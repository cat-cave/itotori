#!/usr/bin/env node
// CI guard: no direct legacy ModelProvider invocation.
//
// The rebuilt LLM layer has one physical dispatch boundary:
// apps/itotori/src/llm/dispatch.ts, which delegates through the pinned TanStack
// adapter. No shipped source may call (or capture) a legacy provider's
// `invoke` member. The companion LLM-layer import guard proves that this
// dispatcher is the only provider-SDK importer.
//
// This guard is defense-in-depth against accidental direct calls. The primary
// control is architectural: providers are constructed and handed only to the
// supervisor. AST-only analysis cannot soundly decide a fully neutral alias
// such as `function f(p) { p.invoke(req); }`; that undecidable case is
// intentionally out of scope.
//
// This is AST-based rather than a grep so comments and strings do not count,
// while optional chaining and literal-computed access still do. ModelProvider
// has the distinctive one-request `invoke(request)` signature; the app's
// higher-level QA agents use `invoke(actor, input)`, which this guard leaves
// alone. Provider-named/forwarding receivers are rejected regardless of arity
// so malformed calls and method extraction cannot evade the policy.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindingIdentifier,
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  nodeText,
  objectPropertyKeyName,
  parseTypeScript,
  stringLiteralValue,
  unwrapTsTypeAssertions,
  walk,
  zeroBasedStartLine,
} from "./stable-ts-ast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const LLM_DISPATCHER_PATH = "apps/itotori/src/llm/dispatch.ts";

function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function isExemptPath(path) {
  // There is no remaining direct-invocation adapter or supervisor exemption.
  // Keep this exported predicate for the regression suite; its false value is
  // itself the guard against reviving the deleted provider stack.
  void path;
  return false;
}

export function shouldScanPath(path) {
  const normalized = normalizeRepoPath(path);
  return (
    normalized.startsWith("apps/itotori/src/") &&
    TS_LIKE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  );
}

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
    if (isCallExpression(unwrapped)) {
      collect(unwrapped.callee);
    }
  }

  collect(node);
  return names;
}

function isProviderName(name) {
  return /provider(?:factory)?$/iu.test(name) || /^(?:inner|delegate)$/iu.test(name);
}

function isProviderForwardingReceiver(node, providerAliases = new Set()) {
  return receiverNames(node).some((name) => providerAliases.has(name) || isProviderName(name));
}

