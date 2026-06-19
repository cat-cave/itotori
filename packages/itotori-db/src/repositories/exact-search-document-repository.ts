import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  exactSearchDocuments,
  exactSearchSourceArtifactTypeValues,
  localeBranches,
  localeBranchUnits,
  projects,
  sourceBundles,
  sourceUnits,
  type ExactSearchSourceArtifactType,
} from "../schema.js";

export const exactSearchToolName = "search.exact";
export const exactSearchToolVersion = "1.0.0";

export const exactSearchDiagnosticCodeValues = {
  projectMissing: "project_missing",
  localeBranchMissing: "locale_branch_missing",
  unsupportedArtifactType: "unsupported_artifact_type",
  staleSourceRevision: "stale_source_revision",
  blankQuery: "blank_query",
} as const;

export type ExactSearchDiagnosticCode =
  (typeof exactSearchDiagnosticCodeValues)[keyof typeof exactSearchDiagnosticCodeValues];

export type ExactSearchDiagnostic = {
  code: ExactSearchDiagnosticCode;
  severity: "error" | "warning" | "info";
  message: string;
  reasonCode: ExactSearchDiagnosticCode;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type ExactSearchJsonRecord = Record<string, unknown>;

export type ExactSearchDocumentRecord = {
  searchDocumentId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sourceArtifactType: ExactSearchSourceArtifactType;
  sourceArtifactId: string;
  exactTerm: string;
  normalizedExactTerm: string;
  sourceLocale: string;
  targetLocale: string;
  provenance: ExactSearchJsonRecord;
  refreshedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type RefreshExactSearchDocumentsInput = {
  projectId: string;
  localeBranchId: string;
  expectedSourceRevisionId?: string;
  sourceArtifactTypes?: readonly string[];
};

export type RefreshExactSearchDocumentsResult = {
  status: "completed" | "failed";
  toolName: typeof exactSearchToolName;
  toolVersion: typeof exactSearchToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  sourceArtifactTypes: ExactSearchSourceArtifactType[];
  documentCount: number;
  diagnostics: ExactSearchDiagnostic[];
};

export type SearchExactInput = {
  projectId: string;
  localeBranchId: string;
  query: string;
  sourceRevisionId?: string;
  sourceArtifactTypes?: readonly string[];
  limit?: number;
};

export type ExactSearchToolMatch = ExactSearchDocumentRecord & {
  provenance: ExactSearchJsonRecord & {
    toolName: typeof exactSearchToolName;
    toolVersion: typeof exactSearchToolVersion;
    searchDocumentId: string;
    sourceArtifactType: ExactSearchSourceArtifactType;
    sourceArtifactId: string;
    sourceRevisionId: string;
  };
};

export type SearchExactToolResult = {
  status: "completed" | "failed";
  toolName: typeof exactSearchToolName;
  toolVersion: typeof exactSearchToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string;
  normalizedQuery: string;
  matches: ExactSearchToolMatch[];
  diagnostics: ExactSearchDiagnostic[];
};

export interface ItotoriExactSearchDocumentRepositoryPort {
  refreshDocuments(
    actor: AuthorizationActor,
    input: RefreshExactSearchDocumentsInput,
  ): Promise<RefreshExactSearchDocumentsResult>;
  searchExact(actor: AuthorizationActor, input: SearchExactInput): Promise<SearchExactToolResult>;
}

export class ItotoriExactSearchDocumentRepository implements ItotoriExactSearchDocumentRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async refreshDocuments(
    actor: AuthorizationActor,
    input: RefreshExactSearchDocumentsInput,
  ): Promise<RefreshExactSearchDocumentsResult> {
    await requirePermission(this.db, actor, permissionValues.projectImport);

    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      return refreshFailure(input, null, [], [context.diagnostic]);
    }

    const sourceArtifactTypes = normalizeSourceArtifactTypes(input.sourceArtifactTypes);
    if (sourceArtifactTypes.diagnostics.length > 0) {
      return refreshFailure(
        input,
        context.value.sourceRevisionId,
        [],
        sourceArtifactTypes.diagnostics,
      );
    }

    if (
      input.expectedSourceRevisionId !== undefined &&
      input.expectedSourceRevisionId !== context.value.sourceRevisionId
    ) {
      return refreshFailure(input, context.value.sourceRevisionId, sourceArtifactTypes.values, [
        staleSourceRevisionDiagnostic(
          input.expectedSourceRevisionId,
          context.value.sourceRevisionId,
        ),
      ]);
    }

    const documentCount = await this.db.transaction(async (tx) => {
      await tx
        .delete(exactSearchDocuments)
        .where(
          and(
            eq(exactSearchDocuments.projectId, input.projectId),
            eq(exactSearchDocuments.localeBranchId, input.localeBranchId),
            inArray(exactSearchDocuments.sourceArtifactType, sourceArtifactTypes.values),
          ),
        );

      if (!sourceArtifactTypes.values.includes(exactSearchSourceArtifactTypeValues.sourceUnit)) {
        return 0;
      }

      const sourceUnitRows = await tx
        .select({
          bridgeUnitId: sourceUnits.bridgeUnitId,
          sourceRevisionId: sourceUnits.sourceRevisionId,
          sourceUnitKey: sourceUnits.sourceUnitKey,
          occurrenceId: sourceUnits.occurrenceId,
          sourceText: sourceUnits.sourceText,
          sourceHash: sourceUnits.sourceHash,
          sourceLocale: sourceUnits.sourceLocale,
        })
        .from(localeBranchUnits)
        .innerJoin(
          sourceUnits,
          and(
            eq(sourceUnits.bridgeUnitId, localeBranchUnits.bridgeUnitId),
            eq(sourceUnits.sourceBundleId, context.value.sourceBundleId),
          ),
        )
        .where(eq(localeBranchUnits.localeBranchId, input.localeBranchId))
        .orderBy(asc(sourceUnits.sourceUnitKey), asc(sourceUnits.occurrenceId));

      const values = sourceUnitRows.map((row) => {
        const normalizedExactTerm = normalizeExactSearchTerm(row.sourceText);
        const searchDocumentId = stableSearchDocumentId({
          localeBranchId: input.localeBranchId,
          sourceRevisionId: context.value.sourceRevisionId,
          sourceArtifactType: exactSearchSourceArtifactTypeValues.sourceUnit,
          sourceArtifactId: row.bridgeUnitId,
          normalizedExactTerm,
        });
        return {
          searchDocumentId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: context.value.sourceRevisionId,
          sourceArtifactType: exactSearchSourceArtifactTypeValues.sourceUnit,
          sourceArtifactId: row.bridgeUnitId,
          exactTerm: row.sourceText,
          normalizedExactTerm,
          sourceLocale: row.sourceLocale,
          targetLocale: context.value.targetLocale,
          provenance: {
            provenanceKind: "exact_search_document",
            toolName: exactSearchToolName,
            toolVersion: exactSearchToolVersion,
            sourceBundleId: context.value.sourceBundleId,
            sourceBundleRevisionId: context.value.sourceRevisionId,
            sourceUnitRevisionId: row.sourceRevisionId,
            sourceArtifactType: exactSearchSourceArtifactTypeValues.sourceUnit,
            sourceArtifactId: row.bridgeUnitId,
            sourceUnitKey: row.sourceUnitKey,
            occurrenceId: row.occurrenceId,
            sourceHash: row.sourceHash,
          } satisfies ExactSearchJsonRecord,
          refreshedAt: sql`now()`,
          updatedAt: sql`now()`,
        };
      });

      if (values.length === 0) {
        return 0;
      }

      const refreshed = await tx
        .insert(exactSearchDocuments)
        .values(values)
        .onConflictDoUpdate({
          target: exactSearchDocuments.searchDocumentId,
          set: {
            exactTerm: sql`excluded.exact_term`,
            normalizedExactTerm: sql`excluded.normalized_exact_term`,
            sourceLocale: sql`excluded.source_locale`,
            targetLocale: sql`excluded.target_locale`,
            provenance: sql`excluded.provenance`,
            refreshedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ searchDocumentId: exactSearchDocuments.searchDocumentId });

      return refreshed.length;
    });

    return {
      status: "completed",
      toolName: exactSearchToolName,
      toolVersion: exactSearchToolVersion,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: context.value.sourceRevisionId,
      sourceArtifactTypes: sourceArtifactTypes.values,
      documentCount,
      diagnostics: [],
    };
  }

  async searchExact(
    actor: AuthorizationActor,
    input: SearchExactInput,
  ): Promise<SearchExactToolResult> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    if (input.query.trim().length === 0) {
      return searchFailure(input, "", null, [blankQueryDiagnostic()]);
    }

    const normalizedQuery = normalizeExactSearchTerm(input.query);
    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      return searchFailure(input, normalizedQuery, null, [context.diagnostic]);
    }

    const sourceArtifactTypes = normalizeSourceArtifactTypes(input.sourceArtifactTypes);
    if (sourceArtifactTypes.diagnostics.length > 0) {
      return searchFailure(
        input,
        normalizedQuery,
        context.value.sourceRevisionId,
        sourceArtifactTypes.diagnostics,
      );
    }

    if (
      input.sourceRevisionId !== undefined &&
      input.sourceRevisionId !== context.value.sourceRevisionId
    ) {
      return searchFailure(input, normalizedQuery, context.value.sourceRevisionId, [
        staleSourceRevisionDiagnostic(input.sourceRevisionId, context.value.sourceRevisionId),
      ]);
    }

    const rows = await this.db
      .select()
      .from(exactSearchDocuments)
      .where(
        and(
          eq(exactSearchDocuments.projectId, input.projectId),
          eq(exactSearchDocuments.localeBranchId, input.localeBranchId),
          eq(exactSearchDocuments.sourceRevisionId, context.value.sourceRevisionId),
          eq(exactSearchDocuments.normalizedExactTerm, normalizedQuery),
          inArray(exactSearchDocuments.sourceArtifactType, sourceArtifactTypes.values),
        ),
      )
      .orderBy(
        asc(exactSearchDocuments.sourceArtifactId),
        asc(exactSearchDocuments.searchDocumentId),
      )
      .limit(clampLimit(input.limit));

    return {
      status: "completed",
      toolName: exactSearchToolName,
      toolVersion: exactSearchToolVersion,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: context.value.sourceRevisionId,
      query: input.query,
      normalizedQuery,
      matches: rows.map((row) => {
        const record = exactSearchDocumentRecordFromRow(row);
        return {
          ...record,
          provenance: {
            ...record.provenance,
            toolName: exactSearchToolName,
            toolVersion: exactSearchToolVersion,
            searchDocumentId: record.searchDocumentId,
            sourceArtifactType: record.sourceArtifactType,
            sourceArtifactId: record.sourceArtifactId,
            sourceRevisionId: record.sourceRevisionId,
          },
        };
      }),
      diagnostics: [],
    };
  }
}

