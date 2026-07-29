import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  exactSearchDocuments,
  exactSearchSourceArtifactTypeValues,
  localeBranches,
  projects,
  sourceBundles,
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

export function normalizeExactSearchTerm(value: string): string {
  return requiredString(value, "query")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
}

export function exactSearchDocumentRecordFromRow(
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

export async function currentLocaleBranchContext(
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

export function normalizeSourceArtifactTypes(sourceArtifactTypes: readonly string[] | undefined): {
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

export function staleSourceRevisionDiagnostic(
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

export function blankQueryDiagnostic(): ExactSearchDiagnostic {
  return {
    code: exactSearchDiagnosticCodeValues.blankQuery,
    reasonCode: exactSearchDiagnosticCodeValues.blankQuery,
    severity: "error",
    message: "exact search v1 requires a non-empty query",
    field: "query",
  };
}

export function refreshFailure(
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

export function searchFailure(
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

export function stableSearchDocumentId(input: {
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

export function clampLimit(limit: number | undefined): number {
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
