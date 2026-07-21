import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
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
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriExactSearchDocumentRepository", () => {
  it("refreshes stable source-unit documents idempotently and search.exact never substring matches", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedExactSearchProject(context.db);
      const repository = new ItotoriExactSearchDocumentRepository(context.db);

      const firstRefresh = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: "bridge-search:bundle-revision",
      });
      const firstRows = await exactSearchRows(context.db);

      await seedExactSearchProject(context.db);
      const secondRefresh = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: "bridge-search:bundle-revision",
      });
      const secondRows = await exactSearchRows(context.db);

      expect(firstRefresh).toMatchObject({
        status: "completed",
        toolName: exactSearchToolName,
        toolVersion: exactSearchToolVersion,
        sourceRevisionId: "bridge-search:bundle-revision",
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
        sourceRevisionId: "bridge-search:bundle-revision",
        query: "  hero  ",
      });
      expect(exact).toMatchObject({
        status: "completed",
        toolName: "search.exact",
        toolVersion: "1.0.0",
        normalizedQuery: "hero",
        diagnostics: [],
      });
      expect(exact.matches.map((match) => match.sourceArtifactId)).toEqual(["unit-hero"]);
      expect(exact.matches[0]?.provenance).toMatchObject({
        toolName: "search.exact",
        toolVersion: "1.0.0",
        searchDocumentId: exact.matches[0]?.searchDocumentId,
        sourceArtifactType: "source_unit",
        sourceArtifactId: "unit-hero",
        sourceRevisionId: "bridge-search:bundle-revision",
        sourceUnitRevisionId: "bridge-search:unit:unit-hero",
        sourceHash: "hash:hero",
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
        matches: [expect.objectContaining({ sourceArtifactId: "unit-hero-arrives" })],
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

      await seedExactSearchProject(context.db, {
        bridgeId: "bridge-search-v2",
        sourceBundleHash: "hash:bundle-v2",
        units: [
          {
            bridgeUnitId: "unit-champion",
            sourceUnitKey: "scene.001.hero",
            occurrenceId: "occurrence-hero",
            sourceText: "Champion",
            sourceHash: "hash:champion",
          },
          {
            bridgeUnitId: "unit-sidekick",
            sourceUnitKey: "scene.002.sidekick",
            occurrenceId: "occurrence-sidekick",
            sourceText: "Sidekick",
            sourceHash: "hash:sidekick",
          },
        ],
      });

      await expect(
        repository.refreshDocuments(localActor, {
          projectId: "project-search",
          localeBranchId: "locale-en-us",
          expectedSourceRevisionId: "bridge-search:bundle-revision",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        sourceRevisionId: "bridge-search-v2:bundle-revision",
        diagnostics: [
          expect.objectContaining({
            code: exactSearchDiagnosticCodeValues.staleSourceRevision,
          }),
        ],
      });

      const refreshed = await repository.refreshDocuments(localActor, {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        expectedSourceRevisionId: "bridge-search-v2:bundle-revision",
      });
      expect(refreshed).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-search-v2:bundle-revision",
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
        sourceRevisionId: "bridge-search-v2:bundle-revision",
        matches: [expect.objectContaining({ sourceArtifactId: "unit-champion" })],
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
        sourceRevisionId: "bridge-search:bundle-revision",
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
  overrides: ExactSearchBridgeOverrides = {},
): Promise<void> {
  const repository = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repository.importSourceBundle(localActor, exactSearchProjectFixture(overrides));
}

function exactSearchProjectFixture(
  overrides: ExactSearchBridgeOverrides = {},
): ItotoriProjectRecord {
  return {
    projectId: "project-search",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {},
    bridge: exactSearchBridgeFixture(overrides),
  };
}

function exactSearchBridgeFixture(overrides: ExactSearchBridgeOverrides = {}): BridgeBundle {
  const bridgeId = overrides.bridgeId ?? "bridge-search";
  const sourceBundleHash = overrides.sourceBundleHash ?? "hash:bundle-v1";
  const assetId = `${bridgeId}:scenario.ks`;
  const units = overrides.units ?? [
    {
      bridgeUnitId: "unit-hero",
      sourceUnitKey: "scene.001.hero",
      occurrenceId: "occurrence-hero",
      sourceText: "Hero",
      sourceHash: "hash:hero",
    },
    {
      bridgeUnitId: "unit-heroine",
      sourceUnitKey: "scene.002.heroine",
      occurrenceId: "occurrence-heroine",
      sourceText: "Heroine",
      sourceHash: "hash:heroine",
    },
    {
      bridgeUnitId: "unit-hero-arrives",
      sourceUnitKey: "scene.003.hero-arrives",
      occurrenceId: "occurrence-hero-arrives",
      sourceText: "Hero arrives",
      sourceHash: "hash:hero-arrives",
    },
  ];
  return {
    schemaVersion: "0.1.0",
    bridgeId,
    sourceBundleHash,
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: units.map((unit) => exactSearchUnit({ ...unit, assetId })),
  };
}

function exactSearchUnit(
  input: ExactSearchUnitFixture & { assetId: string },
): BridgeBundle["units"][number] {
  return {
    bridgeUnitId: input.bridgeUnitId,
    sourceUnitKey: input.sourceUnitKey,
    occurrenceId: input.occurrenceId,
    sourceHash: input.sourceHash,
    sourceLocale: "ja-JP",
    sourceText: input.sourceText,
    textSurface: "dialogue",
    protectedSpans: [],
    patchRef: {
      assetId: input.assetId,
      writeMode: "replace",
      sourceUnitKey: input.sourceUnitKey,
    },
  };
}

async function exactSearchRows(db: ConstructorParameters<typeof ItotoriProjectRepository>[0]) {
  return await db
    .select()
    .from(exactSearchDocuments)
    .where(eq(exactSearchDocuments.projectId, "project-search"))
    .orderBy(exactSearchDocuments.sourceArtifactId);
}

type ExactSearchBridgeOverrides = {
  bridgeId?: string;
  sourceBundleHash?: string;
  units?: ExactSearchUnitFixture[];
};

type ExactSearchUnitFixture = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceText: string;
  sourceHash: string;
};
