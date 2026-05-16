import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We test the CLI by spawning the actual binary (tsx cli/run-stack.ts). This
// catches integration issues that pure unit tests of parseArgs would miss —
// arg-handler ordering, exit codes, the help text reaching stderr, etc.

const cliPath = path.resolve(__dirname, "run-stack.ts");
const repoRoot = path.resolve(__dirname, "..");

let tempWorkspace: string;

function setupWorkspace(content: string): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-cli-test-"));
	fs.mkdirSync(path.join(ws, "node_modules"));
	// Symlink typescript so the in-process tsc can find lib files.
	const realTs = path.dirname(
		require.resolve("typescript/package.json", { paths: [repoRoot] }),
	);
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
	fs.writeFileSync(path.join(ws, "src.ts"), content);
	return ws;
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
	const result = spawnSync("npx", ["tsx", cliPath, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ANTHROPIC_API_KEY: "", ...env },
		encoding: "utf-8",
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.status ?? -1,
	};
}

beforeEach(() => {
	tempWorkspace = setupWorkspace("export const x = 1;\n");
});

afterEach(() => {
	if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
});

describe("CLI — argument validation", () => {
	it("exits 2 with help when --workspace is omitted", () => {
		const r = runCli([]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("--workspace");
	});

	it("--help exits 0", () => {
		const r = runCli(["--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain("Usage");
		expect(r.stderr).toContain("--llm");
		expect(r.stderr).toContain("Exit codes");
	});

	it("--help mentions all Layer-2 flags", () => {
		const r = runCli(["--help"]);
		expect(r.stderr).toContain("--llm-model");
		expect(r.stderr).toContain("--llm-max-iterations");
		expect(r.stderr).toContain("--llm-budget-usd");
		expect(r.stderr).toContain("ANTHROPIC_API_KEY");
	});

	it("invalid --llm-max-iterations exits 2", () => {
		const r = runCli([
			"--workspace",
			tempWorkspace,
			"--llm",
			"--llm-max-iterations",
			"not-a-number",
		]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("positive integer");
	});

	it("invalid --llm-budget-usd exits 2", () => {
		const r = runCli([
			"--workspace",
			tempWorkspace,
			"--llm",
			"--llm-budget-usd",
			"-5",
		]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("positive number");
	});

	it("workspace without tsconfig.json exits 2", () => {
		const noTsconfig = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-cli-test-"));
		try {
			const r = runCli(["--workspace", noTsconfig]);
			expect(r.exitCode).toBe(2);
			expect(r.stderr).toContain("tsconfig.json");
		} finally {
			fs.rmSync(noTsconfig, { recursive: true, force: true });
		}
	});

	it("missing workspace path exits 2", () => {
		const r = runCli(["--workspace", "/tmp/definitely-does-not-exist-tsfix-test"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("workspace not found");
	});
});

describe("CLI — Layer 0 (default path)", () => {
	it("clean workspace exits 0 with passed=true", () => {
		const r = runCli(["--workspace", tempWorkspace, "--json"]);
		expect(r.exitCode).toBe(0);
		const report = JSON.parse(r.stdout);
		expect(report.passed).toBe(true);
		expect(report.errorsBefore).toBe(0);
		expect(report.errorsAfter).toBe(0);
		expect(report.layer2).toBeNull();
	});

	it("workspace with a fixable TS2552 typo exits 0 after Layer 0 fixes it", () => {
		fs.writeFileSync(
			path.join(tempWorkspace, "src.ts"),
			"const x = consol.log(1);\n",
		);
		const r = runCli(["--workspace", tempWorkspace, "--json"]);
		expect(r.exitCode).toBe(0);
		const report = JSON.parse(r.stdout);
		expect(report.passed).toBe(true);
		expect(report.lspFixer.ran).toBe(true);
		expect(report.lspFixer.fixesApplied).toBeGreaterThan(0);
	});

	it("workspace with unfixable error exits 1 (without --llm)", () => {
		fs.writeFileSync(
			path.join(tempWorkspace, "src.ts"),
			"export const x: number = 'string-literal';\n", // TS2322 — Layer 0 abstains
		);
		const r = runCli(["--workspace", tempWorkspace, "--json"]);
		expect(r.exitCode).toBe(1);
		const report = JSON.parse(r.stdout);
		expect(report.passed).toBe(false);
		expect(report.errorsAfter).toBeGreaterThan(0);
		expect(report.layer2).toBeNull();
	});
});

describe("CLI — Layer 2 flag (without making real LLM calls)", () => {
	it("--llm without ANTHROPIC_API_KEY exits 2 with helpful error", () => {
		fs.writeFileSync(
			path.join(tempWorkspace, "src.ts"),
			"export const x: number = 'string-literal';\n",
		);
		const r = runCli(["--workspace", tempWorkspace, "--llm"], {
			ANTHROPIC_API_KEY: "",
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("ANTHROPIC_API_KEY");
	});

	it("--llm + --dry-run is rejected (mutually exclusive)", () => {
		fs.writeFileSync(
			path.join(tempWorkspace, "src.ts"),
			"export const x: number = 'string-literal';\n",
		);
		const r = runCli(["--workspace", tempWorkspace, "--llm", "--dry-run"], {
			ANTHROPIC_API_KEY: "test-key",
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("mutually exclusive");
	});

	it("--llm on a clean workspace doesn't trigger Layer 2 (nothing to mend)", () => {
		const r = runCli(["--workspace", tempWorkspace, "--llm", "--json"], {
			ANTHROPIC_API_KEY: "test-key", // not used — no errors to escalate
		});
		expect(r.exitCode).toBe(0);
		const report = JSON.parse(r.stdout);
		expect(report.layer2).toBeNull(); // Layer 2 only runs if errors survive Layer 0/1
	});
});

describe("CLI — multi-provider (v0.6.0+)", () => {
	beforeEach(() => {
		fs.writeFileSync(
			path.join(tempWorkspace, "src.ts"),
			"export const x: number = 'string-literal';\n",
		);
	});

	it("--help lists all three providers and their env-var names", () => {
		const r = runCli(["--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain("--llm-provider");
		expect(r.stderr).toContain("anthropic");
		expect(r.stderr).toContain("openai");
		expect(r.stderr).toContain("google");
		expect(r.stderr).toContain("ANTHROPIC_API_KEY");
		expect(r.stderr).toContain("OPENAI_API_KEY");
		expect(r.stderr).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
	});

	it("invalid --llm-provider value exits 2", () => {
		const r = runCli(["--workspace", tempWorkspace, "--llm", "--llm-provider", "mistral"]);
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("--llm-provider");
		expect(r.stderr).toContain("anthropic, openai, google");
	});

	it("--llm-provider openai checks OPENAI_API_KEY, not ANTHROPIC_API_KEY", () => {
		// Set ANTHROPIC_API_KEY but NOT OPENAI_API_KEY → should still fail
		// because we asked for openai.
		const r = runCli(["--workspace", tempWorkspace, "--llm", "--llm-provider", "openai"], {
			ANTHROPIC_API_KEY: "anthropic-key",
			OPENAI_API_KEY: "",
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("OPENAI_API_KEY");
		expect(r.stderr).not.toContain("ANTHROPIC_API_KEY");
	});

	it("--llm-provider google checks GOOGLE_GENERATIVE_AI_API_KEY", () => {
		const r = runCli(["--workspace", tempWorkspace, "--llm", "--llm-provider", "google"], {
			GOOGLE_GENERATIVE_AI_API_KEY: "",
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
	});

	it("default provider is anthropic (back-compat with v0.5.0 callers)", () => {
		// No --llm-provider flag, no ANTHROPIC_API_KEY → error mentions Anthropic.
		const r = runCli(["--workspace", tempWorkspace, "--llm"], {
			ANTHROPIC_API_KEY: "",
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("ANTHROPIC_API_KEY");
		expect(r.stderr).toContain("anthropic");
	});
});
