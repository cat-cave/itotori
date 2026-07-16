// Stable, deterministic identifiers for A7's emitted objects.
//
// Every id is a pure function of the character it is about, so a re-run over the
// same snapshot produces byte-identical object ids, claim ids, and media ids.

/** The object id of a character's bio. */
export function bioObjectId(characterId: string): string {
  return `character-bio:${characterId}`;
}

/** The stable media id a character's portrait binds to. */
export function portraitMediaId(characterId: string): string {
  return `portrait:${characterId}`;
}

/** The id of the module-authored whole-game presence claim for a character. */
export function presenceClaimId(characterId: string): string {
  return `character-bio:${characterId}:presence`;
}

/** The id of the nth model-proposed claim on a character's bio. */
export function modelClaimId(characterId: string, ordinal: number): string {
  return `character-bio:${characterId}:claim:${ordinal}`;
}
