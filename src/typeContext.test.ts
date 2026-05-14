import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessTsc } from "./validatorInProcess.js";
import type { Diagnostic } from "./index.js";
import { getTypeContext, resetTypeContextCache } from "./typeContext.js";

// Driving the test through `runInProcessTsc` (rather than synthesizing a
// Diagnostic by hand) keeps the test honest: column/line numbers come from
// the same code path tsfix's runtime emits, so a refactor of either side
// can't silently desync.

const require = createRequire(import.meta.url);
const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-typecontext-"));
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

describe("getTypeContext", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetTypeContextCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("returns errorSite for any diagnostic, even ones with no resolvable type", () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["broken.ts"],
			logger: noopLogger,
		});
		const diag = tsc.diagnostics.find((d: Diagnostic) => d.category === "error");
		expect(diag).toBeDefined();

		const ctx = getTypeContext({ workspaceRoot: workspace, diagnostic: diag! });
		expect(ctx.errorSite.file).toBe("broken.ts");
		expect(ctx.errorSite.lines).toContain("'hello'");
	});

	it("resolves a TS2339 'property does not exist' error to its declaring interface", () => {
		fs.writeFileSync(
			path.join(workspace, "types.ts"),
			"export interface User {\n  id: string;\n  name: string;\n}\n",
		);
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			'import type { User } from "./types.js";\n' +
				"export function greet(u: User): string {\n" +
				"  return u.email;\n" +
				"}\n",
		);
		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["broken.ts"],
			logger: noopLogger,
		});
		const diag = tsc.diagnostics.find((d: Diagnostic) => d.code === "TS2339");
		expect(diag, "expected a TS2339 diagnostic").toBeDefined();

		const ctx = getTypeContext({ workspaceRoot: workspace, diagnostic: diag! });
		expect(ctx.typeDeclaration).toBeDefined();
		expect(ctx.typeDeclaration?.symbol).toBe("User");
		expect(ctx.typeDeclaration?.file).toContain("types.ts");
		expect(ctx.typeDeclaration?.lines).toContain("interface User");
		expect(ctx.typeDeclaration?.lines).toContain("id: string");
	});

	it("returns errorSite only when the error node has no resolvable user-land type (TS2304)", () => {
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const greeting = doesNotExist;\n",
		);
		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["broken.ts"],
			logger: noopLogger,
		});
		const diag = tsc.diagnostics.find((d: Diagnostic) => d.code === "TS2304");
		expect(diag, "expected a TS2304 diagnostic").toBeDefined();

		const ctx = getTypeContext({ workspaceRoot: workspace, diagnostic: diag! });
		expect(ctx.errorSite.lines).toContain("doesNotExist");
		// TS2304 = "Cannot find name". By definition there is no declaration to
		// resolve to, so typeDeclaration should be undefined.
		expect(ctx.typeDeclaration).toBeUndefined();
	});
});
