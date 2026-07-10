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
 * Property name of a member expression when the key is STATICALLY known:
 * - static: `obj.prop` / `obj?.prop` → `"prop"`
 * - literal-computed: `obj["prop"]` / `obj?.["prop"]` / `obj[1]` → `"prop"` / `"1"`
 * - no-substitution template: `obj?.[`prop`]` → `"prop"`
 *
 * DYNAMIC (non-literal) computed keys return `undefined` — callers must stay
 * conservative and not over-flag unknown keys. Prefer this over branching on
 * `computed` + `property.type` at every call site.
 *
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {string | undefined}
 */
export function memberPropertyName(node) {
  if (!isMemberExpression(node)) return undefined;
  if (!node.computed) {
    return nameOf(node.property);
  }
  return literalKeyName(node.property);
}

/**
 * Known key text from a property / pattern key / computed index when it is a
 * string, number, or no-substitution template literal. Dynamic expressions
 * return undefined.
 *
 * @param {import("@babel/types").Node | null | undefined} node
 * @returns {string | undefined}
 */
export function literalKeyName(node) {
  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Identifier" || unwrapped.type === "JSXIdentifier") {
    // Non-computed property keys are Identifiers; computed keys that are bare
    // identifiers are DYNAMIC (variable index) — not a known literal key.
    // Callers that want static property keys use memberPropertyName (which only
    // routes Identifiers through nameOf when computed:false).
    return undefined;
  }
  if (unwrapped.type === "StringLiteral" || unwrapped.type === "NumericLiteral") {
    return String(unwrapped.value);
  }
  if (unwrapped.type === "TemplateLiteral" && unwrapped.expressions.length === 0) {
    return unwrapped.quasis[0]?.value.cooked ?? unwrapped.quasis[0]?.value.raw ?? undefined;
  }
  return nameOf(unwrapped);
}

/**
 * Key name of an ObjectProperty / ObjectMethod key (static Identifier or
 * literal-computed StringLiteral / NumericLiteral).
 *
 * @param {import("@babel/types").Node | null | undefined} key
 * @param {boolean} [computed]
 * @returns {string | undefined}
 */
export function objectPropertyKeyName(key, computed = false) {
  if (!key) return undefined;
  if (!computed) {
    return nameOf(key) ?? stringLiteralValue(key) ?? undefined;
  }
  return literalKeyName(key);
}

/**
 * Callee / expression surface name for `foo`, `obj.foo`, `obj?.foo`,
 * `obj["foo"]`, `obj?.["foo"]`. Dynamic computed keys return undefined.
 *
 * When `includeComputedMember` is false (coverage-guard conservatism matching
 * the pre-Babel TypeScript walk), only Identifier and static `.prop` / `?.prop`
 * members resolve — literal-computed `obj["prop"]` returns undefined.
 *
 * @param {import("@babel/types").Node | null | undefined} expression
 * @param {{ includeComputedMember?: boolean }} [options]
 * @returns {string | undefined}
 */
export function callExpressionName(expression, options = {}) {
  const includeComputedMember = options.includeComputedMember !== false;
  const unwrapped = unwrapTsTypeAssertions(expression);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Identifier") return unwrapped.name;
  if (!includeComputedMember && isMemberExpression(unwrapped) && unwrapped.computed) {
    return undefined;
  }
  return memberPropertyName(unwrapped);
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
  const unwrapped = unwrapTsTypeAssertions(node);
  if (!unwrapped) return null;
  if (unwrapped.type === "StringLiteral") return unwrapped.value;
  if (unwrapped.type === "TemplateLiteral" && unwrapped.expressions.length === 0) {
    return unwrapped.quasis[0]?.value.cooked ?? unwrapped.quasis[0]?.value.raw ?? null;
  }
  // Babel represents `` `foo` `` as TemplateLiteral; some forms as StringLiteral.
  return null;
}

/**
 * Unwrap TS `as` / `satisfies` wrappers and parentheses.
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
 * Walk a binding pattern (ObjectPattern / ArrayPattern / AssignmentPattern /
 * RestElement / Identifier) and invoke `onBinding` for every bound Identifier.
 * Used by permission-helper alias collection so destructured renames are not
 * dropped.
 *
 * @param {import("@babel/types").Node | null | undefined} pattern
 * @param {(binding: import("@babel/types").Identifier, keyName: string | undefined, patternNode: import("@babel/types").Node) => void} onBinding
 * @param {string | undefined} [parentKeyName]
 */
export function forEachPatternBinding(pattern, onBinding, parentKeyName = undefined) {
  if (!pattern) return;
  if (pattern.type === "AssignmentPattern") {
    forEachPatternBinding(pattern.left, onBinding, parentKeyName);
    return;
  }
  if (pattern.type === "RestElement") {
    forEachPatternBinding(pattern.argument, onBinding, parentKeyName);
    return;
  }
  if (pattern.type === "Identifier") {
    onBinding(pattern, parentKeyName, pattern);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "RestElement") {
        forEachPatternBinding(property.argument, onBinding, parentKeyName);
        continue;
      }
      if (property.type !== "ObjectProperty") continue;
      const keyName = objectPropertyKeyName(property.key, property.computed);
      // Nested pattern or binding under this key.
      forEachPatternBinding(property.value, onBinding, keyName);
    }
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element === null) continue;
      forEachPatternBinding(element, onBinding, parentKeyName);
    }
  }
}

