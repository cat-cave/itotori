import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  type CapabilityLevel,
  type CapabilityLevelStatusKind,
  type EngineCapabilityEvidenceKind,
  type EngineCapabilityEvidenceSource,
  type EngineCapabilityEvidenceStatus,
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  engineCapabilityEvidence,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
  engineCapabilityReports,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

// KAIFUU-053: capability-leveled engine detector registry.
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

function assertStatusShape(status: CapabilityLevelStatusInput, label: string): void {
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

function statusFor(matrix: AdapterCapabilityMatrixRecord, level: CapabilityLevel) {
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

export class EngineCapabilityReportRepository {
  constructor(private readonly db: ItotoriDatabase) {}

  /**
   * Upsert one adapter's full 4-rung matrix in a single transaction. The
   * matrix is validated against the same shape rules the Postgres CHECK
   * constraint enforces; rejection happens before any writes touch the
   * database.
   */
  async writeMatrix(
    actor: AuthorizationActor,
    matrix: AdapterCapabilityMatrixRecord,
  ): Promise<EngineCapabilityReportRow[]> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    if (typeof matrix.adapterId !== "string" || matrix.adapterId.length === 0) {
      throw new EngineCapabilityReportShapeError(
        "AdapterCapabilityMatrix.adapterId must be a non-empty string",
      );
    }
    for (const level of Object.values(capabilityLevelValues)) {
      assertStatusShape(statusFor(matrix, level), `AdapterCapabilityMatrix.${level}`);
    }

    return this.db.transaction(async (tx) => {
      const inserted: EngineCapabilityReportRow[] = [];
      for (const level of Object.values(capabilityLevelValues)) {
        const status = statusFor(matrix, level);
        const limitations = status.kind === "partial" ? status.limitations : [];
        const reason = status.kind === "unsupported" ? status.reason : null;
        const rows = await tx
          .insert(engineCapabilityReports)
          .values({
            engineCapabilityReportId: createUuid7(),
            adapterId: matrix.adapterId,
            level,
            statusKind: status.kind,
            limitations,
            reason,
          })
          .onConflictDoUpdate({
            target: [engineCapabilityReports.adapterId, engineCapabilityReports.level],
            set: {
              statusKind: status.kind,
              limitations,
              reason,
              reportedAt: new Date(),
            },
          })
          .returning();
        const row = rows[0];
        if (row) {
          inserted.push(toRow(row));
        }
      }
      return inserted;
    });
  }

  async recordCapabilityEvidence(
    actor: AuthorizationActor,
    input: CapabilityEvidenceInput,
  ): Promise<EngineCapabilityEvidenceRow> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    const value = normalizeCapabilityEvidenceInput(input);
    const rows = await this.db
      .insert(engineCapabilityEvidence)
      .values({
        engineCapabilityEvidenceId: createUuid7(),
        adapterId: value.adapterId,
        level: value.level,
        evidenceSource: value.evidenceSource,
        evidenceKind: value.evidenceKind,
        schemaVersion: value.schemaVersion,
        status: value.status,
        aggregateCounts: value.aggregateCounts,
        evidenceLabels: value.evidenceLabels,
        limitations: value.limitations,
        publicFixtureId: value.publicFixtureId,
        reportedAt: value.reportedAt,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new EngineCapabilityReportShapeError("Capability evidence insert returned no row");
    }
    return toEvidenceRow(row);
  }

  async readMatrix(adapterId: string): Promise<AdapterCapabilityMatrixRecord | null> {
    const rows = await this.db
      .select()
      .from(engineCapabilityReports)
      .where(eq(engineCapabilityReports.adapterId, adapterId));
    if (rows.length === 0) {
      return null;
    }
    const byLevel = new Map<CapabilityLevel, EngineCapabilityReportRow>();
    for (const raw of rows) {
      const row = toRow(raw);
      byLevel.set(row.level, row);
    }
    const decode = (level: CapabilityLevel): CapabilityLevelStatusInput => {
      const row = byLevel.get(level);
      if (!row) {
        return {
          kind: "unsupported",
          reason: `no capability report recorded for ${adapterId} at ${level}`,
        };
      }
      switch (row.statusKind) {
        case "supported":
          return { kind: "supported" };
        case "partial":
          return { kind: "partial", limitations: row.limitations };
        case "unsupported":
          return {
            kind: "unsupported",
            reason: row.reason ?? `unsupported capability report for ${adapterId} at ${level}`,
          };
      }
    };
    return {
      adapterId,
      identify: decode(capabilityLevelValues.identify),
      inventory: decode(capabilityLevelValues.inventory),
      extract: decode(capabilityLevelValues.extract),
      patch: decode(capabilityLevelValues.patch),
    };
  }

  async listMatrices(): Promise<AdapterCapabilityMatrixRecord[]> {
    const rows = await this.db.select().from(engineCapabilityReports);
    const byAdapter = new Map<string, EngineCapabilityReportRow[]>();
    for (const raw of rows) {
      const row = toRow(raw);
      const bucket = byAdapter.get(row.adapterId) ?? [];
      bucket.push(row);
      byAdapter.set(row.adapterId, bucket);
    }
    const matrices: AdapterCapabilityMatrixRecord[] = [];
    for (const adapterId of [...byAdapter.keys()].sort()) {
      const matrix = await this.readMatrix(adapterId);
      if (matrix !== null) {
        matrices.push(matrix);
      }
    }
    return matrices;
  }

  async listMatricesWithEvidence(): Promise<EngineCapabilityReadinessRecord[]> {
    const matrices = await this.listMatrices();
    const readModels: EngineCapabilityReadinessRecord[] = [];
    for (const matrix of matrices) {
      const readiness = await this.readCapabilityReadiness(matrix.adapterId);
      if (readiness !== null) {
        readModels.push(readiness);
      }
    }
    return readModels;
  }

  async readCapabilityReadiness(
    adapterId: string,
  ): Promise<EngineCapabilityReadinessRecord | null> {
    const matrix = await this.readMatrix(adapterId);
    if (matrix === null) {
      return null;
    }
    const evidenceRows = await this.db
      .select()
      .from(engineCapabilityEvidence)
      .where(eq(engineCapabilityEvidence.adapterId, adapterId));
    const evidenceByLevel = emptyEvidenceByLevel();
    for (const row of evidenceRows.map(toEvidenceRow).sort(compareEvidenceRows)) {
      evidenceBucket(evidenceByLevel[row.level], row.evidenceSource).push(row);
    }
    return {
      adapterId,
      matrix,
      evidenceByLevel,
    };
  }

  /**
   * Strict gate: returns true iff the adapter's status at `level` is
   * `supported`. Partial does NOT count.
   */
  async isAdapterUsable(adapterId: string, level: CapabilityLevel): Promise<boolean> {
    const rows = await this.db
      .select({ statusKind: engineCapabilityReports.statusKind })
      .from(engineCapabilityReports)
      .where(
        and(
          eq(engineCapabilityReports.adapterId, adapterId),
          eq(engineCapabilityReports.level, level),
        ),
      );
    const row = rows[0];
    return row?.statusKind === capabilityLevelStatusKindValues.supported;
  }

  /**
   * Returns every adapter id whose status at `level` is strictly
   * `supported`, sorted ascending.
   */
  async adaptersSupporting(level: CapabilityLevel): Promise<string[]> {
    const rows = await this.db
      .select({ adapterId: engineCapabilityReports.adapterId })
      .from(engineCapabilityReports)
      .where(
        and(
          eq(engineCapabilityReports.level, level),
          eq(engineCapabilityReports.statusKind, capabilityLevelStatusKindValues.supported),
        ),
      );
    return [...new Set(rows.map((row) => row.adapterId))].sort();
  }
}

function toRow(raw: typeof engineCapabilityReports.$inferSelect): EngineCapabilityReportRow {
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

function normalizeCapabilityEvidenceInput(
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

function toEvidenceRow(
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

function emptyEvidenceByLevel(): EngineCapabilityEvidenceByLevel {
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

function evidenceBucket(
  split: EngineCapabilityEvidenceSplit,
  source: EngineCapabilityEvidenceSource,
): EngineCapabilityEvidenceRow[] {
  if (source === engineCapabilityEvidenceSourceValues.publicFixture) {
    return split.publicFixture;
  }
  return split.privateLocalAggregate;
}

function compareEvidenceRows(
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
