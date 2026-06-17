import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
} from "../schema.js";

export const feedbackSourceKindValues = {
  manualPlaytest: "manual_playtest",
  manualReview: "manual_review",
  importedFile: "imported_file",
  runtimeReview: "runtime_review",
  internalNote: "internal_note",
} as const;

export type FeedbackSourceKind =
  (typeof feedbackSourceKindValues)[keyof typeof feedbackSourceKindValues];

export const feedbackTypeValues = {
  objectiveDefect: "objective_defect",
  stylePreference: "style_preference",
  glossaryCanonIssue: "glossary_canon_issue",
  unclearContext: "unclear_context",
  runtimeIssue: "runtime_issue",
  assetIssue: "asset_issue",
} as const;

export type FeedbackType = (typeof feedbackTypeValues)[keyof typeof feedbackTypeValues];

export const feedbackTriageLabelValues = {
  objectiveDefectCandidate: "objective_defect_candidate",
  styleDisputeCandidate: "style_dispute_candidate",
  glossaryCanonCandidate: "glossary_canon_candidate",
  runtimeIssueCandidate: "runtime_issue_candidate",
  assetIssueCandidate: "asset_issue_candidate",
  needsContext: "needs_context",
} as const;

export type FeedbackTriageLabel =
  (typeof feedbackTriageLabelValues)[keyof typeof feedbackTriageLabelValues];

export const feedbackContextStatusValues = {
  contextualized: "contextualized",
  needsContext: "needs_context",
} as const;

export type FeedbackContextStatus =
  (typeof feedbackContextStatusValues)[keyof typeof feedbackContextStatusValues];

export const feedbackReportStatusValues = {
  open: "open",
  needsContext: "needs_context",
} as const;

export type FeedbackReportStatus =
  (typeof feedbackReportStatusValues)[keyof typeof feedbackReportStatusValues];

export type FeedbackReporter = {
  role: string;
  reporterId?: string;
  displayName?: string;
  contact?: string;
};

export type ManualFeedbackLineReference = {
  bridgeUnitId?: string;
  sourceUnitKey?: string;
  sourceHash?: string;
  assetId?: string;
  path?: string;
  line?: number;
  column?: number;
  sourceLocation?: Record<string, unknown>;
  quotedText?: string;
};

type ManualFeedbackAttachmentBase = {
  attachmentId?: string;
  artifactId?: string;
  uri?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackScreenshotAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "screenshot";
  caption?: string;
  capturePosition?: string;
  evidenceTier?: string;
};

export type ManualFeedbackSaveContextAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "save_context";
  contextToken?: string;
  routeRef?: string;
  sceneRef?: string;
  createdAt?: string;
};

export type ManualFeedbackContextAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "context";
  contextKind: string;
  contextId?: string;
  routeRef?: string;
  sceneRef?: string;
  speakerRef?: string;
  visibleText?: string;
};

export type ManualFeedbackRuntimeArtifactAttachment = ManualFeedbackAttachmentBase & {
  attachmentKind: "runtime_artifact";
  runtimeArtifactId: string;
  evidenceTier?: string;
};

export type ManualFeedbackAttachment =
  | ManualFeedbackScreenshotAttachment
  | ManualFeedbackSaveContextAttachment
  | ManualFeedbackContextAttachment
  | ManualFeedbackRuntimeArtifactAttachment;

export type ManualFeedbackSourceInput = {
  feedbackSourceId?: string;
  sourceKind?: FeedbackSourceKind;
  label?: string;
  sourceChannel?: string;
  privacyReviewState?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackImportInput = {
  feedbackReportId?: string;
  feedbackEvidenceId?: string;
  feedbackSourceId?: string;
  feedbackSource?: ManualFeedbackSourceInput;
  projectId: string;
  localeBranchId?: string;
  sourceBundleId?: string;
  targetLocale: string;
  feedbackType: FeedbackType;
  reporter: FeedbackReporter;
  reporterNote: string;
  lineReference?: ManualFeedbackLineReference;
  attachments?: ManualFeedbackAttachment[];
  privacyClassification?: string;
  redactionState?: string;
  reportedAt?: string;
  dedupeKey?: string;
  suggestedEdit?: string;
  metadata?: Record<string, unknown>;
};

export type ManualFeedbackImportResult = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  feedbackSourceId: string;
  dedupeKey: string;
  triageLabel: FeedbackTriageLabel;
  reportStatus: FeedbackReportStatus;
  contextStatus: FeedbackContextStatus;
  reportCount: number;
  duplicate: boolean;
};

