import { objectPropertyKeyName } from "./stable-ts-ast.mjs";

export function unwrapTsTypeAssertions(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression;
  }
  return current;
}

export function forEachPatternBinding(pattern, onBinding, parentKeyName = undefined) {
  if (!pattern) return;
  if (pattern.type === "AssignmentPattern")
    return forEachPatternBinding(pattern.left, onBinding, parentKeyName);
  if (pattern.type === "RestElement")
    return forEachPatternBinding(pattern.argument, onBinding, parentKeyName);
  if (pattern.type === "Identifier") return onBinding(pattern, parentKeyName, pattern);
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "RestElement")
        forEachPatternBinding(property.argument, onBinding, parentKeyName);
      else if (property.type === "ObjectProperty") {
        forEachPatternBinding(
          property.value,
          onBinding,
          objectPropertyKeyName(property.key, property.computed),
        );
      }
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements)
      if (element !== null) forEachPatternBinding(element, onBinding, parentKeyName);
  }
}
