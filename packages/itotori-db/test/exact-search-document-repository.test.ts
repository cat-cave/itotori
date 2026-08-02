import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriExactSearchDocumentRepository,
  exactSearchDiagnosticCodeValues,
  exactSearchToolName,
  exactSearchToolVersion,
} from "../src/repositories/exact-search-document-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { exactSearchDocuments } from "../src/schema.js";
import { currentProjectFixture } from "./current-project-fixture.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const exactSearchProject = currentProjectFixture({
  seed: "exact-search-primary",
  projectId: "project-search",
  localeBranchId: "locale-en-us",
  units: [
    {
      sourceUnitKey: "scene.001.hero",
      occurrenceId: "occurrence-hero",
      sourceText: "Hero",
    },
    {
      sourceUnitKey: "scene.002.heroine",
      occurrenceId: "occurrence-heroine",
      sourceText: "Heroine",
    },
    {
      sourceUnitKey: "scene.003.hero-arrives",
      occurrenceId: "occurrence-hero-arrives",
      sourceText: "Hero arrives",
    },
  ],
});
const exactSearchUpdatedProject = currentProjectFixture({
  seed: "exact-search-updated",
  projectId: "project-search",
  localeBranchId: "locale-en-us",
  units: [
    {
      sourceUnitKey: "scene.001.hero",
      occurrenceId: "occurrence-hero",
      sourceText: "Champion",
    },
    {
      sourceUnitKey: "scene.002.sidekick",
      occurrenceId: "occurrence-sidekick",
      sourceText: "Sidekick",
    },
  ],
});
const [heroUnit, heroineUnit, heroArrivesUnit] = exactSearchProject.bridge.units;
const [championUnit, sidekickUnit] = exactSearchUpdatedProject.bridge.units;
if (
  heroUnit === undefined ||
  heroineUnit === undefined ||
  heroArrivesUnit === undefined ||
  championUnit === undefined ||
  sidekickUnit === undefined
) {
  throw new Error("exact-search fixtures require three primary and two updated units");
}
const exactSearchRevisionId = exactSearchProject.bridge.sourceBundleRevision.revisionId;
const exactSearchUpdatedRevisionId =
  exactSearchUpdatedProject.bridge.sourceBundleRevision.revisionId;

