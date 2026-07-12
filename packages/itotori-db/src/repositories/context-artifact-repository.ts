import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  contextArtifactCategoryValues,
  contextArtifacts,
  contextArtifactSourceUnits,
  contextArtifactStatusValues,
  contextEntryVersions,
  localeBranches,
  projects,
  sourceBundles,
  sourceUnits,
  type ContextArtifactCategory,
  type ContextArtifactStatus,
  type ContextEntryVersionCitation,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

export { contextArtifactCategoryValues, contextArtifactStatusValues } from "../schema.js";

export const contextArtifactToolName = "tool.context-artifacts";
export const contextArtifactToolVersion = "1.0.0";
export const contextArtifactSchemaVersion = "itotori.context-artifact.v1";

export const contextArtifactDiagnosticCodeValues = {
  projectMissing: "project_missing",
  localeBranchMissing: "locale_branch_missing",
  unsupportedCategory: "unsupported_category",
  unsupportedStatus: "unsupported_status",
  staleSourceRevision: "stale_source_revision",
  missingSourceCitation: "missing_source_citation",
  sourceUnitMissing: "source_unit_missing",
  sourceUnitOutOfScope: "source_unit_out_of_scope",
  unboundedArtifactBody: "unbounded_artifact_body",
  unboundedArtifactData: "unbounded_artifact_data",
  blankQuery: "blank_query",
} as const;

export type ContextArtifactDiagnosticCode =
  (typeof contextArtifactDiagnosticCodeValues)[keyof typeof contextArtifactDiagnosticCodeValues];

export type ContextArtifactDiagnostic = {
  code: ContextArtifactDiagnosticCode;
  reasonCode: ContextArtifactDiagnosticCode;
  severity: "error" | "warning" | "info";
  message: string;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type ContextArtifactJsonRecord = Record<string, unknown>;

export type ContextArtifactSourceUnitInput = {
  bridgeUnitId: string;
  citation: string;
  metadata?: ContextArtifactJsonRecord;
};

export type UpsertContextArtifactInput = {
  contextArtifactId?: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: string;
  status?: string;
  title: string;
  body: string;
  data?: ContextArtifactJsonRecord;
  producedByAgent?: string | null;
  producedByTool?: string | null;
  producerVersion: string;
  provenance?: ContextArtifactJsonRecord;
  sourceUnits: ContextArtifactSourceUnitInput[];
};

export type RetrieveContextArtifactsInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId?: string;
  categories?: readonly string[];
  bridgeUnitIds?: readonly string[];
  query?: string;
  includeStale?: boolean;
  limit?: number;
};

export type InvalidateContextArtifactsInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId?: string;
  bridgeUnitIds?: readonly string[];
  reason?: string;
};

/** Scope for the append-only ContextEntryVersion history of one entry. */
export type ListContextEntryVersionsInput = {
  projectId: string;
  localeBranchId: string;
  contextArtifactId: string;
};

export type ContextArtifactSourceUnitRecord = {
  contextArtifactId: string;
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceHash: string;
  citation: string;
  metadata: ContextArtifactJsonRecord;
  createdAt: Date;
};

export type ContextArtifactRecord = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: ContextArtifactCategory;
  status: ContextArtifactStatus;
  title: string;
  normalizedTitle: string;
  body: string;
  data: ContextArtifactJsonRecord;
  /** Immutable ContextEntryVersion id currently selected as this entry's head. */
  headVersionId: string | null;
  contentHash: string;
  producedByAgent: string | null;
  producedByTool: string | null;
  producerVersion: string;
  provenance: ContextArtifactJsonRecord;
  invalidatedReason: string | null;
  invalidatedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceUnits: ContextArtifactSourceUnitRecord[];
};

/**
 * An immutable ContextEntryVersion snapshot. `contentHash` verifies a snapshot
 * body but is deliberately not used as its identity: two writes with identical
 * content are still distinct lineage events.
 */
export type ContextEntryVersionRecord = {
  contextEntryVersionId: string;
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  parentVersionId: string | null;
  sourceRevisionId: string;
  category: ContextArtifactCategory;
  status: ContextArtifactStatus;
  title: string;
  normalizedTitle: string;
  body: string;
  data: ContextArtifactJsonRecord;
  contentHash: string;
  producedByAgent: string | null;
  producedByTool: string | null;
  producerVersion: string;
  provenance: ContextArtifactJsonRecord;
  citations: ContextEntryVersionCitation[];
  affectedUnitIds: string[];
  invalidatedReason: string | null;
  invalidatedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
};

