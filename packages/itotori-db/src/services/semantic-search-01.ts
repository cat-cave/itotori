import { type TerminologySearchMatchKind } from "../repositories/terminology-repository.js";
import {
  exactSearchToolName,
  exactSearchToolVersion,
} from "../repositories/exact-search-document-repository.js";

import { normalizeSemanticSearchText, semanticSearchTextHash } from "./semantic-search-03.js";
import { assertEmbeddingVector } from "./semantic-search-04.js";

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

export type RecordedEmbeddingFixtureMetadata = {
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

export type LocaleBranchSearchContext =
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
