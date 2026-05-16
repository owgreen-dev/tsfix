import { SyntaxKind } from "ts-morph";

export const code = "TS2554";
export const name = "ts2554-arg-count-mismatch";

/**
 * Find a CallExpression whose target function declares N required parameters.
 * Remove one of the call's arguments → TS2554 ("Expected N arguments, but
 * got M"). Layer 0 abstains: there's no LSP code-fix for argument-count
 * mismatches outside of "addMissingFunctionDeclaration" (which would create
 * a new function declaration — not in the safe allowlist).
 *
 * Mutation strategy: text splice. Remove the chosen argument plus the comma
 * separator to either side (whichever exists) so the resulting argument list
 * is syntactically valid.
 *
 * Requires the call to currently match its signature (otherwise the file is
 * already broken). We drop the LAST argument — function ends up missing one.
 */
export async function mutate(sf, opts) {
	const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
	const candidates = [];

	for (const call of calls) {
		const args = call.getArguments();
		if (args.length < 1) continue; // need ≥1 arg to drop

		const checker = call.getProject().getTypeChecker();
		const sig = checker.getResolvedSignature?.(call);
		if (!sig) continue;

		const params = sig.getParameters();
		// Count required (non-optional) parameters.
		const requiredCount = params.filter((p) => {
			const decl = p.getDeclarations()[0];
			if (!decl) return false;
			// `?` optional marker
			if (typeof decl.hasQuestionToken === "function" && decl.hasQuestionToken()) return false;
			// `= default` initializer
			if (typeof decl.getInitializer === "function" && decl.getInitializer()) return false;
			// rest param
			if (typeof decl.isRestParameter === "function" && decl.isRestParameter()) return false;
			return true;
		}).length;

		if (requiredCount < 1) continue; // function must require ≥1 arg
		// The call must currently match the signature exactly — otherwise the
		// file is already broken or there are optional params we'd need to
		// reason about.
		if (args.length !== requiredCount) continue;

		candidates.push({ call, args });
	}

	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	// Drop the LAST argument — easier to handle the comma cleanup.
	const dropIdx = target.args.length - 1;
	const dropped = target.args[dropIdx];

	const fullText = sf.getFullText();
	let start = dropped.getStart();
	const end = dropped.getEnd();

	// Walk back over whitespace + the preceding comma so we don't leave a
	// trailing `,)` in the call.
	let i = start - 1;
	while (i >= 0 && /\s/.test(fullText[i])) i--;
	if (i >= 0 && fullText[i] === ",") {
		start = i;
	}

	const oldText = fullText.slice(dropped.getStart(), end);
	const mutatedText = fullText.slice(0, start) + fullText.slice(end);

	return {
		code: "TS2554",
		mutatedText,
		description: `Dropped trailing argument '${oldText.slice(0, 30)}' from call. Function expects ${target.args.length}, call now passes ${target.args.length - 1}. Should report TS2554.`,
	};
}
