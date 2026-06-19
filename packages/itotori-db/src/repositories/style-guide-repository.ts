import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  eventOutbox,
  artifacts,
  findings,
  localeBranches,
  localeBranchUnits,
  type OutboxEventType,
  type OutboxStatus,
  outboxEventTypeValues,
  outboxStatusValues,
  sourceBundles,
  sourceRevisions,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
  type StyleGuideVersionStatus,
} from "../schema.js";
import {
  createUuid7,
  type OutboxEventRecord,
  type QueueErrorRecord,
} from "./event-queue-repository.js";

export const styleGuideVersionChangedPayloadSchemaVersion =
  "itotori.style_guide_version_changed.v1";
export const affectedWorkInvalidatedPayloadSchemaVersion = "itotori.affected_work_invalidated.v1";

export type StyleGuideRecord = {
  styleGuideId: string;
  projectId: string;
  localeBranchId: string;
  latestVersionId: string | null;
  approvedVersionId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SourceRevisionReference = {
  sourceRevisionId: string;
  revisionKind: string;
  value: string;
};

export type LocaleBranchStyleGuideContext = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceBundleId: string;
  sourceRevisionReference: SourceRevisionReference;
};

export type StyleGuideVersionRecord = {
  styleGuideVersionId: string;
  styleGuideId: string;
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  sourceRevisionReference: SourceRevisionReference;
  versionSequence: number;
  authorUserId: string;
  approverUserId: string | null;
  status: StyleGuideVersionStatus;
  contentHash: string;
  policy: Record<string, unknown>;
  semanticDiagnostics: Record<string, unknown>[];
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StyleGuideVersionChangedPayload = {
  schemaVersion: typeof styleGuideVersionChangedPayloadSchemaVersion;
  eventName: "StyleGuideVersionChanged";
  changeKind: "version_created" | "version_approved";
  projectId: string;
  localeBranchId: string;
  previousVersionId: string | null;
  newVersionId: string;
  sourceRevisionReference: SourceRevisionReference;
};

export type AffectedWorkSurface = "drafts" | "qa_findings" | "exports" | "benchmarks";

export type AffectedWorkReference =
  | {
      surface: "drafts";
      draftId: string;
      bridgeUnitId: string;
    }
  | {
      surface: "qa_findings";
      findingId: string;
    }
  | {
      surface: "exports";
      artifactId: string;
      artifactKind: string;
    }
  | {
      surface: "benchmarks";
      artifactId: string;
      artifactKind: string;
    };

export type AffectedWorkInvalidatedPayload = {
  schemaVersion: typeof affectedWorkInvalidatedPayloadSchemaVersion;
  eventName: "AffectedWorkInvalidated";
  invalidationKind: "style_guide_version_approved";
  projectId: string;
  localeBranchId: string;
  approverUserId: string;
  priorStyleGuideVersionId: string;
  approvedStyleGuideVersionId: string;
  sourceRevisionBoundary: {
    prior: SourceRevisionReference;
    approved: SourceRevisionReference;
  };
  affectedWork: {
    surface: AffectedWorkSurface;
    count: number;
    references: AffectedWorkReference[];
  };
};

export type CreateStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId?: string;
  expectedPreviousVersionId?: string | null;
  sourceRevisionId?: string;
  authorUserId?: string;
  status?: StyleGuideVersionStatus;
  contentHash?: string;
  policy: Record<string, unknown>;
  semanticDiagnostics?: Record<string, unknown>[];
};

export type ApproveStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId: string;
  expectedLatestVersionId: string;
  approverUserId?: string;
};

export type CreateStyleGuideVersionResult = {
  version: StyleGuideVersionRecord;
  outboxEvent: OutboxEventRecord;
};

export type ApproveStyleGuideVersionResult = {
  previousApprovedVersionId: string | null;
  version: StyleGuideVersionRecord;
  outboxEvent: OutboxEventRecord;
  invalidationOutboxEvents: OutboxEventRecord[];
};

