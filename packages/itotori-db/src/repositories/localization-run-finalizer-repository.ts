// p0-core-terminal-run-finalizer — durable terminalization foundation.
//
// This repository owns the small set of facts that must move together at the
// end of every localization run: exact PatchVersion membership, one canonical
// summary projection, and the run-scoped finalizer outbox. Every patch member
// must point at a real persisted immutable result revision.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { verifyLocalizationArtifactManifest } from "../localization-artifact-integrity.js";
import {
  localizationJournalCostReservations,
  localizationJournalLlmAttempts,
  localizationJournalRunUnits,
  localizationJournalRuns,
  localizationResultRevisions,
  localizationPatchVersionUnits,
  localizationPatchVersions,
  localizationRunFinalizerOutbox,
  localizationRunTerminalSummaries,
  translationCandidates,
  type LocalizationRunFinalizerOutboxStatus,
  type LocalizationRunFinalizerStage,
  type LocalizationRunPatchVersionStatus,
  type LocalizationRunTerminalStatus,
  writtenQaFindings,
  writtenUnitOutcomes,
} from "../schema.js";
import type {
  LocalizationJournalCostReservationRecord,
  LocalizationJournalOperationalBlocker,
  LocalizationJournalRunLeaseIdentity,
  LocalizationJournalRunStatus,
} from "./localization-journal-repository.js";

export const LOCALIZATION_RUN_TERMINAL_SUMMARY_SCHEMA_VERSION =
  "itotori.localization-run-summary.v0.1";

export type LocalizationRunFinalizerJson = Record<string, unknown>;

export type LocalizationRunFinalizerRootCauseKind =
  | "completed"
  | "operational_blocker"
  | "cancelled"
  | "patch_fault"
  | "itotori_defect"
  | "finalizer_fault";

/** The first/root failure is retained even when cleanup itself also fails. */
export type LocalizationRunFinalizerRootCause = {
  kind: LocalizationRunFinalizerRootCauseKind;
  stage: LocalizationRunFinalizerStage | null;
  code: string;
  message: string;
};

/**
 * Public/canonical summary stages deliberately collapse the two physical patch
 * workers into the one terminalizer `patch` stage. The outbox retains
 * `patch_build` and `patch_apply` internally so each worker remains
 * independently idempotent; a summary never exposes two competing schemas.
 */
export const localizationRunTerminalSummaryStageValues = [
  "preflight",
  "provider",
  "unit",
  "persistence",
  "patch",
  "validation",
  "summary",
  "cleanup",
] as const;
export type LocalizationRunTerminalSummaryStage =
  (typeof localizationRunTerminalSummaryStageValues)[number];

export type LocalizationRunTerminalSummaryStageStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped";

export type LocalizationRunTerminalSummaryRootCause = {
  kind: LocalizationRunFinalizerRootCauseKind;
  stage: LocalizationRunTerminalSummaryStage | null;
  code: string;
  message: string;
};

export type LocalizationRunFinalizerRunRecord = {
  runId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  frozenScope: Record<string, unknown> | unknown[] | null;
  routingPolicy: Record<string, unknown> | null;
  costPolicy: Record<string, unknown> | null;
  status: LocalizationJournalRunStatus;
  pausedBlocker: LocalizationJournalOperationalBlocker | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: Date | null;
  fenceToken: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationRunFinalizerUnitRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string | null;
  unitOrdinal: number;
  state: "pending" | "claimed" | "written";
  nextAction: Record<string, unknown> | null;
};

export type LocalizationRunFinalizerOutcomeRecord = {
  journalOutcomeId: string;
  outcomeId: string;
  bridgeUnitId: string;
  selectedCandidateId: string;
  selectedCandidateBody: string | null;
  selectedCandidateValid: boolean;
  resultRevisionId: string | null;
};

export type LocalizationRunFinalizerAttemptRecord = {
  attemptId: string;
  bridgeUnitId: string;
  lifecycleState: "dispatching" | "completed";
  retryDecision: string | null;
  /** A completed retry request on a still-unwritten unit has no durable next result yet. */
  retryWaiting: boolean;
};

export type LocalizationRunFinalizerPatchUnitRecord = {
  bridgeUnitId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
  unitOrdinal: number;
};

export type LocalizationRunFinalizerPatchVersionRecord = {
  patchVersionId: string;
  runId: string;
  status: LocalizationRunPatchVersionStatus;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  playableAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  units: LocalizationRunFinalizerPatchUnitRecord[];
};

