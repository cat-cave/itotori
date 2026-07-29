import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  ItotoriSemanticGlossarySearchService,
  RecordedEmbeddingFixtureAdapter,
  semanticGlossarySearchDiagnosticCodeValues,
} from "../src/services/semantic-search.js";
import {
  terminologyAliasKindValues,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import { seedProject } from "./terminology-repository.test.shared-01.js";

describe("ItotoriTerminologyRepository", () => {
  it("persists locale-branch scoped preferred terms with aliases, citations, and lexical indexes", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);

      const result = await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-crimson-moon",
        sourceTerm: "紅月",
        preferredTranslation: "Crimson Moon",
        termKind: terminologyTermKindValues.loreTerm,
        partOfSpeech: "proper_noun",
        notes: "Keep title case in UI labels.",
        aliases: [
          {
            aliasId: "alias-red-moon",
            aliasText: "赤い月",
            aliasKind: terminologyAliasKindValues.sourceAlias,
            locale: "ja-JP",
          },
          {
            aliasId: "alias-blood-moon",
            aliasText: "Blood Moon",
            aliasKind: terminologyAliasKindValues.disallowedTranslation,
            locale: "en-US",
          },
        ],
        sourceReferences: [
          {
            sourceRefId: "source-ref-crimson-moon",
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            referenceKind: terminologySourceReferenceKindValues.sourceUnit,
            citation: "terminology.scene.001.line.001",
            context: "Opening narration names the recurring moon motif.",
          },
        ],
      });

      expect(result.conflict).toBeNull();
      expect(result.term).toMatchObject({
        termId: "term-crimson-moon",
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        sourceTerm: "紅月",
        normalizedSourceTerm: "紅月",
        preferredTranslation: "Crimson Moon",
        normalizedPreferredTranslation: "crimson moon",
        termKind: terminologyTermKindValues.loreTerm,
        status: "active",
        aliases: expect.arrayContaining([
          expect.objectContaining({
            aliasId: "alias-red-moon",
            aliasKind: terminologyAliasKindValues.sourceAlias,
            normalizedAliasText: "赤い月",
          }),
          expect.objectContaining({
            aliasId: "alias-blood-moon",
            aliasKind: terminologyAliasKindValues.disallowedTranslation,
            normalizedAliasText: "blood moon",
          }),
        ]),
        sourceReferences: [
          expect.objectContaining({
            sourceRefId: "source-ref-crimson-moon",
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            referenceKind: terminologySourceReferenceKindValues.sourceUnit,
          }),
        ],
        semanticIndex: expect.objectContaining({
          embeddingProvider: "itotori-lexical",
          embeddingModel: "terminology-lexical-token-index-v1",
          embeddingDimension: 0,
          embeddingVector: null,
          status: terminologySemanticIndexStatusValues.indexedLexical,
          metadata: expect.objectContaining({
            hookKind: "lexical_token_index",
            indexKind: "lexical_token_index",
            semanticReady: false,
            vectorReady: false,
          }),
        }),
      });

      const persistedSemanticRows = await context.db
        .select()
        .from(terminologySemanticIndex)
        .where(eq(terminologySemanticIndex.termId, "term-crimson-moon"));
      expect(persistedSemanticRows).toHaveLength(1);
      expect(persistedSemanticRows[0]?.searchTokens).toEqual(
        expect.arrayContaining(["crimson", "moon", "blood"]),
      );
    } finally {
      await context.close();
    }
  });

  it("searches exact terms, aliases, and lexical hook tokens deterministically", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);
      await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-hero",
        sourceTerm: "勇者",
        preferredTranslation: "Hero",
        termKind: terminologyTermKindValues.characterName,
        aliases: [
          {
            aliasText: "Brave One",
            aliasKind: terminologyAliasKindValues.targetAlias,
            locale: "en-US",
          },
        ],
        semanticIndex: {
          searchDocument: "Hero Brave One protagonist chosen by the relic",
        },
      });

      await expect(
        repository.searchTerms(localActor, {
          localeBranchId: "locale-en-us",
          query: "勇者",
        }),
      ).resolves.toMatchObject({
        results: [
          {
            matchKinds: ["exact_source"],
            score: 100,
            term: { termId: "term-hero" },
          },
        ],
      });

      await expect(
        repository.searchTerms(localActor, {
          localeBranchId: "locale-en-us",
          query: "Brave One",
        }),
      ).resolves.toMatchObject({
        results: [
          {
            matchKinds: expect.arrayContaining(["alias", "lexical_hook"]),
            term: { termId: "term-hero" },
          },
        ],
      });

      await expect(
        repository.searchTerms(localActor, {
          localeBranchId: "locale-en-us",
          query: "relic protagonist",
        }),
      ).resolves.toMatchObject({
        results: [
          {
            matchKinds: ["lexical_hook"],
            score: 20,
            term: { termId: "term-hero" },
          },
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("runs provider-free recorded semantic glossary search with exact fallback behavior", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const terminology = new ItotoriTerminologyRepository(context.db);
      await terminology.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-semantic-hero",
        sourceTerm: "勇者",
        preferredTranslation: "Hero",
        termKind: terminologyTermKindValues.characterName,
        sourceReferences: [
          {
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            referenceKind: terminologySourceReferenceKindValues.sourceUnit,
            citation: "terminology.scene.001.line.001",
          },
        ],
        semanticIndex: {
          searchDocument: "Hero protagonist chosen champion relic",
          embeddingProvider: "itotori-recorded-fixture",
          embeddingModel: "semantic-fixture-v1",
          embeddingDimension: 2,
          embeddingVector: [0.99, 0.01],
          status: terminologySemanticIndexStatusValues.ready,
        },
      });
      await terminology.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-semantic-gate",
        sourceTerm: "門",
        preferredTranslation: "Gate",
        termKind: terminologyTermKindValues.general,
        semanticIndex: {
          searchDocument: "Gate threshold portal village",
          embeddingProvider: "itotori-recorded-fixture",
          embeddingModel: "semantic-fixture-v1",
          embeddingDimension: 2,
          embeddingVector: [0.2, 0.8],
          status: terminologySemanticIndexStatusValues.ready,
        },
      });
      await terminology.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-semantic-stale",
        sourceTerm: "古い語",
        preferredTranslation: "Old Term",
        termKind: terminologyTermKindValues.general,
        semanticIndex: {
          searchDocument: "Old stale champion term",
          embeddingProvider: "itotori-recorded-fixture",
          embeddingModel: "semantic-fixture-v1",
          embeddingDimension: 2,
          embeddingVector: [1, 0],
          status: terminologySemanticIndexStatusValues.stale,
        },
      });

      const service = new ItotoriSemanticGlossarySearchService(
        context.db,
        new RecordedEmbeddingFixtureAdapter({
          fixtureId: "semantic-glossary-fixture-v1",
          provider: "recorded-fixture",
          model: "semantic-fixture-v1",
          dimension: 2,
          vectors: [
            { text: "chosen champion", embedding: [1, 0] },
            { text: "unmatched semantic", embedding: [0, 1] },
            { text: "古い語", embedding: [1, 0] },
          ],
        }),
      );

      const ranked = await service.searchGlossary(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:bundle-revision",
        query: "chosen champion",
        limit: 2,
        minScore: 0.1,
      });
      expect(ranked).toMatchObject({
        status: "completed",
        readiness: {
          embeddingMode: "recorded_fixture",
          liveProviderRequired: false,
          fixtureId: "semantic-glossary-fixture-v1",
          pgvector: {
            required: false,
            available: false,
            reason: "public_ci_uses_recorded_json_vectors",
          },
          exactFallback: { triggered: false, reason: null },
        },
        diagnostics: [
          expect.objectContaining({
            code: semanticGlossarySearchDiagnosticCodeValues.staleSemanticIndex,
          }),
        ],
      });
      expect(ranked.matches.map((match) => match.term.termId)).toEqual([
        "term-semantic-hero",
        "term-semantic-gate",
      ]);
      expect(ranked.matches[0]).toMatchObject({
        matchKinds: ["semantic_vector"],
        provenance: expect.objectContaining({
          provenanceKind: "semantic_glossary_search_result",
          fixtureId: "semantic-glossary-fixture-v1",
          semanticIndexId: expect.any(String),
          citations: [
            expect.objectContaining({
              citation: "terminology.scene.001.line.001",
              bridgeUnitId: "bridge-unit-term",
            }),
          ],
        }),
      });

      await expect(
        service.searchGlossary(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          query: "勇者",
        }),
      ).resolves.toMatchObject({
        readiness: {
          exactFallback: { triggered: true, reason: "missing_recorded_embedding" },
        },
        matches: [
          expect.objectContaining({
            term: expect.objectContaining({ termId: "term-semantic-hero" }),
            matchKinds: ["exact_fallback"],
            exactMatchKinds: ["exact_source"],
          }),
        ],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: semanticGlossarySearchDiagnosticCodeValues.exactFallbackUsed,
          }),
        ]),
      });

      await expect(
        service.searchGlossary(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          query: "古い語",
          minScore: 1,
        }),
      ).resolves.toMatchObject({
        readiness: {
          exactFallback: { triggered: true, reason: "stale_semantic_index" },
        },
        matches: [
          expect.objectContaining({
            term: expect.objectContaining({ termId: "term-semantic-stale" }),
            matchKinds: ["exact_fallback"],
          }),
        ],
      });

      await expect(
        service.searchGlossary(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          query: "unmatched semantic",
          minScore: 0.99,
        }),
      ).resolves.toMatchObject({
        readiness: {
          exactFallback: { triggered: true, reason: "no_semantic_results" },
        },
        matches: [],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: semanticGlossarySearchDiagnosticCodeValues.noSemanticResults,
          }),
        ]),
      });
    } finally {
      await context.close();
    }
  });

  it("ranks equal-score and equal-sourceTerm semantic matches deterministically by term id", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const terminology = new ItotoriTerminologyRepository(context.db);
      // Two distinct terms with the SAME sourceTerm and SAME embedding vector.
      // Both produce an identical cosine score, so the only stable final
      // tie-breaker is the term id (ascending).
      const equalTermOptions = {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceTerm: "剣",
        termKind: terminologyTermKindValues.general,
        semanticIndex: {
          searchDocument: "Sword blade edge weapon",
          embeddingProvider: "itotori-recorded-fixture",
          embeddingModel: "semantic-fixture-v1",
          embeddingDimension: 2,
          embeddingVector: [1, 0],
          status: terminologySemanticIndexStatusValues.ready,
        },
      } as const;
      await terminology.upsertTerm(localActor, {
        ...equalTermOptions,
        termId: "term-tie-bravo",
        preferredTranslation: "Sword Bravo",
      });
      await terminology.upsertTerm(localActor, {
        ...equalTermOptions,
        termId: "term-tie-alpha",
        preferredTranslation: "Sword Alpha",
      });

      const service = new ItotoriSemanticGlossarySearchService(
        context.db,
        new RecordedEmbeddingFixtureAdapter({
          fixtureId: "semantic-glossary-fixture-v1",
          provider: "recorded-fixture",
          model: "semantic-fixture-v1",
          dimension: 2,
          vectors: [{ text: "Sword blade edge weapon", embedding: [1, 0] }],
        }),
      );

      const expectedOrder = ["term-tie-alpha", "term-tie-bravo"];
      const firstRun = await service.searchGlossary(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        query: "Sword blade edge weapon",
        minScore: 0.1,
        limit: 10,
      });
      expect(firstRun.matches).toHaveLength(2);
      expect(firstRun.matches[0]?.score).toBe(firstRun.matches[1]?.score);
      expect(firstRun.matches[0]?.term.sourceTerm).toBe(firstRun.matches[1]?.term.sourceTerm);
      expect(firstRun.matches.map((match) => match.term.termId)).toEqual(expectedOrder);

      // Re-running the search on the same input yields the identical order.
      const secondRun = await service.searchGlossary(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        query: "Sword blade edge weapon",
        minScore: 0.1,
        limit: 10,
      });
      expect(secondRun.matches.map((match) => match.term.termId)).toEqual(expectedOrder);
    } finally {
      await context.close();
    }
  });
});
