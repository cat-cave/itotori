import type { Node, ObjectExpression, Statement } from "@babel/types";
import {
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  nameOf,
  parseTypeScript,
  permissionHelperAliases,
  permissionHelperCallName,
  sourceLocation,
  walk,
} from "../../../scripts/stable-ts-ast.mjs";

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

type ParentNode = Node & { parent?: Node | null };

/**
 * Discover every mutating guarded API service call in `source` that is NOT
 * covered by a permission gate in the same innermost handler scope. An empty
 * array means every mutation is permission-covered.
 */
export function findUncoveredApiPermissionMutations(
  source: string,
  fileName: string,
): UncoveredApiMutation[] {
  const root = parseTypeScript(source, fileName);
  const apiPermissionGateAliases = permissionHelperAliases(root, API_PERMISSION_GATE_HELPER);
  const reviewerQueuePermissionViewAliases = permissionHelperAliases(
    root,
    API_REVIEWER_QUEUE_PERMISSION_VIEW_HELPER,
  );
  const uncovered: UncoveredApiMutation[] = [];

  walk(root, (node) => {
    // Optional service calls (`services.projectWorkflow?.importBridge(…)`) are
    // OptionalCallExpression in Babel — still mutations that need a gate.
    if (isCallExpression(node)) {
      const mutation = mutatingApiServiceMethod(node.callee);
      if (
        mutation !== undefined &&
        !isCoveredByApiPermission(
          node,
          mutation.surface,
          apiPermissionGateAliases,
          reviewerQueuePermissionViewAliases,
        )
      ) {
        uncovered.push({ ...mutation, location: sourceLocation(fileName, node) });
      }
    }
  });

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
 *
 * Static, optional, and literal-computed forms are equivalent:
 * `services.projectWorkflow.importBridge`,
 * `services?.projectWorkflow?.importBridge`,
 * `services?.projectWorkflow?.["importBridge"]`.
 * Dynamic (non-literal) computed keys stay conservative and are not matched.
 */
function mutatingApiServiceMethod(
  expression: Node,
): { surface: GuardedApiServiceSurface; method: string } | undefined {
  if (!isMemberExpression(expression) || !isMemberExpression(expression.object)) {
    return undefined;
  }

  const method = memberPropertyName(expression);
  const surface = memberPropertyName(expression.object);
  if (method === undefined || surface === undefined) {
    return undefined;
  }

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
  mutation: Node,
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
    isCallExpression(mutation) &&
    callReceivesResolvedPermissionView(mutation, resolvedPermissionViews)
  );
}

/**
 * Walk up from `node` to the first ancestor that owns a statement list (block,
 * case/default clause, source file, module block) and return that list plus the
 * index of the statement on the path to `node`.
 */
function enclosingStatementList(
  node: Node,
): { list: readonly Statement[]; index: number } | undefined {
  let child: ParentNode = node as ParentNode;
  let parent: ParentNode | null | undefined = child.parent;
  while (parent !== undefined && parent !== null) {
    const statements = statementListOf(parent);
    if (statements !== undefined) {
      const index = statements.indexOf(child as Statement);
      if (index >= 0) {
        return { list: statements, index };
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return undefined;
}

function statementListOf(node: Node): readonly Statement[] | undefined {
  if (node.type === "BlockStatement" || node.type === "Program" || node.type === "TSModuleBlock") {
    return node.body as readonly Statement[];
  }
  if (node.type === "SwitchCase") {
    return node.consequent;
  }
  return undefined;
}

function containsPermissionHelperCall(node: Node, aliases: ReadonlySet<string>): boolean {
  let found = false;
  walk(node, (current) => {
    if (found) {
      return;
    }
    if (
      isCallExpression(current) &&
      permissionHelperCallName(current.callee, aliases) !== undefined
    ) {
      found = true;
    }
  });
  return found;
}

function addResolvedPermissionViewDeclarations(
  node: Node,
  reviewerQueuePermissionViewAliases: ReadonlySet<string>,
  resolvedPermissionViews: Set<string>,
): void {
  walk(node, (current) => {
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier" &&
      current.init !== null &&
      current.init !== undefined &&
      containsPermissionHelperCall(current.init, reviewerQueuePermissionViewAliases)
    ) {
      resolvedPermissionViews.add(current.id.name);
    }
  });
}

function callReceivesResolvedPermissionView(
  call: Node,
  resolvedPermissionViews: ReadonlySet<string>,
): boolean {
  if (!isCallExpression(call)) {
    return false;
  }
  return call.arguments.some((argument) =>
    objectLiteralReceivesResolvedPermissionView(argument, resolvedPermissionViews),
  );
}

function objectLiteralReceivesResolvedPermissionView(
  node: Node,
  resolvedPermissionViews: ReadonlySet<string>,
): boolean {
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression"
  ) {
    return objectLiteralReceivesResolvedPermissionView(node.expression, resolvedPermissionViews);
  }
  if (node.type !== "ObjectExpression") {
    return false;
  }
  return objectExpressionReceivesResolvedPermissionView(node, resolvedPermissionViews);
}

function objectExpressionReceivesResolvedPermissionView(
  node: ObjectExpression,
  resolvedPermissionViews: ReadonlySet<string>,
): boolean {
  for (const property of node.properties) {
    if (
      property.type === "ObjectProperty" &&
      property.shorthand &&
      property.key.type === "Identifier"
    ) {
      if (resolvedPermissionViews.has(property.key.name)) {
        return true;
      }
    }
    if (
      property.type === "ObjectProperty" &&
      propertyNameText(property.key) === "permission" &&
      property.value.type === "Identifier" &&
      resolvedPermissionViews.has(property.value.name)
    ) {
      return true;
    }
  }
  return false;
}

function propertyNameText(name: Node): string | undefined {
  return nameOf(name);
}
