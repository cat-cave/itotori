// The live composition substrate — the concrete builders that satisfy the
// `WorkflowPortDeps` contract by wrapping the already-built live infrastructure:
// the sole ZDR dispatch boundary, the CAS accepted-output heads + physical memo
// ledger, and the decode structure export. These are the substrate the workflow
// ports (`../workflow-ports.ts`) adapt into the deterministic driver's seams.

export {
  createDispatchRuntime,
  createCertifiedDispatch,
  type CertifiedDispatch,
  type DispatchRuntimeBase,
  type LiveDispatchRuntimeConfig,
  type PayloadResolver,
  type RunSnapshotRevisions,
} from "./dispatch-runtime.js";
export {
  createLiveWorkflowArtifactStore,
  inMemoryStepCache,
  type AcceptedOutputCas,
  type AcceptedUnitOutput,
  type FinalizeArtifactResolver,
  type LiveWorkflowArtifactStoreConfig,
  type WorkflowStepCache,
} from "./artifact-store.js";
export {
  projectDecodeStructure,
  type DecodeSceneProjection,
  type DecodeUnitFact,
} from "./scene-projection.js";
export {
  createFieldMemoCipher,
  FIELD_CIPHER_KEY_ENV_VAR,
  FieldCipherKeyError,
  FieldCipherRefError,
} from "./field-cipher.js";
export {
  createLiveLocalizationSubstrate,
  createLiveWorkflowPortDeps,
  productionLocalizeDispatchConfig,
  createProductionLiveLocalizationSubstrate,
  createProductionLiveWorkflowPortDeps,
  loadInstalledBible,
  LiveWorkflowFactoryError,
  type InstalledBibleSource,
  type LiveWorkflowFactoryConfig,
  type LiveWorkflowRoleSeams,
  type LiveWorkflowStores,
} from "./factory.js";
