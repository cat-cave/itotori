import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import { permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  localeBranches,
  sourceBundles,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferences,
  terminologyTerms,
  terminologyTermStatusValues,
  type TerminologySemanticIndexStatus,
} from "../schema.js";
import {
  ItotoriTerminologyRepository,
  type ItotoriTerminologyRepositoryPort,
  type TerminologySearchMatchKind,
  type TerminologySearchResult,
} from "../repositories/terminology-repository.js";
import {
  exactSearchToolName,
  exactSearchToolVersion,
} from "../repositories/exact-search-document-repository.js";

import {
  RecordedEmbeddingFixtureAdapter,
  type RecordedEmbeddingMatch,
  type SemanticGlossarySearchDiagnostic,
  type SemanticGlossarySearchInput,
  type SemanticGlossarySearchMatch,
  type SemanticGlossarySearchReadiness,
  type SemanticGlossarySearchReadModel,
  semanticGlossarySearchToolName,
  semanticGlossarySearchToolVersion,
} from "./semantic-search-01.js";
import {
  baseReadiness,
  compareSemanticMatches,
  cosineSimilarity,
  exactFallbackMatch,
  hasStrongExactMatch,
  mergeSearchMatches,
  normalizeSemanticSearchText,
  type SemanticCandidate,
  semanticMatch,
} from "./semantic-search-03.js";
import {
  blankQueryDiagnostic,
  clampLimit,
  currentLocaleBranchContext,
  exactFallbackUsedDiagnostic,
  failedResult,
  groupBy,
  missingRecordedEmbeddingDiagnostic,
  noSemanticResultsDiagnostic,
  staleSemanticIndexDiagnostic,
  staleSourceRevisionDiagnostic,
} from "./semantic-search-04.js";

export class ItotoriSemanticGlossarySearchService {
  private readonly terminologyRepository: ItotoriTerminologyRepositoryPort;

  constructor(
    private readonly db: ItotoriDatabase,
    private readonly embeddings: RecordedEmbeddingFixtureAdapter,
    options: { terminologyRepository?: ItotoriTerminologyRepositoryPort } = {},
  ) {
    this.terminologyRepository =
      options.terminologyRepository ?? new ItotoriTerminologyRepository(db);
  }

  async searchGlossary(
    actor: AuthorizationActor,
    input: SemanticGlossarySearchInput,
  ): Promise<SemanticGlossarySearchReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const normalizedQuery = normalizeSemanticSearchText(input.query);
    const readiness = baseReadiness(this.embeddings.metadata(), null);
    if (normalizedQuery.length === 0) {
      return {
        outputKind: "semantic_glossary_search",
        status: "failed",
        toolName: semanticGlossarySearchToolName,
        toolVersion: semanticGlossarySearchToolVersion,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: null,
        query: input.query,
        normalizedQuery,
        readiness,
        matches: [],
        diagnostics: [blankQueryDiagnostic()],
      };
    }

    const context = await currentLocaleBranchContext(
      this.db,
      input.projectId,
      input.localeBranchId,
    );
    if (context.diagnostic !== undefined) {
      return failedResult(input, normalizedQuery, null, readiness, [context.diagnostic]);
    }
    if (
      input.sourceRevisionId !== undefined &&
      input.sourceRevisionId !== context.value.sourceRevisionId
    ) {
      return failedResult(input, normalizedQuery, context.value.sourceRevisionId, readiness, [
        staleSourceRevisionDiagnostic(input.sourceRevisionId, context.value.sourceRevisionId),
      ]);
    }

    const queryEmbedding = this.embeddings.embedQuery(input.query);
    if (queryEmbedding === null) {
      return this.exactFallback(input, normalizedQuery, context.value.sourceRevisionId, {
        actor,
        reason: "missing_recorded_embedding",
        diagnostics: [missingRecordedEmbeddingDiagnostic(input.query)],
      });
    }

    const readinessWithQuery = baseReadiness(queryEmbedding, queryEmbedding.textHash);
    const candidates = await this.semanticCandidates(input);
    const staleCount = candidates.filter(
      (candidate) => candidate.semanticStatus === terminologySemanticIndexStatusValues.stale,
    ).length;
    const staleRelevantCount = candidates.filter(
      (candidate) =>
        candidate.semanticStatus === terminologySemanticIndexStatusValues.stale &&
        (normalizeSemanticSearchText(candidate.sourceTerm) === normalizedQuery ||
          normalizeSemanticSearchText(candidate.preferredTranslation) === normalizedQuery),
    ).length;
    const diagnostics: SemanticGlossarySearchDiagnostic[] = [];
    if (staleCount > 0) {
      diagnostics.push(staleSemanticIndexDiagnostic(staleCount));
    }

    const minScore = input.minScore ?? 0.2;
    const limit = clampLimit(input.limit);
    const readyCandidates = candidates.filter(
      (candidate) => candidate.semanticStatus === terminologySemanticIndexStatusValues.ready,
    );
    const ranked = readyCandidates
      .map((candidate) => {
        if (
          candidate.embeddingVector === null ||
          candidate.embeddingVector.length !== queryEmbedding.dimension
        ) {
          return null;
        }
        const score = cosineSimilarity(queryEmbedding.embedding, candidate.embeddingVector);
        if (score < minScore) {
          return null;
        }
        return semanticMatch(candidate, score, queryEmbedding);
      })
      .filter((match): match is SemanticGlossarySearchMatch => match !== null)
      .sort(compareSemanticMatches);

