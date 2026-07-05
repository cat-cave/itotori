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
//                                 item; for runtime-evidence items it
//                                 asserts the supplied evidence tier and
//                                 refs match the values persisted on the
//                                 item before recording them verbatim
//                                 onto the transition log
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
  defer(actor: AuthorizationActor, input: DeferActionInput): Promise<ReviewerQueueActionResult>;
  escalate(
    actor: AuthorizationActor,
    input: EscalateActionInput,
  ): Promise<ReviewerQueueActionResult>;
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
  applyPreparedBatch(
    actor: AuthorizationActor,
    inputs: readonly ReviewerQueueActionInput[],
  ): Promise<ReviewerQueueActionResult[]>;
};

export type ReviewerQueueActionServiceDeps = Record<string, never>;

export type ReviewerQueueDecisionContextRefs = {
  source: {
    bridgeUnitId: string;
    sourceUnitKey: string;
    sourceRevisionId: string;
  };
  draft: {
    draftId: string;
    draftAttemptId: string;
  };
  runtime: {
    runtimeTargetId: string;
    observationEventIds: string[];
    artifactHashes: string[];
  };
  style: {
    styleGuidePolicyVersionId: string;
  };
  glossary: {
    termIds: string[];
  };
  qa: {
    findingIds: string[];
  };
};

/**
 * Shared shape every action carries. `expectedSourceRevisionId` lets the
 * repository reject stale reviewer decisions (reviewer acted on a
 * revision that has since been superseded) without partial writes.
 */
export type ReviewerQueueActionCommonInput = {
  reviewItemId: string;
  actorUserId: string;
  expectedSourceRevisionId: string;
  expectedLeaseId?: string;
  affectedArtifactIds?: string[];
  diagnostics?: ReviewerQueueDiagnostic[];
  metadata?: Record<string, unknown>;
  contextRefs?: ReviewerQueueDecisionContextRefs;
};

export type ApproveActionInput = ReviewerQueueActionCommonInput;

export type RejectActionInput = ReviewerQueueActionCommonInput;

export type DeferActionInput = ReviewerQueueActionCommonInput & {
  deferReason: string;
};

