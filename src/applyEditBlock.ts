/**
 * SEARCH/REPLACE block parser + fuzzy applier (Aider's `editblock` format).
 *
 * The format an LLM emits when asked to repair a file:
 *
 *     path/to/file.ts
 *     <<<<<<< SEARCH
 *     // exact text to find
 *     =======
 *     // replacement text
 *     >>>>>>> REPLACE
 *
 * Fenced code blocks (```ts ... ```) around the markers are tolerated.
 * Multiple blocks per file and multiple files per LLM output are allowed.
 *
 * Match algorithm (3 tiers, abstain on ambiguity):
 *   1. Exact substring match.
 *   2. Right-strip per line (trailing-whitespace tolerance), retry.
 *   3. Full strip per line (leading + trailing), retry.
 *
 * If a tier finds multiple matches, we surface "ambiguous: N matches" rather
 * than guess. Better to drop the patch and let the LLM emit a more specific
 * SEARCH block on the next iteration than to silently corrupt the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface EditBlock {
	file: string;
	search: string;
	replace: string;
}

export interface ApplyEditBlocksOptions {
	workspaceRoot: string;
	blocks: EditBlock[];
	/** Compute new content, return successes/failures, but skip writing to disk. */
	dryRun?: boolean;
}

export interface ApplyResult {
	blocks: EditBlock[];
	applied: number;
	filesEdited: string[];
	failures: Array<{ block: EditBlock; reason: string }>;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const SEPARATOR = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

/**
 * Extract a clean file path from the line preceding a SEARCH marker.
 * Handles three observed shapes from real LLM output:
 *   - bare path: `src/api.ts`
 *   - quoted path: `"src/api.ts"` or `` `src/api.ts` ``
 *   - XML-style attribute: `<file path="src/api.ts">` (claude likes this when
 *     the system prompt itself uses XML markers)
 */
function extractFilePath(line: string): string {
	const trimmed = line.trim();
	const attrMatch = trimmed.match(/<\s*file\s+path\s*=\s*["']([^"']+)["']\s*\/?>/i);
	if (attrMatch) return attrMatch[1];
	return trimmed.replace(/^[`'"]+|[`'"]+$/g, "");
}

/**
 * Extract every well-formed SEARCH/REPLACE block from raw LLM output.
 * Malformed / truncated blocks at the tail are skipped silently.
 */
export function parseEditBlocks(llmOutput: string): EditBlock[] {
	const blocks: EditBlock[] = [];
	const lines = llmOutput.split("\n");

	let i = 0;
	while (i < lines.length) {
		while (i < lines.length && lines[i].trim() !== SEARCH_MARKER) {
			i++;
		}
		if (i >= lines.length) {
			break;
		}

		// File path: walk back from SEARCH marker, skipping fence lines, blank
		// lines, and closing XML tags (left over from a prior block's wrapper).
		let fileIdx = i - 1;
		while (fileIdx >= 0) {
			const trimmed = lines[fileIdx].trim();
			if (
				trimmed === "" ||
				trimmed.startsWith("```") ||
				trimmed.startsWith("</")
			) {
				fileIdx--;
				continue;
			}
			break;
		}
		const filePath = fileIdx >= 0 ? extractFilePath(lines[fileIdx]) : "";

		i++; // past SEARCH marker
		const searchLines: string[] = [];
		while (i < lines.length && lines[i].trim() !== SEPARATOR) {
			searchLines.push(lines[i]);
			i++;
		}
		if (i >= lines.length) {
			break;
		}

		i++; // past separator
		const replaceLines: string[] = [];
		while (i < lines.length && lines[i].trim() !== REPLACE_MARKER) {
			replaceLines.push(lines[i]);
			i++;
		}
		if (i >= lines.length) {
			break;
		}

		blocks.push({
			file: filePath,
			search: searchLines.join("\n"),
			replace: replaceLines.join("\n"),
		});
		i++; // past REPLACE marker
	}

	return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = haystack.indexOf(needle, pos);
		if (idx < 0) return count;
		count++;
		pos = idx + needle.length;
	}
}

function rstripPerLine(text: string): string {
	return text.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
}

function stripPerLine(text: string): string {
	return text.split("\n").map((l) => l.trim()).join("\n");
}

/**
 * Replace the matched region in the original (un-normalized) content. We
 * find which line range the normalized search occupied and splice on that
 * line range — preserves the original's surrounding whitespace, replaces
 * only the matched lines.
 */
function spliceLines(
	originalContent: string,
	normalizedContent: string,
	normalizedSearch: string,
	replace: string,
): string | undefined {
	const idx = normalizedContent.indexOf(normalizedSearch);
	if (idx < 0) return undefined;
	const linesBefore = normalizedContent.slice(0, idx).split("\n").length - 1;
	const matchLineCount = normalizedSearch.split("\n").length;
	const origLines = originalContent.split("\n");
	const before = origLines.slice(0, linesBefore);
	const after = origLines.slice(linesBefore + matchLineCount);
	return [...before, replace, ...after].join("\n");
}

export type SingleBlockResult =
	| { newContent: string; matchedTier: "exact" | "rstrip" | "strip" }
	| { error: string };

/**
 * Apply one search/replace to a single file's content. Pure — doesn't
 * touch disk.
 */
export function applySingleBlock(
	fileContent: string,
	search: string,
	replace: string,
): SingleBlockResult {
	if (search === "") {
		return { error: "empty search block" };
	}

	const exactCount = countOccurrences(fileContent, search);
	if (exactCount === 1) {
		return { newContent: fileContent.replace(search, replace), matchedTier: "exact" };
	}
	if (exactCount > 1) {
		return { error: `ambiguous: ${exactCount} exact matches` };
	}

	const rstripContent = rstripPerLine(fileContent);
	const rstripSearch = rstripPerLine(search);
	const rstripCount = countOccurrences(rstripContent, rstripSearch);
	if (rstripCount === 1) {
		const out = spliceLines(fileContent, rstripContent, rstripSearch, replace);
		if (out !== undefined) {
			return { newContent: out, matchedTier: "rstrip" };
		}
	}
	if (rstripCount > 1) {
		return { error: `ambiguous: ${rstripCount} rstrip matches` };
	}

	const stripContent = stripPerLine(fileContent);
	const stripSearch = stripPerLine(search);
	const stripCount = countOccurrences(stripContent, stripSearch);
	if (stripCount === 1) {
		const out = spliceLines(fileContent, stripContent, stripSearch, replace);
		if (out !== undefined) {
			return { newContent: out, matchedTier: "strip" };
		}
	}
	if (stripCount > 1) {
		return { error: `ambiguous: ${stripCount} strip matches` };
	}

	return { error: "no match" };
}

/**
 * Top-level: apply a list of edit blocks. Stacks multiple blocks against
 * the same file in memory before writing, so block N+1 sees block N's edit.
 *
 * Failures are collected, not thrown — the mend loop wants to know what
 * succeeded so it can re-run tsc on the partial fix.
 */
export function applyEditBlocks(opts: ApplyEditBlocksOptions): ApplyResult {
	const { workspaceRoot, blocks, dryRun = false } = opts;
	const fileSnapshots = new Map<string, string>();
	const failures: ApplyResult["failures"] = [];
	const filesEdited = new Set<string>();
	let applied = 0;

	for (const block of blocks) {
		const filePath = path.isAbsolute(block.file)
			? block.file
			: path.join(workspaceRoot, block.file);

		let content = fileSnapshots.get(filePath);
		if (content === undefined) {
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch (err) {
				failures.push({
					block,
					reason: `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
				});
				continue;
			}
		}

		const result = applySingleBlock(content, block.search, block.replace);
		if ("error" in result) {
			failures.push({ block, reason: result.error });
			continue;
		}

		fileSnapshots.set(filePath, result.newContent);
		filesEdited.add(filePath);
		applied++;
	}

	if (!dryRun) {
		for (const [filePath, content] of fileSnapshots) {
			try {
				fs.writeFileSync(filePath, content);
			} catch (err) {
				failures.push({
					block: { file: filePath, search: "", replace: "" },
					reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
	}

	return {
		blocks,
		applied,
		filesEdited: Array.from(filesEdited),
		failures,
	};
}
