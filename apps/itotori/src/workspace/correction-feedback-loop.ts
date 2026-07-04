// itotori-correction-feedback-writeback-e2e — the feedback loop's RETURN path.
//
// The workspace correction service (ITOTORI-118) already routes a reviewer fix
// into feedback intake + durable edit history + the reviewer decision queue.
// That is the loop's INBOUND leg. This module closes the OUTBOUND leg: a
// reviewer correction (source → corrected target for a bridge unit) is written
// back into the translation-memory + glossary stores AND schedules an affected
// rerun, so the NEXT draft for every unit sharing that source reuses the
// correction instead of re-deriving the wrong text.
//
// It composes EXISTING services — it invents no new store:
//
//   1. translation-memory writeback → `ItotoriTranslationMemoryRepository.
//      upsertSegment` persists the corrected target as a reusable segment keyed
//      to the corrected unit's source. A deterministic `memorySegmentId` makes
//      re-applying the SAME correction an idempotent update (no duplicate row).
//      The next draft consumes it through the ordinary TM prefill path
//      (`ItotoriTranslationMemoryService.prefillDrafts`) — the corrected segment
//      exact-matches every unit with the same source hash and rewrites its
//      `locale_branch_units.target_text`.
//
//   2. glossary writeback (optional) → when the correction carries a source
//      term, `ItotoriTerminologyRepository.upsertTerm` persists
//      sourceTerm → corrected target so the glossary now carries the corrected
//      preferred translation. (The agentic loop's consumption of the glossary
//      is the style-glossary injection landing in parallel; the persisted term
//      is the durable half of that handoff.)
//
//   3. affected rerun → `ItotoriTranslationMemoryRepository.listUnitsSharingSource`
//      resolves every unit sharing the corrected source; those units become the
//      rerun's affected scope and the correction enqueues the reviewer-rerun job
//      chain via the shared `buildRerunJobInputsFromPayloadContext` lowering
//      (same draft-repair → qa-replay → export-regeneration → runtime-validation
//      chain a reviewer-queue action produces). A deterministic idempotency key
//      collapses a re-applied correction onto the same jobs.

import type {
  AuthorizationActor,
  ItotoriTerminologyRepositoryPort,
  ItotoriTranslationMemoryRepositoryPort,
  JobQueueRecord,
} from "@itotori/db";
import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  terminologySourceReferenceKindValues,
  translationMemorySegmentStatusValues,
} from "@itotori/db";
import { createHash } from "node:crypto";
import {
  buildRerunJobInputsFromPayloadContext,
  reviewerTriggeredRerunPayloadSchemaVersion,
  reviewerTriggeredRerunReasonCodeValues,
  type ReviewerTriggeredRerunPayload,
  type ReviewerTriggeredRerunQueuePort,
  type ReviewerTriggeredRerunReasonCode,
} from "../reviewer/repair-rerun-scheduler.js";

/** TM writeback surface the loop needs (segment upsert + affected-unit fan-out). */
export type WorkspaceCorrectionTranslationMemoryPort = Pick<
  ItotoriTranslationMemoryRepositoryPort,
  "upsertSegment" | "listUnitsSharingSource"
>;

/** Glossary writeback surface (term upsert). Optional — only term-scoped fixes use it. */
export type WorkspaceCorrectionGlossaryPort = Pick<ItotoriTerminologyRepositoryPort, "upsertTerm">;

export type WorkspaceCorrectionFeedbackLoopDeps = {
  actor: AuthorizationActor;
  translationMemory: WorkspaceCorrectionTranslationMemoryPort;
  rerunQueue: ReviewerTriggeredRerunQueuePort;
  glossary?: WorkspaceCorrectionGlossaryPort;
};

export type WorkspaceCorrectionWritebackInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  bridgeUnitId: string;
  /** The reviewer's corrected target text — the value that persists + reruns. */
  correctedText: string;
  /** When the correction fixes a glossary term, its source term (glossary writeback). */
  sourceTerm?: string;
  /** Correlates the writeback/rerun back to the feedback report the correction produced. */
  feedbackReportId?: string;
  batchId?: string;
  reason?: string;
};

export type WorkspaceCorrectionWritebackResult = {
  /** False only when the corrected unit is not in the branch (nothing was persisted). */
  writtenBack: boolean;
  /** The reusable translation-memory segment written (deterministic, idempotent). */
  memorySegmentId: string | null;
  /** The glossary term written, when the correction was term-scoped. */
  termId: string | null;
  /** Every bridge unit sharing the corrected source — the affected rerun scope. */
  affectedBridgeUnitIds: string[];
  /** The reviewer-rerun jobs scheduled for the affected units. */
  scheduledJobIds: string[];
  skippedReason?: "unit_not_in_branch";
};

export interface WorkspaceCorrectionFeedbackLoopPort {
  applyCorrectionWriteback(
    input: WorkspaceCorrectionWritebackInput,
  ): Promise<WorkspaceCorrectionWritebackResult>;
}

export class WorkspaceCorrectionFeedbackLoop implements WorkspaceCorrectionFeedbackLoopPort {
  constructor(private readonly deps: WorkspaceCorrectionFeedbackLoopDeps) {}