    if (ranked.length > 0) {
      const exact = await this.searchExactFallback(actor, input);
      const exactMatches = exact.results.filter(hasStrongExactMatch).map(exactFallbackMatch);
      const exactFallbackTriggered = exactMatches.length > 0;
      return {
        outputKind: "semantic_glossary_search",
        status: "completed",
        toolName: semanticGlossarySearchToolName,
        toolVersion: semanticGlossarySearchToolVersion,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: context.value.sourceRevisionId,
        query: input.query,
        normalizedQuery,
        readiness: exactFallbackTriggered
          ? {
              ...readinessWithQuery,
              exactFallback: {
                triggered: true,
                reason: "semantic_exact_match",
                toolName: exactSearchToolName,
                toolVersion: exactSearchToolVersion,
              },
            }
          : readinessWithQuery,
        matches: mergeSearchMatches(exactMatches, ranked, limit),
        diagnostics: exactFallbackTriggered
          ? [
              ...diagnostics,
              exactFallbackUsedDiagnostic("semantic_exact_match", exactMatches.length),
            ]
          : diagnostics,
      };
    }

    const fallbackReason =
      staleRelevantCount > 0 || (staleCount > 0 && readyCandidates.length === 0)
        ? "stale_semantic_index"
        : "no_semantic_results";
    return this.exactFallback(input, normalizedQuery, context.value.sourceRevisionId, {
      actor,
      reason: fallbackReason,
      diagnostics: [...diagnostics, noSemanticResultsDiagnostic(fallbackReason)],
      queryEmbedding,
    });
  }

  private async semanticCandidates(
    input: SemanticGlossarySearchInput,
  ): Promise<SemanticCandidate[]> {
    const rows = await this.db
      .select({
        termId: terminologyTerms.termId,
        sourceTerm: terminologyTerms.sourceTerm,
        preferredTranslation: terminologyTerms.preferredTranslation,
        termKind: terminologyTerms.termKind,
        status: terminologyTerms.status,
        sourceLocale: terminologyTerms.sourceLocale,
        targetLocale: terminologyTerms.targetLocale,
        semanticIndexId: terminologySemanticIndex.semanticIndexId,
        searchDocument: terminologySemanticIndex.searchDocument,
        searchTokens: terminologySemanticIndex.searchTokens,
        embeddingProvider: terminologySemanticIndex.embeddingProvider,
        embeddingModel: terminologySemanticIndex.embeddingModel,
        embeddingDimension: terminologySemanticIndex.embeddingDimension,
        embeddingVector: terminologySemanticIndex.embeddingVector,
        contentHash: terminologySemanticIndex.contentHash,
        semanticStatus: terminologySemanticIndex.status,
      })
      .from(terminologyTerms)
      .innerJoin(
        terminologySemanticIndex,
        eq(terminologySemanticIndex.termId, terminologyTerms.termId),
      )
      .where(
        and(
          eq(terminologyTerms.projectId, input.projectId),
          eq(terminologyTerms.localeBranchId, input.localeBranchId),
          input.includeDeprecated
            ? eq(terminologyTerms.localeBranchId, input.localeBranchId)
            : ne(terminologyTerms.status, terminologyTermStatusValues.deprecated),
        ),
      )
      .orderBy(asc(terminologyTerms.sourceTerm), asc(terminologyTerms.termId));

    const termIds = rows.map((row) => row.termId);
    const references =
      termIds.length === 0
        ? []
        : await this.db
            .select()
            .from(terminologySourceReferences)
            .where(inArray(terminologySourceReferences.termId, termIds))
            .orderBy(
              asc(terminologySourceReferences.termId),
              asc(terminologySourceReferences.citation),
            );
    const referencesByTermId = groupBy(references, (reference) => reference.termId);

    return rows.map((row) => ({
      ...row,
      semanticStatus: row.semanticStatus as TerminologySemanticIndexStatus,
      references: referencesByTermId.get(row.termId) ?? [],
    }));
  }

  private async exactFallback(
    input: SemanticGlossarySearchInput,
    normalizedQuery: string,
    sourceRevisionId: string,
    fallback: {
      actor: AuthorizationActor;
      reason: NonNullable<SemanticGlossarySearchReadiness["exactFallback"]["reason"]>;
      diagnostics: SemanticGlossarySearchDiagnostic[];
      queryEmbedding?: RecordedEmbeddingMatch;
    },
  ): Promise<SemanticGlossarySearchReadModel> {
    const exact = await this.searchExactFallback(fallback.actor, input);
    return {
      outputKind: "semantic_glossary_search",
      status: "completed",
      toolName: semanticGlossarySearchToolName,
      toolVersion: semanticGlossarySearchToolVersion,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId,
      query: input.query,
      normalizedQuery,
      readiness: {
        ...baseReadiness(
          fallback.queryEmbedding ?? this.embeddings.metadata(),
          fallback.queryEmbedding?.textHash ?? null,
        ),
        exactFallback: {
          triggered: true,
          reason: fallback.reason,
          toolName: exactSearchToolName,
          toolVersion: exactSearchToolVersion,
        },
      },
      matches: exact.results.map(exactFallbackMatch),
      diagnostics: [
        ...fallback.diagnostics,
        exactFallbackUsedDiagnostic(fallback.reason, exact.results.length),
      ],
    };
  }

  private async searchExactFallback(
    actor: AuthorizationActor,
    input: SemanticGlossarySearchInput,
  ): Promise<Awaited<ReturnType<ItotoriTerminologyRepositoryPort["searchTerms"]>>> {
    return this.terminologyRepository.searchTerms(actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.includeDeprecated === undefined
        ? {}
        : { includeDeprecated: input.includeDeprecated }),
    });
  }
}
