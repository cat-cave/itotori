// Default source-Wiki roster selection.
//
// The whole-game source Wiki is built by the ANALYST castings of the roster —
// A1 through A10. The default selection is the FULL analyst set: production does
// not narrow it. A caller may pass an explicit subset, but every id in it must
// be an analyst role the roster owns; a localizer or reviewer id, or an unknown
// id, is rejected loud. The selection is returned in canonical role order so the
// plan is deterministic.

import { ROLE_ID_UNIVERSE, ROSTER, specialistFor, type Specialist } from "../roster/index.js";
import { RoleIdSchema, type RoleId } from "../contracts/index.js";

/** The analyst roles, in canonical order — the full source-Wiki roster. Derived
 * from the roster manifest (the shape a role is cast onto), never hand-listed. */
export const ANALYST_ROLE_IDS: readonly RoleId[] = Object.freeze(
  ROLE_ID_UNIVERSE.filter((roleId) => ROSTER[roleId].shape === "analyst"),
);

/** A role selection that is not an analyst casting, or is not a real role. */
export class SourceWikiSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceWikiSelectionError";
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
