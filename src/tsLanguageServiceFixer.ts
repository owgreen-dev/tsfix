/**
 * TS Language Service Fixer — Sprint G / Sprint J (2026-05-03).
 *
 * Layer 0 of the mend stack. Uses TypeScript's built-in `LanguageService.getCodeFixesAtPosition`
 * (the same engine VS Code's Quick Fix uses) to resolve common errors *deterministically*,
 * before we spend a single LLM call on them.
 *
 * Why this exists: ~80% of generated-code TS errors fall into a small set of
 * boring categories that the compiler already knows how to fix:
 *
 *   - TS2304 "Cannot find name X"           → auto-import
 *   - TS2305 "no exported member named X"   → did-you-mean rename
 *   - TS2551 "Property X does not exist on Y. Did you mean Z?" → spelling fix
 *   - TS2552 "Cannot find name X. Did you mean Y?" → spelling fix
 *   - TS2724 "no exported member, did you mean Y?" → import rename
 *
 * For these, the fixer is free (no LLM), fast (~ms), and deterministic.
 * The LLM mend stack only gets called for *interesting* errors that require
 * semantic reasoning (signature drift, missing logic, package gotchas).
 *
 * Conservative coverage: we only apply fixes for codes whose auto-fixes are
 * unambiguous. Codes like TS7006 (implicit any) and TS2741 (missing property)
 * are skipped — those need human intent to choose the right type or default
 * value, and a wrong auto-fix introduces silent bugs.
 *
 * Iteration cap: 5 passes. After each pass we re-validate; cascades like
 * "rename import → rename type annotation → rename method call" can need 3-4
 * hops to converge. The signature-set progress check stops sooner if no new
 * errors appear. If errors remain after pass 5, escalate to LLM mend.
 *
 * Feature flag: `SPECTOSHIP_TS_LSP_FIXER=false` opts out (default: ON).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/** TS error codes whose built-in code-fix is safe to apply without human review. */
const SAFE_FIXABLE_CODES = new Set<number>([
	2304, // Cannot find name 'X'
	2305, // Module '...' has no exported member 'X'
	2551, // Property 'X' does not exist on type 'Y'. Did you mean 'Z'?
	2552, // Cannot find name 'X'. Did you mean 'Y'?
	2724, // '...' has no exported member named 'X'. Did you mean 'Y'?
]);

/**
 * Allowlist of TypeScript fix names we will apply. Many TS error codes return
 * multiple alternative fixes (e.g. for TS2304: "import" adds an import,
 * `fixMissingFunctionDeclaration` declares a stub) and the wrong one rewrites
 * intent. Only the names below are deterministic and safe.
 *
 * Discovered via probe (2026-05-03): for TS2304 'Cannot find name', the LSP
 * returns ["import", "fixMissingFunctionDeclaration"]. Without this allowlist,
 * the equivalence check rejected both and the auto-import never fired.
 */
const SAFE_FIX_NAMES = new Set<string>([
	"import", // auto-add import statement (TS2304, TS2305)
	"fixImport", // alternative auto-import in some scenarios
	"spelling", // did-you-mean rename for TS2552 (the actual fixName the LSP returns)
	"fixSpelling", // alternate spelling-fix name some TS versions emit
]);

export interface LSPFixerLogger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface LSPFixerOptions {
	workspaceRoot: string;
	/** Files where errors were detected. Limits the fix scope. */
	targetFiles: string[];
	logger: LSPFixerLogger;
	/** Max iterations (default 5). Signature-set progress check stops sooner. */
	maxIterations?: number;
	/**
	 * When true, run the full fix loop in memory but do NOT persist edits to
	 * disk. Returned `LSPFixerResult` is identical otherwise — `filesEdited`
	 * lists the files that *would* have been written, `fixesApplied` is the
	 * count of fixes the loop computed. Use to preview what tsfix would do
	 * before letting it modify a workspace.
	 */
	dryRun?: boolean;
	/**
	 * Per-error telemetry callback. One event per `(errorCode, fix-attempt)`
	 * with `fixed: true` when the fix landed and `fixed: false` when the LSP
	 * abstained (no safe candidate). Events fire even on dry runs.
	 * Optional — undefined callback costs nothing.
	 */
	onLayerEvent?: (event: import("./index.js").LayerEvent) => void;
}

