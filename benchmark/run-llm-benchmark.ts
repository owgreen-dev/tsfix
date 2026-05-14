#!/usr/bin/env tsx
/**
 * @shipispec/tsmend benchmark harness.
 *
 * For each fixture under `fixtures/<name>/` containing an `expected.json`:
 *   1. Symlink `node_modules/typescript` to the package's typescript install.
 *   2. Snapshot all `.ts` files in the fixture (so a successful repair
 *      doesn't permanently mutate the broken source).
 *   3. Run tsc → assemble MendContext → call `runMendLoop` against the
 *      live Anthropic API (model defaults to `claude-haiku-4-5`).
 *   4. Compare outcome to `expected.json` (errorsBefore / errorsAfterMax /
 *      mustPass / costUsdMax).
 *   5. Restore snapshot.
 *
 * Skipped silently when `ANTHROPIC_API_KEY` is unset — lets CI run the
 * benchmark step without paying for tokens until the secret is configured.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInProcessTsc } from "../src/validatorInProcess.js";
import type { Diagnostic, MendContext } from "../src/index.js";
import { runMendLoop } from "../src/runMendLoop.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.ANTHROPIC_API_KEY) {
	console.log(
		"[benchmark] ANTHROPIC_API_KEY not set — skipping. Set it to run live LLM benchmarks (~$0.01 per run with claude-haiku-4-5).",
	);
	process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
const fixtureFilter = process.argv.find((a) => a.startsWith("--fixture="))?.split("=")[1];

// Anthropic Haiku 4.5 — USD per million tokens. https://www.anthropic.com/pricing
const HAIKU_PRICING = { input: 0.8, output: 4.0 };
function estimateCostUsd(inputTokens: number, outputTokens: number): number {
	return (inputTokens * HAIKU_PRICING.input + outputTokens * HAIKU_PRICING.output) / 1e6;
}

const fixturesDir = path.join(__dirname, "..", "fixtures");
let fixtures = fs
	.readdirSync(fixturesDir)
	.filter((name) => fs.existsSync(path.join(fixturesDir, name, "expected.json")))
	.sort();

if (fixtureFilter) {
	fixtures = fixtures.filter((name) => name === fixtureFilter);
	if (fixtures.length === 0) {
		console.error(`[benchmark] no fixture named '${fixtureFilter}'`);
		process.exit(2);
	}
}

if (fixtures.length === 0) {
	console.error(`[benchmark] no fixtures under ${fixturesDir}`);
	process.exit(2);
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function ensureTypescriptSymlink(fixtureDir: string): void {
	const target = path.join(fixtureDir, "node_modules", "typescript");
	if (fs.existsSync(target)) return;
	const realTs = path.dirname(require.resolve("typescript/package.json"));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(realTs, target);
}

function snapshotTsFiles(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const skip = new Set(["node_modules", "dist", ".git"]);
	function walk(d: string): void {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (skip.has(e.name)) continue;
				walk(path.join(d, e.name));
			} else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
				out.set(path.join(d, e.name), fs.readFileSync(path.join(d, e.name), "utf-8"));
			}
		}
	}
	walk(dir);
	return out;
}

function restoreSnapshot(snapshot: Map<string, string>): void {
	for (const [filePath, content] of snapshot) {
		fs.writeFileSync(filePath, content);
	}
}

interface ResultRow {
	name: string;
	passed: boolean;
	reason?: string;
	errorsBefore?: number;
	errorsAfter?: number;
	iterations?: number;
	costUsd?: number;
}

console.log(`[benchmark] running ${fixtures.length} fixture(s) against ${model}\n`);

const results: ResultRow[] = [];

for (const name of fixtures) {
	const fixtureDir = path.join(fixturesDir, name);
	const expected = JSON.parse(
		fs.readFileSync(path.join(fixtureDir, "expected.json"), "utf-8"),
	);
	ensureTypescriptSymlink(fixtureDir);
	const snapshot = snapshotTsFiles(fixtureDir);

	try {
		console.log(`──── ${name} ────`);
		console.log(`  ${expected.description}`);

		const tsc = runInProcessTsc({ workspaceRoot: fixtureDir, logger: noopLogger });
		const errorDiags = tsc.diagnostics.filter((d: Diagnostic) => d.category === "error");

		if (
			expected.errorsBefore !== undefined &&
			errorDiags.length !== expected.errorsBefore
		) {
			results.push({
				name,
				passed: false,
				reason: `errorsBefore: expected ${expected.errorsBefore}, got ${errorDiags.length}`,
			});
			continue;
		}

		const context: MendContext = {
			workspaceRoot: fixtureDir,
			diagnostics: errorDiags,
			erroredFiles: Array.from(new Set(errorDiags.map((d: Diagnostic) => d.file))),
		};

		const start = Date.now();
		const mendResult = await runMendLoop({
			context,
			llm: { provider: "anthropic", model, apiKey },
			maxIterations: expected.maxIterations ?? 3,
		});
		const elapsedMs = Date.now() - start;
		const cost = estimateCostUsd(mendResult.totalInputTokens, mendResult.totalOutputTokens);

		const failures: string[] = [];
		if (
			expected.errorsAfterMax !== undefined &&
			mendResult.diagnosticsAfter.length > expected.errorsAfterMax
		) {
			failures.push(
				`errorsAfter ${mendResult.diagnosticsAfter.length} > max ${expected.errorsAfterMax}`,
			);
		}
		if (expected.mustPass && !mendResult.passed) {
			failures.push(
				`mustPass=true but passed=false (stopReason=${mendResult.stopReason})`,
			);
		}
		if (expected.costUsdMax !== undefined && cost > expected.costUsdMax) {
			failures.push(`cost $${cost.toFixed(4)} > max $${expected.costUsdMax}`);
		}

		const passed = failures.length === 0;
		console.log(
			`  → ${passed ? "✓" : "✗"} ${errorDiags.length} → ${mendResult.diagnosticsAfter.length} errors, ${mendResult.iterations.length} iter, $${cost.toFixed(4)}, ${elapsedMs}ms`,
		);
		if (!passed) {
			failures.forEach((f) => console.log(`    └─ ${f}`));
			// Verbose dump on failure — shows what the LLM actually emitted.
			for (const iter of mendResult.iterations) {
				console.log(
					`    iter ${iter.index}: applied=${iter.patchesApplied} failed=${iter.patchesFailed} tokens=${iter.inputTokens}→${iter.outputTokens}`,
				);
				console.log("    --- raw LLM response ---");
				const indented = iter.rawResponse
					.split("\n")
					.slice(0, 30)
					.map((l) => `    ${l}`)
					.join("\n");
				console.log(indented);
				if (iter.rawResponse.split("\n").length > 30) {
					console.log("    ... (truncated)");
				}
				console.log("    ------------------------");
			}
		}

		results.push({
			name,
			passed,
			reason: failures.length > 0 ? failures.join("; ") : undefined,
			errorsBefore: errorDiags.length,
			errorsAfter: mendResult.diagnosticsAfter.length,
			iterations: mendResult.iterations.length,
			costUsd: cost,
		});
	} finally {
		restoreSnapshot(snapshot);
	}
}

console.log("\n══════════════════════════════════════════════════════════");
const passed = results.filter((r) => r.passed).length;
console.log(`Mend benchmark: ${passed}/${results.length} passed`);
for (const r of results) {
	const icon = r.passed ? "✓" : "✗";
	const stats =
		r.errorsBefore !== undefined
			? `(${r.errorsBefore} → ${r.errorsAfter}, ${r.iterations}× iter, $${r.costUsd?.toFixed(4)})`
			: r.reason || "";
	console.log(`  ${icon} ${r.name.padEnd(35)} ${stats}`);
}
const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);

process.exit(passed === results.length ? 0 : 1);
