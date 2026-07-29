import {
  bindingIdentifier,
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  nodeText,
  objectPropertyKeyName,
  unwrapTsTypeAssertions,
  walk,
} from "./stable-ts-ast.mjs";
import {
  isProviderForwardingReceiver,
  isProviderName,
  staticStringValue,
} from "./audit-no-direct-provider-invoke-provider-analysis.mjs";
import { expressionProducesProvider } from "./audit-no-direct-provider-invoke-provider-taint.mjs";

export function assignedBindingName(node) {
  let expression = node;
  let parent = node.parent;

  while (
    parent &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "ParenthesizedExpression") &&
    parent.expression === expression
  ) {
    expression = parent;
    parent = parent.parent;
  }

  if (parent?.type === "VariableDeclarator" && parent.init === expression) {
    return parent.id.type === "Identifier" ? parent.id.name : undefined;
  }
  if (parent?.type === "AssignmentExpression" && parent.right === expression) {
    return parent.left.type === "Identifier" ? parent.left.name : undefined;
  }
  return undefined;
}

export function isMemberRead(node) {
  const parent = node.parent;
  if (parent?.type === "AssignmentExpression" && parent.left === node) return false;
  if (parent?.type === "UpdateExpression" && parent.argument === node) return false;
  if (parent?.type === "UnaryExpression" && parent.operator === "delete") return false;
  return true;
}

export function resolvedMemberPropertyName(member, constants) {
  return (
    memberPropertyName(member) ??
    (member.computed ? staticStringValue(member.property, constants) : undefined)
  );
}

function isDirectReflectGet(node, reflectObjectAliases) {
  const unwrapped = unwrapTsTypeAssertions(node);
  if (!isMemberExpression(unwrapped) || memberPropertyName(unwrapped) !== "get") return false;
  const receiver = unwrapTsTypeAssertions(unwrapped.object);
  return receiver?.type === "Identifier" && reflectObjectAliases.has(receiver.name);
}

export function collectReflectGetAliases(root) {
  const reflectObjectAliases = new Set(["Reflect"]);
  const getAliases = new Set();
  let changed = true;

  function collectDestructuredGet(pattern, source) {
    const unwrappedSource = unwrapTsTypeAssertions(source);
    if (
      pattern.type !== "ObjectPattern" ||
      unwrappedSource?.type !== "Identifier" ||
      !reflectObjectAliases.has(unwrappedSource.name)
    ) {
      return false;
    }
    let added = false;
    for (const property of pattern.properties) {
      if (
        property.type !== "ObjectProperty" ||
        objectPropertyKeyName(property.key, property.computed) !== "get"
      ) {
        continue;
      }
      const binding = bindingIdentifier(property.value);
      if (binding !== null && !getAliases.has(binding.name)) {
        getAliases.add(binding.name);
        added = true;
      }
    }
    return added;
  }

  while (changed) {
    changed = false;
    walk(root, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        const source = unwrapTsTypeAssertions(node.init);
        if (
          source?.type === "Identifier" &&
          reflectObjectAliases.has(source.name) &&
          !reflectObjectAliases.has(node.id.name)
        ) {
          reflectObjectAliases.add(node.id.name);
          changed = true;
        }
        if (
          (isDirectReflectGet(source, reflectObjectAliases) ||
            (source?.type === "Identifier" && getAliases.has(source.name))) &&
          !getAliases.has(node.id.name)
        ) {
          getAliases.add(node.id.name);
          changed = true;
        }
      }
      if (node.type === "VariableDeclarator" && collectDestructuredGet(node.id, node.init)) {
        changed = true;
      }
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type === "Identifier"
      ) {
        const source = unwrapTsTypeAssertions(node.right);
        if (
          source?.type === "Identifier" &&
          reflectObjectAliases.has(source.name) &&
          !reflectObjectAliases.has(node.left.name)
        ) {
          reflectObjectAliases.add(node.left.name);
          changed = true;
        }
        if (
          (isDirectReflectGet(source, reflectObjectAliases) ||
            (source?.type === "Identifier" && getAliases.has(source.name))) &&
          !getAliases.has(node.left.name)
        ) {
          getAliases.add(node.left.name);
          changed = true;
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        collectDestructuredGet(node.left, node.right)
      ) {
        changed = true;
      }
    });
  }

  return { getAliases, reflectObjectAliases };
}