export interface ItotoriFeedbackRepositoryPort {
  importManualFeedback(
    actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult>;
}

export class ItotoriFeedbackRepository implements ItotoriFeedbackRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async importManualFeedback(
    actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    await requirePermission(this.db, actor, permissionValues.feedbackImport);
    const normalized = normalizeManualFeedback(input);

    return this.db.transaction(async (tx) => {
      await tx
        .insert(feedbackSources)
        .values({
          feedbackSourceId: normalized.feedbackSourceId,
          projectId: input.projectId,
          sourceKind: normalized.feedbackSource.sourceKind,
          label: normalized.feedbackSource.label,
          sourceChannel: normalized.feedbackSource.sourceChannel,
          privacyReviewState: normalized.feedbackSource.privacyReviewState,
          metadata: normalized.feedbackSource.metadata,
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: feedbackSources.feedbackSourceId,
          set: {
            label: normalized.feedbackSource.label,
            sourceChannel: normalized.feedbackSource.sourceChannel,
            privacyReviewState: normalized.feedbackSource.privacyReviewState,
            metadata: normalized.feedbackSource.metadata,
            updatedAt: sql`now()`,
          },
        });

      const existingRows = await tx
        .select({
          feedbackReportId: feedbackReports.feedbackReportId,
          reportStatus: feedbackReports.reportStatus,
          contextStatus: feedbackReports.contextStatus,
          triageLabel: feedbackReports.triageLabel,
        })
        .from(feedbackReports)
        .where(eq(feedbackReports.dedupeKey, normalized.dedupeKey))
        .limit(1);
      const existing = existingRows[0];
      const feedbackReportId = existing?.feedbackReportId ?? normalized.feedbackReportId;
      const duplicate = existing !== undefined;

      if (!existing) {
        await tx.insert(feedbackReports).values({
          feedbackReportId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId ?? null,
          sourceBundleId: input.sourceBundleId ?? null,
          bridgeUnitId: input.lineReference?.bridgeUnitId ?? null,
          targetLocale: input.targetLocale,
          feedbackSourceId: normalized.feedbackSourceId,
          feedbackType: input.feedbackType,
          triageLabel: normalized.triageLabel,
          reportStatus: normalized.reportStatus,
          contextStatus: normalized.contextStatus,
          privacyClassification: normalized.privacyClassification,
          redactionState: normalized.redactionState,
          reporterRole: input.reporter.role,
          reporterNote: normalized.reporterNote,
          dedupeKey: normalized.dedupeKey,
          lineReference: normalized.lineReference,
          attachmentSummary: normalized.attachmentSummary,
          reportCount: 1,
          metadata: normalized.metadata,
          firstReportedAt: normalized.reportedAt,
          lastReportedAt: normalized.reportedAt,
        });
      }

      await tx
        .insert(feedbackReportEvidence)
        .values({
          feedbackEvidenceId: normalized.feedbackEvidenceId,
          feedbackReportId,
          feedbackSourceId: normalized.feedbackSourceId,
          reporter: input.reporter,
          reporterNote: normalized.reporterNote,
          lineReference: normalized.lineReference,
          attachments: normalized.attachments,
          contextSignals: normalized.contextSignals,
          metadata: normalized.metadata,
          reportedAt: normalized.reportedAt,
        })
        .onConflictDoNothing();

      for (const attachment of normalized.attachments) {
        const artifactId = attachment.artifactId;
        if (!artifactId) {
          continue;
        }

        await tx
          .insert(artifacts)
          .values({
            artifactId,
            projectId: input.projectId,
            localeBranchId: input.localeBranchId ?? null,
            sourceBundleId: input.sourceBundleId ?? null,
            bridgeUnitId: input.lineReference?.bridgeUnitId ?? null,
            artifactKind: artifactKindForAttachment(attachment),
            uri: attachment.uri ?? null,
            hash: attachment.hash ?? null,
            metadata: {
              feedbackReportId,
              feedbackEvidenceId: normalized.feedbackEvidenceId,
              attachment,
            },
          })
          .onConflictDoUpdate({
            target: artifacts.artifactId,
            set: {
              localeBranchId: input.localeBranchId ?? null,
              sourceBundleId: input.sourceBundleId ?? null,
              bridgeUnitId: input.lineReference?.bridgeUnitId ?? null,
              artifactKind: artifactKindForAttachment(attachment),
              uri: attachment.uri ?? null,
              hash: attachment.hash ?? null,
              metadata: {
                feedbackReportId,
                feedbackEvidenceId: normalized.feedbackEvidenceId,
                attachment,
              },
            },
          });
      }

      const reportCount = await refreshReportCount(tx, feedbackReportId, normalized.reportedAt);
      const eventKind = duplicate
        ? "feedback_report_duplicate_aggregated"
        : "feedback_report_imported";

      await tx
        .insert(events)
        .values({
          eventId: eventIdFor(eventKind, normalized.feedbackEvidenceId),
          projectId: input.projectId,
          localeBranchId: input.localeBranchId ?? null,
          eventKind,
          occurredAt: normalized.reportedAt,
          actor: {
            actorKind: "human",
            userId: actor.userId,
            displayName: input.reporter.displayName ?? input.reporter.role,
          },
          subjectRefs: subjectRefsFor(feedbackReportId, input),
          provenance: [
            {
              provenanceKind: "feedback_source",
              feedbackSourceId: normalized.feedbackSourceId,
            },
          ],
          causalLinks: [],
          payload: {
            feedbackEvidenceId: normalized.feedbackEvidenceId,
            feedbackType: input.feedbackType,
            triageLabel: existing?.triageLabel ?? normalized.triageLabel,
            contextStatus: existing?.contextStatus ?? normalized.contextStatus,
            dedupeKey: normalized.dedupeKey,
            reportCount,
            duplicate,
          },
        })
        .onConflictDoNothing();

      return {
        feedbackReportId,
        feedbackEvidenceId: normalized.feedbackEvidenceId,
        feedbackSourceId: normalized.feedbackSourceId,
        dedupeKey: normalized.dedupeKey,
        triageLabel: labelFromRow(existing?.triageLabel) ?? normalized.triageLabel,
        reportStatus: statusFromRow(existing?.reportStatus) ?? normalized.reportStatus,
        contextStatus: contextFromRow(existing?.contextStatus) ?? normalized.contextStatus,
        reportCount,
        duplicate,
      };
    });
  }
}

