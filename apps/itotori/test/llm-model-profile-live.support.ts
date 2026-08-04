export function terminalGenerationLookupAttempts(
  lookupGenerationIds: readonly (string | null)[],
  terminalGenerationId: string | null,
): number {
  // The dispatcher reconciles every physical step. This certificate instead
  // attests only to the accepted terminal response, whose generation ID is
  // exposed on the final dispatch result.
  return terminalGenerationId === null
    ? 0
    : lookupGenerationIds.filter((generationId) => generationId === terminalGenerationId).length;
}
