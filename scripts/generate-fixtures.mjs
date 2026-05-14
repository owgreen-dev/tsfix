#!/usr/bin/env node
/**
 * @shipispec/tsmend fixture generator.
 *
 * Generates Layer-2 benchmark fixtures by taking valid TypeScript seed files
 * from `seeds/`, applying a targeted ts-morph AST mutation, and validating
 * via tsfix's `runInProcessTsc` that exactly the expected error code fires.
 * Layer 0 is also run as a gate — if tsfix can fix the mutation, it's not a
 * Layer 2 fixture and the mutation is rejected.
 *
 * Memory note: a SHARED ts-morph Project + a SHARED validation tempDir +
 * explicit cache resets between iterations keep memory bounded. Without
 * sharing, both ts-morph and tsfix's programCache grow ~160MB per attempt
 * and OOM by ~50 attempts.
 *
 * CLI:
 *   node scripts/generate-fixtures.mjs                    # all codes, 10 each
 *   node scripts/generate-fixtures.mjs --code=TS2339      # one code only
 *   node scripts/generate-fixtures.mjs --count=5
 *   node scripts/generate-fixtures.mjs --seed=userCrud.ts
 *   node scripts/generate-fixtures.mjs --rng-seed=42
 *   VERBOSE=1 ...                                          # show rejections
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Project } from "ts-morph";
// Imports tsfix's own dist/ — run `npm run build` first.
import {
	runInProcessTsc,
	runValidationLoop,
	resetInProcessTscCache,
	resetLSPFixerCache,
} from "../dist/index.js";
import { mutate as mutateTS2339 } from "./lib/mutators/ts2339-property-not-exist.mjs";
import { mutate as mutateTS7006 } from "./lib/mutators/ts7006-implicit-any.mjs";
import { mutate as mutateTS2741 } from "./lib/mutators/ts2741-missing-property.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const seedsDir = path.join(root, "seeds");
const fixturesDir = path.join(root, "fixtures");
// Live OUTSIDE the project's node_modules — tsfix's runInProcessTsc filters
// out diagnostics from any path containing `node_modules`, so a shared
// validation dir under node_modules silently reports zero errors.
const cacheDir = path.join(os.tmpdir(), "tsmend-gen");

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const MUTATORS = {
	TS2339: { mutate: mutateTS2339, name: "ts2339-property-not-exist" },
	TS7006: { mutate: mutateTS7006, name: "ts7006-implicit-any" },
	TS2741: { mutate: mutateTS2741, name: "ts2741-missing-property" },
};

function mulberry32(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function ensureTsSymlink(workspaceDir) {
	const target = path.join(workspaceDir, "node_modules", "typescript");
	if (fs.existsSync(target)) return;
	const realTs = path.dirname(require.resolve("typescript/package.json"));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(realTs, target);
}

function writeBaseTsconfig(dir) {
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2020",
					module: "esnext",
					moduleResolution: "bundler",
					strict: true,
					noEmit: true,
					esModuleInterop: true,
					skipLibCheck: true,
				},
				include: ["**/*.ts"],
			},
			null,
			2,
		) + "\n",
	);
}

// ── Shared resources (created once, reused across all mutations) ──────────

fs.mkdirSync(cacheDir, { recursive: true });
const sharedDir = fs.mkdtempSync(path.join(cacheDir, "shared-"));
ensureTsSymlink(sharedDir);
writeBaseTsconfig(sharedDir);
const sharedBrokenPath = path.join(sharedDir, "broken.ts");

// One ts-morph Project across the whole run. We swap the source-file
// content per mutation rather than creating a fresh Project each time —
// ts-morph holds typescript's lib files internally per Project, so a fresh
// Project per call is a ~100MB allocation that GC can't keep up with.
const VIRTUAL_PATH = "/__seed.ts";
const sharedProject = new Project({
	skipAddingFilesFromTsConfig: true,
	useInMemoryFileSystem: true,
});

function loadSeedIntoSharedProject(seedPath) {
	const text = fs.readFileSync(seedPath, "utf-8");
	const existing = sharedProject.getSourceFile(VIRTUAL_PATH);
	if (existing) {
		existing.replaceWithText(text);
		return existing;
	}
	return sharedProject.createSourceFile(VIRTUAL_PATH, text);
}

// ── Per-mutation validation ────────────────────────────────────────────────