/**
 * Collect import renames and variable aliases of `helperName`, including
 * destructured/object/array/default patterns and literal-computed member
 * access (`authorization?.["requirePermission"]`).
 *
 * Options (defaults are the wide role-guard behavior):
 * - `includeDestructureAliases` (default true): collect renamed destructure
 *   bindings such as `{ requireApiPermission: gate }`. Set false for the
 *   mutation-coverage guard so adversarial fake-helper renames stay uncovered
 *   (matches the pre-Babel TypeScript walk, which only tracked import renames
 *   and simple `const alias = helper` assignments).
 * - `includeComputedMember` (default true): treat literal-computed member
 *   access (`obj["requireApiPermission"]`) as an alias source / helper name.
 *   Set false for coverage-guard conservatism.
 *
 * @param {import("@babel/types").Node} root
 * @param {string} helperName
 * @param {{ includeDestructureAliases?: boolean, includeComputedMember?: boolean }} [options]
 * @returns {Set<string>}
 */
export function permissionHelperAliases(root, helperName, options = {}) {
  const includeDestructureAliases = options.includeDestructureAliases !== false;
  const includeComputedMember = options.includeComputedMember !== false;
  const nameOpts = { includeComputedMember };
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

    /**
     * If `init` resolves to a known helper name (identifier or member ending
     * in that name, static or — when enabled — literal-computed), return it.
     * @param {import("@babel/types").Node | null | undefined} init
     */
    function helperNameFromInit(init) {
      const name = callExpressionName(init, nameOpts);
      return name !== undefined && aliases.has(name) ? name : undefined;
    }

    /**
     * @param {import("@babel/types").Node | null | undefined} pattern
     * @param {import("@babel/types").Node | null | undefined} init
     */
    function collectFromPattern(pattern, init) {
      if (!pattern) return;

      if (pattern.type === "AssignmentPattern") {
        collectFromPattern(pattern.left, init);
        return;
      }

      if (pattern.type === "Identifier") {
        if (helperNameFromInit(init) !== undefined) {
          addAlias(pattern.name);
        }
        return;
      }

      // Coverage-conservative path: skip object/array destructure alias
      // collection so `{ requireApiPermission: gate }` does not make `gate`
      // count as a real permission gate. Non-renamed
      // `const { requireApiPermission } = services` still works because the
      // seed set already contains the helper name.
      if (!includeDestructureAliases) {
        return;
      }

      if (pattern.type === "ObjectPattern") {
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            collectFromPattern(property.argument, init);
            continue;
          }
          if (property.type !== "ObjectProperty") continue;
          const keyName = objectPropertyKeyName(property.key, property.computed);
          // `{ requirePermission: check }` / `{ requirePermission: check = requirePermission }`
          // — key is the helper (or alias), value is the bound local name.
          if (keyName !== undefined && aliases.has(keyName)) {
            const binding = bindingIdentifier(property.value);
            if (binding !== null) addAlias(binding.name);
          }
          // Nested patterns continue under the same object init.
          if (
            property.value.type === "ObjectPattern" ||
            property.value.type === "ArrayPattern" ||
            property.value.type === "AssignmentPattern"
          ) {
            collectFromPattern(property.value, init);
          }
        }
        return;
      }

      if (pattern.type === "ArrayPattern") {
        const initUnwrapped = unwrapTsTypeAssertions(init);
        if (initUnwrapped?.type === "ArrayExpression") {
          for (let index = 0; index < pattern.elements.length; index += 1) {
            const element = pattern.elements[index];
            if (element === null) continue;
            const elementInit = initUnwrapped.elements[index] ?? null;
            collectFromPattern(element, elementInit);
          }
        } else {
          // Unknown array init — still walk for nested object patterns with
          // helper-named keys (e.g. `[{ requirePermission: check }]`).
          for (const element of pattern.elements) {
            if (element === null) continue;
            collectFromPattern(element, null);
          }
        }
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

      if (node.type === "VariableDeclarator" && node.init !== null && node.init !== undefined) {
        collectFromPattern(node.id, node.init);
      }

      // Destructuring assignment: `({ requirePermission: check } = authorization)`
      if (node.type === "AssignmentExpression") {
        collectFromPattern(node.left, node.right);
      }
    });
  }

  return aliases;
}

/**
 * @param {import("@babel/types").Node} expression
 * @param {ReadonlySet<string>} aliases
 * @param {{ includeComputedMember?: boolean }} [options]
 * @returns {string | undefined}
 */
export function permissionHelperCallName(expression, aliases, options = {}) {
  const name = callExpressionName(expression, options);
  return name !== undefined && aliases.has(name) ? name : undefined;
}
