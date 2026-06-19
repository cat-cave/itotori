import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  findings,
  terminologyAliasKindValues,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflictStatusValues,
  terminologySemanticIndex,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
  terminologyTerms,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriTerminologyRepository", () => {
  it("persists locale-branch scoped preferred terms with aliases, citations, and semantic hooks", async () => {
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
            bridgeUnitId: "bridge-unit-term",
            referenceKind: terminologySourceReferenceKindValues.sourceUnit,
          }),
        ],
        semanticIndex: expect.objectContaining({
          embeddingProvider: "itotori-offline",
          embeddingModel: "terminology-token-overlap-v1",
          embeddingDimension: 0,
          embeddingVector: null,
          status: "ready",
          metadata: expect.objectContaining({ hookKind: "token_overlap", pgvectorReady: true }),
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

  it("searches exact terms, aliases, and semantic hook tokens deterministically", async () => {
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
            matchKinds: expect.arrayContaining(["alias", "semantic_hook"]),
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
            matchKinds: ["semantic_hook"],
            score: 20,
            term: { termId: "term-hero" },
          },
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("records preferred translation conflicts as glossary conflicts and open terminology findings", async () => {
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
      });

      const conflictResult = await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-brave",
        sourceTerm: "勇者",
        preferredTranslation: "Brave",
        termKind: terminologyTermKindValues.characterName,
      });

      expect(conflictResult.conflict).toMatchObject({
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        normalizedSourceTerm: "勇者",
        conflictKind: terminologyConflictKindValues.preferredTranslation,
        status: terminologyConflictStatusValues.open,
        summary: expect.stringContaining("Hero"),
        metadata: expect.objectContaining({
          reasonCode: "preferred_translation_conflict",
          translations: expect.arrayContaining(["Hero", "Brave"]),
        }),
      });

      const termRows = await context.db
        .select({ termId: terminologyTerms.termId, status: terminologyTerms.status })
        .from(terminologyTerms)
        .where(eq(terminologyTerms.normalizedSourceTerm, "勇者"))
        .orderBy(terminologyTerms.termId);
      expect(termRows).toEqual([
        { termId: "term-brave", status: "conflicted" },
        { termId: "term-hero", status: "conflicted" },
      ]);

      const findingRows = await context.db
        .select()
        .from(findings)
        .where(eq(findings.findingId, conflictResult.conflict?.findingId ?? ""));
      expect(findingRows).toEqual([
        expect.objectContaining({
          findingKind: "terminology_conflict",
          qualityCategory: "terminology",
          status: "open",
          title: "Glossary preferred translation conflict",
        }),
      ]);

      const evidenceCount = await context.db.execute(sql`
        select count(*)::int as count
        from ${terminologyConflictEvidence}
        where conflict_id = ${conflictResult.conflict?.conflictId}
      `);
      expect(evidenceCount.rows[0]).toMatchObject({ count: 2 });

      await expect(
        repository.listConflicts(localActor, {
          localeBranchId: "locale-en-us",
          status: terminologyConflictStatusValues.open,
        }),
      ).resolves.toEqual([expect.objectContaining({ conflictId: conflictResult.conflict?.conflictId })]);
    } finally {
      await context.close();
    }
  });
});

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-terminology",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {
      "bridge-unit-term": "The Crimson Moon rises.",
    },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-terminology",
      sourceBundleHash: "hash-terminology",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-term",
          sourceUnitKey: "terminology.scene.001.line.001",
          occurrenceId: "occurrence-term-1",
          sourceHash: "source-hash-term",
          sourceLocale: "ja-JP",
          sourceText: "紅月が昇る。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "terminology.scene.001.line.001",
          },
        },
      ],
    },
  };
}

async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}
