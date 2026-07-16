// The localizer-profile posture + the no-bypass guarantee.
//
// The bible is built by the LOCALIZER castings of the roster — the write shape,
// not the analyst (read) shape. `localizerProfileRoles` surfaces those castings
// READ-ONLY so the pass adopts the localizer posture; it constructs nothing.
//
// The no-bypass guarantee lives here too: production and pilot MUST build the
// full bible, and the ONLY function that yields a collapsed (empty) bible is
// `bypassBibleForAblation`, which is gated to the explicit ablation posture. A
// production or pilot posture can never reach a bypass — the guard throws.

import { ROSTER_SPECIALISTS, type Specialist } from "../roster/index.js";
import type { LocalizationPosture } from "./types.js";

/** The write shape the bible pass runs under. */
export const LOCALIZER_PROFILE_SHAPE = "localizer" as const;

/** The postures that MUST build the full bible — production and pilot. */
export const FULL_BIBLE_POSTURES: readonly LocalizationPosture[] = Object.freeze([
  "production",
  "pilot",
]);

/** The localizer-shape specialists of the roster, in canonical order. The bible
 * pass adopts this posture; it reads the roster and casts nothing new. */
export function localizerProfileRoles(): readonly Specialist[] {
  return Object.freeze(
    ROSTER_SPECIALISTS.filter((specialist) => specialist.shape === LOCALIZER_PROFILE_SHAPE),
  );
}

/** Whether a posture is obligated to build the whole bible (production / pilot). */
export function mustBuildFullBible(posture: LocalizationPosture): boolean {
  return FULL_BIBLE_POSTURES.includes(posture);
}

/** An attempt to bypass or collapse the bible under a posture that forbids it. */
export class BibleBypassError extends Error {
  constructor(readonly posture: LocalizationPosture) {
    super(
      `posture '${posture}' must build the full bible — only the explicit ablation posture may bypass it`,
    );
    this.name = "BibleBypassError";
  }
}

/** The result of the one sanctioned bypass: a collapsed, empty bible under the
 * ablation posture (used by the ablation study only, never by production/pilot). */
export interface AblationBypass {
  readonly bypassed: true;
  readonly posture: "ablation";
}

/**
 * The ONLY path to a collapsed bible. It throws unless the posture is exactly
 * `ablation`; production and pilot are refused loud. There is no other function
 * anywhere that yields a bible without building it — so production/pilot have no
 * reachable bypass.
 */
export function bypassBibleForAblation(posture: LocalizationPosture): AblationBypass {
  if (posture !== "ablation") {
    throw new BibleBypassError(posture);
  }
  return { bypassed: true, posture };
}
