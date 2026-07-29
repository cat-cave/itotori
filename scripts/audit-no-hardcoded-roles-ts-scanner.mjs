import {
  bindingIdentifier,
  callExpressionName,
  forEachChild,
  isCallExpression,
  isComputedMember,
  isMemberExpression,
  memberPropertyName,
  objectPropertyKeyName,
  parseTypeScript,
  stringLiteralValue,
  unwrapTsTypeAssertions,
  zeroBasedStartLine,
} from "./stable-ts-ast.mjs";
import {
  isAuthRoleMapName,
  isAuthRoleName,
  isAuthSubjectName,
  LABELS,
  markerOnLineOrAbove,
} from "./audit-no-hardcoded-roles-shared.mjs";

const BINARY_EQUALITY_OPERATORS = new Set(["===", "==", "!==", "!="]);

function immediateObjectName(expression) {
  const unwrapped = unwrapTsTypeAssertions(expression);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Identifier") return unwrapped.name;
  if (isMemberExpression(unwrapped)) return memberPropertyName(unwrapped);
  return undefined;
}

function roleReadInfo(node, aliases) {
  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return null;
  if (unwrapped.type === "Identifier") {
    if (unwrapped.name === "role") return { authSubject: false };
    const alias = aliases.get(unwrapped.name);
    return alias === undefined ? null : { authSubject: alias.authSubject };
  }
  if (isMemberExpression(unwrapped) && memberPropertyName(unwrapped) === "role") {
    return { authSubject: isAuthSubjectName(immediateObjectName(unwrapped.object)) };
  }
  return null;
}

function collectAliases(root) {
  const aliases = new Map();

  function collectRoleBindingsFromPattern(pattern, initSubject) {
    if (!pattern) return;
    if (pattern.type === "AssignmentPattern") {
      collectRoleBindingsFromPattern(pattern.left, initSubject);
      return;
    }
    if (pattern.type === "RestElement") {
      collectRoleBindingsFromPattern(pattern.argument, initSubject);
      return;
    }
    if (pattern.type === "Identifier") {
      if (pattern.name === "role") aliases.set("role", { authSubject: initSubject });
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) {
        if (element !== null) collectRoleBindingsFromPattern(element, initSubject);
      }
      return;
    }
    if (pattern.type !== "ObjectPattern") return;
    for (const property of pattern.properties) {
      if (property.type === "RestElement") {
        collectRoleBindingsFromPattern(property.argument, initSubject);
        continue;
      }
      if (property.type !== "ObjectProperty") continue;
      const propName = objectPropertyKeyName(property.key, property.computed);
      if (propName === "role") {
        const binding = bindingIdentifier(property.value);
        if (binding !== null) aliases.set(binding.name, { authSubject: initSubject });
      } else {
        collectRoleBindingsFromPattern(property.value, initSubject);
      }
    }
  }

  function initAuthSubject(init) {
    if (!init) return false;
    const unwrapped = unwrapTsTypeAssertions(init);
    if (!unwrapped) return false;
    return unwrapped.type === "Identifier" || isMemberExpression(unwrapped)
      ? isAuthSubjectName(immediateObjectName(unwrapped))
      : false;
  }

  function collectFromBinding(id, init) {
    if (!id) return;
    const unwrappedInit = unwrapTsTypeAssertions(init);
    if (
      id.type === "Identifier" &&
      unwrappedInit &&
      isMemberExpression(unwrappedInit) &&
      memberPropertyName(unwrappedInit) === "role"
    ) {
      aliases.set(id.name, {
        authSubject: isAuthSubjectName(immediateObjectName(unwrappedInit.object)),
      });
      return;
    }
    if (
      id.type === "Identifier" &&
      unwrappedInit?.type === "Identifier" &&
      (unwrappedInit.name === "role" || aliases.has(unwrappedInit.name))
    ) {
      const origin =
        unwrappedInit.name === "role" ? { authSubject: false } : aliases.get(unwrappedInit.name);
      aliases.set(id.name, { authSubject: origin?.authSubject ?? false });
      return;
    }
    if (
      id.type === "ObjectPattern" ||
      id.type === "ArrayPattern" ||
      id.type === "AssignmentPattern" ||
      id.type === "RestElement"
    ) {
      collectRoleBindingsFromPattern(id, initAuthSubject(init));
    }
  }

  function visit(node) {
    if (node.type === "VariableDeclarator" && node.init !== null && node.init !== undefined) {
      collectFromBinding(node.id, node.init);
    }
    if (node.type === "AssignmentExpression") collectFromBinding(node.left, node.right);
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassMethod" ||
      node.type === "ObjectMethod" ||
      node.type === "ClassPrivateMethod"
    ) {
      for (const param of node.params) {
        if (param.type === "AssignmentPattern") {
          if (param.left.type === "Identifier" && param.left.name === "role") {
            aliases.set("role", { authSubject: false });
          } else {
            collectRoleBindingsFromPattern(param.left, false);
          }
        } else if (param.type === "Identifier" && param.name === "role") {
          aliases.set("role", { authSubject: false });
        } else {
          collectRoleBindingsFromPattern(param, false);
        }
      }
    }
    forEachChild(node, visit);
  }

  visit(root);
  return aliases;
}

