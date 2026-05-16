import { Node, SyntaxKind } from "ts-morph";

export const code = "TS2322";
export const name = "ts2322-incompatible-return";

/**
 * Find a return statement whose containing function declares a primitive
 * return type (`string` / `number` / `boolean`). Replace the returned
 * expression with a literal of a different primitive type → TS2322.
 *
 * Layer 0 abstains: there's no LSP code-fix for type mismatches (would
 * require rewriting either the return type annotation or the value, neither
 * of which is in the safe-fix allowlist).
 *
 * Mutation strategy: text splice. Replace `expr` with one of:
 *   string → 42 (number)
 *   number → "x" (string)
 *   boolean → "x" (string)
 */
export async function mutate(sf, opts) {
	const returns = sf.getDescendantsOfKind(SyntaxKind.ReturnStatement);
	const candidates = [];
	for (const r of returns) {
		const expr = r.getExpression();
		if (!expr) continue;

		// Walk up to the containing function/method to read its declared
		// return type.
		let fnNode = r.getParent();
		while (
			fnNode &&
			!Node.isFunctionDeclaration(fnNode) &&
			!Node.isMethodDeclaration(fnNode) &&
			!Node.isArrowFunction(fnNode) &&
			!Node.isFunctionExpression(fnNode)
		) {
			fnNode = fnNode.getParent();
		}
		if (!fnNode) continue;
		const rtn = fnNode.getReturnTypeNode?.();
		if (!rtn) continue;
		const declared = rtn.getText();
		// Restrict to primitive return types so we can pick a safe wrong literal.
		if (!["string", "number", "boolean"].includes(declared)) continue;
		candidates.push({ ret: r, expr, declared });
	}
	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const wrongLiteral =
		target.declared === "string"
			? "42"
			: target.declared === "number"
				? `"x_${opts.index}"`
				: `"x_${opts.index}"`; // boolean → string

	const fullText = sf.getFullText();
	const start = target.expr.getStart();
	const end = target.expr.getEnd();
	const oldText = fullText.slice(start, end);
	const mutatedText = fullText.slice(0, start) + wrongLiteral + fullText.slice(end);

	return {
		code: "TS2322",
		mutatedText,
		description: `Replaced return value '${oldText.slice(0, 30)}' with ${wrongLiteral} in a function declared to return ${target.declared}. Should report TS2322.`,
	};
}
