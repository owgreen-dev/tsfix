import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcessTsc } from "./validatorInProcess.js";
import type { Diagnostic, MendContext } from "./index.js";
import { runMendLoop } from "./runMendLoop.js";
import { type LLMCall } from "./mendAgent.js";
import { resetTypeContextCache } from "./typeContext.js";

const require = createRequire(import.meta.url);
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const llmConfig = {
	provider: "anthropic" as const,
	model: "claude-haiku-4-5",
	apiKey: "test",
};

function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-loop-"));
	fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
	const realTs = path.dirname(require.resolve("typescript/package.json"));
	fs.symlinkSync(realTs, path.join(ws, "node_modules", "typescript"));
	fs.writeFileSync(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({
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
		}),
	);
	return ws;
}

function buildContext(workspace: string, files: string[]): MendContext {
	const tsc = runInProcessTsc({
		workspaceRoot: workspace,
		generatedFiles: files,
		logger: noopLogger,
	});
	const errorDiags = tsc.diagnostics.filter((d: Diagnostic) => d.category === "error");
	return {
		workspaceRoot: workspace,
		diagnostics: errorDiags,
		erroredFiles: Array.from(new Set(errorDiags.map((d: Diagnostic) => d.file))),
	};
}

function searchReplaceBlock(file: string, search: string, replace: string): string {
	return [file, "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n");
}