export interface ItotoriStyleGuideRepositoryPort {
  getLocaleBranchContext(
    projectId: string,
    localeBranchId: string,
  ): Promise<LocaleBranchStyleGuideContext | null>;
  getStyleGuideByLocaleBranchId(localeBranchId: string): Promise<StyleGuideRecord | null>;
  getLatestVersionByLocaleBranchId(localeBranchId: string): Promise<StyleGuideVersionRecord | null>;
  getApprovedVersionByLocaleBranchId(
    localeBranchId: string,
  ): Promise<StyleGuideVersionRecord | null>;
  listVersionsByLocaleBranchId(localeBranchId: string): Promise<StyleGuideVersionRecord[]>;
  createVersion(
    actor: AuthorizationActor,
    input: CreateStyleGuideVersionInput,
  ): Promise<CreateStyleGuideVersionResult>;
  approveVersion(
    actor: AuthorizationActor,
    input: ApproveStyleGuideVersionInput,
  ): Promise<ApproveStyleGuideVersionResult>;
}

export class ItotoriStyleGuideRepository implements ItotoriStyleGuideRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

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
      const outboxEvent = await appendStyleGuideVersionChangedEventInTx(tx, {
        changeKind: "version_created",
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        previousVersionId,
        newVersionId: version.styleGuideVersionId,
        sourceRevisionReference: version.sourceRevisionReference,
      });
      return { version, outboxEvent };
    });
  }

  async approveVersion(
    actor: AuthorizationActor,
    input: ApproveStyleGuideVersionInput,
  ): Promise<ApproveStyleGuideVersionResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

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
      const outboxEvent = await appendStyleGuideVersionChangedEventInTx(tx, {
        changeKind: "version_approved",
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        previousVersionId: previousApprovedVersionId,
        newVersionId: approved.styleGuideVersionId,
        sourceRevisionReference: approved.sourceRevisionReference,
      });

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

type StyleGuideRow = typeof styleGuides.$inferSelect;
type StyleGuideVersionRow = typeof styleGuideVersions.$inferSelect;
type SourceRevisionRow = typeof sourceRevisions.$inferSelect;
type StyleGuideDb = Pick<ItotoriDatabase, "select" | "execute" | "insert" | "update">;

