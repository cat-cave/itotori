import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriBranchReferenceRepository,
  branchPolicyGlossaryReferenceUpdatedEventKind,
} from "../src/repositories/branch-reference-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  branchPolicyGlossaryReferences,
  events,
  findings,
  glossaryReviewItemStateValues,
  localeBranchUnits,
  sourceRevisions,
  styleGuideVersionStatusValues,
  terminologyAliasKindValues,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflictStatusValues,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
  terminologyTermStatusValues,
  terminologyTerms,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

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
      ).resolves.toEqual([
        expect.objectContaining({ conflictId: conflictResult.conflict?.conflictId }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("serializes concurrent preferred translation upserts and reconciles conflicts after write", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);

      const results = await Promise.all([
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-sage",
          sourceTerm: "賢者",
          preferredTranslation: "Sage",
          termKind: terminologyTermKindValues.characterName,
        }),
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-wise-one",
          sourceTerm: "賢者",
          preferredTranslation: "Wise One",
          termKind: terminologyTermKindValues.characterName,
        }),
      ]);

      expect(results.some((result) => result.conflict !== null)).toBe(true);
      const conflicts = await repository.listConflicts(localActor, {
        localeBranchId: "locale-en-us",
        status: terminologyConflictStatusValues.open,
      });
      expect(conflicts).toEqual([
        expect.objectContaining({
          normalizedSourceTerm: "賢者",
          metadata: expect.objectContaining({
            translations: expect.arrayContaining(["Sage", "Wise One"]),
          }),
        }),
      ]);

      const termRows = await context.db
        .select({ termId: terminologyTerms.termId, status: terminologyTerms.status })
        .from(terminologyTerms)
        .where(eq(terminologyTerms.normalizedSourceTerm, "賢者"))
        .orderBy(terminologyTerms.termId);
      expect(termRows).toEqual([
        { termId: "term-sage", status: "conflicted" },
        { termId: "term-wise-one", status: "conflicted" },
      ]);

      const evidenceCount = await context.db.execute(sql`
        select count(*)::int as count
        from ${terminologyConflictEvidence}
        where conflict_id = ${conflicts[0]?.conflictId}
      `);
      expect(evidenceCount.rows[0]).toMatchObject({ count: 2 });
    } finally {
      await context.close();
    }
  });

  it("rejects source references from another project or source bundle", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.reset(localActor);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await projectRepository.importSourceBundle(localActor, otherProjectFixture());
      const repository = new ItotoriTerminologyRepository(context.db);

      await expect(
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-cross-revision",
          sourceTerm: "異界",
          preferredTranslation: "Otherworld",
          sourceReferences: [
            {
              sourceRevisionId: "bridge-terminology-other:unit:bridge-unit-other",
              referenceKind: terminologySourceReferenceKindValues.sourceUnit,
              citation: "other.scene.001.line.001",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "terminology.source_reference.source_revision_mismatch",
      });

      await expect(
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-cross-unit",
          sourceTerm: "門",
          preferredTranslation: "Gate",
          sourceReferences: [
            {
              bridgeUnitId: "bridge-unit-other",
              referenceKind: terminologySourceReferenceKindValues.sourceUnit,
              citation: "other.scene.001.line.001",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "terminology.source_reference.bridge_unit_mismatch",
      });
    } finally {
      await context.close();
    }
  });

  it("rejects unscoped or cross-project source provenance references", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.reset(localActor);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await projectRepository.importSourceBundle(localActor, otherProjectFixture());
      await context.db.insert(catalogSourceProvenance).values([
        {
          sourceProvenanceId: "provenance-unscoped",
          catalogSource: catalogSourceValues.manual,
          sourceRecordKind: catalogSourceRecordKindValues.manualAssertion,
          sourceId: "manual-unscoped",
          ok: true,
          fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          sourceProvenanceId: "provenance-other-project",
          catalogSource: catalogSourceValues.manual,
          sourceRecordKind: catalogSourceRecordKindValues.manualAssertion,
          sourceId: "manual-other-project",
          ok: true,
          fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: {
            projectId: "project-terminology-other",
            localeBranchId: "locale-en-us-other",
            sourceBundleId: "bridge-terminology-other",
          },
        },
        {
          sourceProvenanceId: "provenance-project-source",
          catalogSource: catalogSourceValues.manual,
          sourceRecordKind: catalogSourceRecordKindValues.manualAssertion,
          sourceId: "manual-project-source",
          ok: true,
          fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: {
            projectId: "project-terminology",
            localeBranchId: "locale-en-us",
            sourceBundleId: "bridge-terminology",
          },
        },
      ]);
      const repository = new ItotoriTerminologyRepository(context.db);

      await expect(
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-unscoped-provenance",
          sourceTerm: "出所",
          preferredTranslation: "Origin",
          sourceReferences: [
            {
              sourceProvenanceId: "provenance-unscoped",
              referenceKind: terminologySourceReferenceKindValues.catalog,
              citation: "manual-unscoped",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "terminology.source_reference.source_provenance_mismatch",
      });

      await expect(
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-cross-provenance",
          sourceTerm: "外部",
          preferredTranslation: "External",
          sourceReferences: [
            {
              sourceProvenanceId: "provenance-other-project",
              referenceKind: terminologySourceReferenceKindValues.catalog,
              citation: "manual-other-project",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "terminology.source_reference.source_provenance_mismatch",
      });

      const result = await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-scoped-provenance",
        sourceTerm: "証跡",
        preferredTranslation: "Evidence",
        sourceReferences: [
          {
            sourceProvenanceId: "provenance-project-source",
            referenceKind: terminologySourceReferenceKindValues.catalog,
            citation: "manual-project-source",
          },
        ],
      });

      expect(result.term.sourceReferences).toEqual([
        expect.objectContaining({
          sourceProvenanceId: "provenance-project-source",
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("derives lexical readiness metadata instead of trusting caller metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);

      const result = await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-spoofed-readiness",
        sourceTerm: "偽装",
        preferredTranslation: "Spoof",
        semanticIndex: {
          metadata: {
            semanticReady: true,
            vectorReady: true,
          },
        },
      });

      expect(result.term.semanticIndex).toMatchObject({
        embeddingProvider: "itotori-lexical",
        embeddingModel: "terminology-lexical-token-index-v1",
        embeddingDimension: 0,
        embeddingVector: null,
        status: terminologySemanticIndexStatusValues.indexedLexical,
        metadata: expect.objectContaining({
          semanticReady: false,
          vectorReady: false,
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("rejects spoofed ready semantic indexes and accepts coherent vector readiness", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);

      await expect(
        repository.upsertTerm(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          termId: "term-fake-ready",
          sourceTerm: "準備",
          preferredTranslation: "Ready",
          semanticIndex: {
            status: terminologySemanticIndexStatusValues.ready,
            metadata: {
              semanticReady: true,
              vectorReady: true,
            },
          },
        }),
      ).rejects.toThrow(/ready requires a non-lexical provider\/model/u);

      const result = await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-real-ready",
        sourceTerm: "意味",
        preferredTranslation: "Meaning",
        semanticIndex: {
          embeddingProvider: "itotori-semantic-test",
          embeddingModel: "semantic-model-v1",
          embeddingDimension: 3,
          embeddingVector: [0.1, 0.2, 0.3],
          status: terminologySemanticIndexStatusValues.ready,
          metadata: {
            semanticReady: false,
            vectorReady: false,
          },
        },
      });

      expect(result.term.semanticIndex).toMatchObject({
        embeddingProvider: "itotori-semantic-test",
        embeddingModel: "semantic-model-v1",
        embeddingDimension: 3,
        embeddingVector: [0.1, 0.2, 0.3],
        status: terminologySemanticIndexStatusValues.ready,
        metadata: expect.objectContaining({
          indexKind: "semantic_vector_index",
          semanticReady: true,
          vectorReady: true,
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("reads glossary context with style guide, provenance, protected spans, and review items", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      await seedApprovedGlossaryPolicy(context.db);
      const repository = new ItotoriTerminologyRepository(context.db);
      await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-context-crimson-moon",
        sourceTerm: "紅月",
        preferredTranslation: "Crimson Moon",
        sourceReferences: [
          {
            sourceRefId: "source-ref-context-crimson-moon",
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            referenceKind: terminologySourceReferenceKindValues.sourceUnit,
            citation: "terminology.scene.001.line.001",
            context: "Policy fixture includes a protected placeholder near the term.",
          },
        ],
      });

      const reviewItem = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-context-crimson-moon",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "紅月",
        proposedTranslation: "Crimson Moon",
        sourceReferences: [
          {
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            citation: "terminology.scene.001.line.001",
          },
        ],
        provenance: { fixture: "policy-aware-glossary" },
      });

      await expect(
        repository.getGlossaryContext(localActor, {
          localeBranchId: "locale-en-us",
          termId: "term-context-crimson-moon",
          sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        }),
      ).resolves.toMatchObject({
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        styleGuideVersionId: "style-guide-version-glossary-policy",
        term: {
          termId: "term-context-crimson-moon",
          localeBranchId: "locale-en-us",
          preferredTranslation: "Crimson Moon",
        },
        termProvenance: [
          expect.objectContaining({
            sourceRefId: "source-ref-context-crimson-moon",
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            bridgeUnitId: "bridge-unit-term",
            citation: "terminology.scene.001.line.001",
          }),
        ],
        protectedSpanReferences: [
          expect.objectContaining({
            bridgeUnitId: "bridge-unit-term",
            sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
            raw: "{player}",
            preserveMode: "exact",
          }),
        ],
        reviewItems: [
          expect.objectContaining({
            reviewItemId: reviewItem.reviewItemId,
            state: glossaryReviewItemStateValues.proposed,
            provenance: expect.objectContaining({
              fixture: "policy-aware-glossary",
              localeBranchId: "locale-en-us",
              sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
              styleGuideVersionId: "style-guide-version-glossary-policy",
            }),
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("persists proposed, approved, rejected, conflict, and stale-source review states with stable ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      await seedApprovedGlossaryPolicy(context.db);
      await context.db.insert(sourceRevisions).values({
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-stale",
        projectId: "project-terminology",
        revisionKind: "content_hash",
        value: "stale-source-hash",
      });
      const repository = new ItotoriTerminologyRepository(context.db);
      await repository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-approved-hero",
        sourceTerm: "勇者",
        preferredTranslation: "Hero",
        termKind: terminologyTermKindValues.characterName,
      });

      const proposed = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "紅月",
        proposedTranslation: "Crimson Moon",
      });
      const proposedAgain = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "紅月",
        proposedTranslation: "Crimson Moon",
        metadata: { reviewerQueueFixture: "same-proposal" },
      });
      const explicitlyApprovedProposal = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "紅月",
        proposedTranslation: "Crimson Moon",
        state: glossaryReviewItemStateValues.approved,
      });
      const approved = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        state: glossaryReviewItemStateValues.approved,
        sourceTerm: "司書",
        proposedTranslation: "Archivist",
      });
      const approvedDuplicate = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "司書",
        proposedTranslation: "Archivist",
      });
      const rejected = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        state: glossaryReviewItemStateValues.rejected,
        sourceTerm: "門",
        proposedTranslation: "Portal",
      });
      const rejectedDuplicate = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "門",
        proposedTranslation: "Portal",
      });
      const conflict = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        sourceTerm: "勇者",
        proposedTranslation: "Brave",
      });
      const stale = await repository.upsertGlossaryReviewItem(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-stale",
        sourceTerm: "古い名",
        proposedTranslation: "Old Name",
      });

      expect(proposedAgain.reviewItemId).toBe(proposed.reviewItemId);
      expect(explicitlyApprovedProposal.reviewItemId).toBe(proposed.reviewItemId);
      expect(approvedDuplicate.reviewItemId).toBe(approved.reviewItemId);
      expect(rejectedDuplicate.reviewItemId).toBe(rejected.reviewItemId);
      expect(proposed.reviewItemId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect([
        proposedAgain.state,
        explicitlyApprovedProposal.state,
        approved.state,
        approvedDuplicate.state,
        rejected.state,
        rejectedDuplicate.state,
        conflict.state,
        stale.state,
      ]).toEqual([
        glossaryReviewItemStateValues.proposed,
        glossaryReviewItemStateValues.approved,
        glossaryReviewItemStateValues.approved,
        glossaryReviewItemStateValues.approved,
        glossaryReviewItemStateValues.rejected,
        glossaryReviewItemStateValues.rejected,
        glossaryReviewItemStateValues.conflict,
        glossaryReviewItemStateValues.staleSource,
      ]);
      expect(conflict.semanticDiagnostics).toEqual([
        expect.objectContaining({
          code: "glossary_review.proposal.preferred_translation_conflict",
          severity: "error",
          provenance: expect.objectContaining({
            conflictingTermIds: ["term-approved-hero"],
            approvedTranslations: ["Hero"],
          }),
        }),
      ]);
      expect(stale.semanticDiagnostics).toEqual([
        expect.objectContaining({
          code: "glossary_review.source_revision.stale",
          severity: "warning",
          provenance: expect.objectContaining({
            currentSourceBundleId: "bridge-terminology",
          }),
        }),
      ]);

      await expect(
        repository.listGlossaryReviewItems(localActor, {
          localeBranchId: "locale-en-us",
          state: glossaryReviewItemStateValues.conflict,
        }),
      ).resolves.toEqual([expect.objectContaining({ reviewItemId: conflict.reviewItemId })]);

      const approvedTermRows = await context.db
        .select({ termId: terminologyTerms.termId, status: terminologyTerms.status })
        .from(terminologyTerms)
        .where(eq(terminologyTerms.termId, "term-approved-hero"));
      expect(approvedTermRows).toEqual([
        { termId: "term-approved-hero", status: terminologyTermStatusValues.active },
      ]);
    } finally {
      await context.close();
    }
  });

  it("resolves branch-scoped policy and glossary references without leaking sibling locale decisions", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.reset(localActor);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await projectRepository.importSourceBundle(localActor, siblingLocaleProjectFixture());

      const styleRepository = new ItotoriStyleGuideRepository(context.db);
      await styleRepository.createVersion(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: "style-guide-version-en-us-reference",
        status: styleGuideVersionStatusValues.approved,
        policy: {
          schemaVersion: "itotori.style-guide.policy.v1",
          sections: { tone: ["Use title case for lore terms."] },
        },
      });
      await styleRepository.createVersion(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-fr-fr",
        styleGuideVersionId: "style-guide-version-fr-fr-reference",
        status: styleGuideVersionStatusValues.approved,
        policy: {
          schemaVersion: "itotori.style-guide.policy.v1",
          sections: { tone: ["Use French sentence case."] },
        },
      });

      const terminologyRepository = new ItotoriTerminologyRepository(context.db);
      await terminologyRepository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-branch-only-crimson-moon",
        sourceTerm: "紅月",
        preferredTranslation: "Crimson Moon",
      });

      const branchReferences = new ItotoriBranchReferenceRepository(context.db);
      const previousEnReference = await branchReferences.resolveBranchPolicyGlossaryReference(
        localActor,
        {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
        },
      );
      const previousFrReference = await branchReferences.resolveBranchPolicyGlossaryReference(
        localActor,
        {
          projectId: "project-terminology",
          localeBranchId: "locale-fr-fr",
        },
      );
      const enReference = await branchReferences.updateBranchPolicyGlossaryReference(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        updateReason: "test_en_branch_reference",
      });
      const frReference = await branchReferences.updateBranchPolicyGlossaryReference(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-fr-fr",
        updateReason: "test_fr_branch_reference",
      });

      expect(enReference).toMatchObject({
        localeBranchId: "locale-en-us",
        styleGuideVersionId: "style-guide-version-en-us-reference",
        versionSequence: (previousEnReference?.versionSequence ?? 0) + 1,
        supersedesReferenceId: previousEnReference?.referenceId ?? null,
        glossaryTermRefs: [
          expect.objectContaining({
            termId: "term-branch-only-crimson-moon",
            preferredTranslation: "Crimson Moon",
          }),
        ],
      });
      expect(frReference).toMatchObject({
        localeBranchId: "locale-fr-fr",
        styleGuideVersionId: "style-guide-version-fr-fr-reference",
        versionSequence: (previousFrReference?.versionSequence ?? 0) + 1,
        supersedesReferenceId: previousFrReference?.referenceId ?? null,
        glossaryTermRefs: [],
      });
      await expect(
        branchReferences.resolveBranchPolicyGlossaryReference(localActor, {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
        }),
      ).resolves.toMatchObject({
        referenceId: enReference.referenceId,
        glossaryContentHash: enReference.glossaryContentHash,
      });

      const auditRows = await context.db
        .select()
        .from(events)
        .where(eq(events.eventKind, branchPolicyGlossaryReferenceUpdatedEventKind));
      expect(auditRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventId: enReference.eventId,
            localeBranchId: "locale-en-us",
            payload: expect.objectContaining({
              referenceId: enReference.referenceId,
              glossaryContentHash: enReference.glossaryContentHash,
            }),
          }),
          expect.objectContaining({
            eventId: frReference.eventId,
            localeBranchId: "locale-fr-fr",
            payload: expect.objectContaining({
              referenceId: frReference.referenceId,
              glossaryContentHash: frReference.glossaryContentHash,
            }),
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("audits glossary reference updates without rewriting historical draft provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.reset(localActor);
      await projectRepository.importSourceBundle(localActor, { ...projectFixture(), drafts: {} });
      const styleRepository = new ItotoriStyleGuideRepository(context.db);
      await styleRepository.createVersion(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        styleGuideVersionId: "style-guide-version-draft-reference",
        status: styleGuideVersionStatusValues.approved,
        policy: {
          schemaVersion: "itotori.style-guide.policy.v1",
          sections: { terminology: ["Prefer established glossary translations."] },
        },
      });

      const terminologyRepository = new ItotoriTerminologyRepository(context.db);
      await terminologyRepository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-draft-crimson-moon",
        sourceTerm: "紅月",
        preferredTranslation: "Crimson Moon",
      });

      await projectRepository.saveDrafts(localActor, projectFixture());

      const draftRowsBefore = await context.db
        .select({
          bridgeUnitId: localeBranchUnits.bridgeUnitId,
          styleGuideVersionId: localeBranchUnits.styleGuideVersionId,
          glossaryReferenceId: localeBranchUnits.glossaryReferenceId,
        })
        .from(localeBranchUnits)
        .where(eq(localeBranchUnits.localeBranchId, "locale-en-us"));
      const draftProvenanceBefore = draftRowsBefore.find(
        (row) => row.bridgeUnitId === "bridge-unit-term",
      );
      expect(draftProvenanceBefore).toMatchObject({
        styleGuideVersionId: "style-guide-version-draft-reference",
        glossaryReferenceId: expect.any(String),
      });

      await terminologyRepository.upsertTerm(localActor, {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        termId: "term-draft-archivist",
        sourceTerm: "司書",
        preferredTranslation: "Archivist",
      });
      const branchReferences = new ItotoriBranchReferenceRepository(context.db);
      const updatedReference = await branchReferences.updateBranchPolicyGlossaryReference(
        localActor,
        {
          projectId: "project-terminology",
          localeBranchId: "locale-en-us",
          updateReason: "test_glossary_term_added",
        },
      );

      expect(updatedReference).toMatchObject({
        versionSequence: 2,
        supersedesReferenceId: draftProvenanceBefore?.glossaryReferenceId,
        glossaryTermRefs: expect.arrayContaining([
          expect.objectContaining({ termId: "term-draft-archivist" }),
        ]),
      });

      const draftRowsAfter = await context.db
        .select({
          bridgeUnitId: localeBranchUnits.bridgeUnitId,
          styleGuideVersionId: localeBranchUnits.styleGuideVersionId,
          glossaryReferenceId: localeBranchUnits.glossaryReferenceId,
        })
        .from(localeBranchUnits)
        .where(eq(localeBranchUnits.localeBranchId, "locale-en-us"));
      expect(draftRowsAfter.find((row) => row.bridgeUnitId === "bridge-unit-term")).toEqual(
        draftProvenanceBefore,
      );

      const referenceRows = await context.db
        .select()
        .from(branchPolicyGlossaryReferences)
        .where(eq(branchPolicyGlossaryReferences.localeBranchId, "locale-en-us"))
        .orderBy(branchPolicyGlossaryReferences.versionSequence);
      expect(referenceRows.map((row) => row.referenceId)).toEqual([
        draftProvenanceBefore?.glossaryReferenceId,
        updatedReference.referenceId,
      ]);
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
          sourceText: "紅月{player}が昇る。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
          ],
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

