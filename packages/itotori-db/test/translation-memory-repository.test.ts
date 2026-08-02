import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  lexicalSimilarityScore,
  TranslationMemorySourceScopeError,
} from "../src/repositories/translation-memory-repository.js";
import {
  localeBranchUnits,
  translationMemorySegments,
  translationMemoryMatchKindValues,
  translationMemoryReuseStatusValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import { currentProjectFixture } from "./current-project-fixture.js";

const localActor: AuthorizationActor = { userId: localUserId };
const translationMemoryProject = currentProjectFixture({
  seed: "translation-memory",
  projectId: "project-tm",
  localeBranchId: "locale-en-us",
  units: [
    {
      sourceUnitKey: "scene.001.memory-a",
      sourceText: "おはようございます、先輩。",
      targetText: "Good morning, senpai.",
    },
    {
      sourceUnitKey: "scene.002.memory-b",
      sourceText: "おはようございます、先輩。",
      targetText: "Morning, senpai.",
    },
    {
      sourceUnitKey: "scene.010.target",
      sourceText: "おはようございます、先輩。",
    },
    {
      sourceUnitKey: "scene.020.fuzzy-source",
      sourceText: "おかえりなさい、ご主人様。",
      targetText: "Welcome back, master.",
    },
    { sourceUnitKey: "scene.021.fuzzy-target", sourceText: "おかえりなさいご主人様！" },
  ],
});
const [memoryA, memoryB, targetExact, fuzzySource, fuzzyTarget] =
  translationMemoryProject.bridge.units;
if (
  memoryA === undefined ||
  memoryB === undefined ||
  targetExact === undefined ||
  fuzzySource === undefined ||
  fuzzyTarget === undefined
) {
  throw new Error("translation memory fixture requires five current bridge units");
}

describe("ItotoriTranslationMemoryRepository", () => {
  it("reuses repeated exact lines in locale-branch scope and records applied provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedTranslationMemoryProject(context.db);
      const repository = new ItotoriTranslationMemoryRepository(context.db);
      const service = new ItotoriTranslationMemoryService(repository);

      expect(new Set([memoryA.sourceHash, memoryB.sourceHash, targetExact.sourceHash]).size).toBe(
        3,
      );

      await repository.upsertSegment(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        sourceBridgeUnitId: memoryA.bridgeUnitId,
        memorySegmentId: "tm-memory-a",
        targetText: "Good morning, senpai.",
        expectedSourceHash: memoryA.sourceHash,
        expectedTargetLocale: "en-US",
        provenance: { source: "approved_draft", reviewer: "fixture" },
      });
      await repository.upsertSegment(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        sourceBridgeUnitId: memoryB.bridgeUnitId,
        memorySegmentId: "tm-memory-b",
        targetText: "Morning, senpai.",
        expectedSourceHash: memoryB.sourceHash,
        expectedTargetLocale: "en-US",
        provenance: { source: "approved_draft", reviewer: "fixture" },
      });

      const matchSet = await repository.findReusableSegments({
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "en-US",
        targetBridgeUnitId: targetExact.bridgeUnitId,
        includeFuzzy: true,
        candidateLimit: 5,
      });
      expect(matchSet?.matches.map((match) => match.memorySegmentId)).toEqual([
        "tm-memory-a",
        "tm-memory-b",
      ]);
      expect(matchSet?.matches.map((match) => match.matchScore)).toEqual([1000, 1000]);

      const result = await service.prefillDrafts(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "en-US",
        bridgeUnitIds: [targetExact.bridgeUnitId],
        requestId: "prefill-exact",
      });
      expect(result).toMatchObject({
        status: "completed",
        appliedCount: 1,
        suggestedCount: 0,
        skippedCount: 0,
      });
      expect(result.reuses[0]?.match).toMatchObject({
        memorySegmentId: "tm-memory-a",
        matchKind: translationMemoryMatchKindValues.exact,
        matchScore: 1000,
      });

      await expect(targetText(context.db, "locale-en-us", targetExact.bridgeUnitId)).resolves.toBe(
        "Good morning, senpai.",
      );
      const events = await repository.listReuseEvents({
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        targetBridgeUnitId: targetExact.bridgeUnitId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        memorySegmentId: "tm-memory-a",
        matchKind: translationMemoryMatchKindValues.exact,
        reuseStatus: translationMemoryReuseStatusValues.applied,
        sourceHash: targetExact.sourceHash,
        candidateSourceHash: memoryA.sourceHash,
        targetText: "Good morning, senpai.",
        costImpact: {
          providerCallAvoided: true,
          calculation: "deterministic_character_estimate_v1",
        },
      });
      expect(events[0]?.provenance).toMatchObject({
        requestId: "prefill-exact",
        selectedMemorySegmentId: "tm-memory-a",
        targetSourceUnitKey: "scene.010.target",
      });
    } finally {
      await context.close();
    }
  });

  it("rejects wrong-locale and stale-source reuse instead of falling back across branches", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedTranslationMemoryProject(context.db);
      await seedTranslationMemoryProject(context.db, {
        localeBranchId: "locale-fr-fr",
        targetLocale: "fr-FR",
        drafts: {},
      });
      const repository = new ItotoriTranslationMemoryRepository(context.db);
      await repository.upsertSegment(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        sourceBridgeUnitId: memoryA.bridgeUnitId,
        memorySegmentId: "tm-memory-a",
        targetText: "Good morning, senpai.",
        expectedSourceHash: memoryA.sourceHash,
      });

      await expect(
        repository.findReusableSegments({
          projectId: "project-tm",
          localeBranchId: "locale-fr-fr",
          requestedTargetLocale: "fr-FR",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          candidateLimit: 5,
        }),
      ).resolves.toMatchObject({ matches: [] });
      await expect(
        repository.recordReuse(localActor, {
          projectId: "project-tm",
          localeBranchId: "locale-fr-fr",
          requestedTargetLocale: "fr-FR",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          memorySegmentId: "tm-memory-a",
          matchKind: translationMemoryMatchKindValues.exact,
          matchScore: 1000,
          applyDraft: true,
        }),
      ).rejects.toMatchObject({
        code: "memory_segment_scope_mismatch",
      } satisfies Partial<TranslationMemorySourceScopeError>);

      await expect(
        repository.upsertSegment(localActor, {
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          sourceBridgeUnitId: memoryA.bridgeUnitId,
          memorySegmentId: "tm-stale-write",
          targetText: "Good morning, senpai.",
          expectedSourceHash: "hash:old-good-morning",
        }),
      ).rejects.toMatchObject({
        code: "stale_source_hash",
      } satisfies Partial<TranslationMemorySourceScopeError>);

      await context.db
        .update(translationMemorySegments)
        .set({ sourceRevisionId: fuzzySource.sourceRevision.revisionId })
        .where(eq(translationMemorySegments.memorySegmentId, "tm-memory-a"));

      await expect(
        repository.findReusableSegments({
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          requestedTargetLocale: "en-US",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          includeFuzzy: true,
          minFuzzyScore: 300,
        }),
      ).resolves.toMatchObject({ matches: [] });
      await expect(
        repository.recordReuse(localActor, {
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          requestedTargetLocale: "en-US",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          memorySegmentId: "tm-memory-a",
          matchKind: translationMemoryMatchKindValues.fuzzy,
          matchScore: 500,
          applyDraft: true,
        }),
      ).rejects.toMatchObject({
        code: "memory_segment_scope_mismatch",
      } satisfies Partial<TranslationMemorySourceScopeError>);
    } finally {
      await context.close();
    }
  });

  it("does not reuse same-branch memory when requested target locale differs from current branch locale", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedTranslationMemoryProject(context.db);
      const repository = new ItotoriTranslationMemoryRepository(context.db);
      const service = new ItotoriTranslationMemoryService(repository);
      await repository.upsertSegment(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        sourceBridgeUnitId: memoryA.bridgeUnitId,
        memorySegmentId: "tm-memory-a",
        targetText: "Good morning, senpai.",
        expectedSourceHash: memoryA.sourceHash,
        expectedTargetLocale: "en-US",
      });

      await expect(
        repository.findReusableSegments({
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          requestedTargetLocale: "fr-FR",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          candidateLimit: 5,
        }),
      ).resolves.toMatchObject({ matches: [] });

      const prefill = await service.prefillDrafts(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "fr-FR",
        bridgeUnitIds: [targetExact.bridgeUnitId],
        requestId: "prefill-wrong-requested-locale",
      });
      expect(prefill).toMatchObject({
        status: "completed",
        appliedCount: 0,
        suggestedCount: 0,
        skippedCount: 1,
        skipped: [expect.objectContaining({ reasonCode: "target_locale_mismatch" })],
      });
      await expect(
        targetText(context.db, "locale-en-us", targetExact.bridgeUnitId),
      ).resolves.toBeNull();
      await expect(
        repository.listReuseEvents({
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          targetBridgeUnitId: targetExact.bridgeUnitId,
        }),
      ).resolves.toHaveLength(0);
      await expect(
        repository.recordReuse(localActor, {
          projectId: "project-tm",
          localeBranchId: "locale-en-us",
          requestedTargetLocale: "fr-FR",
          targetBridgeUnitId: targetExact.bridgeUnitId,
          memorySegmentId: "tm-memory-a",
          matchKind: translationMemoryMatchKindValues.exact,
          matchScore: 1000,
          applyDraft: true,
        }),
      ).rejects.toMatchObject({
        code: "target_locale_mismatch",
      } satisfies Partial<TranslationMemorySourceScopeError>);
    } finally {
      await context.close();
    }
  });

  it("returns bounded deterministic fuzzy suggestions and can record suggestion-only cost impact", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedTranslationMemoryProject(context.db);
      const repository = new ItotoriTranslationMemoryRepository(context.db);
      const service = new ItotoriTranslationMemoryService(repository);

      await repository.upsertSegment(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        sourceBridgeUnitId: fuzzySource.bridgeUnitId,
        memorySegmentId: "tm-fuzzy-source",
        targetText: "Welcome back, master.",
        expectedSourceHash: fuzzySource.sourceHash,
      });
      expect(
        lexicalSimilarityScore("おかえりなさい、ご主人様。", "おかえりなさいご主人様！"),
      ).toBeGreaterThanOrEqual(650);

      const matchSet = await repository.findReusableSegments({
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "en-US",
        targetBridgeUnitId: fuzzyTarget.bridgeUnitId,
        includeFuzzy: true,
        minFuzzyScore: 650,
        candidateLimit: 1,
        scoredCandidateLimit: 10,
      });
      expect(matchSet?.matches).toEqual([
        expect.objectContaining({
          memorySegmentId: "tm-fuzzy-source",
          matchKind: translationMemoryMatchKindValues.fuzzy,
          targetText: "Welcome back, master.",
        }),
      ]);

      const result = await service.prefillDrafts(localActor, {
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        requestedTargetLocale: "en-US",
        bridgeUnitIds: [fuzzyTarget.bridgeUnitId],
        applyDrafts: false,
        includeFuzzy: true,
        minFuzzyScore: 650,
        requestId: "prefill-fuzzy-suggest",
      });
      expect(result).toMatchObject({
        status: "completed",
        appliedCount: 0,
        suggestedCount: 1,
        skippedCount: 0,
      });
      await expect(
        targetText(context.db, "locale-en-us", fuzzyTarget.bridgeUnitId),
      ).resolves.toBeNull();
      const events = await repository.listReuseEvents({
        projectId: "project-tm",
        localeBranchId: "locale-en-us",
        targetBridgeUnitId: fuzzyTarget.bridgeUnitId,
      });
      expect(events[0]).toMatchObject({
        reuseStatus: translationMemoryReuseStatusValues.suggested,
        matchKind: translationMemoryMatchKindValues.fuzzy,
        costImpact: {
          providerCallAvoided: false,
          calculation: "deterministic_character_estimate_v1",
        },
      });
    } finally {
      await context.close();
    }
  });
});

async function seedTranslationMemoryProject(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
  overrides: Partial<ItotoriProjectRecord> = {},
): Promise<void> {
  const repository = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repository.importSourceBundle(localActor, translationMemoryProjectFixture(overrides));
}

function translationMemoryProjectFixture(
  overrides: Partial<ItotoriProjectRecord> = {},
): ItotoriProjectRecord {
  return { ...structuredClone(translationMemoryProject), ...overrides };
}

async function targetText(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
  localeBranchId: string,
  bridgeUnitId: string,
): Promise<string | null> {
  const rows = await db
    .select({ targetText: localeBranchUnits.targetText })
    .from(localeBranchUnits)
    .where(
      and(
        eq(localeBranchUnits.localeBranchId, localeBranchId),
        eq(localeBranchUnits.bridgeUnitId, bridgeUnitId),
      ),
    )
    .limit(1);
  return rows[0]?.targetText ?? null;
}
