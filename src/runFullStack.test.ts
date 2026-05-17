import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFullStack, type LayerEvent } from "./index.js";
import type { LLMCall } from "./mendAgent.js";

const require = createRequire(import.meta.url);

function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-fullstack-"));
	fs.mkdirSync(path.join(ws, "node_modules"));
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

function searchReplaceBlock(file: string, search: string, replace: string): string {
	return [file, "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n");
}

let workspace: string;

beforeEach(() => {
	workspace = setupWorkspace();
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

describe("runFullStack — composition", () => {
	it("clean workspace → passes, layer2/layer4 null, totalCostUsd 0", async () => {
		fs.writeFileSync(path.join(workspace, "ok.ts"), "export const x = 1;\n");
		const r = await runFullStack({ workspaceRoot: workspace });

		expect(r.passed).toBe(true);
		expect(r.errorsBefore).toBe(0);
		expect(r.errorsAfterLayer1).toBe(0);
		expect(r.errorsAfterAllLayers).toBe(0);
		expect(r.layer2).toBeNull();
		expect(r.layer4).toBeNull();
		expect(r.totalCostUsd).toBe(0);
	});

	it("Layer 1 fixes a TS2552 typo without invoking Layer 2", async () => {
		fs.writeFileSync(
			path.join(workspace, "src.ts"),
			"export const x = consol.log(1);\n",
		);
		const r = await runFullStack({ workspaceRoot: workspace });

		expect(r.passed).toBe(true);
		expect(r.errorsBefore).toBeGreaterThan(0);
		expect(r.errorsAfterLayer1).toBe(0);
		expect(r.layer1.fixesApplied).toBeGreaterThan(0);
		expect(r.layer2).toBeNull(); // no llm config → Layer 2 skipped entirely
	});

	it("unfixable error + no llm → fails, layer2 null", async () => {
		fs.writeFileSync(
			path.join(workspace, "src.ts"),
			"export const x: number = 'string-literal';\n",
		);
		const r = await runFullStack({ workspaceRoot: workspace });

		expect(r.passed).toBe(false);
		expect(r.errorsAfterLayer1).toBeGreaterThan(0);
		expect(r.errorsAfterAllLayers).toBe(r.errorsAfterLayer1);
		expect(r.layer2).toBeNull();
	});

	it("unfixable error + mocked LLM → Layer 2 runs, totalCostUsd reflects token usage", async () => {
		const filepath = path.join(workspace, "broken.ts");
		fs.writeFileSync(filepath, "export const x: number = 'hello';\n");

		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'hello';",
				"export const x: string = 'hello';",
			),
			inputTokens: 1_000_000, // 1M tokens → $1 input on claude-haiku-4-5
			outputTokens: 100_000, // 100k → $0.50 output
		}));

		const r = await runFullStack({
			workspaceRoot: workspace,
			llm: {
				provider: "anthropic",
				model: "claude-haiku-4-5",
				apiKey: "test-key",
				maxIterations: 1,
			},
			_callLLM: fakeLLM,
		});

		expect(r.passed).toBe(true);
		expect(r.layer2).not.toBeNull();
		expect(r.layer2!.stopReason).toBe("fixed");
		expect(fakeLLM).toHaveBeenCalledOnce();
		// claude-haiku-4-5: $1.00 input + $5.00 output per MTok.
		// 1M input + 100k output → $1.00 + $0.50 = $1.50.
		expect(r.totalCostUsd).toBeCloseTo(1.5, 2);
	});

	it("unknown model → cost reported as 0 (no warning crash)", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'hello';",
				"export const x: string = 'hello';",
			),
			inputTokens: 999_999,
			outputTokens: 999_999,
		}));

		const r = await runFullStack({
			workspaceRoot: workspace,
			llm: { provider: "anthropic", model: "claude-experimental-9000", apiKey: "k", maxIterations: 1 },
			_callLLM: fakeLLM,
		});

		expect(r.totalCostUsd).toBe(0);
		// Layer 2 still ran successfully — pricing is decoupled from execution.
		expect(r.layer2).not.toBeNull();
	});

	it("stubOnFailure → Layer 4 fires when LLM fails", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: "I cannot fix this", // no edit blocks
			inputTokens: 50,
			outputTokens: 10,
		}));

		const r = await runFullStack({
			workspaceRoot: workspace,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k", maxIterations: 1 },
			stubOnFailure: true,
			_callLLM: fakeLLM,
		});

		expect(r.passed).toBe(true); // Layer 4 silenced the error
		expect(r.layer4).not.toBeNull();
		expect(r.layer4!.stubsApplied.length).toBeGreaterThan(0);
		expect(fs.readFileSync(path.join(workspace, "broken.ts"), "utf-8")).toContain(
			"@ts-expect-error",
		);
	});
});

