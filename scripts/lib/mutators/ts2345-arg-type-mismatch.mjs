import { SyntaxKind } from "ts-morph";

export const code = "TS2345";
export const name = "ts2345-arg-type-mismatch";

/**
 * Find a CallExpression where the called function declares typed parameters.
 * Pick one argument, replace it with a literal of an incompatible primitive
 * type → TS2345 ("Argument of type 'X' is not assignable to parameter of
 * type 'Y'").
 *
 * Layer 0 abstains: no LSP code-fix exists for argument-type mismatches
 * (would require rewriting the value or the parameter type — neither is in
 * the safe-fix allowlist).
 *
 * Strategy: scan the call's arguments; find one whose contextual type is a
 * primitive (`string` / `number` / `boolean`); replace with a literal of a
 * different primitive.
 */
export async function mutate(sf, opts) {
	const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
	const candidates = [];

	for (const call of calls) {
		const args = call.getArguments();
		if (args.length === 0) continue;

		// Examine each argument; pick those whose CONTEXTUAL type (i.e. the
		// parameter type the function expects) is a primitive we can flip.
		const sig = call.getReturnType().getCallSignatures(); // unused; see below
		void sig; // appease lint

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			// Read the parameter type via the call's resolved signature.
			const checker = call.getProject().getTypeChecker();
			const resolvedSig = checker.getResolvedSignature?.(call);
			if (!resolvedSig) continue;
			const params = resolvedSig.getParameters();
			if (i >= params.length) continue;

			const paramDecl = params[i].getDeclarations()[0];
			if (!paramDecl) continue;
			const paramType = checker.getTypeOfSymbolAtLocation?.(params[i], paramDecl);
			if (!paramType) continue;

			const paramTypeText = paramType.getText();
			if (!["string", "number", "boolean"].includes(paramTypeText)) continue;

			// Also skip when the argument is already a literal of the right
			// type AND would naturally pass — we only want sites where we can
			// inject a wrong literal.
			candidates.push({ call, argIndex: i, paramType: paramTypeText, arg });
		}
	}

	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const wrongLiteral =
		target.paramType === "string"
			? `42`
			: target.paramType === "number"
				? `"x_${opts.index}"`
				: `"x_${opts.index}"`; // boolean → string

	const fullText = sf.getFullText();
	const start = target.arg.getStart();
	const end = target.arg.getEnd();
	const oldText = fullText.slice(start, end);
	const mutatedText = fullText.slice(0, start) + wrongLiteral + fullText.slice(end);

	return {
		code: "TS2345",
		mutatedText,
		description: `Replaced argument '${oldText.slice(0, 30)}' with ${wrongLiteral} (parameter expects ${target.paramType}). Should report TS2345.`,
	};
}
