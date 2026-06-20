import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { sourceBundles, sourceRevisions, sourceUnits } from "../src/schema.js";
import {
  ContextArtifactRepositoryError,
  contextArtifactCategoryValues,
  contextArtifactDiagnosticCodeValues,
  contextArtifactStatusValues,
  contextArtifactToolName,
  contextArtifactToolVersion,
  ItotoriContextArtifactRepository,
} from "../src/repositories/context-artifact-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriContextArtifactRepository", () => {
  it("persists typed bounded artifacts with source citations and producer provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);

      const artifact = await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-scene-1",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "Opening scene",
        body: "The hero meets Mira at the station before the route split.",
        data: { routeNode: "common.001" },
        producedByAgent: "agent.scene-summarizer",
        producedByTool: "tool.context-extractor",
        producerVersion: "1.0.0",
        provenance: { runId: "run-context-1" },
        sourceUnits: [
          { bridgeUnitId: "unit-opening", citation: "scene.001.opening" },
          { bridgeUnitId: "unit-mira", citation: "scene.002.mira" },
        ],
      });

      expect(artifact).toMatchObject({
        contextArtifactId: "context-artifact-scene-1",
        category: "scene_summary",
        status: "active",
        contentHash: expect.stringMatching(/^sha256:/),
        producedByAgent: "agent.scene-summarizer",
        producedByTool: "tool.context-extractor",
        producerVersion: "1.0.0",
        provenance: expect.objectContaining({
          schemaVersion: "itotori.context-artifact.v1",
          runId: "run-context-1",
        }),
      });
      expect(artifact.sourceUnits).toEqual([
        expect.objectContaining({
          bridgeUnitId: "unit-mira",
          sourceRevisionId: "bridge-context:bundle-revision",
          sourceHash: "hash:mira",
          citation: "scene.002.mira",
        }),
        expect.objectContaining({
          bridgeUnitId: "unit-opening",
          sourceRevisionId: "bridge-context:bundle-revision",
          sourceHash: "hash:opening",
          citation: "scene.001.opening",
        }),
      ]);

      await expect(
        repository.upsertArtifact(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
          category: contextArtifactCategoryValues.characterNote,
          title: "Oversized",
          body: "x".repeat(20_001),
          producedByTool: "tool.context-extractor",
          producerVersion: "1.0.0",
          sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
        }),
      ).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: contextArtifactDiagnosticCodeValues.unboundedArtifactBody,
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("retrieves precise current artifacts by category, source unit, query, citations, and provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await seedArtifacts(repository);

      const result = await repository.retrieveArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        categories: [contextArtifactCategoryValues.characterNote],
        bridgeUnitIds: ["unit-mira"],
        query: "Mira",
      });

      expect(result).toMatchObject({
        status: "completed",
        toolName: contextArtifactToolName,
        toolVersion: contextArtifactToolVersion,
        sourceRevisionId: "bridge-context:bundle-revision",
        normalizedQuery: "mira",
        categories: ["character_note"],
        diagnostics: [],
      });
      expect(result.matches.map((match) => match.contextArtifactId)).toEqual([
        "context-artifact-mira",
      ]);
      expect(result.matches[0]).toMatchObject({
        retrievalReasons: expect.arrayContaining(["source_unit", "exact_title"]),
        citations: [expect.objectContaining({ bridgeUnitId: "unit-mira" })],
        provenance: expect.objectContaining({
          toolName: contextArtifactToolName,
          toolVersion: contextArtifactToolVersion,
          contextArtifactId: "context-artifact-mira",
          category: "character_note",
          producedByAgent: "agent.character-notes",
        }),
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: [contextArtifactCategoryValues.routeMap],
          query: "Mira",
        }),
      ).resolves.toMatchObject({ status: "completed", matches: [] });
    } finally {
      await context.close();
    }
  });

  it("invalidates active artifacts when cited source units change and hides stale artifacts by default", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await seedArtifacts(repository);

      await advanceContextSourceRevision(context.db);

      const invalidated = await repository.invalidateAffectedArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        reason: "source_reimport",
      });
      expect(invalidated).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision:v2",
        invalidatedCount: 3,
        invalidatedArtifactIds: expect.arrayContaining([
          "context-artifact-opening",
          "context-artifact-mira",
          "context-artifact-route",
        ]),
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: [contextArtifactCategoryValues.sceneSummary],
          query: "station",
        }),
      ).resolves.toMatchObject({ status: "completed", matches: [] });

      const staleIncluded = await repository.retrieveArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        categories: [contextArtifactCategoryValues.sceneSummary],
        query: "station",
        includeStale: true,
      });
      expect(staleIncluded.matches).toEqual([
        expect.objectContaining({
          contextArtifactId: "context-artifact-opening",
          status: contextArtifactStatusValues.stale,
          invalidatedReason: "source_reimport",
        }),
      ]);

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
          categories: [contextArtifactCategoryValues.sceneSummary],
          query: "station",
          includeStale: true,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision",
        matches: [
          expect.objectContaining({
            contextArtifactId: "context-artifact-opening",
            status: contextArtifactStatusValues.stale,
          }),
        ],
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        diagnostics: [
          expect.objectContaining({
            code: contextArtifactDiagnosticCodeValues.staleSourceRevision,
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("preserves citations when a cited source unit is removed before stale invalidation", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const artifactRepository = new ItotoriContextArtifactRepository(context.db);
      await artifactRepository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-removed-mira",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.characterNote,
        title: "Removed Mira citation",
        body: "Mira's removed source unit remains inspectable after reimport.",
        producedByAgent: "agent.character-notes",
        producerVersion: "1.0.0",
        provenance: { runId: "run-removed-unit" },
        sourceUnits: [{ bridgeUnitId: "unit-mira", citation: "scene.002.mira" }],
      });

      await new ItotoriProjectRepository(context.db).importSourceBundle(
        localActor,
        contextProjectFixture({
          units: [
            {
              bridgeUnitId: "unit-opening",
              sourceUnitKey: "scene.001.opening",
              occurrenceId: "occurrence-opening",
              sourceText: "Opening",
              sourceHash: "hash:opening",
            },
            {
              bridgeUnitId: "unit-route",
              sourceUnitKey: "scene.003.route",
              occurrenceId: "occurrence-route",
              sourceText: "Route split",
              sourceHash: "hash:route",
            },
          ],
        }),
      );

      const result = await artifactRepository.retrieveArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        bridgeUnitIds: ["unit-mira"],
        includeStale: true,
      });

      expect(result).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision",
        matches: [
          expect.objectContaining({
            contextArtifactId: "context-artifact-removed-mira",
            status: contextArtifactStatusValues.stale,
            invalidatedReason: "source_import",
            citations: [
              expect.objectContaining({
                bridgeUnitId: "unit-mira",
                sourceRevisionId: "bridge-context:bundle-revision",
                sourceHash: "hash:mira",
                citation: "scene.002.mira",
              }),
            ],
            provenance: expect.objectContaining({
              runId: "run-removed-unit",
              contextArtifactId: "context-artifact-removed-mira",
              producedByAgent: "agent.character-notes",
            }),
            retrievalReasons: expect.arrayContaining(["source_unit"]),
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("manually invalidates active artifacts by source unit without an artifact read cap", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await seedArtifacts(repository);

      const invalidated = await repository.invalidateAffectedArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        bridgeUnitIds: ["unit-route"],
        reason: "manual_source_review",
      });

      expect(invalidated).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision",
        invalidatedCount: 1,
        invalidatedArtifactIds: ["context-artifact-route"],
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: [contextArtifactCategoryValues.routeMap],
          includeStale: true,
        }),
      ).resolves.toMatchObject({
        matches: [
          expect.objectContaining({
            contextArtifactId: "context-artifact-route",
            status: contextArtifactStatusValues.stale,
            invalidatedReason: "manual_source_review",
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("applies source-unit and query filters before the default retrieval limit", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      for (let index = 0; index < 25; index += 1) {
        await repository.upsertArtifact(localActor, {
          contextArtifactId: `context-artifact-filler-${index.toString().padStart(2, "0")}`,
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
          category: contextArtifactCategoryValues.sceneSummary,
          title: `aaa filler ${index.toString().padStart(2, "0")}`,
          body: "Common background detail.",
          producedByTool: "tool.context-extractor",
          producerVersion: "1.0.0",
          sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
        });
      }
      await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-late-match",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "zzz late Mira source match",
        body: "Contains the only late retrieval phrase.",
        producedByTool: "tool.context-extractor",
        producerVersion: "1.0.0",
        sourceUnits: [{ bridgeUnitId: "unit-mira", citation: "scene.002.mira" }],
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: [contextArtifactCategoryValues.sceneSummary],
          bridgeUnitIds: ["unit-mira"],
        }),
      ).resolves.toMatchObject({
        matches: [
          expect.objectContaining({
            contextArtifactId: "context-artifact-late-match",
            retrievalReasons: expect.arrayContaining(["source_unit"]),
          }),
        ],
      });

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: [contextArtifactCategoryValues.sceneSummary],
          query: "only late retrieval phrase",
        }),
      ).resolves.toMatchObject({
        matches: [
          expect.objectContaining({
            contextArtifactId: "context-artifact-late-match",
            retrievalReasons: expect.arrayContaining(["body"]),
          }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("returns semantic diagnostics for unsupported categories and bad source citations", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);

      await expect(
        repository.retrieveArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          categories: ["legacy_rag_blob"],
        }),
      ).resolves.toMatchObject({
        status: "failed",
        diagnostics: [
          expect.objectContaining({
            code: contextArtifactDiagnosticCodeValues.unsupportedCategory,
          }),
        ],
      });

      await expect(
        repository.upsertArtifact(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
          category: contextArtifactCategoryValues.sceneSummary,
          title: "Bad citation",
          body: "Cannot be grounded.",
          producedByTool: "tool.context-extractor",
          producerVersion: "1.0.0",
          sourceUnits: [{ bridgeUnitId: "missing-unit", citation: "missing" }],
        }),
      ).rejects.toBeInstanceOf(ContextArtifactRepositoryError);
    } finally {
      await context.close();
    }
  });
});

