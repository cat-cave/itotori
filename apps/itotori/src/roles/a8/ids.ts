// Stable, deterministic identifiers for A8's emitted objects.
//
// Every id is a pure function of the character (and, for a relationship, its
// ordinal) it is about, so a re-run over the same snapshot produces byte-
// identical object ids and claim ids.

/** The object id of a character's background. */
export function backgroundObjectId(characterId: string): string {
  return `character-background:${characterId}`;
}

/** The id of the module-authored whole-game presence claim for a character. */
export function presenceClaimId(characterId: string): string {
  return `character-background:${characterId}:presence`;
}

/** The id of the nth relationship claim on a character's background. */
export function relationshipClaimId(characterId: string, ordinal: number): string {
  return `character-background:${characterId}:relationship:${ordinal}`;
}

/** The evidence id a scene is citeable under in the snapshot evidence index. */
export function sceneEvidenceId(sceneId: string | number): string {
  return `scene:${sceneId}`;
}
