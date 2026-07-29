import {
  type CapabilityLevel,
  type EngineCapabilityEvidenceSource,
  capabilityLevelValues,
  engineCapabilityEvidence,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  engineCapabilityReports,
} from "../schema.js";
import {
  capabilityEvidenceLabelValues,
  type AdapterCapabilityMatrixRecord,
  type CapabilityEvidenceInput,
  type CapabilityEvidenceLabel,
  type CapabilityLevelStatusInput,
  EngineCapabilityReportShapeError,
  type EngineCapabilityEvidenceByLevel,
  type EngineCapabilityEvidenceRow,
  type EngineCapabilityEvidenceSplit,
  type EngineCapabilityReportRow,
} from "./engine-capability-report-repository-types.js";

export function assertStatusShape(status: CapabilityLevelStatusInput, label: string): void {
  switch (status.kind) {
    case "supported":
      return;
    case "partial":
      if (!Array.isArray(status.limitations) || status.limitations.length === 0) {
        throw new EngineCapabilityReportShapeError(
          `${label}: partial status requires a non-empty limitations array`,
        );
      }
      return;
    case "unsupported":
      if (typeof status.reason !== "string" || status.reason.trim().length === 0) {
        throw new EngineCapabilityReportShapeError(
          `${label}: unsupported status requires a non-empty reason`,
        );
      }
      return;
    default: {
      // Exhaustive guard for never-narrowing.
      const exhaustive: never = status;
      throw new EngineCapabilityReportShapeError(
        `${label}: unknown status kind ${(exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

export function statusFor(
  matrix: AdapterCapabilityMatrixRecord,
  level: CapabilityLevel,
): CapabilityLevelStatusInput {
  return matrix[level];
}

const allowedEvidenceLabels = new Set<string>(Object.values(capabilityEvidenceLabelValues));
const evidenceInputKeys = new Set([
  "adapterId",
  "level",
  "evidenceSource",
  "evidenceKind",
  "schemaVersion",
  "status",
  "aggregateCounts",
  "evidenceLabels",
  "limitations",
  "publicFixtureId",
  "reportedAt",
]);

const privateLocalEvidenceKinds = new Set<string>([
  engineCapabilityEvidenceKindValues.localCorpusSidecar,
  engineCapabilityEvidenceKindValues.engineMarkerCount,
]);

const publicFixtureEvidenceKinds = new Set<string>([
  engineCapabilityEvidenceKindValues.adapterMatrix,
  engineCapabilityEvidenceKindValues.keyValidation,
]);

const publicFixtureEvidenceLabels = new Set<string>([
  capabilityEvidenceLabelValues.adapterCapabilityMatrix,
  capabilityEvidenceLabelValues.publicFixtureMatrix,
  capabilityEvidenceLabelValues.publicFixtureKeyValidation,
]);

const privateLocalEvidenceLabels = new Set<string>(
  Object.values(capabilityEvidenceLabelValues).filter(
    (label) => !publicFixtureEvidenceLabels.has(label),
  ),
);

const evidenceLeakagePatterns: Array<{ pattern: RegExp; label: string }> = [
  {
    // Boundary class covers string-start, whitespace, quotes, and the
    // key=value / key:value delimiters (`=`, `:`) so a private root that
    // follows a key (e.g. `source=/private/corpus`, `path:/private/x`) is
    // caught the same as one at a string start or after whitespace.
    pattern:
      /(^|[\s"'`=:])(?:\/(?:home|users|tmp|var|scratch|mnt|volumes|private)\b|~\/|[a-z]:[\\/]|file:)/i,
    label: "local path",
  },
  {
    pattern:
      /\b[^\s\\/]+\.(?:rpgmvp|rpgmvo|rpgmvm|png|jpg|jpeg|json|txt|ks|xp3|exe|dll|ini|sav|zip|rar|7z)\b/i,
    label: "filename",
  },
  { pattern: /\bscreen\s*shot|screenshot\w*/i, label: "screenshot name" },
  { pattern: /\braw[_ -]?text\b/i, label: "raw text" },
  {
    pattern: /\b(?:secret|secret_key|raw[_ -]?key|key[_ -]?material|decryption[_ -]?key)\b/i,
    label: "key material",
  },
  {
    pattern: /(?:path[._\-\s]*hash|local[._\-\s]*scan[._\-\s]*entry[._\-\s]*id|entry[._\-\s]*id)/i,
    label: "path hash or local entry id",
  },
  { pattern: /\b[a-f0-9]{32,}\b/i, label: "raw hash" },
  { pattern: /\b(?:raw[_ -]?signal|signal[_ -]?blob|signals?)\b/i, label: "raw signal blob" },
];

