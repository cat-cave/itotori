import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
} from "../schema.js";

export const feedbackSourceKindValues = {
  manualPlaytest: "manual_playtest",
  manualReview: "manual_review",
  importedFile: "imported_file",
  runtimeReview: "runtime_review",
  internalNote: "internal_note",
  communityChannel: "community_channel",
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
  contextCorrectionCandidate: "context_correction_candidate",
} as const;

export type FeedbackTriageLabel =
  (typeof feedbackTriageLabelValues)[keyof typeof feedbackTriageLabelValues];

export const feedbackContextStatusValues = {
  contextualized: "contextualized",
} as const;

export type FeedbackContextStatus =
  (typeof feedbackContextStatusValues)[keyof typeof feedbackContextStatusValues];

export const feedbackReportStatusValues = {
  open: "open",
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
  /** Every feedback import is scoped to a concrete bridge unit. */
  bridgeUnitId: string;
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
  /** The canonical branch that owns the concrete bridge-unit target. */
  localeBranchId: string;
  sourceBundleId?: string;
  feedbackType: FeedbackType;
  reporter: FeedbackReporter;
  reporterNote: string;
  /** A feedback import never creates a deferred, targetless report. */
  lineReference: ManualFeedbackLineReference;
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

/**
 * Internal write shape after the repository has resolved the locale from the
 * canonical branch. Import callers never choose the persisted target locale.
 */
type ScopedManualFeedbackInput = ManualFeedbackImportInput & { targetLocale: string };

/**
 * Persisted context needed to turn a feedback report into a canonical context
 * correction. This deliberately does not describe a separate decision item:
 * feedback intake is allowed to feed the shared correction path directly.
 */
export type ManualFeedbackCorrectionContext = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  feedbackType: FeedbackType;
  triageLabel: FeedbackTriageLabel;
  contextStatus: FeedbackContextStatus;
  /** The report/evidence text as durably persisted by feedback intake. */
  reporterNote: string;
  suggestedEdit: string | null;
  /** Stable, persisted target units; never inferred from a caller's raw input. */
  affectedUnitIds: string[];
};

