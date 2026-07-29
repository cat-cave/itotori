import { and, eq, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
} from "../schema.js";
import {
  artifactKindForAttachment,
  contextFromRow,
  eventIdFor,
  labelFromRow,
  normalizeManualFeedback,
  statusFromRow,
  subjectRefsFor,
  type ScopedManualFeedbackInput,
} from "./feedback-repository-normalization.js";
import { parseManualFeedbackImportInput } from "./feedback-repository-parsing.js";
import type {
  FeedbackType,
  ItotoriFeedbackRepositoryPort,
  ManualFeedbackCorrectionContext,
  ManualFeedbackImportInput,
  ManualFeedbackImportResult,
  UnitBoundFeedbackNote,
} from "./feedback-repository-types.js";
import { stringFromRecord } from "./feedback-repository-utils.js";

type FeedbackWriteDatabase = Pick<ItotoriDatabase, "execute" | "update">;

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

  async listUnitBoundFeedback(
    actor: AuthorizationActor,
    query: { projectId: string; localeBranchId: string; bridgeUnitId: string },
  ): Promise<UnitBoundFeedbackNote[]> {
    await requirePermission(this.db, actor, permissionValues.feedbackImport);
    const bridgeUnitId = query.bridgeUnitId.trim();
    if (bridgeUnitId.length === 0) {
      throw new Error("listUnitBoundFeedback requires a non-empty bridgeUnitId");
    }
    const rows = await this.db
      .select({
        feedbackReportId: feedbackReports.feedbackReportId,
        projectId: feedbackReports.projectId,
        localeBranchId: feedbackReports.localeBranchId,
        bridgeUnitId: feedbackReports.bridgeUnitId,
        triageLabel: feedbackReports.triageLabel,
        contextStatus: feedbackReports.contextStatus,
        reportMetadata: feedbackReports.metadata,
        reportCount: feedbackReports.reportCount,
        feedbackEvidenceId: feedbackReportEvidence.feedbackEvidenceId,
        reporterNote: feedbackReportEvidence.reporterNote,
        evidenceMetadata: feedbackReportEvidence.metadata,
        lineReference: feedbackReportEvidence.lineReference,
        reportedAt: feedbackReportEvidence.reportedAt,
      })
      .from(feedbackReports)
      .innerJoin(
        feedbackReportEvidence,
        eq(feedbackReportEvidence.feedbackReportId, feedbackReports.feedbackReportId),
      )
      .where(
        and(
          eq(feedbackReports.projectId, query.projectId),
          eq(feedbackReports.localeBranchId, query.localeBranchId),
          eq(feedbackReports.bridgeUnitId, bridgeUnitId),
        ),
      )
      .orderBy(feedbackReportEvidence.reportedAt, feedbackReportEvidence.feedbackEvidenceId);

    const notes: UnitBoundFeedbackNote[] = [];
    for (const row of rows) {
      const triageLabel = labelFromRow(row.triageLabel);
      const contextStatus = contextFromRow(row.contextStatus);
      if (triageLabel === undefined || contextStatus === undefined) {
        continue;
      }
      const lineRef =
        row.lineReference !== null && typeof row.lineReference === "object"
          ? (row.lineReference as Record<string, unknown>)
          : null;
      const sourceLocation =
        lineRef !== null &&
        lineRef.sourceLocation !== null &&
        typeof lineRef.sourceLocation === "object"
          ? (lineRef.sourceLocation as Record<string, unknown>)
          : null;
      const sceneFromLine =
        sourceLocation !== null && typeof sourceLocation.sceneId === "string"
          ? sourceLocation.sceneId
          : null;
      const sceneFromMeta =
        stringFromRecord(row.reportMetadata, "sceneId") ??
        stringFromRecord(row.evidenceMetadata, "sceneId") ??
        null;
      notes.push({
        feedbackReportId: row.feedbackReportId,
        feedbackEvidenceId: row.feedbackEvidenceId,
        projectId: row.projectId,
        localeBranchId: row.localeBranchId ?? query.localeBranchId,
        bridgeUnitId: row.bridgeUnitId,
        sceneId: sceneFromLine ?? sceneFromMeta,
        note: row.reporterNote,
        severity: stringFromRecord(row.reportMetadata, "severity") ?? "note",
        category: stringFromRecord(row.reportMetadata, "category") ?? "",
        triageLabel,
        contextStatus,
        reportedAt: row.reportedAt.toISOString(),
        duplicate: row.reportCount > 1,
      });
    }
    return notes;
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
