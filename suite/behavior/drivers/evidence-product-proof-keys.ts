const PRODUCT_PROOF_KEYS = [
  "schema",
  "artifactClass",
  "scopeId",
  "artifactId",
  "artifactKind",
  "publicContent",
  "evidenceKind",
  "contentCase",
  "sourceRevision",
  "currentRevision",
  "anchorRevision",
  "peerRevision",
  "alternateRevision",
  "unaffectedRevision",
  "scanClasses",
  "publishedRef",
  "scopePrefix",
  "cleanupDecisions",
  "identityChangeChangesHash",
  "scenarioOutput",
  "uriNegativeControlsRejected",
];

export function assertExactProductProofKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...PRODUCT_PROOF_KEYS].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error("evidence-product-proof-keys-invalid");
}
