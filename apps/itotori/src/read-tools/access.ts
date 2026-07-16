// Access control for the strict local read-tool surface.
//
// Everything here is DATA, not role logic: a tool-to-roles allowlist table, and
// pure predicates for reveal-horizon and route visibility. A caller may read a
// fact only when its role is on the tool's allowlist, the fact is at or before
// the snapshot's reveal horizon, and the fact's route scope is visible to the
// caller's route. Explicit-id lookups of a hidden fact FAIL LOUD (a denial),
// never silently drop; range scans filter hidden facts out of the ordered set.

import type { LlmRevealHorizon } from "@itotori/db";

import type { RoleId, RouteScope, ToolName } from "../contracts/index.js";

/** The 19-role universe, as data. A tool granted to "all roles" lists these. */
export const ALL_ROLES: readonly RoleId[] = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
  "P1",
  "P2",
  "P3",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
];

const ANALYST_ROLES: readonly RoleId[] = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
];
const LOCALIZER_ROLES: readonly RoleId[] = ["P1", "P2", "P3"];
const REVIEWER_ROLES: readonly RoleId[] = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"];

/** Which role may call which read tool. Permission sets are DATA; a role that
 * is absent from a tool's set is denied that tool. */
export const TOOL_ROLE_ALLOWLIST: Readonly<Record<ToolName, readonly RoleId[]>> = {
  decode_get_units: ALL_ROLES,
  decode_get_neighbors: [...LOCALIZER_ROLES, "Q1"],
  decode_get_route_graph: ANALYST_ROLES,
  decode_get_character_occurrences: [...ANALYST_ROLES, "Q2"],
  glossary_lookup: [...LOCALIZER_ROLES, ...REVIEWER_ROLES],
  outputs_get_accepted: ALL_ROLES,
  references_search: [...ANALYST_ROLES, ...LOCALIZER_ROLES],
  // Egress-gated tools are never part of the local read surface allowlist.
  web_search: [],
  back_translate: [],
  render_and_ocr: [],
};

/** The caller's authorization envelope for a read-tool invocation. */
export interface ReadToolCaller {
  roleId: RoleId;
  /** The route(s) this caller is permitted to read. A `global` caller reads
   * every route; a `route`/`route-set` caller reads only global facts plus its
   * own route(s). */
  routeVisibility: RouteScope;
  /** Target locale branch the caller is bound to. Required for locale-scoped
   * tools (glossary_lookup, outputs_get_accepted); a mismatch is a denial. */
  localeBranchId: string | null;
}

export type ReadToolDenialCode =
  | "role-not-allowed"
  | "beyond-reveal-horizon"
  | "out-of-route"
  | "unknown-argument"
  | "invalid-argument"
  | "cursor-mismatch"
  | "row-exceeds-byte-budget"
  | "unknown-subject"
  | "locale-branch-mismatch"
  | "snapshot-integrity";

/** A loud, typed refusal. Every guarantee this surface enforces throws one of
 * these rather than returning a truncated or fabricated pseudo-result. */
export class ReadToolError extends Error {
  constructor(
    readonly code: ReadToolDenialCode,
    detail: string,
  ) {
    super(`read tool ${code}: ${detail}`);
    this.name = "ReadToolError";
  }
}

/** Assert the caller's role may call `tool`, or throw a denial. */
export function assertRoleAllowed(tool: ToolName, roleId: RoleId): void {
  if (!TOOL_ROLE_ALLOWLIST[tool].includes(roleId)) {
    throw new ReadToolError("role-not-allowed", `role ${roleId} may not call ${tool}`);
  }
}

/** True when a fact at `playOrderIndex` is at or before the reveal horizon. */
export function withinHorizon(playOrderIndex: number, horizon: LlmRevealHorizon): boolean {
  if (horizon.kind === "complete") return true;
  return playOrderIndex <= horizon.playOrderIndex;
}

/** The set of route ids a route scope names (empty for a global scope). */
function routeIdsOf(scope: RouteScope): readonly string[] {
  if (scope.kind === "global") return [];
  if (scope.kind === "route") return [scope.routeId];
  return scope.routeIds;
}

/** True when a fact scoped by `factScope` is visible to a caller whose route
 * visibility is `callerScope`. Global facts are always visible; a global caller
 * sees every route; otherwise the two route sets must intersect. */
export function routeScopeVisible(factScope: RouteScope, callerScope: RouteScope): boolean {
  if (factScope.kind === "global") return true;
  if (callerScope.kind === "global") return true;
  const callerRoutes = new Set(routeIdsOf(callerScope));
  return routeIdsOf(factScope).some((routeId) => callerRoutes.has(routeId));
}
