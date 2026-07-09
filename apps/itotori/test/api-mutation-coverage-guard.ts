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
 * shape. It walks the entire module AST, finds every call to a mutating API
 * service port method (fail-closed: anything not on a read-only denylist counts
 * as a mutation), and requires that each such call be covered by the API
 * permission mechanism for that port inside the SAME innermost handler scope
 * (block / case clause / arrow body). A mutation without such a gate is
 * reported as uncovered regardless of how the route was dispatched.
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

export const READ_ONLY_REVIEWER_QUEUE_METHODS: ReadonlySet<string> = new Set([
  "loadDashboard",
  "loadDetailContext",
]);

export const READ_ONLY_WORKSPACE_CORRECTIONS_METHODS: ReadonlySet<string> = new Set([
  "loadPreview",
]);

export const READ_ONLY_ASSET_DECISIONS_METHODS: ReadonlySet<string> = new Set([
  "loadActiveDecisions",
  "loadCandidateAssets",
]);

/**
 * Name of the helper every route MUST call to gate a mutation. A mutation is
 * "covered" iff a call to this helper precedes it in the same handler scope.
 */
export const API_PERMISSION_GATE_HELPER = "requireApiPermission";
export const API_REVIEWER_QUEUE_PERMISSION_VIEW_HELPER = "resolveApiReviewerQueuePermissionView";

type GuardedApiServiceSurface =
  | "projectWorkflow"
  | "reviewerQueue"
  | "workspaceCorrections"
  | "assetDecisions";

export type UncoveredApiMutation = {
  /** The API service surface reached without a covering permission gate. */
  surface: GuardedApiServiceSurface;
  /** The mutating service method reached without a covering permission gate. */
  method: string;
  /** `file:line:column` of the uncovered mutation call. */
  location: string;
};

/**
 * Discover every mutating guarded API service call in `source` that is NOT
 * covered by a permission gate in the same innermost handler scope. An empty
 * array means every mutation is permission-covered.
 */
