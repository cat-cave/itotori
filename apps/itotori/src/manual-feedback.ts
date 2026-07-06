import {
  type AuthorizationActor,
  type ItotoriFeedbackRepositoryPort,
  type ItotoriReviewerQueueRepositoryPort,
  type ManualFeedbackImportInput,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  type ReviewerQueueItemRecord,
  ReviewerQueueRepositoryError,
  feedbackContextStatusValues,
  feedbackTriageLabelValues,
  reviewerQueueItemKindValues,
} from "@itotori/db";
import { localUserActor } from "./auth.js";
import type { BridgeUnitMetadata } from "./draft-feedback/bridge-unit-metadata.js";

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
    > &
      Partial<Pick<ItotoriReviewerQueueRepositoryPort, "loadItemsByBranch">>,
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
    if (context === null || context.contextStatus !== feedbackContextStatusValues.contextualized) {
      return;
    }
    const queueContext = sanitizeReviewerQueueRecord(context.context);
    const queueAttachments = sanitizeReviewerQueueAttachments(context.attachments);
    const isStyleDispute = context.triageLabel === feedbackTriageLabelValues.styleDisputeCandidate;
    const styleDisputeKey = isStyleDispute ? context.feedbackReportId : undefined;
    const affectedBridgeUnitIds = bridgeUnitIdsFromContext(queueContext);
    // Typed against the SAME contract the batch service reads back
    // (`BridgeUnitMetadata`), so a rename/reshape of these keys is a compile
    // error on the producer as well as the consumer.
    const affectedUnitMetadata: BridgeUnitMetadata =
      affectedBridgeUnitIds.length === 0
        ? {}
        : { affectedUnitIds: affectedBridgeUnitIds, bridgeUnitIds: affectedBridgeUnitIds };

    if (
      isStyleDispute &&
      (await this.hasExistingStyleDisputeItem({
        localeBranchId: context.localeBranchId,
        sourceRevisionId: context.sourceRevisionId,
        styleDisputeKey: context.feedbackReportId,
      }))
    ) {
      return;
    }

    try {
      await this.reviewerQueueRepository.createItem(this.actor, {
        projectId: context.projectId,
        localeBranchId: context.localeBranchId,
        sourceRevisionId: context.sourceRevisionId,
        itemKind: isStyleDispute
          ? reviewerQueueItemKindValues.style
          : reviewerQueueItemKindValues.feedback,
        sourceItemRef: context.feedbackReportId,
        summary: summarizeFeedbackForQueue(context.reporterNote),
        affectedArtifactIds: context.affectedArtifactIds,
        payload: {
          feedbackReportId: context.feedbackReportId,
          feedbackEvidenceId: context.feedbackEvidenceId,
          evidenceId: context.feedbackEvidenceId,
          ...(styleDisputeKey === undefined ? {} : { styleDisputeKey }),
          feedbackType: context.feedbackType,
          triageLabel: context.triageLabel,
          ...affectedUnitMetadata,
          context: queueContext,
          attachments: queueAttachments,
          reporterNote: context.reporterNote,
        },
        metadata: {
          source: "manual_feedback_import",
          feedbackReportId: context.feedbackReportId,
          feedbackEvidenceId: context.feedbackEvidenceId,
          evidenceId: context.feedbackEvidenceId,
          ...(styleDisputeKey === undefined ? {} : { styleDisputeKey }),
          triageLabel: context.triageLabel,
          contextStatus: context.contextStatus,
          ...affectedUnitMetadata,
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

  private async hasExistingStyleDisputeItem(input: {
    localeBranchId: string;
    sourceRevisionId: string;
    styleDisputeKey: string;
  }): Promise<boolean> {
    if (this.reviewerQueueRepository?.loadItemsByBranch === undefined) {
      return false;
    }
    const items = await this.reviewerQueueRepository.loadItemsByBranch(
      this.actor,
      input.localeBranchId,
    );
    return items.some(
      (item) =>
        item.sourceRevisionId === input.sourceRevisionId &&
        item.sourceItemRef === input.styleDisputeKey &&
        isStyleDisputeQueueItem(item, input.styleDisputeKey),
    );
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

function bridgeUnitIdsFromContext(context: Record<string, unknown>): string[] {
  return sortedUnique([
    ...stringArrayValue(context.affectedUnitIds),
    ...stringArrayValue(context.affectedBridgeUnitIds),
    ...stringArrayValue(context.bridgeUnitIds),
    ...stringArrayValue(context.unitIds),
    ...stringValue(recordValue(context.lineReference)?.bridgeUnitId),
  ]);
}

function isStyleDisputeQueueItem(item: ReviewerQueueItemRecord, styleDisputeKey: string): boolean {
  if (item.itemKind === reviewerQueueItemKindValues.style) {
    return true;
  }
  if (item.itemKind !== reviewerQueueItemKindValues.feedback) {
    return false;
  }
  return [item.payload, item.metadata].some(
    (record) =>
      record.styleDisputeKey === styleDisputeKey ||
      record.triageLabel === feedbackTriageLabelValues.styleDisputeCandidate,
  );
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string[] {
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
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