export function normalizeExactSearchTerm(value: string): string {
  return requiredString(value, "query")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
}

function exactSearchDocumentRecordFromRow(
  row: typeof exactSearchDocuments.$inferSelect,
): ExactSearchDocumentRecord {
  return {
    searchDocumentId: row.searchDocumentId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    sourceArtifactType: exactSearchSourceArtifactType(row.sourceArtifactType),
    sourceArtifactId: row.sourceArtifactId,
    exactTerm: row.exactTerm,
    normalizedExactTerm: row.normalizedExactTerm,
    sourceLocale: row.sourceLocale,
    targetLocale: row.targetLocale,
    provenance: row.provenance,
    refreshedAt: row.refreshedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type LocaleBranchContextResult =
  | {
      value: {
        projectId: string;
        localeBranchId: string;
        sourceBundleId: string;
        sourceRevisionId: string;
        targetLocale: string;
      };
      diagnostic?: undefined;
    }
  | {
      value?: undefined;
      diagnostic: ExactSearchDiagnostic;
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
    return {
      diagnostic: {
        code: exactSearchDiagnosticCodeValues.projectMissing,
        reasonCode: exactSearchDiagnosticCodeValues.projectMissing,
        severity: "error",
        message: `project ${projectId} does not exist`,
        field: "projectId",
        metadata: { projectId },
      },
    };
  }

  const [branch] = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
      sourceBundleId: localeBranches.sourceBundleId,
      sourceRevisionId: sourceBundles.sourceBundleRevisionId,
      targetLocale: localeBranches.targetLocale,
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
    return {
      diagnostic: {
        code: exactSearchDiagnosticCodeValues.localeBranchMissing,
        reasonCode: exactSearchDiagnosticCodeValues.localeBranchMissing,
        severity: "error",
        message: `locale branch ${localeBranchId} does not exist for project ${projectId}`,
        field: "localeBranchId",
        metadata: { projectId, localeBranchId },
      },
    };
  }

  return { value: branch };
}

