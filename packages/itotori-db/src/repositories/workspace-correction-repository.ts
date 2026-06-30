// ITOTORI-118 — workspace manual correction edit-history repository.
//
// Persists the durable, append-only edit history produced when a reviewer
// manually corrects a translated unit in the localization workspace. Each
// correction is ALSO routed through the existing feedback intake (so it enters
// the same decision queue + targeted-rerun loop as QA / runtime findings); this
// repository never forks that path. It records the durable audit row — tied to
// (project, locale branch, source revision, bridge unit, actor, reason) — and a
// matching `itotori_events` row in a SINGLE transaction so the edit history and
// the canonical event log can never diverge.
//
// `queue.manage` gates the write (a workspace mutation) and `queue.read` gates
// the read-back, exactly like the reviewer queue: read-only browsing is never
// blocked by the mutation permission, and a mutation never proceeds without it.

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { events, workspaceCorrectionEdits } from "../schema.js";

export const workspaceCorrectionDispositionValues = {
  repairCandidate: "repair_candidate",
  decisionQueue: "decision_queue",
  needsContext: "needs_context",
} as const;

export type WorkspaceCorrectionDisposition =
  (typeof workspaceCorrectionDispositionValues)[keyof typeof workspaceCorrectionDispositionValues];

export const workspaceCorrectionDispositionList: ReadonlyArray<WorkspaceCorrectionDisposition> = [
  workspaceCorrectionDispositionValues.repairCandidate,
  workspaceCorrectionDispositionValues.decisionQueue,
  workspaceCorrectionDispositionValues.needsContext,
];

/** Durable event kind appended to `itotori_events` for every correction. */
export const workspaceCorrectionEventKind = "workspace_correction_recorded";

export const workspaceCorrectionRepositoryErrorCodes = [
  "workspace_correction_invalid_input",
] as const;

export type WorkspaceCorrectionRepositoryErrorCode =
  (typeof workspaceCorrectionRepositoryErrorCodes)[number];

export class WorkspaceCorrectionRepositoryError extends Error {
  constructor(
    readonly code: WorkspaceCorrectionRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceCorrectionRepositoryError";
  }
}

export type WorkspaceCorrectionEditInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  bridgeUnitId: string;
  actorUserId: string;
  /** Reviewer's justification for the correction. Required, non-empty. */
  reason: string;
  /** The draft the reviewer saw, when one existed. */
  beforeText?: string | null;
  /** The reviewer's correction. Required, non-empty. */
  afterText: string;
  disposition: WorkspaceCorrectionDisposition;
  triageLabel: string;
  feedbackReportId: string;
  feedbackEvidenceId: string;
  reviewItemId?: string | null;
  batchId: string;
  actorDisplayName?: string;
  recordedAt?: Date;
  metadata?: Record<string, unknown>;
};

export type WorkspaceCorrectionEditRecord = {
  correctionEditId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  bridgeUnitId: string;
  actorUserId: string;
  reason: string;
  beforeText: string | null;
  afterText: string;
  disposition: WorkspaceCorrectionDisposition;
  triageLabel: string;
  feedbackReportId: string;
  feedbackEvidenceId: string;
  reviewItemId: string | null;
  batchId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  /** True when this exact correction was already recorded (idempotent replay). */
  duplicate: boolean;
};

export interface ItotoriWorkspaceCorrectionRepositoryPort {
  recordCorrectionEdit(
    actor: AuthorizationActor,
    input: WorkspaceCorrectionEditInput,
  ): Promise<WorkspaceCorrectionEditRecord>;
  loadCorrectionEditsByBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<WorkspaceCorrectionEditRecord[]>;
}

