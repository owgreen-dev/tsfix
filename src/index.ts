/**
 * @shipispec/tsfix — public API.
 *
 * A reusable TypeScript error-recovery agent. Validates LLM-generated (or any)
 * TypeScript code via in-process tsc, auto-fixes deterministic error classes
 * (TS2304/2305/2552/2724) via TypeScript's built-in code-fix engine, and
 * runs Layer 2 LLM mend (single-file repair via Vercel AI SDK + Anthropic)
 * on what survives.
 *
 * ## Quick start (library)
 *
 * ```ts
 * import { runValidationLoop } from "@shipispec/tsfix";
 *
 * const result = await runValidationLoop({
 *   workspaceRoot: "/path/to/your/project",
 *   targetFiles: ["src/index.ts", "src/utils.ts"],
 * });
 *
 * console.log(result.passed, result.errorsAfter, result.lspFixer.fixesApplied);
 * ```
 *
 * ## Quick start (CLI)
 *
 * ```
 * npx @shipispec/tsfix --workspace ./my-project
 * ```
 *
 * ## Layered API
 *
 * - `runValidationLoop` — full deterministic loop (recommended entry point)
 * - `runInProcessTsc` — just type-check, returns structured diagnostics
 * - `runLSPFixerPass` — just the auto-fix pass, edits files in place
 *
 * ## Public types for the LLM-mend layer
 *
 * - `Diagnostic` — single tsc error (re-exported from `runInProcessTsc`)
 * - `MendContext` — input contract for the Layer 2–4 LLM-mend agent
 * - `LayerEvent` — per-layer event shape for streaming telemetry
 *
 * ## Layer 2 mend API (v0.4.0+)
 *
 * - `getTypeContext` — TS Language Service type-declaration injection
 * - `mendSingleFile` — single-LLM-call repair via Vercel AI SDK
 * - `runMendLoop` — bounded retry with no-progress / regression detection
 * - `parseEditBlocks` / `applyEditBlocks` — Aider-style SEARCH/REPLACE applier
 *
 * ## Layer 4 escape hatch (v0.5.0+)
 *
 * - `stubAndContinue` — insert `// @ts-expect-error - tsfix: ...` above
 *   unresolved error sites so the workspace compiles. Opt-in: set
 *   `stubOnFailure: true` on `runMendLoop`, or call directly.
 */

export { runInProcessTsc, isInProcessTscEnabled, resetInProcessTscCache } from "./validatorInProcess.js";
export type { InProcessTscOptions, InProcessTscResult } from "./validatorInProcess.js";

export { runLSPFixerPass, isLSPFixerEnabled, resetLSPFixerCache } from "./tsLanguageServiceFixer.js";
export type { LSPFixerOptions, LSPFixerResult, LSPFixerLogger } from "./tsLanguageServiceFixer.js";

import * as fs from "node:fs";
import * as path from "node:path";
import {
	runInProcessTsc,
	resetInProcessTscCache,
	type InProcessTscResult,
} from "./validatorInProcess.js";
import { runLSPFixerPass } from "./tsLanguageServiceFixer.js";

/** Logger shape required by the validation/fix loop. Plain object with three methods. */
export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface ValidationLoopOptions {
	/** Absolute path to the workspace (must contain `tsconfig.json`). */
	workspaceRoot: string;
	/**
	 * Files to scope the type-check + fix to. If omitted, all .ts/.tsx files
	 * under `workspaceRoot` (excluding node_modules, .next, dist, build, .git)
	 * are discovered.
	 */
	targetFiles?: string[];
	/** Skip Layer 0 LSP auto-fixer. Default false. */
	skipLSPFixer?: boolean;
	/**
	 * Run the LSP fixer in memory but do NOT persist edits to disk. The
	 * returned `lspFixer.filesEdited` lists files that *would* have been
	 * written. Useful for previewing changes before letting tsfix mutate a
	 * workspace. Default false.
	 */
	dryRun?: boolean;
	/** Default: a no-op logger. Pass your own to capture layer events. */
	logger?: Logger;
	/**
	 * Per-error telemetry callback for Layer 1 (LSP fixer). Fires once per
	 * fixable error with `{layer: 1, errorCode, fixed, latencyMs, ts}`. Optional;
	 * undefined callback costs nothing. See `LayerEvent`.
	 */
	onLayerEvent?: (event: LayerEvent) => void;
}

