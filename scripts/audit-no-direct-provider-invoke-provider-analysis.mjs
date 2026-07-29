import {
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  objectPropertyKeyName,
  stringLiteralValue,
  unwrapTsTypeAssertions,
  walk,
} from "./stable-ts-ast.mjs";

function receiverNames(node) {
  const names = [];

  function collect(current) {
    const unwrapped = unwrapTsTypeAssertions(current);
    if (!unwrapped) return;
    if (unwrapped.type === "Identifier") {
      names.push(unwrapped.name);
      return;
    }
    if (unwrapped.type === "ThisExpression") {
      names.push("this");
      return;
    }
    if (isMemberExpression(unwrapped)) {
      collect(unwrapped.object);
      const property = memberPropertyName(unwrapped);
      if (property !== undefined) names.push(property);
      return;
    }
    if (isCallExpression(unwrapped)) collect(unwrapped.callee);
  }

  collect(node);
  return names;
}

export function isProviderName(name) {
  return /provider(?:factory)?$/iu.test(name) || /^(?:inner|delegate)$/iu.test(name);
}

export function isProviderForwardingReceiver(node, providerAliases = new Set()) {
  return receiverNames(node).some((name) => providerAliases.has(name) || isProviderName(name));
}

export function staticStringValue(node, constants) {
  const literal = stringLiteralValue(node);
  if (literal !== null) return literal;

  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Identifier") return constants.get(unwrapped.name);
  if (unwrapped.type === "BinaryExpression" && unwrapped.operator === "+") {
    const left = staticStringValue(unwrapped.left, constants);
    const right = staticStringValue(unwrapped.right, constants);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (unwrapped.type === "TemplateLiteral") {
    let value = "";
    for (let index = 0; index < unwrapped.quasis.length; index += 1) {
      value += unwrapped.quasis[index]?.value.cooked ?? unwrapped.quasis[index]?.value.raw ?? "";
      const expression = unwrapped.expressions[index];
      if (expression === undefined) continue;
      const expressionValue = staticStringValue(expression, constants);
      if (expressionValue === undefined) return undefined;
      value += expressionValue;
    }
    return value;
  }
  return undefined;
}

export function typeReferencesModelProvider(typeNode, providerTypeNames) {
  if (!typeNode) return false;
  if (typeNode.type === "TSTypeAnnotation" || typeNode.type === "TSParenthesizedType") {
    return typeReferencesModelProvider(typeNode.typeAnnotation, providerTypeNames);
  }
  if (typeNode.type === "TSTypeReference") {
    let typeName = typeNode.typeName;
    while (typeName.type === "TSQualifiedName") typeName = typeName.right;
    return typeName.type === "Identifier" && providerTypeNames.has(typeName.name);
  }
  if (typeNode.type === "TSUnionType" || typeNode.type === "TSIntersectionType") {
    return typeNode.types.some((candidate) =>
      typeReferencesModelProvider(candidate, providerTypeNames),
    );
  }
  return false;
}

export function collectModelProviderTypeNames(root) {
  const providerTypeNames = new Set(["ModelProvider"]);
  let changed = true;

  while (changed) {
    changed = false;
    walk(root, (node) => {
      if (node.type === "ImportSpecifier") {
        const imported =
          node.imported.type === "Identifier" ? node.imported.name : String(node.imported.value);
        if (providerTypeNames.has(imported) && !providerTypeNames.has(node.local.name)) {
          providerTypeNames.add(node.local.name);
          changed = true;
        }
      }
      if (
        node.type === "TSTypeAliasDeclaration" &&
        typeReferencesModelProvider(node.typeAnnotation, providerTypeNames) &&
        !providerTypeNames.has(node.id.name)
      ) {
        providerTypeNames.add(node.id.name);
        changed = true;
      }
    });
  }

  return providerTypeNames;
}

export function collectProviderReturningFunctionNames(root, providerTypeNames) {
  const namedCallableTypes = new Map();
  const names = new Set();

  walk(root, (node) => {
    if (node.type === "TSTypeAliasDeclaration") {
      namedCallableTypes.set(node.id.name, node.typeAnnotation);
    } else if (node.type === "TSInterfaceDeclaration") {
      namedCallableTypes.set(node.id.name, node.body);
    }
  });

  function returnsModelProvider(typeNode, seen = new Set()) {
    if (!typeNode) return false;
    if (typeNode.type === "TSTypeAnnotation" || typeNode.type === "TSParenthesizedType") {
      return returnsModelProvider(typeNode.typeAnnotation, seen);
    }
    if (typeNode.type === "TSFunctionType" || typeNode.type === "TSConstructorType") {
      return typeReferencesModelProvider(typeNode.returnType, providerTypeNames);
    }
    if (typeNode.type === "TSUnionType" || typeNode.type === "TSIntersectionType") {
      return typeNode.types.some((candidate) => returnsModelProvider(candidate, seen));
    }
    if (typeNode.type === "TSTypeReference" && typeNode.typeName.type === "Identifier") {
      const name = typeNode.typeName.name;
      if (seen.has(name)) return false;
      const namedType = namedCallableTypes.get(name);
      return namedType !== undefined && returnsModelProvider(namedType, new Set([...seen, name]));
    }
    const members =
      typeNode.type === "TSTypeLiteral"
        ? typeNode.members
        : typeNode.type === "TSInterfaceBody"
          ? typeNode.body
          : undefined;
    return (
      members?.some(
        (member) =>
          member.type === "TSCallSignatureDeclaration" &&
          typeReferencesModelProvider(member.returnType, providerTypeNames),
      ) ?? false
    );
  }

  walk(root, (node) => {
    if (
      (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") &&
      node.id !== null &&
      typeReferencesModelProvider(node.returnType, providerTypeNames)
    ) {
      names.add(node.id.name);
      return;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      (returnsModelProvider(node.id.typeAnnotation) ||
        ((node.init?.type === "ArrowFunctionExpression" ||
          node.init?.type === "FunctionExpression") &&
          typeReferencesModelProvider(node.init.returnType, providerTypeNames)))
    ) {
      names.add(node.id.name);
      return;
    }
    if (
      (node.type === "ObjectMethod" || node.type === "ClassMethod") &&
      typeReferencesModelProvider(node.returnType, providerTypeNames)
    ) {
      const name = objectPropertyKeyName(node.key, node.computed);
      if (name !== undefined) names.add(name);
    }
  });

  return names;
}

export function hasModelProviderType(node, providerTypeNames) {
  return typeReferencesModelProvider(node?.typeAnnotation, providerTypeNames);
}

export function expressionPath(node) {
  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Identifier") return unwrapped.name;
  if (unwrapped.type === "ThisExpression") return "this";
  if (!isMemberExpression(unwrapped)) return undefined;
  const objectPath = expressionPath(unwrapped.object);
  const property = memberPropertyName(unwrapped);
  return objectPath === undefined || property === undefined
    ? undefined
    : `${objectPath}.${property}`;
}

export function collectTypedProviderMemberPaths(root, providerTypeNames) {
  const namedObjectTypes = new Map();
  walk(root, (node) => {
    if (node.type === "TSTypeAliasDeclaration") {
      namedObjectTypes.set(node.id.name, node.typeAnnotation);
    } else if (node.type === "TSInterfaceDeclaration") {
      namedObjectTypes.set(node.id.name, node.body);
    }
  });

  function providerProperties(typeNode, seen = new Set()) {
    if (!typeNode) return new Set();
    if (typeNode.type === "TSTypeAnnotation" || typeNode.type === "TSParenthesizedType") {
      return providerProperties(typeNode.typeAnnotation, seen);
    }
    if (typeNode.type === "TSUnionType" || typeNode.type === "TSIntersectionType") {
      const properties = new Set();
      for (const candidate of typeNode.types) {
        for (const property of providerProperties(candidate, seen)) properties.add(property);
      }
      return properties;
    }
    if (typeNode.type === "TSTypeReference" && typeNode.typeName.type === "Identifier") {
      const typeName = typeNode.typeName.name;
      if (seen.has(typeName)) return new Set();
      const namedType = namedObjectTypes.get(typeName);
      if (namedType === undefined) return new Set();
      return providerProperties(namedType, new Set([...seen, typeName]));
    }
    const members =
      typeNode.type === "TSTypeLiteral"
        ? typeNode.members
        : typeNode.type === "TSInterfaceBody"
          ? typeNode.body
          : undefined;
    if (members === undefined) return new Set();

    const properties = new Set();
    for (const member of members) {
      if (
        member.type !== "TSPropertySignature" ||
        !typeReferencesModelProvider(member.typeAnnotation, providerTypeNames)
      ) {
        continue;
      }
      const property = objectPropertyKeyName(member.key, member.computed);
      if (property !== undefined) properties.add(property);
    }
    return properties;
  }

  const paths = new Set();
  walk(root, (node) => {
    if (node.type === "Identifier" && node.typeAnnotation !== undefined) {
      for (const property of providerProperties(node.typeAnnotation)) {
        paths.add(`${node.name}.${property}`);
      }
    }
    if (
      (node.type === "ClassProperty" || node.type === "ClassPrivateProperty") &&
      node.typeAnnotation !== undefined &&
      typeReferencesModelProvider(node.typeAnnotation, providerTypeNames)
    ) {
      const property = objectPropertyKeyName(node.key, node.computed);
      if (property !== undefined) paths.add(`this.${property}`);
    }
  });
  return paths;
}