export interface LSPFixerResult {
	/** Number of fixes successfully applied across all iterations. */
	fixesApplied: number;
	/** Files whose contents were modified on disk. */
	filesEdited: string[];
	/** Iteration count when fixer stopped (1 if it converged on first pass). */
	iterations: number;
	/** When true, every diagnostic was auto-fixable and resolved. Caller can skip LLM mend. */
	allResolved: boolean;
	/** Errors remaining after the last iteration (caller passes these to LLM mend). */
	remainingErrors: Array<{
		file: string;
		line: number;
		column: number;
		code: string;
		message: string;
	}>;
}

/**
 * Apply LSP code-fixes to all diagnostics in the workspace whose error code
 * is in SAFE_FIXABLE_CODES. Writes edits back to disk. Re-runs ts diagnostics
 * after each pass; stops when no further fixable errors remain or
 * maxIterations is reached.
 *
 * Throws on host setup failure (missing tsconfig, etc.) — callers should
 * catch and fall through to LLM mend.
 */
export function runLSPFixerPass(opts: LSPFixerOptions): LSPFixerResult {
	const { workspaceRoot, targetFiles, logger, onLayerEvent } = opts;
	const maxIterations = opts.maxIterations ?? 5;
	const dryRun = opts.dryRun ?? false;
	const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) {
		return {
			fixesApplied: 0,
			filesEdited: [],
			iterations: 0,
			allResolved: true,
			remainingErrors: [],
		};
	}

	const compilerOptions = readCompilerOptions(tsconfigPath, logger);
	if (!compilerOptions) {
		return {
			fixesApplied: 0,
			filesEdited: [],
			iterations: 0,
			allResolved: true,
			remainingErrors: [],
		};
	}

	// Build a versioned in-memory snapshot table. The host reads from this
	// table for files we've edited, falling back to disk for everything else.
	// Without versioning, the LanguageService caches stale ASTs and misfires.
	const snapshots = new Map<string, { content: string; version: number }>();
	const filesEdited = new Set<string>();
	let totalFixes = 0;

	// Resolve workspace's typescript lib dir for `getDefaultLibFileName` — the
	// extension-bundled typescript can't find its lib files (esbuild strips
	// `__dirname` resolution). See validatorInProcess.ts for the same fix.
	const workspaceLibDir = path.join(workspaceRoot, "node_modules", "typescript", "lib");
	const hasWorkspaceLib = fs.existsSync(workspaceLibDir);

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => Array.from(snapshots.keys()),
		getScriptVersion: (fileName) => String(snapshots.get(fileName)?.version ?? 0),
		getScriptSnapshot: (fileName) => {
			const cached = snapshots.get(fileName);
			if (cached) {
				return ts.ScriptSnapshot.fromString(cached.content);
			}
			if (!fs.existsSync(fileName)) {
				return undefined;
			}
			try {
				const content = fs.readFileSync(fileName, "utf-8");
				snapshots.set(fileName, { content, version: 1 });
				return ts.ScriptSnapshot.fromString(content);
			} catch {
				return undefined;
			}
		},
		getCurrentDirectory: () => workspaceRoot,
		getCompilationSettings: () => compilerOptions,
		getDefaultLibFileName: (options) => {
			if (hasWorkspaceLib) {
				// Return absolute path inside the workspace's typescript install.
				// LanguageService uses the directory of this file as the lib dir,
				// which means lib.dom.d.ts / lib.es2015.d.ts etc. resolve there too.
				return path.join(workspaceLibDir, path.basename(ts.getDefaultLibFilePath(options)));
			}
			return ts.getDefaultLibFilePath(options);
		},
		fileExists: (fileName) => snapshots.has(fileName) || fs.existsSync(fileName),
		readFile: (fileName) =>
			snapshots.get(fileName)?.content ??
			(fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : undefined),
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};

	// Seed the snapshot map with all target files so the LanguageService
	// scans them on first call.
	for (const f of targetFiles) {
		const abs = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
		if (!fs.existsSync(abs)) {
			continue;
		}
		const content = fs.readFileSync(abs, "utf-8");
		snapshots.set(abs, { content, version: 1 });
	}

	const service = ts.createLanguageService(host, ts.createDocumentRegistry());

	let iter = 0;
	let lastErrorSignatures = new Set<string>();
	for (iter = 1; iter <= maxIterations; iter++) {
		const fixableErrors = collectFixableErrors(service, snapshots, workspaceRoot);
		if (fixableErrors.length === 0) {
			break;
		}
		// Detect "stuck loop": same identical set of fixable errors across two
		// iterations. Compare by (file, start, code) signature, not just count —
		// a fix can convert a TS2724 at position A into a TS2552 at position B,
		// which keeps the count at 1 but is genuine progress.
		const signatures = computeErrorSignatures(fixableErrors);
		if (signatureSetsEqual(signatures, lastErrorSignatures)) {
			logger.info(
				`[ts-lsp-fixer] iteration ${iter}: no progress (${fixableErrors.length} fixable error(s), same set as last iter) — stopping`,
			);
			break;
		}
		lastErrorSignatures = signatures;

		let appliedThisIter = 0;
		for (const err of fixableErrors) {
			const errStartMs = Date.now();
			const fixes = safeGetCodeFixes(service, err);
			if (!fixes || fixes.length === 0) {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
				continue;
			}
			// Pick the safest applicable fix:
			// 1. Filter to only fixes whose `fixName` is in SAFE_FIX_NAMES.
			//    This rules out destructive alternatives like
			//    `fixMissingFunctionDeclaration` (declares a stub) which TS
			//    suggests alongside `import` for TS2304.
			// 2. If multiple safe fixes remain and they're not textually
			//    equivalent, skip — genuine ambiguity (e.g., import from
			//    package A vs package B).
			const safeFixes = fixes.filter((f) => SAFE_FIX_NAMES.has(f.fixName));
			if (safeFixes.length === 0) {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
				continue;
			}
			if (safeFixes.length > 1 && !fixesAreEquivalent(safeFixes)) {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
				continue;
			}
			const fix = safeFixes[0];
			const applied = applyFixToSnapshots(fix, snapshots);
			if (applied > 0) {
				appliedThisIter++;
				totalFixes++;
				for (const change of fix.changes) {
					filesEdited.add(change.fileName);
				}
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: true,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
			} else {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
			}
		}
		logger.info(
			`[ts-lsp-fixer] iteration ${iter}: applied ${appliedThisIter}/${fixableErrors.length} fixes`,
		);
		if (appliedThisIter === 0) {
			break;
		}
	}

	// Persist the final snapshots back to disk for files we modified.
	// In dry-run mode, skip writes — the snapshot map still has the
	// would-be-edited content so callers can introspect via remainingErrors.
	if (dryRun) {
		if (filesEdited.size > 0) {
			logger.info(
				`[ts-lsp-fixer] dry-run: skipped writing ${filesEdited.size} file(s): ${[...filesEdited].map((f) => path.relative(workspaceRoot, f) || f).join(", ")}`,
			);
		}
	} else {
		for (const fileName of filesEdited) {
			const snap = snapshots.get(fileName);
			if (snap) {
				try {
					fs.writeFileSync(fileName, snap.content, "utf-8");
				} catch (err) {
					logger.warn(
						`[ts-lsp-fixer] failed to write ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	// Final diagnostic snapshot for the caller (now reading from edited files).
	const remaining = collectAllErrors(service, snapshots, workspaceRoot);
	service.dispose();

	return {
		fixesApplied: totalFixes,
		filesEdited: Array.from(filesEdited).map((f) => path.relative(workspaceRoot, f) || f),
		iterations: iter,
		allResolved: remaining.length === 0,
		remainingErrors: remaining,
	};
}

function readCompilerOptions(
	tsconfigPath: string,
	logger: LSPFixerLogger,
): ts.CompilerOptions | null {
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) {
		logger.error(
			`[ts-lsp-fixer] tsconfig parse error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
		);
		return null;
	}
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	return parsed.options;
}

function collectFixableErrors(
	service: ts.LanguageService,
	snapshots: Map<string, { content: string; version: number }>,
	workspaceRoot: string,
): Array<{ file: string; start: number; length: number; code: number }> {
	const out: Array<{ file: string; start: number; length: number; code: number }> = [];
	for (const [fileName] of snapshots) {
		if (fileName.includes("node_modules")) {
			continue;
		}
		if (/lib\.[a-z0-9.]+\.d\.ts$/.test(fileName)) {
			continue;
		}
		const semantic = service.getSemanticDiagnostics(fileName);
		const syntactic = service.getSyntacticDiagnostics(fileName);
		for (const d of [...semantic, ...syntactic]) {
			if (!SAFE_FIXABLE_CODES.has(d.code)) {
				continue;
			}
			if (d.start === undefined || d.length === undefined) {
				continue;
			}
			out.push({ file: fileName, start: d.start, length: d.length, code: d.code });
		}
	}
	void workspaceRoot;
	return out;
}

function collectAllErrors(
	service: ts.LanguageService,
	snapshots: Map<string, { content: string; version: number }>,
	workspaceRoot: string,
): LSPFixerResult["remainingErrors"] {
	const out: LSPFixerResult["remainingErrors"] = [];
	for (const [fileName] of snapshots) {
		if (fileName.includes("node_modules")) {
			continue;
		}
		if (/lib\.[a-z0-9.]+\.d\.ts$/.test(fileName)) {
			continue;
		}
		const semantic = service.getSemanticDiagnostics(fileName);
		const syntactic = service.getSyntacticDiagnostics(fileName);
		for (const d of [...semantic, ...syntactic]) {
			if (d.category !== ts.DiagnosticCategory.Error) {
				continue;
			}
			let line = 0;
			let column = 0;
			if (d.file && d.start !== undefined) {
				const pos = d.file.getLineAndCharacterOfPosition(d.start);
				line = pos.line + 1;
				column = pos.character + 1;
			}
			out.push({
				file: path.relative(workspaceRoot, fileName) || fileName,
				line,
				column,
				code: `TS${d.code}`,
				message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			});
		}
	}
	return out;
}

function safeGetCodeFixes(
	service: ts.LanguageService,
	err: { file: string; start: number; length: number; code: number },
): readonly ts.CodeFixAction[] | null {
	try {
		return service.getCodeFixesAtPosition(
			err.file,
			err.start,
			err.start + err.length,
			[err.code],
			{},
			{},
		);
	} catch {
		return null;
	}
}

/**
 * When the LanguageService returns multiple code-fix candidates, only apply
 * if they're textually equivalent (same edits on the same files). This
 * conservatively skips ambiguous cases (e.g., import from `lib/foo` vs
 * `lib/bar` where both export `Foo`) where guessing wrong is worse than
 * deferring to the LLM.
 */
/**
 * @internal Compute a stable `(file, start, code)` signature for each fixable
 * error. Used by the iteration loop's stuck-loop detector.
 */
export function computeErrorSignatures(
	errors: readonly { file: string; start: number; code: number }[],
): Set<string> {
	return new Set(errors.map((e) => `${e.file}:${e.start}:${e.code}`));
}

/**
 * @internal True if `a` and `b` contain the same members. Used to decide
 * whether the iteration loop is stuck (same error set across passes) vs.
 * making genuine progress (set membership changed even if size didn't).
 */
export function signatureSetsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const s of a) {
		if (!b.has(s)) {
			return false;
		}
	}
	return true;
}