export type ContextArtifactMatch = ContextArtifactRecord & {
  retrievalScore: number;
  retrievalReasons: string[];
  citations: ContextArtifactSourceUnitRecord[];
  provenance: ContextArtifactJsonRecord & {
    schemaVersion: typeof contextArtifactSchemaVersion;
    toolName: typeof contextArtifactToolName;
    toolVersion: typeof contextArtifactToolVersion;
    contextArtifactId: string;
    category: ContextArtifactCategory;
    sourceRevisionId: string;
    producedByAgent: string | null;
    producedByTool: string | null;
    producerVersion: string;
  };
};

export type ContextArtifactRetrievalResult = {
  status: "completed" | "failed";
  toolName: typeof contextArtifactToolName;
  toolVersion: typeof contextArtifactToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string | null;
  normalizedQuery: string | null;
  categories: ContextArtifactCategory[];
  matches: ContextArtifactMatch[];
  diagnostics: ContextArtifactDiagnostic[];
};

export type ContextArtifactInvalidationResult = {
  status: "completed" | "failed";
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  invalidatedCount: number;
  invalidatedArtifactIds: string[];
  diagnostics: ContextArtifactDiagnostic[];
};

export interface ItotoriContextArtifactRepositoryPort {
  upsertArtifact(
    actor: AuthorizationActor,
    input: UpsertContextArtifactInput,
  ): Promise<ContextArtifactRecord>;
  invalidateAffectedArtifacts(
    actor: AuthorizationActor,
    input: InvalidateContextArtifactsInput,
  ): Promise<ContextArtifactInvalidationResult>;
  retrieveArtifacts(
    actor: AuthorizationActor,
    input: RetrieveContextArtifactsInput,
  ): Promise<ContextArtifactRetrievalResult>;
}

