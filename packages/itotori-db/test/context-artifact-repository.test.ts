import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
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
          sourceRevisionId: "bridge-context:unit:unit-mira",
          sourceHash: "hash:mira",
          citation: "scene.002.mira",
        }),
        expect.objectContaining({
          bridgeUnitId: "unit-opening",
          sourceRevisionId: "bridge-context:unit:unit-opening",
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

      await seedContextProject(context.db, {
        sourceBundleHash: "hash:bundle-v2",
        units: [
          {
            bridgeUnitId: "unit-opening",
            sourceUnitKey: "scene.001.opening",
            occurrenceId: "occurrence-opening",
            sourceText: "Opening revised",
            sourceHash: "hash:opening-v2",
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
        ],
      });

      const invalidated = await repository.invalidateAffectedArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        reason: "source_reimport",
      });
      expect(invalidated).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision:v2",
        invalidatedCount: 1,
        invalidatedArtifactIds: ["context-artifact-opening"],
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
    sourceBundleHash === "hash:bundle-v1"
      ? "bridge-context:bundle-revision"
      : "bridge-context:bundle-revision:v2";
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
    sourceRevisionId: `${input.sourceBundleRevisionId}:unit:${input.bridgeUnitId}`,
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
  units?: ContextUnitFixture[];
};

type ContextUnitFixture = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceText: string;
  sourceHash: string;
};
