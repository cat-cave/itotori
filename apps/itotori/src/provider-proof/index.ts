// ITOTORI-116 — provider-proof harness public surface.

export {
  PROVIDER_PROOF_FIXTURE_SCHEMA_VERSION,
  PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS,
  PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING,
  ProviderProofConfigurationError,
  ProviderProofFixtureError,
  assertProviderProofFixture,
  recordedAttemptSource,
  runProviderProof,
  type ProviderProofAttemptSource,
  type ProviderProofFixture,
  type ProviderProofRecordedAttempt,
  type ProviderProofRoleResult,
  type RunProviderProofArgs,
} from "./harness.js";
export { scoreQaAgainstOracle } from "./oracle.js";
export {
  buildAlphaProviderProofSummary,
  renderReadmeSafeProviderProofSummary,
} from "./alpha-proof-summary.js";
export {
  PROVIDER_PROOF_LIVE_FLAG,
  PROVIDER_PROOF_LIVE_MAX_PRICE_USD,
  PROVIDER_PROOF_MODEL_ENV,
  PROVIDER_PROOF_PROVIDER_ID_ENV,
  providerProofSummary,
  readProviderProofFixture,
  runLiveProviderProof,
  runProviderProofCommand,
  runRecordedProviderProof,
  type ProviderProofCommandOptions,
  type ProviderProofResult,
} from "./command.js";
