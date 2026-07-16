// Dependency ordering of the analyst roles into topological phases.
//
// The order is DERIVED from the roster manifest's DAG positions, not hand-coded:
// each role declares its upstream roles, and this builds the topological LEVELS
// over the selected set (a role's level is one past the deepest selected
// upstream). Roles at the same level are mutually independent and run together;
// a later level never starts until the earlier level's evidence exists. This is
// exactly the guarantee that A4/A9/A5 wait on A3/A7/A8: A4 upstream A3, A9
// upstream A4/A8, A5 upstream A3/A4/A8/A9, so they land on strictly later levels.

import { ROLE_ID_UNIVERSE } from "../roster/index.js";
import type { RoleId } from "../contracts/index.js";
import type { Specialist } from "../roster/index.js";

/** A cycle in the selected roles' dependency graph — a manifest defect. */
export class SourceWikiOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceWikiOrderingError";
  }
}

const CANONICAL_INDEX: ReadonlyMap<RoleId, number> = new Map(
  ROLE_ID_UNIVERSE.map((roleId, index) => [roleId, index] as const),
);

function canonicalSort(roles: readonly RoleId[]): RoleId[] {
  return [...roles].sort(
    (left, right) => (CANONICAL_INDEX.get(left) ?? 0) - (CANONICAL_INDEX.get(right) ?? 0),
  );
}

/**
 * Order the selected analyst specialists into dependency LEVELS. Each returned
 * inner array is one level: the roles whose selected upstream all resolved on an
 * earlier level, in canonical order. A dependency cycle throws.
 */
export function orderAnalystLevels(specialists: readonly Specialist[]): RoleId[][] {
  const selected = new Set<RoleId>(specialists.map((s) => s.roleId));
  const upstream = new Map<RoleId, readonly RoleId[]>();
  for (const specialist of specialists) {
    // Only upstream roles that are ALSO in the selection gate this run.
    upstream.set(
      specialist.roleId,
      specialist.dagPosition.upstream.filter((roleId) => selected.has(roleId)),
    );
  }

  const level = new Map<RoleId, number>();
  const levels: RoleId[][] = [];
  let remaining = [...selected];
  while (remaining.length > 0) {
    const ready = remaining.filter((roleId) =>
      (upstream.get(roleId) ?? []).every((up) => level.has(up)),
    );
    if (ready.length === 0) {
      throw new SourceWikiOrderingError(
        `analyst dependency cycle among roles: ${canonicalSort(remaining).join(", ")}`,
      );
    }
    const depth = levels.length;
    for (const roleId of ready) level.set(roleId, depth);
    levels.push(canonicalSort(ready));
    const readySet = new Set(ready);
    remaining = remaining.filter((roleId) => !readySet.has(roleId));
  }
  return levels;
}