function normalizeSourceArtifactTypes(sourceArtifactTypes: readonly string[] | undefined): {
  values: ExactSearchSourceArtifactType[];
  diagnostics: ExactSearchDiagnostic[];
} {
  const requested = sourceArtifactTypes ?? [exactSearchSourceArtifactTypeValues.sourceUnit];
  const values: ExactSearchSourceArtifactType[] = [];
  const diagnostics: ExactSearchDiagnostic[] = [];

  if (requested.length === 0) {
    diagnostics.push({
      code: exactSearchDiagnosticCodeValues.unsupportedArtifactType,
      reasonCode: exactSearchDiagnosticCodeValues.unsupportedArtifactType,
      severity: "error",
      message: "exact search v1 requires at least one supported source artifact type",
      field: "sourceArtifactTypes",
      metadata: { supportedArtifactTypes: supportedSourceArtifactTypes },
    });
    return { values, diagnostics };
  }

  for (const [index, sourceArtifactType] of requested.entries()) {
    if (sourceArtifactType === exactSearchSourceArtifactTypeValues.sourceUnit) {
      values.push(sourceArtifactType);
      continue;
    }
    diagnostics.push({
      code: exactSearchDiagnosticCodeValues.unsupportedArtifactType,
      reasonCode: exactSearchDiagnosticCodeValues.unsupportedArtifactType,
      severity: "error",
      message: `exact search v1 does not support source artifact type ${sourceArtifactType}`,
      field: `sourceArtifactTypes[${index}]`,
      metadata: { sourceArtifactType, supportedArtifactTypes: supportedSourceArtifactTypes },
    });
  }

  return { values: [...new Set(values)], diagnostics };
}

