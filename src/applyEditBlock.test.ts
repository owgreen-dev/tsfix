import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyEditBlocks,
	applySingleBlock,
	parseEditBlocks,
} from "./applyEditBlock.js";

describe("parseEditBlocks", () => {
	it("parses a single block with file path on the preceding line", () => {
		const out = [
			"Here's the fix:",
			"",
			"src/api.ts",
			"```ts",
			"<<<<<<< SEARCH",
			"const x = 1;",
			"=======",
			"const x: number = 1;",
			">>>>>>> REPLACE",
			"```",
			"",
			"Should resolve TS2322.",
		].join("\n");

		const blocks = parseEditBlocks(out);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].file).toBe("src/api.ts");
		expect(blocks[0].search).toBe("const x = 1;");
		expect(blocks[0].replace).toBe("const x: number = 1;");
	});

	it("parses multiple blocks across files", () => {
		const out = [
			"src/a.ts",
			"<<<<<<< SEARCH",
			"foo",
			"=======",
			"bar",
			">>>>>>> REPLACE",
			"",
			"src/b.ts",
			"<<<<<<< SEARCH",
			"baz",
			"=======",
			"qux",
			">>>>>>> REPLACE",
		].join("\n");

		const blocks = parseEditBlocks(out);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ file: "src/a.ts", search: "foo", replace: "bar" });
		expect(blocks[1]).toEqual({ file: "src/b.ts", search: "baz", replace: "qux" });
	});

	it("returns empty array on plain prose", () => {
		expect(parseEditBlocks("nothing structural here")).toEqual([]);
	});

	it("ignores a block truncated mid-stream", () => {
		const out = ["src/a.ts", "<<<<<<< SEARCH", "foo", "======="].join("\n");
		expect(parseEditBlocks(out)).toEqual([]);
	});

	it("extracts the path from a <file path=\"…\"> wrapper (Claude regression)", () => {
		// Claude often mirrors XML markers from the system prompt back into its
		// output. Path attribute should still resolve cleanly.
		const out = [
			'<file path="src/api.ts">',
			"<<<<<<< SEARCH",
			"foo",
			"=======",
			"bar",
			">>>>>>> REPLACE",
			"</file>",
		].join("\n");
		const blocks = parseEditBlocks(out);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].file).toBe("src/api.ts");
	});

	it("skips a closing </…> tag when walking back to the path of a subsequent block", () => {
		const out = [
			'<file path="src/a.ts">',
			"<<<<<<< SEARCH",
			"foo",
			"=======",
			"bar",
			">>>>>>> REPLACE",
			"</file>",
			'<file path="src/b.ts">',
			"<<<<<<< SEARCH",
			"baz",
			"=======",
			"qux",
			">>>>>>> REPLACE",
			"</file>",
		].join("\n");
		const blocks = parseEditBlocks(out);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].file).toBe("src/a.ts");
		expect(blocks[1].file).toBe("src/b.ts");
	});
});

describe("applySingleBlock fuzzy match tiers", () => {
	it("applies exact match", () => {
		const result = applySingleBlock("hello world", "hello", "goodbye");
		expect("newContent" in result).toBe(true);
		if ("newContent" in result) {
			expect(result.newContent).toBe("goodbye world");
			expect(result.matchedTier).toBe("exact");
		}
	});

	it("applies rstrip match (file has trailing whitespace, search doesn't)", () => {
		const file = "  function f() {\n    return 1;   \n  }\n";
		const search = "    return 1;\n  }";
		const result = applySingleBlock(file, search, "    return 2;\n  }");
		expect("newContent" in result).toBe(true);
		if ("newContent" in result) {
			expect(result.matchedTier).toBe("rstrip");
			expect(result.newContent).toContain("return 2;");
		}
	});

	it("applies strip match (file has different indentation than search)", () => {
		// File uses 2-space indent; search expresses 4-space (LLM picked the
		// wrong indent). Exact and rstrip both fail; strip removes leading
		// whitespace per-line and matches.
		const file = "function f() {\n  return 1;\n}\n";
		const search = "    return 1;";
		const result = applySingleBlock(file, search, "    return 2;");
		expect("newContent" in result).toBe(true);
		if ("newContent" in result) {
			expect(result.matchedTier).toBe("strip");
		}
	});

	it("abstains on ambiguous exact match", () => {
		const result = applySingleBlock("foo\nfoo\n", "foo", "bar");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("ambiguous");
		}
	});

	it("reports 'no match' cleanly", () => {
		const result = applySingleBlock("hello", "world", "earth");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toBe("no match");
		}
	});

	it("rejects empty search blocks", () => {
		const result = applySingleBlock("hello", "", "world");
		expect("error" in result).toBe(true);
	});
});

describe("applyEditBlocks end-to-end", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-apply-"));
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("writes the edit to disk and reports filesEdited", () => {
		const file = path.join(workspace, "broken.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		const result = applyEditBlocks({
			workspaceRoot: workspace,
			blocks: [
				{ file: "broken.ts", search: "const x = 1;", replace: "const x: number = 1;" },
			],
		});
		expect(result.applied).toBe(1);
		expect(result.failures).toHaveLength(0);
		expect(result.filesEdited).toEqual([file]);
		expect(fs.readFileSync(file, "utf-8")).toBe("const x: number = 1;\n");
	});

	it("dryRun computes the result but does not write to disk", () => {
		const file = path.join(workspace, "broken.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		const result = applyEditBlocks({
			workspaceRoot: workspace,
			blocks: [
				{ file: "broken.ts", search: "const x = 1;", replace: "const x: number = 1;" },
			],
			dryRun: true,
		});
		expect(result.applied).toBe(1);
		expect(fs.readFileSync(file, "utf-8")).toBe("const x = 1;\n");
	});

	it("stacks multiple blocks against the same file in order", () => {
		const file = path.join(workspace, "broken.ts");
		fs.writeFileSync(file, "const x = 1;\nconst y = 2;\n");
		const result = applyEditBlocks({
			workspaceRoot: workspace,
			blocks: [
				{ file: "broken.ts", search: "const x = 1;", replace: "const x: number = 1;" },
				{ file: "broken.ts", search: "const y = 2;", replace: "const y: number = 2;" },
			],
		});
		expect(result.applied).toBe(2);
		expect(fs.readFileSync(file, "utf-8")).toBe(
			"const x: number = 1;\nconst y: number = 2;\n",
		);
	});

	it("collects failures without aborting subsequent blocks", () => {
		const file = path.join(workspace, "broken.ts");
		fs.writeFileSync(file, "const x = 1;\n");
		const result = applyEditBlocks({
			workspaceRoot: workspace,
			blocks: [
				{ file: "broken.ts", search: "nonexistent", replace: "whatever" },
				{ file: "broken.ts", search: "const x = 1;", replace: "const x: number = 1;" },
			],
		});
		expect(result.applied).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].reason).toBe("no match");
		expect(fs.readFileSync(file, "utf-8")).toBe("const x: number = 1;\n");
	});
});