  async applyCorrectionWriteback(
    input: WorkspaceCorrectionWritebackInput,
  ): Promise<WorkspaceCorrectionWritebackResult> {
    // Resolve the affected scope first: the corrected unit must be in the
    // branch, and every unit sharing its source is what the rerun targets.
    const shared = await this.deps.translationMemory.listUnitsSharingSource({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      bridgeUnitId: input.bridgeUnitId,
    });
    if (shared === null) {
      return {
        writtenBack: false,
        memorySegmentId: null,
        termId: null,
        affectedBridgeUnitIds: [],
        scheduledJobIds: [],
        skippedReason: "unit_not_in_branch",
      };
    }

    // 1. Translation-memory writeback (deterministic id → idempotent upsert).
    const memorySegmentId = correctionSegmentId(input.localeBranchId, input.bridgeUnitId);
    await this.deps.translationMemory.upsertSegment(this.deps.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceBridgeUnitId: input.bridgeUnitId,
      targetText: input.correctedText,
      memorySegmentId,
      status: translationMemorySegmentStatusValues.reusable,
      expectedSourceRevisionId: input.sourceRevisionId,
      provenance: {
        schemaVersion: reviewerTriggeredRerunPayloadSchemaVersion,
        source: "workspace_correction",
        ...(input.feedbackReportId === undefined
          ? {}
          : { feedbackReportId: input.feedbackReportId }),
        ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    });

    // 2. Glossary writeback (optional, only for term-scoped corrections).
    let termId: string | null = null;
    if (input.sourceTerm !== undefined && input.sourceTerm.length > 0 && this.deps.glossary) {
      const result = await this.deps.glossary.upsertTerm(this.deps.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceTerm: input.sourceTerm,
        preferredTranslation: input.correctedText,
        termId: correctionTermId(input.localeBranchId, input.sourceTerm),
        conflictPolicy: "record",
        sourceReferences: [
          {
            referenceKind: terminologySourceReferenceKindValues.manual,
            bridgeUnitId: input.bridgeUnitId,
            sourceRevisionId: input.sourceRevisionId,
            citation: input.reason ?? input.correctedText,
          },
        ],
        metadata: {
          source: "workspace_correction",
          ...(input.feedbackReportId === undefined
            ? {}
            : { feedbackReportId: input.feedbackReportId }),
          ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
        },
      });
      termId = result.term.termId;
    }

    // 3. Affected rerun: schedule the reviewer-rerun chain over the shared units.
    const reasonCodes: ReviewerTriggeredRerunReasonCode[] = [
      reviewerTriggeredRerunReasonCodeValues.reviewerCorrectionWriteback,
      reviewerTriggeredRerunReasonCodeValues.translationMemoryInvalidated,
      ...(termId === null
        ? []
        : [
            reviewerTriggeredRerunReasonCodeValues.reviewerGlossaryUpdate,
            reviewerTriggeredRerunReasonCodeValues.glossaryInvalidated,
          ]),
    ];
    const correctionRef = correctionRerunRef(input.localeBranchId, input.bridgeUnitId);
    const context: Omit<ReviewerTriggeredRerunPayload, "stage"> = {
      schemaVersion: reviewerTriggeredRerunPayloadSchemaVersion,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: shared.sourceRevisionId,
      affectedUnitIds: shared.bridgeUnitIds,
      artifactIds: [],
      policyVersions: {
        styleGuideVersionId: null,
        glossaryVersionId: null,
        pairPolicyVersionId: null,
        qaPolicyVersionId: null,
        exportPolicyVersionId: null,
        runtimeValidationPolicyVersionId: null,
      },
      reasonCodes,
      reviewItemId: correctionRef,
      transitionId: correctionRef,
      reviewerAction:
        termId === null
          ? reviewerQueueActionValues.requestRepair
          : reviewerQueueActionValues.updateGlossary,
      itemKind: reviewerQueueItemKindValues.feedback,
      sourceItemRef: input.bridgeUnitId,
      ...(termId === null ? {} : { termId, approvedTranslation: input.correctedText }),
    };
    const jobInputs = buildRerunJobInputsFromPayloadContext(context);
    const jobs = await this.deps.rerunQueue.enqueueJobs(this.deps.actor, jobInputs);

    return {
      writtenBack: true,
      memorySegmentId,
      termId,
      affectedBridgeUnitIds: shared.bridgeUnitIds,
      scheduledJobIds: jobs.map((job: JobQueueRecord) => job.jobId),
    };
  }
}

function correctionSegmentId(localeBranchId: string, bridgeUnitId: string): string {
  return `workspace-correction-tm-${stableId(localeBranchId, bridgeUnitId)}`;
}

function correctionTermId(localeBranchId: string, sourceTerm: string): string {
  return `workspace-correction-term-${stableId(localeBranchId, sourceTerm)}`;
}

function correctionRerunRef(localeBranchId: string, bridgeUnitId: string): string {
  return `workspace-correction:${localeBranchId}:${bridgeUnitId}`;
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 24);
}