export class ItotoriContextArtifactRepository implements ItotoriContextArtifactRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async upsertArtifact(
    actor: AuthorizationActor,
    input: UpsertContextArtifactInput,
  ): Promise<ContextArtifactRecord> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      throw new ContextArtifactRepositoryError([context.diagnostic]);
    }
    if (input.sourceRevisionId !== context.value.sourceRevisionId) {
      throw new ContextArtifactRepositoryError([
        staleSourceRevisionDiagnostic(input.sourceRevisionId, context.value.sourceRevisionId),
      ]);
    }

    const category = parseCategory(input.category, "category");
    const status = parseStatus(input.status ?? contextArtifactStatusValues.active, "status");
    const bounded = validateBoundedPayload(input);
    if (bounded.length > 0) {
      throw new ContextArtifactRepositoryError(bounded);
    }
    if (input.sourceUnits.length === 0) {
      throw new ContextArtifactRepositoryError([missingSourceCitationDiagnostic()]);
    }

    const sourceUnitRows = await currentSourceUnitRows(
      this.db,
      context.value.sourceBundleId,
      input.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId),
    );
    const sourceUnitById = new Map(sourceUnitRows.map((row) => [row.bridgeUnitId, row]));
    const sourceDiagnostics = input.sourceUnits.flatMap((sourceUnit, index) => {
      const row = sourceUnitById.get(sourceUnit.bridgeUnitId);
      if (row === undefined) {
        return [sourceUnitMissingDiagnostic(sourceUnit.bridgeUnitId, index)];
      }
      return [];
    });
    if (sourceDiagnostics.length > 0) {
      throw new ContextArtifactRepositoryError(sourceDiagnostics);
    }

    const contextArtifactId = input.contextArtifactId ?? createUuid7();
    const normalizedTitle = normalizeContextArtifactText(input.title);
    const data = input.data ?? {};
    const provenance = {
      ...input.provenance,
      schemaVersion: contextArtifactSchemaVersion,
      producedByAgent: input.producedByAgent ?? null,
      producedByTool: input.producedByTool ?? null,
      producerVersion: input.producerVersion,
    };
    const versionCitations: ContextEntryVersionCitation[] = input.sourceUnits.map((sourceUnit) => {
      const row = sourceUnitById.get(sourceUnit.bridgeUnitId);
      if (row === undefined) {
        throw new Error(`validated source unit disappeared: ${sourceUnit.bridgeUnitId}`);
      }
      return {
        bridgeUnitId: sourceUnit.bridgeUnitId,
        // The artifact is scoped to the bundle revision, but each citation
        // must retain the exact source-unit revision it was built from. A
        // byte-identical unit revision is still distinct provenance.
        sourceRevisionId: row.sourceRevisionId,
        sourceHash: row.sourceHash,
        citation: sourceUnit.citation,
        metadata: sourceUnit.metadata ?? {},
      };
    });
    const contentHash = contextArtifactContentHash({
      category,
      title: input.title,
      body: input.body,
      data,
      sourceUnits: versionCitations.map((citation) => ({
        bridgeUnitId: citation.bridgeUnitId,
        sourceHash: citation.sourceHash,
        citation: citation.citation,
      })),
    });
    const invalidatedReason =
      status === contextArtifactStatusValues.active ? null : (input.status ?? null);
    const invalidatedAt = status === contextArtifactStatusValues.active ? null : sql`now()`;
    const contextEntryVersionId = createUuid7();

    await this.db.transaction(async (tx) => {
      // Serialize writes of the same ContextEntry. The parent pointer is read
      // and advanced under one transaction-scoped lock, so concurrent upserts
      // cannot fork lineage from the same prior head.
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext(coalesce(current_schema(), '') || ':' || ${contextArtifactId})
        )`,
      );
      const [existing] = await tx
        .select({
          projectId: contextArtifacts.projectId,
          localeBranchId: contextArtifacts.localeBranchId,
          headVersionId: contextArtifacts.headVersionId,
        })
        .from(contextArtifacts)
        .where(eq(contextArtifacts.contextArtifactId, contextArtifactId))
        .limit(1);

      if (existing === undefined) {
        await tx.insert(contextArtifacts).values({
          contextArtifactId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          category,
          status,
          title: input.title,
          normalizedTitle,
          body: input.body,
          data,
          contentHash,
          producedByAgent: input.producedByAgent ?? null,
          producedByTool: input.producedByTool ?? null,
          producerVersion: input.producerVersion,
          provenance,
          headVersionId: null,
          invalidatedReason,
          invalidatedAt,
          createdByUserId: actor.userId,
          updatedAt: sql`now()`,
        });
      } else if (
        existing.projectId !== input.projectId ||
        existing.localeBranchId !== input.localeBranchId
      ) {
        throw new Error(
          `context artifact ${contextArtifactId} belongs to a different project or locale branch`,
        );
      }

      await tx.insert(contextEntryVersions).values({
        contextEntryVersionId,
        contextArtifactId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        parentVersionId: existing?.headVersionId ?? null,
        sourceRevisionId: input.sourceRevisionId,
        category,
        status,
        title: input.title,
        normalizedTitle,
        body: input.body,
        data,
        contentHash,
        producedByAgent: input.producedByAgent ?? null,
        producedByTool: input.producedByTool ?? null,
        producerVersion: input.producerVersion,
        provenance,
        citations: versionCitations,
        affectedUnitIds: unique(versionCitations.map((citation) => citation.bridgeUnitId)).sort(),
        invalidatedReason,
        invalidatedAt,
        createdByUserId: actor.userId,
      });

      if (existing === undefined) {
        await tx
          .update(contextArtifacts)
          .set({ headVersionId: contextEntryVersionId, updatedAt: sql`now()` })
          .where(eq(contextArtifacts.contextArtifactId, contextArtifactId));
      } else {
        await tx
          .update(contextArtifacts)
          .set({
            sourceRevisionId: input.sourceRevisionId,
            category,
            status,
            title: input.title,
            normalizedTitle,
            body: input.body,
            data,
            contentHash,
            producedByAgent: input.producedByAgent ?? null,
            producedByTool: input.producedByTool ?? null,
            producerVersion: input.producerVersion,
            provenance,
            headVersionId: contextEntryVersionId,
            invalidatedReason,
            invalidatedAt,
            updatedAt: sql`now()`,
          })
          .where(eq(contextArtifacts.contextArtifactId, contextArtifactId));
      }

      await tx
        .delete(contextArtifactSourceUnits)
        .where(eq(contextArtifactSourceUnits.contextArtifactId, contextArtifactId));

      await tx.insert(contextArtifactSourceUnits).values(
        versionCitations.map((citation) => ({
          contextArtifactId,
          bridgeUnitId: citation.bridgeUnitId,
          sourceRevisionId: citation.sourceRevisionId,
          sourceHash: citation.sourceHash,
          citation: citation.citation,
          metadata: citation.metadata,
        })),
      );
    });

    return await requireArtifactById(this.db, contextArtifactId);
  }

  async invalidateAffectedArtifacts(
    actor: AuthorizationActor,
    input: InvalidateContextArtifactsInput,
  ): Promise<ContextArtifactInvalidationResult> {
    await requirePermission(this.db, actor, permissionValues.projectImport);
    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      return invalidationFailure(input, null, [context.diagnostic]);
    }
    if (
      input.sourceRevisionId !== undefined &&
      input.sourceRevisionId !== context.value.sourceRevisionId
    ) {
      return invalidationFailure(input, context.value.sourceRevisionId, [
        staleSourceRevisionDiagnostic(input.sourceRevisionId, context.value.sourceRevisionId),
      ]);
    }

    const activeRows = await artifactsWithSources(this.db, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      includeStale: false,
    });
    const currentRows = await currentSourceUnitRows(
      this.db,
      context.value.sourceBundleId,
      unique(
        activeRows.flatMap((artifact) => artifact.sourceUnits.map((source) => source.bridgeUnitId)),
      ),
    );
    const currentById = new Map(currentRows.map((row) => [row.bridgeUnitId, row]));
    const explicitBridgeUnitIds = new Set(input.bridgeUnitIds ?? []);
    const invalidatedArtifactIds = activeRows
      .filter((artifact) => {
        if (artifact.sourceRevisionId !== context.value.sourceRevisionId) {
          return true;
        }
        return artifact.sourceUnits.some((source) => {
          if (explicitBridgeUnitIds.has(source.bridgeUnitId)) {
            return true;
          }
          const current = currentById.get(source.bridgeUnitId);
          return (
            current === undefined ||
            current.sourceRevisionId !== source.sourceRevisionId ||
            current.sourceHash !== source.sourceHash
          );
        });
      })
      .map((artifact) => artifact.contextArtifactId);

    if (invalidatedArtifactIds.length > 0) {
      await this.db
        .update(contextArtifacts)
        .set({
          status: contextArtifactStatusValues.stale,
          invalidatedReason: input.reason ?? "source_changed",
          invalidatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(inArray(contextArtifacts.contextArtifactId, invalidatedArtifactIds));
    }

    return {
      status: "completed",
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: context.value.sourceRevisionId,
      invalidatedCount: invalidatedArtifactIds.length,
      invalidatedArtifactIds,
      diagnostics: [],
    };
  }

  async retrieveArtifacts(
    actor: AuthorizationActor,
    input: RetrieveContextArtifactsInput,
  ): Promise<ContextArtifactRetrievalResult> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      return retrievalFailure(input, null, null, [], [context.diagnostic]);
    }
    const includeStale = input.includeStale ?? false;
    if (
      input.sourceRevisionId !== undefined &&
      input.sourceRevisionId !== context.value.sourceRevisionId &&
      !includeStale
    ) {
      return retrievalFailure(
        input,
        context.value.sourceRevisionId,
        null,
        [],
        [staleSourceRevisionDiagnostic(input.sourceRevisionId, context.value.sourceRevisionId)],
      );
    }
    const categories = normalizeCategories(input.categories);
    if (categories.diagnostics.length > 0) {
      return retrievalFailure(
        input,
        context.value.sourceRevisionId,
        null,
        [],
        categories.diagnostics,
      );
    }
    const normalizedQuery =
      input.query === undefined ? null : normalizeContextArtifactText(input.query);
    if (input.query !== undefined && normalizedQuery !== null && normalizedQuery.length === 0) {
      return retrievalFailure(input, context.value.sourceRevisionId, "", categories.values, [
        blankQueryDiagnostic(),
      ]);
    }

    const outputSourceRevisionId = input.sourceRevisionId ?? context.value.sourceRevisionId;
    const artifactFilter: ArtifactFilter = {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      categories: categories.values,
      includeStale,
      limit: clampLimit(input.limit),
      normalizedQuery,
    };
    if (input.sourceRevisionId !== undefined) {
      artifactFilter.sourceRevisionId = input.sourceRevisionId;
    } else if (!includeStale) {
      artifactFilter.sourceRevisionId = context.value.sourceRevisionId;
    }
    if (input.bridgeUnitIds !== undefined) {
      artifactFilter.bridgeUnitIds = input.bridgeUnitIds;
    }
    const rows = await artifactsWithSources(this.db, artifactFilter);
    const matches = rows
      .map((artifact) => scoredArtifact(artifact, normalizedQuery, input.bridgeUnitIds))
      .filter((artifact) => artifact.retrievalScore > 0)
      .sort((left, right) => {
        const scoreDelta = right.retrievalScore - left.retrievalScore;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.contextArtifactId.localeCompare(right.contextArtifactId);
      })
      .slice(0, clampLimit(input.limit));

    return {
      status: "completed",
      toolName: contextArtifactToolName,
      toolVersion: contextArtifactToolVersion,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: outputSourceRevisionId,
      query: input.query ?? null,
      normalizedQuery,
      categories: categories.values,
      matches,
      diagnostics: [],
    };
  }

  async listEntryVersions(
    actor: AuthorizationActor,
    input: ListContextEntryVersionsInput,
  ): Promise<ContextEntryVersionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select()
      .from(contextEntryVersions)
      .where(
        and(
          eq(contextEntryVersions.contextArtifactId, input.contextArtifactId),
          eq(contextEntryVersions.projectId, input.projectId),
          eq(contextEntryVersions.localeBranchId, input.localeBranchId),
        ),
      )
      .orderBy(
        asc(contextEntryVersions.createdAt),
        asc(contextEntryVersions.contextEntryVersionId),
      );
    return rows.map(contextEntryVersionRecordFromRow);
  }
}

export class ContextArtifactRepositoryError extends Error {
  constructor(readonly diagnostics: ContextArtifactDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "ContextArtifactRepositoryError";
  }
}

export function normalizeContextArtifactText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function contextArtifactRecordFromRow(
  row: typeof contextArtifacts.$inferSelect,
  sourceUnitRows: ContextArtifactSourceUnitRecord[],
): ContextArtifactRecord {
  return {
    contextArtifactId: row.contextArtifactId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    category: parseCategory(row.category, "category"),
    status: parseStatus(row.status, "status"),
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    body: row.body,
    data: row.data,
    headVersionId: row.headVersionId,
    contentHash: row.contentHash,
    producedByAgent: row.producedByAgent,
    producedByTool: row.producedByTool,
    producerVersion: row.producerVersion,
    provenance: row.provenance,
    invalidatedReason: row.invalidatedReason,
    invalidatedAt: row.invalidatedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sourceUnits: sourceUnitRows,
  };
}

function contextEntryVersionRecordFromRow(
  row: typeof contextEntryVersions.$inferSelect,
): ContextEntryVersionRecord {
  return {
    contextEntryVersionId: row.contextEntryVersionId,
    contextArtifactId: row.contextArtifactId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    parentVersionId: row.parentVersionId,
    sourceRevisionId: row.sourceRevisionId,
    category: parseCategory(row.category, "category"),
    status: parseStatus(row.status, "status"),
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    body: row.body,
    data: row.data,
    contentHash: row.contentHash,
    producedByAgent: row.producedByAgent,
    producedByTool: row.producedByTool,
    producerVersion: row.producerVersion,
    provenance: row.provenance,
    citations: row.citations,
    affectedUnitIds: row.affectedUnitIds,
    invalidatedReason: row.invalidatedReason,
    invalidatedAt: row.invalidatedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function sourceUnitRecordFromRow(
  row: typeof contextArtifactSourceUnits.$inferSelect,
): ContextArtifactSourceUnitRecord {
  return {
    contextArtifactId: row.contextArtifactId,
    bridgeUnitId: row.bridgeUnitId,
    sourceRevisionId: row.sourceRevisionId,
    sourceHash: row.sourceHash,
    citation: row.citation,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

async function requireArtifactById(
  db: ItotoriDatabase,
  contextArtifactId: string,
): Promise<ContextArtifactRecord> {
  const rows = await artifactsWithSources(db, { contextArtifactId, includeStale: true, limit: 1 });
  const artifact = rows[0];
  if (artifact === undefined) {
    throw new Error(`context artifact ${contextArtifactId} was not persisted`);
  }
  return artifact;
}

type ArtifactFilter = {
  contextArtifactId?: string;
  projectId?: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  categories?: ContextArtifactCategory[];
  includeStale: boolean;
  bridgeUnitIds?: readonly string[];
  limit?: number;
  normalizedQuery?: string | null;
};

async function artifactsWithSources(
  db: ItotoriDatabase,
  filter: ArtifactFilter,
): Promise<ContextArtifactRecord[]> {
  const conditions = [];
  if (filter.contextArtifactId !== undefined) {
    conditions.push(eq(contextArtifacts.contextArtifactId, filter.contextArtifactId));
  }
  if (filter.projectId !== undefined) {
    conditions.push(eq(contextArtifacts.projectId, filter.projectId));
  }
  if (filter.localeBranchId !== undefined) {
    conditions.push(eq(contextArtifacts.localeBranchId, filter.localeBranchId));
  }
  if (filter.sourceRevisionId !== undefined) {
    conditions.push(eq(contextArtifacts.sourceRevisionId, filter.sourceRevisionId));
  }
  if (!filter.includeStale) {
    conditions.push(eq(contextArtifacts.status, contextArtifactStatusValues.active));
  }
  if (filter.categories !== undefined && filter.categories.length > 0) {
    conditions.push(inArray(contextArtifacts.category, filter.categories));
  }
  if (filter.bridgeUnitIds !== undefined && filter.bridgeUnitIds.length > 0) {
    const sourceMatches = await db
      .select({ contextArtifactId: contextArtifactSourceUnits.contextArtifactId })
      .from(contextArtifactSourceUnits)
      .where(inArray(contextArtifactSourceUnits.bridgeUnitId, unique(filter.bridgeUnitIds)));
    const contextArtifactIds = unique(sourceMatches.map((row) => row.contextArtifactId));
    if (contextArtifactIds.length === 0) {
      return [];
    }
    conditions.push(inArray(contextArtifacts.contextArtifactId, contextArtifactIds));
  }
  if (filter.normalizedQuery !== undefined && filter.normalizedQuery !== null) {
    conditions.push(sql`(
      position(${filter.normalizedQuery} in ${contextArtifacts.normalizedTitle}) > 0
      or position(${filter.normalizedQuery} in lower(${contextArtifacts.body})) > 0
      or exists (
        select 1
        from itotori_context_artifact_source_units casu
        where casu.context_artifact_id = ${contextArtifacts.contextArtifactId}
          and position(${filter.normalizedQuery} in lower(casu.citation)) > 0
      )
    )`);
  }

  const query = db
    .select()
    .from(contextArtifacts)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      asc(contextArtifacts.category),
      asc(contextArtifacts.normalizedTitle),
      asc(contextArtifacts.contextArtifactId),
    );
  const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);

  if (rows.length === 0) {
    return [];
  }

  const sourceRows = await db
    .select()
    .from(contextArtifactSourceUnits)
    .where(
      inArray(
        contextArtifactSourceUnits.contextArtifactId,
        rows.map((row) => row.contextArtifactId),
      ),
    )
    .orderBy(
      asc(contextArtifactSourceUnits.contextArtifactId),
      asc(contextArtifactSourceUnits.bridgeUnitId),
    );
  const sourceRowsByArtifactId = new Map<string, ContextArtifactSourceUnitRecord[]>();
  for (const row of sourceRows) {
    const record = sourceUnitRecordFromRow(row);
    const existing = sourceRowsByArtifactId.get(record.contextArtifactId);
    if (existing === undefined) {
      sourceRowsByArtifactId.set(record.contextArtifactId, [record]);
    } else {
      existing.push(record);
    }
  }

  return rows.map((row) =>
    contextArtifactRecordFromRow(row, sourceRowsByArtifactId.get(row.contextArtifactId) ?? []),
  );
}

function scoredArtifact(
  artifact: ContextArtifactRecord,
  normalizedQuery: string | null,
  bridgeUnitIds: readonly string[] | undefined,
): ContextArtifactMatch {
  const reasons: string[] = [];
  let score = 1;
  const bridgeUnitIdSet = new Set(bridgeUnitIds ?? []);
  if (
    bridgeUnitIdSet.size > 0 &&
    artifact.sourceUnits.some((source) => bridgeUnitIdSet.has(source.bridgeUnitId))
  ) {
    score += 20;
    reasons.push("source_unit");
  }
  if (normalizedQuery !== null) {
    const body = normalizeContextArtifactText(artifact.body);
    const citationText = normalizeContextArtifactText(
      artifact.sourceUnits.map((source) => source.citation).join(" "),
    );
    if (artifact.normalizedTitle === normalizedQuery) {
      score += 30;
      reasons.push("exact_title");
    } else if (artifact.normalizedTitle.includes(normalizedQuery)) {
      score += 15;
      reasons.push("title");
    }
    if (body.includes(normalizedQuery)) {
      score += 10;
      reasons.push("body");
    }
    if (citationText.includes(normalizedQuery)) {
      score += 6;
      reasons.push("citation");
    }
    if (reasons.length === 0) {
      score = 0;
    }
  }
  return {
    ...artifact,
    retrievalScore: score,
    retrievalReasons: reasons.length === 0 ? ["typed_filter"] : reasons,
    citations: artifact.sourceUnits,
    provenance: {
      ...artifact.provenance,
      schemaVersion: contextArtifactSchemaVersion,
      toolName: contextArtifactToolName,
      toolVersion: contextArtifactToolVersion,
      contextArtifactId: artifact.contextArtifactId,
      category: artifact.category,
      sourceRevisionId: artifact.sourceRevisionId,
      producedByAgent: artifact.producedByAgent,
      producedByTool: artifact.producedByTool,
      producerVersion: artifact.producerVersion,
    },
  };
}

type LocaleBranchContextResult =
  | {
      value: {
        projectId: string;
        localeBranchId: string;
        sourceBundleId: string;
        sourceRevisionId: string;
      };
      diagnostic?: undefined;
    }
  | {
      value?: undefined;
      diagnostic: ContextArtifactDiagnostic;
    };

async function currentLocaleBranchContext(
  db: ItotoriDatabase,
  projectId: string,
  localeBranchId: string,
): Promise<LocaleBranchContextResult> {
  const [project] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (project === undefined) {
    return { diagnostic: projectMissingDiagnostic(projectId) };
  }

  const [branch] = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
      sourceBundleId: localeBranches.sourceBundleId,
      sourceRevisionId: sourceBundles.sourceBundleRevisionId,
    })
    .from(localeBranches)
    .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
    .where(
      and(
        eq(localeBranches.projectId, projectId),
        eq(localeBranches.localeBranchId, localeBranchId),
      ),
    )
    .limit(1);
  if (branch === undefined) {
    return { diagnostic: localeBranchMissingDiagnostic(projectId, localeBranchId) };
  }
  return { value: branch };
}

async function currentSourceUnitRows(
  db: ItotoriDatabase,
  sourceBundleId: string,
  bridgeUnitIds: readonly string[],
): Promise<
  {
    bridgeUnitId: string;
    sourceRevisionId: string;
    sourceHash: string;
  }[]
> {
  const ids = unique(bridgeUnitIds);
  if (ids.length === 0) {
    return [];
  }
  return await db
    .select({
      bridgeUnitId: sourceUnits.bridgeUnitId,
      sourceRevisionId: sourceUnits.sourceRevisionId,
      sourceHash: sourceUnits.sourceHash,
    })
    .from(sourceUnits)
    // ITOTORI-060: context staleness compares against the ACTIVE source set;
    // tombstoned (removed) units are excluded so a dropped unit reads as absent.
    .where(
      and(
        eq(sourceUnits.sourceBundleId, sourceBundleId),
        inArray(sourceUnits.bridgeUnitId, ids),
        isNull(sourceUnits.removedAt),
      ),
    );
}

function normalizeCategories(categories: readonly string[] | undefined): {
  values: ContextArtifactCategory[];
  diagnostics: ContextArtifactDiagnostic[];
} {
  const requested = categories ?? Object.values(contextArtifactCategoryValues);
  const values: ContextArtifactCategory[] = [];
  const diagnostics: ContextArtifactDiagnostic[] = [];
  for (const [index, category] of requested.entries()) {
    try {
      values.push(parseCategory(category, `categories[${index}]`));
    } catch (error) {
      if (error instanceof ContextArtifactRepositoryError) {
        diagnostics.push(...error.diagnostics);
      } else {
        throw error;
      }
    }
  }
  return { values: unique(values), diagnostics };
}

function parseCategory(value: string, field: string): ContextArtifactCategory {
  if (isContextArtifactCategory(value)) {
    return value;
  }
  throw new ContextArtifactRepositoryError([
    {
      code: contextArtifactDiagnosticCodeValues.unsupportedCategory,
      reasonCode: contextArtifactDiagnosticCodeValues.unsupportedCategory,
      severity: "error",
      message: `unsupported context artifact category ${value}`,
      field,
      metadata: { supportedCategories: Object.values(contextArtifactCategoryValues) },
    },
  ]);
}

function parseStatus(value: string, field: string): ContextArtifactStatus {
  if (isContextArtifactStatus(value)) {
    return value;
  }
  throw new ContextArtifactRepositoryError([
    {
      code: contextArtifactDiagnosticCodeValues.unsupportedStatus,
      reasonCode: contextArtifactDiagnosticCodeValues.unsupportedStatus,
      severity: "error",
      message: `unsupported context artifact status ${value}`,
      field,
      metadata: { supportedStatuses: Object.values(contextArtifactStatusValues) },
    },
  ]);
}

function isContextArtifactCategory(value: string): value is ContextArtifactCategory {
  return (Object.values(contextArtifactCategoryValues) as string[]).includes(value);
}

function isContextArtifactStatus(value: string): value is ContextArtifactStatus {
  return (Object.values(contextArtifactStatusValues) as string[]).includes(value);
}

function validateBoundedPayload(input: UpsertContextArtifactInput): ContextArtifactDiagnostic[] {
  const diagnostics: ContextArtifactDiagnostic[] = [];
  if (input.body.length > 20_000) {
    diagnostics.push({
      code: contextArtifactDiagnosticCodeValues.unboundedArtifactBody,
      reasonCode: contextArtifactDiagnosticCodeValues.unboundedArtifactBody,
      severity: "error",
      message: "context artifact body exceeds 20000 characters",
      field: "body",
      metadata: { maxCharacters: 20_000 },
    });
  }
  if (jsonBytes(input.data ?? {}) > 65_536 || jsonBytes(input.provenance ?? {}) > 65_536) {
    diagnostics.push({
      code: contextArtifactDiagnosticCodeValues.unboundedArtifactData,
      reasonCode: contextArtifactDiagnosticCodeValues.unboundedArtifactData,
      severity: "error",
      message: "context artifact data or provenance exceeds 65536 bytes",
      field: "data",
      metadata: { maxBytes: 65_536 },
    });
  }
  return diagnostics;
}

function contextArtifactContentHash(input: {
  category: ContextArtifactCategory;
  title: string;
  body: string;
  data: ContextArtifactJsonRecord;
  sourceUnits: { bridgeUnitId: string; sourceHash: string; citation: string }[];
}): string {
  return `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
}

