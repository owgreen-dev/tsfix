/**
 * Bounded mend loop with no-progress detection.
 *
 *   1. Run tsc (`runInProcessTsc` from tsfix) to capture baseline diagnostics.
 *   2. If clean → return immediately with `stopReason: "noErrors"`.
 *   3. For up to `maxIterations`:
 *        a. Build a per-iteration MendContext scoped to the current errors.
 *        b. Call `mendSingleFile` (LLM → SEARCH/REPLACE → apply).
 *        c. Re-run tsc.
 *        d. Compare error-signature set:
 *             - empty             → "fixed"
 *             - same as previous  → "noProgress" (LLM made no useful change)
 *             - larger            → "regressed" (LLM made it worse)
 *             - shrunk / changed  → continue
 *   4. Hit maxIterations → `stopReason: "maxIterations"`.
 *
 * The signature is `(file, line, column, code)` — same shape tsfix's Layer 0
 * fixer uses internally. We don't import that helper because it's an
 * `@internal` export of tsfix; reimplementing here is ~10 lines.
 *
 * dryRun: runs a single iteration with mendSingleFile in dry-run mode, then
 * returns. We can't iterate without writing to disk because re-validation
 * needs the actual file changes.
 */

import type { Diagnostic, MendContext } from "./index.js";
import { resetInProcessTscCache, runInProcessTsc } from "./validatorInProcess.js";
import { mendSingleFile, type LLMCall, type MendSingleFileResult } from "./mendAgent.js";
import { stubAndContinue, type AppliedStub } from "./stubAndContinue.js";

export interface RunMendLoopOptions {
	context: MendContext;
	llm: {
		provider: "anthropic";
		model: string;
		apiKey: string;
	};
	/** Hard cap on LLM calls. Default 3. */
	maxIterations?: number;
	/** Single dry-run pass — call LLM, parse, but don't write to disk. Default false. */
	dryRun?: boolean;
	/**
	 * When the loop exits with leftover errors (stopReason !== "fixed"),
	 * apply Layer 4 stub-and-continue: insert `// @ts-expect-error - tsfix: ...`
	 * comments above each unresolved error site so tsc exits 0. Opt-in.
	 * Default false. Ignored when `dryRun: true`.
	 */
	stubOnFailure?: boolean;
	/** @internal — LLM call override for tests. */
	_callLLM?: LLMCall;
}

export interface MendLoopIteration {
	index: number;
	diagnosticsBefore: number;
	diagnosticsAfter: number;
	patchesApplied: number;
	patchesFailed: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	/** Raw LLM response for this iteration — useful for debugging failed patches. */
	rawResponse: string;
}

export type StopReason =
	| "noErrors"
	| "fixed"
	| "noProgress"
	| "regressed"
	| "maxIterations"
	| "stubbed";

export interface RunMendLoopResult {
	iterations: MendLoopIteration[];
	diagnosticsBefore: Diagnostic[];
	diagnosticsAfter: Diagnostic[];
	passed: boolean;
	stopReason: StopReason;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalLatencyMs: number;
	/**
	 * Layer 4 stubs applied after the LLM loop terminated with leftover
	 * errors. Present only when `stubOnFailure: true` was set. Empty array
	 * means stubOnFailure ran but nothing was eligible (e.g. all errors
	 * were in .d.ts files).
	 */
	stubs?: AppliedStub[];
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function errorSignature(d: Diagnostic): string {
	return `${d.file}:${d.line}:${d.column}:${d.code}`;
}

function signatureSet(diags: Diagnostic[]): Set<string> {
	const out = new Set<string>();
	for (const d of diags) {
		if (d.category === "error") out.add(errorSignature(d));
	}
	return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function refreshDiagnostics(workspaceRoot: string, files: string[]): Diagnostic[] {
	resetInProcessTscCache();
	const result = runInProcessTsc({
		workspaceRoot,
		generatedFiles: files,
		logger: noopLogger,
	});
	return result.diagnostics.filter((d: Diagnostic) => d.category === "error");
}

export async function runMendLoop(opts: RunMendLoopOptions): Promise<RunMendLoopResult> {
	const { context, llm, maxIterations = 3, dryRun = false, stubOnFailure = false, _callLLM } = opts;
	const startMs = Date.now();

	const diagnosticsBefore = context.diagnostics.filter((d) => d.category === "error");

	if (diagnosticsBefore.length === 0) {
		return {
			iterations: [],
			diagnosticsBefore,
			diagnosticsAfter: [],
			passed: true,
			stopReason: "noErrors",
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalLatencyMs: Date.now() - startMs,
		};
	}

	const filesInScope = Array.from(new Set(context.diagnostics.map((d) => d.file)));

	const iterations: MendLoopIteration[] = [];
	let currentDiags = diagnosticsBefore;
	let prevSig = signatureSet(currentDiags);
	let stopReason: StopReason = "maxIterations";
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	for (let i = 0; i < maxIterations; i++) {
		const erroredFiles = Array.from(new Set(currentDiags.map((d) => d.file)));
		const iterContext: MendContext = {
			...context,
			diagnostics: currentDiags,
			erroredFiles,
		};

		const mend: MendSingleFileResult = await mendSingleFile({
			context: iterContext,
			llm,
			dryRun,
			_callLLM,
		});

		totalInputTokens += mend.inputTokens;
		totalOutputTokens += mend.outputTokens;

		const newDiags = dryRun
			? currentDiags // can't re-validate without disk writes
			: refreshDiagnostics(context.workspaceRoot, filesInScope);
		const newSig = signatureSet(newDiags);

		iterations.push({
			index: i,
			diagnosticsBefore: currentDiags.length,
			diagnosticsAfter: newDiags.length,
			patchesApplied: mend.apply.applied,
			patchesFailed: mend.apply.failures.length,
			inputTokens: mend.inputTokens,
			outputTokens: mend.outputTokens,
			latencyMs: mend.latencyMs,
			rawResponse: mend.rawResponse,
		});

		if (dryRun) {
			currentDiags = newDiags;
			stopReason = "maxIterations";
			break;
		}

		if (newDiags.length === 0) {
			stopReason = "fixed";
			currentDiags = newDiags;
			break;
		}
		if (newSig.size > prevSig.size) {
			stopReason = "regressed";
			currentDiags = newDiags;
			break;
		}
		if (setsEqual(newSig, prevSig)) {
			stopReason = "noProgress";
			currentDiags = newDiags;
			break;
		}

		currentDiags = newDiags;
		prevSig = newSig;
	}

	// Layer 4 — stub-and-continue. Only runs when the LLM loop didn't
	// reach `fixed` AND the caller opted in AND we're not in dryRun.
	let stubs: AppliedStub[] | undefined;
	if (stubOnFailure && !dryRun && currentDiags.length > 0) {
		const stubResult = stubAndContinue({
			workspaceRoot: context.workspaceRoot,
			diagnostics: currentDiags,
		});
		stubs = stubResult.stubsApplied;
		// Re-validate so diagnosticsAfter reflects the post-stub state.
		const postStubDiags = refreshDiagnostics(context.workspaceRoot, filesInScope);
		if (postStubDiags.length === 0) {
			stopReason = "stubbed";
		}
		currentDiags = postStubDiags;
	}

	return {
		iterations,
		diagnosticsBefore,
		diagnosticsAfter: currentDiags,
		passed: currentDiags.length === 0,
		stopReason,
		totalInputTokens,
		totalOutputTokens,
		totalLatencyMs: Date.now() - startMs,
		...(stubs !== undefined ? { stubs } : {}),
	};
}
