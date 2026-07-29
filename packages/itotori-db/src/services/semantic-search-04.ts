import { and, eq } from "drizzle-orm";

import type { ItotoriDatabase } from "../connection.js";
import { localeBranches, sourceBundles } from "../schema.js";

import {
  exactSearchToolName,
  exactSearchToolVersion,
} from "../repositories/exact-search-document-repository.js";

import {
  type LocaleBranchSearchContext,
  type SemanticGlossarySearchDiagnostic,
  semanticGlossarySearchDiagnosticCodeValues,
  type SemanticGlossarySearchInput,
  type SemanticGlossarySearchReadiness,
  type SemanticGlossarySearchReadModel,
  semanticGlossarySearchToolName,
  semanticGlossarySearchToolVersion,
} from "./semantic-search-01.js";

export async function currentLocaleBranchContext(
  db: ItotoriDatabase,
  projectId: string,
  localeBranchId: string,
): Promise<LocaleBranchSearchContext> {
  const [branch] = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
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
    return {
      diagnostic: {
        code: semanticGlossarySearchDiagnosticCodeValues.localeBranchMissing,
        reasonCode: semanticGlossarySearchDiagnosticCodeValues.localeBranchMissing,
        severity: "error",
        message: `locale branch ${localeBranchId} does not exist for project ${projectId}`,
        field: "localeBranchId",
        metadata: { projectId, localeBranchId },
      },
    };
  }
  return { value: branch };
}

export function failedResult(
  input: SemanticGlossarySearchInput,
  normalizedQuery: string,
  sourceRevisionId: string | null,
  readiness: SemanticGlossarySearchReadiness,
  diagnostics: SemanticGlossarySearchDiagnostic[],
): SemanticGlossarySearchReadModel {
  return {
    outputKind: "semantic_glossary_search",
    status: "failed",
    toolName: semanticGlossarySearchToolName,
    toolVersion: semanticGlossarySearchToolVersion,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId,
    query: input.query,
    normalizedQuery,
    readiness,
    matches: [],
    diagnostics,
  };
}

export function blankQueryDiagnostic(): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.blankQuery,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.blankQuery,
    severity: "error",
    message: "semantic glossary search requires a non-empty query",
    field: "query",
  };
}

export function staleSourceRevisionDiagnostic(
  requestedSourceRevisionId: string,
  currentSourceRevisionId: string,
): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.staleSourceRevision,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.staleSourceRevision,
    severity: "error",
    message: `source revision ${requestedSourceRevisionId} is stale for current locale branch revision ${currentSourceRevisionId}`,
    field: "sourceRevisionId",
    metadata: { requestedSourceRevisionId, currentSourceRevisionId },
  };
}

export function missingRecordedEmbeddingDiagnostic(
  query: string,
): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.missingRecordedEmbedding,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.missingRecordedEmbedding,
    severity: "info",
    message: "recorded embedding fixture has no query vector; exact fallback was used",
    metadata: { query },
  };
}

export function staleSemanticIndexDiagnostic(staleCount: number): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.staleSemanticIndex,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.staleSemanticIndex,
    severity: "warning",
    message: "one or more semantic glossary indexes are stale and were excluded from ranking",
    metadata: { staleCount },
  };
}

export function noSemanticResultsDiagnostic(
  reason: "stale_semantic_index" | "no_semantic_results",
): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.noSemanticResults,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.noSemanticResults,
    severity: "info",
    message: "recorded semantic ranking produced no candidates; exact fallback was used",
    metadata: { fallbackReason: reason },
  };
}

export function exactFallbackUsedDiagnostic(
  reason: NonNullable<SemanticGlossarySearchReadiness["exactFallback"]["reason"]>,
  matchCount: number,
): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.exactFallbackUsed,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.exactFallbackUsed,
    severity: "info",
    message: "semantic glossary search used deterministic exact fallback",
    metadata: {
      reason,
      matchCount,
      toolName: exactSearchToolName,
      toolVersion: exactSearchToolVersion,
    },
  };
}

export function assertEmbeddingVector(vector: number[], dimension: number, label: string): void {
  if (!Array.isArray(vector) || vector.length !== dimension || !vector.every(Number.isFinite)) {
    throw new Error(`${label} must contain ${dimension} finite numbers`);
  }
}

export function groupBy<Value, Key>(
  values: Value[],
  keyForValue: (value: Value) => Key,
): Map<Key, Value[]> {
  const grouped = new Map<Key, Value[]>();
  for (const value of values) {
    const key = keyForValue(value);
    const bucket = grouped.get(key) ?? [];
    bucket.push(value);
    grouped.set(key, bucket);
  }
  return grouped;
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
