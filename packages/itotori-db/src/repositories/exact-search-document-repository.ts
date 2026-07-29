import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  exactSearchDocuments,
  exactSearchSourceArtifactTypeValues,
  localeBranchUnits,
  sourceUnits,
} from "../schema.js";
import {
  blankQueryDiagnostic,
  clampLimit,
  currentLocaleBranchContext,
  exactSearchDocumentRecordFromRow,
  exactSearchToolName,
  exactSearchToolVersion,
  normalizeExactSearchTerm,
  normalizeSourceArtifactTypes,
  refreshFailure,
  searchFailure,
  stableSearchDocumentId,
  staleSourceRevisionDiagnostic,
} from "./exact-search-document-repository-support.js";
import type {
  ExactSearchJsonRecord,
  RefreshExactSearchDocumentsInput,
  RefreshExactSearchDocumentsResult,
  SearchExactInput,
  SearchExactToolResult,
} from "./exact-search-document-repository-support.js";

export {
  exactSearchDiagnosticCodeValues,
  exactSearchToolName,
  exactSearchToolVersion,
  normalizeExactSearchTerm,
} from "./exact-search-document-repository-support.js";
export type {
  ExactSearchDiagnostic,
  ExactSearchDiagnosticCode,
  ExactSearchDocumentRecord,
  ExactSearchJsonRecord,
  ExactSearchToolMatch,
  RefreshExactSearchDocumentsInput,
  RefreshExactSearchDocumentsResult,
  SearchExactInput,
  SearchExactToolResult,
} from "./exact-search-document-repository-support.js";

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