export function toReportRow(
  raw: typeof engineCapabilityReports.$inferSelect,
): EngineCapabilityReportRow {
  return {
    engineCapabilityReportId: raw.engineCapabilityReportId,
    adapterId: raw.adapterId,
    level: raw.level,
    statusKind: raw.statusKind,
    limitations: raw.limitations ?? [],
    reason: raw.reason ?? null,
    reportedAt: raw.reportedAt,
  };
}

export function normalizeCapabilityEvidenceInput(
  input: CapabilityEvidenceInput,
): Required<CapabilityEvidenceInput> {
  validateCapabilityEvidenceInput(input);
  return {
    adapterId: input.adapterId,
    level: input.level,
    evidenceSource: input.evidenceSource,
    evidenceKind: input.evidenceKind,
    schemaVersion: input.schemaVersion,
    status: input.status,
    aggregateCounts: input.aggregateCounts ?? {},
    evidenceLabels: input.evidenceLabels ?? [],
    limitations: input.limitations ?? [],
    publicFixtureId: input.publicFixtureId ?? null,
    reportedAt: input.reportedAt ?? new Date(),
  };
}

function validateCapabilityEvidenceInput(input: CapabilityEvidenceInput): void {
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (!evidenceInputKeys.has(key)) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.${key}: unsupported field; raw evidence blobs are not accepted`,
      );
    }
  }
  if (typeof input.adapterId !== "string" || input.adapterId.trim().length === 0) {
    throw new EngineCapabilityReportShapeError("CapabilityEvidence.adapterId must be non-empty");
  }
  if (!Object.values(capabilityLevelValues).includes(input.level)) {
    throw new EngineCapabilityReportShapeError(`CapabilityEvidence.level is not supported`);
  }
  if (!Object.values(engineCapabilityEvidenceSourceValues).includes(input.evidenceSource)) {
    throw new EngineCapabilityReportShapeError(
      `CapabilityEvidence.evidenceSource is not supported`,
    );
  }
  if (!Object.values(engineCapabilityEvidenceKindValues).includes(input.evidenceKind)) {
    throw new EngineCapabilityReportShapeError(`CapabilityEvidence.evidenceKind is not supported`);
  }
  if (!Object.values(engineCapabilityEvidenceStatusValues).includes(input.status)) {
    throw new EngineCapabilityReportShapeError(`CapabilityEvidence.status is not supported`);
  }
  if (typeof input.schemaVersion !== "string" || input.schemaVersion.trim().length === 0) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.schemaVersion must be non-empty",
    );
  }
  validateAggregateCounts(input.aggregateCounts ?? {});
  validateEvidenceLabels(input.evidenceLabels ?? []);
  validateStringArray(input.limitations ?? [], "limitations");
  if (input.publicFixtureId != null && input.publicFixtureId.trim().length === 0) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.publicFixtureId must be non-empty when provided",
    );
  }
  if (
    input.evidenceSource !== engineCapabilityEvidenceSourceValues.publicFixture &&
    input.publicFixtureId != null
  ) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.publicFixtureId is only valid for public_fixture evidence",
    );
  }
  validateEvidenceSourcePairing(input);
  assertNoEvidenceLeakage(input);
}

function validateEvidenceSourcePairing(input: CapabilityEvidenceInput): void {
  if (
    input.evidenceSource === engineCapabilityEvidenceSourceValues.publicFixture &&
    !publicFixtureEvidenceKinds.has(input.evidenceKind)
  ) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.public_fixture only accepts public fixture evidence kinds",
    );
  }
  if (
    input.evidenceSource === engineCapabilityEvidenceSourceValues.privateLocalAggregate &&
    !privateLocalEvidenceKinds.has(input.evidenceKind)
  ) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.private_local_aggregate only accepts aggregate local evidence kinds",
    );
  }
  for (const label of input.evidenceLabels ?? []) {
    if (
      input.evidenceSource === engineCapabilityEvidenceSourceValues.publicFixture &&
      privateLocalEvidenceLabels.has(label)
    ) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.public_fixture does not accept private-local label ${label}`,
      );
    }
    if (
      input.evidenceSource === engineCapabilityEvidenceSourceValues.privateLocalAggregate &&
      publicFixtureEvidenceLabels.has(label)
    ) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.private_local_aggregate does not accept public fixture label ${label}`,
      );
    }
  }
}

function validateAggregateCounts(counts: Record<string, number>): void {
  if (!isPlainRecord(counts)) {
    throw new EngineCapabilityReportShapeError(
      "CapabilityEvidence.aggregateCounts must be an object",
    );
  }
  for (const [key, value] of Object.entries(counts)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new EngineCapabilityReportShapeError(
        "CapabilityEvidence.aggregateCounts keys must be non-empty strings",
      );
    }
    if (!Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.aggregateCounts.${key} must be a finite non-negative integer`,
      );
    }
  }
}