async function tryMutation(seedPath, mutator, opts) {
	const sf = loadSeedIntoSharedProject(seedPath);
	const seedText = sf.getFullText();
	const result = await mutator.mutate(sf, opts);
	if (!result) return { status: "skip", reason: "mutator returned null" };

	if (process.env.VERBOSE) {
		const same = result.mutatedText === seedText;
		console.error(
			`  [debug] ${path.basename(seedPath)}: mutatedText ${same ? "IDENTICAL to seed" : "differs from seed"} (${result.mutatedText.length} chars)`,
		);
		if (!same) {
			// Find the first differing window
			let diffStart = 0;
			while (diffStart < seedText.length && seedText[diffStart] === result.mutatedText[diffStart]) {
				diffStart++;
			}
			console.error(
				`  [debug] first diff @ ${diffStart}: seed=${JSON.stringify(seedText.slice(diffStart, diffStart + 40))} mut=${JSON.stringify(result.mutatedText.slice(diffStart, diffStart + 40))}`,
			);
		}
	}

	fs.writeFileSync(sharedBrokenPath, result.mutatedText);

	// Reset both caches before the validation pass — keeps tsfix's
	// programCache pinned at one entry (the sharedDir) and forces a fresh
	// parse against the new broken.ts content.
	resetInProcessTscCache();
	const tsc = runInProcessTsc({ workspaceRoot: sharedDir, logger: noopLogger });
	const errs = tsc.diagnostics.filter((d) => d.category === "error");
	if (errs.length === 0) {
		if (process.env.VERBOSE) {
			console.error(`  [debug] sharedDir=${sharedDir}`);
			console.error(`  [debug] broken.ts on disk (first 300 chars):\n${fs.readFileSync(sharedBrokenPath, "utf-8").slice(0, 300)}`);
			console.error(`  [debug] tsc.diagnostics.length=${tsc.diagnostics.length}, passed=${tsc.passed}`);
			console.error(`  [debug] tsc.output=${JSON.stringify(tsc.output).slice(0, 300)}`);
		}
		return { status: "reject", reason: "mutation produced no errors" };
	}
	if (errs.length > 1) {
		return { status: "reject", reason: `produced ${errs.length} errors (want 1)` };
	}
	if (errs[0].code !== result.code) {
		return { status: "reject", reason: `wrong code: got ${errs[0].code}, want ${result.code}` };
	}

	resetInProcessTscCache();
	resetLSPFixerCache();
	const validation = runValidationLoop({ workspaceRoot: sharedDir, logger: noopLogger });
	if (validation.passed) {
		return { status: "reject", reason: "Layer 0 (tsfix) fixes it — not a Layer 2 fixture" };
	}

	// runValidationLoop may have written fixes into broken.ts even though
	// they didn't fully resolve — restore the mutated text so the next
	// mutation attempt starts clean.
	fs.writeFileSync(sharedBrokenPath, result.mutatedText);

	return { status: "ok", result, errsBefore: errs.length };
}

function writeFixture(slug, mutatorName, seedName, index, mutResult, errsBefore) {
	const dir = path.join(fixturesDir, slug);
	fs.mkdirSync(dir, { recursive: true });
	writeBaseTsconfig(dir);
	fs.writeFileSync(path.join(dir, "broken.ts"), mutResult.mutatedText);
	fs.writeFileSync(
		path.join(dir, "expected.json"),
		JSON.stringify(
			{
				description: mutResult.description,
				expectedErrorCode: mutResult.code,
				errorsBefore: errsBefore,
				errorsAfterMax: 0,
				maxIterations: 3,
				mustPass: true,
				costUsdMax: 0.005,
				_generated: {
					seed: seedName,
					mutator: mutatorName,
					index,
					timestamp: new Date().toISOString(),
				},
			},
			null,
			2,
		) + "\n",
	);
}

// ── CLI driver ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const codeFilter = args.find((a) => a.startsWith("--code="))?.split("=")[1];
const countArg = args.find((a) => a.startsWith("--count="))?.split("=")[1];
const seedFilter = args.find((a) => a.startsWith("--seed="))?.split("=")[1];
const rngSeedArg = args.find((a) => a.startsWith("--rng-seed="))?.split("=")[1];

const count = countArg ? parseInt(countArg, 10) : 10;
const rngSeed = rngSeedArg ? parseInt(rngSeedArg, 10) : 42;

const codes = codeFilter ? [codeFilter] : Object.keys(MUTATORS);
const seeds = (seedFilter ? [seedFilter] : fs.readdirSync(seedsDir).filter((f) => f.endsWith(".ts"))).sort();

if (seeds.length === 0) {
	console.error(`[gen] no seeds in ${seedsDir}`);
	process.exit(2);
}

console.log(`[gen] codes=[${codes.join(", ")}] seeds=${seeds.length} count=${count}/code rng-seed=${rngSeed}`);

const summary = { ok: 0, skip: 0, reject: 0 };

try {
	for (const code of codes) {
		const m = MUTATORS[code];
		if (!m) {
			console.error(`[gen] no mutator for ${code}`);
			continue;
		}
		let written = 0;
		let attempts = 0;
		const maxAttempts = count * 5;
		const rng = mulberry32(rngSeed + Object.keys(MUTATORS).indexOf(code));
		while (written < count && attempts < maxAttempts) {
			const seedName = seeds[attempts % seeds.length];
			const seedPath = path.join(seedsDir, seedName);
			const opts = { rng, index: written };
			attempts++;
			const out = await tryMutation(seedPath, m, opts);
			if (out.status === "ok") {
				const slug = `gen-${code.toLowerCase()}-${path.parse(seedName).name}-${written}`;
				writeFixture(slug, m.name, seedName, written, out.result, out.errsBefore);
				summary.ok++;
				written++;
				console.log(`  ✓ ${slug}`);
			} else {
				summary[out.status]++;
				if (process.env.VERBOSE) {
					console.log(`  ${out.status === "skip" ? "·" : "✗"} ${seedName}#${attempts}: ${out.reason}`);
				}
			}
		}
		console.log(`  → ${code}: ${written}/${count} written (${attempts} attempts)`);
	}
} finally {
	if (process.env.KEEP_SHARED_DIR) {
		console.log(`[gen] retained sharedDir for inspection: ${sharedDir}`);
	} else {
		fs.rmSync(sharedDir, { recursive: true, force: true });
	}
}

console.log(
	`\n[gen] done: ${summary.ok} written, ${summary.reject} rejected, ${summary.skip} skipped`,
);
