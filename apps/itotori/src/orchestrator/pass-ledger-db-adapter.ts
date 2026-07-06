// pass-ledger-production-wiring — the production `PassLedgerPort`, backed by
// the DB-persisted `itotori_localization_pass_ledger` table.
//
// `pass-ledger.ts` defines the orchestrator's `PassLedgerPort` (record + read
// the latest / the history) and an `InMemoryPassLedger` for tests. Production
// needs the SAME contract backed by a durable table so a live pass N+1 run
// CONSUMES the persisted pass N. This adapter is that binding: it wraps the
// `@itotori/db` `ItotoriLocalizationPassLedgerRepository` (table CRUD +
// deterministic pass-number assignment) and maps between the app's
// `LocalizationPassRecord` and the db repository's generic stored shape.
//
// The db repository is intentionally ignorant of the app's record type (it
// stores the generic body as opaque jsonb + promotes lineage/cost/ZDR columns),
// so the type dependency flows one way (app -> db) with no cycle. This adapter
// owns the (de)serialization of the record BODY (inputs / outputs / accepted
// deltas / consumed feedback notes) which is plain, Date-free JSON.
//
// Mirrors how `DrivenDbPersistenceAdapter` (project-driven-executor-sinks.ts)
// binds the draft / provider-run ports to real repositories.

import type {
  AuthorizationActor,
  ItotoriLocalizationPassLedgerRepositoryPort,
  LocalizationPassLedgerRecord,
} from "@itotori/db";
import type {
  AcceptedDelta,
  LocalizationPassInputs,
  LocalizationPassOutputs,
  LocalizationPassRecord,
  PassFeedbackNote,
  PassLedgerPort,
} from "./pass-ledger.js";

/**
 * The generic pass-record BODY the adapter stores as jsonb (everything the
 * ledger row's promoted columns do NOT already carry). Plain JSON — no `Date`
 * fields — so it round-trips byte-equal through jsonb.
 */
type StoredPassBody = {
  inputs: LocalizationPassInputs;
  outputs: LocalizationPassOutputs;
  acceptedDeltas: AcceptedDelta[];
  consumedFeedbackNotes: PassFeedbackNote[];
};

/**
 * DB-backed {@link PassLedgerPort}. `recordPass` appends a row (the db repo
 * assigns the deterministic `passNumber` / `priorPassNumber` inside its
 * transaction); the reads reconstruct the full `LocalizationPassRecord` from
 * the promoted columns + the stored body.
 */
export class DbPassLedger implements PassLedgerPort {
  constructor(private readonly repository: ItotoriLocalizationPassLedgerRepositoryPort) {}

  async recordPass(
    actor: AuthorizationActor,
    record: Omit<LocalizationPassRecord, "passNumber" | "priorPassNumber">,
  ): Promise<LocalizationPassRecord> {
    const body: StoredPassBody = {
      inputs: record.inputs,
      outputs: record.outputs,
      acceptedDeltas: record.acceptedDeltas,
      consumedFeedbackNotes: record.consumedFeedbackNotes,
    };
    const stored = await this.repository.recordPass(actor, {
      projectId: record.projectId,
      localeBranchId: record.localeBranchId,
      sourceRevisionId: record.sourceRevisionId,
      recordedAt: record.recordedAt,
      // PROJECT LAW: the REAL summed usage.cost the executor produced.
      totalUsageCostUsd: record.outputs.totalUsageCostUsd,
      zdrConfirmed: record.outputs.zdrConfirmed,
      recordBody: body as unknown as Record<string, unknown>,
    });
    return reconstruct(stored);
  }

  async loadLatestPass(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord | undefined> {
    const stored = await this.repository.loadLatestPass(actor, localeBranchId);
    return stored === undefined ? undefined : reconstruct(stored);
  }

  async loadPassesForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord[]> {
    const rows = await this.repository.loadPassesForBranch(actor, localeBranchId);
    return rows.map(reconstruct);
  }
}

function reconstruct(stored: LocalizationPassLedgerRecord): LocalizationPassRecord {
  const body = stored.recordBody as unknown as StoredPassBody;
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.inputs !== "object" ||
    typeof body.outputs !== "object" ||
    !Array.isArray(body.acceptedDeltas) ||
    !Array.isArray(body.consumedFeedbackNotes)
  ) {
    throw new Error(
      `pass-ledger-db-adapter: stored pass ${stored.passLedgerId} has a malformed record body`,
    );
  }
  return {
    passNumber: stored.passNumber,
    ...(stored.priorPassNumber !== undefined ? { priorPassNumber: stored.priorPassNumber } : {}),
    projectId: stored.projectId,
    localeBranchId: stored.localeBranchId,
    sourceRevisionId: stored.sourceRevisionId,
    recordedAt: stored.recordedAt,
    inputs: body.inputs,
    outputs: body.outputs,
    acceptedDeltas: body.acceptedDeltas,
    consumedFeedbackNotes: body.consumedFeedbackNotes,
  };
}
