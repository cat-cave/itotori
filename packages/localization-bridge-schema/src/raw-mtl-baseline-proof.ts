/** Retired legacy raw-MTL proof wire contract. */
type Retired = any;
export const RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION = "retired" as const;
export const RAW_MTL_BASELINE_SYSTEM_KIND = "retired" as const;
export type RawMtlBaselineQualityComparisonEntry = Retired;
export type RawMtlBaselineBenchmarkSection = Retired;
export type RawMtlBaselineQualitySection = Retired;
export type RawMtlBaselineProofArtifact = Retired;
export const RAW_MTL_BASELINE_PROOF_JSON_SCHEMA: Retired = {};
export class RawMtlBaselineProofValidationError extends Error {}
export function assertRawMtlBaselineProofArtifact(
  _value: unknown,
): asserts _value is RawMtlBaselineProofArtifact {}
export function parseRawMtlBaselineProofArtifact(_raw: string): RawMtlBaselineProofArtifact {
  throw new RawMtlBaselineProofValidationError(
    "The legacy raw-MTL proof contract has been removed.",
  );
}
