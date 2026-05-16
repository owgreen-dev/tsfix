/**
 * tsfix CLI entry — bundled to `dist/cli.js` and run as
 * `npx @shipispec/tsfix --workspace <path>`.
 *
 * Default path is Layer 0/1 only (deterministic LSP auto-fix; no network
 * calls). Pass `--llm` to escalate the remaining errors to Layer 2
 * (Anthropic-only today; multi-provider follows in a later PR).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
	runInProcessTsc,
	runMendLoop,
	runValidationLoop,
	discoverTsFiles,
	type Diagnostic,
	type LLMProvider,
	type MendContext,
	type ValidationLoopResult,
} from "../src/index.js";

interface CliArgs {
	workspace: string;
	json: boolean;
	noLsp: boolean;
	dryRun: boolean;
	files: string[] | undefined;
	verbose: boolean;
	llm: boolean;
	llmProvider: LLMProvider;
	llmModel: string;
	llmMaxIterations: number;
	llmBudgetUsd: number | undefined;
}

interface StackReport {
	workspace: string;
	errorsBefore: number;
	lspFixer: {
		ran: boolean;
		fixesApplied: number;
		filesEdited: string[];
		iterations: number;
	} | null;
	layer2: {
		ran: boolean;
		stopReason: string;
		errorsBefore: number;
		errorsAfter: number;
		iterations: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCostUsd: number;
		budgetExceeded: boolean;
		provider: LLMProvider;
		model: string;
	} | null;
	errorsAfter: number;
	remainingByCode: Record<string, number>;
	remainingByFile: Record<string, number>;
	passed: boolean;
	elapsedMs: number;
	dryRun: boolean;
	logs?: string[];
}

// USD per million tokens. Pricing snapshot: 2026-05-16.
// Verified against the live pricing pages:
// - Anthropic: docs.claude.com/en/docs/about-claude/pricing
// - OpenAI:    via the LiteLLM model_prices_and_context_window.json mirror
//              (raw.githubusercontent.com/BerriAI/litellm/...) since
//              openai.com/api/pricing blocks plain HTTP fetchers
// - Google:    ai.google.dev/gemini-api/docs/pricing
// Unknown (provider, model) pairs log a warning and report cost as 0 — budget
// cap won't trigger, since we can't compute spend reliably. Re-verify the
// table before any tagged release; provider pricing shifts.
const PRICING: Record<LLMProvider, Record<string, { input: number; output: number }>> = {
	anthropic: {
		// All 4.5+ models share the same tier (the 4.5 release brought a
		// significant price drop on Opus). 4.1 retains the older Opus tier.
		"claude-haiku-4-5": { input: 1.0, output: 5.0 },
		"claude-sonnet-4-5": { input: 3.0, output: 15.0 },
		"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
		"claude-opus-4-5": { input: 5.0, output: 25.0 },
		"claude-opus-4-6": { input: 5.0, output: 25.0 },
		"claude-opus-4-7": { input: 5.0, output: 25.0 },
		"claude-opus-4-1": { input: 15.0, output: 75.0 },
	},
	openai: {
		// Mini / nano tiers — well-matched to TypeScript repair (small
		// context, structured output). Default model uses one of these.
		"gpt-5-nano": { input: 0.05, output: 0.4 },
		"gpt-5-mini": { input: 0.25, output: 2.0 },
		// gpt-5 flagship + recent point releases (all $1.25 / $10).
		"gpt-5": { input: 1.25, output: 10.0 },
		"gpt-5.1": { input: 1.25, output: 10.0 },
		"gpt-5.2": { input: 1.75, output: 14.0 },
		// Reasoning models — sometimes better at semantic repair, more expensive.
		"o3-mini": { input: 1.1, output: 4.4 },
		"o4-mini": { input: 1.1, output: 4.4 },
		"o3": { input: 2.0, output: 8.0 },
	},
	google: {
		// Lite < flash < pro, matching the haiku/sonnet/opus mental model.
		"gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
		"gemini-2.5-flash": { input: 0.3, output: 2.5 },
		// Standard tier (≤200k tokens). 2.5-pro doubles to $2.50/$15.00 above
		// 200k — not modeled here since our prompts are well below that.
		"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	},
};

function estimateCostUsd(
	provider: LLMProvider,
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const p = PRICING[provider]?.[model];
	if (!p) return 0;
	return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

const ENV_KEY_BY_PROVIDER: Record<LLMProvider, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

const DEFAULT_MODEL_BY_PROVIDER: Record<LLMProvider, string> = {
	anthropic: "claude-haiku-4-5",
	openai: "gpt-5-mini",
	google: "gemini-2.5-flash",
};

function isLLMProvider(s: string): s is LLMProvider {
	return s === "anthropic" || s === "openai" || s === "google";
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		workspace: "",
		json: false,
		noLsp: false,
		dryRun: false,
		files: undefined,
		verbose: false,
		llm: false,
		llmProvider: "anthropic",
		// llmModel default depends on provider — we set it AFTER parsing so
		// `--llm-provider openai` without `--llm-model` picks gpt-4o-mini, etc.
		// An empty string here means "use the provider's default".
		llmModel: "",
		llmMaxIterations: 3,
		llmBudgetUsd: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--workspace" || a === "-w") {
			args.workspace = argv[++i] ?? "";
		} else if (a === "--json") {
			args.json = true;
		} else if (a === "--no-lsp") {
			args.noLsp = true;
		} else if (a === "--dry-run") {
			args.dryRun = true;
		} else if (a === "--files") {
			args.files = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		} else if (a === "--verbose" || a === "-v") {
			args.verbose = true;
		} else if (a === "--llm") {
			args.llm = true;
		} else if (a === "--llm-provider") {
			const p = argv[++i] ?? "";
			if (!isLLMProvider(p)) {
				console.error(`error: --llm-provider expects one of: anthropic, openai, google. Got '${p}'`);
				process.exit(2);
			}
			args.llmProvider = p;
		} else if (a === "--llm-model") {
			args.llmModel = argv[++i] ?? args.llmModel;
		} else if (a === "--llm-max-iterations") {
			const n = parseInt(argv[++i] ?? "", 10);
			if (Number.isNaN(n) || n < 1) {
				console.error(`error: --llm-max-iterations expects a positive integer, got '${argv[i]}'`);
				process.exit(2);
			}
			args.llmMaxIterations = n;
		} else if (a === "--llm-budget-usd") {
			const v = parseFloat(argv[++i] ?? "");
			if (Number.isNaN(v) || v < 0) {
				console.error(`error: --llm-budget-usd expects a positive number, got '${argv[i]}'`);
				process.exit(2);
			}
			args.llmBudgetUsd = v;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	if (!args.workspace) {
		console.error("error: --workspace <path> is required");
		printHelp();
		process.exit(2);
	}
	// Apply provider-specific default model if user didn't pass --llm-model.
	if (args.llmModel === "") {
		args.llmModel = DEFAULT_MODEL_BY_PROVIDER[args.llmProvider];
	}
	return args;
}

function printHelp(): void {
	console.error(`
Usage: tsfix --workspace <path> [options]

Layer 0/1 (default — deterministic, no network):
  --workspace, -w <path>      Workspace root (required)
  --files <a.ts,b.ts>         Scope tsc/lsp to this comma-separated list
  --no-lsp                    Skip Layer 0 LSP auto-fixer (validate only)
  --dry-run                   Run fixer in memory; list edits but don't write
  --json                      Emit JSON report on stdout
  --verbose, -v               Stream layer logs to stderr
  --help, -h                  Show this help

Layer 2 (opt-in — single-file LLM mend):
  --llm                       Enable Layer 2 on errors that survive Layer 0/1
  --llm-provider <name>       anthropic | openai | google   (default: anthropic)
  --llm-model <name>          Model name. Defaults per provider:
                                anthropic → claude-haiku-4-5
                                openai    → gpt-5-mini
                                google    → gemini-2.5-flash
                              Known-priced models per provider:
                                anthropic: claude-haiku-4-5, -sonnet-4-5,
                                           -sonnet-4-6, -opus-4-5, -opus-4-6,
                                           -opus-4-7, -opus-4-1
                                openai:    gpt-5-nano, gpt-5-mini, gpt-5,
                                           gpt-5.1, gpt-5.2, o3-mini, o4-mini, o3
                                google:    gemini-2.5-flash-lite, gemini-2.5-flash,
                                           gemini-2.5-pro
                              Cost estimate is 0 for unlisted models (the
                              warning suggests pinning a listed one).
  --llm-max-iterations <N>    Cap on LLM retries (default: 3)
  --llm-budget-usd <amount>   Soft cost cap. Exits with code 3 if exceeded.

Layer 2 requires the provider's API key in env:
  anthropic → ANTHROPIC_API_KEY
  openai    → OPENAI_API_KEY
  google    → GOOGLE_GENERATIVE_AI_API_KEY

Exit codes:
  0  no errors after stack
  1  errors remain after stack
  2  bad arguments / harness error
  3  Layer 2 budget exceeded (errors may still remain; partial work persisted)
`.trim());
}

function makeLogger(captureLines: string[], verbose: boolean) {
	const log = (level: string, msg: string) => {
		const line = `[${level}] ${msg}`;
		captureLines.push(line);
		if (verbose) process.stderr.write(line + "\n");
	};
	return {
		info: (m: string) => log("info", m),
		warn: (m: string) => log("warn", m),
		error: (m: string) => log("error", m),
	};
}

function printHumanReport(r: StackReport): void {
	const w = process.stderr;
	w.write(`\nTSC Defense Stack — ${r.workspace}${r.dryRun ? " (dry-run)" : ""}\n`);
	w.write(`  errors before: ${r.errorsBefore}\n`);
	if (r.lspFixer?.ran) {
		const verb = r.dryRun ? "would apply" : "applied";
		const editVerb = r.dryRun ? "would edit" : "edited";
		w.write(
			`  LSP fixer:     ${verb} ${r.lspFixer.fixesApplied} fix(es) in ${r.lspFixer.iterations} iter(s); ${editVerb} ${r.lspFixer.filesEdited.length} file(s)\n`,
		);
		if (r.dryRun && r.lspFixer.filesEdited.length > 0) {
			for (const f of r.lspFixer.filesEdited) {
				w.write(`    - ${f}\n`);
			}
		}
	} else {
		w.write(`  LSP fixer:     skipped\n`);
	}
	if (r.layer2) {
		const l2 = r.layer2;
		w.write(
			`  Layer 2 (LLM): ${l2.errorsBefore} → ${l2.errorsAfter} errors  ${l2.iterations}× iter  ${l2.totalInputTokens}→${l2.totalOutputTokens} tokens  $${l2.totalCostUsd.toFixed(4)} ${l2.budgetExceeded ? "⚠️  budget exceeded" : ""}\n`,
		);
		w.write(`                 ${l2.provider}/${l2.model} · stopReason=${l2.stopReason}\n`);
	}
	w.write(`  errors after:  ${r.errorsAfter}\n`);
	if (r.errorsAfter > 0) {
		const top = Object.entries(r.remainingByCode)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);
		w.write(`  top remaining codes:\n`);
		for (const [code, n] of top) {
			w.write(`    ${code.padEnd(8)} ${n}\n`);
		}
	}
	w.write(`  elapsed:       ${r.elapsedMs}ms\n`);
	w.write(`  ${r.passed ? "✓ PASS" : "✗ FAIL"}\n\n`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const workspaceRoot = path.resolve(args.workspace);
	if (!fs.existsSync(workspaceRoot)) {
		console.error(`error: workspace not found: ${workspaceRoot}`);
		return 2;
	}
	if (!fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
		console.error(`error: no tsconfig.json in ${workspaceRoot}`);
		return 2;
	}

	const logs: string[] = [];
	const logger = makeLogger(logs, args.verbose);

	const targetFiles = args.files ?? discoverTsFiles(workspaceRoot);
	if (targetFiles.length === 0) {
		console.error("error: no .ts/.tsx files found in workspace");
		return 2;
	}

	const loop: ValidationLoopResult = runValidationLoop({
		workspaceRoot,
		targetFiles,
		skipLSPFixer: args.noLsp,
		dryRun: args.dryRun,
		logger,
	});

	const report: StackReport = {
		workspace: path.relative(process.cwd(), workspaceRoot) || workspaceRoot,
		errorsBefore: loop.errorsBefore,
		lspFixer: args.noLsp
			? { ran: false, fixesApplied: 0, filesEdited: [], iterations: 0 }
			: loop.lspFixer,
		layer2: null,
		errorsAfter: loop.errorsAfter,
		remainingByCode: loop.remainingByCode,
		remainingByFile: loop.remainingByFile,
		passed: loop.passed,
		elapsedMs: loop.elapsedMs,
		dryRun: args.dryRun,
	};

	let budgetExceeded = false;

	// ── Layer 2 escalation ─────────────────────────────────────────────────
	if (args.llm && loop.errorsAfter > 0) {
		if (args.dryRun) {
			console.error("error: --llm and --dry-run are mutually exclusive (Layer 2 writes patches to disk)");
			return 2;
		}
		const envKeyName = ENV_KEY_BY_PROVIDER[args.llmProvider];
		const apiKey = process.env[envKeyName];
		if (!apiKey) {
			console.error(`error: --llm with provider '${args.llmProvider}' requires ${envKeyName} in the environment`);
			return 2;
		}
		if (!PRICING[args.llmProvider]?.[args.llmModel]) {
			logger.warn(
				`unknown model '${args.llmProvider}/${args.llmModel}' — cost estimates will be 0; budget cap will not trigger`,
			);
		}

		const errorDiags = loop.diagnostics.filter((d) => d.category === "error");
		const context: MendContext = {
			workspaceRoot,
			diagnostics: errorDiags,
			erroredFiles: Array.from(new Set(errorDiags.map((d: Diagnostic) => d.file))),
		};

		const layer2Start = Date.now();
		const mend = await runMendLoop({
			context,
			llm: { provider: args.llmProvider, model: args.llmModel, apiKey },
			maxIterations: args.llmMaxIterations,
		});
		void layer2Start;

		const totalCostUsd = estimateCostUsd(
			args.llmProvider,
			args.llmModel,
			mend.totalInputTokens,
			mend.totalOutputTokens,
		);
		budgetExceeded =
			args.llmBudgetUsd !== undefined && totalCostUsd > args.llmBudgetUsd;

		report.layer2 = {
			ran: true,
			stopReason: mend.stopReason,
			errorsBefore: errorDiags.length,
			errorsAfter: mend.diagnosticsAfter.length,
			iterations: mend.iterations.length,
			totalInputTokens: mend.totalInputTokens,
			totalOutputTokens: mend.totalOutputTokens,
			totalCostUsd,
			budgetExceeded,
			provider: args.llmProvider,
			model: args.llmModel,
		};

		// Re-derive the final report from the post-Layer-2 state. Layer 2
		// may have written files, so we need a fresh in-process tsc to get
		// accurate remainingByCode / remainingByFile.
		const post = runInProcessTsc({
			workspaceRoot,
			generatedFiles: targetFiles,
			logger,
		});
		const postErrorDiags = post.diagnostics.filter((d) => d.category === "error");
		report.errorsAfter = postErrorDiags.length;
		report.remainingByCode = {};
		report.remainingByFile = {};
		for (const d of postErrorDiags) {
			report.remainingByCode[d.code] = (report.remainingByCode[d.code] ?? 0) + 1;
			report.remainingByFile[d.file] = (report.remainingByFile[d.file] ?? 0) + 1;
		}
		report.passed = report.errorsAfter === 0;
		report.elapsedMs = loop.elapsedMs + (Date.now() - layer2Start);
	}

	if (args.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		printHumanReport(report);
	}

	// Exit code precedence: budget exceeded (3) > errors remain (1) > clean (0).
	// 2 is reserved for bad args / harness errors and is returned earlier.
	if (budgetExceeded) return 3;
	return report.passed ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("harness error:", err instanceof Error ? err.stack : err);
		process.exit(2);
	},
);
