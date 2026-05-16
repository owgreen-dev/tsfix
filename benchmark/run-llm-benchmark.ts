#!/usr/bin/env tsx
/**
 * Layer-2 (LLM mend) benchmark harness.
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
 *
 * ## Day-4 additions
 *
 * - **Concurrency** — fixtures run in parallel under a `pLimit(N)` semaphore
 *   (default 8). 100 fixtures @ ~1.5s sequential → ~2 min; in parallel → ~20s.
 *   Each fixture has its own workspace (snapshot/restore is isolated), so no
 *   shared mutable state across workers — except tsfix's program cache, which
 *   thrashes harmlessly under concurrency.
 *
 * - **File-based response cache** — every LLM call is keyed by
 *   `sha256(systemBlock + userBlock + model)` and stored under
 *   `.benchmark-cache/<hash>.json`. Re-runs after a no-op edit replay
 *   cached responses for free. Any change to the system prompt, fixture
 *   content, or model invalidates automatically (it's all in the hash).
 *
 *   Flags: `--no-cache` to bypass; `--clear-cache` to wipe and exit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInProcessTsc } from "../src/validatorInProcess.js";
import type { Diagnostic, MendContext } from "../src/index.js";
import { runMendLoop } from "../src/runMendLoop.js";
import type { LLMCall } from "../src/mendAgent.js";
import { makeCachingLLMCall, type CacheStats } from "./cache.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(repoRoot, ".benchmark-cache");

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fixtureFilter = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="))?.split("=")[1];
const noCache = args.includes("--no-cache");
const clearCache = args.includes("--clear-cache");

if (clearCache) {
	if (fs.existsSync(cacheRoot)) {
		fs.rmSync(cacheRoot, { recursive: true, force: true });
		console.log(`[benchmark] cleared cache at ${path.relative(repoRoot, cacheRoot)}`);
	} else {
		console.log(`[benchmark] cache already empty (${path.relative(repoRoot, cacheRoot)} does not exist)`);
	}
	process.exit(0);
}

const concurrency = concurrencyArg ? Math.max(1, parseInt(concurrencyArg, 10)) : 8;

if (!process.env.ANTHROPIC_API_KEY && !noCache) {
	// We could still serve from cache for re-runs without an API key, but only
	// if every fixture has a cached entry. For simplicity, mirror the previous
	// behavior: skip when no key is set. Future enhancement: cache-only mode.
	console.log(
		"[benchmark] ANTHROPIC_API_KEY not set — skipping. Set it to run live LLM benchmarks (~$0.01 per run with claude-haiku-4-5).",
	);
	process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

// ── Pricing (Haiku 4.5; override via env if you change model) ─────────────────

const HAIKU_PRICING = { input: 0.8, output: 4.0 };
function estimateCostUsd(inputTokens: number, outputTokens: number): number {
	return (inputTokens * HAIKU_PRICING.input + outputTokens * HAIKU_PRICING.output) / 1e6;
}
// ── Response cache stats (cache logic itself lives in ./cache.ts) ─────────────

const cacheStats: CacheStats = { hits: 0, misses: 0 };

// ── Concurrency limiter (inline, no extra dep) ────────────────────────────────

function pLimit<T>(concurrency_: number): (fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const queue: Array<() => void> = [];
	const run = async (fn: () => Promise<T>): Promise<T> => {
		if (active >= concurrency_) {
			await new Promise<void>((resolve) => queue.push(resolve));
		}
		active++;
		try {
			return await fn();
		} finally {
			active--;
			const next = queue.shift();
			if (next) next();
		}
	};
	return run;
}

// ── Fixture discovery ─────────────────────────────────────────────────────────

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

// Also filter to Layer-2-shaped expected.json (skip Layer-0 fixtures).
fixtures = fixtures.filter((name) => {
	const expected = fs.readFileSync(
		path.join(fixturesDir, name, "expected.json"),
		"utf-8",
	);
	return /"costUsdMax"|"expectedErrorCode"/.test(expected);
});

if (fixtures.length === 0) {
	console.error(`[benchmark] no Layer-2 fixtures found (matched 0 fixtures with costUsdMax or expectedErrorCode in expected.json)`);
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

// ── Default LLM call (only used on cache miss) ────────────────────────────────

// We don't directly import or build the Vercel-AI-SDK-based default here —
// that lives inside `mendAgent.ts`. Instead we call `runMendLoop` with our
// caching `_callLLM`. To wrap the *real* call, we need access to it; we
// re-construct it lazily here using the same SDK pattern. This keeps the
// cache layer independent of mendAgent's internals.

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const realLLMCall: LLMCall = async ({ systemBlock, userBlock, model: modelStr, apiKey: key }) => {
	const anthropic = createAnthropic({ apiKey: key });
	const start = Date.now();
	const result = await generateText({
		model: anthropic(modelStr),
		system: systemBlock,
		prompt: userBlock,
		maxOutputTokens: 4096,
	});
	void start;
	const text = (result as { text?: string }).text ?? "";
	const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage ?? {};
	return {
		text,
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
	};
};

const cachingLLMCall = makeCachingLLMCall(realLLMCall, {
	cacheDir: cacheRoot,
	stats: cacheStats,
	bypass: noCache,
});

// ── Per-fixture worker ────────────────────────────────────────────────────────

interface ResultRow {
	name: string;
	passed: boolean;
	reason?: string;
	errorsBefore?: number;
	errorsAfter?: number;
	iterations?: number;
	costUsd?: number;
	elapsedMs?: number;
	failureDetail?: string;
}

async function runOne(name: string, index: number, total: number): Promise<ResultRow> {
	const fixtureDir = path.join(fixturesDir, name);
	const expected = JSON.parse(
		fs.readFileSync(path.join(fixtureDir, "expected.json"), "utf-8"),
	);
	ensureTypescriptSymlink(fixtureDir);
	const snapshot = snapshotTsFiles(fixtureDir);

	const failureLines: string[] = [];

	try {
		const tsc = runInProcessTsc({ workspaceRoot: fixtureDir, logger: noopLogger });
		const errorDiags = tsc.diagnostics.filter((d: Diagnostic) => d.category === "error");

		if (
			expected.errorsBefore !== undefined &&
			errorDiags.length !== expected.errorsBefore
		) {
			const row: ResultRow = {
				name,
				passed: false,
				reason: `errorsBefore: expected ${expected.errorsBefore}, got ${errorDiags.length}`,
			};
			console.log(`[${index + 1}/${total}] ✗ ${name} — ${row.reason}`);
			return row;
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
			_callLLM: cachingLLMCall,
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
			`[${index + 1}/${total}] ${passed ? "✓" : "✗"} ${name.padEnd(40)} ${errorDiags.length}→${mendResult.diagnosticsAfter.length} err  ${mendResult.iterations.length}× iter  $${cost.toFixed(4)}  ${elapsedMs}ms`,
		);

		if (!passed) {
			failureLines.push(`──── ${name} (FAILED) ────`);
			failureLines.push(`  ${expected.description}`);
			failures.forEach((f) => failureLines.push(`  └─ ${f}`));
			for (const iter of mendResult.iterations) {
				failureLines.push(
					`  iter ${iter.index}: applied=${iter.patchesApplied} failed=${iter.patchesFailed} tokens=${iter.inputTokens}→${iter.outputTokens}`,
				);
				failureLines.push("  --- raw LLM response (truncated to 30 lines) ---");
				const indented = iter.rawResponse
					.split("\n")
					.slice(0, 30)
					.map((l) => `  ${l}`)
					.join("\n");
				failureLines.push(indented);
				if (iter.rawResponse.split("\n").length > 30) {
					failureLines.push("  ... (truncated)");
				}
				failureLines.push("  ----------------------------------------------");
			}
		}

		return {
			name,
			passed,
			reason: failures.length > 0 ? failures.join("; ") : undefined,
			errorsBefore: errorDiags.length,
			errorsAfter: mendResult.diagnosticsAfter.length,
			iterations: mendResult.iterations.length,
			costUsd: cost,
			elapsedMs,
			failureDetail: failureLines.length > 0 ? failureLines.join("\n") : undefined,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`[${index + 1}/${total}] ✗ ${name} — threw: ${msg}`);
		return { name, passed: false, reason: `threw: ${msg}` };
	} finally {
		restoreSnapshot(snapshot);
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(
	`[benchmark] running ${fixtures.length} fixture(s) against ${model} · concurrency=${concurrency} · cache=${noCache ? "OFF" : "ON"}\n`,
);

const limit = pLimit<ResultRow>(concurrency);
const overallStart = Date.now();

const results = await Promise.all(
	fixtures.map((name, i) => limit(() => runOne(name, i, fixtures.length))),
);

const overallElapsedMs = Date.now() - overallStart;

// Sort by name for the summary so output is deterministic regardless of
// concurrent completion order.
results.sort((a, b) => a.name.localeCompare(b.name));

// Print failure details first (each fixture's full per-iteration dump).
const failures = results.filter((r) => !r.passed && r.failureDetail);
if (failures.length > 0) {
	console.log("\n══════════════════════════════════════════════════════════");
	console.log(`Failure details (${failures.length}):`);
	console.log("══════════════════════════════════════════════════════════\n");
	for (const r of failures) {
		console.log(r.failureDetail);
		console.log();
	}
}

console.log("\n══════════════════════════════════════════════════════════");
const passed = results.filter((r) => r.passed).length;
console.log(`Layer-2 benchmark: ${passed}/${results.length} passed`);
for (const r of results) {
	const icon = r.passed ? "✓" : "✗";
	const stats =
		r.errorsBefore !== undefined
			? `(${r.errorsBefore} → ${r.errorsAfter}, ${r.iterations}× iter, $${r.costUsd?.toFixed(4)}, ${r.elapsedMs}ms)`
			: r.reason || "";
	console.log(`  ${icon} ${r.name.padEnd(40)} ${stats}`);
}
const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
const cacheTotal = cacheStats.hits + cacheStats.misses;
const cacheHitRate = cacheTotal > 0 ? ((cacheStats.hits / cacheTotal) * 100).toFixed(1) : "0";
console.log(`\nWall time:    ${(overallElapsedMs / 1000).toFixed(1)}s`);
console.log(`Total cost:   $${totalCost.toFixed(4)} (cache misses only — hits are free)`);
console.log(`Cache:        ${cacheStats.hits}/${cacheTotal} hits (${cacheHitRate}%) · ${path.relative(repoRoot, cacheRoot)}/`);

process.exit(passed === results.length ? 0 : 1);
