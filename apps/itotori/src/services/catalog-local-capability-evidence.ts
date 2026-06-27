import {
  type AdapterCapabilityMatrixRecord,
  type CapabilityEvidenceInput as DbCapabilityEvidenceInput,
  type CapabilityEvidenceLabel,
  type CapabilityLevel,
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

export const catalogCapabilityEvidenceInputSchemaVersion =
  "catalog.capability_evidence_input.v0.1" as const;
export const catalogCapabilityEvidenceReadinessSchemaVersion =
  "catalog.capability_evidence_readiness.v0.1" as const;
export const catalogCapabilityEvidenceMergeFixtureSchemaVersion =
  "catalog.capability_evidence_merge_fixture.v0.1" as const;

export const catalogLocalRpgMakerMvMzSourceAdapterId = "local-scan:rpg_maker_mv_mz" as const;
export const catalogPublicRpgMakerMvMzAdapterId = "kaifuu.rpg-maker-mv-mz" as const;

export type CatalogCapabilityEvidenceSource = "public_fixture" | "private_local_aggregate";
export type CatalogCapabilityEvidenceKind = "adapter_matrix" | "local_corpus_sidecar";
export type CatalogCapabilityEvidenceStatus = "present" | "partial" | "missing" | "unknown";

export type CatalogCapabilityEvidenceInput = {
  schemaVersion: typeof catalogCapabilityEvidenceInputSchemaVersion;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: CatalogCapabilityEvidenceSource;
  evidenceKind: CatalogCapabilityEvidenceKind;
  sourceAdapterId: string;
  sourceSchemaVersion: string;
  status: CatalogCapabilityEvidenceStatus;
  aggregateCounts: Record<string, number>;
  evidenceLabels: string[];
  limitations: string[];
};

export type CatalogPublicFixtureCapabilityEvidence = {
  schemaVersion: typeof catalogCapabilityEvidenceInputSchemaVersion;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: "public_fixture";
  evidenceKind: "adapter_matrix";
  fixtureId: string;
  status: CatalogCapabilityEvidenceStatus;
  evidenceLabels: string[];
  limitations: string[];
};

export type CatalogCapabilityEvidenceReadiness = {
  schemaVersion: typeof catalogCapabilityEvidenceReadinessSchemaVersion;
  adapterId: string;
  matrix: AdapterCapabilityMatrixRecord;
  supportEvidence: {
    publicFixture: CatalogPublicFixtureCapabilityEvidence[];
    privateLocalAggregate: CatalogCapabilityEvidenceInput[];
  };
};

export type CatalogCapabilityEvidenceMergeInput = {
  schemaVersion: typeof catalogCapabilityEvidenceMergeFixtureSchemaVersion;
  publicFixture: {
    fixtureId: string;
    matrix: AdapterCapabilityMatrixRecord;
    evidence: Omit<
      CatalogPublicFixtureCapabilityEvidence,
      "schemaVersion" | "adapterId" | "fixtureId"
    >[];
  };
  privateLocalAggregate?: {
    localEngineEvidence: CatalogLocalEngineEvidence;
  };
};

export class CatalogLocalCapabilityEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogLocalCapabilityEvidenceError";
  }
}

