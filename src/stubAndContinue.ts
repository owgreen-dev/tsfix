/**
 * Layer 4 — stub-and-continue escape hatch.
 *
 * When Layer 0/1 abstains and Layer 2's `runMendLoop` returns with leftover
 * diagnostics (stopReason `noProgress`, `regressed`, or `maxIterations`),
 * Layer 4 inserts a `// @ts-expect-error` directive immediately above each
 * unresolved error site so `tsc --noEmit` exits 0. Caller's pipeline
 * unblocks; the developer reviews the directive at leisure.
 *
 * Why `@ts-expect-error` and not `@ts-ignore`:
 *   `@ts-expect-error` errors out if the next line has NO error — meaning
 *   stale directives self-destruct as soon as the underlying issue is
 *   fixed by other means. `@ts-ignore` is permissive and rots silently.
 *
 * Trust posture: Layer 4 is opt-in. The CLI default never reaches it.
 * `runMendLoop` only invokes it when `stubOnFailure: true` is set.
 *
 * Idempotency: re-running on a workspace that already has stubs above the
 * same error lines is a no-op. We detect the existing directive on the
 * line above and skip.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "./index.js";

export interface StubAndContinueOptions {
	/** Absolute path to the workspace (used for resolving / skipping node_modules). */
	workspaceRoot: string;
	/** Unresolved diagnostics (errors only — warnings/suggestions ignored). */
	diagnostics: Diagnostic[];
	/** Report what would be stubbed without writing. Default false. */
	dryRun?: boolean;
	logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
	/** Override the comment marker (default: "tsfix"). */
	stubMarker?: string;
	/** Cap on message length included in the comment. Default 120. */
	maxMessageLength?: number;
}

export interface AppliedStub {
	/** Absolute path of the file edited. */
	file: string;
	/**
	 * 1-based line number tsc originally reported the error on (pre-stub).
	 * In the file *after* stubbing, the error code lives at `errorLine + 1`
	 * and the `@ts-expect-error` comment lives at `errorLine`.
	 */
	errorLine: number;
	/** All TS codes on the error line, deduplicated and sorted. */
	codes: string[];
	/** The comment text actually written (without leading whitespace). */
	commentText: string;
}

export interface SkippedStub {
	file: string;
	line: number;
	codes: string[];
	reason: "node_modules" | "declaration_file" | "file_not_found" | "already_stubbed" | "file_too_short";
}

