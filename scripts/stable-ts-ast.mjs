// Stable TypeScript AST parse + walk helpers for CI/security tooling.
//
// Decoupled from the TypeScript compiler API (which TS7 moved under
// `typescript/unstable/*`). Uses @babel/parser with the TypeScript plugin —
// a stable public surface with full TS syntax support and parent-linked trees
// for scope-aware analysis.

import { parse } from "@babel/parser";

const SKIP_KEYS = new Set([
  "parent",
  "loc",
  "range",
  "start",
  "end",
  "type",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
]);

/**
 * @param {string} source
 * @param {string} fileName
 */
function parseOptions(source, fileName) {
  const isJsx = fileName.endsWith(".tsx") || fileName.endsWith(".jsx");
  return {
    sourceType: /** @type {const} */ ("module"),
    sourceFilename: fileName,
    plugins: [
      "typescript",
      ...(isJsx ? /** @type {const} */ (["jsx"]) : []),
      ["decorators", { decoratorsBeforeExport: true }],
      "importAttributes",
      "explicitResourceManagement",
    ],
    // Match the TS compiler API's tolerance for incomplete probe fixtures used
    // by security regression suites (unclosed braces, partial snippets).
    errorRecovery: true,
    attachComment: true,
    ranges: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  };
}

/**
 * Parse TypeScript/JavaScript source into a Babel AST with parent links.
 *
 * On hard syntax failures (Babel is stricter than `ts.createSourceFile` about
 * unclosed braces), append closing braces so partial security fixtures still
 * yield an AST for the statements that parsed. Real shipped source must already
 * be syntactically valid; this only recovers incomplete probe snippets.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {import("@babel/types").File}
 */
export function parseTypeScript(source, fileName) {
  const options = parseOptions(source, fileName);
  let text = source;
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const ast = parse(text, options);
      attachParents(ast, null);
      return ast;
    } catch (error) {
      lastError = error;
      text = `${text}\n}`;
    }
  }
  throw lastError;
}

/**
 * @param {import("@babel/types").Node} node
 * @param {import("@babel/types").Node | null} parent
 */
function attachParents(node, parent) {
  // @ts-expect-error parent is attached for tooling walks
  node.parent = parent;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = /** @type {unknown} */ (node[/** @type {keyof typeof node} */ (key)]);
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) attachParents(child, node);
      }
    } else if (isAstNode(value)) {
      attachParents(value, node);
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is import("@babel/types").Node}
 */
export function isAstNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (/** @type {{ type?: unknown }} */ (value).type) === "string"
  );
}

/**
 * Visit direct AST children (Babel equivalent of ts.forEachChild).
 * @param {import("@babel/types").Node} node
 * @param {(child: import("@babel/types").Node) => void} callback
 */
export function forEachChild(node, callback) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = /** @type {unknown} */ (node[/** @type {keyof typeof node} */ (key)]);
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) callback(child);
      }
    } else if (isAstNode(value)) {
      callback(value);
    }
  }
}

/**
 * Depth-first walk of the entire subtree rooted at `node`.
 * @param {import("@babel/types").Node} node
 * @param {(node: import("@babel/types").Node) => void} visitor
 */
export function walk(node, visitor) {
  visitor(node);
  forEachChild(node, (child) => walk(child, visitor));
}

/**
 * 0-based line index of a node's start (mirrors ts getLineAndCharacterOfPosition).
 * @param {import("@babel/types").Node} node
 */
export function zeroBasedStartLine(node) {
  return (node.loc?.start.line ?? 1) - 1;
}

/**
 * `file:line:column` (1-based line and column) for diagnostics.
 * @param {string} fileName
 * @param {import("@babel/types").Node} node
 */
export function sourceLocation(fileName, node) {
  const line = node.loc?.start.line ?? 1;
  const column = (node.loc?.start.column ?? 0) + 1;
  return `${fileName}:${line}:${column}`;
}

/**
 * Source text covered by `node`.
 * @param {string} source
 * @param {import("@babel/types").Node} node
 */
export function nodeText(source, node) {
  if (typeof node.start === "number" && typeof node.end === "number") {
    return source.slice(node.start, node.end);
  }
  return "";
}

/**
 * Joined leading comment bodies attached to `node` (Babel strips // and /* *\/).
 * @param {import("@babel/types").Node} node
 */