const knownMarkerLabels = new Set(["rpgmaker_mv_metadata"]);
const knownPublicFixtureIds = new Set(["catalog-capability-evidence-mv-mz-public-matrix"]);
const knownPublicEvidenceLabels = new Set(["rpg_maker_mv_mz_public_fixture_matrix"]);
const catalogCapabilityEvidenceStatusValues = new Set<CatalogCapabilityEvidenceStatus>([
  "present",
  "partial",
  "missing",
  "unknown",
]);
const publicFixtureEvidenceKeys = new Set([
  "level",
  "evidenceSource",
  "evidenceKind",
  "status",
  "evidenceLabels",
  "limitations",
]);
const capabilityMatrixLevels = [
  capabilityLevelValues.identify,
  capabilityLevelValues.inventory,
  capabilityLevelValues.extract,
  capabilityLevelValues.patch,
] as const;
const publicMatrixKeys = new Set(["adapterId", ...capabilityMatrixLevels]);
const supportedMatrixStatusKeys = new Set(["kind"]);
const partialMatrixStatusKeys = new Set(["kind", "limitations"]);
const unsupportedMatrixStatusKeys = new Set(["kind", "reason"]);
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
const forbiddenEvidenceKeys = new Set([
  "filename",
  "fileName",
  "path",
  "pathHash",
  "localId",
  "localScanEntryId",
  "rawText",
  "rawSignal",
  "screenshot",
  "secretKey",
  "keyMaterial",
]);
const forbiddenEvidenceValuePatterns = [
  /(^|[\s"'])\/home\//u,
  /(^|[\s"'])\/scratch\//u,
  /(^|[\s"'])\/mnt\//u,
  /(^|[\s"'])\/Users\//u,
  /(^|[\s"'])\/Volumes\//u,
  /(^|[\s"'])\/private\//u,
  /(^|[\s"'])\/tmp\//u,
  /(^|[\s"'])\/var\//u,
  /(^|[\s"'])~\//u,
  /(^|[\s"'])[A-Za-z]:[\\/]/u,
  /file:/iu,
  /\b[A-Za-z0-9 ._-]+\.(?:json|txt|rpgmvp|rpgmvm|rpgmvo|zip|rar|7z|png|jpe?g|webp)\b/iu,
  /\.rpgmvp\b/iu,
  /\bsecret[_ -]?key\b/iu,
  /\bkeyMaterial\b/u,
  /screenshot/iu,
  /\bsha256:[a-f0-9]{16,}\b/iu,
  /\b[a-f0-9]{64}\b/iu,
  /pathHash/u,
  /localScanEntryId/u,
  /\blocal[-_ ]?scan[-_ ]?(entry[-_ ]?)?id\b/iu,
  /\bscan[-_ ]?id\b/iu,
  /raw\s*text|rawText/iu,
];

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

export function mergeCapabilityEvidenceFixture(
  input: CatalogCapabilityEvidenceMergeInput,
): CatalogCapabilityEvidenceReadiness {
  if (input.schemaVersion !== catalogCapabilityEvidenceMergeFixtureSchemaVersion) {
    throw new CatalogLocalCapabilityEvidenceError(
      `unsupported merge fixture schemaVersion ${input.schemaVersion}`,
    );
  }

  const publicMatrix = publicMatrixForMerge(input.publicFixture.matrix);
  const privateLocalAggregate = input.privateLocalAggregate?.localEngineEvidence
    ? mapLocalEngineEvidenceToCapabilityEvidence(input.privateLocalAggregate.localEngineEvidence)
    : [];
  const publicFixture = publicFixtureEvidenceForMerge(input);

  return {
    schemaVersion: catalogCapabilityEvidenceReadinessSchemaVersion,
    adapterId: publicMatrix.adapterId,
    matrix: publicMatrix,
    supportEvidence: {
      publicFixture,
      privateLocalAggregate,
    },
  };
}

function publicMatrixForMerge(matrix: unknown): AdapterCapabilityMatrixRecord {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new CatalogLocalCapabilityEvidenceError("publicFixture.matrix must be an object");
  }
  for (const key of Object.keys(matrix)) {
    if (!publicMatrixKeys.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `publicFixture.matrix.${key} is not allowed in public fixture matrix`,
      );
    }
  }

  const record = matrix as Partial<AdapterCapabilityMatrixRecord>;
  if (record.adapterId !== catalogPublicRpgMakerMvMzAdapterId) {
    throw new CatalogLocalCapabilityEvidenceError(
      `public matrix adapterId must be ${catalogPublicRpgMakerMvMzAdapterId}`,
    );
  }

  return {
    adapterId: record.adapterId,
    identify: publicMatrixStatusForMerge(record.identify, "publicFixture.matrix.identify"),
    inventory: publicMatrixStatusForMerge(record.inventory, "publicFixture.matrix.inventory"),
    extract: publicMatrixStatusForMerge(record.extract, "publicFixture.matrix.extract"),
    patch: publicMatrixStatusForMerge(record.patch, "publicFixture.matrix.patch"),
  };
}

function publicMatrixStatusForMerge(
  status: unknown,
  path: string,
): AdapterCapabilityMatrixRecord["identify"] {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path} must be an object`);
  }
  const record = status as Record<string, unknown>;
  switch (record.kind) {
    case "supported":
      assertOnlyPublicMatrixStatusKeys(record, supportedMatrixStatusKeys, path);
      return { kind: "supported" };
    case "partial": {
      assertOnlyPublicMatrixStatusKeys(record, partialMatrixStatusKeys, path);
      assertPublicNonEmptyStringArray(record.limitations, `${path}.limitations`);
      assertNoForbiddenPublicFixtureEvidenceLeakage(record.limitations, `${path}.limitations`);
      return { kind: "partial", limitations: [...record.limitations] };
    }
    case "unsupported":
      assertOnlyPublicMatrixStatusKeys(record, unsupportedMatrixStatusKeys, path);
      if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
        throw new CatalogLocalCapabilityEvidenceError(`${path}.reason must be a non-empty string`);
      }
      assertNoForbiddenPublicFixtureEvidenceLeakage(record.reason, `${path}.reason`);
      return { kind: "unsupported", reason: record.reason };
    default:
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.kind must be supported, partial, or unsupported`,
      );
  }
}

function assertOnlyPublicMatrixStatusKeys(
  record: Record<string, unknown>,
  allowlist: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowlist.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.${key} is not allowed in public fixture matrix status`,
      );
    }
  }
}

function publicFixtureEvidenceForMerge(
  input: CatalogCapabilityEvidenceMergeInput,
): CatalogPublicFixtureCapabilityEvidence[] {
  assertKnownPublicFixtureId(input.publicFixture.fixtureId);
  assertNoForbiddenPublicFixtureEvidenceLeakage(
    input.publicFixture.fixtureId,
    "publicFixture.fixtureId",
  );
  if (!Array.isArray(input.publicFixture.evidence)) {
    throw new CatalogLocalCapabilityEvidenceError("public fixture evidence must be an array");
  }

  return input.publicFixture.evidence.map((evidence, index) => {
    assertPublicFixtureEvidenceRow(evidence, index);
    return {
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      adapterId: input.publicFixture.matrix.adapterId,
      level: evidence.level,
      evidenceSource: "public_fixture",
      evidenceKind: "adapter_matrix",
      fixtureId: input.publicFixture.fixtureId,
      status: evidence.status,
      evidenceLabels: [...evidence.evidenceLabels],
      limitations: [...evidence.limitations],
    };
  });
}

function assertKnownPublicFixtureId(fixtureId: unknown): asserts fixtureId is string {
  if (typeof fixtureId !== "string" || !knownPublicFixtureIds.has(fixtureId)) {
    throw new CatalogLocalCapabilityEvidenceError("unsupported public fixtureId");
  }
}

function assertPublicFixtureEvidenceRow(
  evidence: unknown,
  index: number,
): asserts evidence is Omit<
  CatalogPublicFixtureCapabilityEvidence,
  "schemaVersion" | "adapterId" | "fixtureId"
> {
  const path = `publicFixture.evidence.${index}`;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path} must be an object`);
  }
  for (const key of Object.keys(evidence)) {
    if (!publicFixtureEvidenceKeys.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.${key} is not allowed in public fixture evidence`,
      );
    }
  }

  const row = evidence as Partial<CatalogPublicFixtureCapabilityEvidence>;
  if (row.level !== capabilityLevelValues.identify) {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.level is not supported`);
  }
  if (row.evidenceSource !== "public_fixture") {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.evidenceSource is not supported`);
  }
  if (row.evidenceKind !== "adapter_matrix") {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.evidenceKind is not supported`);
  }
  if (!catalogCapabilityEvidenceStatusValues.has(row.status as CatalogCapabilityEvidenceStatus)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.status is not supported`);
  }
  assertKnownLabels(
    row.evidenceLabels as string[],
    knownPublicEvidenceLabels,
    `${path}.evidenceLabels`,
  );
  assertPublicStringArray(row.limitations, `${path}.limitations`);
  assertNoForbiddenPublicFixtureEvidenceLeakage(row, path);
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

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function localEvidenceLimitations(evidence: CatalogLocalEngineEvidence): string[] {
  return [
    "private-local aggregate marker evidence only; no public fixture support claimed",
    "local scan marker evidence does not claim adapter execution, extraction, inventory, decryption, or patch support",
    `local readiness identify=${evidence.readiness.identify}; inventory=${evidence.readiness.inventory}; extract=${evidence.readiness.extract}; patch=${evidence.readiness.patch}`,
  ];
}

function assertNoForbiddenLocalEvidenceLeakage(value: unknown, path = "localEngineEvidence"): void {
  if (typeof value === "string") {
    for (const pattern of forbiddenEvidenceValuePatterns) {
      if (pattern.test(value)) {
        throw new CatalogLocalCapabilityEvidenceError(
          `${path} contains forbidden private evidence`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenLocalEvidenceLeakage(entry, `${path}.${index}`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenEvidenceKeys.has(key)) {
        throw new CatalogLocalCapabilityEvidenceError(`${path}.${key} is not aggregate-safe`);
      }
      assertNoForbiddenLocalEvidenceLeakage(entry, `${path}.${key}`);
    }
  }
}

function assertPublicStringArray(values: unknown, field: string): asserts values is string[] {
  if (!Array.isArray(values)) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be an array`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new CatalogLocalCapabilityEvidenceError(`${field}.${index} must be a non-empty string`);
    }
  }
}

function assertPublicNonEmptyStringArray(
  values: unknown,
  field: string,
): asserts values is string[] {
  assertPublicStringArray(values, field);
  if (values.length === 0) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be a non-empty string array`);
  }
}

function assertNoForbiddenPublicFixtureEvidenceLeakage(
  value: unknown,
  path = "publicFixture",
): void {
  if (typeof value === "string") {
    for (const pattern of forbiddenEvidenceValuePatterns) {
      if (pattern.test(value)) {
        throw new CatalogLocalCapabilityEvidenceError(`${path} contains forbidden public evidence`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenPublicFixtureEvidenceLeakage(entry, `${path}.${index}`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenEvidenceKeys.has(key)) {
        throw new CatalogLocalCapabilityEvidenceError(
          `${path}.${key} is not allowed in public fixture evidence`,
        );
      }
      assertNoForbiddenPublicFixtureEvidenceLeakage(entry, `${path}.${key}`);
    }
  }
}