export function findUncoveredApiPermissionMutations(
  source: string,
  fileName: string,
): UncoveredApiMutation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const apiPermissionGateAliases = permissionHelperAliases(sourceFile, API_PERMISSION_GATE_HELPER);
  const reviewerQueuePermissionViewAliases = permissionHelperAliases(
    sourceFile,
    API_REVIEWER_QUEUE_PERMISSION_VIEW_HELPER,
  );
  const uncovered: UncoveredApiMutation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const mutation = mutatingApiServiceMethod(node.expression);
      if (
        mutation !== undefined &&
        !isCoveredByApiPermission(
          node,
          mutation.surface,
          apiPermissionGateAliases,
          reviewerQueuePermissionViewAliases,
        )
      ) {
        uncovered.push({ ...mutation, location: sourceLocation(sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return uncovered;
}

/**
 * Backwards-compatible name used by the original SHARED-026 tests. The guard
 * now covers every API mutation port listed above, not only projectWorkflow.
 */
export function findUncoveredProjectWorkflowMutations(
  source: string,
  fileName: string,
): UncoveredApiMutation[] {
  return findUncoveredApiPermissionMutations(source, fileName);
}

/**
 * Returns the service surface and method if `expression` is a guarded
 * `*.<surface>.<method>` access whose method is a mutation (not on the
 * read-only denylist), else undefined. The receiver identifier is NOT
 * constrained to `services`, so a route-table handler using a differently-named
 * parameter is still caught.
 */
function mutatingApiServiceMethod(
  expression: ts.Expression,
): { surface: GuardedApiServiceSurface; method: string } | undefined {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression)
  ) {
    return undefined;
  }

  const surface = expression.expression.name.text;
  const method = expression.name.text;
  switch (surface) {
    case "projectWorkflow":
      return READ_ONLY_PROJECT_WORKFLOW_METHODS.has(method) ? undefined : { surface, method };
    case "reviewerQueue":
      return READ_ONLY_REVIEWER_QUEUE_METHODS.has(method) ? undefined : { surface, method };
    case "workspaceCorrections":
      return READ_ONLY_WORKSPACE_CORRECTIONS_METHODS.has(method) ? undefined : { surface, method };
    case "assetDecisions":
      return READ_ONLY_ASSET_DECISIONS_METHODS.has(method) ? undefined : { surface, method };
    default:
      return undefined;
  }
}

/**
 * A mutation is covered iff its enclosing statement list either contains an
 * earlier `requireApiPermission` call or the mutation call receives a
 * `permission` value that was resolved earlier in that same scope by
 * `resolveApiReviewerQueuePermissionView`. Coverage is checked in the
 * INNERMOST handler scope only (the block / case clause / arrow body that
 * directly holds the mutation statement); a gate belonging to a sibling route
 * handler never counts.
 */
function isCoveredByApiPermission(
  mutation: ts.Node,
  surface: GuardedApiServiceSurface,
  apiPermissionGateAliases: ReadonlySet<string>,
  reviewerQueuePermissionViewAliases: ReadonlySet<string>,
): boolean {
  const enclosing = enclosingStatementList(mutation);
  if (enclosing === undefined) {
    return false;
  }
  const resolvedPermissionViews = new Set<string>();
  for (let index = 0; index < enclosing.index; index += 1) {
    const statement = enclosing.list[index]!;
    if (containsPermissionHelperCall(statement, apiPermissionGateAliases)) {
      return true;
    }
    addResolvedPermissionViewDeclarations(
      statement,
      reviewerQueuePermissionViewAliases,
      resolvedPermissionViews,
    );
  }
  if (surface !== "reviewerQueue" && surface !== "workspaceCorrections") {
    return false;
  }
  return (
    ts.isCallExpression(mutation) &&
    callReceivesResolvedPermissionView(mutation, resolvedPermissionViews)
  );
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

function containsPermissionHelperCall(
  node: ts.Node,
  aliases: ReadonlySet<string>,
): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(current) &&
      permissionHelperCallName(current.expression, aliases) !== undefined
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function addResolvedPermissionViewDeclarations(
  node: ts.Node,
  reviewerQueuePermissionViewAliases: ReadonlySet<string>,
  resolvedPermissionViews: Set<string>,
): void {
  function visit(current: ts.Node): void {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      containsPermissionHelperCall(current.initializer, reviewerQueuePermissionViewAliases)
    ) {
      resolvedPermissionViews.add(current.name.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
}

function callReceivesResolvedPermissionView(
  call: ts.CallExpression,
  resolvedPermissionViews: ReadonlySet<string>,
): boolean {
  return call.arguments.some((argument) =>
    objectLiteralReceivesResolvedPermissionView(argument, resolvedPermissionViews),
  );
}

function objectLiteralReceivesResolvedPermissionView(
  node: ts.Node,
  resolvedPermissionViews: ReadonlySet<string>,
): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return objectLiteralReceivesResolvedPermissionView(node.expression, resolvedPermissionViews);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }
  for (const property of node.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      resolvedPermissionViews.has(property.name.text)
    ) {
      return true;
    }
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "permission" &&
      ts.isIdentifier(property.initializer) &&
      resolvedPermissionViews.has(property.initializer.text)
    ) {
      return true;
    }
  }
  return false;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
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

function permissionHelperCallName(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): string | undefined {
  const name = callExpressionName(expression);
  return name !== undefined && aliases.has(name) ? name : undefined;
}

function permissionHelperAliases(sourceFile: ts.SourceFile, helperName: string): Set<string> {
  const aliases = new Set([helperName]);
  let changed = true;

  while (changed) {
    changed = false;

    function addAlias(alias: string | undefined): void {
      if (alias !== undefined && !aliases.has(alias)) {
        aliases.add(alias);
        changed = true;
      }
    }

    function visit(node: ts.Node): void {
      if (
        ts.isImportSpecifier(node) &&
        node.propertyName?.text === helperName &&
        node.name.text !== helperName
      ) {
        addAlias(node.name.text);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializerName = callExpressionName(node.initializer);
        if (initializerName !== undefined && aliases.has(initializerName)) {
          addAlias(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return aliases;
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}
