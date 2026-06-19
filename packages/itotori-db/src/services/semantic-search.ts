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

export const semanticGlossarySearchToolName = "search.glossary";
export const semanticGlossarySearchToolVersion = "1.0.0";

export const semanticGlossarySearchDiagnosticCodeValues = {
  blankQuery: "blank_query",
  localeBranchMissing: "locale_branch_missing",
  staleSourceRevision: "stale_source_revision",
  missingRecordedEmbedding: "missing_recorded_embedding",
  staleSemanticIndex: "stale_semantic_index",
  noSemanticResults: "no_semantic_results",
  exactFallbackUsed: "exact_fallback_used",
} as const;

export type SemanticGlossarySearchDiagnosticCode =
  (typeof semanticGlossarySearchDiagnosticCodeValues)[keyof typeof semanticGlossarySearchDiagnosticCodeValues];

export type SemanticGlossarySearchDiagnostic = {
  code: SemanticGlossarySearchDiagnosticCode;
  reasonCode: SemanticGlossarySearchDiagnosticCode;
  severity: "error" | "warning" | "info";
  message: string;
  field?: string;
  metadata?: Record<string, unknown>;
};

export type RecordedEmbeddingFixtureVector = {
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

export type RecordedEmbeddingFixture = {
  fixtureId: string;
  provider: string;
  model: string;
  dimension: number;
  vectors: readonly RecordedEmbeddingFixtureVector[];
};

export type RecordedEmbeddingMatch = {
  fixtureId: string;
  provider: string;
  model: string;
  dimension: number;
  text: string;
  normalizedText: string;
  textHash: string;
  embedding: number[];
  metadata: Record<string, unknown>;
};

type RecordedEmbeddingFixtureMetadata = {
  fixtureId: string;
  provider: string;
  model: string;
  dimension: number;
};

export class RecordedEmbeddingFixtureAdapter {
  private readonly vectorsByTextHash: Map<string, RecordedEmbeddingMatch>;

  constructor(private readonly fixture: RecordedEmbeddingFixture) {
    if (!Number.isInteger(fixture.dimension) || fixture.dimension < 1) {
      throw new Error("recorded embedding fixture dimension must be a positive integer");
    }
    this.vectorsByTextHash = new Map(
      fixture.vectors.map((vector) => {
        assertEmbeddingVector(vector.embedding, fixture.dimension, "recorded fixture embedding");
        const normalizedText = normalizeSemanticSearchText(vector.text);
        const textHash = semanticSearchTextHash(normalizedText);
        return [
          textHash,
          {
            fixtureId: fixture.fixtureId,
            provider: fixture.provider,
            model: fixture.model,
            dimension: fixture.dimension,
            text: vector.text,
            normalizedText,
            textHash,
            embedding: vector.embedding,
            metadata: vector.metadata ?? {},
          },
        ];
      }),
    );
  }

  embedQuery(query: string): RecordedEmbeddingMatch | null {
    return (
      this.vectorsByTextHash.get(semanticSearchTextHash(normalizeSemanticSearchText(query))) ?? null
    );
  }

  metadata(): RecordedEmbeddingFixtureMetadata {
    return {
      fixtureId: this.fixture.fixtureId,
      provider: this.fixture.provider,
      model: this.fixture.model,
      dimension: this.fixture.dimension,
    };
  }
}

export type SemanticGlossarySearchInput = {
  projectId: string;
  localeBranchId: string;
  query: string;
  sourceRevisionId?: string;
  limit?: number;
  minScore?: number;
  includeDeprecated?: boolean;
};

export type SemanticGlossarySearchMatchKind = "semantic_vector" | "exact_fallback";

export type SemanticGlossarySearchTermSummary = {
  termId: string;
  sourceTerm: string;
  preferredTranslation: string;
  termKind: string;
  status: string;
  sourceLocale: string;
  targetLocale: string;
};

export type SemanticGlossarySearchMatch = {
  term: SemanticGlossarySearchTermSummary;
  score: number;
  matchKinds: SemanticGlossarySearchMatchKind[];
  exactMatchKinds: TerminologySearchMatchKind[];
  provenance: Record<string, unknown>;
};

export type SemanticGlossarySearchReadiness = {
  embeddingMode: "recorded_fixture";
  liveProviderRequired: false;
  fixtureId: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  queryEmbeddingHash: string | null;
  pgvector: {
    required: false;
    available: false;
    reason: "public_ci_uses_recorded_json_vectors";
  };
  exactFallback: {
    triggered: boolean;
    reason:
      | "missing_recorded_embedding"
      | "stale_semantic_index"
      | "no_semantic_results"
      | "semantic_exact_match"
      | null;
    toolName: typeof exactSearchToolName;
    toolVersion: typeof exactSearchToolVersion;
  };
};

export type SemanticGlossarySearchReadModel = {
  outputKind: "semantic_glossary_search";
  status: "completed" | "failed";
  toolName: typeof semanticGlossarySearchToolName;
  toolVersion: typeof semanticGlossarySearchToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string;
  normalizedQuery: string;
  readiness: SemanticGlossarySearchReadiness;
  matches: SemanticGlossarySearchMatch[];
  diagnostics: SemanticGlossarySearchDiagnostic[];
};

type LocaleBranchSearchContext =
  | {
      value: {
        projectId: string;
        localeBranchId: string;
        sourceRevisionId: string;
      };
      diagnostic?: undefined;
    }
  | {
      value?: undefined;
      diagnostic: SemanticGlossarySearchDiagnostic;
    };

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

type SemanticCandidate = {
  termId: string;
  sourceTerm: string;
  preferredTranslation: string;
  termKind: string;
  status: string;
  sourceLocale: string;
  targetLocale: string;
  semanticIndexId: string;
  searchDocument: string;
  searchTokens: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVector: number[] | null;
  contentHash: string;
  semanticStatus: TerminologySemanticIndexStatus;
  references: Array<typeof terminologySourceReferences.$inferSelect>;
};

export function normalizeSemanticSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function semanticSearchTextHash(normalizedText: string): string {
  return `sha256:${createHash("sha256").update(normalizedText).digest("hex")}`;
}

function semanticMatch(
  candidate: SemanticCandidate,
  score: number,
  queryEmbedding: RecordedEmbeddingMatch,
): SemanticGlossarySearchMatch {
  return {
    term: termSummary(candidate),
    score: Number(score.toFixed(6)),
    matchKinds: ["semantic_vector"],
    exactMatchKinds: [],
    provenance: {
      provenanceKind: "semantic_glossary_search_result",
      toolName: semanticGlossarySearchToolName,
      toolVersion: semanticGlossarySearchToolVersion,
      fixtureId: queryEmbedding.fixtureId,
      queryEmbeddingHash: queryEmbedding.textHash,
      semanticIndexId: candidate.semanticIndexId,
      semanticIndexStatus: candidate.semanticStatus,
      embeddingProvider: candidate.embeddingProvider,
      embeddingModel: candidate.embeddingModel,
      embeddingDimension: candidate.embeddingDimension,
      contentHash: candidate.contentHash,
      citations: candidate.references.map((reference) => ({
        sourceRefId: reference.sourceRefId,
        sourceRevisionId: reference.sourceRevisionId,
        bridgeUnitId: reference.bridgeUnitId,
        referenceKind: reference.referenceKind,
        citation: reference.citation,
        context: reference.context,
      })),
    },
  };
}

function exactFallbackMatch(match: TerminologySearchResult): SemanticGlossarySearchMatch {
  return {
    term: {
      termId: match.term.termId,
      sourceTerm: match.term.sourceTerm,
      preferredTranslation: match.term.preferredTranslation,
      termKind: match.term.termKind,
      status: match.term.status,
      sourceLocale: match.term.sourceLocale,
      targetLocale: match.term.targetLocale,
    },
    score: match.score,
    matchKinds: ["exact_fallback"],
    exactMatchKinds: match.matchKinds,
    provenance: {
      provenanceKind: "semantic_glossary_exact_fallback_result",
      toolName: semanticGlossarySearchToolName,
      toolVersion: semanticGlossarySearchToolVersion,
      fallbackToolName: exactSearchToolName,
      fallbackToolVersion: exactSearchToolVersion,
      termId: match.term.termId,
      exactMatchKinds: match.matchKinds,
      citations: match.term.sourceReferences.map((reference) => ({
        sourceRefId: reference.sourceRefId,
        sourceRevisionId: reference.sourceRevisionId,
        bridgeUnitId: reference.bridgeUnitId,
        referenceKind: reference.referenceKind,
        citation: reference.citation,
        context: reference.context,
      })),
    },
  };
}

function termSummary(candidate: SemanticCandidate): SemanticGlossarySearchTermSummary {
  return {
    termId: candidate.termId,
    sourceTerm: candidate.sourceTerm,
    preferredTranslation: candidate.preferredTranslation,
    termKind: candidate.termKind,
    status: candidate.status,
    sourceLocale: candidate.sourceLocale,
    targetLocale: candidate.targetLocale,
  };
}

function compareSemanticMatches(
  left: SemanticGlossarySearchMatch,
  right: SemanticGlossarySearchMatch,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return left.term.sourceTerm.localeCompare(right.term.sourceTerm);
}

function hasStrongExactMatch(match: TerminologySearchResult): boolean {
  return match.matchKinds.some(
    (kind) => kind === "exact_source" || kind === "exact_translation" || kind === "alias",
  );
}

function mergeSearchMatches(
  exactMatches: SemanticGlossarySearchMatch[],
  semanticMatches: SemanticGlossarySearchMatch[],
  limit: number,
): SemanticGlossarySearchMatch[] {
  const mergedByTermId = new Map<string, SemanticGlossarySearchMatch>();
  for (const match of [...exactMatches, ...semanticMatches].sort(compareSemanticMatches)) {
    if (!mergedByTermId.has(match.term.termId)) {
      mergedByTermId.set(match.term.termId, match);
    }
  }
  return [...mergedByTermId.values()].sort(compareSemanticMatches).slice(0, limit);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function baseReadiness(
  fixtureMatch: RecordedEmbeddingFixtureMetadata | null,
  queryEmbeddingHash: string | null,
): SemanticGlossarySearchReadiness {
  return {
    embeddingMode: "recorded_fixture",
    liveProviderRequired: false,
    fixtureId: fixtureMatch?.fixtureId ?? "unresolved-recorded-fixture",
    embeddingProvider: fixtureMatch?.provider ?? "recorded-fixture",
    embeddingModel: fixtureMatch?.model ?? "recorded-fixture",
    embeddingDimension: fixtureMatch?.dimension ?? 0,
    queryEmbeddingHash,
    pgvector: {
      required: false,
      available: false,
      reason: "public_ci_uses_recorded_json_vectors",
    },
    exactFallback: {
      triggered: false,
      reason: null,
      toolName: exactSearchToolName,
      toolVersion: exactSearchToolVersion,
    },
  };
}

async function currentLocaleBranchContext(
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

function failedResult(
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

function blankQueryDiagnostic(): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.blankQuery,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.blankQuery,
    severity: "error",
    message: "semantic glossary search requires a non-empty query",
    field: "query",
  };
}

function staleSourceRevisionDiagnostic(
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

function missingRecordedEmbeddingDiagnostic(query: string): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.missingRecordedEmbedding,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.missingRecordedEmbedding,
    severity: "info",
    message: "recorded embedding fixture has no query vector; exact fallback was used",
    metadata: { query },
  };
}

function staleSemanticIndexDiagnostic(staleCount: number): SemanticGlossarySearchDiagnostic {
  return {
    code: semanticGlossarySearchDiagnosticCodeValues.staleSemanticIndex,
    reasonCode: semanticGlossarySearchDiagnosticCodeValues.staleSemanticIndex,
    severity: "warning",
    message: "one or more semantic glossary indexes are stale and were excluded from ranking",
    metadata: { staleCount },
  };
}

function noSemanticResultsDiagnostic(
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

function exactFallbackUsedDiagnostic(
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

function assertEmbeddingVector(vector: number[], dimension: number, label: string): void {
  if (!Array.isArray(vector) || vector.length !== dimension || !vector.every(Number.isFinite)) {
    throw new Error(`${label} must contain ${dimension} finite numbers`);
  }
}

function groupBy<Value, Key>(
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

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 20;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return 1;
  }
  return Math.min(limit, 100);
}
