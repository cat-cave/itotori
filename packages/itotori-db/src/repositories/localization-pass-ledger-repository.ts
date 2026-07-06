// itotori-multipass-pass-ledger / pass-ledger-production-wiring — DB-backed
// localization pass ledger repository.
//
// Persists one APPEND-ONLY row per localization pass on a locale branch
// (table `itotori_localization_pass_ledger`, migration 0058). This is the
// production store the orchestrator's `PassLedgerPort` binds to so a live pass
// N+1 run CONSUMES the persisted pass N (its accepted state + flagged-unit
// feedback) instead of re-drafting from scratch.
//
// Deliberately game-agnostic + generic: the repository stores the pass record
// BODY (inputs / outputs / accepted deltas / consumed feedback notes) verbatim
// as an opaque jsonb blob and promotes only the lineage + cost + ZDR columns
// it queries on. It knows nothing about the app's `LocalizationPassRecord`
// shape — the app adapter maps between the two — so this package stays free of
// any dependency on the orchestrator's types.
//
// Determinism: `recordPass` assigns `pass_number = max(pass_number) + 1` per
// branch inside the recording transaction; the unique index on
// (locale_branch_id, pass_number) is the hard guard against a concurrent
// double-record racing to the same number.

import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import { localizationPassLedger } from "../schema.js";

/**
 * A persisted localization-pass row, as the repository returns it. `passNumber`
 * + `priorPassNumber` carry the iteration lineage; `totalUsageCostUsd` is the
 * REAL summed usage.cost (PROJECT LAW — never fabricated); `recordBody` is the
 * verbatim generic record body the app adapter serialized in.
 */
export type LocalizationPassLedgerRecord = {
  passLedgerId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  passNumber: number;
  priorPassNumber?: number;
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  recordBody: Record<string, unknown>;
  recordedAt: Date;
};

/**
 * Input to `recordPass`. The repository assigns `passNumber` /
 * `priorPassNumber` deterministically from the branch's prior history — the
 * caller never supplies them.
 */
export type RecordLocalizationPassInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  recordedAt: Date;
  /** The REAL summed usage.cost (PROJECT LAW). A real zero is valid. */
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  /** The verbatim generic pass record body (opaque to this package). */
  recordBody: Record<string, unknown>;
};

export interface ItotoriLocalizationPassLedgerRepositoryPort {
  recordPass(
    actor: AuthorizationActor,
    input: RecordLocalizationPassInput,
  ): Promise<LocalizationPassLedgerRecord>;
  loadLatestPass(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassLedgerRecord | undefined>;
  loadPassesForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassLedgerRecord[]>;
}

export class LocalizationPassLedgerRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalizationPassLedgerRepositoryError";
  }
}

export class ItotoriLocalizationPassLedgerRepository implements ItotoriLocalizationPassLedgerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordPass(
    actor: AuthorizationActor,
    input: RecordLocalizationPassInput,
  ): Promise<LocalizationPassLedgerRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    if (input.totalUsageCostUsd < 0) {
      throw new LocalizationPassLedgerRepositoryError(
        `refusing to record a negative usage.cost (${input.totalUsageCostUsd}); cost comes only from real provider telemetry`,
      );
    }

    return this.db.transaction(async (tx) => {
      // Assign the pass number deterministically from the branch's prior
      // history (max + 1, else 1). The read + insert share the transaction so
      // a concurrent recorder cannot observe the same max; the unique index on
      // (locale_branch_id, pass_number) is the hard backstop.
      const priorRows = await tx
        .select()
        .from(localizationPassLedger)
        .where(eq(localizationPassLedger.localeBranchId, input.localeBranchId))
        .orderBy(desc(localizationPassLedger.passNumber))
        .limit(1);
      const priorPassNumber = priorRows[0]?.passNumber;
      const passNumber = (priorPassNumber ?? 0) + 1;

      const inserted = await tx
        .insert(localizationPassLedger)
        .values({
          passLedgerId: `localization-pass-${randomUUID()}`,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          passNumber,
          priorPassNumber: priorPassNumber ?? null,
          // Store the real decimal verbatim; `numeric` round-trips as a string.
          totalUsageCostUsd: String(input.totalUsageCostUsd),
          zdrConfirmed: input.zdrConfirmed,
          recordBody: input.recordBody,
          recordedAt: input.recordedAt,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new LocalizationPassLedgerRepositoryError(
          `localization pass row for branch ${input.localeBranchId} disappeared immediately after insert`,
        );
      }
      return rowToRecord(row);
    });
  }

  async loadLatestPass(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassLedgerRecord | undefined> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const rows = await this.db
      .select()
      .from(localizationPassLedger)
      .where(eq(localizationPassLedger.localeBranchId, localeBranchId))
      .orderBy(desc(localizationPassLedger.passNumber))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  async loadPassesForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassLedgerRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const rows = await this.db
      .select()
      .from(localizationPassLedger)
      .where(eq(localizationPassLedger.localeBranchId, localeBranchId))
      .orderBy(localizationPassLedger.passNumber);
    return rows.map(rowToRecord);
  }
}

function rowToRecord(
  row: typeof localizationPassLedger.$inferSelect,
): LocalizationPassLedgerRecord {
  return {
    passLedgerId: row.passLedgerId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    passNumber: row.passNumber,
    ...(row.priorPassNumber !== null ? { priorPassNumber: row.priorPassNumber } : {}),
    totalUsageCostUsd: Number(row.totalUsageCostUsd),
    zdrConfirmed: row.zdrConfirmed,
    recordBody: row.recordBody,
    recordedAt: row.recordedAt,
  };
}
