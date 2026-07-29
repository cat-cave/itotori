export const catalogLocalScanSchemaVersion = "catalog.local_corpus_sidecar.v0.1" as const;
export const catalogLocalDetectionSchemaVersion = "catalog.local_corpus_detection.v0.1" as const;
export const catalogLocalArchiveDetectionSchemaVersion =
  "catalog.local_corpus_archive_detection.v0.1" as const;
export const catalogLocalEngineEvidenceSchemaVersion =
  "catalog.local_corpus_engine_evidence.v0.1" as const;
export const catalogLocalScannerName = "itotori-local-corpus-scanner" as const;
export const catalogLocalScannerVersion = "0.1.0" as const;
export const catalogLocalMetadataFileName = ".itotori-local-corpus.json" as const;
const kaifuuArchiveDetectionEvidencePolicy =
  "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized" as const;
const kaifuuRedactedDetectionGameDir = "[redacted-local-game-dir]" as const;
const kaifuuLocalArchiveSupportBoundary =
  "Itotori local scan reports aggregate archive and engine markers only; no registered Kaifuu adapter execution, extraction, decryption, inventory, or patch support is claimed." as const;

export type CatalogLocalEntryKind =
  | "source_archive"
  | "installed_game"
  | "collection_member"
  | "edition"
  | "sidecar_metadata"
  | "unknown_directory";
export type CatalogLocalPackageKind = "archive" | "loose_files" | "installer" | "unknown";
export type CatalogLocalInstallState =
  | "source_archive"
  | "installed"
  | "patch_target"
  | "not_installed"
  | "archived"
  | "unknown";
export type CatalogLocalArchiveState =
  | "archive_file"
  | "expanded_directory"
  | "mixed_archive_and_install"
  | "none"
  | "unknown";
export type CatalogLocalEngineReadiness = {
  identify: "supported" | "partial" | "unsupported" | "unknown";
  inventory: "supported" | "partial" | "unsupported" | "unknown";
  extract: "supported" | "partial" | "unsupported" | "unknown";
  patch: "supported" | "partial" | "unsupported" | "unknown";
};
export type CatalogLocalKaifuuEvidenceStatus =
  | "matched"
  | "missing"
  | "invalid"
  | "informational"
  | "unknown";
export type CatalogLocalKaifuuArchiveEvidenceType =
  | "file_extension"
  | "file_name"
  | "file_magic"
  | "metadata_field"
  | "aggregate_count";
export type CatalogLocalKaifuuRequirementStatus =
  | "satisfied"
  | "missing"
  | "not_required"
  | "unsupported"
  | "unknown";
export type CatalogLocalKaifuuCapabilityStatus =
  | "supported"
  | "limited"
  | "unsupported"
  | "requires_user_input"
  | "unknown";