function siblingLocaleProjectFixture(): ItotoriProjectRecord {
  return {
    ...projectFixture(),
    localeBranchId: "locale-fr-fr",
    targetLocale: "fr-FR",
    drafts: {
      "bridge-unit-term": "La lune cramoisie se leve.",
    },
  };
}

function otherProjectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-terminology-other",
    localeBranchId: "locale-en-us-other",
    targetLocale: "en-US",
    drafts: {
      "bridge-unit-other": "The other gate opens.",
    },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-terminology-other",
      sourceBundleHash: "hash-terminology-other",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-other",
          sourceUnitKey: "other.scene.001.line.001",
          occurrenceId: "occurrence-other-1",
          sourceHash: "source-hash-other",
          sourceLocale: "ja-JP",
          sourceText: "門が開く。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "other-source.json",
            writeMode: "replace",
            sourceUnitKey: "other.scene.001.line.001",
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

async function seedApprovedGlossaryPolicy(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriStyleGuideRepository(db);
  await repo.createVersion(localActor, {
    projectId: "project-terminology",
    localeBranchId: "locale-en-us",
    styleGuideVersionId: "style-guide-version-glossary-policy",
    status: styleGuideVersionStatusValues.approved,
    policy: {
      schemaVersion: "itotori.style-guide.policy.v1",
      sections: {
        terminology: [
          {
            termId: "term-context-crimson-moon",
            sourceTerm: "紅月",
            preferredTranslation: "Crimson Moon",
            provenance: {
              sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
              citation: "terminology.scene.001.line.001",
            },
          },
        ],
        protectedSpans: [
          {
            bridgeUnitId: "bridge-unit-term",
            raw: "{player}",
            preserveMode: "exact",
          },
        ],
      },
    },
    semanticDiagnostics: [
      {
        code: "glossary_policy.fixture.ready",
        severity: "info",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
      },
    ],
  });
}
