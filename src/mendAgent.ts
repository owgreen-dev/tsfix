/**
 * Single-file LLM mend (Layer 2).
 *
 * Builds a prompt of:
 *   - System block: instructions + the erroring file's full content + type
 *     context resolved through the TS Language Service for each diagnostic.
 *   - User block: the diagnostics themselves (changes per iteration; cheap).
 *
 * Sends to Anthropic via Vercel AI SDK, parses the SEARCH/REPLACE response,
 * applies via `applyEditBlocks`. Multi-file scope is Layer 3 (deferred to
 * tsmend v0.2).
 *
 * Prompt-cache breakpoint placement is intentionally simple in v0.1.0 — we
 * pass the whole system block as one cached unit. Future tuning belongs in
 * `runMendLoop` once we have benchmark data on hit rates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { MendContext } from "./index.js";
import { getTypeContext } from "./typeContext.js";
import {
	applyEditBlocks,
	parseEditBlocks,
	type ApplyResult,
	type EditBlock,
} from "./applyEditBlock.js";

/**
 * Provider identifier. Each corresponds to one `@ai-sdk/<provider>` adapter
 * in the Vercel AI SDK. Adding a provider requires (1) the corresponding
 * `@ai-sdk/X` dep in package.json, (2) a case in `buildLanguageModel`, and
 * (3) the appropriate API-key env-var name documented in the CLI.
 */
export type LLMProvider = "anthropic" | "openai" | "google";

export interface MendSingleFileOptions {
	context: MendContext;
	llm: {
		provider: LLMProvider;
		model: string;
		apiKey: string;
	};
	/** Compute and parse patches but skip writing to disk. Default false. */
	dryRun?: boolean;
	/** @internal — LLM call override. Tests inject a fake; real callers leave it. */
	_callLLM?: LLMCall;
}

