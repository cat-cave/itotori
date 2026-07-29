import {
  type CapabilityEvidenceInput as DbCapabilityEvidenceInput,
  type CapabilityEvidenceLabel,
  capabilityEvidenceLabelValues,
  capabilityLevelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "@itotori/db";
import {
  type CatalogLocalEngineEvidence,
  catalogLocalDetectionSchemaVersion,
  catalogLocalEngineEvidenceSchemaVersion,
  catalogLocalScannerName,
} from "./catalog-local-scan.js";
import {
  type CatalogCapabilityEvidenceInput,
  type CatalogCapabilityEvidenceStatus,
  CatalogLocalCapabilityEvidenceError,
  catalogCapabilityEvidenceInputSchemaVersion,
  catalogLocalRpgMakerMvMzSourceAdapterId,
  catalogPublicRpgMakerMvMzAdapterId,
} from "./catalog-local-capability-evidence-contract.js";
import {
  assertNoForbiddenLocalEvidenceLeakage,
  sortRecord,
} from "./catalog-local-capability-evidence-validation.js";

const knownMarkerLabels = new Set(["rpgmaker_mv_metadata"]);
const knownExtensionCountKeys = new Set([
  "[none]",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".ogg",
  ".wav",
  ".mp3",
  ".m4a",
  ".mp4",
  ".webm",
  ".avi",
  ".mpg",
  ".mpeg",
  "unknown_extension",
]);
const knownFileKindCountKeys = new Set(["archive", "script", "image", "audio", "video", "other"]);

export function mapLocalEngineEvidenceToCapabilityEvidence(
  evidence: CatalogLocalEngineEvidence,
): CatalogCapabilityEvidenceInput[] {
  assertKnownRpgMakerMvMzLocalEvidence(evidence);
  assertNoForbiddenLocalEvidenceLeakage(evidence);

  return [
    {
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      adapterId: catalogPublicRpgMakerMvMzAdapterId,
      level: capabilityLevelValues.identify,
      evidenceSource: "private_local_aggregate",
      evidenceKind: "local_corpus_sidecar",
      sourceAdapterId: evidence.adapterId,
      sourceSchemaVersion: evidence.schemaVersion,
      status: localIdentifyStatus(evidence),
      aggregateCounts: aggregateCountsForLocalEvidence(evidence),
      evidenceLabels: evidence.evidence.markerKinds
        .filter((label) => knownMarkerLabels.has(label))
        .sort(),
      limitations: localEvidenceLimitations(evidence),
    },
  ];
}

export function mapLocalCapabilityEvidenceToDbInput(
  evidence: CatalogCapabilityEvidenceInput,
): DbCapabilityEvidenceInput {
  if (
    evidence.adapterId !== catalogPublicRpgMakerMvMzAdapterId ||
    evidence.evidenceSource !== "private_local_aggregate" ||
    evidence.evidenceKind !== "local_corpus_sidecar"
  ) {
    throw new CatalogLocalCapabilityEvidenceError(
      "only mapped MV/MZ private-local sidecar evidence can be persisted",
    );
  }

  return {
    adapterId: evidence.adapterId,
    level: evidence.level,
    evidenceSource: engineCapabilityEvidenceSourceValues.privateLocalAggregate,
    evidenceKind: engineCapabilityEvidenceKindValues.localCorpusSidecar,
    schemaVersion: evidence.schemaVersion,
    status: dbEvidenceStatus(evidence.status),
    aggregateCounts: dbApprovedAggregateCounts(evidence.aggregateCounts),
    evidenceLabels: [
      capabilityEvidenceLabelValues.localCorpusMarkerEvidence,
      capabilityEvidenceLabelValues.localEngineMarkerCount,
      capabilityEvidenceLabelValues.localExtensionCount,
      capabilityEvidenceLabelValues.localFileKindCount,
      capabilityEvidenceLabelValues.mvMzMarkerEvidence,
      ...evidence.evidenceLabels.map(dbEvidenceLabel),
    ],
    limitations: evidence.limitations,
  };
}

function dbEvidenceStatus(
  status: CatalogCapabilityEvidenceStatus,
): DbCapabilityEvidenceInput["status"] {
  switch (status) {
    case "present":
      return engineCapabilityEvidenceStatusValues.present;
    case "partial":
      return engineCapabilityEvidenceStatusValues.partial;
    case "missing":
      return engineCapabilityEvidenceStatusValues.missing;
    case "unknown":
      return engineCapabilityEvidenceStatusValues.unknown;
  }
}

function dbEvidenceLabel(label: string): CapabilityEvidenceLabel {
  if (label === "rpgmaker_mv_metadata") {
    return capabilityEvidenceLabelValues.rpgmakerMvMetadata;
  }
  throw new CatalogLocalCapabilityEvidenceError(
    `cannot persist unsupported evidence label ${label}`,
  );
}

function dbApprovedAggregateCounts(counts: Record<string, number>): Record<string, number> {
  return sortRecord({
    local_extension_count: sumAggregateCounts(counts, "extension."),
    local_file_kind_count: sumAggregateCounts(counts, "file_kind."),
    local_marker_count: sumAggregateCounts(counts, "marker."),
  });
}

function sumAggregateCounts(counts: Record<string, number>, prefix: string): number {
  return Object.entries(counts).reduce(
    (total, [key, value]) => (key.startsWith(prefix) ? total + value : total),
    0,
  );
}

function assertKnownRpgMakerMvMzLocalEvidence(evidence: CatalogLocalEngineEvidence): void {
  if (evidence.schemaVersion !== catalogLocalEngineEvidenceSchemaVersion) {
    throw new CatalogLocalCapabilityEvidenceError(
      "unsupported local engine evidence schemaVersion",
    );
  }
  if (evidence.producer !== catalogLocalScannerName) {
    throw new CatalogLocalCapabilityEvidenceError("unsupported local engine evidence producer");
  }
  if (evidence.localDetectionSchemaVersion !== catalogLocalDetectionSchemaVersion) {
    throw new CatalogLocalCapabilityEvidenceError(
      "unsupported local detection schemaVersion for engine evidence",
    );
  }
  if (evidence.adapterId !== catalogLocalRpgMakerMvMzSourceAdapterId) {
    throw new CatalogLocalCapabilityEvidenceError("unsupported local engine evidence adapterId");
  }
  if (evidence.engineName !== "rpg_maker_mv_mz" || evidence.engineSource !== "local_scan") {
    throw new CatalogLocalCapabilityEvidenceError("unsupported local engine evidence source");
  }
  assertKnownLabels(evidence.evidence.markerKinds, knownMarkerLabels, "markerKinds");
  assertCountRecord(evidence.evidence.extensionCounts, knownExtensionCountKeys, "extensionCounts");
  assertCountRecord(evidence.evidence.fileKindCounts, knownFileKindCountKeys, "fileKindCounts");
}

function assertKnownLabels(labels: string[], allowlist: Set<string>, field: string): void {
  if (!Array.isArray(labels)) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be an array`);
  }
  for (const label of labels) {
    if (!allowlist.has(label)) {
      throw new CatalogLocalCapabilityEvidenceError(`${field} contains unsupported label ${label}`);
    }
  }
}

function assertCountRecord(
  counts: Record<string, number>,
  allowlist: Set<string>,
  field: string,
): void {
  for (const [key, value] of Object.entries(counts)) {
    if (!allowlist.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(`${field} contains unsupported key ${key}`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CatalogLocalCapabilityEvidenceError(
        `${field}.${key} must be a non-negative integer`,
      );
    }
  }
}

function localIdentifyStatus(
  evidence: CatalogLocalEngineEvidence,
): CatalogCapabilityEvidenceInput["status"] {
  if (evidence.readiness.identify === "supported" || evidence.readiness.identify === "partial") {
    return "partial";
  }
  if (evidence.readiness.identify === "unsupported") {
    return "missing";
  }
  return "unknown";
}

function aggregateCountsForLocalEvidence(
  evidence: CatalogLocalEngineEvidence,
): Record<string, number> {
  return sortRecord({
    ...prefixCounts("extension", evidence.evidence.extensionCounts),
    ...prefixCounts("file_kind", evidence.evidence.fileKindCounts),
    ...Object.fromEntries(
      evidence.evidence.markerKinds.map((markerKind) => [`marker.${markerKind}`, 1]),
    ),
  });
}

function prefixCounts(prefix: string, counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [`${prefix}.${aggregateCountKey(key)}`, value]),
  );
}

function aggregateCountKey(key: string): string {
  if (key === "[none]") {
    return "none";
  }
  return key.startsWith(".") ? key.slice(1) : key;
}

function localEvidenceLimitations(evidence: CatalogLocalEngineEvidence): string[] {
  return [
    "private-local aggregate marker evidence only; no public fixture support claimed",
    "local scan marker evidence does not claim adapter execution, extraction, inventory, decryption, or patch support",
    `local readiness identify=${evidence.readiness.identify}; inventory=${evidence.readiness.inventory}; extract=${evidence.readiness.extract}; patch=${evidence.readiness.patch}`,
  ];
}
