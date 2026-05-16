import { SyntaxKind } from "ts-morph";

export const code = "TS2365";
export const name = "ts2365-operator-mismatch";

/**
 * Find a BinaryExpression using a numeric operator (`<`, `>`, `<=`, `>=`, `-`,
 * `*`, `/`, `%`) where one side is currently typed `number`. Replace that
 * side with a string literal → TS2365 ("Operator '<' cannot be applied to
 * types 'string' and 'number'").
 *
 * NOTE: `+` is excluded because TS allows `string + number` via implicit
 * coercion (no error). NOTE: `==` and `===` accept any operand combination
 * (the error is TS2367, not TS2365), so equality operators are also out.
 *
 * Layer 0 abstains: no LSP code-fix for operator-type mismatches outside of
 * "convertToStringConcatenation" which doesn't apply here.
 */
const NUMERIC_OPS = new Set([
	SyntaxKind.LessThanToken,
	SyntaxKind.GreaterThanToken,
	SyntaxKind.LessThanEqualsToken,
	SyntaxKind.GreaterThanEqualsToken,
	SyntaxKind.MinusToken,
	SyntaxKind.AsteriskToken,
	SyntaxKind.SlashToken,
	SyntaxKind.PercentToken,
]);

export async function mutate(sf, opts) {
	const bins = sf.getDescendantsOfKind(SyntaxKind.BinaryExpression);
	const candidates = [];

	for (const bin of bins) {
		const opTok = bin.getOperatorToken();
		if (!NUMERIC_OPS.has(opTok.getKind())) continue;

		const left = bin.getLeft();
		const right = bin.getRight();
		const lType = left.getType().getText();
		const rType = right.getType().getText();

		// Both sides must currently be number (otherwise the original code
		// would already be broken, or the operator isn't numeric in this
		// context).
		if (lType !== "number" || rType !== "number") continue;

		candidates.push({ bin, left, right });
	}

	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	// Coin-flip which side to corrupt — keeps the fixture set non-uniform.
	const corruptLeft = opts.rng() < 0.5;
	const victim = corruptLeft ? target.left : target.right;

	const fullText = sf.getFullText();
	const start = victim.getStart();
	const end = victim.getEnd();
	const oldText = fullText.slice(start, end);
	const wrongLiteral = `"oops_${opts.index}"`;
	const mutatedText = fullText.slice(0, start) + wrongLiteral + fullText.slice(end);

	return {
		code: "TS2365",
		mutatedText,
		description: `Replaced ${corruptLeft ? "left" : "right"} operand '${oldText.slice(0, 30)}' of a numeric binary expression with ${wrongLiteral}. Should report TS2365.`,
	};
}
