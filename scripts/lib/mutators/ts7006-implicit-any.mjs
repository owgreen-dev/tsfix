import { SyntaxKind } from "ts-morph";

export const code = "TS7006";
export const name = "ts7006-implicit-any";

/**
 * Find a function parameter with an explicit type annotation. Strip the
 * `: TypeName` portion from the source text. Under `strict: true` (which
 * all generated fixtures use), the parameter implicitly becomes `any`,
 * surfacing TS7006.
 *
 * Mutation strategy: text splice from the colon (or `?` token) to the
 * end of the type node. Bypasses ts-morph's `removeType()` API which
 * doesn't reliably propagate to `getFullText()` under in-memory FS.
 */
export async function mutate(sf, opts) {
	const params = sf.getDescendantsOfKind(SyntaxKind.Parameter);
	const candidates = params.filter((p) => {
		if (!p.getTypeNode()) return false;
		const nameNode = p.getNameNode();
		return nameNode.getKind() === SyntaxKind.Identifier;
	});
	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const paramName = target.getName();
	const typeNode = target.getTypeNode();
	const oldType = typeNode.getText();

	// Find the `:` between the name and the type by scanning backward from
	// the type node's start. The colon is whitespace-tolerant.
	const fullText = sf.getFullText();
	const typeStart = typeNode.getStart();
	const typeEnd = typeNode.getEnd();
	let colonIdx = typeStart - 1;
	while (colonIdx > 0 && fullText[colonIdx] !== ":") colonIdx--;
	if (fullText[colonIdx] !== ":") return null; // shouldn't happen but be safe

	const mutatedText = fullText.slice(0, colonIdx) + fullText.slice(typeEnd);

	return {
		code: "TS7006",
		mutatedText,
		description: `Stripped type annotation from parameter '${paramName}: ${oldType}'. Should now report TS7006 implicit any.`,
	};
}