async function appendStyleGuideVersionChangedEventInTx(
  db: StyleGuideDb,
  payload: Omit<StyleGuideVersionChangedPayload, "schemaVersion" | "eventName">,
): Promise<OutboxEventRecord> {
  const outboxEventId = createUuid7();
  const idempotencyKey = styleGuideVersionChangedIdempotencyKey(payload);
  const eventPayload: StyleGuideVersionChangedPayload = {
    schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
    eventName: "StyleGuideVersionChanged",
    ...payload,
  };
  const rows = await db.execute(sql`
    insert into ${eventOutbox} (
      outbox_event_id,
      project_id,
      locale_branch_id,
      event_type,
      status,
      idempotency_key,
      correlation_id,
      payload
    )
    values (
      ${outboxEventId},
      ${payload.projectId},
      ${payload.localeBranchId},
      ${outboxEventTypeValues.styleGuideVersionChanged},
      ${outboxStatusValues.pending},
      ${idempotencyKey},
      ${outboxEventId},
      ${JSON.stringify(eventPayload)}::jsonb
    )
    on conflict (idempotency_key) do nothing
    returning *
  `);
  if (rows.rows[0] !== undefined) {
    return outboxEventFromRow(rows.rows[0] as Record<string, unknown>);
  }

  const existingRows = await db.execute(sql`
    select *
    from ${eventOutbox}
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  const existing = existingRows.rows[0];
  if (existing === undefined) {
    throw new Error(`outbox event ${outboxEventId} was not persisted`);
  }
  return outboxEventFromRow(existing as Record<string, unknown>);
}

function styleGuideVersionChangedIdempotencyKey(
  payload: Omit<StyleGuideVersionChangedPayload, "schemaVersion" | "eventName">,
): string {
  return [
    "style-guide-version-changed",
    payload.changeKind,
    payload.localeBranchId,
    payload.previousVersionId ?? "none",
    payload.newVersionId,
  ].join(":");
}

type AffectedWorkBySurface = Record<AffectedWorkSurface, AffectedWorkReference[]>;

type AppendAffectedWorkInvalidatedInput = {
  projectId: string;
  localeBranchId: string;
  approverUserId: string;
  priorVersion: StyleGuideVersionRecord;
  approvedVersion: StyleGuideVersionRecord;
  causationOutboxEvent: OutboxEventRecord;
};

async function appendAffectedWorkInvalidatedEventsInTx(
  db: StyleGuideDb,
  input: AppendAffectedWorkInvalidatedInput,
): Promise<OutboxEventRecord[]> {
  const affectedWork = await listAffectedWorkByPriorStyleGuideVersionInTx(db, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    priorStyleGuideVersionId: input.priorVersion.styleGuideVersionId,
  });
  const outboxEvents: OutboxEventRecord[] = [];

  for (const surface of affectedWorkSurfaces) {
    const references = affectedWork[surface];
    if (references.length === 0) {
      continue;
    }

    outboxEvents.push(
      await appendAffectedWorkInvalidatedEventInTx(db, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        approverUserId: input.approverUserId,
        priorStyleGuideVersionId: input.priorVersion.styleGuideVersionId,
        approvedStyleGuideVersionId: input.approvedVersion.styleGuideVersionId,
        sourceRevisionBoundary: {
          prior: input.priorVersion.sourceRevisionReference,
          approved: input.approvedVersion.sourceRevisionReference,
        },
        affectedWork: {
          surface,
          count: references.length,
          references,
        },
        causationOutboxEvent: input.causationOutboxEvent,
      }),
    );
  }

  return outboxEvents;
}

const affectedWorkSurfaces = [
  "drafts",
  "qa_findings",
  "exports",
  "benchmarks",
] as const satisfies readonly AffectedWorkSurface[];

async function listAffectedWorkByPriorStyleGuideVersionInTx(
  db: StyleGuideDb,
  input: {
    projectId: string;
    localeBranchId: string;
    priorStyleGuideVersionId: string;
  },
): Promise<AffectedWorkBySurface> {
  const drafts = await db
    .select({ bridgeUnitId: localeBranchUnits.bridgeUnitId })
    .from(localeBranchUnits)
    .where(
      sql`${localeBranchUnits.localeBranchId} = ${input.localeBranchId}
        and ${localeBranchUnits.targetText} is not null`,
    )
    .orderBy(asc(localeBranchUnits.bridgeUnitId));

  const findingsRows = await db
    .select({ findingId: findings.findingId })
    .from(findings)
    .where(
      sql`${findings.projectId} = ${input.projectId}
        and ${findings.localeBranchId} = ${input.localeBranchId}
        and ${findings.status} <> 'resolved'
        and (
          ${findings.affectedRefs} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.evidence} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.provenance} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.causalLinks} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
        )`,
    )
    .orderBy(asc(findings.findingId));

  const exportRows = await db
    .select({ artifactId: artifacts.artifactId, artifactKind: artifacts.artifactKind })
    .from(artifacts)
    .where(
      sql`${artifacts.projectId} = ${input.projectId}
        and ${artifacts.localeBranchId} = ${input.localeBranchId}
        and ${artifacts.artifactKind} in ('patch_export', 'patch_result', 'delta_package')
        and (
          ${artifacts.metadata}->>'styleGuideVersionId' = ${input.priorStyleGuideVersionId}
          or ${artifacts.metadata}->>'styleGuidePolicyVersionId' = ${input.priorStyleGuideVersionId}
        )`,
    )
    .orderBy(asc(artifacts.artifactId));

  const benchmarkRows = await db
    .select({ artifactId: artifacts.artifactId, artifactKind: artifacts.artifactKind })
    .from(artifacts)
    .where(
      sql`${artifacts.projectId} = ${input.projectId}
        and ${artifacts.localeBranchId} = ${input.localeBranchId}
        and ${artifacts.artifactKind} = 'benchmark_report'
        and (
          ${artifacts.metadata}->>'styleGuideVersionId' = ${input.priorStyleGuideVersionId}
          or ${artifacts.metadata}->>'styleGuidePolicyVersionId' = ${input.priorStyleGuideVersionId}
        )`,
    )
    .orderBy(asc(artifacts.artifactId));

  return {
    drafts: drafts.map((row) => ({
      surface: "drafts",
      draftId: `${input.localeBranchId}:${row.bridgeUnitId}`,
      bridgeUnitId: row.bridgeUnitId,
    })),
    qa_findings: findingsRows.map((row) => ({
      surface: "qa_findings",
      findingId: row.findingId,
    })),
    exports: exportRows.map((row) => ({
      surface: "exports",
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
    })),
    benchmarks: benchmarkRows.map((row) => ({
      surface: "benchmarks",
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
    })),
  };
}

async function appendAffectedWorkInvalidatedEventInTx(
  db: StyleGuideDb,
  input: Omit<
    AffectedWorkInvalidatedPayload,
    "schemaVersion" | "eventName" | "invalidationKind"
  > & {
    causationOutboxEvent: OutboxEventRecord;
  },
): Promise<OutboxEventRecord> {
  const outboxEventId = createUuid7();
  const payload: AffectedWorkInvalidatedPayload = {
    schemaVersion: affectedWorkInvalidatedPayloadSchemaVersion,
    eventName: "AffectedWorkInvalidated",
    invalidationKind: "style_guide_version_approved",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    approverUserId: input.approverUserId,
    priorStyleGuideVersionId: input.priorStyleGuideVersionId,
    approvedStyleGuideVersionId: input.approvedStyleGuideVersionId,
    sourceRevisionBoundary: input.sourceRevisionBoundary,
    affectedWork: input.affectedWork,
  };
  const idempotencyKey = affectedWorkInvalidatedIdempotencyKey(payload);

  const rows = await db.execute(sql`
    insert into ${eventOutbox} (
      outbox_event_id,
      project_id,
      locale_branch_id,
      event_type,
      status,
      idempotency_key,
      correlation_id,
      causation_id,
      payload
    )
    values (
      ${outboxEventId},
      ${input.projectId},
      ${input.localeBranchId},
      ${outboxEventTypeValues.affectedWorkInvalidated},
      ${outboxStatusValues.pending},
      ${idempotencyKey},
      ${input.causationOutboxEvent.correlationId},
      ${input.causationOutboxEvent.outboxEventId},
      ${JSON.stringify(payload)}::jsonb
    )
    on conflict (idempotency_key) do nothing
    returning *
  `);
  if (rows.rows[0] !== undefined) {
    return outboxEventFromRow(rows.rows[0] as Record<string, unknown>);
  }

  const existingRows = await db.execute(sql`
    select *
    from ${eventOutbox}
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  const existing = existingRows.rows[0];
  if (existing === undefined) {
    throw new Error(`outbox event ${outboxEventId} was not persisted`);
  }
  return outboxEventFromRow(existing as Record<string, unknown>);
}

