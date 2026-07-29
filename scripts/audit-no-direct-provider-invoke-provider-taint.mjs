import {
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  objectPropertyKeyName,
  unwrapTsTypeAssertions,
  walk,
} from "./stable-ts-ast.mjs";
import {
  expressionPath,
  hasModelProviderType,
  isProviderName,
  staticStringValue,
} from "./audit-no-direct-provider-invoke-provider-analysis.mjs";

export function collectStringConstants(root) {
  const initializers = new Map();
  const ambiguousNames = new Set();
  const constants = new Map();

  walk(root, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.parent?.type !== "VariableDeclaration" ||
      node.parent.kind !== "const" ||
      node.id.type !== "Identifier" ||
      node.init === null
    ) {
      return;
    }
    if (initializers.has(node.id.name) || ambiguousNames.has(node.id.name)) {
      initializers.delete(node.id.name);
      ambiguousNames.add(node.id.name);
      return;
    }
    initializers.set(node.id.name, node.init);
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of initializers) {
      if (constants.has(name)) continue;
      const value = staticStringValue(initializer, constants);
      if (value !== undefined) {
        constants.set(name, value);
        changed = true;
      }
    }
  }

  return constants;
}

export function expressionProducesProvider(
  node,
  providerAliases,
  providerTypeNames,
  typedProviderMemberPaths,
) {
  if (!node) return false;
  if (hasModelProviderType(node, providerTypeNames)) return true;

  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return false;
  if (unwrapped.type === "Identifier") {
    return providerAliases.has(unwrapped.name) || isProviderName(unwrapped.name);
  }
  if (isMemberExpression(unwrapped)) {
    const path = expressionPath(unwrapped);
    if (path !== undefined && typedProviderMemberPaths.has(path)) return true;
    const property = memberPropertyName(unwrapped);
    return property !== undefined && isProviderName(property);
  }
  if (isCallExpression(unwrapped)) {
    const callee = unwrapTsTypeAssertions(unwrapped.callee);
    if (callee?.type === "Identifier") {
      return providerAliases.has(callee.name) || isProviderName(callee.name);
    }
    if (isMemberExpression(callee)) {
      const property = memberPropertyName(callee);
      return property !== undefined && (providerAliases.has(property) || isProviderName(property));
    }
    return false;
  }
  if (unwrapped.type === "ObjectExpression") {
    return unwrapped.properties.some(
      (property) =>
        property.type === "SpreadElement" &&
        expressionProducesProvider(
          property.argument,
          providerAliases,
          providerTypeNames,
          typedProviderMemberPaths,
        ),
    );
  }
  if (unwrapped.type === "ConditionalExpression") {
    return (
      expressionProducesProvider(
        unwrapped.consequent,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      ) ||
      expressionProducesProvider(
        unwrapped.alternate,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      )
    );
  }
  if (unwrapped.type === "LogicalExpression") {
    return (
      expressionProducesProvider(
        unwrapped.left,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      ) ||
      expressionProducesProvider(
        unwrapped.right,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      )
    );
  }
  if (unwrapped.type === "AwaitExpression") {
    return expressionProducesProvider(
      unwrapped.argument,
      providerAliases,
      providerTypeNames,
      typedProviderMemberPaths,
    );
  }
  return false;
}

function collectProviderPatternAliases(pattern, providerAliases, constants) {
  if (pattern.type !== "ObjectPattern") return false;
  let changed = false;

  for (const property of pattern.properties) {
    if (property.type !== "ObjectProperty") continue;
    const key =
      objectPropertyKeyName(property.key, property.computed) ??
      (property.computed ? staticStringValue(property.key, constants) : undefined);
    if (key === undefined || !isProviderName(key)) continue;
    const value =
      property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    if (value.type === "Identifier" && !providerAliases.has(value.name)) {
      providerAliases.add(value.name);
      changed = true;
    }
  }
  return changed;
}

export function collectProviderAliases(
  root,
  constants,
  providerTypeNames,
  typedProviderMemberPaths,
  providerReturningFunctionNames,
) {
  const providerAliases = new Set(providerReturningFunctionNames);
  let changed = true;

  while (changed) {
    changed = false;
    walk(root, (node) => {
      if (
        node.type === "Identifier" &&
        hasModelProviderType(node, providerTypeNames) &&
        !providerAliases.has(node.name)
      ) {
        providerAliases.add(node.name);
        changed = true;
      }

      if (node.type === "VariableDeclarator") {
        if (
          node.id.type === "Identifier" &&
          expressionProducesProvider(
            node.init,
            providerAliases,
            providerTypeNames,
            typedProviderMemberPaths,
          ) &&
          !providerAliases.has(node.id.name)
        ) {
          providerAliases.add(node.id.name);
          changed = true;
        }
        if (collectProviderPatternAliases(node.id, providerAliases, constants)) changed = true;
      }

      if (node.type === "AssignmentExpression" && node.operator === "=") {
        if (
          node.left.type === "Identifier" &&
          expressionProducesProvider(
            node.right,
            providerAliases,
            providerTypeNames,
            typedProviderMemberPaths,
          ) &&
          !providerAliases.has(node.left.name)
        ) {
          providerAliases.add(node.left.name);
          changed = true;
        }
        if (collectProviderPatternAliases(node.left, providerAliases, constants)) changed = true;
      }
    });
  }

  return providerAliases;
}

export function collectOneArgumentCallBindings(root) {
  const bindings = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    walk(root, (node) => {
      if (isCallExpression(node) && node.arguments.length === 1) {
        const callee = unwrapTsTypeAssertions(node.callee);
        if (callee?.type === "Identifier" && !bindings.has(callee.name)) {
          bindings.add(callee.name);
          changed = true;
        }
      }

      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        bindings.has(node.id.name)
      ) {
        const source = unwrapTsTypeAssertions(node.init);
        if (source?.type === "Identifier" && !bindings.has(source.name)) {
          bindings.add(source.name);
          changed = true;
        }
      }

      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type === "Identifier" &&
        bindings.has(node.left.name)
      ) {
        const source = unwrapTsTypeAssertions(node.right);
        if (source?.type === "Identifier" && !bindings.has(source.name)) {
          bindings.add(source.name);
          changed = true;
        }
      }
    });
  }

  return bindings;
}