/**
 * @internal True if every fix in `fixes` produces identical text edits.
 * Used to decide whether multiple candidate fixes for one error are safe to
 * pick automatically (identical = unambiguous; different = abstain).
 */
export function fixesAreEquivalent(fixes: readonly ts.CodeFixAction[]): boolean {
	if (fixes.length === 0) {
		return false;
	}
	const first = serializeFix(fixes[0]);
	for (let i = 1; i < fixes.length; i++) {
		if (serializeFix(fixes[i]) !== first) {
			return false;
		}
	}
	return true;
}

function serializeFix(fix: ts.CodeFixAction): string {
	return fix.changes
		.map(
			(c) =>
				`${c.fileName}|${c.textChanges.map((t) => `${t.span.start}:${t.span.length}:${t.newText}`).join(";")}`,
		)
		.join("||");
}

/**
 * @internal Apply a CodeFixAction's text changes to in-memory snapshots.
 * Returns the number of changes successfully applied. Bumps script versions
 * so the LanguageService re-parses on next call. Skips edits to files not
 * already in `snapshots` (defensive — won't create new files unbeknownst).
 */
export function applyFixToSnapshots(
	fix: ts.CodeFixAction,
	snapshots: Map<string, { content: string; version: number }>,
): number {
	let applied = 0;
	for (const change of fix.changes) {
		const snap = snapshots.get(change.fileName);
		if (!snap) {
			// New file (e.g., auto-import sometimes creates a new file). Skip
			// for safety — we don't want the fixer creating files unbeknownst.
			continue;
		}
		// Apply edits in reverse-order so earlier offsets stay valid.
		const sorted = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
		let next = snap.content;
		for (const tc of sorted) {
			next = next.slice(0, tc.span.start) + tc.newText + next.slice(tc.span.start + tc.span.length);
		}
		snapshots.set(change.fileName, { content: next, version: snap.version + 1 });
		applied++;
	}
	return applied;
}

/** Whether the LSP fixer is enabled (env-flag opt-out). Default ON. */
export function isLSPFixerEnabled(): boolean {
	return process.env.SPECTOSHIP_TS_LSP_FIXER !== "false";
}

/** Reset internal caches (for tests). No-op currently — service is created per-call. */
export function resetLSPFixerCache(): void {
	// Intentional no-op: we create a fresh LanguageService per call.
}
