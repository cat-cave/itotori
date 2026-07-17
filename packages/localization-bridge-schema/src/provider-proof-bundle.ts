/** Retired legacy provider-proof wire contract. */
type Retired = any;
export const PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION = "retired" as const;
export type ProviderProofMode = Retired;
export type ProviderProofRoleName = Retired;
export const PROVIDER_PROOF_ROLE_NAMES: Retired = [];
export type ProviderProofAttemptOutcome = Retired;
export type ProviderProofRetryState = Retired;
export type ProviderProofTerminalStatus = Retired;
export type ProviderProofRejection = Retired;
export type ProviderProofAttempt = Retired;
export type ProviderProofRole = Retired;
export type ProviderProofLedgerRow = Retired;
export type ProviderProofSeededDefect = Retired;
export type ProviderProofQaOracleReport = Retired;
export type ProviderProofZdrPosture = Retired;
export type ProviderProofBundle = Retired;
export const PROVIDER_PROOF_BUNDLE_JSON_SCHEMA: Retired = {};
export class ProviderProofBundleValidationError extends Error {}
export function assertProviderProofBundle(_value: unknown): asserts _value is ProviderProofBundle {}
export function parseProviderProofBundle(_raw: string): ProviderProofBundle {
  throw new ProviderProofBundleValidationError(
    "The legacy provider-proof contract has been removed.",
  );
}