export interface StubAndContinueResult {
	stubsApplied: AppliedStub[];
	skipped: SkippedStub[];
	filesEdited: string[];
	diagnosticsBefore: number;
	/** Diagnostics still on disk after stubs were applied (excludes the stubbed sites). */
	diagnosticsAfter: number;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Group diagnostics by `(file, line)` so a single comment covers multiple
 * errors on the same line (e.g. TS2304 + TS2552 from one typo).
 */
function groupByLine(diagnostics: Diagnostic[]): Map<string, Diagnostic[]> {
	const groups = new Map<string, Diagnostic[]>();
	for (const d of diagnostics) {
		if (d.category !== "error") continue;
		const key = `${d.file}::${d.line}`;
		const list = groups.get(key);
		if (list) list.push(d);
		else groups.set(key, [d]);
	}
	return groups;
}

/**
 * Resolve `diagnosticFile` against `workspaceRoot` if relative. Diagnostics
 * from `runInProcessTsc` use paths relative to the workspace; consumers may
 * also pass absolute paths. We tolerate both.
 */
function resolveFile(diagnosticFile: string, workspaceRoot: string): string {
	return path.isAbsolute(diagnosticFile)
		? diagnosticFile
		: path.resolve(workspaceRoot, diagnosticFile);
}

function shouldSkipFile(file: string, workspaceRoot: string): SkippedStub["reason"] | null {
	const rel = path.relative(workspaceRoot, file);
	if (rel.startsWith("node_modules") || rel.includes(`${path.sep}node_modules${path.sep}`)) {
		return "node_modules";
	}
	if (file.endsWith(".d.ts")) {
		return "declaration_file";
	}
	if (!fs.existsSync(file)) {
		return "file_not_found";
	}
	return null;
}

/** Detects `// @ts-expect-error` or `// @ts-ignore` (with or without args). */
function lineIsTsSuppression(line: string): boolean {
	return /^\s*\/\/\s*@ts-(?:expect-error|ignore)\b/.test(line);
}

function leadingWhitespace(line: string): string {
	const match = line.match(/^(\s*)/);
	return match ? match[1] : "";
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

/**
 * Build the stub comment for a group of errors on the same line.
 * Format: `// @ts-expect-error - tsfix: TS2304, TS7006 — <combined messages>`
 */
function buildStubComment(group: Diagnostic[], marker: string, maxMessageLength: number): string {
	const codes = Array.from(new Set(group.map((d) => d.code))).sort();
	// Join unique messages with " | "; truncate to maxMessageLength
	const messages = Array.from(new Set(group.map((d) => d.message.replace(/\s+/g, " ").trim()))).join(" | ");
	const truncated = truncate(messages, maxMessageLength);
	return `// @ts-expect-error - ${marker}: ${codes.join(", ")} — ${truncated}`;
}

export function stubAndContinue(opts: StubAndContinueOptions): StubAndContinueResult {
	const {
		workspaceRoot,
		diagnostics,
		dryRun = false,
		logger = noopLogger,
		stubMarker = "tsfix",
		maxMessageLength = 120,
	} = opts;

	const errorOnly = diagnostics.filter((d) => d.category === "error");
	const grouped = groupByLine(errorOnly);

	const stubsApplied: AppliedStub[] = [];
	const skipped: SkippedStub[] = [];
	const filesEditedSet = new Set<string>();

	// Group keys (file::line) → group entries, sorted so we process each file
	// in descending line order (later edits don't shift earlier line numbers).
	// We key by the resolved absolute path so relative + absolute diagnostics
	// pointing at the same file collapse into one entry.
	const byFile = new Map<string, Array<{ line: number; group: Diagnostic[] }>>();
	for (const [key, group] of grouped) {
		const sepIdx = key.lastIndexOf("::");
		const rawFile = key.slice(0, sepIdx);
		const file = resolveFile(rawFile, workspaceRoot);
		const line = parseInt(key.slice(sepIdx + 2), 10);
		const list = byFile.get(file) ?? [];
		list.push({ line, group });
		byFile.set(file, list);
	}

	for (const [file, entries] of byFile) {
		const skipReason = shouldSkipFile(file, workspaceRoot);
		if (skipReason !== null) {
			for (const entry of entries) {
				skipped.push({
					file,
					line: entry.line,
					codes: Array.from(new Set(entry.group.map((d) => d.code))).sort(),
					reason: skipReason,
				});
			}
			continue;
		}

		const source = fs.readFileSync(file, "utf-8");
		// Detect line ending (preserve on write).
		const eol = source.includes("\r\n") ? "\r\n" : "\n";
		const lines = source.split(/\r?\n/);

		// Process in descending line order so inserts don't shift later lines.
		entries.sort((a, b) => b.line - a.line);

		let edited = false;
		for (const { line: errorLine, group } of entries) {
			// errorLine is 1-based; array is 0-based.
			const errorIdx = errorLine - 1;
			if (errorIdx < 0 || errorIdx >= lines.length) {
				skipped.push({
					file,
					line: errorLine,
					codes: Array.from(new Set(group.map((d) => d.code))).sort(),
					reason: "file_too_short",
				});
				continue;
			}

			// Idempotency: if the line above already suppresses, skip.
			const lineAbove = errorIdx > 0 ? lines[errorIdx - 1] : "";
			if (lineIsTsSuppression(lineAbove)) {
				skipped.push({
					file,
					line: errorLine,
					codes: Array.from(new Set(group.map((d) => d.code))).sort(),
					reason: "already_stubbed",
				});
				continue;
			}

			const indent = leadingWhitespace(lines[errorIdx]);
			const commentText = buildStubComment(group, stubMarker, maxMessageLength);
			const commentLineWithIndent = `${indent}${commentText}`;

			// Insert the comment above the error line.
			lines.splice(errorIdx, 0, commentLineWithIndent);
			edited = true;

			stubsApplied.push({
				file,
				errorLine, // original line as reported by tsc; in the file post-stub, the comment is here and the code is at errorLine+1
				codes: Array.from(new Set(group.map((d) => d.code))).sort(),
				commentText,
			});
		}

		if (edited) {
			filesEditedSet.add(file);
			if (!dryRun) {
				fs.writeFileSync(file, lines.join(eol), "utf-8");
				logger.info(`[stub-and-continue] stubbed ${entries.length} site(s) in ${path.relative(workspaceRoot, file)}`);
			} else {
				logger.info(`[stub-and-continue] (dry-run) would stub ${entries.length} site(s) in ${path.relative(workspaceRoot, file)}`);
			}
		}
	}

	return {
		stubsApplied,
		skipped,
		filesEdited: Array.from(filesEditedSet),
		diagnosticsBefore: errorOnly.length,
		// Each applied stub suppresses every diagnostic on its line. Compare
		// after resolving raw diagnostic paths to absolute, since stubsApplied
		// stores absolute paths but the input diagnostics may be relative.
		diagnosticsAfter: errorOnly.length - stubsApplied.reduce((acc, s) => {
			const onLine = errorOnly.filter(
				(d) => resolveFile(d.file, workspaceRoot) === s.file && d.line === s.errorLine,
			).length;
			return acc + onLine;
		}, 0),
	};
}
