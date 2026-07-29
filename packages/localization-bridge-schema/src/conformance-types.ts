// Runtime conformance ingestion schema mirror.
//
// This module mirrors the Rust validator in
// `crates/utsushi-core/src/conformance/{mod,result,manifest}.rs`. It is the
// single TypeScript seam Itotori uses to re-validate `ConformanceResult` and
// `ConformanceManifest` JSON payloads before ingest. The validator is
// conservative: evidence tier and fidelity tier strings are preserved
// byte-equal, unknown semantic-code prefixes are rejected at the schema
// layer, and `Skip` / `Unsupported` outcomes can never be widened into a
// `Pass` because the variants are distinct tagged-union arms.

export const CONFORMANCE_SCHEMA_VERSION_V01 = "0.2.0-alpha" as const;

export const CONFORMANCE_ABI_VERSION_V01 = 1 as const;

export const CONFORMANCE_PROFILE_IDS_V01 = [
  "text-trace",
  "branch-capture",
  "snapshot-restore",
  "frame-capture",
  "recording-capture",
  "deterministic-replay",
] as const;
export type ConformanceProfileIdV01 = (typeof CONFORMANCE_PROFILE_IDS_V01)[number];

export const CONFORMANCE_EVIDENCE_TIERS_V01 = ["E0", "E1", "E2", "E3", "E4"] as const;
export type ConformanceEvidenceTierV01 = (typeof CONFORMANCE_EVIDENCE_TIERS_V01)[number];

export const CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01 = [
  "asset_access",
  "input",
  "clock",
  "replay_log",
  "text_sink",
  "frame_sink",
  "audio_sink",
  "artifact_store",
  "snapshot_primitives",
] as const;
export type ConformanceSubsystemRequirementV01 =
  (typeof CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01)[number];

export const CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01 = [
  "trace_log",
  "screenshot",
  "frame_capture",
  "recording",
  "reference_comparison",
] as const;
export type ConformanceRuntimeArtifactKindV01 =
  (typeof CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01)[number];

export const CONFORMANCE_OUTCOME_KINDS_V01 = ["pass", "fail", "skip", "unsupported"] as const;
export type ConformanceOutcomeKindV01 = (typeof CONFORMANCE_OUTCOME_KINDS_V01)[number];

export const CONFORMANCE_EVIDENCE_REF_KINDS_V01 = [
  "runtimeArtifact",
  "textLine",
  "frameArtifactRef",
  "replayLogRef",
  "implMapFixture",
  "bridgeUnit",
  "statePath",
] as const;
export type ConformanceEvidenceRefKindV01 = (typeof CONFORMANCE_EVIDENCE_REF_KINDS_V01)[number];

// Per-profile evidence-tier ceilings mirror `ProfileId::evidence_tier_ceiling`
// in `crates/utsushi-core/src/conformance/mod.rs`.
export const PROFILE_EVIDENCE_TIER_CEILING: Record<
  ConformanceProfileIdV01,
  ConformanceEvidenceTierV01
> = {
  "text-trace": "E1",
  "branch-capture": "E1",
  "snapshot-restore": "E1",
  "frame-capture": "E2",
  "recording-capture": "E2",
  "deterministic-replay": "E1",
};

// Per-profile required-subsystems mirror `ProfileId::required_subsystems`.
export const PROFILE_REQUIRED_SUBSYSTEMS: Record<
  ConformanceProfileIdV01,
  ReadonlyArray<ConformanceSubsystemRequirementV01>
> = {
  "text-trace": ["text_sink"],
  "branch-capture": ["text_sink"],
  "snapshot-restore": ["snapshot_primitives"],
  "frame-capture": ["frame_sink", "artifact_store"],
  "recording-capture": ["frame_sink", "artifact_store"],
  "deterministic-replay": ["replay_log", "clock", "text_sink"],
};

export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{7,63}$/u;
export const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const SEMANTIC_CODE_PATTERN = /^(utsushi|kaifuu)\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;
export const ALLOWED_SEMANTIC_CODE_PREFIXES = [
  "utsushi.conformance.",
  "utsushi.snapshot.",
  "kaifuu.",
] as const;
export const RUNTIME_ARTIFACT_URI_PREFIX = "artifacts/utsushi/runtime/";
export const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
export const RFC3339_INSTANT_PATTERN_CONFORMANCE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

