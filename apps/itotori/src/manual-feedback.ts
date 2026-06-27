import {
  type AuthorizationActor,
  type ItotoriFeedbackRepositoryPort,
  type ItotoriReviewerQueueRepositoryPort,
  type ManualFeedbackImportInput,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  ReviewerQueueRepositoryError,
  feedbackContextStatusValues,
  reviewerQueueItemKindValues,
} from "@itotori/db";
import { localUserActor } from "./auth.js";

export interface ManualFeedbackImportPort {
  importManualFeedback(input: unknown): Promise<ManualFeedbackImportResult>;
}

export class ManualFeedbackImportService {
  constructor(
    private readonly repository: Pick<ItotoriFeedbackRepositoryPort, "importManualFeedback"> &
      Partial<Pick<ItotoriFeedbackRepositoryPort, "loadManualFeedbackReviewerQueueContext">>,
    private readonly actor: AuthorizationActor = localUserActor,
    private readonly reviewerQueueRepository?: Pick<
      ItotoriReviewerQueueRepositoryPort,
      "createItem"
    >,
  ) {}

  async importManualFeedback(input: unknown): Promise<ManualFeedbackImportResult> {
    const parsed = parseManualFeedbackImportInput(input);
    const result = await this.repository.importManualFeedback(this.actor, parsed);
    await this.enqueueReviewerQueueItem(result);
    return result;
  }

  private async enqueueReviewerQueueItem(result: ManualFeedbackImportResult): Promise<void> {
    if (
      this.reviewerQueueRepository === undefined ||
      this.repository.loadManualFeedbackReviewerQueueContext === undefined ||
      result.duplicate ||
      result.contextStatus !== feedbackContextStatusValues.contextualized
    ) {
      return;
    }

    const context = await this.repository.loadManualFeedbackReviewerQueueContext(
      this.actor,
      result.feedbackReportId,
      result.feedbackEvidenceId,
    );
    if (
      context === null ||
      context.contextStatus !== feedbackContextStatusValues.contextualized
    ) {
      return;
    }
    const queueContext = sanitizeReviewerQueueRecord(context.context);
    const queueAttachments = sanitizeReviewerQueueAttachments(context.attachments);

    try {
      await this.reviewerQueueRepository.createItem(this.actor, {
        projectId: context.projectId,
        localeBranchId: context.localeBranchId,
        sourceRevisionId: context.sourceRevisionId,
        itemKind: reviewerQueueItemKindValues.feedback,
        sourceItemRef: context.feedbackReportId,
        summary: summarizeFeedbackForQueue(context.reporterNote),
        affectedArtifactIds: context.affectedArtifactIds,
        payload: {
          feedbackReportId: context.feedbackReportId,
          feedbackEvidenceId: context.feedbackEvidenceId,
          evidenceId: context.feedbackEvidenceId,
          feedbackType: context.feedbackType,
          triageLabel: context.triageLabel,
          context: queueContext,
          attachments: queueAttachments,
          reporterNote: context.reporterNote,
        },
        metadata: {
          source: "manual_feedback_import",
          feedbackReportId: context.feedbackReportId,
          feedbackEvidenceId: context.feedbackEvidenceId,
          evidenceId: context.feedbackEvidenceId,
          triageLabel: context.triageLabel,
          contextStatus: context.contextStatus,
          context: queueContext,
          attachments: queueAttachments,
        },
        createdByUserId: this.actor.userId,
      });
    } catch (error) {
      if (
        error instanceof ReviewerQueueRepositoryError &&
        error.code === "reviewer_queue_item_duplicate"
      ) {
        return;
      }
      throw error;
    }
  }
}

function summarizeFeedbackForQueue(reporterNote: string): string {
  const singleLine = reporterNote.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 120) {
    return `Manual feedback: ${singleLine}`;
  }
  return `Manual feedback: ${singleLine.slice(0, 117)}...`;
}

function sanitizeReviewerQueueAttachments(attachments: unknown[]): unknown[] {
  return attachments
    .map((attachment) => {
      if (!isRecord(attachment)) {
        return null;
      }
      return compactRecord({
        attachmentKind: attachment.attachmentKind,
        attachmentId: attachment.attachmentId,
        artifactId: attachment.artifactId,
        hash: attachment.hash,
        caption: attachment.caption,
        capturePosition: attachment.capturePosition,
        evidenceTier: attachment.evidenceTier,
        contextToken: attachment.contextToken,
        routeRef: attachment.routeRef,
        sceneRef: attachment.sceneRef,
        createdAt: attachment.createdAt,
        contextKind: attachment.contextKind,
        contextId: attachment.contextId,
        speakerRef: attachment.speakerRef,
        runtimeArtifactId: attachment.runtimeArtifactId,
      });
    })
    .filter((attachment): attachment is Record<string, unknown> => attachment !== null);
}

function sanitizeReviewerQueueRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (reviewerQueueContextOmittedKeys.has(key)) {
      continue;
    }
    if (Array.isArray(entry)) {
      const items = entry
        .map((item) => (isRecord(item) ? sanitizeReviewerQueueRecord(item) : item))
        .filter((item) => !isRecord(item) || Object.keys(item).length > 0);
      if (items.length > 0) {
        sanitized[key] = items;
      }
      continue;
    }
    if (isRecord(entry)) {
      const nested = sanitizeReviewerQueueRecord(entry);
      if (Object.keys(nested).length > 0) {
        sanitized[key] = nested;
      }
      continue;
    }
    sanitized[key] = entry;
  }
  return compactRecord(sanitized);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") {
      continue;
    }
    if (Array.isArray(entry) && entry.length === 0) {
      continue;
    }
    if (isRecord(entry) && Object.keys(entry).length === 0) {
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const reviewerQueueContextOmittedKeys = new Set([
  "uri",
  "fileUri",
  "path",
  "filePath",
  "localPath",
  "sourceLocation",
  "quotedText",
  "visibleText",
  "metadata",
]);

export type { ManualFeedbackImportInput };