export interface ItotoriFeedbackRepositoryPort {
  importManualFeedback(
    actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult>;
  loadManualFeedbackCorrectionContext(
    actor: AuthorizationActor,
    feedbackReportId: string,
    feedbackEvidenceId: string,
  ): Promise<ManualFeedbackCorrectionContext | null>;
}

export class ItotoriFeedbackRepository implements ItotoriFeedbackRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async importManualFeedback(
    actor: AuthorizationActor,
    input: ManualFeedbackImportInput,
  ): Promise<ManualFeedbackImportResult> {
    await requirePermission(this.db, actor, permissionValues.feedbackImport);
    const parsedInput = parseManualFeedbackImportInput(input);

    return this.db.transaction(async (tx) => {
      const branchRows = await tx
        .select({ targetLocale: localeBranches.targetLocale })
        .from(localeBranches)
        .where(
          and(
            eq(localeBranches.projectId, parsedInput.projectId),
            eq(localeBranches.localeBranchId, parsedInput.localeBranchId),
          ),
        )
        .limit(1);
      const targetLocale = branchRows[0]?.targetLocale;
      if (targetLocale === undefined) {
        throw new Error(
          `manual feedback locale branch ${parsedInput.localeBranchId} does not belong to project ${parsedInput.projectId}`,
        );
      }
      const scopedInput: ScopedManualFeedbackInput = { ...parsedInput, targetLocale };
      const normalized = normalizeManualFeedback(scopedInput);

      await tx
        .insert(feedbackSources)
        .values({
          feedbackSourceId: normalized.feedbackSourceId,
          projectId: parsedInput.projectId,
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

      if (
        existing !== undefined &&
        (labelFromRow(existing.triageLabel) === undefined ||
          statusFromRow(existing.reportStatus) === undefined ||
          contextFromRow(existing.contextStatus) === undefined)
      ) {
        throw new Error(
          `manual feedback report ${existing.feedbackReportId} is a legacy targetless report; create a canonical Wiki correction before importing it again`,
        );
      }

      if (!existing) {
        await tx.insert(feedbackReports).values({
          feedbackReportId,
          projectId: parsedInput.projectId,
          localeBranchId: parsedInput.localeBranchId,
          sourceBundleId: parsedInput.sourceBundleId ?? null,
          bridgeUnitId: parsedInput.lineReference.bridgeUnitId,
          targetLocale: normalized.targetLocale,
          feedbackSourceId: normalized.feedbackSourceId,
          feedbackType: parsedInput.feedbackType,
          triageLabel: normalized.triageLabel,
          reportStatus: normalized.reportStatus,
          contextStatus: normalized.contextStatus,
          privacyClassification: normalized.privacyClassification,
          redactionState: normalized.redactionState,
          reporterRole: parsedInput.reporter.role,
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
          reporter: parsedInput.reporter,
          reporterNote: normalized.reporterNote,
          lineReference: normalized.lineReference,
          attachments: normalized.attachments,
          contextSignals: normalized.contextSignals,
          metadata: {
            ...normalized.metadata,
            importedFeedbackType: parsedInput.feedbackType,
          },
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
            projectId: parsedInput.projectId,
            localeBranchId: parsedInput.localeBranchId,
            sourceBundleId: parsedInput.sourceBundleId ?? null,
            bridgeUnitId: parsedInput.lineReference.bridgeUnitId,
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
              localeBranchId: parsedInput.localeBranchId,
              sourceBundleId: parsedInput.sourceBundleId ?? null,
              bridgeUnitId: parsedInput.lineReference.bridgeUnitId,
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
          projectId: parsedInput.projectId,
          localeBranchId: parsedInput.localeBranchId,
          eventKind,
          occurredAt: normalized.reportedAt,
          actor: {
            actorKind: "human",
            userId: actor.userId,
            displayName: parsedInput.reporter.displayName ?? parsedInput.reporter.role,
          },
          subjectRefs: subjectRefsFor(feedbackReportId, scopedInput),
          provenance: [
            {
              provenanceKind: "feedback_source",
              feedbackSourceId: normalized.feedbackSourceId,
            },
          ],
          causalLinks: [],
          payload: {
            feedbackEvidenceId: normalized.feedbackEvidenceId,
            feedbackType: parsedInput.feedbackType,
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

  async loadManualFeedbackCorrectionContext(
    actor: AuthorizationActor,
    feedbackReportId: string,
    feedbackEvidenceId: string,
  ): Promise<ManualFeedbackCorrectionContext | null> {
    await requirePermission(this.db, actor, permissionValues.feedbackImport);
    const rows = await this.db
      .select({
        feedbackReportId: feedbackReports.feedbackReportId,
        feedbackEvidenceId: feedbackReportEvidence.feedbackEvidenceId,
        projectId: feedbackReports.projectId,
        localeBranchId: feedbackReports.localeBranchId,
        bridgeUnitId: feedbackReports.bridgeUnitId,
        feedbackType: feedbackReports.feedbackType,
        triageLabel: feedbackReports.triageLabel,
        contextStatus: feedbackReports.contextStatus,
        reportMetadata: feedbackReports.metadata,
        reporterNote: feedbackReportEvidence.reporterNote,
        evidenceMetadata: feedbackReportEvidence.metadata,
      })
      .from(feedbackReports)
      .innerJoin(
        feedbackReportEvidence,
        eq(feedbackReportEvidence.feedbackReportId, feedbackReports.feedbackReportId),
      )
      .where(
        and(
          eq(feedbackReports.feedbackReportId, feedbackReportId),
          eq(feedbackReportEvidence.feedbackEvidenceId, feedbackEvidenceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    const triageLabel = row === undefined ? undefined : labelFromRow(row.triageLabel);
    const contextStatus = row === undefined ? undefined : contextFromRow(row.contextStatus);
    if (
      row === undefined ||
      row.localeBranchId === null ||
      row.bridgeUnitId === null ||
      row.bridgeUnitId.trim().length === 0 ||
      triageLabel === undefined ||
      contextStatus === undefined
    ) {
      return null;
    }

    // The rerun must target the branch's CURRENT source revision. A report's
    // optional source-bundle/metadata fields are historical caller input and
    // can be stale by the time feedback becomes a correction.
    const sourceRevisionId = await this.loadCurrentBranchSourceRevisionId(
      row.projectId,
      row.localeBranchId,
    );
    if (sourceRevisionId === undefined) {
      return null;
    }

    return {
      feedbackReportId: row.feedbackReportId,
      feedbackEvidenceId: row.feedbackEvidenceId,
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      sourceRevisionId,
      feedbackType: row.feedbackType as FeedbackType,
      triageLabel,
      contextStatus,
      reporterNote: row.reporterNote,
      suggestedEdit:
        stringFromRecord(row.evidenceMetadata, "suggestedEdit") ??
        stringFromRecord(row.reportMetadata, "suggestedEdit") ??
        null,
      affectedUnitIds: [row.bridgeUnitId],
    };
  }

  private async loadCurrentBranchSourceRevisionId(
    projectId: string,
    localeBranchId: string,
  ): Promise<string | undefined> {
    const branchRows = await this.db
      .select({ sourceRevisionId: sourceBundles.sourceBundleRevisionId })
      .from(localeBranches)
      .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
      .where(
        and(
          eq(localeBranches.projectId, projectId),
          eq(localeBranches.localeBranchId, localeBranchId),
        ),
      )
      .limit(1);
    return branchRows[0]?.sourceRevisionId;
  }
}

export function parseManualFeedbackImportInput(value: unknown): ManualFeedbackImportInput {
  const input = requireRecord(value, "manual feedback input");
  if ("targetLocale" in input) {
    throw new Error(
      "manual feedback targetLocale is server-owned by localeBranchId and must not be supplied",
    );
  }
  const parsed: ManualFeedbackImportInput = {
    projectId: requiredString(input, "projectId"),
    localeBranchId: requiredNonBlankString(input, "localeBranchId"),
    feedbackType: requiredEnum(input, "feedbackType", Object.values(feedbackTypeValues)),
    reporter: parseReporter(input.reporter),
    reporterNote: requiredString(input, "reporterNote"),
    lineReference: parseLineReference(input.lineReference),
  };

  assignOptionalString(parsed, input, "feedbackReportId");
  assignOptionalString(parsed, input, "feedbackEvidenceId");
  assignOptionalString(parsed, input, "feedbackSourceId");
  assignOptionalString(parsed, input, "sourceBundleId");
  assignOptionalString(parsed, input, "privacyClassification");
  assignOptionalString(parsed, input, "redactionState");
  assignOptionalString(parsed, input, "reportedAt");
  assignOptionalString(parsed, input, "dedupeKey");
  assignOptionalString(parsed, input, "suggestedEdit");

  if (input.feedbackSource !== undefined) {
    parsed.feedbackSource = parseFeedbackSourceInput(input.feedbackSource);
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) {
      throw new Error("manual feedback attachments must be an array");
    }
    parsed.attachments = input.attachments.map((attachment, index) =>
      parseAttachment(attachment, `manual feedback attachments[${index}]`),
    );
  }
  if (input.metadata !== undefined) {
    parsed.metadata = requireRecord(input.metadata, "manual feedback metadata");
  }
  if (parsed.reportedAt !== undefined && Number.isNaN(new Date(parsed.reportedAt).getTime())) {
    throw new Error("manual feedback reportedAt must be a valid date string");
  }

  return parsed;
}

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
  targetLocale: string;
};

type FeedbackWriteDatabase = Pick<ItotoriDatabase, "execute" | "update">;

function normalizeManualFeedback(input: ScopedManualFeedbackInput): NormalizedManualFeedback {
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
    if (isRecord(entry)) {
      const nested = compactRecord(entry);
      if (Object.keys(nested).length === 0) {
        continue;
      }
      compacted[key] = nested;
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

function normalizeLineReference(
  lineReference: ManualFeedbackLineReference | undefined,
): Record<string, unknown> | null {
  if (!lineReference) {
    return null;
  }
  const normalized = compactRecord(lineReference);
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function hasUsableLineReferenceSignal(signal: Record<string, unknown>): boolean {
  return hasAnySignalField(signal, [
    "bridgeUnitId",
    "sourceUnitKey",
    "sourceHash",
    "assetId",
    "path",
    "line",
    "sourceLocation",
    "quotedText",
  ]);
}

function hasAnySignalField(signal: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => hasMeaningfulSignalValue(signal[field]));
}

function hasMeaningfulSignalValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return true;
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

function parseReporter(value: unknown): FeedbackReporter {
  const reporter = requireRecord(value, "manual feedback reporter");
  const parsed: FeedbackReporter = {
    role: requiredString(reporter, "reporter.role"),
  };
  assignOptionalString(parsed, reporter, "reporterId");
  assignOptionalString(parsed, reporter, "displayName");
  assignOptionalString(parsed, reporter, "contact");
  return parsed;
}

function parseFeedbackSourceInput(value: unknown): ManualFeedbackSourceInput {
  const source = requireRecord(value, "manual feedback feedbackSource");
  const parsed: ManualFeedbackSourceInput = {};
  assignOptionalString(parsed, source, "feedbackSourceId");
  if (source.sourceKind !== undefined) {
    parsed.sourceKind = requiredEnum(
      source,
      "feedbackSource.sourceKind",
      Object.values(feedbackSourceKindValues),
    );
  }
  assignOptionalString(parsed, source, "label");
  assignOptionalString(parsed, source, "sourceChannel");
  assignOptionalString(parsed, source, "privacyReviewState");
  if (source.metadata !== undefined) {
    parsed.metadata = requireRecord(source.metadata, "feedbackSource.metadata");
  }
  return parsed;
}

function parseLineReference(value: unknown): ManualFeedbackLineReference {
  const reference = requireRecord(value, "manual feedback lineReference");
  const parsed: ManualFeedbackLineReference = {
    bridgeUnitId: requiredNonBlankString(reference, "lineReference.bridgeUnitId"),
  };
  assignOptionalString(parsed, reference, "sourceUnitKey");
  assignOptionalString(parsed, reference, "sourceHash");
  assignOptionalString(parsed, reference, "assetId");
  assignOptionalString(parsed, reference, "path");
  assignOptionalNumber(parsed, reference, "line");
  assignOptionalNumber(parsed, reference, "column");
  assignOptionalString(parsed, reference, "quotedText");
  if (reference.sourceLocation !== undefined) {
    parsed.sourceLocation = requireRecord(reference.sourceLocation, "lineReference.sourceLocation");
  }
  return parsed;
}

function parseAttachment(value: unknown, context: string): ManualFeedbackAttachment {
  const attachment = requireRecord(value, context);
  const base: ManualFeedbackAttachmentBase = {};
  assignOptionalString(base, attachment, "attachmentId");
  assignOptionalString(base, attachment, "artifactId");
  assignOptionalString(base, attachment, "uri");
  assignOptionalString(base, attachment, "hash");
  if (attachment.metadata !== undefined) {
    base.metadata = requireRecord(attachment.metadata, `${context}.metadata`);
  }

  const attachmentKind = requiredEnum(attachment, `${context}.attachmentKind`, [
    "screenshot",
    "save_context",
    "context",
    "runtime_artifact",
  ] as const);
  switch (attachmentKind) {
    case "screenshot": {
      const screenshot: ManualFeedbackScreenshotAttachment = {
        ...base,
        attachmentKind,
      };
      assignOptionalString(screenshot, attachment, "caption");
      assignOptionalString(screenshot, attachment, "capturePosition");
      assignOptionalString(screenshot, attachment, "evidenceTier");
      return screenshot;
    }
    case "save_context": {
      const saveContext: ManualFeedbackSaveContextAttachment = {
        ...base,
        attachmentKind,
      };
      assignOptionalString(saveContext, attachment, "contextToken");
      assignOptionalString(saveContext, attachment, "routeRef");
      assignOptionalString(saveContext, attachment, "sceneRef");
      assignOptionalString(saveContext, attachment, "createdAt");
      return saveContext;
    }
    case "context": {
      const contextAttachment: ManualFeedbackContextAttachment = {
        ...base,
        attachmentKind,
        contextKind: requiredString(attachment, `${context}.contextKind`),
      };
      assignOptionalString(contextAttachment, attachment, "contextId");
      assignOptionalString(contextAttachment, attachment, "routeRef");
      assignOptionalString(contextAttachment, attachment, "sceneRef");
      assignOptionalString(contextAttachment, attachment, "speakerRef");
      assignOptionalString(contextAttachment, attachment, "visibleText");
      return contextAttachment;
    }
    case "runtime_artifact": {
      const runtimeArtifact: ManualFeedbackRuntimeArtifactAttachment = {
        ...base,
        attachmentKind,
        runtimeArtifactId: requiredString(attachment, `${context}.runtimeArtifactId`),
      };
      assignOptionalString(runtimeArtifact, attachment, "evidenceTier");
      return runtimeArtifact;
    }
  }
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromRecord(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[fieldName(field)];
  if (typeof value !== "string") {
    throw new Error(`manual feedback ${field} must be a string`);
  }
  return value;
}

function requiredNonBlankString(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field).trim();
  if (value.length === 0) {
    throw new Error(`manual feedback ${field} must be a non-empty string`);
  }
  return value;
}

function assignOptionalString(
  target: object,
  source: Record<string, unknown>,
  field: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`manual feedback ${field} must be a string`);
  }
  (target as Record<string, unknown>)[field] = value;
}

function assignOptionalNumber(
  target: object,
  source: Record<string, unknown>,
  field: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`manual feedback ${field} must be a finite number`);
  }
  (target as Record<string, unknown>)[field] = value;
}

function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  values: T,
): T[number] {
  const value = record[fieldName(field)];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`manual feedback ${field} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function fieldName(field: string): string {
  return field.slice(field.lastIndexOf(".") + 1);
}