export interface MendSingleFileResult {
	rawResponse: string;
	blocks: EditBlock[];
	apply: ApplyResult;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

export type LLMCall = (params: {
	systemBlock: string;
	userBlock: string;
	/**
	 * Provider name. Optional for backward compatibility — when omitted,
	 * the default impl treats it as "anthropic" (matches v0.5.0 behavior).
	 * Test injection points can ignore this field.
	 */
	provider?: LLMProvider;
	model: string;
	apiKey: string;
}) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

const SYSTEM_INSTRUCTIONS = `You are a TypeScript code-repair tool. You receive a TypeScript file with one or more compiler errors and resolve them.

Output ONLY SEARCH/REPLACE blocks. No prose, no explanations, no XML wrappers.

The first line of each block is the workspace-relative file path on its own line. Then the SEARCH/REPLACE markers around the change. Concrete example:

src/api.ts
<<<<<<< SEARCH
const x = 1;
=======
const x: number = 1;
>>>>>>> REPLACE

Rules:
- The file path is a plain line. Do not wrap it in tags, fences, or quotes.
- SEARCH text must match the file VERBATIM. Whitespace, indentation, line endings: copy exactly.
- Make SEARCH unique. If a one-line search would match multiple places in the file, include 1-2 lines of surrounding context.
- REPLACE must be valid TypeScript that resolves the diagnostic.
- Do not invent imports, types, properties, or values. Use only what the type-context section shows.
- One SEARCH/REPLACE block per logical change.
- If you cannot resolve a diagnostic with the information given, omit a block for it.`;

function workspaceRelative(workspaceRoot: string, p: string): string {
	return path.isAbsolute(p) ? path.relative(workspaceRoot, p) : p;
}

/** @internal — exported for unit tests. */
export function buildSystemBlock(context: MendContext, erroredFile: string): string {
	const wsRel = workspaceRelative(context.workspaceRoot, erroredFile);
	const absPath = path.isAbsolute(erroredFile)
		? erroredFile
		: path.join(context.workspaceRoot, erroredFile);

	let fileContent: string;
	try {
		fileContent = fs.readFileSync(absPath, "utf-8");
	} catch {
		fileContent = "(file unreadable)";
	}

	const fileDiags = context.diagnostics.filter(
		(d) =>
			d.category === "error" &&
			workspaceRelative(context.workspaceRoot, d.file) === wsRel,
	);

	const typeContexts: string[] = [];
	const seen = new Set<string>();
	for (const diag of fileDiags) {
		const ctx = getTypeContext({
			workspaceRoot: context.workspaceRoot,
			diagnostic: diag,
		});
		if (!ctx.typeDeclaration) continue;
		const key = `${ctx.typeDeclaration.file}:${ctx.typeDeclaration.symbol}`;
		if (seen.has(key)) continue;
		seen.add(key);
		typeContexts.push(
			`// type: ${ctx.typeDeclaration.symbol}\n` +
				`// file: ${ctx.typeDeclaration.file}\n` +
				ctx.typeDeclaration.lines,
		);
	}

	const parts: string[] = [
		SYSTEM_INSTRUCTIONS,
		"",
		`### file: ${wsRel}`,
		"```ts",
		fileContent.replace(/\n$/, ""),
		"```",
	];
	if (typeContexts.length > 0) {
		parts.push("", "### type-context");
		for (const tc of typeContexts) {
			parts.push("```ts", tc, "```");
		}
	}
	if (context.taskDescription) {
		parts.push("", `### task`, context.taskDescription);
	}
	return parts.join("\n");
}

/** @internal — exported for unit tests. */
export function buildUserBlock(context: MendContext, erroredFile: string): string {
	const wsRel = workspaceRelative(context.workspaceRoot, erroredFile);
	const fileDiags = context.diagnostics.filter(
		(d) =>
			d.category === "error" &&
			workspaceRelative(context.workspaceRoot, d.file) === wsRel,
	);
	const lines = fileDiags.map(
		(d) => `${d.file}(${d.line},${d.column}): ${d.code}: ${d.message}`,
	);
	return `tsc reports:\n${lines.join("\n")}\n\nEmit SEARCH/REPLACE blocks to resolve.`;
}

/**
 * Build a Vercel-AI-SDK `LanguageModel` for the requested provider. Each
 * `@ai-sdk/X` package exports a `createX({ apiKey })` factory that returns
 * a callable; calling it with the model name yields a `LanguageModel`
 * compatible with `generateText`.
 *
 * Why factories per call (not module-level singletons): apiKey can vary
 * per call (different callers, different keys); factories are cheap;
 * `generateText` is the hot path and dominates wall time.
 */
function buildLanguageModel(provider: LLMProvider, model: string, apiKey: string): LanguageModel {
	switch (provider) {
		case "anthropic":
			return createAnthropic({ apiKey })(model);
		case "openai":
			return createOpenAI({ apiKey })(model);
		case "google":
			return createGoogleGenerativeAI({ apiKey })(model);
		default: {
			// Exhaustiveness check — TypeScript errors here if a new provider
			// is added to the union without a corresponding case.
			const _exhaustive: never = provider;
			throw new Error(`unknown provider: ${_exhaustive}`);
		}
	}
}

const defaultLLMCall: LLMCall = async ({ systemBlock, userBlock, provider = "anthropic", model, apiKey }) => {
	const llmModel = buildLanguageModel(provider, model, apiKey);
	// Use top-level `system:` parameter (Vercel AI SDK v6 pattern) rather than
	// putting a system role inside `messages` — the latter triggers the
	// "system messages in messages field" security warning and can be dropped
	// or rerouted on some providers.
	const result = await generateText({
		model: llmModel,
		system: systemBlock,
		messages: [{ role: "user", content: userBlock }],
	});
	return {
		text: result.text,
		inputTokens: result.usage?.inputTokens ?? 0,
		outputTokens: result.usage?.outputTokens ?? 0,
	};
};

export async function mendSingleFile(
	opts: MendSingleFileOptions,
): Promise<MendSingleFileResult> {
	const { context, llm, dryRun = false, _callLLM = defaultLLMCall } = opts;
	const erroredFile = context.erroredFiles[0];
	if (!erroredFile) {
		throw new Error("mendSingleFile: no errored files in context");
	}

	const systemBlock = buildSystemBlock(context, erroredFile);
	const userBlock = buildUserBlock(context, erroredFile);

	const startMs = Date.now();
	const llmResult = await _callLLM({
		systemBlock,
		userBlock,
		provider: llm.provider,
		model: llm.model,
		apiKey: llm.apiKey,
	});
	const latencyMs = Date.now() - startMs;

	const rawResponse = llmResult.text;
	const blocks = parseEditBlocks(rawResponse);
	const apply = applyEditBlocks({
		workspaceRoot: context.workspaceRoot,
		blocks,
		dryRun,
	});

	return {
		rawResponse,
		blocks,
		apply,
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		latencyMs,
	};
}