describe("runMendLoop", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetTypeContextCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("returns immediately with stopReason='noErrors' on clean input", async () => {
		fs.writeFileSync(path.join(workspace, "ok.ts"), "export const x = 1;\n");
		const context: MendContext = {
			workspaceRoot: workspace,
			diagnostics: [],
			erroredFiles: [],
		};
		const fakeLLM = vi.fn();
		const result = await runMendLoop({
			context,
			llm: llmConfig,
			_callLLM: fakeLLM as unknown as LLMCall,
		});
		expect(result.passed).toBe(true);
		expect(result.stopReason).toBe("noErrors");
		expect(result.iterations).toHaveLength(0);
		expect(fakeLLM).not.toHaveBeenCalled();
	});

	it("stops with stopReason='fixed' when LLM resolves all errors in one iteration", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'hello';",
				"export const x: string = 'hello';",
			),
			inputTokens: 100,
			outputTokens: 50,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(true);
		expect(result.stopReason).toBe("fixed");
		expect(result.iterations).toHaveLength(1);
		expect(result.iterations[0].patchesApplied).toBe(1);
		expect(result.totalInputTokens).toBe(100);
		expect(result.totalOutputTokens).toBe(50);
	});

	it("stops with stopReason='noProgress' when LLM patches don't apply or don't help", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		// SEARCH text isn't in the file → applyEditBlocks records a failure and
		// the file is unchanged → re-running tsc yields the same signature set →
		// loop bails after iteration 1.
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock("broken.ts", "no such text in file", "irrelevant"),
			inputTokens: 100,
			outputTokens: 50,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 5,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(false);
		expect(result.stopReason).toBe("noProgress");
		expect(result.iterations).toHaveLength(1);
		expect(result.iterations[0].patchesApplied).toBe(0);
		expect(result.iterations[0].patchesFailed).toBe(1);
		expect(fakeLLM).toHaveBeenCalledOnce();
	});

	it("stops with stopReason='maxIterations' when progress is made but not enough", async () => {
		// Two distinct errors. LLM fixes one per iteration. With maxIterations=1
		// it should stop having made real progress but with errors remaining.
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'a';\nexport const y: number = 'b';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'a';",
				"export const x: string = 'a';",
			),
			inputTokens: 100,
			outputTokens: 50,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 1,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(false);
		expect(result.stopReason).toBe("maxIterations");
		expect(result.iterations).toHaveLength(1);
		// One error fixed, one remains
		expect(result.diagnosticsAfter.length).toBe(1);
	});

	it("loops across multiple iterations when each LLM call makes partial progress", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'a';\nexport const y: number = 'b';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		let callCount = 0;
		const fakeLLM: LLMCall = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				return {
					text: searchReplaceBlock(
						"broken.ts",
						"export const x: number = 'a';",
						"export const x: string = 'a';",
					),
					inputTokens: 100,
					outputTokens: 50,
				};
			}
			return {
				text: searchReplaceBlock(
					"broken.ts",
					"export const y: number = 'b';",
					"export const y: string = 'b';",
				),
				inputTokens: 100,
				outputTokens: 50,
			};
		});

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 3,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(true);
		expect(result.stopReason).toBe("fixed");
		expect(result.iterations).toHaveLength(2);
		expect(fakeLLM).toHaveBeenCalledTimes(2);
		expect(result.totalInputTokens).toBe(200);
	});

	it("dryRun runs a single iteration without writing to disk", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'hello';",
				"export const x: string = 'hello';",
			),
			inputTokens: 100,
			outputTokens: 50,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			dryRun: true,
			maxIterations: 5,
			_callLLM: fakeLLM,
		});

		expect(result.iterations).toHaveLength(1);
		expect(fakeLLM).toHaveBeenCalledOnce();
		// Disk untouched
		expect(fs.readFileSync(path.join(workspace, "broken.ts"), "utf-8")).toContain(
			"const x: number",
		);
	});

	it("stubOnFailure: applies @ts-expect-error when the loop fails and flips stopReason to 'stubbed'", async () => {
		const brokenPath = path.join(workspace, "broken.ts");
		fs.writeFileSync(brokenPath, "export const x: number = 'hello';\n");
		const context = buildContext(workspace, ["broken.ts"]);
		expect(context.diagnostics.length).toBeGreaterThan(0);

		// LLM that never produces a valid patch — forces noProgress → stub.
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: "no patches here",
			inputTokens: 50,
			outputTokens: 10,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 1,
			stubOnFailure: true,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(true);
		expect(result.stopReason).toBe("stubbed");
		expect(result.stubs).toBeDefined();
		expect(result.stubs!.length).toBeGreaterThan(0);
		expect(result.stubs![0].codes).toContain("TS2322");

		const post = fs.readFileSync(brokenPath, "utf-8");
		expect(post).toContain("@ts-expect-error - tsfix: TS2322");
		// Re-validate: tsc should now be clean.
		const postTsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: [brokenPath],
			logger: noopLogger,
		});
		expect(postTsc.diagnostics.filter((d: Diagnostic) => d.category === "error")).toEqual([]);
	});

	it("stubOnFailure: false (default) — leaves errors in place when the loop fails", async () => {
		const brokenPath = path.join(workspace, "broken.ts");
		fs.writeFileSync(brokenPath, "export const x: number = 'hello';\n");
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: "no patches",
			inputTokens: 50,
			outputTokens: 10,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 1,
			_callLLM: fakeLLM,
		});

		expect(result.passed).toBe(false);
		expect(result.stopReason).not.toBe("stubbed");
		expect(result.stubs).toBeUndefined();
		// File untouched
		const post = fs.readFileSync(brokenPath, "utf-8");
		expect(post).not.toContain("@ts-expect-error");
	});

	it("stubOnFailure with dryRun: true — does NOT apply stubs (dry-run takes precedence)", async () => {
		const brokenPath = path.join(workspace, "broken.ts");
		fs.writeFileSync(brokenPath, "export const x: number = 'hello';\n");
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: "no patches",
			inputTokens: 50,
			outputTokens: 10,
		}));

		const result = await runMendLoop({
			context,
			llm: llmConfig,
			maxIterations: 1,
			dryRun: true,
			stubOnFailure: true,
			_callLLM: fakeLLM,
		});

		expect(result.stubs).toBeUndefined();
		expect(fs.readFileSync(brokenPath, "utf-8")).not.toContain("@ts-expect-error");
	});
});
