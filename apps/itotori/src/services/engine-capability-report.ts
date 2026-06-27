import {
  type AdapterCapabilityMatrixRecord,
  type AuthorizationActor,
  type CapabilityLevel,
  EngineCapabilityReportRepository,
  capabilityLevelValues,
} from "@itotori/db";

// KAIFUU-053: itotori-side consumer for the capability-leveled engine
// detector registry. Wraps the repository with a typed API that the
// dashboard and CLI surfaces consume so they can distinguish "identified
// only" engines from engines that actually support extract/patch.
//
// The strict gate (acceptance criterion 2) lives at the
// `isUsable(adapterId, level)` boundary: Partial does NOT count as
// Supported.

export type AdapterUsabilityBadge =
  | "supported"
  | "partial"
  | "unsupported"
  | "identify_only"
  | "unknown";

export type CapabilityEvidenceStatus = "present" | "partial" | "missing" | "unknown";

export type AdapterCapabilityEvidenceSource = "public_fixture" | "private_local_aggregate";

export type CapabilityEvidenceLevels = Record<CapabilityLevel, CapabilityEvidenceStatus>;

export type AdapterCapabilityEvidenceSummary = {
  publicFixture: {
    present: boolean;
    fixtureIds: string[];
    evidenceKinds: string[];
    levels: CapabilityEvidenceLevels;
    limitations: string[];
  };
  privateLocalAggregate: {
    present: boolean;
    corpusCount: number;
    entryCount: number;
    markerKinds: string[];
    aggregateCounts: Record<string, number>;
    levels: CapabilityEvidenceLevels;
    limitations: string[];
  };
};

export type AdapterCapabilitySummary = {
  adapterId: string;
  badge: AdapterUsabilityBadge;
  identify: AdapterCapabilityMatrixRecord["identify"];
  inventory: AdapterCapabilityMatrixRecord["inventory"];
  extract: AdapterCapabilityMatrixRecord["extract"];
  patch: AdapterCapabilityMatrixRecord["patch"];
  evidence: AdapterCapabilityEvidenceSummary;
};

export type AdapterCapabilityEvidenceInput = {
  adapterId?: string;
  level?: CapabilityLevel;
  evidenceSource?: AdapterCapabilityEvidenceSource;
  source?: AdapterCapabilityEvidenceSource;
  evidenceKind?: string;
  kind?: string;
  status?: CapabilityEvidenceStatus;
  aggregateCounts?: Record<string, unknown>;
  evidenceLabels?: string[];
  markerKinds?: string[];
  limitations?: string[];
  publicFixtureId?: string;
  fixtureId?: string;
};

type AdapterMatrixWithEvidence =
  | AdapterCapabilityMatrixRecord
  | {
      matrix: AdapterCapabilityMatrixRecord;
      evidence?: ReadonlyArray<AdapterCapabilityEvidenceInput>;
    }
  | (AdapterCapabilityMatrixRecord & {
      evidence?: ReadonlyArray<AdapterCapabilityEvidenceInput>;
      capabilityEvidence?: ReadonlyArray<AdapterCapabilityEvidenceInput>;
    });

type EngineCapabilityEvidenceRepositoryPort = {
  listMatricesWithEvidence(): Promise<AdapterMatrixWithEvidence[]>;
};

export type EngineCapabilityReportPort = {
  /**
   * Strict gate: returns true iff the adapter is `Supported` at `level`.
   * Partial does NOT count.
   */
  isUsable(adapterId: string, level: CapabilityLevel): Promise<boolean>;

  /**
   * Returns the full per-adapter matrix and a `badge` summary suitable
   * for dashboard / CLI rendering.
   */
  listAdapterSummaries(): Promise<AdapterCapabilitySummary[]>;

  /**
   * Convenience: every adapter id whose status at `level` is strictly
   * `supported`, sorted ascending.
   */
  adaptersSupporting(level: CapabilityLevel): Promise<string[]>;

  /**
   * Record one adapter's typed 4-rung matrix. Mirrors the upstream
   * `EngineAdapter::capabilities().level_matrix`.
   */
  recordMatrix(matrix: AdapterCapabilityMatrixRecord): Promise<void>;
};

export class EngineCapabilityReportService implements EngineCapabilityReportPort {
  constructor(
    private readonly repository: EngineCapabilityReportRepository &
      Partial<EngineCapabilityEvidenceRepositoryPort>,
    private readonly actor: AuthorizationActor,
  ) {}

  async isUsable(adapterId: string, level: CapabilityLevel): Promise<boolean> {
    return this.repository.isAdapterUsable(adapterId, level);
  }

