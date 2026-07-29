import { asc, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import {
  localeBranches,
  sourceBundles,
  sourceRevisions,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  buildStyleGuideApprovalEventPayload,
  buildStyleGuideVersionCreatedPayload,
  contentHashForPolicy,
  type ApproveStyleGuideVersionInput,
  type ApproveStyleGuideVersionResult,
  type CreateStyleGuideVersionInput,
  type CreateStyleGuideVersionResult,
  type ItotoriStyleGuideRepositoryPort,
  type LocaleBranchStyleGuideContext,
  type StyleGuideRecord,
  type StyleGuideVersionRecord,
} from "./style-guide-repository-contracts.js";
import { appendAffectedWorkInvalidatedEventsInTx, appendStyleGuideVersionChangedEventInTx } from "./style-guide-repository-outbox.js";
import {
  getLocaleBranchContextInTx,
  getSourceRevisionInTx,
  getVersionByIdInTx,
  rowNumber,
  styleGuideFromRow,
  versionFromJoinedRow,
} from "./style-guide-repository-rows.js";

export class ItotoriStyleGuideRepository implements ItotoriStyleGuideRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async authorizeApproval(actor: AuthorizationActor): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.styleGuideApprove);
  }

  async getLocaleBranchContext(
    projectId: string,
    localeBranchId: string,
  ): Promise<LocaleBranchStyleGuideContext | null> {
    const rows = await this.db
      .select({
        projectId: localeBranches.projectId,
        localeBranchId: localeBranches.localeBranchId,
        targetLocale: localeBranches.targetLocale,
        sourceBundleId: localeBranches.sourceBundleId,
        sourceRevisionId: sourceRevisions.sourceRevisionId,
        revisionKind: sourceRevisions.revisionKind,
        value: sourceRevisions.value,
      })
      .from(localeBranches)
      .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
      .innerJoin(
        sourceRevisions,
        eq(sourceRevisions.sourceRevisionId, sourceBundles.sourceBundleRevisionId),
      )
      .where(
        sql`${localeBranches.projectId} = ${projectId} and ${localeBranches.localeBranchId} = ${localeBranchId}`,
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      targetLocale: row.targetLocale,
      sourceBundleId: row.sourceBundleId,
      sourceRevisionReference: {
        sourceRevisionId: row.sourceRevisionId,
        revisionKind: row.revisionKind,
        value: row.value,
      },
    };
  }

  async getStyleGuideByLocaleBranchId(localeBranchId: string): Promise<StyleGuideRecord | null> {
    const rows = await this.db
      .select()
      .from(styleGuides)
      .where(eq(styleGuides.localeBranchId, localeBranchId))
      .limit(1);
    return rows[0] === undefined ? null : styleGuideFromRow(rows[0]);
  }

  async getLatestVersionByLocaleBranchId(
    localeBranchId: string,
  ): Promise<StyleGuideVersionRecord | null> {
    const guide = await this.getStyleGuideByLocaleBranchId(localeBranchId);
    if (guide?.latestVersionId === null || guide === null) {
      return null;
    }
    return this.getVersionById(guide.latestVersionId);
  }

  async getApprovedVersionByLocaleBranchId(
    localeBranchId: string,
  ): Promise<StyleGuideVersionRecord | null> {
    const guide = await this.getStyleGuideByLocaleBranchId(localeBranchId);
    if (guide?.approvedVersionId === null || guide === null) {
      return null;
    }
    return this.getVersionById(guide.approvedVersionId);
  }

  async listVersionsByLocaleBranchId(localeBranchId: string): Promise<StyleGuideVersionRecord[]> {
    const rows = await this.db
      .select({
        version: styleGuideVersions,
        sourceRevision: sourceRevisions,
      })
      .from(styleGuideVersions)
      .innerJoin(
        sourceRevisions,
        eq(sourceRevisions.sourceRevisionId, styleGuideVersions.sourceRevisionId),
      )
      .where(eq(styleGuideVersions.localeBranchId, localeBranchId))
      .orderBy(asc(styleGuideVersions.versionSequence), asc(styleGuideVersions.createdAt));
    return rows.map((row) => versionFromJoinedRow(row.version, row.sourceRevision));
  }

  async createVersion(
    actor: AuthorizationActor,
    input: CreateStyleGuideVersionInput,
  ): Promise<CreateStyleGuideVersionResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    return this.db.transaction(async (tx) => {
      const context = await getLocaleBranchContextInTx(tx, input.projectId, input.localeBranchId);
      if (context === null) {
        throw new Error(
          `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
        );
      }

      const sourceRevisionId =
        input.sourceRevisionId ?? context.sourceRevisionReference.sourceRevisionId;
      const sourceRevision = await getSourceRevisionInTx(tx, input.projectId, sourceRevisionId);
      if (sourceRevision === null) {
        throw new Error(
          `source revision ${sourceRevisionId} does not exist for project ${input.projectId}`,
        );
      }

      const existingGuides = await tx
        .select()
        .from(styleGuides)
        .where(eq(styleGuides.localeBranchId, input.localeBranchId))
        .limit(1);
      const existingGuide = existingGuides[0];
      const styleGuideId = existingGuide?.styleGuideId ?? `style-guide:${input.localeBranchId}`;
      const previousVersionId = existingGuide?.latestVersionId ?? null;

      if (
        input.expectedPreviousVersionId !== undefined &&
        input.expectedPreviousVersionId !== previousVersionId
      ) {
        throw new Error(
          `style guide version write expected previous version ${input.expectedPreviousVersionId ?? "none"} but latest is ${previousVersionId ?? "none"}`,
        );
      }

      if (existingGuide === undefined) {
        await tx.insert(styleGuides).values({
          styleGuideId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          createdByUserId: actor.userId,
        });
      }

      const sequenceRows = await tx.execute(sql`
        select coalesce(max(version_sequence), 0)::int as max_sequence
        from ${styleGuideVersions}
        where locale_branch_id = ${input.localeBranchId}
      `);
      const maxSequence = rowNumber(
        sequenceRows.rows[0] as Record<string, unknown>,
        "max_sequence",
      );
      const versionSequence = maxSequence + 1;
      const styleGuideVersionId = input.styleGuideVersionId ?? createUuid7();
      const status = input.status ?? styleGuideVersionStatusValues.draft;
      const approvedAt = status === styleGuideVersionStatusValues.approved ? new Date() : null;

      await tx.insert(styleGuideVersions).values({
        styleGuideVersionId,
        styleGuideId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        previousVersionId,
        sourceRevisionId,
        versionSequence,
        authorUserId: input.authorUserId ?? actor.userId,
        approverUserId: status === styleGuideVersionStatusValues.approved ? actor.userId : null,
        status,
        contentHash: input.contentHash ?? contentHashForPolicy(input.policy),
        policy: input.policy,
        semanticDiagnostics: input.semanticDiagnostics ?? [],
        approvedAt,
      });

      if (status === styleGuideVersionStatusValues.approved && existingGuide?.approvedVersionId) {
        await tx
          .update(styleGuideVersions)
          .set({ status: styleGuideVersionStatusValues.superseded, updatedAt: sql`now()` })
          .where(eq(styleGuideVersions.styleGuideVersionId, existingGuide.approvedVersionId));
      }

      await tx
        .update(styleGuides)
        .set({
          latestVersionId: styleGuideVersionId,
          approvedVersionId:
            status === styleGuideVersionStatusValues.approved
              ? styleGuideVersionId
              : (existingGuide?.approvedVersionId ?? null),
          updatedAt: sql`now()`,
        })
        .where(eq(styleGuides.styleGuideId, styleGuideId));

      const version = await getVersionByIdInTx(tx, styleGuideVersionId);
      if (version === null) {
        throw new Error(`style guide version ${styleGuideVersionId} was not persisted`);
      }
      const outboxEvent = await appendStyleGuideVersionChangedEventInTx(
        tx,
        buildStyleGuideVersionCreatedPayload({
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          previousVersionId,
          version,
        }),
      );
      return { version, outboxEvent };
    });
  }

  async approveVersion(
    actor: AuthorizationActor,
    input: ApproveStyleGuideVersionInput,
  ): Promise<ApproveStyleGuideVersionResult> {
    await requirePermission(this.db, actor, permissionValues.styleGuideApprove);

    return this.db.transaction(async (tx) => {
      const guideRows = await tx
        .select()
        .from(styleGuides)
        .where(eq(styleGuides.localeBranchId, input.localeBranchId))
        .limit(1);
      const guide = guideRows[0];
      if (guide === undefined || guide.projectId !== input.projectId) {
        throw new Error(`style guide for locale branch ${input.localeBranchId} does not exist`);
      }

      const version = await getVersionByIdInTx(tx, input.styleGuideVersionId);
      if (
        version === null ||
        version.projectId !== input.projectId ||
        version.localeBranchId !== input.localeBranchId
      ) {
        throw new Error(
          `style guide version ${input.styleGuideVersionId} does not exist for locale branch ${input.localeBranchId}`,
        );
      }

      const previousApprovedVersionId = guide.approvedVersionId;
      const previousApprovedVersion =
        previousApprovedVersionId === null
          ? null
          : await getVersionByIdInTx(tx, previousApprovedVersionId);
      if (guide.latestVersionId !== input.expectedLatestVersionId) {
        throw new Error(
          `style guide approval expected latest version ${input.expectedLatestVersionId} but latest is ${guide.latestVersionId ?? "none"}`,
        );
      }
      if (guide.latestVersionId !== input.styleGuideVersionId) {
        throw new Error(
          `style guide version ${input.styleGuideVersionId} is not the latest version for locale branch ${input.localeBranchId}`,
        );
      }

      const guideUpdates = await tx
        .update(styleGuides)
        .set({
          approvedVersionId: input.styleGuideVersionId,
          updatedAt: sql`now()`,
        })
        .where(
          sql`${styleGuides.styleGuideId} = ${guide.styleGuideId}
            and ${styleGuides.latestVersionId} = ${input.expectedLatestVersionId}
            and ${styleGuides.latestVersionId} = ${input.styleGuideVersionId}`,
        )
        .returning({ styleGuideId: styleGuides.styleGuideId });
      if (guideUpdates.length === 0) {
        throw new Error(
          `style guide approval expected latest version ${input.expectedLatestVersionId} but the latest version changed`,
        );
      }

      if (previousApprovedVersionId) {
        await tx
          .update(styleGuideVersions)
          .set({ status: styleGuideVersionStatusValues.superseded, updatedAt: sql`now()` })
          .where(eq(styleGuideVersions.styleGuideVersionId, previousApprovedVersionId));
      }

      await tx
        .update(styleGuideVersions)
        .set({
          status: styleGuideVersionStatusValues.approved,
          approverUserId: input.approverUserId ?? actor.userId,
          approvedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(styleGuideVersions.styleGuideVersionId, input.styleGuideVersionId));

      const approved = await getVersionByIdInTx(tx, input.styleGuideVersionId);
      if (approved === null) {
        throw new Error(`style guide version ${input.styleGuideVersionId} was not approved`);
      }
      const outboxEvent = await appendStyleGuideVersionChangedEventInTx(
        tx,
        buildStyleGuideApprovalEventPayload({
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          approverUserId: input.approverUserId ?? actor.userId,
          priorVersion: previousApprovedVersion,
          approvedVersion: approved,
        }),
      );

      const invalidationOutboxEvents =
        previousApprovedVersion === null
          ? []
          : await appendAffectedWorkInvalidatedEventsInTx(tx, {
              projectId: input.projectId,
              localeBranchId: input.localeBranchId,
              approverUserId: input.approverUserId ?? actor.userId,
              priorVersion: previousApprovedVersion,
              approvedVersion: approved,
              causationOutboxEvent: outboxEvent,
            });

      return {
        previousApprovedVersionId,
        version: approved,
        outboxEvent,
        invalidationOutboxEvents,
      };
    });
  }

  private async getVersionById(
    styleGuideVersionId: string,
  ): Promise<StyleGuideVersionRecord | null> {
    return getVersionByIdInTx(this.db, styleGuideVersionId);
  }
}