export type CatalogLocalKaifuuDetectionEvidence = {
  path: string;
  kind: string;
  status: CatalogLocalKaifuuEvidenceStatus;
  detail: string;
  count?: number;
};
export type CatalogLocalKaifuuRequirement = {
  category: string;
  key: string;
  status: CatalogLocalKaifuuRequirementStatus;
  description: string;
  placeholder: string | null;
  secret: boolean;
};
export type CatalogLocalKaifuuCapability = {
  capability: string;
  status: CatalogLocalKaifuuCapabilityStatus;
  limitation: string | null;
};
export type CatalogLocalKaifuuDetectionResult = {
  adapterId: string;
  detected: boolean;
  engineFamily?: string;
  engineVersion?: string;
  detectedVariant?: string;
  evidence: CatalogLocalKaifuuDetectionEvidence[];
  requirements: CatalogLocalKaifuuRequirement[];
  capabilities: CatalogLocalKaifuuCapability[];
};
export type CatalogLocalKaifuuArchiveDetectionRow = {
  rowId: string;
  engineFamily: string;
  detected: boolean;
  detectedVariant: string;
  signals: string[];
  evidence: Array<{
    evidenceType: CatalogLocalKaifuuArchiveEvidenceType;
    pattern: string;
    status: CatalogLocalKaifuuEvidenceStatus;
    count: number;
    detail: string;
  }>;
  requirements: CatalogLocalKaifuuRequirement[];
  capabilities: CatalogLocalKaifuuCapability[];
  diagnostics: Array<{
    code: string;
    signal: string;
    requiredCapability?: string;
    supportBoundary: string;
    remediation?: string;
  }>;
  supportBoundary: typeof kaifuuLocalArchiveSupportBoundary;
};
export type CatalogLocalKaifuuDetectionReport = {
  schemaVersion: typeof catalogLocalDetectionSchemaVersion;
  schemaDialect: "itotori_local_corpus_detection";
  gameDir: typeof kaifuuRedactedDetectionGameDir;
  status: "matched" | "unknown";
  detections: CatalogLocalKaifuuDetectionResult[];
  warnings: string[];
  archiveDetection: {
    schemaVersion: typeof catalogLocalArchiveDetectionSchemaVersion;
    schemaDialect: "itotori_local_corpus_archive_detection";
    status: "matched" | "unknown";
    evidencePolicy: typeof kaifuuArchiveDetectionEvidencePolicy;
    rows: CatalogLocalKaifuuArchiveDetectionRow[];
  };
};
export type CatalogLocalEngineEvidence = {
  schemaVersion: typeof catalogLocalEngineEvidenceSchemaVersion;
  producer: typeof catalogLocalScannerName;
  localDetectionSchemaVersion: typeof catalogLocalDetectionSchemaVersion;
  adapterId: string;
  engineName: string;
  engineSource: "local_scan";
  engineConfidence: "high" | "medium" | "low" | "unknown";
  readiness: CatalogLocalEngineReadiness;
  evidence: {
    markerKinds: string[];
    extensionCounts: Record<string, number>;
    fileKindCounts: Record<string, number>;
  };
};
export type CatalogLocalScanEntry = {
  localId: string;
  entryKind: CatalogLocalEntryKind;
  releaseKind: "original" | "edition" | "collection_member" | "unknown";
  packageKind: CatalogLocalPackageKind;
  installState: CatalogLocalInstallState;
  archiveState: CatalogLocalArchiveState;
  owned: boolean;
  pathHash: string;
  pathRedactionClass: "private_path_hash";
  fingerprintHash: string;
  byteCount: number;
  fileCount: number;
  directoryCount: number;
  extensionCounts: Record<string, number>;
  fileKindCounts: Record<string, number>;
  archiveDetection: {
    status: "detected" | "not_detected" | "unknown";
    archiveKind: "source_archive" | "embedded_archive" | "expanded_archive" | "none" | "unknown";
    evidence: {
      archiveExtension?: string;
      archiveFileCount: number;
      expandedArchiveMarkerCount: number;
    };
  };
  engineDetection: CatalogLocalKaifuuDetectionReport | null;
  localEngineEvidence: CatalogLocalEngineEvidence | null;
  relationshipEvidence: {
    collectionMember: boolean;
    edition: boolean;
    sidecarMetadata: boolean;
    editionSignalKinds: string[];
  };
  catalogLocalScanEntryInput: {
    pathHash: string;
    pathRedactionClass: "private_path_hash";
    owned: boolean;
    engineName?: string;
    engineSource?: "local_scan";
    engineConfidence?: "high" | "medium" | "low" | "unknown";
    signals: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
};
export type CatalogLocalScanReport = {
  schemaVersion: typeof catalogLocalScanSchemaVersion;
  localScanId: string;
  scannerName: typeof catalogLocalScannerName;
  scannerVersion: typeof catalogLocalScannerVersion;
  tool: { name: typeof catalogLocalScannerName; version: typeof catalogLocalScannerVersion };
  scanRoot: { labelHash: string; pathHash: string; pathRedactionClass: "private_path_hash" };
  startedAt: string;
  completedAt: string;
  owned: boolean;
  summary: {
    entryCount: number;
    fileCount: number;
    directoryCount: number;
    byteCount: number;
    byEntryKind: Record<CatalogLocalEntryKind, number>;
    byInstallState: Record<CatalogLocalInstallState, number>;
    byArchiveState: Record<CatalogLocalArchiveState, number>;
    byEngine: Record<string, number>;
    extensionCounts: Record<string, number>;
    fileKindCounts: Record<string, number>;
  };
  hashes: { rootPathHash: string; reportFingerprintHash: string };
  privacy: { hashMode: "hmac-sha256"; hashKeyProvided: true; keyEmitted: false };
  entries: CatalogLocalScanEntry[];
};
export type CatalogLocalScanOptions = {
  rootPath: string;
  rootLabel?: string;
  owned?: boolean;
  maxDepth?: number;
  hashKey?: string;
  now?: () => Date;
};