export interface ValidationLoopResult {
	passed: boolean;
	errorsBefore: number;
	errorsAfter: number;
	lspFixer: {
		ran: boolean;
		fixesApplied: number;
		filesEdited: string[];
		iterations: number;
	};
	remainingByCode: Record<string, number>;
	remainingByFile: Record<string, number>;
	diagnostics: InProcessTscResult["diagnostics"];
	elapsedMs: number;
}

const noopLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * Discover all `.ts` / `.tsx` files under a workspace, excluding common
 * non-source dirs. Skips `.d.ts` declaration files.
 */
export function discoverTsFiles(workspaceRoot: string): string[] {
	const out: string[] = [];
	const skip = new Set(["node_modules", ".next", "dist", "build", ".git", "out", "coverage"]);
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (skip.has(e.name)) {
					continue;
				}
				walk(path.join(dir, e.name));
			} else if (e.isFile() && !e.name.endsWith(".d.ts")) {
				if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
					out.push(path.relative(workspaceRoot, path.join(dir, e.name)));
				}
			}
		}
	};
	walk(workspaceRoot);
	return out;
}

/**
 * Run the full deterministic validation + fix loop:
 *
 *   1. In-process tsc → capture baseline diagnostics
 *   2. If errors AND not `skipLSPFixer`, run Layer 0 LSP auto-fix
 *   3. If fixes were applied, re-run in-process tsc to capture post-fix state
 *   4. Return aggregated result
 *
 * Throws on missing `tsconfig.json` or workspace path.
 */
