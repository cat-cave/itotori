import { callExpressionName } from "./stable-ts-ast.mjs";

export function permissionHelperCallName(expression, aliases, options = {}) {
  const name = callExpressionName(expression, options);
  return name !== undefined && aliases.has(name) ? name : undefined;
}