export function leadingCommentText(node) {
  const comments = node.leadingComments ?? [];
  return comments.map((comment) => comment.value).join("\n");
}

/**
 * Identifier / string / numeric literal name text, if any.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {string | undefined}
 */
export function nameOf(node) {
  if (!node) return undefined;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  if (node.type === "PrivateName") return `#${node.id.name}`;
  return undefined;
}

/**
 * Ordinary or optional member expression (`obj.prop` / `obj?.prop` /
 * `obj[prop]` / `obj?.[prop]`). Babel splits optional chaining into
 * `OptionalMemberExpression`; TypeScript's AST did not, so every property
 * access check must accept both.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {node is import("@babel/types").MemberExpression | import("@babel/types").OptionalMemberExpression}
 */
export function isMemberExpression(node) {
  return node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression";
}

/**
 * Ordinary or optional call (`foo()` / `foo?.()` / `obj.foo?.()`). Babel uses
 * `OptionalCallExpression` for optional calls; treat both as calls everywhere
 * callees/args are analyzed.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {node is import("@babel/types").CallExpression | import("@babel/types").OptionalCallExpression}
 */
export function isCallExpression(node) {
  return node?.type === "CallExpression" || node?.type === "OptionalCallExpression";
}

/**
 * Callee / expression surface name for `foo`, `obj.foo`, or `obj?.foo`.
 * @param {import("@babel/types").Node | null | undefined} expression
 * @returns {string | undefined}
 */
export function callExpressionName(expression) {
  if (!expression) return undefined;
  if (expression.type === "Identifier") return expression.name;
  if (isStaticMember(expression) && expression.property.type === "Identifier") {
    return expression.property.name;
  }
  return undefined;
}

/**
 * Non-computed member expression: `obj.prop` / `obj?.prop` (not `obj[prop]`).
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {node is (import("@babel/types").MemberExpression | import("@babel/types").OptionalMemberExpression) & { computed: false }}
 */
export function isStaticMember(node) {
  return isMemberExpression(node) && !node.computed;
}

/**
 * Computed member expression: `obj[prop]` / `obj?.[prop]`.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {node is (import("@babel/types").MemberExpression | import("@babel/types").OptionalMemberExpression) & { computed: true }}
 */
export function isComputedMember(node) {
  return isMemberExpression(node) && node.computed;
}

/**
 * Identifier bound by a pattern node, unwrapping default bindings
 * (`AssignmentPattern`) so `{ role: r = "admin" }` and `{ role = "admin" }`
 * yield the bound name the same way the TypeScript API's binding element did.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {import("@babel/types").Identifier | null}
 */
export function bindingIdentifier(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node;
  if (node.type === "AssignmentPattern") return bindingIdentifier(node.left);
  return null;
}

/**
 * String value of a string literal or no-substitution template.
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {string | null}
 */
export function stringLiteralValue(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }
  // Babel represents `` `foo` `` as TemplateLiteral; some forms as StringLiteral.
  return null;
}

/**
 * Unwrap TS `as` / `satisfies` wrappers.
 * @param {import("@babel/types").Node | null | undefined} node
 */
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

/**
 * Collect import renames and variable aliases of `helperName`.
 * @param {import("@babel/types").Node} root
 * @param {string} helperName
 * @returns {Set<string>}
 */
export function permissionHelperAliases(root, helperName) {
  const aliases = new Set([helperName]);
  let changed = true;

  while (changed) {
    changed = false;

    /** @param {string | undefined} alias */
    function addAlias(alias) {
      if (alias !== undefined && !aliases.has(alias)) {
        aliases.add(alias);
        changed = true;
      }
    }

    walk(root, (node) => {
      if (node.type === "ImportSpecifier") {
        const imported = nameOf(node.imported);
        const local = nameOf(node.local);
        if (imported === helperName && local !== undefined && local !== helperName) {
          addAlias(local);
        }
      }
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init !== null &&
        node.init !== undefined
      ) {
        const initializerName = callExpressionName(node.init);
        if (initializerName !== undefined && aliases.has(initializerName)) {
          addAlias(node.id.name);
        }
      }
    });
  }

  return aliases;
}

/**
 * @param {import("@babel/types").Node} expression
 * @param {ReadonlySet<string>} aliases
 * @returns {string | undefined}
 */
export function permissionHelperCallName(expression, aliases) {
  const name = callExpressionName(expression);
  return name !== undefined && aliases.has(name) ? name : undefined;
}
