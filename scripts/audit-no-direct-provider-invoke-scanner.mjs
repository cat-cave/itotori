import {
  bindingIdentifier,
  isMemberExpression,
  nodeText,
  parseTypeScript,
  walk,
  zeroBasedStartLine,
} from "./stable-ts-ast.mjs";
import { normalizeRepoPath } from "./audit-no-direct-provider-invoke-paths.mjs";
import {
  collectModelProviderTypeNames,
  collectProviderReturningFunctionNames,
  collectTypedProviderMemberPaths,
  isProviderForwardingReceiver,
  staticStringValue,
} from "./audit-no-direct-provider-invoke-provider-analysis.mjs";
import {
  collectOneArgumentCallBindings,
  collectProviderAliases,
  collectStringConstants,
  expressionProducesProvider,
} from "./audit-no-direct-provider-invoke-provider-taint.mjs";
import {
  assignedBindingName,
  collectReflectGetAliases,
  destructuredInvokeProperties,
  directCallForMember,
  isMemberRead,
  isObjectValuesCall,
  isReflectGetCall,
  resolvedMemberPropertyName,
} from "./audit-no-direct-provider-invoke-invocation-analysis.mjs";

function isExemptPath(path) {
  void path;
  return false;
}

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