function jsonBytes(value: ContextArtifactJsonRecord): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 20;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return 1;
  }
  return Math.min(limit, 100);
}

function projectMissingDiagnostic(projectId: string): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.projectMissing,
    reasonCode: contextArtifactDiagnosticCodeValues.projectMissing,
    severity: "error",
    message: `project ${projectId} does not exist`,
    field: "projectId",
    metadata: { projectId },
  };
}

function localeBranchMissingDiagnostic(
  projectId: string,
  localeBranchId: string,
): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.localeBranchMissing,
    reasonCode: contextArtifactDiagnosticCodeValues.localeBranchMissing,
    severity: "error",
    message: `locale branch ${localeBranchId} does not exist for project ${projectId}`,
    field: "localeBranchId",
    metadata: { projectId, localeBranchId },
  };
}

function staleSourceRevisionDiagnostic(
  requestedSourceRevisionId: string,
  currentSourceRevisionId: string,
): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.staleSourceRevision,
    reasonCode: contextArtifactDiagnosticCodeValues.staleSourceRevision,
    severity: "error",
    message: `source revision ${requestedSourceRevisionId} is stale for current locale branch revision ${currentSourceRevisionId}`,
    field: "sourceRevisionId",
    metadata: { requestedSourceRevisionId, currentSourceRevisionId },
  };
}