export function findTsViolations(path, contents, lines) {
  const root = parseTypeScript(contents, path);
  const aliases = collectAliases(root);
  const found = [];
  const seen = new Set();
  const record = (node, label) => {
    const line = zeroBasedStartLine(node);
    if (markerOnLineOrAbove(lines, line)) return;
    const key = `${line}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      file: path,
      line: line + 1,
      pattern: label,
      excerpt: (lines[line] ?? "").trim().slice(0, 200),
    });
  };

  function visit(node) {
    if (node.type === "BinaryExpression" && BINARY_EQUALITY_OPERATORS.has(node.operator)) {
      const leftRead = roleReadInfo(node.left, aliases);
      const rightRead = roleReadInfo(node.right, aliases);
      const leftStr = stringLiteralValue(node.left);
      const rightStr = stringLiteralValue(node.right);
      let read = null;
      let literal = null;
      if (leftRead !== null && rightStr !== null) {
        read = leftRead;
        literal = rightStr;
      } else if (rightRead !== null && leftStr !== null) {
        read = rightRead;
        literal = leftStr;
      }
      if (read !== null && (read.authSubject || isAuthRoleName(literal))) {
        record(node, LABELS.comparison);
      }
    }

    if (node.type === "SwitchStatement") {
      const discriminant = roleReadInfo(node.discriminant, aliases);
      if (discriminant !== null) {
        const caseValues = node.cases
          .filter((clause) => clause.test !== null)
          .map((clause) => stringLiteralValue(clause.test))
          .filter((value) => value !== null);
        if (discriminant.authSubject || caseValues.some((value) => isAuthRoleName(value))) {
          record(node, LABELS.switch);
        }
      }
    }

    if (isComputedMember(node)) {
      const index = roleReadInfo(node.property, aliases);
      if (
        index !== null &&
        (isAuthRoleMapName(immediateObjectName(node.object)) || index.authSubject)
      ) {
        record(node, LABELS.lookup);
      }
      const keyLiteral = stringLiteralValue(node.property);
      if (keyLiteral !== null && isAuthRoleName(keyLiteral)) record(node, LABELS.lookup);
    }

    if (
      isMemberExpression(node) &&
      memberPropertyName(node) === "role" &&
      isAuthSubjectName(immediateObjectName(node.object))
    ) {
      record(node, LABELS.subject);
    }

    if (node.type === "Identifier" || node.type === "JSXIdentifier") {
      if (/^is_?[Aa]dmin$/u.test(node.name)) record(node, LABELS.isAdmin);
      else if (node.name === "roleValues") record(node, LABELS.roleValues);
      else if (node.name === "ROLES") record(node, LABELS.roles);
    }
    if (isCallExpression(node)) {
      const calleeName = callExpressionName(node.callee);
      if (calleeName !== undefined && /^has_?[Rr]ole$/u.test(calleeName)) {
        record(node, LABELS.hasRole);
      }
    }
    forEachChild(node, visit);
  }

  visit(root);
  return found;
}
