/**
 * TSC Defense Stack benchmark runner.
 *
 * Snapshots each fixture's source files (so the LSP fixer's in-place edits
 * don't permanently mutate them), runs the standalone CLI on every fixture,
 * compares against `expected.json`, and aggregates per-layer hit rates.
 *
 * Usage:
 *   npx tsx tsc-defense-stack/benchmark/run-benchmark.ts
 *   npx tsx tsc-defense-stack/benchmark/run-benchmark.ts --json
 *   npx tsx tsc-defense-stack/benchmark/run-benchmark.ts --fixture synthetic-typo-ts2552
 *
 * Exit codes:
 *   0  all fixtures passed
 *   1  one or more fixtures failed
 *   2  harness error (no fixtures, etc.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runValidationLoop, discoverTsFiles } from "../src/index.js";

interface Expected {
	description?: string;
	errorsBefore?: number;
	errorsAfterMax?: number;
	lspFixesAppliedMin?: number;
	lspFixesAppliedMax?: number;
	mustPass: boolean;
	expectedFixerCodes?: string[];
}

interface FixtureResult {
	name: string;
	expected: Expected;
	errorsBefore: number;
	errorsAfter: number;
	lspFixesApplied: number;
	lspIterations: number;
	filesEdited: string[];
	remainingByCode: Record<string, number>;
	passed: boolean;
	failureReasons: string[];
	elapsedMs: number;
}

// tsx loads .ts as CJS when the package.json doesn't declare "type": "module".
// Use a CJS-friendly path resolution: __dirname is provided by tsx's loader.
// Falls through to import.meta.url for ESM-mode hosts.
declare const __dirname: string | undefined;
const SCRIPT_DIR =
	typeof __dirname !== "undefined"
		? __dirname
		: path.dirname(new URL(import.meta.url).pathname);
const FIXTURES_ROOT = path.resolve(SCRIPT_DIR, "..", "fixtures");

function listFixtures(filter?: string): string[] {
	const entries = fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true });
	const out: string[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (e.name.startsWith("_")) continue; // _shared, _shared-node_modules
		if (filter && e.name !== filter) continue;
		const dir = path.join(FIXTURES_ROOT, e.name);
		if (!fs.existsSync(path.join(dir, "expected.json"))) continue;
		if (!fs.existsSync(path.join(dir, "tsconfig.json"))) continue;
		// Skip Layer-2 fixtures (mend territory) — they have `costUsdMax` or
		// `expectedErrorCode` (singular) in their expected.json schema. The
		// Layer-0 benchmark cannot resolve them by design; they belong to
		// `npm run benchmark:llm`.
		const expectedRaw = fs.readFileSync(path.join(dir, "expected.json"), "utf-8");
		if (/"costUsdMax"|"expectedErrorCode"/.test(expectedRaw)) continue;
		out.push(e.name);
	}
	return out.sort();
}

function readExpected(fixtureDir: string): Expected {
	const raw = fs.readFileSync(path.join(fixtureDir, "expected.json"), "utf-8");
	return JSON.parse(raw) as Expected;
}

/**
 * Snapshot every .ts(x) file under the fixture into memory so we can restore
 * after the LSP fixer mutates them. Without this, the second benchmark run
 * sees clean code and reports 0 errors — false-pass.
 */
function snapshotFiles(workspaceRoot: string, files: string[]): Map<string, string> {
	const snap = new Map<string, string>();
	for (const f of files) {
		const abs = path.join(workspaceRoot, f);
		if (fs.existsSync(abs)) {
			snap.set(abs, fs.readFileSync(abs, "utf-8"));
		}
	}
	return snap;
}

function restoreFiles(snap: Map<string, string>): void {
	for (const [abs, content] of snap) {
		fs.writeFileSync(abs, content, "utf-8");
	}
}

function silentLogger() {
	return {
		info: (_m: string) => {},
		warn: (_m: string) => {},
		error: (_m: string) => {},
	};
}

