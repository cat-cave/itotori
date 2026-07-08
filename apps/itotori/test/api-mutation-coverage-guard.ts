import * as ts from "typescript";

/**
 * SHARED-026 — shape-robust API mutation-permission coverage guard.
 *
 * The legacy discovery in `api-handlers.test.ts` (`sourceApiMutationRoutes`)
 * only walks the DIRECT statements of `routeItotoriApiRequest` and only
 * recognises two routing shapes: a top-level `if (request.method === "POST"
 * && request.pathname === <literal>)` and the single `switch
 * (projectRoute.resource)`. A new mutating route added through ANY other form
 * — a route-table entry, a `switch` on a different discriminant, or a
 * helper-predicate `if (request.method === "POST" && parsed !== null)` — is
 * invisible to that scan, so it can reach a `services.projectWorkflow.*`
 * mutation with NO `requireApiPermission` gate and the guard stays green.
 *
 * This guard is shape-INDEPENDENT: it keys on the MUTATION, not the routing
 * shape. It walks the entire module AST, finds every call to a mutating
 * `*.projectWorkflow.<method>()` (fail-closed: anything not on the read-only
 * denylist counts as a mutation), and requires that each such call be covered
 * by a `requireApiPermission(...)` gate that lexically precedes it inside the
 * SAME innermost handler scope (block / case clause / arrow body). A mutation
 * without such a preceding gate is reported as uncovered regardless of how the
 * route was dispatched.
 */

/**
 * Read-only `projectWorkflow` methods. Anything NOT listed here is treated as a
 * mutation (fail-closed), so a newly-added mutating method is caught by default
 * rather than silently skipped.
 */
export const READ_ONLY_PROJECT_WORKFLOW_METHODS: ReadonlySet<string> = new Set([
  // ITOTORI-050 — the server-side project/branch ownership lookup consumed by
  // the mutation scoping policy. A read, never a mutation.
  "listLocaleBranchIdentities",
  "getDashboardStatus",
  "getProjectOverview",
  "getDashboardDecisions",
  "getRuntimeStatus",
  "getCostReport",
  "getCostDrilldown",
  "getBenchmarkReports",
]);

/**
 * Name of the helper every route MUST call to gate a mutation. A mutation is
 * "covered" iff a call to this helper precedes it in the same handler scope.
 */
export const API_PERMISSION_GATE_HELPER = "requireApiPermission";

export type UncoveredApiMutation = {
  /** The mutating `projectWorkflow` method reached without a preceding gate. */
  method: string;
  /** `file:line:column` of the uncovered mutation call. */
  location: string;
};

/**
 * Discover every mutating `projectWorkflow` call in `source` that is NOT gated
 * by a preceding `requireApiPermission(...)` in the same innermost handler
 * scope. An empty array means every mutation is permission-covered.
 */
export function findUncoveredProjectWorkflowMutations(
  source: string,
  fileName: string,
): UncoveredApiMutation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const uncovered: UncoveredApiMutation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const method = mutatingProjectWorkflowMethod(node.expression);
      if (method !== undefined && !isCoveredByPrecedingGate(node)) {
        uncovered.push({ method, location: sourceLocation(sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return uncovered;
}

/**
 * Returns the method name if `expression` is a `*.projectWorkflow.<method>`
 * access whose method is a mutation (not on the read-only denylist), else
 * undefined. The receiver identifier is NOT constrained to `services`, so a
 * route-table handler using a differently-named parameter is still caught.
 */
function mutatingProjectWorkflowMethod(expression: ts.Expression): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "projectWorkflow" &&
    !READ_ONLY_PROJECT_WORKFLOW_METHODS.has(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

/**
 * A mutation is covered iff its enclosing statement list contains an earlier
 * statement whose subtree calls `requireApiPermission`. Coverage is checked in
 * the INNERMOST handler scope only (the block / case clause / arrow body that
 * directly holds the mutation statement); a gate belonging to a sibling route
 * handler never counts.
 */
function isCoveredByPrecedingGate(mutation: ts.Node): boolean {
  const enclosing = enclosingStatementList(mutation);
  if (enclosing === undefined) {
    return false;
  }
  for (let index = 0; index < enclosing.index; index += 1) {
    if (containsApiPermissionGateCall(enclosing.list[index]!)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk up from `node` to the first ancestor that owns a statement list (block,
 * case/default clause, source file, module block) and return that list plus the
 * index of the statement on the path to `node`.
 */
function enclosingStatementList(
  node: ts.Node,
): { list: readonly ts.Statement[]; index: number } | undefined {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    const statements = statementListOf(parent);
    if (statements !== undefined) {
      const index = statements.indexOf(child as ts.Statement);
      if (index >= 0) {
        return { list: statements, index };
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return undefined;
}

function statementListOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    return node.statements;
  }
  return undefined;
}

function containsApiPermissionGateCall(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(current) &&
      callExpressionName(current.expression) === API_PERMISSION_GATE_HELPER
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function callExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}
