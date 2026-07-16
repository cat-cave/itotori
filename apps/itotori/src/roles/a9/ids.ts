// Stable, deterministic identifiers for A9's emitted objects.
//
// Every id is a pure function of the (character, route) pair it is about (and,
// for a shift, its ordinal), so a re-run over the same snapshot produces byte-
// identical object ids and claim ids.

/** The object id of a character's per-route arc. */
export function routeArcObjectId(characterId: string, routeId: string): string {
  return `character-route-arc:${characterId}:${routeId}`;
}

/** The id of the module-authored route-presence claim for a character on a route. */
export function presenceClaimId(characterId: string, routeId: string): string {
  return `character-route-arc:${characterId}:${routeId}:presence`;
}

/** The id of the nth state-shift claim on a character's per-route arc. */
export function shiftClaimId(characterId: string, routeId: string, ordinal: number): string {
  return `character-route-arc:${characterId}:${routeId}:shift:${ordinal}`;
}