function affectedWorkInvalidatedIdempotencyKey(payload: AffectedWorkInvalidatedPayload): string {
  return [
    "affected-work-invalidated",
    "style-guide-approved",
    payload.localeBranchId,
    payload.priorStyleGuideVersionId,
    payload.approvedStyleGuideVersionId,
    payload.affectedWork.surface,
  ].join(":");
}

function outboxEventFromRow(row: Record<string, unknown>): OutboxEventRecord {
  return {
    outboxEventId: rowString(row, "outbox_event_id"),
    projectId: rowString(row, "project_id"),
    localeBranchId: nullableRowString(row, "locale_branch_id"),
    sourceEventId: nullableRowString(row, "source_event_id"),
    eventType: rowString(row, "event_type") as OutboxEventType,
    status: rowString(row, "status") as OutboxStatus,
    idempotencyKey: rowString(row, "idempotency_key"),
    correlationId: rowString(row, "correlation_id"),
    causationId: nullableRowString(row, "causation_id"),
    payload: rowJsonRecord(row, "payload"),
    availableAt: rowDate(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    maxAttempts: rowNumber(row, "max_attempts"),
    lockedBy: nullableRowString(row, "locked_by"),
    lockedAt: nullableRowDate(row, "locked_at"),
    leaseExpiresAt: nullableRowDate(row, "lease_expires_at"),
    publishedAt: nullableRowDate(row, "published_at"),
    lastError: nullableRowString(row, "last_error"),
    errorHistory: rowArray(row, "error_history") as QueueErrorRecord[],
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
  };
}

function styleGuideFromRow(row: StyleGuideRow): StyleGuideRecord {
  return {
    styleGuideId: row.styleGuideId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    latestVersionId: row.latestVersionId,
    approvedVersionId: row.approvedVersionId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getLocaleBranchContextInTx(
  db: StyleGuideDb,
  projectId: string,
  localeBranchId: string,
): Promise<LocaleBranchStyleGuideContext | null> {
  const rows = await db
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

async function getSourceRevisionInTx(
  db: StyleGuideDb,
  projectId: string,
  sourceRevisionId: string,
): Promise<SourceRevisionReference | null> {
  const rows = await db
    .select()
    .from(sourceRevisions)
    .where(
      sql`${sourceRevisions.projectId} = ${projectId} and ${sourceRevisions.sourceRevisionId} = ${sourceRevisionId}`,
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    sourceRevisionId: row.sourceRevisionId,
    revisionKind: row.revisionKind,
    value: row.value,
  };
}

async function getVersionByIdInTx(
  db: StyleGuideDb,
  styleGuideVersionId: string,
): Promise<StyleGuideVersionRecord | null> {
  const rows = await db
    .select({
      version: styleGuideVersions,
      sourceRevision: sourceRevisions,
    })
    .from(styleGuideVersions)
    .innerJoin(
      sourceRevisions,
      eq(sourceRevisions.sourceRevisionId, styleGuideVersions.sourceRevisionId),
    )
    .where(eq(styleGuideVersions.styleGuideVersionId, styleGuideVersionId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : versionFromJoinedRow(row.version, row.sourceRevision);
}

function versionFromJoinedRow(
  row: StyleGuideVersionRow,
  sourceRevision: SourceRevisionRow,
): StyleGuideVersionRecord {
  return {
    styleGuideVersionId: row.styleGuideVersionId,
    styleGuideId: row.styleGuideId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    previousVersionId: row.previousVersionId,
    sourceRevisionReference: {
      sourceRevisionId: sourceRevision.sourceRevisionId,
      revisionKind: sourceRevision.revisionKind,
      value: sourceRevision.value,
    },
    versionSequence: row.versionSequence,
    authorUserId: row.authorUserId,
    approverUserId: row.approverUserId,
    status: row.status as StyleGuideVersionStatus,
    contentHash: row.contentHash,
    policy: row.policy,
    semanticDiagnostics: row.semanticDiagnostics,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function contentHashForPolicy(policy: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableStringify(policy)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

function nullableRowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a nullable string`);
  }
  return value;
}

function rowDate(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  throw new Error(`expected ${key} to be a date`);
}

function nullableRowDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  return rowDate(row, key);
}

function rowJsonRecord(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`expected ${key} to be a JSON object`);
}

function rowArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`expected ${key} to be an array`);
}

function rowNumber(row: Record<string, unknown> | undefined, key: string): number {
  if (row === undefined) {
    return 0;
  }
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10);
  }
  return 0;
}