async function seedArtifacts(repository: ItotoriContextArtifactRepository): Promise<void> {
  await repository.upsertArtifact(localActor, {
    contextArtifactId: "context-artifact-opening",
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-context:bundle-revision",
    category: contextArtifactCategoryValues.sceneSummary,
    title: "Opening station",
    body: "The opening at the station establishes Mira and the hero before the route split.",
    producedByAgent: "agent.scene-summaries",
    producerVersion: "1.0.0",
    sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
  });
  await repository.upsertArtifact(localActor, {
    contextArtifactId: "context-artifact-mira",
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-context:bundle-revision",
    category: contextArtifactCategoryValues.characterNote,
    title: "Mira",
    body: "Mira speaks formally when she is anxious.",
    producedByAgent: "agent.character-notes",
    producerVersion: "1.0.0",
    sourceUnits: [{ bridgeUnitId: "unit-mira", citation: "scene.002.mira" }],
  });
  await repository.upsertArtifact(localActor, {
    contextArtifactId: "context-artifact-route",
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-context:bundle-revision",
    category: contextArtifactCategoryValues.routeMap,
    title: "Common route split",
    body: "The first route choice happens after the station scene.",
    producedByTool: "tool.route-map",
    producerVersion: "1.0.0",
    sourceUnits: [{ bridgeUnitId: "unit-route", citation: "scene.003.route" }],
  });
}

