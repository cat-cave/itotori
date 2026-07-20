// The run-mode policy, MODELLED AS DATA — a permission-set table, not scattered
// mode conditionals. Each run mode is one row of booleans stating what that mode
// REQUIRES and PERMITS. `resolve.ts` reads this table; it never branches on a
// mode name to decide a requirement. Adding or changing a rule is a data edit
// here, in one place, and every legality decision follows from it.
//
// The rows encode the acceptance clauses directly:
//   - production and pilot REQUIRE whole-game context + the full roster +
//     wiki-first bible, and they MAY finalize a shippable artifact; they differ
//     on no requirement here — only the free output-scope axis distinguishes a
//     production run from a pilot run;
//   - test-dev is the only mode that PERMITS a narrowed context and the ablation
//     selector, and it may NEVER finalize a shippable artifact.

import { FULL_CONTEXT_ROSTER, contextRosterIsFull } from "../source-wiki/roster-selection.js";
import type { RoleId, RunModeValue } from "../contracts/index.js";
import type { LocalizationPosture } from "../localized-wiki/index.js";

/** One run mode's requirements + permissions, as data. Every field is a hard
 * policy bit; `resolve.ts` reads them and rejects any request the row forbids. */
export interface ModeProfile {
  readonly runMode: RunModeValue;
  /** The run must stand on whole-game (or external-augmented) context. */
  readonly requiresWholeGameContext: boolean;
  /** The run must cast the entire roster — no partial selection. */
  readonly requiresFullRoster: boolean;
  /** The run must build on the wiki-first bible — no null-Wiki basis. */
  readonly requiresWikiFirstBible: boolean;
  /** The run may narrow context below whole-game. */
  readonly permitsNarrowedContext: boolean;
  /** The run may select the pure-MTL ablation (null Wiki / direct translation). */
  readonly permitsAblation: boolean;
  /** The run may finalize a shippable / released artifact. */
  readonly canFinalizeShippable: boolean;
}

// The permission-set table. Production and pilot are identical on every
// REQUIREMENT (both demand the full context stack and both may ship) — the only
// axis on which they differ is output scope, which is free for both and so is
// absent from this table. Test-dev is the quarantine mode: it alone relaxes the
// context/roster/bible requirements, and it alone can never ship.
const PROFILE_ROWS: readonly ModeProfile[] = Object.freeze([
  {
    runMode: "production",
    requiresWholeGameContext: true,
    requiresFullRoster: true,
    requiresWikiFirstBible: true,
    permitsNarrowedContext: false,
    permitsAblation: false,
    canFinalizeShippable: true,
  },
  {
    runMode: "pilot",
    requiresWholeGameContext: true,
    requiresFullRoster: true,
    requiresWikiFirstBible: true,
    permitsNarrowedContext: false,
    permitsAblation: false,
    canFinalizeShippable: true,
  },
  {
    runMode: "test-dev",
    requiresWholeGameContext: false,
    requiresFullRoster: false,
    requiresWikiFirstBible: false,
    permitsNarrowedContext: true,
    permitsAblation: true,
    canFinalizeShippable: false,
  },
]);

/** The mode-profile table keyed by run mode. Immutable. */
export const MODE_PROFILES: Readonly<Record<RunModeValue, ModeProfile>> = Object.freeze(
  Object.fromEntries(PROFILE_ROWS.map((profile) => [profile.runMode, profile])),
) as Readonly<Record<RunModeValue, ModeProfile>>;

/** The mode profile for a run mode, or throw for an unknown mode. */
export function profileFor(runMode: RunModeValue): ModeProfile {
  const profile = MODE_PROFILES[runMode];
  if (profile === undefined) {
    throw new Error(`no run-mode profile for '${String(runMode)}'`);
  }
  return profile;
}

// The bible posture each run mode maps onto — as data, not a conditional.
// Production / pilot map to their like-named bible postures; test-dev has NO
// canonical bible posture (it maps to `null`) — a narrowed test-dev run does a
// wiki-first build over its narrowed scope, and an ablation test-dev run maps to
// the `ablation` posture in `resolve.ts` via the ablation selector.
const POSTURE_ROWS: readonly (readonly [RunModeValue, LocalizationPosture | null])[] =
  Object.freeze([
    ["production", "production"],
    ["pilot", "pilot"],
    ["test-dev", null],
  ]);

/** The canonical bible posture for a run mode (before the ablation selector is
 * applied): production / pilot map to themselves, test-dev maps to `null`. */
export const BASE_POSTURE_BY_RUN_MODE: Readonly<Record<RunModeValue, LocalizationPosture | null>> =
  Object.freeze(Object.fromEntries(POSTURE_ROWS)) as Readonly<
    Record<RunModeValue, LocalizationPosture | null>
  >;

/** The full roster for this policy is the context roster: exactly the ten
 * source-Wiki analysts. P/Q roles are fixed workflow stages, not selectable
 * context castings. */
export function rosterIsFull(roster: readonly RoleId[]): boolean {
  return contextRosterIsFull(roster);
}

/** The canonical full context roster selection — all A1-A10, in canonical
 * order. Production and pilot require it. */
export const FULL_ROSTER: readonly RoleId[] = FULL_CONTEXT_ROSTER;
