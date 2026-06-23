import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  type CapabilityLevel,
  type CapabilityLevelStatusKind,
  capabilityLevelStatusKindValues,
  capabilityLevelValues,
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
