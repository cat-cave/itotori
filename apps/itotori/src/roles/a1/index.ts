// A1 Style Lead — self-contained role module.
//
// It CONSUMES the shared roster and the shared claim-validation gate read-only
// and imports nothing from any sibling role. It emits a cited source-language
// style-contract WikiObject and abstracts it into a reusable org/user/genre-keyed
// style artifact. This barrel is A1's own surface — not the shared roster barrel.

export {
  ABSTRACT_STYLE_ARTIFACT_SCHEMA_VERSION,
  AbstractStyleArtifactSchema,
  AbstractStyleError,
  AbstractStyleKeySchema,
  STYLE_POLICY_FIELDS,
  StyleObservationRefSchema,
  StylePolicyFieldSchema,
  StylePolicyValueSchema,
  abstractStyleArtifactId,
  abstractStyleFromContract,
  appliesToSnapshot,
  foldStyleContract,
  invalidatedStyleConsumers,
  snapshotsForField,
  type AbstractStyleArtifact,
  type AbstractStyleKey,
  type FoldOptions,
  type FoldResult,
  type StyleObservationRef,
  type StylePolicyField,
  type StylePolicyValue,
} from "./abstract-style.js";
export {
  assembleStyleLeadCallSpec,
  composeStyleLeadPrompt,
  inlineStylePromptStore,
  styleLeadTerminalSchemaHash,
  type StyleLeadRequest,
  type StyleLeadSlice,
  type StylePromptStore,
} from "./spec.js";
export {
  StyleLeadError,
  dispatchStyleLeadModel,
  recordedStyleLeadModel,
  runStyleLead,
  type StyleLeadDeps,
  type StyleLeadModelPort,
  type StyleLeadResult,
} from "./run.js";
