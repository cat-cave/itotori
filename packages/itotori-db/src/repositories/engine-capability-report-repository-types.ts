import type {
  CapabilityLevel,
  CapabilityLevelStatusKind,
  EngineCapabilityEvidenceKind,
  EngineCapabilityEvidenceSource,
  EngineCapabilityEvidenceStatus,
} from "../schema.js";

// Capability-leveled engine detector registry.
//
// Mirrors `kaifuu_core::registry::capability::AdapterCapabilityMatrix` and
// `packages/localization-bridge-schema/src/index.ts`
// (`AdapterCapabilityMatrixV02`). The strict gate (acceptance criterion 2)
// lives in `isAdapterUsable` / `adaptersSupporting` below — "Partial" does
// NOT count as Supported.

export type CapabilityLevelStatusInput =
  | { kind: "supported" }
  | { kind: "partial"; limitations: string[] }
  | { kind: "unsupported"; reason: string };

export type AdapterCapabilityMatrixRecord = {
  adapterId: string;
  identify: CapabilityLevelStatusInput;
  inventory: CapabilityLevelStatusInput;
  extract: CapabilityLevelStatusInput;
  patch: CapabilityLevelStatusInput;
};

export type EngineCapabilityReportRow = {
  engineCapabilityReportId: string;
  adapterId: string;
  level: CapabilityLevel;
  statusKind: CapabilityLevelStatusKind;
  limitations: string[];
  reason: string | null;
  reportedAt: Date;
};

export const capabilityEvidenceLabelValues = {
  adapterCapabilityMatrix: "adapter_capability_matrix",
  publicFixtureMatrix: "public_fixture_matrix",
  publicFixtureKeyValidation: "public_fixture_key_validation",
  rpgmakerMvMetadata: "rpgmaker_mv_metadata",
  rpgmakerMzMetadata: "rpgmaker_mz_metadata",
  encryptedAssetExtension: "encrypted_asset_extension",
  systemJsonLayout: "system_json_layout",
  localEngineMarkerCount: "local_engine_marker_count",
  localExtensionCount: "local_extension_count",
  localFileKindCount: "local_file_kind_count",
  localCorpusMarkerEvidence: "local_corpus_marker_evidence",
  mvMzMarkerEvidence: "mv_mz_marker_evidence",
} as const;

export type CapabilityEvidenceLabel =
  (typeof capabilityEvidenceLabelValues)[keyof typeof capabilityEvidenceLabelValues];

export type CapabilityEvidenceInput = {
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: EngineCapabilityEvidenceSource;
  evidenceKind: EngineCapabilityEvidenceKind;
  schemaVersion: string;
  status: EngineCapabilityEvidenceStatus;
  aggregateCounts?: Record<string, number>;
  evidenceLabels?: CapabilityEvidenceLabel[];
  limitations?: string[];
  publicFixtureId?: string | null;
  reportedAt?: Date;
};

export type EngineCapabilityEvidenceRow = {
  engineCapabilityEvidenceId: string;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: EngineCapabilityEvidenceSource;
  evidenceKind: EngineCapabilityEvidenceKind;
  schemaVersion: string;
  status: EngineCapabilityEvidenceStatus;
  aggregateCounts: Record<string, number>;
  evidenceLabels: CapabilityEvidenceLabel[];
  limitations: string[];
  publicFixtureId: string | null;
  reportedAt: Date;
};

export type EngineCapabilityEvidenceSplit = {
  publicFixture: EngineCapabilityEvidenceRow[];
  privateLocalAggregate: EngineCapabilityEvidenceRow[];
};

export type EngineCapabilityEvidenceByLevel = Record<
  CapabilityLevel,
  EngineCapabilityEvidenceSplit
>;

export type EngineCapabilityReadinessRecord = {
  adapterId: string;
  matrix: AdapterCapabilityMatrixRecord;
  evidenceByLevel: EngineCapabilityEvidenceByLevel;
};

export class EngineCapabilityReportShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineCapabilityReportShapeError";
  }
}
