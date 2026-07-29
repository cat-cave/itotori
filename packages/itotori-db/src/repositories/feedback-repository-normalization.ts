import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackSourceKindValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  type FeedbackContextStatus,
  type FeedbackReportStatus,
  type FeedbackSourceKind,
  type FeedbackTriageLabel,
  type FeedbackType,
  type ManualFeedbackAttachment,
  type ManualFeedbackImportInput,
  type ManualFeedbackLineReference,
} from "./feedback-repository-types.js";
import {
  compactRecord,
  hasAnySignalField,
  hasUsableLineReferenceSignal,
  hashJson,
  normalizeLineReference,
  normalizeText,
} from "./feedback-repository-utils.js";

export type ScopedManualFeedbackInput = ManualFeedbackImportInput & { targetLocale: string };

export type NormalizedManualFeedback = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  feedbackSourceId: string;
  feedbackSource: {
    sourceKind: FeedbackSourceKind;
    label: string;
    sourceChannel: string | null;
    privacyReviewState: string;
    metadata: Record<string, unknown>;
  };
  reporterNote: string;
  lineReference: Record<string, unknown> | null;
  attachments: ManualFeedbackAttachment[];
  attachmentSummary: Record<string, unknown>;
  contextSignals: Record<string, unknown>;
  contextStatus: FeedbackContextStatus;
  triageLabel: FeedbackTriageLabel;
  reportStatus: FeedbackReportStatus;
  privacyClassification: string;
  redactionState: string;
  reportedAt: Date;
  dedupeKey: string;
  metadata: Record<string, unknown>;
  targetLocale: string;
};

export function deriveFeedbackDedupeKey(input: ManualFeedbackImportInput): string {
  if (input.dedupeKey) {
    return `feedback:manual:${hashJson({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      feedbackType: input.feedbackType,
      externalDedupeKey: normalizeText(input.dedupeKey),
      anchor: primaryDedupeAnchor(input),
    })}`;
  }

  return `feedback:sha256:${hashJson({
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    feedbackType: input.feedbackType,
    anchor: primaryDedupeAnchor(input),
    reporterNote: normalizeText(input.reporterNote).slice(0, 512),
  })}`;
}

export function normalizeManualFeedback(
  input: ScopedManualFeedbackInput,
): NormalizedManualFeedback {
  const reporterNote = input.reporterNote.trim();
  if (reporterNote.length === 0) {
    throw new Error("manual feedback reporterNote is required");
  }
  if (input.reporter.role.trim().length === 0) {
    throw new Error("manual feedback reporter.role is required");
  }

  const feedbackSource = normalizeFeedbackSource(input);
  const feedbackSourceId =
    input.feedbackSourceId ??
    input.feedbackSource?.feedbackSourceId ??
    `feedback-source:${hashJson({
      projectId: input.projectId,
      sourceKind: feedbackSource.sourceKind,
      label: feedbackSource.label,
    }).slice(0, 32)}`;
  const dedupeKey = deriveFeedbackDedupeKey(input);
  const contextSignals = contextSignalsFor(input);
  const contextStatus = feedbackContextStatusValues.contextualized;
  const triageLabel = classifyFeedback(input.feedbackType);
  const reportStatus = feedbackReportStatusValues.open;
  const metadata = {
    ...input.metadata,
    ...(input.suggestedEdit ? { suggestedEdit: input.suggestedEdit } : {}),
  };
  const attachments = input.attachments ?? [];
  const lineReference = normalizeLineReference(input.lineReference);
  const reportedAt = input.reportedAt ? new Date(input.reportedAt) : new Date();
  const reportSeed = {
    projectId: input.projectId,
    dedupeKey,
    reporterNote,
    lineReference,
  };
  const evidenceSeed = {
    dedupeKey,
    reporter: input.reporter,
    reporterNote,
    lineReference,
    attachments,
    reportedAt: input.reportedAt ?? null,
  };

  return {
    feedbackReportId: input.feedbackReportId ?? `feedback:${hashJson(reportSeed).slice(0, 32)}`,
    feedbackEvidenceId:
      input.feedbackEvidenceId ?? `feedback-evidence:${hashJson(evidenceSeed).slice(0, 32)}`,
    feedbackSourceId,
    feedbackSource,
    reporterNote,
    lineReference,
    attachments,
    attachmentSummary: summarizeAttachments(attachments),
    contextSignals,
    contextStatus,
    triageLabel,
    reportStatus,
    privacyClassification: input.privacyClassification ?? "internal",
    redactionState: input.redactionState ?? "raw",
    reportedAt,
    dedupeKey,
    metadata,
    targetLocale: input.targetLocale,
  };
}

function normalizeFeedbackSource(
  input: ManualFeedbackImportInput,
): NormalizedManualFeedback["feedbackSource"] {
  const source = input.feedbackSource;
  return {
    sourceKind: source?.sourceKind ?? feedbackSourceKindValues.manualPlaytest,
    label: source?.label ?? "Manual playtest reports",
    sourceChannel: source?.sourceChannel ?? null,
    privacyReviewState: source?.privacyReviewState ?? "reviewed",
    metadata: source?.metadata ?? {},
  };
}

function classifyFeedback(feedbackType: FeedbackType): FeedbackTriageLabel {
  switch (feedbackType) {
    case feedbackTypeValues.objectiveDefect:
      return feedbackTriageLabelValues.objectiveDefectCandidate;
    case feedbackTypeValues.stylePreference:
      return feedbackTriageLabelValues.styleDisputeCandidate;
    case feedbackTypeValues.glossaryCanonIssue:
      return feedbackTriageLabelValues.glossaryCanonCandidate;
    case feedbackTypeValues.runtimeIssue:
      return feedbackTriageLabelValues.runtimeIssueCandidate;
    case feedbackTypeValues.assetIssue:
      return feedbackTriageLabelValues.assetIssueCandidate;
    case feedbackTypeValues.unclearContext:
      return feedbackTriageLabelValues.contextCorrectionCandidate;
  }
}

