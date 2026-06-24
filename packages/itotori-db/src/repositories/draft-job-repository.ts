import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  draftJobAttempts,
  draftJobAttemptStatusValues,
  draftJobs,
  draftJobStatusValues,
  type DraftJobAttemptStatus,
  type DraftJobContextRef,
  type DraftJobPolicyVersions,
  type DraftJobProtectedSpanRef,
  type DraftJobStatus,
} from "../schema.js";

export const draftJobStatusList: ReadonlyArray<DraftJobStatus> = [
  draftJobStatusValues.queued,
  draftJobStatusValues.running,
  draftJobStatusValues.succeeded,
  draftJobStatusValues.failed,
  draftJobStatusValues.retryable,
  draftJobStatusValues.cancelled,
];

export const draftJobAttemptStatusList: ReadonlyArray<DraftJobAttemptStatus> = [
  draftJobAttemptStatusValues.running,
  draftJobAttemptStatusValues.succeeded,
  draftJobAttemptStatusValues.failed,
  draftJobAttemptStatusValues.retryable,
  draftJobAttemptStatusValues.cancelled,
];

export class DraftJobRepositoryError extends Error {
  constructor(
    readonly code:
      | "draft_job_not_found"
      | "draft_job_attempt_not_found"
      | "draft_job_not_cancellable"
      | "draft_job_attempt_not_active",
    message: string,
  ) {
    super(message);
    this.name = "DraftJobRepositoryError";
  }
}

export type DraftJobInput = {
  projectId: string;
  localeBranchId: string;
  sourceUnitIds: string[];
  styleGuideVersion: string;
  glossaryVersion: string;
  policyVersions: DraftJobPolicyVersions;
  protectedSpanRefs?: DraftJobProtectedSpanRef[];
  contextRefs?: DraftJobContextRef[];
};