// Bounded length policy (plan §4 - "max 64 bytes per id, 4 KiB per detail").
export const MAX_ID_LENGTH = 64;
export const MAX_PATH_LENGTH = 256;
export const MAX_DETAIL_LENGTH = 4096;
export const MAX_NOTE_LENGTH = 1024;
export const MAX_REASON_LENGTH = 4096;
export const MAX_URI_LENGTH = 1024;

export type ConformanceRuntimeArtifactEvidenceV01 = {
  artifactKind: "runtimeArtifact";
  kind: ConformanceRuntimeArtifactKindV01;
  uri: string;
  artifactId?: string;
};

export type ConformanceTextLineEvidenceV01 = {
  artifactKind: "textLine";
  lineId: string;
};

export type ConformanceFrameArtifactRefEvidenceV01 = {
  artifactKind: "frameArtifactRef";
  frameId: string;
};

export type ConformanceReplayLogRefEvidenceV01 = {
  artifactKind: "replayLogRef";
  runId: string;
};

export type ConformanceImplMapFixtureEvidenceV01 = {
  artifactKind: "implMapFixture";
  fixtureId: string;
};

export type ConformanceBridgeUnitEvidenceV01 = {
  artifactKind: "bridgeUnit";
  bridgeUnitId: string;
};

export type ConformanceStatePathEvidenceV01 = {
  artifactKind: "statePath";
  path: string;
};

export type ConformanceEvidenceRefV01 =
  | ConformanceRuntimeArtifactEvidenceV01
  | ConformanceTextLineEvidenceV01
  | ConformanceFrameArtifactRefEvidenceV01
  | ConformanceReplayLogRefEvidenceV01
  | ConformanceImplMapFixtureEvidenceV01
  | ConformanceBridgeUnitEvidenceV01
  | ConformanceStatePathEvidenceV01;

export type ConformanceResultOutcomePassV01 = {
  kind: "pass";
  evidenceTier: ConformanceEvidenceTierV01;
};

export type ConformanceResultOutcomeFailV01 = {
  kind: "fail";
  semanticCode: string;
  detail: string;
};

export type ConformanceResultOutcomeSkipV01 = {
  kind: "skip";
  semanticCode: string;
  reason: string;
};

export type ConformanceResultOutcomeUnsupportedV01 = {
  kind: "unsupported";
  semanticCode: string;
  declaredInManifest: boolean;
};

export type ConformanceResultOutcomeV01 =
  | ConformanceResultOutcomePassV01
  | ConformanceResultOutcomeFailV01
  | ConformanceResultOutcomeSkipV01
  | ConformanceResultOutcomeUnsupportedV01;

export type ConformanceProfileV01 = {
  id: ConformanceProfileIdV01;
  requiredSubsystems: ConformanceSubsystemRequirementV01[];
  evidenceTierCeiling: ConformanceEvidenceTierV01;
};

export type ConformanceProfileExtensionV01 = {
  profileId: ConformanceProfileIdV01;
  key: string;
  note: string;
};

export type ConformanceManifestV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  abiVersion: typeof CONFORMANCE_ABI_VERSION_V01;
  supportedProfiles: ConformanceProfileV01[];
  optionalExtensions?: ConformanceProfileExtensionV01[];
};

export type ConformanceResultV01 = {
  schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION_V01;
  adapterId: string;
  profileId: ConformanceProfileIdV01;
  outcome: ConformanceResultOutcomeV01;
  evidence: ConformanceEvidenceRefV01[];
  recordedAt: string;
};

export type ConformanceIngestionErrorOptions = {
  code: string;
  message: string;
};

export class ConformanceIngestionError extends Error {
  readonly code: string;
  constructor(options: ConformanceIngestionErrorOptions) {
    super(`${options.code}: ${options.message}`);
    this.name = "ConformanceIngestionError";
    this.code = options.code;
  }
}