export type LocalizationRunFinalizerOutboxRecord = {
  runId: string;
  stage: LocalizationRunFinalizerStage;
  status: LocalizationRunFinalizerOutboxStatus;
  idempotencyKey: string;
  payload: LocalizationRunFinalizerJson;
  evidence: LocalizationRunFinalizerJson | null;
  attemptCount: number;
  availableAt: Date;
  lockedBy: string | null;
  lockedAt: Date | null;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationRunTerminalSummary = {
  schemaVersion: typeof LOCALIZATION_RUN_TERMINAL_SUMMARY_SCHEMA_VERSION;
  runId: string;
  summaryEpoch: number;
  terminalStatus: LocalizationRunTerminalStatus;
  rootCause: LocalizationRunTerminalSummaryRootCause;
  blocker: LocalizationJournalOperationalBlocker | null;
  coverage: {
    plannedUnitCount: number;
    writtenOutcomeCount: number;
    validSelectedCandidateCount: number;
    resultRevisionCount: number;
    missingUnitIds: string[];
    duplicateOutcomeUnitIds: string[];
  };
  attempts: {
    totalCount: number;
    runningCount: number;
    retryWaitingCount: number;
  };
  reservations: {
    totalCount: number;
    reconciledCount: number;
    unresolvedCount: number;
  };
  patch: {
    patchVersionId: string | null;
    exactFrozenScope: boolean;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
    playable: boolean;
  };
  stages: Array<{
    stage: LocalizationRunTerminalSummaryStage;
    status: LocalizationRunTerminalSummaryStageStatus;
    evidence: LocalizationRunFinalizerJson | null;
    error: string | null;
  }>;
  quality: {
    findingCount: number;
    contestedFindingCount: number;
  };
  cleanup: { error: string | null };
  generatedAt: string;
};

export type LocalizationRunTerminalSummaryRecord = {
  runId: string;
  terminalStatus: LocalizationRunTerminalStatus;
  summaryEpoch: number;
  summary: LocalizationRunTerminalSummary;
  terminalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type LocalizationRunFinalizerSnapshot = {
  run: LocalizationRunFinalizerRunRecord;
  units: LocalizationRunFinalizerUnitRecord[];
  outcomes: LocalizationRunFinalizerOutcomeRecord[];
  attempts: LocalizationRunFinalizerAttemptRecord[];
  reservations: LocalizationJournalCostReservationRecord[];
  patch: LocalizationRunFinalizerPatchVersionRecord | null;
  summary: LocalizationRunTerminalSummaryRecord | null;
  outbox: LocalizationRunFinalizerOutboxRecord[];
  quality: {
    findingCount: number;
    contestedFindingCount: number;
  };
};

export type EnsureLocalizationPatchVersionInput = {
  runId: string;
  /** Defaults deterministically to `patch-version:<runId>`. */
  patchVersionId?: string;
  /** Merged idempotently; conflicting values for the same key are rejected. */
  artifactHashes?: Record<string, string>;
  /** Merged idempotently; conflicting values for the same key are rejected. */
  artifactRefs?: Record<string, string>;
};

export type UpsertLocalizationRunFinalizerStageEvidenceInput = {
  runId: string;
  stage: LocalizationRunFinalizerStage;
  status: LocalizationRunFinalizerOutboxStatus;
  payload?: LocalizationRunFinalizerJson;
  evidence?: LocalizationRunFinalizerJson | null;
  lastError?: string | null;
  availableAt?: Date;
};

export type EnterLocalizationRunFinalizingInput = {
  runId: string;
  /** Required only while the run has a live executor lease. */
  lease?: LocalizationJournalRunLeaseIdentity;
};

export type TerminalizeLocalizationRunInput = {
  runId: string;
  terminalStatus: LocalizationRunTerminalStatus;
  /** Required for `succeeded`; defaults to the deterministic patch id when omitted. */
  patchVersionId?: string;
  /** Required only while the run has a live executor lease. */
  lease?: LocalizationJournalRunLeaseIdentity;
  /** Required for a paused terminalization unless the current paused blocker is retained. */
  blocker?: LocalizationJournalOperationalBlocker;
  rootCause?: LocalizationRunFinalizerRootCause;
  /** A resumed executor reached a new pause; replace rather than replay the prior pause epoch. */
  supersedePausedSummary?: boolean;
  /**
   * Explicit operator cancellation fences a live executor by atomically moving
   * its running/paused/finalizing run to `aborted` and clearing the lease. This
   * override is legal only for an `aborted` transition with a `cancelled` root
   * cause; every other terminalization remains lease-owned.
   */
  operatorCancellation?: boolean;
};

export type CompleteSucceededLocalizationRunInput = Omit<
  TerminalizeLocalizationRunInput,
  "terminalStatus"
>;

export interface ItotoriLocalizationRunFinalizerRepositoryPort {
  loadSnapshot(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRunFinalizerSnapshot | null>;
  loadTerminalSummary(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRunTerminalSummaryRecord | null>;
  enterFinalizing(
    actor: AuthorizationActor,
    input: EnterLocalizationRunFinalizingInput,
  ): Promise<LocalizationRunFinalizerRunRecord>;
  ensurePatchVersion(
    actor: AuthorizationActor,
    input: EnsureLocalizationPatchVersionInput,
  ): Promise<LocalizationRunFinalizerPatchVersionRecord>;
  upsertPatchStageEvidence(
    actor: AuthorizationActor,
    input: UpsertLocalizationRunFinalizerStageEvidenceInput,
  ): Promise<LocalizationRunFinalizerOutboxRecord>;
  /** Atomically stores one current canonical summary and moves to any terminal state. */
  terminalize(
    actor: AuthorizationActor,
    input: TerminalizeLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord>;
  /** Alias with an explicit name for non-success paths. */
  persistTerminalSummary(
    actor: AuthorizationActor,
    input: TerminalizeLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord>;
  /** Atomically marks a guarded patch playable, succeeds the run, and emits its summary outbox row. */
  completeSucceededRun(
    actor: AuthorizationActor,
    input: CompleteSucceededLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord>;
}

export class LocalizationRunFinalizerRepositoryError extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "invalid_input"
      | "coverage_incomplete"
      | "patch_conflict"
      | "stage_conflict"
      | "run_lease_lost"
      | "invalid_run_transition"
      | "summary_conflict",
    message: string,
  ) {
    super(message);
    this.name = "LocalizationRunFinalizerRepositoryError";
  }
}

type JournalTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

const patchWorkerStages: readonly LocalizationRunFinalizerStage[] = [
  "patch_build",
  "patch_apply",
  "validation",
];

/**
 * DB foundation for the all-path terminal finalizer. Writes use draft.write;
 * snapshot reads use catalog.read, matching the journal's authorization seam.
 */
export class ItotoriLocalizationRunFinalizerRepository implements ItotoriLocalizationRunFinalizerRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSnapshot(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRunFinalizerSnapshot | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    return loadSnapshotInTx(this.db, runId);
  }

  async loadTerminalSummary(
    actor: AuthorizationActor,
    runId: string,
  ): Promise<LocalizationRunTerminalSummaryRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    assertNonBlank(runId, "runId");
    return loadTerminalSummaryInTx(this.db, runId);
  }

  async enterFinalizing(
    actor: AuthorizationActor,
    input: EnterLocalizationRunFinalizingInput,
  ): Promise<LocalizationRunFinalizerRunRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    return this.db.transaction(async (tx) => {
      const run = await requireRunInTx(tx, input.runId);
      if (
        run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "aborted" ||
        run.status === "finalizing"
      ) {
        return run;
      }
      const rows = await tx
        .update(localizationJournalRuns)
        // `finalizing` itself is the durable run-level lock. Clear the
        // executor lease in the same fenced update: no resumer accepts a
        // finalizing run, so a long build/apply step cannot be overtaken after
        // the executor has drained its provider heartbeats.
        .set({
          status: "finalizing",
          pausedBlocker: null,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(localizationJournalRuns.runId, input.runId),
            inArray(localizationJournalRuns.status, ["running", "paused"]),
            terminalTransitionLeaseCondition(input.lease),
          ),
        )
        .returning();
      const row = rows[0];
      if (row === undefined) {
        const current = await requireRunInTx(tx, input.runId);
        if (current.status === "running" || current.status === "paused") {
          throw new LocalizationRunFinalizerRepositoryError(
            "run_lease_lost",
            `cannot enter finalizing for run ${input.runId}: executor lease changed or is not released`,
          );
        }
        throw new LocalizationRunFinalizerRepositoryError(
          "invalid_run_transition",
          `cannot enter finalizing for run ${input.runId} from ${current.status}`,
        );
      }
      return runFromRow(row);
    });
  }

  async ensurePatchVersion(
    actor: AuthorizationActor,
    input: EnsureLocalizationPatchVersionInput,
  ): Promise<LocalizationRunFinalizerPatchVersionRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    const patchVersionId = input.patchVersionId ?? patchVersionIdFor(input.runId);
    assertNonBlank(patchVersionId, "patchVersionId");
    const artifactHashes = normalizeStringRecord(input.artifactHashes ?? {}, "artifactHashes");
    const artifactRefs = normalizeStringRecord(input.artifactRefs ?? {}, "artifactRefs");

    return this.db.transaction(async (tx) => {
      await requireRunInTx(tx, input.runId);
      await tx.execute(sql`
        select run_id
        from itotori_localization_journal_runs
        where run_id = ${input.runId}
        for update
      `);
      const coverage = await loadCoverageRowsInTx(tx, input.runId);
      const incomplete = coverage.filter(
        (row) =>
          row.journalOutcomeId === null ||
          row.selectedCandidateId === null ||
          row.selectedCandidateBody === null ||
          row.selectedCandidateBody.trim().length === 0 ||
          row.resultRevisionId === null,
      );
      if (incomplete.length > 0) {
        throw new LocalizationRunFinalizerRepositoryError(
          "coverage_incomplete",
          `run ${input.runId} lacks a valid selected candidate and persisted result revision for ${incomplete
            .map((row) => row.bridgeUnitId)
            .join(", ")}`,
        );
      }

      // Serialize manifest/membership establishment against the success
      // barrier. Without this row lock, a writer can observe `building`, wait
      // behind terminalization, then append unverified refs after the patch
      // has become playable.
      await tx.execute(sql`
        select patch_version_id
        from itotori_localization_patch_versions
        where run_id = ${input.runId}
        for update
      `);

      const existingRows = await tx
        .select()
        .from(localizationPatchVersions)
        .where(eq(localizationPatchVersions.runId, input.runId))
        .limit(1);
      const existing = existingRows[0];
      if (existing !== undefined && existing.patchVersionId !== patchVersionId) {
        throw new LocalizationRunFinalizerRepositoryError(
          "patch_conflict",
          `run ${input.runId} already owns patch version ${existing.patchVersionId}`,
        );
      }

      if (existing === undefined) {
        await tx
          .insert(localizationPatchVersions)
          .values({
            patchVersionId,
            runId: input.runId,
            status: "building",
            artifactHashes,
            artifactRefs,
            playableAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
      } else {
        const mergedHashes = mergeStringRecords(existing.artifactHashes, artifactHashes, "hash");
        const mergedRefs = mergeStringRecords(existing.artifactRefs, artifactRefs, "artifact ref");
        const manifestChanged =
          !sameStringRecord(existing.artifactHashes, mergedHashes) ||
          !sameStringRecord(existing.artifactRefs, mergedRefs);
        if (manifestChanged && existing.status !== "building") {
          throw new LocalizationRunFinalizerRepositoryError(
            "patch_conflict",
            `cannot mutate artifact manifest for ${existing.status} patch ${patchVersionId}`,
          );
        }
        if (manifestChanged) {
          await tx
            .update(localizationPatchVersions)
            .set({ artifactHashes: mergedHashes, artifactRefs: mergedRefs, updatedAt: new Date() })
            .where(eq(localizationPatchVersions.patchVersionId, patchVersionId));
        }
      }

      const patchRows = await tx
        .select()
        .from(localizationPatchVersions)
        .where(eq(localizationPatchVersions.runId, input.runId))
        .limit(1);
      const patch = patchRows[0];
      if (patch === undefined || patch.patchVersionId !== patchVersionId) {
        throw new LocalizationRunFinalizerRepositoryError(
          "patch_conflict",
          `could not establish deterministic patch version ${patchVersionId}`,
        );
      }

      if (patch.status === "failed") {
        throw new LocalizationRunFinalizerRepositoryError(
          "patch_conflict",
          `cannot add membership to failed patch version ${patchVersionId}`,
        );
      }

      await tx
        .insert(localizationPatchVersionUnits)
        .values(
          coverage.map((row) => ({
            patchVersionId,
            runId: input.runId,
            bridgeUnitId: row.bridgeUnitId,
            journalOutcomeId: row.journalOutcomeId!,
            resultRevisionId: row.resultRevisionId!,
            unitOrdinal: row.unitOrdinal,
            createdAt: new Date(),
          })),
        )
        .onConflictDoNothing();

      const members = await tx
        .select()
        .from(localizationPatchVersionUnits)
        .where(eq(localizationPatchVersionUnits.patchVersionId, patchVersionId))
        .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
      assertExactPatchMembership(input.runId, patchVersionId, coverage, members);

      for (const stage of patchWorkerStages) {
        await insertOutboxIfMissingInTx(tx, input.runId, stage, {});
      }

      return patchVersionFromRows(patch, members);
    });
  }

  async upsertPatchStageEvidence(
    actor: AuthorizationActor,
    input: UpsertLocalizationRunFinalizerStageEvidenceInput,
  ): Promise<LocalizationRunFinalizerOutboxRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    const suppliedPayload =
      input.payload === undefined ? undefined : normalizeJsonRecord(input.payload, "payload");
    const suppliedEvidence =
      input.evidence === undefined
        ? undefined
        : input.evidence === null
          ? null
          : normalizeJsonRecord(input.evidence, "evidence");
    const lastError = input.lastError === undefined ? null : input.lastError;
    if (lastError !== null) assertNonBlank(lastError, "lastError");

    return this.db.transaction(async (tx) => {
      await requireRunInTx(tx, input.runId);
      const existingRows = await tx
        .select()
        .from(localizationRunFinalizerOutbox)
        .where(
          and(
            eq(localizationRunFinalizerOutbox.runId, input.runId),
            eq(localizationRunFinalizerOutbox.stage, input.stage),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing === undefined) {
        await insertOutboxIfMissingInTx(tx, input.runId, input.stage, suppliedPayload ?? {}, {
          status: input.status,
          evidence: suppliedEvidence ?? null,
          lastError,
          ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
        });
      } else {
        // Worker completion generally carries only evidence/status. In
        // particular, never replace the canonical summary outbox payload with
        // `{}` just because a summary publisher omitted a payload argument.
        const payload = suppliedPayload ?? existing.payload;
        const evidence = suppliedEvidence === undefined ? existing.evidence : suppliedEvidence;
        // Summary delivery is the one deliberately retryable terminal-looking
        // worker state: a prior filesystem/object-store failure must not make
        // the canonical summary impossible to project on a later attempt.
        const terminalExisting =
          existing.status === "succeeded" ||
          (existing.status === "failed" && input.stage !== "summary");
        if (terminalExisting && existing.status !== input.status) {
          throw new LocalizationRunFinalizerRepositoryError(
            "stage_conflict",
            `stage ${input.stage} for run ${input.runId} is already ${existing.status}`,
          );
        }
        if (terminalExisting && !sameJson(existing.payload, payload)) {
          throw new LocalizationRunFinalizerRepositoryError(
            "stage_conflict",
            `stage ${input.stage} for run ${input.runId} has conflicting idempotent payload`,
          );
        }
        if (!terminalExisting) {
          const beginsAttempt = input.status === "running" && existing.status !== "running";
          await tx
            .update(localizationRunFinalizerOutbox)
            .set({
              status: input.status,
              payload,
              evidence,
              lastError,
              availableAt: input.availableAt ?? existing.availableAt,
              attemptCount: existing.attemptCount + (beginsAttempt ? 1 : 0),
              completedAt:
                input.status === "succeeded" || input.status === "failed" ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(localizationRunFinalizerOutbox.runId, input.runId),
                eq(localizationRunFinalizerOutbox.stage, input.stage),
              ),
            );
        }
      }
      const rows = await tx
        .select()
        .from(localizationRunFinalizerOutbox)
        .where(
          and(
            eq(localizationRunFinalizerOutbox.runId, input.runId),
            eq(localizationRunFinalizerOutbox.stage, input.stage),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new Error("finalizer outbox write unexpectedly disappeared");
      return outboxFromRow(row);
    });
  }

  async terminalize(
    actor: AuthorizationActor,
    input: TerminalizeLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertNonBlank(input.runId, "runId");
    return this.db.transaction(async (tx) => terminalizeInTx(tx, input));
  }

  async persistTerminalSummary(
    actor: AuthorizationActor,
    input: TerminalizeLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord> {
    return this.terminalize(actor, input);
  }

  async completeSucceededRun(
    actor: AuthorizationActor,
    input: CompleteSucceededLocalizationRunInput,
  ): Promise<LocalizationRunTerminalSummaryRecord> {
    return this.terminalize(actor, { ...input, terminalStatus: "succeeded" });
  }
}

async function terminalizeInTx(
  tx: JournalTransaction,
  input: TerminalizeLocalizationRunInput,
): Promise<LocalizationRunTerminalSummaryRecord> {
  if (input.supersedePausedSummary === true && input.terminalStatus !== "paused") {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_input",
      "supersedePausedSummary is legal only for a paused terminalization",
    );
  }
  if (
    input.operatorCancellation === true &&
    (input.terminalStatus !== "aborted" || input.rootCause?.kind !== "cancelled")
  ) {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_input",
      "operatorCancellation requires terminalStatus=aborted and rootCause.kind=cancelled",
    );
  }
  const run = await requireRunInTx(tx, input.runId);
  if (input.operatorCancellation !== true) {
    await assertTerminalLeaseInTx(tx, run, input.lease);
  }
  const existingSummary = await loadTerminalSummaryInTx(tx, input.runId);

  if (
    (run.status === "succeeded" || run.status === "failed" || run.status === "aborted") &&
    run.status === input.terminalStatus
  ) {
    if (existingSummary === null) {
      throw new LocalizationRunFinalizerRepositoryError(
        "summary_conflict",
        `terminal run ${input.runId} has no canonical summary`,
      );
    }
    return existingSummary;
  }
  // A released paused run is the common all-path operational-blocker exit.
  // Replaying its finalizer must preserve the first durable blocker/summary,
  // rather than minting a new epoch for the same pause.
  if (
    run.status === "paused" &&
    input.terminalStatus === "paused" &&
    existingSummary !== null &&
    input.supersedePausedSummary !== true
  ) {
    return existingSummary;
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "aborted") {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_run_transition",
      `cannot transition terminal run ${input.runId} from ${run.status} to ${input.terminalStatus}`,
    );
  }

  let patchVersion: LocalizationRunFinalizerPatchVersionRecord | null = null;
  if (input.terminalStatus === "succeeded") {
    const patchVersionId = input.patchVersionId ?? patchVersionIdFor(input.runId);
    await tx.execute(sql`
      select patch_version_id
      from itotori_localization_patch_versions
      where run_id = ${input.runId}
        and patch_version_id = ${patchVersionId}
      for update
    `);
    const patchRows = await tx
      .select()
      .from(localizationPatchVersions)
      .where(
        and(
          eq(localizationPatchVersions.runId, input.runId),
          eq(localizationPatchVersions.patchVersionId, patchVersionId),
        ),
      )
      .limit(1);
    const patch = patchRows[0];
    if (patch === undefined) {
      throw new LocalizationRunFinalizerRepositoryError(
        "coverage_incomplete",
        `succeeded run ${input.runId} requires patch version ${patchVersionId}`,
      );
    }
    if (patch.status === "failed") {
      throw new LocalizationRunFinalizerRepositoryError(
        "patch_conflict",
        `succeeded run ${input.runId} cannot use failed patch ${patchVersionId}`,
      );
    }
    const members = await tx
      .select()
      .from(localizationPatchVersionUnits)
      .where(eq(localizationPatchVersionUnits.patchVersionId, patchVersionId))
      .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
    await assertSuccessBarrierInTx(tx, input.runId, patch, members);
    await tx
      .update(localizationPatchVersions)
      .set({ status: "playable", playableAt: new Date(), updatedAt: new Date() })
      .where(eq(localizationPatchVersions.patchVersionId, patchVersionId));
    const playableRows = await tx
      .select()
      .from(localizationPatchVersions)
      .where(eq(localizationPatchVersions.patchVersionId, patchVersionId))
      .limit(1);
    patchVersion = patchVersionFromRows(playableRows[0]!, members);
  } else if (input.terminalStatus === "failed") {
    // A patchback/build/validation defect must not leave a misleading
    // `building` version behind. Paused operational runs intentionally retain
    // their building version for resume; terminal defects mark it failed.
    const patchRows = await tx
      .select()
      .from(localizationPatchVersions)
      .where(eq(localizationPatchVersions.runId, input.runId))
      .limit(1);
    const patch = patchRows[0];
    if (patch !== undefined && patch.status !== "playable") {
      await tx
        .update(localizationPatchVersions)
        .set({ status: "failed", playableAt: null, updatedAt: new Date() })
        .where(eq(localizationPatchVersions.patchVersionId, patch.patchVersionId));
      const members = await tx
        .select()
        .from(localizationPatchVersionUnits)
        .where(eq(localizationPatchVersionUnits.patchVersionId, patch.patchVersionId))
        .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
      const failedRows = await tx
        .select()
        .from(localizationPatchVersions)
        .where(eq(localizationPatchVersions.patchVersionId, patch.patchVersionId))
        .limit(1);
      patchVersion = patchVersionFromRows(failedRows[0]!, members);
    }
  }

  const blocker =
    input.terminalStatus === "paused" ? normalizeBlocker(input.blocker ?? run.pausedBlocker) : null;
  const rootCause = normalizeRootCause(
    input.rootCause ?? defaultRootCause(input.terminalStatus, blocker),
  );
  const updateRows = await tx
    .update(localizationJournalRuns)
    .set({
      status: input.terminalStatus,
      pausedBlocker: blocker,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationJournalRuns.runId, input.runId),
        inArray(localizationJournalRuns.status, ["running", "paused", "finalizing"]),
        // A finalizing run already owns the durable run-level lock. Direct
        // abort/pause paths still require either their live executor fence or
        // a deliberately released paused lease, so they cannot overwrite a
        // concurrent resume between read and terminal write.
        input.operatorCancellation === true
          ? sql`true`
          : run.status === "finalizing"
            ? eq(localizationJournalRuns.status, "finalizing")
            : terminalTransitionLeaseCondition(input.lease),
      ),
    )
    .returning();
  if (updateRows[0] === undefined) {
    const current = await requireRunInTx(tx, input.runId);
    if (input.operatorCancellation === true && current.status === "aborted") {
      const concurrentSummary = await loadTerminalSummaryInTx(tx, input.runId);
      if (concurrentSummary !== null) return concurrentSummary;
    }
    if (current.status === "running" || current.status === "paused") {
      throw new LocalizationRunFinalizerRepositoryError(
        "run_lease_lost",
        `cannot terminalize run ${input.runId}: executor lease changed or is not released`,
      );
    }
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_run_transition",
      `cannot terminalize run ${input.runId} from ${current.status}`,
    );
  }

  const epoch = existingSummary === null ? 1 : existingSummary.summaryEpoch + 1;
  const snapshot = await loadSnapshotInTx(tx, input.runId);
  if (snapshot === null) throw new Error("terminalized run disappeared");
  const summary = projectTerminalSummary(
    snapshot,
    input.terminalStatus,
    rootCause,
    epoch,
    patchVersion,
  );
  const now = new Date();
  if (existingSummary === null) {
    await tx.insert(localizationRunTerminalSummaries).values({
      runId: input.runId,
      terminalStatus: input.terminalStatus,
      summaryEpoch: epoch,
      summaryJson: summary,
      terminalizedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await tx
      .update(localizationRunTerminalSummaries)
      .set({
        terminalStatus: input.terminalStatus,
        summaryEpoch: epoch,
        summaryJson: summary,
        terminalizedAt: now,
        updatedAt: now,
      })
      .where(eq(localizationRunTerminalSummaries.runId, input.runId));
  }
  await upsertSummaryOutboxInTx(tx, input.runId, summary);
  const record = await loadTerminalSummaryInTx(tx, input.runId);
  if (record === null) throw new Error("terminal summary write unexpectedly disappeared");
  return record;
}

/** The coverage-only success barrier: QA rows are intentionally not read here. */
async function assertSuccessBarrierInTx(
  tx: JournalTransaction,
  runId: string,
  patch: typeof localizationPatchVersions.$inferSelect,
  members: Array<typeof localizationPatchVersionUnits.$inferSelect>,
): Promise<void> {
  const coverage = await loadCoverageRowsInTx(tx, runId);
  const incomplete = coverage.filter(
    (row) =>
      row.journalOutcomeId === null ||
      row.selectedCandidateId === null ||
      row.selectedCandidateBody === null ||
      row.selectedCandidateBody.trim().length === 0 ||
      row.resultRevisionId === null,
  );
  if (incomplete.length > 0) {
    throw new LocalizationRunFinalizerRepositoryError(
      "coverage_incomplete",
      `run ${runId} has incomplete coverage for ${incomplete.map((row) => row.bridgeUnitId).join(", ")}`,
    );
  }
  assertExactPatchMembership(runId, patch.patchVersionId, coverage, members);
  if (
    Object.keys(patch.artifactHashes).length === 0 ||
    Object.keys(patch.artifactRefs).length === 0
  ) {
    throw new LocalizationRunFinalizerRepositoryError(
      "coverage_incomplete",
      `succeeded run ${runId} requires patch artifact refs and hashes`,
    );
  }
  try {
    verifyLocalizationArtifactManifest(patch.artifactRefs, patch.artifactHashes);
  } catch (error) {
    throw new LocalizationRunFinalizerRepositoryError(
      "coverage_incomplete",
      `succeeded run ${runId} has an invalid patch artifact manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [attempts, reservations, stages] = await Promise.all([
    tx
      .select()
      .from(localizationJournalLlmAttempts)
      .where(eq(localizationJournalLlmAttempts.runId, runId)),
    tx
      .select()
      .from(localizationJournalCostReservations)
      .where(eq(localizationJournalCostReservations.runId, runId)),
    tx
      .select()
      .from(localizationRunFinalizerOutbox)
      .where(eq(localizationRunFinalizerOutbox.runId, runId)),
  ]);
  const writtenUnitIds = new Set(coverage.map((row) => row.bridgeUnitId));
  const liveAttempt = attempts.find(
    (attempt) =>
      attempt.lifecycleState === "dispatching" ||
      (attempt.retryDecision === "retry" && !writtenUnitIds.has(attempt.bridgeUnitId)),
  );
  if (liveAttempt !== undefined) {
    throw new LocalizationRunFinalizerRepositoryError(
      "coverage_incomplete",
      `succeeded run ${runId} still has live or retry-waiting attempt ${liveAttempt.attemptId}`,
    );
  }
  const unresolvedReservation = reservations.find(
    (reservation) => reservation.state !== "reconciled",
  );
  if (unresolvedReservation !== undefined) {
    throw new LocalizationRunFinalizerRepositoryError(
      "coverage_incomplete",
      `succeeded run ${runId} has unresolved reservation ${unresolvedReservation.reservationId}`,
    );
  }
  const stageByName = new Map(stages.map((stage) => [stage.stage, stage.status]));
  for (const stage of patchWorkerStages) {
    if (stageByName.get(stage) !== "succeeded") {
      throw new LocalizationRunFinalizerRepositoryError(
        "coverage_incomplete",
        `succeeded run ${runId} requires successful ${stage} evidence`,
      );
    }
  }
}

async function loadSnapshotInTx(
  db: Pick<ItotoriDatabase, "select"> | JournalTransaction,
  runId: string,
): Promise<LocalizationRunFinalizerSnapshot | null> {
  const runRows = await db
    .select()
    .from(localizationJournalRuns)
    .where(eq(localizationJournalRuns.runId, runId))
    .limit(1);
  const runRow = runRows[0];
  if (runRow === undefined) return null;
  const [
    unitRows,
    coverageRows,
    attemptRows,
    reservationRows,
    patchRows,
    outboxRows,
    summary,
    qualityRows,
  ] = await Promise.all([
    db
      .select()
      .from(localizationJournalRunUnits)
      .where(eq(localizationJournalRunUnits.runId, runId))
      .orderBy(asc(localizationJournalRunUnits.unitOrdinal)),
    loadCoverageRowsInTx(db, runId),
    db
      .select()
      .from(localizationJournalLlmAttempts)
      .where(eq(localizationJournalLlmAttempts.runId, runId))
      .orderBy(
        asc(localizationJournalLlmAttempts.bridgeUnitId),
        asc(localizationJournalLlmAttempts.logicalCallId),
        asc(localizationJournalLlmAttempts.attemptIndex),
      ),
    db
      .select()
      .from(localizationJournalCostReservations)
      .where(eq(localizationJournalCostReservations.runId, runId))
      .orderBy(asc(localizationJournalCostReservations.createdAt)),
    db
      .select()
      .from(localizationPatchVersions)
      .where(eq(localizationPatchVersions.runId, runId))
      .limit(1),
    db
      .select()
      .from(localizationRunFinalizerOutbox)
      .where(eq(localizationRunFinalizerOutbox.runId, runId))
      .orderBy(asc(localizationRunFinalizerOutbox.stage)),
    loadTerminalSummaryInTx(db, runId),
    db
      .select({
        findingCount: sql<string>`count(*)::text`,
        contestedFindingCount: sql<string>`count(*) filter (where ${writtenQaFindings.contested})::text`,
      })
      .from(writtenQaFindings)
      .innerJoin(
        writtenUnitOutcomes,
        eq(writtenQaFindings.journalOutcomeId, writtenUnitOutcomes.journalOutcomeId),
      )
      .where(eq(writtenUnitOutcomes.runId, runId)),
  ]);
  const patchRow = patchRows[0];
  const memberRows =
    patchRow === undefined
      ? []
      : await db
          .select()
          .from(localizationPatchVersionUnits)
          .where(eq(localizationPatchVersionUnits.patchVersionId, patchRow.patchVersionId))
          .orderBy(asc(localizationPatchVersionUnits.unitOrdinal));
  const writtenUnitIds = new Set(
    coverageRows.filter((row) => row.journalOutcomeId !== null).map((row) => row.bridgeUnitId),
  );
  const quality = qualityRows[0] ?? { findingCount: "0", contestedFindingCount: "0" };
  return {
    run: runFromRow(runRow),
    units: unitRows.map((row) => ({
      bridgeUnitId: row.bridgeUnitId,
      sourceUnitKey: row.sourceUnitKey,
      unitOrdinal: row.unitOrdinal,
      state: row.state as LocalizationRunFinalizerUnitRecord["state"],
      nextAction: (row.nextAction as Record<string, unknown> | null) ?? null,
    })),
    outcomes: coverageRows
      .filter((row) => row.journalOutcomeId !== null)
      .map((row) => ({
        journalOutcomeId: row.journalOutcomeId!,
        outcomeId: row.outcomeId!,
        bridgeUnitId: row.bridgeUnitId,
        selectedCandidateId: row.selectedCandidateId!,
        selectedCandidateBody: row.selectedCandidateBody,
        selectedCandidateValid:
          row.selectedCandidateId !== null &&
          row.selectedCandidateBody !== null &&
          row.selectedCandidateBody.trim().length > 0,
        resultRevisionId: row.resultRevisionId,
      })),
    attempts: attemptRows.map((row) => ({
      attemptId: row.attemptId,
      bridgeUnitId: row.bridgeUnitId,
      lifecycleState: row.lifecycleState as "dispatching" | "completed",
      retryDecision: row.retryDecision,
      retryWaiting: row.retryDecision === "retry" && !writtenUnitIds.has(row.bridgeUnitId),
    })),
    reservations: reservationRows.map((row) => ({
      reservationId: row.reservationId,
      runId: row.runId,
      attemptId: row.attemptId,
      reservedUsd: row.reservedUsd,
      reconciledUsd: row.reconciledUsd,
      state: row.state,
      createdAt: row.createdAt,
      reconciledAt: row.reconciledAt,
    })),
    patch: patchRow === undefined ? null : patchVersionFromRows(patchRow, memberRows),
    summary,
    outbox: outboxRows.map(outboxFromRow),
    quality: {
      findingCount: Number(quality.findingCount),
      contestedFindingCount: Number(quality.contestedFindingCount),
    },
  };
}

type CoverageRow = {
  bridgeUnitId: string;
  unitOrdinal: number;
  journalOutcomeId: string | null;
  outcomeId: string | null;
  selectedCandidateId: string | null;
  selectedCandidateBody: string | null;
  resultRevisionId: string | null;
};

async function loadCoverageRowsInTx(
  db: Pick<ItotoriDatabase, "select"> | JournalTransaction,
  runId: string,
): Promise<CoverageRow[]> {
  return db
    .select({
      bridgeUnitId: localizationJournalRunUnits.bridgeUnitId,
      unitOrdinal: localizationJournalRunUnits.unitOrdinal,
      journalOutcomeId: writtenUnitOutcomes.journalOutcomeId,
      outcomeId: writtenUnitOutcomes.outcomeId,
      selectedCandidateId: writtenUnitOutcomes.selectedCandidateId,
      selectedCandidateBody: translationCandidates.body,
      resultRevisionId: localizationResultRevisions.resultRevisionId,
    })
    .from(localizationJournalRunUnits)
    .leftJoin(
      writtenUnitOutcomes,
      and(
        eq(localizationJournalRunUnits.runId, writtenUnitOutcomes.runId),
        eq(localizationJournalRunUnits.bridgeUnitId, writtenUnitOutcomes.bridgeUnitId),
      ),
    )
    .leftJoin(
      translationCandidates,
      and(
        eq(translationCandidates.journalOutcomeId, writtenUnitOutcomes.journalOutcomeId),
        eq(translationCandidates.candidateId, writtenUnitOutcomes.selectedCandidateId),
      ),
    )
    .leftJoin(
      localizationResultRevisions,
      and(
        eq(localizationResultRevisions.journalOutcomeId, writtenUnitOutcomes.journalOutcomeId),
        eq(localizationResultRevisions.runId, localizationJournalRunUnits.runId),
        eq(localizationResultRevisions.bridgeUnitId, localizationJournalRunUnits.bridgeUnitId),
        eq(
          localizationResultRevisions.selectedCandidateId,
          writtenUnitOutcomes.selectedCandidateId,
        ),
      ),
    )
    .where(eq(localizationJournalRunUnits.runId, runId))
    .orderBy(asc(localizationJournalRunUnits.unitOrdinal));
}

async function loadTerminalSummaryInTx(
  db: Pick<ItotoriDatabase, "select"> | JournalTransaction,
  runId: string,
): Promise<LocalizationRunTerminalSummaryRecord | null> {
  const rows = await db
    .select()
    .from(localizationRunTerminalSummaries)
    .where(eq(localizationRunTerminalSummaries.runId, runId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : terminalSummaryFromRow(row);
}

async function requireRunInTx(
  tx: JournalTransaction,
  runId: string,
): Promise<LocalizationRunFinalizerRunRecord> {
  const snapshot = await loadSnapshotInTx(tx, runId);
  if (snapshot === null) {
    throw new LocalizationRunFinalizerRepositoryError(
      "run_not_found",
      `run ${runId} does not exist`,
    );
  }
  return snapshot.run;
}

async function assertTerminalLeaseInTx(
  tx: JournalTransaction,
  run: LocalizationRunFinalizerRunRecord,
  lease: LocalizationJournalRunLeaseIdentity | undefined,
): Promise<void> {
  const rows = await tx.execute(sql<{ lease_live: boolean }>`
    select (lease_expires_at is not null and lease_expires_at > now()) as lease_live
    from itotori_localization_journal_runs
    where run_id = ${run.runId}
  `);
  const leaseLive = rows.rows[0]?.lease_live === true;
  if (!leaseLive) return;
  if (
    lease === undefined ||
    lease.ownerId !== run.leaseOwnerId ||
    lease.fenceToken !== run.fenceToken
  ) {
    throw new LocalizationRunFinalizerRepositoryError(
      "run_lease_lost",
      `live executor lease must be held to terminalize run ${run.runId}`,
    );
  }
}

/**
 * Guard a terminalizer write at the same statement boundary as its state
 * transition. A prior read/check alone is not safe: a resumer may acquire a
 * new fence between that read and the update.
 */
function terminalTransitionLeaseCondition(lease: LocalizationJournalRunLeaseIdentity | undefined) {
  if (lease === undefined) {
    return sql`${localizationJournalRuns.leaseOwnerId} is null and ${localizationJournalRuns.leaseExpiresAt} is null`;
  }
  return sql`${localizationJournalRuns.leaseOwnerId} = ${lease.ownerId}
    and ${localizationJournalRuns.fenceToken} = ${lease.fenceToken}
    and ${localizationJournalRuns.leaseExpiresAt} > now()`;
}

async function insertOutboxIfMissingInTx(
  tx: JournalTransaction,
  runId: string,
  stage: LocalizationRunFinalizerStage,
  payload: LocalizationRunFinalizerJson,
  options?: {
    status?: LocalizationRunFinalizerOutboxStatus;
    evidence?: LocalizationRunFinalizerJson | null;
    lastError?: string | null;
    availableAt?: Date;
  },
): Promise<void> {
  const status = options?.status ?? "pending";
  const now = new Date();
  await tx
    .insert(localizationRunFinalizerOutbox)
    .values({
      runId,
      stage,
      status,
      idempotencyKey: outboxIdempotencyKeyFor(runId, stage),
      payload,
      evidence: options?.evidence ?? null,
      attemptCount: status === "running" ? 1 : 0,
      availableAt: options?.availableAt ?? now,
      lockedBy: null,
      lockedAt: null,
      leaseExpiresAt: null,
      completedAt: status === "succeeded" || status === "failed" ? now : null,
      lastError: options?.lastError ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function upsertSummaryOutboxInTx(
  tx: JournalTransaction,
  runId: string,
  summary: LocalizationRunTerminalSummary,
): Promise<void> {
  const existingRows = await tx
    .select()
    .from(localizationRunFinalizerOutbox)
    .where(
      and(
        eq(localizationRunFinalizerOutbox.runId, runId),
        eq(localizationRunFinalizerOutbox.stage, "summary"),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (existing === undefined) {
    await insertOutboxIfMissingInTx(tx, runId, "summary", summary);
    return;
  }
  if (sameJson(existing.payload, summary)) return;
  await tx
    .update(localizationRunFinalizerOutbox)
    .set({
      status: "pending",
      payload: summary,
      evidence: null,
      availableAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      leaseExpiresAt: null,
      completedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(localizationRunFinalizerOutbox.runId, runId),
        eq(localizationRunFinalizerOutbox.stage, "summary"),
      ),
    );
}

function projectTerminalSummary(
  snapshot: LocalizationRunFinalizerSnapshot,
  terminalStatus: LocalizationRunTerminalStatus,
  rootCause: LocalizationRunFinalizerRootCause,
  summaryEpoch: number,
  patchVersion: LocalizationRunFinalizerPatchVersionRecord | null,
): LocalizationRunTerminalSummary {
  const plannedIds = snapshot.units.map((unit) => unit.bridgeUnitId);
  const outcomesByUnit = new Map(
    snapshot.outcomes.map((outcome) => [outcome.bridgeUnitId, outcome]),
  );
  const missingUnitIds = plannedIds.filter((unitId) => {
    const outcome = outcomesByUnit.get(unitId);
    return (
      outcome === undefined || !outcome.selectedCandidateValid || outcome.resultRevisionId === null
    );
  });
  const patch = patchVersion ?? snapshot.patch;
  const patchIds = patch?.units.map((unit) => unit.bridgeUnitId) ?? [];
  const exactFrozenScope =
    patchIds.length === plannedIds.length &&
    patchIds.every((unitId, index) => unitId === plannedIds[index]);
  const stages = projectTerminalSummaryStages(snapshot.outbox);
  const cleanup = stages.find((stage) => stage.stage === "cleanup");
  return {
    schemaVersion: LOCALIZATION_RUN_TERMINAL_SUMMARY_SCHEMA_VERSION,
    runId: snapshot.run.runId,
    summaryEpoch,
    terminalStatus,
    rootCause: summaryRootCause(rootCause),
    blocker: terminalStatus === "paused" ? snapshot.run.pausedBlocker : null,
    coverage: {
      plannedUnitCount: plannedIds.length,
      writtenOutcomeCount: snapshot.outcomes.length,
      validSelectedCandidateCount: snapshot.outcomes.filter(
        (outcome) => outcome.selectedCandidateValid,
      ).length,
      resultRevisionCount: snapshot.outcomes.filter((outcome) => outcome.resultRevisionId !== null)
        .length,
      missingUnitIds,
      // `written_unit_outcomes` has a run/unit unique constraint, but the
      // field remains in the common schema so readers do not need a special
      // DB-only summary shape.
      duplicateOutcomeUnitIds: [],
    },
    attempts: {
      totalCount: snapshot.attempts.length,
      runningCount: snapshot.attempts.filter((attempt) => attempt.lifecycleState === "dispatching")
        .length,
      retryWaitingCount: snapshot.attempts.filter((attempt) => attempt.retryWaiting).length,
    },
    reservations: {
      totalCount: snapshot.reservations.length,
      reconciledCount: snapshot.reservations.filter(
        (reservation) => reservation.state === "reconciled",
      ).length,
      unresolvedCount: snapshot.reservations.filter(
        (reservation) => reservation.state !== "reconciled",
      ).length,
    },
    patch: {
      patchVersionId: patch?.patchVersionId ?? null,
      exactFrozenScope,
      artifactHashes: patch?.artifactHashes ?? {},
      artifactRefs: patch?.artifactRefs ?? {},
      playable: patch?.status === "playable",
    },
    stages,
    quality: {
      findingCount: snapshot.quality.findingCount,
      contestedFindingCount: snapshot.quality.contestedFindingCount,
    },
    cleanup: { error: cleanup?.error ?? null },
    generatedAt: new Date().toISOString(),
  };
}

function summaryRootCause(
  rootCause: LocalizationRunFinalizerRootCause,
): LocalizationRunTerminalSummaryRootCause {
  return {
    kind: rootCause.kind,
    stage:
      rootCause.stage === "patch_build" || rootCause.stage === "patch_apply"
        ? "patch"
        : rootCause.stage,
    code: rootCause.code,
    message: rootCause.message,
  };
}

function projectTerminalSummaryStages(
  outbox: LocalizationRunFinalizerOutboxRecord[],
): LocalizationRunTerminalSummary["stages"] {
  const byStage = new Map<
    LocalizationRunTerminalSummaryStage,
    LocalizationRunTerminalSummary["stages"][number]
  >();
  let patchBuild: LocalizationRunFinalizerOutboxRecord | undefined;
  let patchApply: LocalizationRunFinalizerOutboxRecord | undefined;
  for (const entry of outbox) {
    // Every newly-minted summary epoch still has to project its own payload.
    // Never inherit a prior epoch's successful delivery evidence into the new
    // canonical row before this epoch's summary worker has run.
    if (entry.stage === "summary") continue;
    if (entry.stage === "patch_build") {
      patchBuild = entry;
      continue;
    }
    if (entry.stage === "patch_apply") {
      patchApply = entry;
      continue;
    }
    const stage: LocalizationRunTerminalSummaryStage = entry.stage;
    const incoming = {
      stage,
      status: summaryStageStatus(entry.status),
      evidence: entry.evidence,
      error: entry.lastError,
    } satisfies LocalizationRunTerminalSummary["stages"][number];
    const current = byStage.get(stage);
    if (
      current === undefined ||
      summaryStageRank(incoming.status) >= summaryStageRank(current.status)
    ) {
      byStage.set(stage, incoming);
    }
  }
  const patch = projectCollapsedPatchStage(patchBuild, patchApply);
  if (patch !== null) byStage.set("patch", patch);
  return localizationRunTerminalSummaryStageValues.map(
    (stage) =>
      byStage.get(stage) ?? {
        stage,
        // The terminal summary itself is written before the outbox publisher
        // attempts its file projection, so `summary` starts pending by design.
        status: stage === "summary" ? "pending" : "skipped",
        evidence: null,
        error: null,
      },
  );
}

function projectCollapsedPatchStage(
  build: LocalizationRunFinalizerOutboxRecord | undefined,
  apply: LocalizationRunFinalizerOutboxRecord | undefined,
): LocalizationRunTerminalSummary["stages"][number] | null {
  if (build === undefined && apply === undefined) return null;
  const failed = [build, apply].find((entry) => entry?.status === "failed");
  if (failed !== undefined) return projectedPatchStage(failed, "failed");
  if (build?.status === "succeeded" && apply?.status === "succeeded") {
    return projectedPatchStage(apply, "succeeded");
  }
  const pending = [build, apply].find((entry) => entry?.status !== "succeeded");
  return projectedPatchStage(pending ?? apply ?? build!, "pending");
}

function projectedPatchStage(
  entry: LocalizationRunFinalizerOutboxRecord,
  status: LocalizationRunTerminalSummaryStageStatus,
): LocalizationRunTerminalSummary["stages"][number] {
  return {
    stage: "patch",
    status,
    evidence: entry.evidence,
    error: entry.lastError,
  };
}

function summaryStageStatus(
  status: LocalizationRunFinalizerOutboxStatus,
): LocalizationRunTerminalSummaryStageStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "pending";
}

function summaryStageRank(status: LocalizationRunTerminalSummaryStageStatus): number {
  return status === "failed" ? 4 : status === "succeeded" ? 3 : status === "pending" ? 2 : 1;
}

function assertExactPatchMembership(
  runId: string,
  patchVersionId: string,
  coverage: CoverageRow[],
  members: Array<typeof localizationPatchVersionUnits.$inferSelect>,
): void {
  if (coverage.length !== members.length) {
    throw new LocalizationRunFinalizerRepositoryError(
      "patch_conflict",
      `patch ${patchVersionId} has ${members.length} members for ${coverage.length} planned units`,
    );
  }
  for (let index = 0; index < coverage.length; index += 1) {
    const row = coverage[index]!;
    const member = members[index];
    if (
      member === undefined ||
      member.runId !== runId ||
      member.bridgeUnitId !== row.bridgeUnitId ||
      member.journalOutcomeId !== row.journalOutcomeId ||
      member.unitOrdinal !== row.unitOrdinal ||
      row.resultRevisionId === null ||
      member.resultRevisionId !== row.resultRevisionId
    ) {
      throw new LocalizationRunFinalizerRepositoryError(
        "patch_conflict",
        `patch ${patchVersionId} membership differs from frozen run scope at ${row.bridgeUnitId}`,
      );
    }
  }
}

function runFromRow(
  row: typeof localizationJournalRuns.$inferSelect,
): LocalizationRunFinalizerRunRecord {
  return {
    runId: row.runId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    targetLocale: row.targetLocale,
    frozenScope: row.frozenScope,
    routingPolicy: row.routingPolicy,
    costPolicy: row.costPolicy,
    status: row.status as LocalizationJournalRunStatus,
    pausedBlocker: row.pausedBlocker as LocalizationJournalOperationalBlocker | null,
    leaseOwnerId: row.leaseOwnerId,
    leaseExpiresAt: row.leaseExpiresAt,
    fenceToken: row.fenceToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function patchVersionFromRows(
  patch: typeof localizationPatchVersions.$inferSelect,
  members: Array<typeof localizationPatchVersionUnits.$inferSelect>,
): LocalizationRunFinalizerPatchVersionRecord {
  return {
    patchVersionId: patch.patchVersionId,
    runId: patch.runId,
    status: patch.status,
    artifactHashes: { ...patch.artifactHashes },
    artifactRefs: { ...patch.artifactRefs },
    playableAt: patch.playableAt,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
    units: members.map((member) => ({
      bridgeUnitId: member.bridgeUnitId,
      journalOutcomeId: member.journalOutcomeId,
      resultRevisionId: member.resultRevisionId,
      unitOrdinal: member.unitOrdinal,
    })),
  };
}

function outboxFromRow(
  row: typeof localizationRunFinalizerOutbox.$inferSelect,
): LocalizationRunFinalizerOutboxRecord {
  return {
    runId: row.runId,
    stage: row.stage,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    payload: { ...row.payload },
    evidence: row.evidence === null ? null : { ...row.evidence },
    attemptCount: row.attemptCount,
    availableAt: row.availableAt,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    completedAt: row.completedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function terminalSummaryFromRow(
  row: typeof localizationRunTerminalSummaries.$inferSelect,
): LocalizationRunTerminalSummaryRecord {
  const summary = row.summaryJson as LocalizationRunTerminalSummary;
  if (
    summary.schemaVersion !== LOCALIZATION_RUN_TERMINAL_SUMMARY_SCHEMA_VERSION ||
    summary.runId !== row.runId ||
    summary.terminalStatus !== row.terminalStatus ||
    summary.summaryEpoch !== row.summaryEpoch
  ) {
    throw new LocalizationRunFinalizerRepositoryError(
      "summary_conflict",
      `canonical terminal summary for run ${row.runId} is malformed`,
    );
  }
  return {
    runId: row.runId,
    terminalStatus: row.terminalStatus,
    summaryEpoch: row.summaryEpoch,
    summary,
    terminalizedAt: row.terminalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultRootCause(
  terminalStatus: LocalizationRunTerminalStatus,
  blocker: LocalizationJournalOperationalBlocker | null,
): LocalizationRunFinalizerRootCause {
  if (terminalStatus === "succeeded") {
    return {
      kind: "completed",
      stage: null,
      code: "coverage_complete",
      message: "frozen run scope is complete and the patch is playable",
    };
  }
  if (terminalStatus === "paused") {
    return {
      kind: "operational_blocker",
      stage: "preflight",
      code: blocker?.kind ?? "operational_blocker",
      message: blocker?.detail ?? "run is paused pending operator action",
    };
  }
  if (terminalStatus === "aborted") {
    return {
      kind: "cancelled",
      stage: null,
      code: "cancelled",
      message: "run was explicitly cancelled",
    };
  }
  return {
    kind: "finalizer_fault",
    stage: "cleanup",
    code: "terminal_failure",
    message: "run ended because of an irrecoverable finalizer or patch fault",
  };
}

function normalizeRootCause(
  rootCause: LocalizationRunFinalizerRootCause,
): LocalizationRunFinalizerRootCause {
  assertNonBlank(rootCause.code, "rootCause.code");
  assertNonBlank(rootCause.message, "rootCause.message");
  return { ...rootCause };
}

function normalizeBlocker(
  blocker: LocalizationJournalOperationalBlocker | null,
): LocalizationJournalOperationalBlocker {
  if (blocker === null) {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_input",
      "paused terminalization requires an operational blocker",
    );
  }
  assertNonBlank(blocker.detail, "blocker.detail");
  assertNonBlank(blocker.evidence, "blocker.evidence");
  assertNonBlank(blocker.raisedAt, "blocker.raisedAt");
  assertNonBlank(blocker.operatorAction, "blocker.operatorAction");
  return { ...blocker };
}

function normalizeStringRecord(
  value: Record<string, string>,
  label: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    assertNonBlank(key, `${label} key`);
    assertNonBlank(entry, `${label}.${key}`);
    output[key] = entry;
  }
  return output;
}

function normalizeJsonRecord(
  value: LocalizationRunFinalizerJson,
  label: string,
): LocalizationRunFinalizerJson {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_input",
      `${label} must be an object`,
    );
  }
  return { ...value };
}

function mergeStringRecords(
  current: Record<string, string>,
  incoming: Record<string, string>,
  label: string,
): Record<string, string> {
  const output = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (output[key] !== undefined && output[key] !== value) {
      throw new LocalizationRunFinalizerRepositoryError(
        "patch_conflict",
        `conflicting ${label} for ${key}`,
      );
    }
    output[key] = value;
  }
  return output;
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key])
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new LocalizationRunFinalizerRepositoryError(
      "invalid_input",
      `${label} must be non-blank`,
    );
  }
}

export function patchVersionIdFor(runId: string): string {
  return `patch-version:${runId}`;
}

export function outboxIdempotencyKeyFor(
  runId: string,
  stage: LocalizationRunFinalizerStage,
): string {
  return `localization-finalizer:${runId}:${stage}`;
}
