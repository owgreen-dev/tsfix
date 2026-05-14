import { SyntaxKind } from "ts-morph";

export const code = "TS2339";
export const name = "ts2339-property-not-exist";

/**
 * Pick a random property access where the receiver type has user-defined
 * declarations. Rename the property to something with no near match —
 * keeps the resulting error a pure TS2339 (Layer 0 abstains because there's
 * no spelling fix candidate).
 *
 * Mutation strategy: text splice based on the name node's byte range.
 * ts-morph's `replaceWithText` on a name node inside `useInMemoryFileSystem`
 * doesn't reliably propagate to `getFullText()`, so we go around it.
 */
export async function mutate(sf, opts) {
	const accesses = sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
	const candidates = accesses.filter((p) => {
		const t = p.getExpression().getType();
		const sym = t.getSymbol();
		if (!sym) return false;
		const decls = sym.getDeclarations() ?? [];
		return decls.some((d) => !/lib\.[a-z0-9.]+\.d\.ts$/.test(d.getSourceFile().fileName));
	});
	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const nameNode = target.getNameNode();
	const oldName = nameNode.getText();
	const newName = `xqz_doesNotExist${opts.index}`;

	const fullText = sf.getFullText();
	const start = nameNode.getStart();
	const end = nameNode.getEnd();
	const mutatedText = fullText.slice(0, start) + newName + fullText.slice(end);

	return {
		code: "TS2339",
		mutatedText,
		description: `Renamed property access '${oldName}' → '${newName}' (no near match — pure TS2339, Layer 0 abstains).`,
	};
}
