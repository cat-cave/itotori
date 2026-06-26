// ITOTORI-081 — ReviewerQueueAction service.
//
// Typed action API the dashboard, CLI, and agentic-loop call to mutate
// reviewer queue items. Each method maps 1:1 to a reviewer action:
//
//   - approve()                 — mark a QA / style / glossary / feedback /
//                                 runtime evidence item accepted
//   - reject()                  — mark an item rejected
//   - requestRepair()           — return a QA / feedback / runtime evidence
//                                 item to the agentic loop for a targeted
//                                 re-run
//   - updateGlossary()          — approve a glossary item, recording the
//                                 downstream glossary writes that follow
//   - updateStyle()             — approve a style item, recording the
//                                 downstream style-guide edit that follows
//   - importRuntimeFeedback()   — approve a runtime evidence / feedback
//                                 item, preserving the Utsushi evidence
//                                 tier verbatim onto the transition log
//
// The service is a thin typed shell over `ItotoriReviewerQueueRepository`.
// It does NOT make LLM calls and carries no model/provider pair — pair
// policy (ITOTORI-227, pair-policy v0.2) only applies to model
// invocations and this service is deterministic.

import type {
  AuthorizationActor,
  ItotoriReviewerQueueRepositoryPort,
  ReviewerQueueAction,
  ReviewerQueueActionInput,
  ReviewerQueueActionResult,
  ReviewerQueueDiagnostic,
  ReviewerQueueItemKind,
  ReviewerQueueItemRecord,
} from "@itotori/db";
import { reviewerQueueActionValues } from "@itotori/db";
import { buildReviewerTriggeredRerunJobInputs } from "./repair-rerun-scheduler.js";

export type ReviewerQueueActionServicePort = {
  approve(actor: AuthorizationActor, input: ApproveActionInput): Promise<ReviewerQueueActionResult>;
  reject(actor: AuthorizationActor, input: RejectActionInput): Promise<ReviewerQueueActionResult>;
  requestRepair(
    actor: AuthorizationActor,
    input: RequestRepairActionInput,
  ): Promise<ReviewerQueueActionResult>;
  updateGlossary(
    actor: AuthorizationActor,
    input: UpdateGlossaryActionInput,
  ): Promise<ReviewerQueueActionResult>;
  updateStyle(
    actor: AuthorizationActor,
    input: UpdateStyleActionInput,
  ): Promise<ReviewerQueueActionResult>;
  importRuntimeFeedback(
    actor: AuthorizationActor,
    input: ImportRuntimeFeedbackActionInput,
  ): Promise<ReviewerQueueActionResult>;
};

export type ReviewerQueueActionServiceDeps = Record<string, never>;

/**
 * Shared shape every action carries. `expectedSourceRevisionId` lets the
 * repository reject stale reviewer decisions (reviewer acted on a
 * revision that has since been superseded) without partial writes.
 */