function runFixture(name: string): FixtureResult {
	const dir = path.join(FIXTURES_ROOT, name);
	const expected = readExpected(dir);
	const files = discoverTsFiles(dir);
	const snap = snapshotFiles(dir, files);
	const logger = silentLogger();

	const loop = runValidationLoop({
		workspaceRoot: dir,
		targetFiles: files,
		logger,
	});

	// Restore snapshots so the next run sees the original broken code.
	restoreFiles(snap);

	const failureReasons: string[] = [];
	if (expected.errorsBefore !== undefined && loop.errorsBefore !== expected.errorsBefore) {
		failureReasons.push(
			`errorsBefore mismatch: expected ${expected.errorsBefore}, got ${loop.errorsBefore}`,
		);
	}
	if (expected.errorsAfterMax !== undefined && loop.errorsAfter > expected.errorsAfterMax) {
		failureReasons.push(`errorsAfter ${loop.errorsAfter} > max ${expected.errorsAfterMax}`);
	}
	if (
		expected.lspFixesAppliedMin !== undefined &&
		loop.lspFixer.fixesApplied < expected.lspFixesAppliedMin
	) {
		failureReasons.push(
			`lspFixes ${loop.lspFixer.fixesApplied} < min ${expected.lspFixesAppliedMin}`,
		);
	}
	if (
		expected.lspFixesAppliedMax !== undefined &&
		loop.lspFixer.fixesApplied > expected.lspFixesAppliedMax
	) {
		failureReasons.push(
			`lspFixes ${loop.lspFixer.fixesApplied} > max ${expected.lspFixesAppliedMax}`,
		);
	}

	const passed =
		failureReasons.length === 0 && (!expected.mustPass || loop.errorsAfter === 0);

	return {
		name,
		expected,
		errorsBefore: loop.errorsBefore,
		errorsAfter: loop.errorsAfter,
		lspFixesApplied: loop.lspFixer.fixesApplied,
		lspIterations: loop.lspFixer.iterations,
		filesEdited: loop.lspFixer.filesEdited,
		remainingByCode: loop.remainingByCode,
		passed,
		failureReasons: failureReasons.concat(
			expected.mustPass && loop.errorsAfter > 0 ? ["mustPass=true but errorsAfter>0"] : [],
		),
		elapsedMs: loop.elapsedMs,
	};
}

function parseArgs(argv: string[]): { fixture?: string; json: boolean } {
	const out: { fixture?: string; json: boolean } = { json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--fixture") out.fixture = argv[++i];
		else if (a === "--json") out.json = true;
	}
	return out;
}

function printHumanReport(results: FixtureResult[]): void {
	const w = process.stderr;
	w.write(`\nTSC Defense Stack Benchmark — ${results.length} fixture(s)\n\n`);

	const nameWidth = Math.max(...results.map((r) => r.name.length), 12);
	for (const r of results) {
		const status = r.passed ? "✓" : "✗";
		const name = r.name.padEnd(nameWidth);
		const transition = `${String(r.errorsBefore).padStart(3)} errors → ${String(r.errorsAfter).padStart(3)} errors`;
		const lsp = r.lspFixesApplied > 0 ? ` (LSP fixed ${r.lspFixesApplied})` : "";
		w.write(`  ${status} ${name}  ${transition}${lsp}\n`);
		if (!r.passed) {
			for (const reason of r.failureReasons) {
				w.write(`      └─ ${reason}\n`);
			}
		}
	}

	const totalBefore = results.reduce((sum, r) => sum + r.errorsBefore, 0);
	const totalLspFixed = results.reduce((sum, r) => sum + r.lspFixesApplied, 0);
	const totalAfter = results.reduce((sum, r) => sum + r.errorsAfter, 0);
	const passed = results.filter((r) => r.passed).length;

	w.write(`\nAggregate:\n`);
	w.write(`  fixtures:        ${passed}/${results.length} passed\n`);
	w.write(`  errors:          ${totalBefore} before → ${totalAfter} after\n`);
	if (totalBefore > 0) {
		const pct = ((totalLspFixed / totalBefore) * 100).toFixed(1);
		w.write(`  Layer 0 LSP:     fixed ${totalLspFixed}/${totalBefore} (${pct}%)\n`);
	}

	const allRemaining: Record<string, number> = {};
	for (const r of results) {
		for (const [code, n] of Object.entries(r.remainingByCode)) {
			allRemaining[code] = (allRemaining[code] ?? 0) + n;
		}
	}
	if (Object.keys(allRemaining).length > 0) {
		const top = Object.entries(allRemaining).sort((a, b) => b[1] - a[1]).slice(0, 6);
		w.write(`  top remaining:   ${top.map(([c, n]) => `${c}=${n}`).join(", ")}\n`);
	}
	w.write(`\n`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const fixtures = listFixtures(args.fixture);
	if (fixtures.length === 0) {
		console.error(`error: no fixtures found${args.fixture ? ` matching "${args.fixture}"` : ""}`);
		return 2;
	}

	const results: FixtureResult[] = [];
	for (const name of fixtures) {
		try {
			results.push(runFixture(name));
		} catch (err) {
			results.push({
				name,
				expected: { mustPass: true },
				errorsBefore: 0,
				errorsAfter: -1,
				lspFixesApplied: 0,
				lspIterations: 0,
				filesEdited: [],
				remainingByCode: {},
				passed: false,
				failureReasons: [`harness error: ${err instanceof Error ? err.message : String(err)}`],
				elapsedMs: 0,
			});
		}
	}

	if (args.json) {
		process.stdout.write(JSON.stringify({ fixtures: results }, null, 2) + "\n");
	} else {
		printHumanReport(results);
	}

	const allPassed = results.every((r) => r.passed);
	return allPassed ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("benchmark error:", err instanceof Error ? err.stack : err);
		process.exit(2);
	},
);