function missingSourceCitationDiagnostic(): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.missingSourceCitation,
    reasonCode: contextArtifactDiagnosticCodeValues.missingSourceCitation,
    severity: "error",
    message: "context artifacts require at least one cited source unit",
    field: "sourceUnits",
  };
}

function sourceUnitMissingDiagnostic(
  bridgeUnitId: string,
  index: number,
): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.sourceUnitMissing,
    reasonCode: contextArtifactDiagnosticCodeValues.sourceUnitMissing,
    severity: "error",
    message: `source unit ${bridgeUnitId} does not exist in the current branch source bundle`,
    field: `sourceUnits[${index}].bridgeUnitId`,
    metadata: { bridgeUnitId },
  };
}

function blankQueryDiagnostic(): ContextArtifactDiagnostic {
  return {
    code: contextArtifactDiagnosticCodeValues.blankQuery,
    reasonCode: contextArtifactDiagnosticCodeValues.blankQuery,
    severity: "error",
    message: "context artifact retrieval requires a non-empty query when query is provided",
    field: "query",
  };
}

function retrievalFailure(
  input: RetrieveContextArtifactsInput,
  sourceRevisionId: string | null,
  normalizedQuery: string | null,
  categories: ContextArtifactCategory[],
  diagnostics: ContextArtifactDiagnostic[],
): ContextArtifactRetrievalResult {
  return {
    status: "failed",
    toolName: contextArtifactToolName,
    toolVersion: contextArtifactToolVersion,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId,
    query: input.query ?? null,
    normalizedQuery,
    categories,
    matches: [],
    diagnostics,
  };
}

function invalidationFailure(
  input: InvalidateContextArtifactsInput,
  sourceRevisionId: string | null,
  diagnostics: ContextArtifactDiagnostic[],
): ContextArtifactInvalidationResult {
  return {
    status: "failed",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId,
    invalidatedCount: 0,
    invalidatedArtifactIds: [],
    diagnostics,
  };
}