export class ItotoriWorkspaceCorrectionRepository implements ItotoriWorkspaceCorrectionRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async recordCorrectionEdit(
    actor: AuthorizationActor,
    input: WorkspaceCorrectionEditInput,
  ): Promise<WorkspaceCorrectionEditRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const normalized = normalizeCorrectionEdit(input);
    const correctionEditId = correctionEditIdFor(normalized);
    const createdAt = input.recordedAt ?? new Date();

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(workspaceCorrectionEdits)
        .values({
          correctionEditId,
          projectId: normalized.projectId,
          localeBranchId: normalized.localeBranchId,
          sourceRevisionId: normalized.sourceRevisionId,
          bridgeUnitId: normalized.bridgeUnitId,
          actorUserId: normalized.actorUserId,
          reason: normalized.reason,
          beforeText: normalized.beforeText,
          afterText: normalized.afterText,
          disposition: normalized.disposition,
          triageLabel: normalized.triageLabel,
          feedbackReportId: normalized.feedbackReportId,
          feedbackEvidenceId: normalized.feedbackEvidenceId,
          reviewItemId: normalized.reviewItemId,
          batchId: normalized.batchId,
          metadata: normalized.metadata,
          createdAt,
        })
        .onConflictDoNothing({ target: workspaceCorrectionEdits.correctionEditId })
        .returning();

      const insertedRow = inserted[0];
      if (insertedRow === undefined) {
        // Idempotent replay: the exact correction is already recorded. Return
        // the durable row verbatim and never re-append the event.
        const existing = await tx
          .select()
          .from(workspaceCorrectionEdits)
          .where(eq(workspaceCorrectionEdits.correctionEditId, correctionEditId))
          .limit(1);
        const existingRow = existing[0];
        if (existingRow === undefined) {
          throw new WorkspaceCorrectionRepositoryError(
            "workspace_correction_invalid_input",
            `workspace correction ${correctionEditId} vanished immediately after insert`,
          );
        }
        return { ...rowToRecord(existingRow), duplicate: true };
      }

      await tx
        .insert(events)
        .values({
          eventId: `${correctionEditId}:${workspaceCorrectionEventKind}`,
          projectId: normalized.projectId,
          localeBranchId: normalized.localeBranchId,
          eventKind: workspaceCorrectionEventKind,
          occurredAt: createdAt,
          actor: {
            actorKind: "human",
            userId: normalized.actorUserId,
            displayName: input.actorDisplayName ?? normalized.actorUserId,
          },
          subjectRefs: [
            { subjectKind: "locale_branch", subjectId: normalized.localeBranchId },
            { subjectKind: "source_revision", subjectId: normalized.sourceRevisionId },
            { subjectKind: "bridge_unit", subjectId: normalized.bridgeUnitId },
            { subjectKind: "feedback_report", subjectId: normalized.feedbackReportId },
            ...(normalized.reviewItemId === null
              ? []
              : [{ subjectKind: "reviewer_queue_item", subjectId: normalized.reviewItemId }]),
          ],
          provenance: [
            {
              provenanceKind: "workspace_correction",
              correctionEditId,
              batchId: normalized.batchId,
              feedbackEvidenceId: normalized.feedbackEvidenceId,
            },
          ],
          causalLinks: [],
          payload: {
            correctionEditId,
            bridgeUnitId: normalized.bridgeUnitId,
            reason: normalized.reason,
            disposition: normalized.disposition,
            triageLabel: normalized.triageLabel,
            hasBeforeText: normalized.beforeText !== null,
            feedbackReportId: normalized.feedbackReportId,
            reviewItemId: normalized.reviewItemId,
          },
        })
        .onConflictDoNothing({ target: events.eventId });

      return { ...rowToRecord(insertedRow), duplicate: false };
    });
  }

  async loadCorrectionEditsByBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<WorkspaceCorrectionEditRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await this.db
      .select()
      .from(workspaceCorrectionEdits)
      .where(eq(workspaceCorrectionEdits.localeBranchId, localeBranchId))
      .orderBy(asc(workspaceCorrectionEdits.createdAt));
    return rows.map((row) => ({ ...rowToRecord(row), duplicate: false }));
  }
}