export function runValidationLoop(opts: ValidationLoopOptions): ValidationLoopResult {
	const { workspaceRoot, skipLSPFixer = false, dryRun = false } = opts;
	const logger = opts.logger ?? noopLogger;

	if (!fs.existsSync(workspaceRoot)) {
		throw new Error(`workspace not found: ${workspaceRoot}`);
	}
	if (!fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
		throw new Error(`no tsconfig.json in ${workspaceRoot}`);
	}

	const targetFiles = opts.targetFiles ?? discoverTsFiles(workspaceRoot);
	const startMs = Date.now();

	resetInProcessTscCache();
	const before = runInProcessTsc({ workspaceRoot, generatedFiles: targetFiles, logger });
	const errorsBefore = before.diagnostics.filter((d) => d.category === "error").length;

	let after = before;
	let lspFixer = {
		ran: false,
		fixesApplied: 0,
		filesEdited: [] as string[],
		iterations: 0,
	};

	if (errorsBefore > 0 && !skipLSPFixer) {
		const lsp = runLSPFixerPass({
			workspaceRoot, targetFiles, logger, dryRun,
			onLayerEvent: opts.onLayerEvent,
		});
		lspFixer = {
			ran: true,
			fixesApplied: lsp.fixesApplied,
			filesEdited: lsp.filesEdited,
			iterations: lsp.iterations,
		};
		// In dry-run mode, the fixer didn't write to disk — re-running tsc
		// would see the original errors, defeating the preview. Use the
		// fixer's own remainingErrors as the authoritative post-fix view.
		if (lsp.fixesApplied > 0 && !dryRun) {
			resetInProcessTscCache();
			after = runInProcessTsc({ workspaceRoot, generatedFiles: targetFiles, logger });
		}
	}

	const errorDiags = after.diagnostics.filter((d) => d.category === "error");
	const errorsAfter = errorDiags.length;

	const remainingByCode: Record<string, number> = {};
	const remainingByFile: Record<string, number> = {};
	for (const d of errorDiags) {
		remainingByCode[d.code] = (remainingByCode[d.code] ?? 0) + 1;
		remainingByFile[d.file] = (remainingByFile[d.file] ?? 0) + 1;
	}

	return {
		passed: errorsAfter === 0,
		errorsBefore,
		errorsAfter,
		lspFixer,
		remainingByCode,
		remainingByFile,
		diagnostics: after.diagnostics,
		elapsedMs: Date.now() - startMs,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types for downstream LLM-mend integrations (Phase 2 contract).
//
// `tsfix` itself does not invoke an LLM. These types define the data a
// Layer 2–4 mend agent (`@shipispec/tsmend`, planned) will consume.
// Establishing them here, in the package every consumer already depends on,
// keeps the contract single-sourced.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single tsc diagnostic. Re-exported from `runInProcessTsc`'s result type
 * so consumers building a `MendContext` don't have to dig the shape out of
 * `InProcessTscResult["diagnostics"][number]`.
 */
export type Diagnostic = InProcessTscResult["diagnostics"][number];

/**
 * Input contract for a Layer 2–4 LLM-mend agent.
 *
 * Pattern:
 *   1. Run `runValidationLoop` (Layer 0/1).
 *   2. If `result.errorsAfter > 0`, build a `MendContext` from the
 *      surviving diagnostics + whatever task/spec context your pipeline has.
 *   3. Hand off to a mend agent (e.g. `@shipispec/tsmend`).
 *
 * Required fields: `workspaceRoot`, `diagnostics`, `erroredFiles`.
 * Everything else is optional — leave fields out if your pipeline doesn't
 * carry them.
 */
export interface MendContext {
	/** Absolute path to the workspace (must contain `tsconfig.json`). */
	workspaceRoot: string;
	/** Diagnostics that survived Layer 0/1 and need higher-layer repair. */
	diagnostics: Diagnostic[];
	/** Absolute paths of files containing the surviving diagnostics. */
	erroredFiles: string[];
	/** Optional one-line summary of what the failing code was supposed to do. */
	taskDescription?: string;
	/** Optional Markdown spec the code is implementing. Helps the LLM understand intent. */
	featureSpecText?: string;
	/** Optional testable acceptance criteria from the spec. */
	acceptanceCriteria?: string;
	/** Other tasks in the same feature, with their files and current status. */
	siblingTasks?: Array<{
		description: string;
		files: string[];
		status: "pending" | "completed" | "failed";
	}>;
	/** Public API surface from earlier completed tasks (helps prevent re-defining symbols). */
	priorTaskExports?: string;
	/** Compact type signatures of installed npm dependencies (helps prevent API hallucination). */
	installedTypes?: string;
}

/**
 * Per-layer event for streaming telemetry across the validate → fix → mend
 * chain. Designed for an `onLayerEvent` callback (added in a future minor
 * release) rather than accumulating in a result array — a workspace with
 * 200 errors emits ~1000 events.
 *
 * Layer assignments:
 *   0 = prevention (prompt rules, exported-API injection — caller's problem)
 *   1 = tsfix LSP fixer (this package)
 *   2 = single-file LLM mend
 *   3 = multi-file LLM mend (blast-radius search/replace)
 *   4 = stub-and-continue (escape hatch)
 */
export interface LayerEvent {
	/** Which layer ran. */
	layer: 0 | 1 | 2 | 3 | 4;
	/** TypeScript error code being acted on (e.g. 2304, 2339, 7006). */
	errorCode: number;
	/** True if the error was resolved by this layer. */
	fixed: boolean;
	/** Wall-clock time spent on this attempt. */
	latencyMs: number;
	/** USD cost (LLM tokens). Undefined for deterministic layers. */
	costUsd?: number;
	/** `Date.now()` at emission. */
	ts: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LLM mend (folded in from @shipispec/tsmend at v0.4.0)
// ─────────────────────────────────────────────────────────────────────────────

export { getTypeContext, resetTypeContextCache } from "./typeContext.js";
export type { TypeContextOptions, TypeContext } from "./typeContext.js";

export { parseEditBlocks, applySingleBlock, applyEditBlocks } from "./applyEditBlock.js";
export type {
	EditBlock,
	ApplyEditBlocksOptions,
	ApplyResult,
	SingleBlockResult,
} from "./applyEditBlock.js";

export { mendSingleFile } from "./mendAgent.js";
export type {
	MendSingleFileOptions,
	MendSingleFileResult,
	LLMCall,
	LLMProvider,
} from "./mendAgent.js";

export { runMendLoop } from "./runMendLoop.js";
export type {
	RunMendLoopOptions,
	RunMendLoopResult,
	MendLoopIteration,
	StopReason,
} from "./runMendLoop.js";

// Layer 4 — stub-and-continue (opt-in escape hatch).
export { stubAndContinue } from "./stubAndContinue.js";
export type {
	StubAndContinueOptions,
	StubAndContinueResult,
	AppliedStub,
	SkippedStub,
} from "./stubAndContinue.js";

// ─────────────────────────────────────────────────────────────────────────────
// Unified full-stack entrypoint (v0.6.0+).
//
// Convenience wrapper that runs Layer 0/1 → Layer 2 (opt-in) → Layer 4
// (opt-in) and returns one combined result. Callers who want just one layer
// keep using the per-layer functions; callers who want "run the whole stack"
// reach for this instead of composing it themselves.
// ─────────────────────────────────────────────────────────────────────────────

import { runMendLoop, type RunMendLoopResult } from "./runMendLoop.js";
import type { AppliedStub } from "./stubAndContinue.js";
import type { LLMProvider } from "./mendAgent.js";

export interface RunFullStackOptions {
	/** Absolute path to the workspace (must contain `tsconfig.json`). */
	workspaceRoot: string;
	/** Files to scope to. If omitted, all `.ts`/`.tsx` files under workspaceRoot. */
	targetFiles?: string[];
	/** Skip Layer 0/1 LSP auto-fixer. Default false. */
	skipLSPFixer?: boolean;
	/**
	 * Layer 2 config. If omitted, the loop stops after Layer 0/1 (matches
	 * `runValidationLoop` behavior — no LLM calls).
	 */
	llm?: {
		provider: LLMProvider;
		model: string;
		apiKey: string;
		maxIterations?: number;
	};
	/**
	 * After Layer 2 (if any), insert `// @ts-expect-error - tsfix: …` above
	 * each unresolved error site so tsc exits 0. Opt-in. Default false.
	 */
	stubOnFailure?: boolean;
	/**
	 * Run all layers in memory; report counts but don't write. Default false.
	 * Layer 2 is auto-skipped under dryRun (it writes patches; would be a
	 * no-op).
	 */
	dryRun?: boolean;
	/** Logger. Default no-op. */
	logger?: Logger;
	/** Per-layer telemetry stream. Forwarded to Layer 1, 2, 4. */
	onLayerEvent?: (event: LayerEvent) => void;
	/** @internal — LLM call override. Tests inject a fake; real callers leave it. */
	_callLLM?: import("./mendAgent.js").LLMCall;
}

export interface RunFullStackResult {
	/** True if `errorsAfterAllLayers === 0`. */
	passed: boolean;
	/** Errors detected before any fix attempt. */
	errorsBefore: number;
	/** Errors remaining after Layer 0/1 (before Layer 2 + 4). */
	errorsAfterLayer1: number;
	/** Errors remaining after every layer that ran. */
	errorsAfterAllLayers: number;
	/** Per-layer sub-results. `layer2` is null when `llm` was omitted; `layer4` is null when `stubOnFailure` was false (or had no candidates). */
	layer1: ValidationLoopResult["lspFixer"];
	layer2: RunMendLoopResult | null;
	layer4: { stubsApplied: AppliedStub[] } | null;
	/** USD spent on Layer 2. 0 when Layer 2 didn't run. */
	totalCostUsd: number;
	/** Wall-clock total across all layers. */
	totalLatencyMs: number;
	/** Remaining diagnostics, grouped by TS code (e.g. `{TS2339: 3}`). */
	remainingByCode: Record<string, number>;
	/** Remaining diagnostics, grouped by file path (relative to workspaceRoot). */
	remainingByFile: Record<string, number>;
}

// USD per million tokens. Mirrors cli/run-stack.ts PRICING (snapshot 2026-05-16).
// TODO: extract to src/pricing.ts so cli + library + benchmark share one source.
const PRICING: Record<LLMProvider, Record<string, { input: number; output: number }>> = {
	anthropic: {
		"claude-haiku-4-5": { input: 1.0, output: 5.0 },
		"claude-sonnet-4-5": { input: 3.0, output: 15.0 },
		"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
		"claude-opus-4-5": { input: 5.0, output: 25.0 },
		"claude-opus-4-6": { input: 5.0, output: 25.0 },
		"claude-opus-4-7": { input: 5.0, output: 25.0 },
		"claude-opus-4-1": { input: 15.0, output: 75.0 },
	},
	openai: {
		"gpt-5-nano": { input: 0.05, output: 0.4 },
		"gpt-5-mini": { input: 0.25, output: 2.0 },
		"gpt-5": { input: 1.25, output: 10.0 },
		"gpt-5.1": { input: 1.25, output: 10.0 },
		"gpt-5.2": { input: 1.75, output: 14.0 },
		"o3-mini": { input: 1.1, output: 4.4 },
		"o4-mini": { input: 1.1, output: 4.4 },
		"o3": { input: 2.0, output: 8.0 },
	},
	google: {
		"gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
		"gemini-2.5-flash": { input: 0.3, output: 2.5 },
		"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	},
};

function costUsd(provider: LLMProvider, model: string, inputTokens: number, outputTokens: number): number {
	const p = PRICING[provider]?.[model];
	if (!p) return 0;
	return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

/**
 * Run the full tsfix stack (Layer 0/1 → Layer 2 → Layer 4) end-to-end.
 *
 * @example
 * ```ts
 * const result = await runFullStack({
 *   workspaceRoot: "/path/to/project",
 *   llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: KEY },
 *   stubOnFailure: true,
 *   onLayerEvent: (e) => console.log(e),
 * });
 * if (!result.passed) { ... }
 * console.log(`Spent $${result.totalCostUsd.toFixed(4)}`);
 * ```
 */
export async function runFullStack(opts: RunFullStackOptions): Promise<RunFullStackResult> {
	const startMs = Date.now();
	const { workspaceRoot, llm, stubOnFailure = false, dryRun = false, onLayerEvent } = opts;

	const layer1 = runValidationLoop({
		workspaceRoot,
		targetFiles: opts.targetFiles,
		skipLSPFixer: opts.skipLSPFixer,
		dryRun,
		logger: opts.logger,
		onLayerEvent,
	});

	let layer2: RunMendLoopResult | null = null;
	let layer4: { stubsApplied: AppliedStub[] } | null = null;
	let totalCostUsd = 0;
	let finalDiagnostics = layer1.diagnostics;

	const shouldRunLayer2 = llm && !dryRun && layer1.errorsAfter > 0;
	if (shouldRunLayer2) {
		const errorDiags = layer1.diagnostics.filter((d) => d.category === "error");
		layer2 = await runMendLoop({
			context: {
				workspaceRoot,
				diagnostics: errorDiags,
				erroredFiles: Array.from(new Set(errorDiags.map((d) => d.file))),
			},
			llm: { provider: llm.provider, model: llm.model, apiKey: llm.apiKey },
			maxIterations: llm.maxIterations,
			stubOnFailure,
			onLayerEvent,
			_callLLM: opts._callLLM,
		});
		totalCostUsd = costUsd(llm.provider, llm.model, layer2.totalInputTokens, layer2.totalOutputTokens);
		if (layer2.stubs && layer2.stubs.length > 0) {
			layer4 = { stubsApplied: layer2.stubs };
		}
		// Re-derive final diagnostics from disk — Layer 2/4 wrote files.
		resetInProcessTscCache();
		const post = runInProcessTsc({
			workspaceRoot,
			generatedFiles: opts.targetFiles ?? discoverTsFiles(workspaceRoot),
			logger: opts.logger ?? noopLogger,
		});
		finalDiagnostics = post.diagnostics;
	}

	const finalErrorDiags = finalDiagnostics.filter((d) => d.category === "error");
	const remainingByCode: Record<string, number> = {};
	const remainingByFile: Record<string, number> = {};
	for (const d of finalErrorDiags) {
		remainingByCode[d.code] = (remainingByCode[d.code] ?? 0) + 1;
		remainingByFile[d.file] = (remainingByFile[d.file] ?? 0) + 1;
	}

	return {
		passed: finalErrorDiags.length === 0,
		errorsBefore: layer1.errorsBefore,
		errorsAfterLayer1: layer1.errorsAfter,
		errorsAfterAllLayers: finalErrorDiags.length,
		layer1: layer1.lspFixer,
		layer2,
		layer4,
		totalCostUsd,
		totalLatencyMs: Date.now() - startMs,
		remainingByCode,
		remainingByFile,
	};
}