export type DraftJobRecord = {
  draftJobId: string;
  projectId: string;
  localeBranchId: string;
  bridgeUnitIds: string[];
  styleGuideVersion: string;
  glossaryVersion: string;
  protectedSpanRefs: DraftJobProtectedSpanRef[];
  policyVersions: DraftJobPolicyVersions;
  contextRefs: DraftJobContextRef[];
  status: DraftJobStatus;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordDraftJobAttemptInput = {
  attemptIndex: number;
  providerRunId?: string;
  startedAt: Date;
};

export type DraftJobAttemptRecord = {
  draftJobAttemptId: string;
  draftJobId: string;
  attemptIndex: number;
  providerRunId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  status: DraftJobAttemptStatus;
  failureReason: string | null;
  recordedProviderArtifactId: string | null;
  createdAt: Date;
};

export type LoadDraftJobsByProjectOptions = {
  statusFilter?: DraftJobStatus;
  limit?: number;
};

export interface ItotoriDraftJobRepositoryPort {
  createDraftJob(actor: AuthorizationActor, input: DraftJobInput): Promise<DraftJobRecord>;
  recordAttempt(
    actor: AuthorizationActor,
    draftJobId: string,
    attemptInput: RecordDraftJobAttemptInput,
  ): Promise<DraftJobAttemptRecord>;
  markAttemptSucceeded(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
    endedAt: Date,
    providerRunId?: string,
    recordedProviderArtifactId?: string,
  ): Promise<void>;
  markAttemptFailed(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
    failureReason: string,
    retryable: boolean,
    endedAt: Date,
  ): Promise<void>;
  cancelDraftJob(actor: AuthorizationActor, draftJobId: string): Promise<void>;
  loadDraftJob(actor: AuthorizationActor, draftJobId: string): Promise<DraftJobRecord | null>;
  loadDraftJobsByProject(
    actor: AuthorizationActor,
    projectId: string,
    opts?: LoadDraftJobsByProjectOptions,
  ): Promise<DraftJobRecord[]>;
  loadDraftJobAttempts(
    actor: AuthorizationActor,
    draftJobId: string,
  ): Promise<DraftJobAttemptRecord[]>;
}

const CANCELLABLE_PARENT_STATUSES: ReadonlyArray<DraftJobStatus> = [
  draftJobStatusValues.queued,
  draftJobStatusValues.running,
  draftJobStatusValues.retryable,
];

const ACTIVE_ATTEMPT_STATUSES: ReadonlyArray<DraftJobAttemptStatus> = [
  draftJobAttemptStatusValues.running,
];

export class ItotoriDraftJobRepository implements ItotoriDraftJobRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async createDraftJob(actor: AuthorizationActor, input: DraftJobInput): Promise<DraftJobRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.sourceUnitIds.length === 0) {
      throw new DraftJobRepositoryError(
        "draft_job_not_found",
        "draft job must reference at least one source unit",
      );
    }

    const draftJobId = `draft-job-${randomUUID()}`;
    const protectedSpanRefs = input.protectedSpanRefs ?? [];
    const contextRefs = input.contextRefs ?? [];
    const now = new Date();

    await this.db.insert(draftJobs).values({
      draftJobId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      bridgeUnitIds: input.sourceUnitIds,
      styleGuideVersion: input.styleGuideVersion,
      glossaryVersion: input.glossaryVersion,
      protectedSpanRefs,
      policyVersions: input.policyVersions,
      contextRefs,
      status: draftJobStatusValues.queued,
      createdAt: now,
      updatedAt: now,
    });

    const persisted = await this.fetchDraftJob(draftJobId);
    if (persisted === null) {
      throw new DraftJobRepositoryError(
        "draft_job_not_found",
        `failed to load draft job ${draftJobId} after insert`,
      );
    }
    return persisted;
  }

  async recordAttempt(
    actor: AuthorizationActor,
    draftJobId: string,
    attemptInput: RecordDraftJobAttemptInput,
  ): Promise<DraftJobAttemptRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    return this.db.transaction(async (tx) => {
      const parentRows = await tx
        .select()
        .from(draftJobs)
        .where(eq(draftJobs.draftJobId, draftJobId))
        .limit(1);
      const parent = parentRows[0];
      if (parent === undefined) {
        throw new DraftJobRepositoryError(
          "draft_job_not_found",
          `draft job ${draftJobId} not found`,
        );
      }
      if (
        parent.status === draftJobStatusValues.succeeded ||
        parent.status === draftJobStatusValues.cancelled
      ) {
        throw new DraftJobRepositoryError(
          "draft_job_not_cancellable",
          `cannot record attempt for draft job ${draftJobId} in status ${parent.status}`,
        );
      }

      const draftJobAttemptId = `draft-job-attempt-${randomUUID()}`;
      const startedAt = attemptInput.startedAt;
      await tx.insert(draftJobAttempts).values({
        draftJobAttemptId,
        draftJobId,
        attemptIndex: attemptInput.attemptIndex,
        providerRunId: attemptInput.providerRunId ?? null,
        startedAt,
        status: draftJobAttemptStatusValues.running,
      });

      await tx
        .update(draftJobs)
        .set({ status: draftJobStatusValues.running, updatedAt: new Date() })
        .where(eq(draftJobs.draftJobId, draftJobId));

      const persisted = await fetchAttemptByIdInTx(tx, draftJobAttemptId);
      if (persisted === null) {
        throw new DraftJobRepositoryError(
          "draft_job_attempt_not_found",
          `failed to load attempt ${draftJobAttemptId} after insert`,
        );
      }
      return persisted;
    });
  }

  async markAttemptSucceeded(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
    endedAt: Date,
    providerRunId?: string,
    recordedProviderArtifactId?: string,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    await this.db.transaction(async (tx) => {
      const attempt = await fetchAttemptByIdInTx(tx, draftJobAttemptId);
      if (attempt === null) {
        throw new DraftJobRepositoryError(
          "draft_job_attempt_not_found",
          `draft job attempt ${draftJobAttemptId} not found`,
        );
      }
      if (!ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) {
        throw new DraftJobRepositoryError(
          "draft_job_attempt_not_active",
          `cannot mark attempt ${draftJobAttemptId} succeeded from status ${attempt.status}`,
        );
      }
      await tx
        .update(draftJobAttempts)
        .set({
          status: draftJobAttemptStatusValues.succeeded,
          endedAt,
          providerRunId: providerRunId ?? attempt.providerRunId,
          recordedProviderArtifactId:
            recordedProviderArtifactId ?? attempt.recordedProviderArtifactId,
        })
        .where(eq(draftJobAttempts.draftJobAttemptId, draftJobAttemptId));

      await tx
        .update(draftJobs)
        .set({
          status: draftJobStatusValues.succeeded,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(eq(draftJobs.draftJobId, attempt.draftJobId));
    });
  }

  async markAttemptFailed(
    actor: AuthorizationActor,
    draftJobAttemptId: string,
    failureReason: string,
    retryable: boolean,
    endedAt: Date,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    await this.db.transaction(async (tx) => {
      const attempt = await fetchAttemptByIdInTx(tx, draftJobAttemptId);
      if (attempt === null) {
        throw new DraftJobRepositoryError(
          "draft_job_attempt_not_found",
          `draft job attempt ${draftJobAttemptId} not found`,
        );
      }
      if (!ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)) {
        throw new DraftJobRepositoryError(
          "draft_job_attempt_not_active",
          `cannot mark attempt ${draftJobAttemptId} failed from status ${attempt.status}`,
        );
      }
      const attemptStatus = retryable
        ? draftJobAttemptStatusValues.retryable
        : draftJobAttemptStatusValues.failed;
      const parentStatus = retryable ? draftJobStatusValues.retryable : draftJobStatusValues.failed;

      await tx
        .update(draftJobAttempts)
        .set({
          status: attemptStatus,
          failureReason,
          endedAt,
        })
        .where(eq(draftJobAttempts.draftJobAttemptId, draftJobAttemptId));

      await tx
        .update(draftJobs)
        .set({ status: parentStatus, failureReason, updatedAt: new Date() })
        .where(eq(draftJobs.draftJobId, attempt.draftJobId));
    });
  }

  async cancelDraftJob(actor: AuthorizationActor, draftJobId: string): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    await this.db.transaction(async (tx) => {
      const parentRows = await tx
        .select()
        .from(draftJobs)
        .where(eq(draftJobs.draftJobId, draftJobId))
        .limit(1);
      const parent = parentRows[0];
      if (parent === undefined) {
        throw new DraftJobRepositoryError(
          "draft_job_not_found",
          `draft job ${draftJobId} not found`,
        );
      }
      if (!CANCELLABLE_PARENT_STATUSES.includes(parent.status)) {
        throw new DraftJobRepositoryError(
          "draft_job_not_cancellable",
          `cannot cancel draft job ${draftJobId} in terminal status ${parent.status}`,
        );
      }

      const cancelEndedAt = new Date();
      await tx
        .update(draftJobAttempts)
        .set({
          status: draftJobAttemptStatusValues.cancelled,
          endedAt: cancelEndedAt,
        })
        .where(
          and(
            eq(draftJobAttempts.draftJobId, draftJobId),
            inArray(draftJobAttempts.status, [
              draftJobAttemptStatusValues.running,
              draftJobAttemptStatusValues.retryable,
            ]),
          ),
        );

      await tx
        .update(draftJobs)
        .set({ status: draftJobStatusValues.cancelled, updatedAt: cancelEndedAt })
        .where(eq(draftJobs.draftJobId, draftJobId));
    });
  }

  async loadDraftJob(
    actor: AuthorizationActor,
    draftJobId: string,
  ): Promise<DraftJobRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return this.fetchDraftJob(draftJobId);
  }

  async loadDraftJobsByProject(
    actor: AuthorizationActor,
    projectId: string,
    opts?: LoadDraftJobsByProjectOptions,
  ): Promise<DraftJobRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(draftJobs.projectId, projectId)];
    if (opts?.statusFilter !== undefined) {
      conditions.push(eq(draftJobs.status, opts.statusFilter));
    }
    const baseQuery = this.db
      .select()
      .from(draftJobs)
      .where(and(...conditions))
      .orderBy(desc(draftJobs.createdAt), asc(draftJobs.draftJobId));
    const rows = await (opts?.limit !== undefined ? baseQuery.limit(opts.limit) : baseQuery);
    return rows.map(draftJobRowToRecord);
  }

  async loadDraftJobAttempts(
    actor: AuthorizationActor,
    draftJobId: string,
  ): Promise<DraftJobAttemptRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(draftJobAttempts)
      .where(eq(draftJobAttempts.draftJobId, draftJobId))
      .orderBy(asc(draftJobAttempts.attemptIndex));
    return rows.map(draftJobAttemptRowToRecord);
  }

  private async fetchDraftJob(draftJobId: string): Promise<DraftJobRecord | null> {
    const rows = await this.db
      .select()
      .from(draftJobs)
      .where(eq(draftJobs.draftJobId, draftJobId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return draftJobRowToRecord(row);
  }
}

async function fetchAttemptByIdInTx(
  tx: Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0],
  draftJobAttemptId: string,
): Promise<DraftJobAttemptRecord | null> {
  const rows = await tx
    .select()
    .from(draftJobAttempts)
    .where(eq(draftJobAttempts.draftJobAttemptId, draftJobAttemptId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return draftJobAttemptRowToRecord(row);
}

function draftJobRowToRecord(row: typeof draftJobs.$inferSelect): DraftJobRecord {
  return {
    draftJobId: row.draftJobId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    bridgeUnitIds: row.bridgeUnitIds,
    styleGuideVersion: row.styleGuideVersion,
    glossaryVersion: row.glossaryVersion,
    protectedSpanRefs: row.protectedSpanRefs,
    policyVersions: row.policyVersions,
    contextRefs: row.contextRefs,
    status: row.status,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function draftJobAttemptRowToRecord(
  row: typeof draftJobAttempts.$inferSelect,
): DraftJobAttemptRecord {
  return {
    draftJobAttemptId: row.draftJobAttemptId,
    draftJobId: row.draftJobId,
    attemptIndex: row.attemptIndex,
    providerRunId: row.providerRunId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    failureReason: row.failureReason,
    recordedProviderArtifactId: row.recordedProviderArtifactId,
    createdAt: row.createdAt,
  };
}

export { draftJobStatusValues, draftJobAttemptStatusValues };
