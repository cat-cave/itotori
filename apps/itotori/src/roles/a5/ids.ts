// Stable, deterministic identifiers for A5's emitted objects.
//
// Every id is a pure function of the character it is about (and, for a rule, its
// ordinal), so a re-run over the same snapshot produces byte-identical object ids
// and claim ids.

/** The object id of a character's voice profile. */
export function voiceProfileObjectId(characterId: string): string {
  return `voice-profile:${characterId}`;
}

/** The id of the module-authored base-register (per-character) claim. */
export function baseRegisterClaimId(characterId: string): string {
  return `voice-profile:${characterId}:base`;
}

/** The id of the nth per-counterpart claim on a character's voice profile. */
export function counterpartClaimId(characterId: string, ordinal: number): string {
  return `voice-profile:${characterId}:counterpart:${ordinal}`;
}

/** The id of the nth per-arc-position claim on a character's voice profile. */
export function arcPositionClaimId(characterId: string, ordinal: number): string {
  return `voice-profile:${characterId}:arc:${ordinal}`;
}
