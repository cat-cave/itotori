// Default source-Wiki roster selection.
//
// The whole-game source Wiki is built by the ANALYST castings of the roster —
// A1 through A10. The default selection is the FULL analyst set: production does
// not narrow it. A caller may pass an explicit subset, but every id in it must
// be an analyst role the roster owns; a localizer or reviewer id, or an unknown
// id, is rejected loud. The selection is returned in canonical role order so the
// plan is deterministic.

import { ROLE_ID_UNIVERSE, ROSTER, specialistFor, type Specialist } from "../roster/index.js";
import { RoleIdSchema, type RoleId, type RunModeValue } from "../contracts/index.js";

/** The analyst roles, in canonical order — the full source-Wiki roster. Derived
 * from the roster manifest (the shape a role is cast onto), never hand-listed. */
export const ANALYST_ROLE_IDS: readonly RoleId[] = Object.freeze(
  ROLE_ID_UNIVERSE.filter((roleId) => ROSTER[roleId].shape === "analyst"),
);

/** The complete context roster. Source-Wiki context is authored by the analyst
 * castings only: A1 through A10. P/Q roles consume that context later; they do
 * not make a source-context selection larger. */
export const FULL_CONTEXT_ROSTER: readonly RoleId[] = ANALYST_ROLE_IDS;

/** A role selection that is not an analyst casting, or is not a real role. */
export class SourceWikiSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceWikiSelectionError";
  }
}

/** True only when a selection names every analyst casting exactly once, with no
 * non-analyst or duplicate role hidden in it. */
export function contextRosterIsFull(selection: readonly RoleId[]): boolean {
  if (selection.length !== FULL_CONTEXT_ROSTER.length) return false;
  const selected = new Set<RoleId>();
  for (const candidate of selection) {
    const parsed = RoleIdSchema.safeParse(candidate);
    if (!parsed.success || !ANALYST_ROLE_IDS.includes(parsed.data)) return false;
    selected.add(parsed.data);
  }
  return (
    selected.size === FULL_CONTEXT_ROSTER.length &&
    FULL_CONTEXT_ROSTER.every((roleId) => selected.has(roleId))
  );
}

/** Production and pilot source context is never a selective analyst run. This
 * guard lives at the source-Wiki executor boundary as well as the run-policy
 * resolver, so a caller cannot validate one roster then execute another. */
export function assertContextRosterForRunMode(
  runMode: RunModeValue,
  selection: readonly RoleId[],
): void {
  if ((runMode === "production" || runMode === "pilot") && !contextRosterIsFull(selection)) {
    throw new SourceWikiSelectionError(
      `run mode '${runMode}' requires the full context roster (all A1-A10); a partial analyst selection is rejected`,
    );
  }
}

/**
 * Resolve the analyst specialists to run. With no argument the selection is the
 * WHOLE analyst set (A1-A10) — the production default. An explicit selection is
 * validated: each id must parse as a role and must be an analyst casting, or the
 * call throws. The result is de-duplicated and returned in canonical order.
 */
export function selectSourceWikiRoles(selection?: readonly RoleId[]): readonly Specialist[] {
  if (selection === undefined) {
    return Object.freeze(ANALYST_ROLE_IDS.map((roleId) => specialistFor(roleId)));
  }
  const requested = new Set<RoleId>();
  for (const raw of selection) {
    const parsed = RoleIdSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SourceWikiSelectionError(`unknown role in source-Wiki selection: ${String(raw)}`);
    }
    const specialist = specialistFor(parsed.data);
    if (specialist.shape !== "analyst") {
      throw new SourceWikiSelectionError(
        `role ${parsed.data} is a ${specialist.shape}, not an analyst — the source Wiki runs analyst roles only`,
      );
    }
    requested.add(parsed.data);
  }
  if (requested.size === 0) {
    throw new SourceWikiSelectionError("source-Wiki selection is empty");
  }
  return Object.freeze(
    ANALYST_ROLE_IDS.filter((roleId) => requested.has(roleId)).map((roleId) =>
      specialistFor(roleId),
    ),
  );
}
