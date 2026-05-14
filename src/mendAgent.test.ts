import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcessTsc } from "./validatorInProcess.js";
import type { Diagnostic, MendContext } from "./index.js";
import {
	buildSystemBlock,
	buildUserBlock,
	mendSingleFile,
	type LLMCall,
} from "./mendAgent.js";
import { resetTypeContextCache } from "./typeContext.js";

const require = createRequire(import.meta.url);
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-mend-"));
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
	const errorDiags = tsc.diagnostics.filter(
		(d: Diagnostic) => d.category === "error",
	);
	return {
		workspaceRoot: workspace,
		diagnostics: errorDiags,
		erroredFiles: Array.from(new Set(errorDiags.map((d: Diagnostic) => d.file))),
	};
}

describe("buildSystemBlock", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetTypeContextCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("includes the erroring file's content", () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);
		const out = buildSystemBlock(context, "broken.ts");
		expect(out).toContain("'hello'");
		expect(out).toContain("### file: broken.ts");
	});

	it("includes type-context block for TS2339", () => {
		fs.writeFileSync(
			path.join(workspace, "types.ts"),
			"export interface User { id: string; name: string; }\n",
		);
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			'import type { User } from "./types.js";\n' +
				"export function greet(u: User) { return u.email; }\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);
		const out = buildSystemBlock(context, "broken.ts");
		expect(out).toContain("### type-context");
		expect(out).toContain("// type: User");
		expect(out).toContain("interface User");
	});

	it("omits type-context section when no resolvable types (TS2304)", () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const greeting = doesNotExist;\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);
		const out = buildSystemBlock(context, "broken.ts");
		expect(out).not.toContain("### type-context");
	});

	it("appends taskDescription when provided", () => {
		fs.writeFileSync(path.join(workspace, "broken.ts"), "export const x = 1;\n");
		const context: MendContext = {
			workspaceRoot: workspace,
			diagnostics: [],
			erroredFiles: ["broken.ts"],
			taskDescription: "wire up auth",
		};
		const out = buildSystemBlock(context, "broken.ts");
		expect(out).toContain("### task");
		expect(out).toContain("wire up auth");
	});
});

describe("buildUserBlock", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetTypeContextCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("formats one line per diagnostic, scoped to the chosen file", () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'a';\nexport const y: number = 'b';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);
		const out = buildUserBlock(context, "broken.ts");
		expect(out).toMatch(/broken\.ts\(\d+,\d+\): TS\d+:/);
		// Two errors → two lines
		const lines = out.split("\n").filter((l) => l.includes("TS"));
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});
});

describe("mendSingleFile end-to-end with mocked LLM", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetTypeContextCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("calls the LLM, parses the response, applies the patch", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: [
				"broken.ts",
				"<<<<<<< SEARCH",
				"export const x: number = 'hello';",
				"=======",
				"export const x: string = 'hello';",
				">>>>>>> REPLACE",
			].join("\n"),
			inputTokens: 100,
			outputTokens: 50,
		}));

		const result = await mendSingleFile({
			context,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "test" },
			_callLLM: fakeLLM,
		});

		expect(fakeLLM).toHaveBeenCalledOnce();
		expect(result.blocks).toHaveLength(1);
		expect(result.apply.applied).toBe(1);
		expect(result.apply.failures).toHaveLength(0);
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(50);
		expect(fs.readFileSync(path.join(workspace, "broken.ts"), "utf-8")).toContain(
			"const x: string",
		);
	});

	it("dryRun parses but does not write to disk", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const context = buildContext(workspace, ["broken.ts"]);

		const fakeLLM: LLMCall = async () => ({
			text: [
				"broken.ts",
				"<<<<<<< SEARCH",
				"export const x: number = 'hello';",
				"=======",
				"export const x: string = 'hello';",
				">>>>>>> REPLACE",
			].join("\n"),
			inputTokens: 100,
			outputTokens: 50,
		});

		const result = await mendSingleFile({
			context,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "test" },
			dryRun: true,
			_callLLM: fakeLLM,
		});

		expect(result.apply.applied).toBe(1);
		expect(fs.readFileSync(path.join(workspace, "broken.ts"), "utf-8")).toContain(
			"const x: number",
		);
	});

	it("throws when there are no errored files in context", async () => {
		const context: MendContext = {
			workspaceRoot: workspace,
			diagnostics: [],
			erroredFiles: [],
		};
		await expect(
			mendSingleFile({
				context,
				llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "test" },
				_callLLM: async () => ({ text: "", inputTokens: 0, outputTokens: 0 }),
			}),
		).rejects.toThrow(/no errored files/);
	});
});