export function deriveFeedbackDedupeKey(input: ManualFeedbackImportInput): string {
  if (input.dedupeKey) {
    return `feedback:manual:${hashJson({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId ?? null,
      dedupeKey: normalizeText(input.dedupeKey),
    })}`;
  }

  return `feedback:sha256:${hashJson({
    projectId: input.projectId,
    localeBranchId: input.localeBranchId ?? null,
    targetLocale: input.targetLocale,
    feedbackType: input.feedbackType,
    anchor: primaryDedupeAnchor(input),
    reporterNote: normalizeText(input.reporterNote).slice(0, 512),
  })}`;
}

type NormalizedManualFeedback = {
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
};

type FeedbackWriteDatabase = Pick<ItotoriDatabase, "execute" | "update">;

function normalizeManualFeedback(input: ManualFeedbackImportInput): NormalizedManualFeedback {
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
  const contextStatus = hasContextSignals(contextSignals)
    ? feedbackContextStatusValues.contextualized
    : feedbackContextStatusValues.needsContext;
  const triageLabel = classifyFeedback(input.feedbackType, contextStatus);
  const reportStatus =
    contextStatus === feedbackContextStatusValues.needsContext
      ? feedbackReportStatusValues.needsContext
      : feedbackReportStatusValues.open;
  const metadata = {
    ...input.metadata,
    ...(input.suggestedEdit ? { suggestedEdit: input.suggestedEdit } : {}),
  };
  const attachments = input.attachments ?? [];
  const lineReference = input.lineReference ? compactRecord(input.lineReference) : null;
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

function classifyFeedback(
  feedbackType: FeedbackType,
  contextStatus: FeedbackContextStatus,
): FeedbackTriageLabel {
  if (contextStatus === feedbackContextStatusValues.needsContext) {
    return feedbackTriageLabelValues.needsContext;
  }

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
      return feedbackTriageLabelValues.needsContext;
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
  const lineReference = input.lineReference ? compactRecord(input.lineReference) : null;
  const attachmentSignals = (input.attachments ?? [])
    .map((attachment) => compactRecord(contextSignalForAttachment(attachment)))
    .filter((signal) => Object.keys(signal).length > 0);

  return compactRecord({
    lineReference,
    attachmentSignals,
  });
}

function contextSignalForAttachment(attachment: ManualFeedbackAttachment): Record<string, unknown> {
  switch (attachment.attachmentKind) {
    case "screenshot":
      return {
        attachmentKind: attachment.attachmentKind,
        artifactId: attachment.artifactId,
        uri: attachment.uri,
        hash: attachment.hash,
        capturePosition: attachment.capturePosition,
      };
    case "save_context":
      return {
        attachmentKind: attachment.attachmentKind,
        contextToken: attachment.contextToken,
        routeRef: attachment.routeRef,
        sceneRef: attachment.sceneRef,
        uri: attachment.uri,
        hash: attachment.hash,
      };
    case "context":
      return {
        attachmentKind: attachment.attachmentKind,
        contextKind: attachment.contextKind,
        contextId: attachment.contextId,
        routeRef: attachment.routeRef,
        sceneRef: attachment.sceneRef,
        speakerRef: attachment.speakerRef,
        visibleText: attachment.visibleText,
      };
    case "runtime_artifact":
      return {
        attachmentKind: attachment.attachmentKind,
        runtimeArtifactId: attachment.runtimeArtifactId,
        evidenceTier: attachment.evidenceTier,
      };
  }
}

function hasContextSignals(contextSignals: Record<string, unknown>): boolean {
  if (contextSignals.lineReference !== undefined) {
    return true;
  }
  const attachmentSignals = contextSignals.attachmentSignals;
  return Array.isArray(attachmentSignals) && attachmentSignals.length > 0;
}

function primaryDedupeAnchor(input: ManualFeedbackImportInput): Record<string, unknown> {
  const lineReference = input.lineReference ? compactRecord(input.lineReference) : null;
  if (lineReference && Object.keys(lineReference).length > 0) {
    return { lineReference };
  }

  const attachmentSignals = (input.attachments ?? [])
    .map((attachment) => compactRecord(contextSignalForAttachment(attachment)))
    .filter((signal) => Object.keys(signal).length > 0);
  if (attachmentSignals.length > 0) {
    return { attachmentSignals };
  }

  return { missingContext: true };
}

function subjectRefsFor(
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

function artifactKindForAttachment(attachment: ManualFeedbackAttachment): string {
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

async function refreshReportCount(
  tx: FeedbackWriteDatabase,
  feedbackReportId: string,
  reportedAt: Date,
): Promise<number> {
  const result = await tx.execute(sql`
    select count(*)::int as report_count
    from ${feedbackReportEvidence}
    where ${feedbackReportEvidence.feedbackReportId} = ${feedbackReportId}
  `);
  const reportCount = Number(result.rows[0]?.report_count ?? 1);
  await tx
    .update(feedbackReports)
    .set({
      reportCount,
      lastReportedAt: reportedAt,
      updatedAt: sql`now()`,
    })
    .where(eq(feedbackReports.feedbackReportId, feedbackReportId));
  return reportCount;
}

function eventIdFor(eventKind: string, feedbackEvidenceId: string): string {
  return `${feedbackEvidenceId}:${eventKind}`;
}

function labelFromRow(value: string | undefined): FeedbackTriageLabel | undefined {
  return Object.values(feedbackTriageLabelValues).includes(value as FeedbackTriageLabel)
    ? (value as FeedbackTriageLabel)
    : undefined;
}

function statusFromRow(value: string | undefined): FeedbackReportStatus | undefined {
  return Object.values(feedbackReportStatusValues).includes(value as FeedbackReportStatus)
    ? (value as FeedbackReportStatus)
    : undefined;
}

function contextFromRow(value: string | undefined): FeedbackContextStatus | undefined {
  return Object.values(feedbackContextStatusValues).includes(value as FeedbackContextStatus)
    ? (value as FeedbackContextStatus)
    : undefined;
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
    compacted[key] = entry;
  }
  return compacted;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
