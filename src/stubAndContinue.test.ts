import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubAndContinue } from "./stubAndContinue.js";
import type { Diagnostic } from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test infrastructure — write file → run stubber → read file back.
// We do NOT exercise tsc here; the integration test in runMendLoop.test.ts
// covers end-to-end "errors disappear after stubbing." This file tests the
// pure file-mutation logic.
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-stub-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
	const full = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
	return full;
}

function diag(file: string, line: number, code: string, message: string): Diagnostic {
	return { file, line, column: 1, code, message, category: "error" };
}

describe("stubAndContinue", () => {
	it("inserts @ts-expect-error above a single error site", () => {
		const file = writeFile(
			"src/api.ts",
			["const x = 1;", "const y = badFn();", "const z = 3;"].join("\n"),
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 2, "TS2304", "Cannot find name 'badFn'.")],
		});

		expect(result.stubsApplied).toHaveLength(1);
		expect(result.stubsApplied[0].errorLine).toBe(2);
		expect(result.stubsApplied[0].codes).toEqual(["TS2304"]);
		expect(result.diagnosticsAfter).toBe(0);

		const content = fs.readFileSync(file, "utf-8");
		const lines = content.split("\n");
		// Line 1 (0-indexed 0): const x = 1;
		// Line 2 (0-indexed 1): // @ts-expect-error ...
		// Line 3 (0-indexed 2): const y = badFn();
		expect(lines[0]).toBe("const x = 1;");
		expect(lines[1]).toMatch(/^\/\/ @ts-expect-error - tsfix: TS2304 — Cannot find name 'badFn'\.$/);
		expect(lines[2]).toBe("const y = badFn();");
		expect(lines[3]).toBe("const z = 3;");
	});

	it("groups multiple errors on the same line into one comment", () => {
		const file = writeFile(
			"src/api.ts",
			["const x = 1;", "const y = consol.log(JSon.parse(s));", "const z = 3;"].join("\n"),
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				diag(file, 2, "TS2552", "Cannot find name 'consol'. Did you mean 'console'?"),
				diag(file, 2, "TS2552", "Cannot find name 'JSon'. Did you mean 'JSON'?"),
			],
		});

		expect(result.stubsApplied).toHaveLength(1);
		expect(result.stubsApplied[0].codes).toEqual(["TS2552"]);
		// 2 diagnostics suppressed by 1 comment → diagnosticsAfter = 0
		expect(result.diagnosticsAfter).toBe(0);

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		expect(lines[1]).toContain("@ts-expect-error - tsfix: TS2552");
		// Both messages should be joined in the comment
		expect(lines[1]).toContain("consol");
		expect(lines[1]).toContain("JSon");
	});

	it("handles errors with different codes on the same line", () => {
		const file = writeFile(
			"src/api.ts",
			["function broken(x) {", "  return x.foo + bad();", "}"].join("\n"),
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				diag(file, 2, "TS2339", "Property 'foo' does not exist on type '{}'."),
				diag(file, 2, "TS2304", "Cannot find name 'bad'."),
			],
		});

		expect(result.stubsApplied).toHaveLength(1);
		expect(result.stubsApplied[0].codes).toEqual(["TS2304", "TS2339"]);

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		expect(lines[1]).toContain("@ts-expect-error - tsfix: TS2304, TS2339");
	});

	it("preserves indentation when inserting the comment", () => {
		const file = writeFile(
			"src/api.ts",
			[
				"function outer() {",
				"\tconst x = 1;",
				"\t\tif (x) {",
				"\t\t\treturn badFn();",
				"\t\t}",
				"}",
			].join("\n"),
		);

		stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 4, "TS2304", "Cannot find name 'badFn'.")],
		});

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		// errorLine 4 → 0-indexed 3. Comment inserted at index 3, original line shifts to 4.
		// Indent matches `\t\t\treturn badFn();` (3 tabs)
		expect(lines[3]).toMatch(/^\t\t\t\/\/ @ts-expect-error - tsfix: TS2304/);
		expect(lines[4]).toBe("\t\t\treturn badFn();");
	});

	it("processes multiple lines in descending order so indices don't shift", () => {
		const file = writeFile(
			"src/api.ts",
			[
				"const a = bad1();",
				"const b = 2;",
				"const c = bad2();",
				"const d = 4;",
				"const e = bad3();",
			].join("\n"),
		);

		stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				diag(file, 1, "TS2304", "Cannot find name 'bad1'."),
				diag(file, 3, "TS2304", "Cannot find name 'bad2'."),
				diag(file, 5, "TS2304", "Cannot find name 'bad3'."),
			],
		});

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		// 8 lines now: stub, bad1, b, stub, bad2, d, stub, bad3
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("@ts-expect-error");
		expect(lines[1]).toBe("const a = bad1();");
		expect(lines[2]).toBe("const b = 2;");
		expect(lines[3]).toContain("@ts-expect-error");
		expect(lines[4]).toBe("const c = bad2();");
		expect(lines[5]).toBe("const d = 4;");
		expect(lines[6]).toContain("@ts-expect-error");
		expect(lines[7]).toBe("const e = bad3();");
	});

	it("is idempotent — re-running on a stubbed file is a no-op", () => {
		const file = writeFile(
			"src/api.ts",
			["// @ts-expect-error - tsfix: TS2304 — Cannot find name 'badFn'.", "const x = badFn();"].join("\n"),
		);

		const originalContent = fs.readFileSync(file, "utf-8");

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			// tsc would still report the error if no @ts-expect-error worked, but the
			// stubber should detect the existing directive and skip.
			diagnostics: [diag(file, 2, "TS2304", "Cannot find name 'badFn'.")],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toBe("already_stubbed");

		// File content unchanged.
		expect(fs.readFileSync(file, "utf-8")).toBe(originalContent);
	});

	it("treats `// @ts-ignore` above as already-stubbed too", () => {
		const file = writeFile(
			"src/api.ts",
			["// @ts-ignore", "const x = badFn();"].join("\n"),
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 2, "TS2304", "Cannot find name 'badFn'.")],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.skipped[0].reason).toBe("already_stubbed");
	});

	it("skips files in node_modules", () => {
		const file = writeFile(
			"node_modules/some-pkg/index.ts",
			"const x: number = 'string';",
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 1, "TS2322", "Type 'string' is not assignable to type 'number'.")],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toBe("node_modules");
	});

	it("skips .d.ts files", () => {
		const file = writeFile(
			"src/types.d.ts",
			"export declare function foo(x: bad): void;",
		);

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 1, "TS2304", "Cannot find name 'bad'.")],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.skipped[0].reason).toBe("declaration_file");
	});

	it("skips when the file does not exist on disk", () => {
		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				diag(path.join(tempDir, "missing.ts"), 1, "TS2304", "Cannot find name 'x'."),
			],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.skipped[0].reason).toBe("file_not_found");
	});

	it("dryRun: reports stubs but does NOT modify disk", () => {
		const file = writeFile("src/api.ts", "const x = badFn();");
		const original = fs.readFileSync(file, "utf-8");

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 1, "TS2304", "Cannot find name 'badFn'.")],
			dryRun: true,
		});

		expect(result.stubsApplied).toHaveLength(1);
		expect(result.filesEdited).toEqual([file]);
		// File on disk unchanged
		expect(fs.readFileSync(file, "utf-8")).toBe(original);
	});

	it("truncates long error messages in the comment", () => {
		const file = writeFile("src/api.ts", ["x", "const y = bad();", "z"].join("\n"));
		const longMessage = "Cannot find name 'bad'. " + "x".repeat(500);

		stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 2, "TS2304", longMessage)],
			maxMessageLength: 50,
		});

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		// Length cap is 50 (the message portion), comment includes header + …
		expect(lines[1]).toContain("…");
		expect(lines[1].length).toBeLessThan(150);
	});

	it("preserves CRLF line endings when present", () => {
		const file = path.join(tempDir, "src/api.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "const x = 1;\r\nconst y = bad();\r\nconst z = 3;\r\n", "utf-8");

		stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 2, "TS2304", "Cannot find name 'bad'.")],
		});

		const content = fs.readFileSync(file, "utf-8");
		expect(content).toContain("\r\n");
		// Should not have introduced any bare LFs
		expect(content.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
	});

	it("handles errors on the first line of a file", () => {
		const file = writeFile("src/api.ts", ["const x = bad();", "const y = 2;"].join("\n"));

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [diag(file, 1, "TS2304", "Cannot find name 'bad'.")],
		});

		expect(result.stubsApplied).toHaveLength(1);

		const lines = fs.readFileSync(file, "utf-8").split("\n");
		expect(lines[0]).toContain("@ts-expect-error - tsfix: TS2304");
		expect(lines[1]).toBe("const x = bad();");
	});

	it("returns empty filesEdited when no eligible stubs", () => {
		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				diag(path.join(tempDir, "missing.ts"), 1, "TS2304", "x"),
				diag(path.join(tempDir, "src/types.d.ts"), 1, "TS2304", "y"),
			],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.filesEdited).toEqual([]);
		expect(result.skipped).toHaveLength(2);
	});

	it("ignores non-error diagnostics (warnings, suggestions)", () => {
		const file = writeFile("src/api.ts", "const x = 1;");

		const result = stubAndContinue({
			workspaceRoot: tempDir,
			diagnostics: [
				{ file, line: 1, column: 1, code: "TS6133", message: "x is declared but never used.", category: "warning" },
				{ file, line: 1, column: 1, code: "TS9999", message: "suggestion", category: "suggestion" },
			],
		});

		expect(result.stubsApplied).toHaveLength(0);
		expect(result.diagnosticsBefore).toBe(0);
	});
});
