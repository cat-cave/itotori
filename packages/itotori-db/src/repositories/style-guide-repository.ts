import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  localeBranches,
  sourceBundles,
  sourceRevisions,
  styleGuides,
  styleGuideVersions,
  styleGuideVersionStatusValues,
  type StyleGuideVersionStatus,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

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

export type CreateStyleGuideVersionInput = {
  projectId: string;
  localeBranchId: string;
  styleGuideVersionId?: string;
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
  approverUserId?: string;
};

export type ApproveStyleGuideVersionResult = {
  previousApprovedVersionId: string | null;
  version: StyleGuideVersionRecord;
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
  ): Promise<StyleGuideVersionRecord>;
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
  ): Promise<StyleGuideVersionRecord> {
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
        previousVersionId: existingGuide?.latestVersionId ?? null,
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
      return version;
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

      await tx
        .update(styleGuides)
        .set({
          approvedVersionId: input.styleGuideVersionId,
          updatedAt: sql`now()`,
        })
        .where(eq(styleGuides.styleGuideId, guide.styleGuideId));

      const approved = await getVersionByIdInTx(tx, input.styleGuideVersionId);
      if (approved === null) {
        throw new Error(`style guide version ${input.styleGuideVersionId} was not approved`);
      }

      return { previousApprovedVersionId, version: approved };
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