function staticStringValue(node, constants) {
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

function typeReferencesModelProvider(typeNode, providerTypeNames) {
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

function collectModelProviderTypeNames(root) {
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

function collectProviderReturningFunctionNames(root, providerTypeNames) {
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

function hasModelProviderType(node, providerTypeNames) {
  return typeReferencesModelProvider(node?.typeAnnotation, providerTypeNames);
}

function expressionPath(node) {
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

function collectTypedProviderMemberPaths(root, providerTypeNames) {
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

function collectStringConstants(root) {
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

function expressionProducesProvider(
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

function collectProviderAliases(
  root,
  constants,
  providerTypeNames,
  typedProviderMemberPaths,
  providerReturningFunctionNames,
) {
  // Provider-returning functions are producer bindings: treating their local
  // names as provider-tainted also follows simple aliases (`const build =
  // getBackend`) before a later call produces the provider value.
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

function collectOneArgumentCallBindings(root) {
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

function assignedBindingName(node) {
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

function isMemberRead(node) {
  const parent = node.parent;
  if (parent?.type === "AssignmentExpression" && parent.left === node) return false;
  if (parent?.type === "UpdateExpression" && parent.argument === node) return false;
  if (parent?.type === "UnaryExpression" && parent.operator === "delete") return false;
  return true;
}

function resolvedMemberPropertyName(member, constants) {
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

function collectReflectGetAliases(root) {
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

function isReflectGetCall(node, aliases) {
  if (!isCallExpression(node)) return false;
  const callee = unwrapTsTypeAssertions(node.callee);
  return (
    isDirectReflectGet(callee, aliases.reflectObjectAliases) ||
    (callee?.type === "Identifier" && aliases.getAliases.has(callee.name))
  );
}

function isObjectValuesCall(node, constants) {
  if (!isCallExpression(node)) return false;
  const callee = unwrapTsTypeAssertions(node.callee);
  if (!isMemberExpression(callee) || resolvedMemberPropertyName(callee, constants) !== "values") {
    return false;
  }
  const receiver = unwrapTsTypeAssertions(callee.object);
  return receiver?.type === "Identifier" && receiver.name === "Object";
}

function destructuredInvokeProperties(
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
      // A statically named `invoke` binding becomes a provider candidate before
      // receiver-name filtering; its eventual one-request call supplies the
      // ModelProvider signature fallback for neutral aliases. Truly dynamic
      // destructuring remains limited to receivers proven provider-valued.
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

function directCallForMember(member) {
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

/**
 * Find forbidden provider-dispatch surfaces in one source file.
 * Exported for the companion regression suite.
 */
export function findViolations(path, contents) {
  const normalizedPath = normalizeRepoPath(path);
  if (isExemptPath(normalizedPath)) return [];

  const lines = contents.split(/\r?\n/u);
  const root = parseTypeScript(contents, normalizedPath);
  const constants = collectStringConstants(root);
  const providerTypeNames = collectModelProviderTypeNames(root);
  const providerReturningFunctionNames = collectProviderReturningFunctionNames(
    root,
    providerTypeNames,
  );
  const typedProviderMemberPaths = collectTypedProviderMemberPaths(root, providerTypeNames);
  const providerAliases = collectProviderAliases(
    root,
    constants,
    providerTypeNames,
    typedProviderMemberPaths,
    providerReturningFunctionNames,
  );
  const reflectGetAliases = collectReflectGetAliases(root);
  const oneArgumentCallBindings = collectOneArgumentCallBindings(root);
  const violations = [];

  function addViolation(node, receiver) {
    const lineIndex = zeroBasedStartLine(node);
    violations.push({
      file: normalizedPath,
      line: lineIndex + 1,
      column: (node.loc?.start.column ?? 0) + 1,
      receiver,
      excerpt: (lines[lineIndex] ?? "").trim().slice(0, 200),
    });
  }

  function addDestructuringViolations(pattern, source) {
    for (const match of destructuredInvokeProperties(
      pattern,
      source,
      providerAliases,
      providerTypeNames,
      typedProviderMemberPaths,
      constants,
      contents,
    )) {
      const binding = bindingIdentifier(match.node.value);
      if (
        match.receiverIsProvider ||
        isProviderForwardingReceiver(source, providerAliases) ||
        expressionProducesProvider(
          source,
          providerAliases,
          providerTypeNames,
          typedProviderMemberPaths,
        ) ||
        (binding !== null && oneArgumentCallBindings.has(binding.name))
      ) {
        addViolation(match.node, match.receiver);
      }
    }
  }

  walk(root, (node) => {
    if (node.type === "VariableDeclarator" && node.init !== null) {
      addDestructuringViolations(node.id, node.init);
      return;
    }

    if (node.type === "AssignmentExpression" && node.operator === "=") {
      addDestructuringViolations(node.left, node.right);
      return;
    }

    if (
      node.type === "AssignmentPattern" &&
      Array.isArray(node.parent?.params) &&
      node.parent.params.includes(node)
    ) {
      addDestructuringViolations(node.left, node.right);
      return;
    }

    if (isObjectValuesCall(node, constants)) {
      const receiver = node.arguments[0];
      if (
        receiver !== undefined &&
        receiver.type !== "SpreadElement" &&
        (isProviderForwardingReceiver(receiver, providerAliases) ||
          expressionProducesProvider(
            receiver,
            providerAliases,
            providerTypeNames,
            typedProviderMemberPaths,
          ))
      ) {
        addViolation(node, nodeText(contents, receiver).replace(/\s+/gu, " ").slice(0, 120));
      }
      return;
    }

    if (isReflectGetCall(node, reflectGetAliases)) {
      const receiver = node.arguments[0];
      const property = node.arguments[1];
      if (receiver?.type === "SpreadElement" || property?.type === "SpreadElement") return;
      const propertyName = staticStringValue(property, constants);
      const assignedBinding = assignedBindingName(node);
      if (
        receiver !== undefined &&
        (propertyName === "invoke" || propertyName === undefined) &&
        (isProviderForwardingReceiver(receiver, providerAliases) ||
          expressionProducesProvider(
            receiver,
            providerAliases,
            providerTypeNames,
            typedProviderMemberPaths,
          ) ||
          (propertyName === "invoke" &&
            assignedBinding !== undefined &&
            oneArgumentCallBindings.has(assignedBinding)))
      ) {
        addViolation(node, nodeText(contents, receiver).replace(/\s+/gu, " ").slice(0, 120));
      }
      return;
    }

    if (!isMemberExpression(node)) return;

    const propertyName = resolvedMemberPropertyName(node, constants);
    const call = directCallForMember(node);
    const providerReceiver =
      isProviderForwardingReceiver(node.object, providerAliases) ||
      expressionProducesProvider(
        node.object,
        providerAliases,
        providerTypeNames,
        typedProviderMemberPaths,
      );
    const assignedBinding = assignedBindingName(node);
    // ModelProvider.invoke accepts exactly one request. Higher-level agent
    // `invoke(actor, input)` calls have two arguments and are not dispatches.
    const modelProviderSignature =
      propertyName === "invoke" && call !== undefined && call.arguments.length === 1;
    const extractedOneArgumentDispatch =
      propertyName === "invoke" &&
      assignedBinding !== undefined &&
      oneArgumentCallBindings.has(assignedBinding);
    const dynamicProviderExtraction =
      node.computed && propertyName === undefined && providerReceiver && isMemberRead(node);
    if (
      propertyName !== "invoke" &&
      !modelProviderSignature &&
      !extractedOneArgumentDispatch &&
      !dynamicProviderExtraction
    ) {
      return;
    }
    if (!providerReceiver && !modelProviderSignature && !extractedOneArgumentDispatch) return;

    addViolation(node, nodeText(contents, node.object).replace(/\s+/gu, " ").slice(0, 120));
  });

  return violations;
}

function listSourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "apps/itotori/src"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      // `git ls-files --cached` retains index entries for worktree deletions.
      // A deleted forbidden caller must disappear from the scan rather than
      // crashing the guard before it can inspect the replacement path.
      .filter((line) => line.length > 0 && shouldScanPath(line) && existsSync(join(repoRoot, line)))
  );
}

function resolveScanTargets(args) {
  if (args.length === 0) {
    return listSourceFiles().map((path) => ({ path, absolutePath: join(repoRoot, path) }));
  }
  return args.map((argument) => {
    const absolutePath = resolve(argument);
    const repoRelative = relative(repoRoot, absolutePath);
    return {
      path: normalizeRepoPath(repoRelative.startsWith("..") ? absolutePath : repoRelative),
      absolutePath,
    };
  });
}

export function runAudit(args = []) {
  const violations = [];
  let scannedCount = 0;

  for (const target of resolveScanTargets(args)) {
    if (args.length === 0 && !shouldScanPath(target.path)) continue;
    if (!TS_LIKE_EXTENSIONS.some((extension) => target.path.endsWith(extension))) continue;
    const contents = readFileSync(target.absolutePath, "utf8");
    scannedCount += 1;
    violations.push(...findViolations(target.path, contents));
  }

  if (violations.length > 0) {
    process.stderr.write(
      `no-direct-provider-invoke audit failed: ${violations.length} forbidden provider dispatch${violations.length === 1 ? "" : "es"} found.\n` +
        "Direct provider invocation is retired; route model work through " +
        `${LLM_DISPATCHER_PATH}.\n\n`,
    );
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}:${violation.column}  [receiver: ${violation.receiver}]\n` +
          `    ${violation.excerpt}\n`,
      );
    }
    return 1;
  }

  process.stdout.write(
    `no-direct-provider-invoke audit passed: ${scannedCount} shipped source files scanned.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runAudit(process.argv.slice(2)));
}
