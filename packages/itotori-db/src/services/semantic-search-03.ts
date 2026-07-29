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
  type RecordedEmbeddingFixtureMetadata,
  type RecordedEmbeddingMatch,
  type SemanticGlossarySearchMatch,
  type SemanticGlossarySearchReadiness,
  type SemanticGlossarySearchTermSummary,
  semanticGlossarySearchToolName,
  semanticGlossarySearchToolVersion,
} from "./semantic-search-01.js";

export type SemanticCandidate = {
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

export function semanticMatch(
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

export function exactFallbackMatch(match: TerminologySearchResult): SemanticGlossarySearchMatch {
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

export function termSummary(candidate: SemanticCandidate): SemanticGlossarySearchTermSummary {
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

export function compareSemanticMatches(
  left: SemanticGlossarySearchMatch,
  right: SemanticGlossarySearchMatch,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const sourceTermComparison = left.term.sourceTerm.localeCompare(right.term.sourceTerm);
  if (sourceTermComparison !== 0) {
    return sourceTermComparison;
  }
  return left.term.termId.localeCompare(right.term.termId);
}

export function hasStrongExactMatch(match: TerminologySearchResult): boolean {
  return match.matchKinds.some(
    (kind) => kind === "exact_source" || kind === "exact_translation" || kind === "alias",
  );
}

export function mergeSearchMatches(
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

export function cosineSimilarity(left: number[], right: number[]): number {
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

export function baseReadiness(
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