async function seedContextProject(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
  overrides: ContextBridgeOverrides = {},
): Promise<void> {
  const repository = new ItotoriProjectRepository(db);
  await repository.importSourceBundle(localActor, contextProjectFixture(overrides));
}

async function advanceContextSourceRevision(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
): Promise<void> {
  await db
    .insert(sourceRevisions)
    .values([
      {
        sourceRevisionId: "bridge-context:bundle-revision:v2",
        projectId: "project-context",
        revisionKind: "content_hash",
        value: "hash:bundle-v2",
      },
      {
        sourceRevisionId: "bridge-context:unit:unit-opening:v2",
        projectId: "project-context",
        revisionKind: "content_hash",
        value: "hash:opening-v2",
      },
    ])
    .onConflictDoNothing();

  await db
    .update(sourceBundles)
    .set({
      sourceBundleRevisionId: "bridge-context:bundle-revision:v2",
      sourceBundleHash: "hash:bundle-v2",
    })
    .where(eq(sourceBundles.sourceBundleId, "bridge-context"));

  await db
    .update(sourceUnits)
    .set({
      sourceRevisionId: "bridge-context:unit:unit-opening:v2",
      sourceHash: "hash:opening-v2",
      sourceText: "Opening revised",
    })
    .where(eq(sourceUnits.bridgeUnitId, "unit-opening"));
}

function contextProjectFixture(overrides: ContextBridgeOverrides = {}): ItotoriProjectRecord {
  return {
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {},
    bridge: contextBridgeFixture(overrides),
  };
}

function contextBridgeFixture(overrides: ContextBridgeOverrides = {}): BridgeBundle {
  const bridgeId = "bridge-context";
  const sourceBundleHash = overrides.sourceBundleHash ?? "hash:bundle-v1";
  const sourceBundleRevisionId =
    overrides.sourceBundleRevisionId ??
    (sourceBundleHash === "hash:bundle-v1"
      ? "bridge-context:bundle-revision"
      : "bridge-context:bundle-revision:v2");
  const assetId = `${bridgeId}:scenario.ks`;
  const units = overrides.units ?? [
    {
      bridgeUnitId: "unit-opening",
      sourceUnitKey: "scene.001.opening",
      occurrenceId: "occurrence-opening",
      sourceText: "Opening",
      sourceHash: "hash:opening",
    },
    {
      bridgeUnitId: "unit-mira",
      sourceUnitKey: "scene.002.mira",
      occurrenceId: "occurrence-mira",
      sourceText: "Mira",
      sourceHash: "hash:mira",
    },
    {
      bridgeUnitId: "unit-route",
      sourceUnitKey: "scene.003.route",
      occurrenceId: "occurrence-route",
      sourceText: "Route split",
      sourceHash: "hash:route",
    },
  ];
  return {
    schemaVersion: "0.1.0",
    bridgeId,
    sourceBundleHash,
    sourceBundleRevisionId,
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: units.map((unit) => contextUnit({ ...unit, assetId, sourceBundleRevisionId })),
  };
}

function contextUnit(
  input: ContextUnitFixture & { assetId: string; sourceBundleRevisionId: string },
): BridgeBundle["units"][number] {
  return {
    bridgeUnitId: input.bridgeUnitId,
    sourceUnitKey: input.sourceUnitKey,
    occurrenceId: input.occurrenceId,
    sourceHash: input.sourceHash,
    sourceRevisionId: input.sourceBundleRevisionId,
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

type ContextBridgeOverrides = {
  sourceBundleHash?: string;
  sourceBundleRevisionId?: string;
  units?: ContextUnitFixture[];
};

type ContextUnitFixture = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceText: string;
  sourceHash: string;
};
