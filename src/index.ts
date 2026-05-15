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
		const lsp = runLSPFixerPass({ workspaceRoot, targetFiles, logger, dryRun });
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
export type { MendSingleFileOptions, MendSingleFileResult, LLMCall } from "./mendAgent.js";

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