describe("ItotoriExactSearchDocumentRepository", () => {
  it("refreshes stable source-unit documents idempotently and search.exact never substring matches", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedExactSearchProject(context.db);
      const repository = new ItotoriExactSearchDocumentRepository(context.db);

      const firstRefresh = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: exactSearchRevisionId,
      });
      const firstRows = await exactSearchRows(context.db);

      await seedExactSearchProject(context.db);
      const secondRefresh = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: exactSearchRevisionId,
      });
      const secondRows = await exactSearchRows(context.db);

      expect(firstRefresh).toMatchObject({
        status: "completed",
        toolName: exactSearchToolName,
        toolVersion: exactSearchToolVersion,
        sourceRevisionId: exactSearchRevisionId,
        documentCount: 3,
        diagnostics: [],
      });
      expect(secondRefresh).toMatchObject({
        status: "completed",
        documentCount: 3,
        diagnostics: [],
      });
      expect(secondRows.map((row) => row.searchDocumentId)).toEqual(
        firstRows.map((row) => row.searchDocumentId),
      );
      expect(secondRows).toHaveLength(3);

      const exact = await repository.searchExact(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        sourceRevisionId: exactSearchRevisionId,
        query: "  hero  ",
      });
      expect(exact).toMatchObject({
        status: "completed",
        toolName: "search.exact",
        toolVersion: "1.0.0",
        normalizedQuery: "hero",
        diagnostics: [],
      });
      expect(exact.matches.map((match) => match.sourceArtifactId)).toEqual([heroUnit.bridgeUnitId]);
      expect(exact.matches[0]?.provenance).toMatchObject({
        toolName: "search.exact",
        toolVersion: "1.0.0",
        searchDocumentId: exact.matches[0]?.searchDocumentId,
        sourceArtifactType: "source_unit",
        sourceArtifactId: heroUnit.bridgeUnitId,
        sourceRevisionId: exactSearchRevisionId,
        sourceUnitRevisionId: heroUnit.sourceRevision.revisionId,
        sourceHash: heroUnit.sourceHash,
      });

      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          query: "her",
        }),
      ).resolves.toMatchObject({ status: "completed", matches: [] });
      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          query: "hero arrives",
        }),
      ).resolves.toMatchObject({
        status: "completed",
        matches: [expect.objectContaining({ sourceArtifactId: heroArrivesUnit.bridgeUnitId })],
      });
    } finally {
      await context.close();
    }
  });

  it("refreshes locale branch updates without duplicate documents and reports stale source revisions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedExactSearchProject(context.db);
      const repository = new ItotoriExactSearchDocumentRepository(context.db);
      await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
      });

      await seedExactSearchProject(context.db, exactSearchUpdatedProject);

      await expect(
        repository.refreshDocuments(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          expectedSourceRevisionId: exactSearchRevisionId,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        sourceRevisionId: exactSearchUpdatedRevisionId,
        diagnostics: [
          expect.objectContaining({
            code: exactSearchDiagnosticCodeValues.staleSourceRevision,
          }),
        ],
      });

      const refreshed = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: exactSearchUpdatedRevisionId,
      });
      expect(refreshed).toMatchObject({
        status: "completed",
        sourceRevisionId: exactSearchUpdatedRevisionId,
        documentCount: 2,
      });
      await expect(exactSearchRows(context.db)).resolves.toHaveLength(2);
      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          query: "Hero",
        }),
      ).resolves.toMatchObject({ status: "completed", matches: [] });
      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          query: "Champion",
        }),
      ).resolves.toMatchObject({
        status: "completed",
        sourceRevisionId: exactSearchUpdatedRevisionId,
        matches: [expect.objectContaining({ sourceArtifactId: championUnit.bridgeUnitId })],
      });
    } finally {
      await context.close();
    }
  });

  it("returns semantic diagnostics for missing project, missing branch, unsupported artifact type, and stale search revision", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedExactSearchProject(context.db);
      const repository = new ItotoriExactSearchDocumentRepository(context.db);

      await expect(
        repository.refreshDocuments(localActor, {
          projectId: "missing-project",
          localeBranchId: "locale-en-us",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        diagnostics: [
          expect.objectContaining({ code: exactSearchDiagnosticCodeValues.projectMissing }),
        ],
      });

      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "missing-locale",
          query: "Hero",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        diagnostics: [
          expect.objectContaining({ code: exactSearchDiagnosticCodeValues.localeBranchMissing }),
        ],
      });

      await expect(
        repository.refreshDocuments(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          sourceArtifactTypes: ["runtime_trace"],
        }),
      ).resolves.toMatchObject({
        status: "failed",
        diagnostics: [
          expect.objectContaining({
            code: exactSearchDiagnosticCodeValues.unsupportedArtifactType,
            field: "sourceArtifactTypes[0]",
          }),
        ],
      });

      await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
      });
      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "old-source-revision",
          query: "Hero",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        matches: [],
        sourceRevisionId: exactSearchRevisionId,
        diagnostics: [
          expect.objectContaining({ code: exactSearchDiagnosticCodeValues.staleSourceRevision }),
        ],
      });
      await expect(
        repository.searchExact(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          query: "   ",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        matches: [],
        normalizedQuery: "",
        diagnostics: [
          expect.objectContaining({
            code: exactSearchDiagnosticCodeValues.blankQuery,
            field: "query",
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });
});

async function seedExactSearchProject(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
  project: ItotoriProjectRecord = exactSearchProject,
): Promise<void> {
  const repository = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repository.importSourceBundle(localActor, structuredClone(project));
}

async function exactSearchRows(db: ConstructorParameters<typeof ItotoriProjectRepository>[0]) {
  return await db
    .select()
    .from(exactSearchDocuments)
    .where(eq(exactSearchDocuments.projectId, "project-search"))
    .orderBy(exactSearchDocuments.sourceArtifactId);
}