function summarizeAttachments(attachments: ManualFeedbackAttachment[]): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const artifactIds: string[] = [];
  for (const attachment of attachments) {
    counts[attachment.attachmentKind] = (counts[attachment.attachmentKind] ?? 0) + 1;
    if (attachment.artifactId) {
      artifactIds.push(attachment.artifactId);
    }
  }

  return {
    counts,
    artifactIds,
  };
}

function contextSignalsFor(input: ManualFeedbackImportInput): Record<string, unknown> {
  const lineReference = contextSignalForLineReference(input.lineReference);
  const attachmentSignals = (input.attachments ?? [])
    .map((attachment) => contextSignalForAttachment(attachment))
    .filter((signal): signal is Record<string, unknown> => signal !== null);

  return compactRecord({
    lineReference,
    attachmentSignals,
  });
}

function contextSignalForLineReference(
  lineReference: ManualFeedbackLineReference | undefined,
): Record<string, unknown> | null {
  const signal = normalizeLineReference(lineReference);
  if (!signal || !hasUsableLineReferenceSignal(signal)) {
    return null;
  }
  return signal;
}

function contextSignalForAttachment(
  attachment: ManualFeedbackAttachment,
): Record<string, unknown> | null {
  let signal: Record<string, unknown>;
  switch (attachment.attachmentKind) {
    case "screenshot":
      signal = compactRecord({
        attachmentKind: attachment.attachmentKind,
        artifactId: attachment.artifactId,
        uri: attachment.uri,
        hash: attachment.hash,
        capturePosition: attachment.capturePosition,
      });
      return hasAnySignalField(signal, ["artifactId", "uri", "hash", "capturePosition"])
        ? signal
        : null;
    case "save_context":
      signal = compactRecord({
        attachmentKind: attachment.attachmentKind,
        artifactId: attachment.artifactId,
        contextToken: attachment.contextToken,
        routeRef: attachment.routeRef,
        sceneRef: attachment.sceneRef,
        uri: attachment.uri,
        hash: attachment.hash,
      });
      return hasAnySignalField(signal, [
        "artifactId",
        "contextToken",
        "routeRef",
        "sceneRef",
        "uri",
        "hash",
      ])
        ? signal
        : null;
    case "context":
      signal = compactRecord({
        attachmentKind: attachment.attachmentKind,
        contextKind: attachment.contextKind,
        contextId: attachment.contextId,
        routeRef: attachment.routeRef,
        sceneRef: attachment.sceneRef,
        speakerRef: attachment.speakerRef,
        visibleText: attachment.visibleText,
      });
      return hasAnySignalField(signal, [
        "contextId",
        "routeRef",
        "sceneRef",
        "speakerRef",
        "visibleText",
      ])
        ? signal
        : null;
    case "runtime_artifact":
      signal = compactRecord({
        attachmentKind: attachment.attachmentKind,
        artifactId: attachment.artifactId,
        uri: attachment.uri,
        hash: attachment.hash,
        runtimeArtifactId: attachment.runtimeArtifactId,
        evidenceTier: attachment.evidenceTier,
      });
      return hasAnySignalField(signal, ["artifactId", "uri", "hash", "runtimeArtifactId"])
        ? signal
        : null;
  }
}

function primaryDedupeAnchor(input: ManualFeedbackImportInput): Record<string, unknown> {
  const lineReference = contextSignalForLineReference(input.lineReference);
  if (lineReference === null) {
    throw new Error("manual feedback requires a bridge-unit line reference for deduplication");
  }
  return { lineReference };
}

export function subjectRefsFor(
  feedbackReportId: string,
  input: ManualFeedbackImportInput,
): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [
    { subjectKind: "feedback_report", subjectId: feedbackReportId },
  ];
  if (input.lineReference?.bridgeUnitId) {
    refs.push({
      subjectKind: "bridge_unit",
      subjectId: input.lineReference.bridgeUnitId,
      label: input.lineReference.sourceUnitKey,
    });
  }
  return refs;
}

export function artifactKindForAttachment(attachment: ManualFeedbackAttachment): string {
  switch (attachment.attachmentKind) {
    case "screenshot":
      return "feedback_screenshot";
    case "save_context":
      return "feedback_save_context";
    case "context":
      return "feedback_context";
    case "runtime_artifact":
      return "feedback_runtime_artifact";
  }
}

export function eventIdFor(eventKind: string, feedbackEvidenceId: string): string {
  return `${feedbackEvidenceId}:${eventKind}`;
}

export function labelFromRow(value: string | undefined): FeedbackTriageLabel | undefined {
  return Object.values(feedbackTriageLabelValues).includes(value as FeedbackTriageLabel)
    ? (value as FeedbackTriageLabel)
    : undefined;
}

export function statusFromRow(value: string | undefined): FeedbackReportStatus | undefined {
  return Object.values(feedbackReportStatusValues).includes(value as FeedbackReportStatus)
    ? (value as FeedbackReportStatus)
    : undefined;
}

export function contextFromRow(value: string | undefined): FeedbackContextStatus | undefined {
  return Object.values(feedbackContextStatusValues).includes(value as FeedbackContextStatus)
    ? (value as FeedbackContextStatus)
    : undefined;
}
