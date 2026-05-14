/**
 * TypeScript Language Service context injection.
 *
 * The architectural moat for the Layer 2 mend agent. When a tsc diagnostic
 * says "Property 'foo' doesn't exist on type 'Bar'", this resolves the `Bar`
 * declaration to its exact source location and slices ±N lines around it.
 *
 * Every other LLM-driven repair tool (Aider, Cline, Cursor, OpenHands,
 * bolt.diy) uses generic grep or repo-maps to assemble context. Calling the
 * actual TypeChecker is what closes the gap between 30% and 70% on semantic
 * TS errors (per SWE-bench TS/JS data).
 *
 * Mirrors the lib-path workaround pattern from `validatorInProcess.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { Diagnostic } from "./index.js";

export interface TypeContextOptions {
	/** Absolute path to the workspace (must contain tsconfig.json). */
	workspaceRoot: string;
	/** A diagnostic from `runInProcessTsc` (or any compatible source). */
	diagnostic: Diagnostic;
	/** Lines of context around the error site. Default 3. */
	errorPadding?: number;
	/** Lines of context around the resolved type declaration. Default 20. */
	declarationPadding?: number;
}

export interface TypeContext {
	/** Numbered lines around the error site. Always present. */
	errorSite: {
		file: string;
		lines: string;
	};
	/** Numbered lines around the resolved type declaration. Present when the
	 *  error node (or one of its first 4 ancestors) has a non-lib symbol with
	 *  at least one declaration. */
	typeDeclaration?: {
		file: string;
		lines: string;
		symbol: string;
	};
}

interface CachedProgram {
	program: ts.Program;
	configMtime: number;
}
const programCache = new Map<string, CachedProgram>();

/** Reset the per-workspace Program cache. Tests should call this in `beforeEach`. */
export function resetTypeContextCache(): void {
	programCache.clear();
}

function buildProgram(workspaceRoot: string): ts.Program | null {
	const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) return null;

	let configMtime = 0;
	try {
		configMtime = fs.statSync(tsconfigPath).mtimeMs;
	} catch {
		return null;
	}

	const cached = programCache.get(workspaceRoot);
	if (cached && cached.configMtime === configMtime) return cached.program;

	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) return null;

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);

	const host = ts.createCompilerHost(parsed.options);
	// Lib-path workaround — same as validatorInProcess.ts.
	// Under esbuild bundling, the bundled `typescript` module's __dirname-based
	// lib lookup resolves to a path that doesn't ship inside the bundle.
	// Redirect to the workspace's `node_modules/typescript/lib`.
	const workspaceLibDir = path.join(workspaceRoot, "node_modules", "typescript", "lib");
	if (fs.existsSync(workspaceLibDir)) {
		const origGetDefaultLibFileName = host.getDefaultLibFileName.bind(host);
		host.getDefaultLibLocation = () => workspaceLibDir;
		host.getDefaultLibFileName = (options) => {
			const fileName = path.basename(origGetDefaultLibFileName(options));
			return path.join(workspaceLibDir, fileName);
		};
	}

	let program: ts.Program;
	try {
		program = ts.createProgram({
			rootNames: parsed.fileNames,
			options: parsed.options,
			host,
		});
	} catch {
		return null;
	}

	programCache.set(workspaceRoot, { program, configMtime });
	return program;
}

function sliceLines(content: string, oneIndexedLine: number, padding: number): string {
	const allLines = content.split("\n");
	const start = Math.max(0, oneIndexedLine - 1 - padding);
	const end = Math.min(allLines.length, oneIndexedLine + padding);
	const width = String(end).length;
	return allLines
		.slice(start, end)
		.map((l, i) => `${String(start + i + 1).padStart(width, " ")} | ${l}`)
		.join("\n");
}

