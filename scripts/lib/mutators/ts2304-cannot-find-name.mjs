import { Node, SyntaxKind } from "ts-morph";

export const code = "TS2304";
export const name = "ts2304-cannot-find-name";

/**
 * Find an identifier in a reference position (not declaration) where renaming
 * to a no-near-match name produces a pure TS2304. Layer 0's auto-import only
 * fires when the LSP finds a candidate to import — by using a name with no
 * lexical similarity to anything in scope or any package, we guarantee
 * abstention.
 *
 * Mutation strategy: text splice on the identifier's start..end range.
 *
 * Why exclude property names: renaming a property access's `name` half is
 * already covered by the TS2339 mutator (`ts2339-property-not-exist`). We
 * target IDENTIFIER references — variables, parameters, function calls —
 * so the resulting error is "Cannot find name 'foo'", not "Property 'foo'
 * does not exist on type 'X'".
 */
export async function mutate(sf, opts) {
	const ids = sf.getDescendantsOfKind(SyntaxKind.Identifier);
	const candidates = ids.filter((id) => {
		// Skip declarations (function name, variable name, parameter name, etc.)
		const parent = id.getParent();
		if (!parent) return false;

		// Skip if this identifier IS the name slot of a declaration.
		if (
			(Node.isFunctionDeclaration(parent) && parent.getNameNode() === id) ||
			(Node.isParameterDeclaration(parent) && parent.getNameNode() === id) ||
			(Node.isVariableDeclaration(parent) && parent.getNameNode() === id) ||
			(Node.isPropertyAssignment(parent) && parent.getNameNode() === id) ||
			(Node.isPropertySignature(parent) && parent.getNameNode() === id) ||
			(Node.isMethodDeclaration(parent) && parent.getNameNode() === id) ||
			(Node.isTypeAliasDeclaration(parent) && parent.getNameNode() === id) ||
			(Node.isInterfaceDeclaration(parent) && parent.getNameNode() === id)
		) {
			return false;
		}

		// Skip property accesses' name half (TS2339 territory).
		if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
			return false;
		}

		// Skip the type position of a property/parameter (we want value
		// references). The result of renaming a type identifier is usually
		// TS2304 too but Layer 0 sometimes adds an import from a global
		// candidate — keep noise low by sticking to value positions.
		if (Node.isTypeReference(parent)) {
			return false;
		}

		// Skip identifiers that are part of a shorthand property assignment
		// (the binding name = the property name; mutating one would change
		// both halves and produce weirder errors).
		if (Node.isShorthandPropertyAssignment(parent)) {
			return false;
		}

		return true;
	});

	if (candidates.length === 0) return null;

	const target = candidates[Math.floor(opts.rng() * candidates.length)];
	const oldName = target.getText();
	const newName = `xqz_undefined_${opts.index}`;

	const fullText = sf.getFullText();
	const start = target.getStart();
	const end = target.getEnd();
	const mutatedText = fullText.slice(0, start) + newName + fullText.slice(end);

	return {
		code: "TS2304",
		mutatedText,
		description: `Renamed reference '${oldName}' → '${newName}' (no near match in scope or imports — pure TS2304, Layer 0 abstains).`,
	};
}