function validateEvidenceLabels(labels: CapabilityEvidenceLabel[]): void {
  validateStringArray(labels, "evidenceLabels");
  for (const label of labels) {
    if (!allowedEvidenceLabels.has(label)) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.evidenceLabels contains unsupported label ${label}`,
      );
    }
  }
}

function validateStringArray(values: string[], fieldName: string): void {
  if (!Array.isArray(values)) {
    throw new EngineCapabilityReportShapeError(`CapabilityEvidence.${fieldName} must be an array`);
  }
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new EngineCapabilityReportShapeError(
        `CapabilityEvidence.${fieldName} must contain only non-empty strings`,
      );
    }
  }
}

function assertNoEvidenceLeakage(input: CapabilityEvidenceInput): void {
  const strings = [
    input.adapterId,
    input.schemaVersion,
    input.publicFixtureId ?? "",
    ...Object.keys(input.aggregateCounts ?? {}),
    ...(input.evidenceLabels ?? []),
    ...(input.limitations ?? []),
  ];
  for (const value of strings) {
    for (const { pattern, label } of evidenceLeakagePatterns) {
      if (pattern.test(value)) {
        throw new EngineCapabilityReportShapeError(`CapabilityEvidence rejects ${label}`);
      }
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toEvidenceRow(
  raw: typeof engineCapabilityEvidence.$inferSelect,
): EngineCapabilityEvidenceRow {
  return {
    engineCapabilityEvidenceId: raw.engineCapabilityEvidenceId,
    adapterId: raw.adapterId,
    level: raw.level,
    evidenceSource: raw.evidenceSource,
    evidenceKind: raw.evidenceKind,
    schemaVersion: raw.schemaVersion,
    status: raw.status,
    aggregateCounts: raw.aggregateCounts ?? {},
    evidenceLabels: (raw.evidenceLabels ?? []) as CapabilityEvidenceLabel[],
    limitations: raw.limitations ?? [],
    publicFixtureId: raw.publicFixtureId ?? null,
    reportedAt: raw.reportedAt,
  };
}

export function emptyEvidenceByLevel(): EngineCapabilityEvidenceByLevel {
  return {
    identify: emptyEvidenceSplit(),
    inventory: emptyEvidenceSplit(),
    extract: emptyEvidenceSplit(),
    patch: emptyEvidenceSplit(),
  };
}

function emptyEvidenceSplit(): EngineCapabilityEvidenceSplit {
  return {
    publicFixture: [],
    privateLocalAggregate: [],
  };
}

export function evidenceBucket(
  split: EngineCapabilityEvidenceSplit,
  source: EngineCapabilityEvidenceSource,
): EngineCapabilityEvidenceRow[] {
  if (source === engineCapabilityEvidenceSourceValues.publicFixture) {
    return split.publicFixture;
  }
  return split.privateLocalAggregate;
}

export function compareEvidenceRows(
  left: EngineCapabilityEvidenceRow,
  right: EngineCapabilityEvidenceRow,
): number {
  const levelOrder = Object.values(capabilityLevelValues);
  const sourceOrder = Object.values(engineCapabilityEvidenceSourceValues);
  const levelDiff = levelOrder.indexOf(left.level) - levelOrder.indexOf(right.level);
  if (levelDiff !== 0) {
    return levelDiff;
  }
  const sourceDiff =
    sourceOrder.indexOf(left.evidenceSource) - sourceOrder.indexOf(right.evidenceSource);
  if (sourceDiff !== 0) {
    return sourceDiff;
  }
  const kindDiff = left.evidenceKind.localeCompare(right.evidenceKind);
  if (kindDiff !== 0) {
    return kindDiff;
  }
  return left.engineCapabilityEvidenceId.localeCompare(right.engineCapabilityEvidenceId);
}
