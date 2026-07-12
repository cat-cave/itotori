// ALPHA-002 — Playable draft feedback loop: public surface.
//
// One import path for the batched feedback intake and its typed triage
// disposition. This surface does not schedule reruns.

export {
  DraftFeedbackBatchError,
  DraftFeedbackBatchService,
  type DraftFeedbackBatchPort,
  dispositionFor,
} from "./batch-service.js";
export {
  BRIDGE_UNIT_METADATA_KEYS,
  BridgeUnitMetadataError,
  type BridgeUnitMetadata,
  readBridgeUnitMetadata,
} from "./bridge-unit-metadata.js";
export {
  DRAFT_FEEDBACK_DISPOSITIONS,
  type DraftFeedbackBatchInput,
  type DraftFeedbackBatchItem,
  type DraftFeedbackBatchResult,
  type DraftFeedbackDisposition,
} from "./types.js";