function exactSearchSourceArtifactType(value: string): ExactSearchSourceArtifactType {
  if (value !== exactSearchSourceArtifactTypeValues.sourceUnit) {
    throw new Error(`unsupported exact search source artifact type in database: ${value}`);
  }
  return value;
}

function staleSourceRevisionDiagnostic(
  requestedSourceRevisionId: string,
  currentSourceRevisionId: string,
): ExactSearchDiagnostic {
  return {
    code: exactSearchDiagnosticCodeValues.staleSourceRevision,
    reasonCode: exactSearchDiagnosticCodeValues.staleSourceRevision,
    severity: "error",
    message: `source revision ${requestedSourceRevisionId} is stale for current locale branch revision ${currentSourceRevisionId}`,
    field: "sourceRevisionId",
    metadata: { requestedSourceRevisionId, currentSourceRevisionId },
  };
}

function blankQueryDiagnostic(): ExactSearchDiagnostic {
  return {
    code: exactSearchDiagnosticCodeValues.blankQuery,
    reasonCode: exactSearchDiagnosticCodeValues.blankQuery,
    severity: "error",
    message: "exact search v1 requires a non-empty query",
    field: "query",
  };
}

function refreshFailure(
  input: RefreshExactSearchDocumentsInput,
  sourceRevisionId: string | null,
  sourceArtifactTypes: ExactSearchSourceArtifactType[],
  diagnostics: ExactSearchDiagnostic[],
): RefreshExactSearchDocumentsResult {
  return {
    status: "failed",
    toolName: exactSearchToolName,
    toolVersion: exactSearchToolVersion,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId,
    sourceArtifactTypes,
    documentCount: 0,
    diagnostics,
  };
}

function searchFailure(
  input: SearchExactInput,
  normalizedQuery: string,
  sourceRevisionId: string | null,
  diagnostics: ExactSearchDiagnostic[],
): SearchExactToolResult {
  return {
    status: "failed",
    toolName: exactSearchToolName,
    toolVersion: exactSearchToolVersion,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId,
    query: input.query,
    normalizedQuery,
    matches: [],
    diagnostics,
  };
}

function stableSearchDocumentId(input: {
  localeBranchId: string;
  sourceRevisionId: string;
  sourceArtifactType: ExactSearchSourceArtifactType;
  sourceArtifactId: string;
  normalizedExactTerm: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        input.localeBranchId,
        input.sourceRevisionId,
        input.sourceArtifactType,
        input.sourceArtifactId,
        input.normalizedExactTerm,
      ].join("\0"),
    )
    .digest("hex");
  return `exact-search-doc:${digest}`;
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

function requiredString(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

const supportedSourceArtifactTypes = [exactSearchSourceArtifactTypeValues.sourceUnit] as const;
