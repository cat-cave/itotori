// Stable, deterministic ids for the objects and claims A10 emits. Every id is a
// pure function of the unit the hypothesis is about, so re-running A10 over the
// same snapshot re-derives the identical object and claim ids.

/** The speaker-hypothesis object id for one unit. */
export function hypothesisObjectId(unitId: string): string {
  return `a10-speaker-hypothesis:${unitId}`;
}

/** The single hypothesis claim id for one unit. */
export function hypothesisClaimId(unitId: string): string {
  return `a10-hypothesis-claim:${unitId}`;
}