  async listAdapterSummaries(): Promise<AdapterCapabilitySummary[]> {
    if (typeof this.repository.listMatricesWithEvidence === "function") {
      const rows = await this.repository.listMatricesWithEvidence();
      return rows.map((row) => {
        const { matrix, evidence } = matrixAndEvidenceFromRepository(row);
        return toSummary(matrix, evidence);
      });
    }
    const matrices = await this.repository.listMatrices();
    return matrices.map((matrix) => toSummary(matrix));
  }

  async adaptersSupporting(level: CapabilityLevel): Promise<string[]> {
    return this.repository.adaptersSupporting(level);
  }

  async recordMatrix(matrix: AdapterCapabilityMatrixRecord): Promise<void> {
    await this.repository.writeMatrix(this.actor, matrix);
  }
}

/**
 * Pure transform used by the dashboard / CLI to compute the
 * "Identified only" badge per acceptance criterion 3.
 *
 * - `supported`     — every rung at or above Extract is Supported (a
 *   fully usable engine).
 * - `partial`       — Extract is Partial (engine extracts, but with
 *   caveats the consumer should surface).
 * - `identify_only` — Identify is Supported, but neither Extract nor
 *   Patch is.
 * - `unsupported`   — Identify is not Supported (effectively a no-op
 *   row, likely test data).
 * - `unknown`       — no rows recorded (matrix is null/missing).
 */
export function adapterBadge(matrix: AdapterCapabilityMatrixRecord): AdapterUsabilityBadge {
  if (matrix.identify.kind !== "supported") {
    return "unsupported";
  }
  if (matrix.extract.kind === "supported") {
    return "supported";
  }
  if (matrix.extract.kind === "partial") {
    return "partial";
  }
  return "identify_only";
}

export function toSummary(
  matrix: AdapterCapabilityMatrixRecord,
  evidence: ReadonlyArray<AdapterCapabilityEvidenceInput> = [],
): AdapterCapabilitySummary {
  return {
    adapterId: matrix.adapterId,
    badge: adapterBadge(matrix),
    identify: matrix.identify,
    inventory: matrix.inventory,
    extract: matrix.extract,
    patch: matrix.patch,
    evidence: summarizeCapabilityEvidence(matrix.adapterId, evidence),
  };
}

export const capabilityLevelOrder: ReadonlyArray<CapabilityLevel> = [
  capabilityLevelValues.identify,
  capabilityLevelValues.inventory,
  capabilityLevelValues.extract,
  capabilityLevelValues.patch,
];

export function emptyCapabilityEvidenceSummary(): AdapterCapabilityEvidenceSummary {
  return {
    publicFixture: {
      present: false,
      fixtureIds: [],
      evidenceKinds: [],
      levels: emptyEvidenceLevels(),
      limitations: [],
    },
    privateLocalAggregate: {
      present: false,
      corpusCount: 0,
      entryCount: 0,
      markerKinds: [],
      aggregateCounts: {},
      levels: emptyEvidenceLevels(),
      limitations: [],
    },
  };
}

export function summarizeCapabilityEvidence(
  adapterId: string,
  evidence: ReadonlyArray<AdapterCapabilityEvidenceInput>,
): AdapterCapabilityEvidenceSummary {
  const summary = emptyCapabilityEvidenceSummary();
  for (const row of evidence) {
    if (row.adapterId !== undefined && row.adapterId !== adapterId) {
      continue;
    }
    const source = row.evidenceSource ?? row.source;
    const status = normalizeEvidenceStatus(row.status);
    if (source === "public_fixture") {
      summary.publicFixture.present ||= status === "present" || status === "partial";
      appendSafeString(summary.publicFixture.evidenceKinds, row.evidenceKind ?? row.kind);
      appendSafeString(summary.publicFixture.fixtureIds, row.publicFixtureId ?? row.fixtureId);
      appendSafeTexts(summary.publicFixture.limitations, row.limitations);
      if (row.level !== undefined) {
        summary.publicFixture.levels[row.level] = status;
      }
    }
    if (source === "private_local_aggregate") {
      summary.privateLocalAggregate.present ||= status === "present" || status === "partial";
      if (row.level !== undefined) {
        summary.privateLocalAggregate.levels[row.level] = status;
      }
      appendSafeLabels(summary.privateLocalAggregate.markerKinds, row.evidenceLabels);
      appendSafeLabels(summary.privateLocalAggregate.markerKinds, row.markerKinds);
      appendSafePrivateLimitations(summary.privateLocalAggregate.limitations, row.limitations);
      mergeAggregateCounts(summary.privateLocalAggregate.aggregateCounts, row.aggregateCounts);
    }
  }
  summary.privateLocalAggregate.corpusCount =
    summary.privateLocalAggregate.aggregateCounts.corpusCount ?? 0;
  summary.privateLocalAggregate.entryCount =
    summary.privateLocalAggregate.aggregateCounts.entryCount ?? 0;
  return summary;
}