type NormalizedCorrectionEdit = Required<
  Pick<
    WorkspaceCorrectionEditInput,
    | "projectId"
    | "localeBranchId"
    | "sourceRevisionId"
    | "bridgeUnitId"
    | "actorUserId"
    | "reason"
    | "afterText"
    | "disposition"
    | "triageLabel"
    | "feedbackReportId"
    | "feedbackEvidenceId"
    | "batchId"
  >
> & {
  beforeText: string | null;
  reviewItemId: string | null;
  metadata: Record<string, unknown>;
};

function normalizeCorrectionEdit(input: WorkspaceCorrectionEditInput): NormalizedCorrectionEdit {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new WorkspaceCorrectionRepositoryError(
      "workspace_correction_invalid_input",
      "workspace correction requires a non-empty reason",
    );
  }
  if (input.afterText.length === 0) {
    throw new WorkspaceCorrectionRepositoryError(
      "workspace_correction_invalid_input",
      "workspace correction requires non-empty corrected text",
    );
  }
  for (const [field, value] of [
    ["projectId", input.projectId],
    ["localeBranchId", input.localeBranchId],
    ["sourceRevisionId", input.sourceRevisionId],
    ["bridgeUnitId", input.bridgeUnitId],
    ["actorUserId", input.actorUserId],
    ["feedbackReportId", input.feedbackReportId],
    ["feedbackEvidenceId", input.feedbackEvidenceId],
    ["batchId", input.batchId],
  ] as const) {
    if (value.trim().length === 0) {
      throw new WorkspaceCorrectionRepositoryError(
        "workspace_correction_invalid_input",
        `workspace correction requires a non-empty ${field}`,
      );
    }
  }
  if (!workspaceCorrectionDispositionList.includes(input.disposition)) {
    throw new WorkspaceCorrectionRepositoryError(
      "workspace_correction_invalid_input",
      `workspace correction disposition must be one of ${workspaceCorrectionDispositionList.join(", ")}`,
    );
  }
  return {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    bridgeUnitId: input.bridgeUnitId,
    actorUserId: input.actorUserId,
    reason,
    beforeText: input.beforeText ?? null,
    afterText: input.afterText,
    disposition: input.disposition,
    triageLabel: input.triageLabel,
    feedbackReportId: input.feedbackReportId,
    feedbackEvidenceId: input.feedbackEvidenceId,
    reviewItemId: input.reviewItemId ?? null,
    batchId: input.batchId,
    metadata: input.metadata ?? {},
  };
}

function correctionEditIdFor(normalized: NormalizedCorrectionEdit): string {
  // Deterministic over the correction's branch-scoped identity so an
  // identical replay collapses onto the same row (idempotent), while a
  // correction of the same unit on a DIFFERENT branch is a distinct row
  // (ITOTORI-059 — branches are never conflated).
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        localeBranchId: normalized.localeBranchId,
        sourceRevisionId: normalized.sourceRevisionId,
        bridgeUnitId: normalized.bridgeUnitId,
        actorUserId: normalized.actorUserId,
        afterText: normalized.afterText,
        feedbackEvidenceId: normalized.feedbackEvidenceId,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `workspace-correction-${digest}`;
}

function rowToRecord(
  row: typeof workspaceCorrectionEdits.$inferSelect,
): Omit<WorkspaceCorrectionEditRecord, "duplicate"> {
  return {
    correctionEditId: row.correctionEditId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    bridgeUnitId: row.bridgeUnitId,
    actorUserId: row.actorUserId,
    reason: row.reason,
    beforeText: row.beforeText,
    afterText: row.afterText,
    disposition: row.disposition as WorkspaceCorrectionDisposition,
    triageLabel: row.triageLabel,
    feedbackReportId: row.feedbackReportId,
    feedbackEvidenceId: row.feedbackEvidenceId,
    reviewItemId: row.reviewItemId,
    batchId: row.batchId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}
