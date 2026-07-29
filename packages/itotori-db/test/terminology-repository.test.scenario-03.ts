import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
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
  ItotoriSemanticGlossarySearchService,
  RecordedEmbeddingFixtureAdapter,
  semanticGlossarySearchDiagnosticCodeValues,
} from "../src/services/semantic-search.js";
import {
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  branchPolicyGlossaryReferences,
  events,
  findings,
  localeBranchUnits,
  styleGuideVersionStatusValues,
  terminologyAliasKindValues,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflictStatusValues,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
  terminologyTerms,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import {
  projectFixture,
  siblingLocaleProjectFixture,
  otherProjectFixture,
  seedProject,
  seedApprovedGlossaryPolicy,
} from "./terminology-repository.test.shared-01.js";

describe("ItotoriTerminologyRepository", () => {
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

  it("reads glossary context with style guide, provenance, and protected spans", async () => {
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
      });
    } finally {
      await context.close();
    }
  });

  it("resolves branch-scoped policy and glossary references without leaking sibling locale decisions", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