describe("runFullStack — onLayerEvent telemetry", () => {
	it("Layer 1: emits one event per fixable error attempt", async () => {
		// Two TS2552 typos on different lines → 2 per-error events.
		fs.writeFileSync(
			path.join(workspace, "src.ts"),
			"export const x = consol.log(1);\nexport const y = JSon.parse('{}');\n",
		);

		const events: LayerEvent[] = [];
		await runFullStack({
			workspaceRoot: workspace,
			onLayerEvent: (e) => events.push(e),
		});

		const layer1 = events.filter((e) => e.layer === 1);
		expect(layer1.length).toBeGreaterThanOrEqual(2);
		const codes = new Set(layer1.map((e) => e.errorCode));
		expect(codes.has(2552)).toBe(true);
		// Every event has a sane shape
		for (const e of layer1) {
			expect(e.layer).toBe(1);
			expect(typeof e.errorCode).toBe("number");
			expect(typeof e.fixed).toBe("boolean");
			expect(typeof e.latencyMs).toBe("number");
			expect(typeof e.ts).toBe("number");
		}
	});

	it("Layer 2: emits one event per iteration with the dominant errorCode", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const events: LayerEvent[] = [];
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: searchReplaceBlock(
				"broken.ts",
				"export const x: number = 'hello';",
				"export const x: string = 'hello';",
			),
			inputTokens: 100,
			outputTokens: 50,
		}));

		await runFullStack({
			workspaceRoot: workspace,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k", maxIterations: 3 },
			onLayerEvent: (e) => events.push(e),
			_callLLM: fakeLLM,
		});

		const layer2 = events.filter((e) => e.layer === 2);
		expect(layer2.length).toBe(1); // one iteration → one event
		expect(layer2[0].errorCode).toBe(2322); // dominant code was TS2322
		expect(layer2[0].fixed).toBe(true); // iteration cleared all errors
	});

	it("Layer 4: emits one event per stub applied", async () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const events: LayerEvent[] = [];
		const fakeLLM: LLMCall = vi.fn(async () => ({
			text: "no patches",
			inputTokens: 50,
			outputTokens: 10,
		}));

		await runFullStack({
			workspaceRoot: workspace,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k", maxIterations: 1 },
			stubOnFailure: true,
			onLayerEvent: (e) => events.push(e),
			_callLLM: fakeLLM,
		});

		const layer4 = events.filter((e) => e.layer === 4);
		expect(layer4.length).toBeGreaterThan(0);
		for (const e of layer4) {
			expect(e.layer).toBe(4);
			expect(e.fixed).toBe(true);
			expect(e.latencyMs).toBe(0); // stubs are essentially instant
		}
	});

	it("undefined onLayerEvent: no crash, no measurable cost (smoke)", async () => {
		fs.writeFileSync(
			path.join(workspace, "src.ts"),
			"export const x = consol.log(1);\n",
		);
		// Just verify nothing throws when the callback is omitted.
		await expect(runFullStack({ workspaceRoot: workspace })).resolves.toBeDefined();
	});
});