function matrixAndEvidenceFromRepository(row: AdapterMatrixWithEvidence): {
  matrix: AdapterCapabilityMatrixRecord;
  evidence: ReadonlyArray<AdapterCapabilityEvidenceInput>;
} {
  if ("matrix" in row) {
    return { matrix: row.matrix, evidence: row.evidence ?? [] };
  }
  const evidenceRow = row as AdapterCapabilityMatrixRecord & {
    evidence?: ReadonlyArray<AdapterCapabilityEvidenceInput>;
    capabilityEvidence?: ReadonlyArray<AdapterCapabilityEvidenceInput>;
  };
  return {
    matrix: row,
    evidence: evidenceRow.evidence ?? evidenceRow.capabilityEvidence ?? [],
  };
}

function emptyEvidenceLevels(): CapabilityEvidenceLevels {
  return {
    [capabilityLevelValues.identify]: "unknown",
    [capabilityLevelValues.inventory]: "unknown",
    [capabilityLevelValues.extract]: "unknown",
    [capabilityLevelValues.patch]: "unknown",
  };
}

function normalizeEvidenceStatus(status: CapabilityEvidenceStatus | undefined) {
  switch (status) {
    case "present":
    case "partial":
    case "missing":
    case "unknown":
      return status;
    default:
      return "unknown";
  }
}

function appendSafeString(target: string[], value: string | undefined): void {
  if (value === undefined || !isSafePublicEvidenceToken(value) || target.includes(value)) {
    return;
  }
  target.push(value);
  target.sort();
}

function appendSafeLabels(target: string[], values: string[] | undefined): void {
  if (values === undefined) {
    return;
  }
  for (const value of values) {
    if (isSafeAggregateLabel(value) && !target.includes(value)) {
      target.push(value);
    }
  }
  target.sort();
}

function appendSafeTexts(target: string[], values: string[] | undefined): void {
  if (values === undefined) {
    return;
  }
  for (const value of values) {
    if (isAggregateSafeText(value) && !target.includes(value)) {
      target.push(value);
    }
  }
  target.sort();
}

function appendSafePrivateLimitations(target: string[], values: string[] | undefined): void {
  if (values === undefined) {
    return;
  }
  for (const value of values) {
    if (isAllowedPrivateAggregateLimitation(value) && !target.includes(value)) {
      target.push(value);
    }
  }
  target.sort();
}

function mergeAggregateCounts(target: Record<string, number>, counts: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(counts)) {
    if (!isAllowedAggregateCountKey(key) || !isFiniteNonNegativeInteger(value)) {
      continue;
    }
    const numericValue = Number(value);
    target[key] = (target[key] ?? 0) + numericValue;
  }
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

function isAllowedAggregateCountKey(value: string): boolean {
  return [
    "corpusCount",
    "entryCount",
    "markerCount",
    "encryptedAssetCount",
    "systemJsonCount",
    "fileKindCount",
  ].includes(value);
}

function isSafePublicEvidenceToken(value: string): boolean {
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) && !looksLikePrivateLeak(value);
}

function isSafeAggregateLabel(value: string): boolean {
  return /^[a-z0-9_.:-]{1,96}$/.test(value) && !looksLikePrivateLeak(value);
}

function isAggregateSafeText(value: string): boolean {
  return value.length > 0 && value.length <= 180 && !looksLikePrivateLeak(value);
}

function isAllowedPrivateAggregateLimitation(value: string): boolean {
  return [
    "identify evidence only",
    "local scan aggregate evidence only; no adapter execution claimed",
    "local scan marker evidence only; no adapter execution claimed",
    "no adapter execution claimed",
    "private-local aggregate evidence only; no adapter execution claimed",
  ].includes(value);
}

function looksLikePrivateLeak(value: string): boolean {
  return [
    /(^|[\s"'=])\/(?:home|tmp|Users|Volumes|private|mnt|var)\b/i,
    /[a-z]:\\/i,
    /\\\\[^\\]+\\/,
    /\bfile:/i,
    /\b(pathHash|localScanEntryId|scanEntryId|rawText|rawSignal|signalBlob|SECRET_KEY)\b/i,
    /\b(screenshot|screen-shot|helper log|helper dump)\b/i,
    /\.(?:rpgmvp|rpgmvm|rpgmvo|rpgmvu)\b/i,
    /\b[\w.-]+\.(?:json|png|jpe?g|webp|ogg|m4a|txt)\b/i,
  ].some((pattern) => pattern.test(value));
}