export type EscalateActionInput = ReviewerQueueActionCommonInput & {
  escalationReason: string;
  escalationTarget: string;
};

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
   * Utsushi evidence tier for the import. For runtime-evidence items the
   * tier (together with `observationEventIds` and `artifactHashes`) is
   * persisted on the item row and is authoritative: the service fetches
   * the item and asserts the supplied values match the persisted ones,
   * throwing `ReviewerQueueActionServiceInputError` on mismatch. This is
   * the explicit hand-off contract that prevents runtime evidence
   * feedback from losing or rewriting its tier on the transition log
   * (audit focus). Feedback-kind items carry no persisted tier, so the
   * supplied value is recorded verbatim.
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

  async defer(
    actor: AuthorizationActor,
    input: DeferActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("deferReason", input.deferReason);
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.defer, {
        deferReason: input.deferReason,
      }),
    );
  }

  async escalate(
    actor: AuthorizationActor,
    input: EscalateActionInput,
  ): Promise<ReviewerQueueActionResult> {
    assertNonEmpty("escalationReason", input.escalationReason);
    assertNonEmpty("escalationTarget", input.escalationTarget);
    return this.applyActionAndSchedule(
      actor,
      buildActionInput(input, reviewerQueueActionValues.escalate, {
        escalationReason: input.escalationReason,
        escalationTarget: input.escalationTarget,
      }),
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
    // Runtime-evidence items carry the Utsushi tier + observation/artifact
    // refs persisted on the item row, and those are authoritative. Fetch
    // the item and assert the supplied values match so a caller cannot
    // record a different tier on the transition log than the item actually
    // carries (the item row itself stays correct via the SQL discriminant,
    // but the recorded feedback must not drift). Feedback-kind items carry
    // no persisted tier, so the supplied values are recorded verbatim. A
    // missing item is left to the repository's typed not-found error. This
    // is the SAME enforcement the batch surface applies via
    // `assertImportRuntimeFeedbackMatchesPersisted` — single enforcement
    // point, no divergence.
    const item = await this.repository.getItem(actor, input.reviewItemId);
    assertImportRuntimeFeedbackMatchesPersisted(item, input);
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

  async applyPreparedBatch(
    actor: AuthorizationActor,
    inputs: readonly ReviewerQueueActionInput[],
  ): Promise<ReviewerQueueActionResult[]> {
    const result = await this.repository.applyActionsAndEnqueueJobs(
      actor,
      inputs,
      buildReviewerTriggeredRerunJobInputs,
    );
    return result.actionResults;
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
export function buildReviewerQueueActionInput(
  common: ReviewerQueueActionCommonInput,
  action: ReviewerQueueAction,
  metadataExtension?: Record<string, unknown>,
): ReviewerQueueActionInput {
  assertDecisionContextRefs(common.contextRefs);
  const result: ReviewerQueueActionInput = {
    reviewItemId: common.reviewItemId,
    action,
    actorUserId: common.actorUserId,
    expectedSourceRevisionId: common.expectedSourceRevisionId,
    ...(common.expectedLeaseId === undefined ? {} : { expectedLeaseId: common.expectedLeaseId }),
  };
  if (common.affectedArtifactIds !== undefined) {
    result.affectedArtifactIds = common.affectedArtifactIds;
  }
  if (common.diagnostics !== undefined) {
    result.diagnostics = common.diagnostics;
  }
  if (common.metadata !== undefined || metadataExtension !== undefined) {
    result.metadata = { ...common.metadata, contextRefs: common.contextRefs, ...metadataExtension };
  } else {
    result.metadata = { contextRefs: common.contextRefs };
  }
  return result;
}

const buildActionInput = buildReviewerQueueActionInput;

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

/**
 * Supplied runtime-feedback evidence to validate against the persisted
 * item row. Shared by the single-item `importRuntimeFeedback` path and
 * the batch surface (`batch-execute.ts`) so both enforce byte-identical
 * persisted-vs-supplied rules.
 */
export type ImportRuntimeFeedbackEvidence = {
  evidenceTier: string;
  observationEventIds: readonly string[];
  artifactHashes: readonly string[];
};

/**
 * The single persisted-vs-supplied enforcement point for
 * `importRuntimeFeedback`. For a runtime-evidence item the persisted
 * tier + observation/artifact refs are authoritative: the supplied
 * evidence MUST match them exactly, so a caller (single-item OR batch)
 * cannot forge/substitute evidence or drift the recorded tier away from
 * what the item actually carries. The tier is therefore recorded
 * verbatim from the persisted record. A null item (repository leaves
 * not-found to its typed error) and feedback-kind items (no persisted
 * tier) pass through — their supplied values are recorded verbatim.
 * Throws `ReviewerQueueActionServiceInputError` on mismatch.
 */
export function assertImportRuntimeFeedbackMatchesPersisted(
  item: ReviewerQueueItemRecord | null,
  supplied: ImportRuntimeFeedbackEvidence,
): void {
  if (item !== null && isRuntimeEvidenceItem(item)) {
    assertMatchesPersistedString("evidenceTier", supplied.evidenceTier, item.evidenceTier);
    assertMatchesPersistedStringArray(
      "observationEventIds",
      supplied.observationEventIds,
      item.observationEventIds,
    );
    assertMatchesPersistedStringArray(
      "artifactHashes",
      supplied.artifactHashes,
      item.artifactHashes,
    );
  }
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

function assertMatchesPersistedString(field: string, supplied: string, persisted: string): void {
  if (supplied !== persisted) {
    throw new ReviewerQueueActionServiceInputError(
      field,
      `${field} '${supplied}' does not match the persisted runtime-evidence value '${persisted}' on the item`,
    );
  }
}

function assertMatchesPersistedStringArray(
  field: string,
  supplied: ReadonlyArray<string>,
  persisted: ReadonlyArray<string>,
): void {
  const matches =
    supplied.length === persisted.length &&
    supplied.every((entry, index) => entry === persisted[index]);
  if (!matches) {
    throw new ReviewerQueueActionServiceInputError(
      field,
      `${field} [${supplied.join(", ")}] does not match the persisted runtime-evidence value [${persisted.join(", ")}] on the item`,
    );
  }
}

function assertDecisionContextRefs(value: ReviewerQueueDecisionContextRefs | undefined): void {
  if (value === undefined) {
    throw new ReviewerQueueActionServiceInputError(
      "contextRefs",
      "contextRefs must include source, draft, runtime, style, glossary, and QA refs",
    );
  }
  assertNonEmpty("contextRefs.source.bridgeUnitId", value.source.bridgeUnitId);
  assertNonEmpty("contextRefs.source.sourceUnitKey", value.source.sourceUnitKey);
  assertNonEmpty("contextRefs.source.sourceRevisionId", value.source.sourceRevisionId);
  assertNonEmpty("contextRefs.draft.draftId", value.draft.draftId);
  assertNonEmpty("contextRefs.draft.draftAttemptId", value.draft.draftAttemptId);
  assertNonEmpty("contextRefs.runtime.runtimeTargetId", value.runtime.runtimeTargetId);
  assertNonEmptyArray("contextRefs.runtime.observationEventIds", value.runtime.observationEventIds);
  assertNonEmptyArray("contextRefs.runtime.artifactHashes", value.runtime.artifactHashes);
  assertNonEmpty(
    "contextRefs.style.styleGuidePolicyVersionId",
    value.style.styleGuidePolicyVersionId,
  );
  assertNonEmptyArray("contextRefs.glossary.termIds", value.glossary.termIds);
  assertNonEmptyArray("contextRefs.qa.findingIds", value.qa.findingIds);
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