/** Deepest descendant whose span contains `position`. */
function getNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node {
	let result: ts.Node = sourceFile;
	function walk(node: ts.Node): void {
		ts.forEachChild(node, (child) => {
			if (position >= child.getStart(sourceFile) && position < child.getEnd()) {
				result = child;
				walk(child);
				return true;
			}
			return false;
		});
	}
	walk(sourceFile);
	return result;
}

function isLibFile(fileName: string): boolean {
	return /lib\.[a-z0-9.]+\.d\.ts$/.test(fileName);
}

/**
 * Walk up from `startNode` looking for a node whose type has a non-lib
 * declaration. Bounded at 4 hops — far enough to catch
 * `propertyAccess.parent.parent` patterns, narrow enough to avoid bubbling
 * up to the whole module's declaration.
 *
 * Special case: for a `TS2339 property doesn't exist on type T` error, the
 * error position is at the property name (which has no symbol). The type T
 * lives on the LEFT operand of the property access, which is a sibling
 * node, not an ancestor. So when we encounter a PropertyAccessExpression
 * (or its element-access cousin) on the way up, we also probe `.expression`.
 */
function findTypeDeclaration(
	checker: ts.TypeChecker,
	startNode: ts.Node,
	maxWalkUp = 4,
): { decl: ts.Declaration; symbolName: string } | undefined {
	const tryResolve = (n: ts.Node) => {
		const type = checker.getTypeAtLocation(n);
		const symbol = type.getSymbol() ?? type.aliasSymbol;
		const declarations = symbol?.getDeclarations();
		if (!declarations || declarations.length === 0) return undefined;
		const nonLib = declarations.find((d) => !isLibFile(d.getSourceFile().fileName));
		if (!nonLib) return undefined;
		return { decl: nonLib, symbolName: symbol?.getName() ?? "(unnamed)" };
	};

	let node: ts.Node | undefined = startNode;
	for (let i = 0; i < maxWalkUp && node; i++) {
		const direct = tryResolve(node);
		if (direct) return direct;

		// TS2339 escape: property name has no symbol; the interesting type is
		// on the object being accessed.
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const sibling = tryResolve(node.expression);
			if (sibling) return sibling;
		}

		node = node.parent;
	}
	return undefined;
}

/**
 * Resolve a tsc diagnostic to its surrounding code context — error site
 * always, plus the declaring type when one can be resolved through the
 * TypeChecker.
 */
export function getTypeContext(opts: TypeContextOptions): TypeContext {
	const { workspaceRoot, diagnostic } = opts;
	const errorPadding = opts.errorPadding ?? 3;
	const declarationPadding = opts.declarationPadding ?? 20;

	const filePath = path.isAbsolute(diagnostic.file)
		? diagnostic.file
		: path.join(workspaceRoot, diagnostic.file);

	const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
	const errorSite = {
		file: diagnostic.file,
		lines: sliceLines(fileContent, diagnostic.line, errorPadding),
	};

	const program = buildProgram(workspaceRoot);
	if (!program) return { errorSite };

	const sourceFile = program.getSourceFile(filePath);
	if (!sourceFile) return { errorSite };

	let position: number;
	try {
		position = ts.getPositionOfLineAndCharacter(
			sourceFile,
			diagnostic.line - 1,
			diagnostic.column - 1,
		);
	} catch {
		return { errorSite };
	}

	const errorNode = getNodeAtPosition(sourceFile, position);
	const checker = program.getTypeChecker();
	const found = findTypeDeclaration(checker, errorNode);
	if (!found) return { errorSite };

	const declSourceFile = found.decl.getSourceFile();
	const declStart = found.decl.getStart(declSourceFile);
	const { line: declLine0 } = ts.getLineAndCharacterOfPosition(declSourceFile, declStart);
	return {
		errorSite,
		typeDeclaration: {
			file: path.relative(workspaceRoot, declSourceFile.fileName) || declSourceFile.fileName,
			lines: sliceLines(declSourceFile.text, declLine0 + 1, declarationPadding),
			symbol: found.symbolName,
		},
	};
}