export function isReflectGetCall(node, aliases) {
  if (!isCallExpression(node)) return false;
  const callee = unwrapTsTypeAssertions(node.callee);
  return (
    isDirectReflectGet(callee, aliases.reflectObjectAliases) ||
    (callee?.type === "Identifier" && aliases.getAliases.has(callee.name))
  );
}

export function isObjectValuesCall(node, constants) {
  if (!isCallExpression(node)) return false;
  const callee = unwrapTsTypeAssertions(node.callee);
  if (!isMemberExpression(callee) || resolvedMemberPropertyName(callee, constants) !== "values") {
    return false;
  }
  const receiver = unwrapTsTypeAssertions(callee.object);
  return receiver?.type === "Identifier" && receiver.name === "Object";
}

export function destructuredInvokeProperties(
  pattern,
  source,
  providerAliases,
  providerTypeNames,
  typedProviderMemberPaths,
  constants,
  contents,
) {
  const matches = [];

  function collectObjectPattern(current, receiver, receiverIsProvider) {
    if (current.type !== "ObjectPattern") return;
    for (const property of current.properties) {
      if (property.type !== "ObjectProperty") continue;
      const key =
        objectPropertyKeyName(property.key, property.computed) ??
        (property.computed ? staticStringValue(property.key, constants) : undefined);
      const dynamicKey = property.computed && key === undefined;
      if (key === "invoke" || (receiverIsProvider && dynamicKey)) {
        matches.push({ node: property, receiver, receiverIsProvider });
      }

      const value =
        property.value.type === "AssignmentPattern" ? property.value.left : property.value;
      if (value.type === "ObjectPattern") {
        const childReceiver = key === undefined ? receiver : `${receiver}.${key}`;
        collectObjectPattern(
          value,
          childReceiver,
          typedProviderMemberPaths.has(childReceiver) || (key !== undefined && isProviderName(key)),
        );
      }
    }
  }

  function collectPattern(current, currentSource) {
    if (!current) return;
    if (current.type === "AssignmentPattern") {
      collectPattern(current.left, currentSource ?? current.right);
      return;
    }
    if (current.type === "ArrayPattern") {
      const unwrappedSource = unwrapTsTypeAssertions(currentSource);
      if (unwrappedSource?.type !== "ArrayExpression") return;
      for (let index = 0; index < current.elements.length; index += 1) {
        const element = current.elements[index];
        const elementSource = unwrappedSource.elements[index];
        if (element === null || elementSource === null || elementSource === undefined) continue;
        if (element.type === "RestElement" || elementSource.type === "SpreadElement") continue;
        collectPattern(element, elementSource);
      }
      return;
    }
    if (current.type !== "ObjectPattern" || !currentSource) return;

    const receiver = nodeText(contents, currentSource).replace(/\s+/gu, " ").slice(0, 120);
    collectObjectPattern(
      current,
      receiver,
      expressionProducesProvider(
        currentSource,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      ) || isProviderForwardingReceiver(currentSource, providerAliases),
    );
  }

  collectPattern(pattern, source);
  return matches;
}

export function directCallForMember(member) {
  let expression = member;
  let parent = member.parent;

  while (
    parent &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "ParenthesizedExpression") &&
    parent.expression === expression
  ) {
    expression = parent;
    parent = parent.parent;
  }

  if (!isCallExpression(parent)) return undefined;
  return unwrapTsTypeAssertions(parent.callee) === member ? parent : undefined;
}
