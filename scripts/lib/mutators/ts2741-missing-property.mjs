import { Node, SyntaxKind } from "ts-morph";

export const code = "TS2741";
export const name = "ts2741-missing-property";

/**
 * Find an object literal whose contextual type has 2+ required properties.
 * Delete one of the literal's property assignments that maps to a required
 * field. Result: TS2741.
 *
 * Mutation strategy: text splice from the property's start through the
 * trailing comma (or up to the closing `}` if it's the last property).
 * Bypasses ts-morph's `remove()` API which doesn't reliably propagate to
 * `getFullText()` under in-memory FS.
 */
export async function mutate(sf, opts) {
	const literals = sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
	const candidates = [];
	for (const lit of literals) {
		const ctxType = lit.getContextualType();
		if (!ctxType) continue;
		const requiredProps = ctxType.getProperties().filter((p) => !p.isOptional());
		if (requiredProps.length < 2) continue;

		const litProps = lit.getProperties().filter((p) => Node.isPropertyAssignment(p));
		if (litProps.length === 0) continue;

		const litPropNames = new Set(litProps.map((p) => p.getName()));
		const allRequiredProvided = requiredProps.every((p) => litPropNames.has(p.getName()));
		if (!allRequiredProvided) continue;

		const deletable = litProps.filter((p) =>
			requiredProps.some((rp) => rp.getName() === p.getName()),
		);
		if (deletable.length === 0) continue;

		candidates.push({ literal: lit, deletable });
	}
	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const propToDelete = target.deletable[Math.floor(opts.rng() * target.deletable.length)];
	const propName = propToDelete.getName();

	const fullText = sf.getFullText();
	const start = propToDelete.getStart();
	let end = propToDelete.getEnd();
	// Include the trailing comma (and any whitespace up to the next non-WS
	// character) so we don't leave `, ,` or a hanging comma at end-of-list.
	while (end < fullText.length && /[\s,]/.test(fullText[end])) {
		if (fullText[end] === ",") {
			end++;
			break;
		}
		end++;
	}
	// If the property had a leading comma and is now last, also strip the
	// preceding comma.
	let trimStart = start;
	if (end >= fullText.length || fullText.slice(end).trimStart().startsWith("}")) {
		let i = start - 1;
		while (i > 0 && /\s/.test(fullText[i])) i--;
		if (fullText[i] === ",") trimStart = i;
	}
	const mutatedText = fullText.slice(0, trimStart) + fullText.slice(end);

	return {
		code: "TS2741",
		mutatedText,
		description: `Removed required property '${propName}' from object literal. Should report TS2741 (missing property).`,
	};
}
