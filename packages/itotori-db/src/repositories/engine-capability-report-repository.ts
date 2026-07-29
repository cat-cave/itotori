import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  type CapabilityLevel,
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
  engineCapabilityEvidence,
  engineCapabilityReports,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  assertStatusShape,
  compareEvidenceRows,
  emptyEvidenceByLevel,
  evidenceBucket,
  normalizeCapabilityEvidenceInput,
  statusFor,
  toEvidenceRow,
  toReportRow,
} from "./engine-capability-report-repository-evidence.js";
import {
  type AdapterCapabilityMatrixRecord,
  type CapabilityEvidenceInput,
  type CapabilityLevelStatusInput,
  EngineCapabilityReportShapeError,
  type EngineCapabilityEvidenceRow,
  type EngineCapabilityReadinessRecord,
  type EngineCapabilityReportRow,
} from "./engine-capability-report-repository-types.js";

export {
  capabilityEvidenceLabelValues,
  EngineCapabilityReportShapeError,
} from "./engine-capability-report-repository-types.js";
export type {
  AdapterCapabilityMatrixRecord,
  CapabilityEvidenceInput,
  CapabilityEvidenceLabel,
  CapabilityLevelStatusInput,
  EngineCapabilityEvidenceByLevel,
  EngineCapabilityEvidenceRow,
  EngineCapabilityEvidenceSplit,
  EngineCapabilityReadinessRecord,
  EngineCapabilityReportRow,
} from "./engine-capability-report-repository-types.js";

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
          inserted.push(toReportRow(row));
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
      const row = toReportRow(raw);
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
      const row = toReportRow(raw);
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