export type ReviewerQueueActionCommonInput = {
  reviewItemId: string;
  actorUserId: string;
  expectedSourceRevisionId: string;
  affectedArtifactIds?: string[];
  diagnostics?: ReviewerQueueDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type ApproveActionInput = ReviewerQueueActionCommonInput;

export type RejectActionInput = ReviewerQueueActionCommonInput;

export type RequestRepairActionInput = ReviewerQueueActionCommonInput & {
  /**
   * Free-form hint string surfaced to the agentic-loop on the next
   * attempt. Recorded on the transition row's metadata so the audit
   * trail captures why the reviewer asked for a repair.
   */
  repairHint: string;
};

export type UpdateGlossaryActionInput = ReviewerQueueActionCommonInput & {
  /**
   * Term id the glossary edit will write to. Recorded on the transition
   * metadata; the actual glossary write lands via the glossary
   * repository on a downstream worker (out of scope for this service).
   */
  termId: string;
  /** Final preferred translation the reviewer approved. */
  approvedTranslation: string;
};

export type UpdateStyleActionInput = ReviewerQueueActionCommonInput & {
  /** Style-guide version id the edit will write to. */
  styleGuideVersionId: string;
  /** Short label describing the approved style rule edit. */
  ruleLabel: string;
};

export type ImportRuntimeFeedbackActionInput = ReviewerQueueActionCommonInput & {
  /**
   * Utsushi evidence tier carried by the reviewer-queue item; the
   * service asserts the supplied value matches the persisted value on
   * the item. This is the explicit hand-off contract that prevents
   * runtime evidence feedback from losing its tier (audit focus).
   */
  evidenceTier: string;
  /** Utsushi observation event ids being imported. */
  observationEventIds: string[];
  /** Hashes of the imported artifact bytes. */
  artifactHashes: string[];
};

export class ReviewerQueueActionService implements ReviewerQueueActionServicePort {
  constructor(private readonly repository: ItotoriReviewerQueueRepositoryPort) {}

  async approve(
    actor: AuthorizationActor,
    input: ApproveActionInput,
  ): Promise<ReviewerQueueActionResult> {
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.approve),
    );
  }

  async reject(
    actor: AuthorizationActor,
    input: RejectActionInput,
  ): Promise<ReviewerQueueActionResult> {
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.reject),
    );
  }

  async requestRepair(
    actor: AuthorizationActor,
    input: RequestRepairActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("repairHint", input.repairHint);
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.requestRepair, {
        repairHint: input.repairHint,
      }),
    );
  }

  async updateGlossary(
    actor: AuthorizationActor,
    input: UpdateGlossaryActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("termId", input.termId);
    assertNonEmpty("approvedTranslation", input.approvedTranslation);
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.updateGlossary, {
        termId: input.termId,
        approvedTranslation: input.approvedTranslation,
      }),
    );
  }

  async updateStyle(
    actor: AuthorizationActor,
    input: UpdateStyleActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("styleGuideVersionId", input.styleGuideVersionId);
    assertNonEmpty("ruleLabel", input.ruleLabel);
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.updateStyle, {
        styleGuideVersionId: input.styleGuideVersionId,
        ruleLabel: input.ruleLabel,
      }),
    );
  }

  async importRuntimeFeedback(
    actor: AuthorizationActor,
    input: ImportRuntimeFeedbackActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("evidenceTier", input.evidenceTier);
    assertNonEmptyArray("observationEventIds", input.observationEventIds);
    assertNonEmptyArray("artifactHashes", input.artifactHashes);
    // Persist the evidence tier + observation event ids + artifact
    // hashes verbatim onto the transition's metadata so the audit trail
    // captures what was imported, in addition to the persisted values
    // on the item row itself.
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.importRuntimeFeedback, {
        evidenceTier: input.evidenceTier,
        observationEventIds: input.observationEventIds,
        artifactHashes: input.artifactHashes,
      }),
    );
  }

  private async applyActionAndSchedule(
    actor: AuthorizationActor,
    input: ReviewerQueueActionInput,
  ): Promise<ReviewerQueueActionResult> {
    const result = await this.repository.applyActionAndEnqueueJobs(
      actor,
      input,
      buildReviewerTriggeredRerunJobInputs,
    );
    return result.actionResult;
  }
}

/**
 * Construct a `ReviewerQueueActionInput` while honoring the workspace's
 * `exactOptionalPropertyTypes: true` setting — optional properties are
 * only added when the caller supplied them, never as `key: undefined`.
 * `metadataExtension` is merged on top of any caller-supplied metadata
 * so per-action context (repair hint, glossary term id, etc.) is
 * preserved alongside the reviewer's free-form metadata.
 */
function buildActionInput(
  common: ReviewerQueueActionCommonInput,
  action: ReviewerQueueAction,
  metadataExtension?: Record<string, unknown>,
): ReviewerQueueActionInput {
  const result: ReviewerQueueActionInput = {
    reviewItemId: common.reviewItemId,
    action,
    actorUserId: common.actorUserId,
    expectedSourceRevisionId: common.expectedSourceRevisionId,
  };
  if (common.affectedArtifactIds !== undefined) {
    result.affectedArtifactIds = common.affectedArtifactIds;
  }
  if (common.diagnostics !== undefined) {
    result.diagnostics = common.diagnostics;
  }
  if (common.metadata !== undefined || metadataExtension !== undefined) {
    result.metadata = { ...common.metadata, ...metadataExtension };
  }
  return result;
}

/**
 * Type-narrow helper for callers that want to ensure a record is
 * runtime evidence before reading the (non-null) evidence tier. Avoids
 * scattered `!`-asserts at the call site.
 */
export function isRuntimeEvidenceItem(
  record: ReviewerQueueItemRecord,
): record is ReviewerQueueItemRecord & {
  itemKind: Extract<ReviewerQueueItemKind, "runtime_evidence">;
  evidenceTier: string;
  observationEventIds: string[];
  artifactHashes: string[];
} {
  return (
    record.itemKind === "runtime_evidence" &&
    record.evidenceTier !== null &&
    record.observationEventIds !== null &&
    record.artifactHashes !== null
  );
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReviewerQueueActionServiceInputError(field, `${field} must be a non-empty string`);
  }
}

function assertNonEmptyArray(field: string, value: ReadonlyArray<string>): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewerQueueActionServiceInputError(field, `${field} must be a non-empty array`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ReviewerQueueActionServiceInputError(
        field,
        `${field} must contain only non-empty strings`,
      );
    }
  }
}

export class ReviewerQueueActionServiceInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewerQueueActionServiceInputError";
  }
}
