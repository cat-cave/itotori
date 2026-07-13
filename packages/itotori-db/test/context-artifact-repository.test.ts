import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { sourceRevisions, sourceUnits } from "../src/schema.js";
import {
  ContextArtifactRepositoryError,
  contextArtifactCategoryValues,
  contextArtifactDiagnosticCodeValues,
  contextArtifactStatusValues,
  contextArtifactToolName,
  contextArtifactToolVersion,
  ItotoriContextArtifactRepository,
  type PersistContextCorrectionInput,
} from "../src/repositories/context-artifact-repository.js";
import { ItotoriEventQueueRepository } from "../src/repositories/event-queue-repository.js";
import { ItotoriSemanticContextReadRepository } from "../src/repositories/semantic-context-read-repository.js";
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

  it("numbers central semantic citations independently for each artifact", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      for (const input of [
        {
          contextArtifactId: "context-artifact-citations-a",
          sceneId: "scene-a",
          sourceUnits: [
            { bridgeUnitId: "unit-opening", citation: "scene-a.opening" },
            { bridgeUnitId: "unit-mira", citation: "scene-a.mira" },
          ],
        },
        {
          contextArtifactId: "context-artifact-citations-b",
          sceneId: "scene-b",
          sourceUnits: [
            { bridgeUnitId: "unit-mira", citation: "scene-b.mira" },
            { bridgeUnitId: "unit-route", citation: "scene-b.route" },
          ],
        },
      ]) {
        await repository.upsertArtifact(localActor, {
          contextArtifactId: input.contextArtifactId,
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          sourceRevisionId: "bridge-context:bundle-revision",
          category: contextArtifactCategoryValues.sceneSummary,
          title: input.sceneId,
          body: input.sceneId,
          data: { semanticKind: "scene_summary", sceneId: input.sceneId },
          producedByTool: "semantic-context-read-test",
          producerVersion: "1.0.0",
          sourceUnits: input.sourceUnits,
        });
      }

      const summaries = await new ItotoriSemanticContextReadRepository(
        context.db,
      ).loadSceneSummaries(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
      });
      expect(
        summaries.map((summary) => summary.citations.map((citation) => citation.citeOrdinal)),
      ).toEqual([
        [1, 2],
        [1, 2],
      ]);
    } finally {
      await context.close();
    }
  });

  it("retains immutable ContextEntryVersion lineage when an entry is upserted twice", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);

      const first = await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-versioned-opening",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "Opening scene",
        body: "The first version records the station meeting.",
        data: { revision: "first" },
        producedByAgent: "agent.scene-summarizer",
        producerVersion: "1.0.0",
        provenance: { runId: "run-context-version-1" },
        sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
      });

      const second = await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-versioned-opening",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "Opening scene",
        body: "The first version records the station meeting.",
        data: { revision: "first" },
        producedByAgent: "agent.scene-summarizer",
        producerVersion: "1.0.0",
        provenance: { runId: "run-context-version-2" },
        sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
      });

      expect(first.headVersionId).toEqual(expect.any(String));
      expect(second.headVersionId).toEqual(expect.any(String));
      expect(second.headVersionId).not.toBe(first.headVersionId);
      // A content hash attests bytes; it is not a version identity. Repeating
      // the same body/citation snapshot still advances an append-only lineage.
      expect(second.contentHash).toBe(first.contentHash);

      const versions = await repository.listEntryVersions(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        contextArtifactId: "context-artifact-versioned-opening",
      });

      // Both packet snapshots remain available after the mutable entry head
      // advances, even though their content hash is intentionally identical.
      expect(versions).toEqual([
        expect.objectContaining({
          contextEntryVersionId: first.headVersionId,
          parentVersionId: null,
          body: "The first version records the station meeting.",
          data: { revision: "first" },
          citations: [
            expect.objectContaining({
              bridgeUnitId: "unit-opening",
              citation: "scene.001.opening",
              sourceHash: "hash:opening",
            }),
          ],
          affectedUnitIds: ["unit-opening"],
        }),
        expect.objectContaining({
          contextEntryVersionId: second.headVersionId,
          parentVersionId: first.headVersionId,
          body: "The first version records the station meeting.",
          data: { revision: "first" },
          provenance: expect.objectContaining({ runId: "run-context-version-2" }),
          citations: [
            expect.objectContaining({
              bridgeUnitId: "unit-opening",
              citation: "scene.001.opening",
              sourceHash: "hash:opening",
            }),
          ],
          affectedUnitIds: ["unit-opening"],
        }),
      ]);

      await expect(
        context.pool.query(
          "update itotori_context_entry_versions set body = $1 where context_entry_version_id = $2",
          ["rewritten history", first.headVersionId],
        ),
      ).rejects.toThrow(/append-only/);

      // Entry removal is the only sanctioned history cleanup: its cascade may
      // delete the immutable rows, while direct version deletion is rejected.
      await context.pool.query(
        "delete from itotori_context_artifacts where context_artifact_id = $1",
        ["context-artifact-versioned-opening"],
      );
      await expect(
        repository.listEntryVersions(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          contextArtifactId: "context-artifact-versioned-opening",
        }),
      ).resolves.toEqual([]);
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

  it("invalidates and rebuilds a cited artifact when only its source revision changes", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await seedArtifacts(repository);

      await advanceCitedUnitSourceRevision(context.db);

      const invalidated = await repository.invalidateAffectedArtifacts(localActor, {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        reason: "source_revision_changed",
      });
      expect(invalidated).toMatchObject({
        status: "completed",
        sourceRevisionId: "bridge-context:bundle-revision",
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
          invalidatedReason: "source_revision_changed",
        }),
      ]);

      const rebuilt = await repository.upsertArtifact(localActor, {
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
      expect(rebuilt).toMatchObject({
        status: contextArtifactStatusValues.active,
        sourceRevisionId: "bridge-context:bundle-revision",
        sourceUnits: [
          expect.objectContaining({
            bridgeUnitId: "unit-opening",
            sourceRevisionId: "bridge-context:unit:unit-opening:v2",
            // The test changes no bytes: revision identity alone invalidates.
            sourceHash: "hash:opening",
          }),
        ],
      });

      await expect(
        repository.invalidateAffectedArtifacts(localActor, {
          projectId: "project-context",
          localeBranchId: "locale-en-us",
          reason: "revision_recheck",
        }),
      ).resolves.toMatchObject({
        status: "completed",
        invalidatedCount: 0,
        invalidatedArtifactIds: [],
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
                sourceRevisionId: "bridge-context:unit:unit-mira",
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

  it("atomically appends a correction, stales only dependents, and reuses its version and job on retry", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-atomic-dependent",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "Dependent opening summary",
        body: "This dependent artifact must be refreshed after the correction.",
        producedByTool: "context-artifact-atomic-test",
        producerVersion: "1.0.0",
        sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
      });
      const input = atomicCorrectionInput();

      const first = await repository.persistContextCorrection(localActor, input);

      expect(first).toMatchObject({
        duplicate: false,
        affectedUnitIds: ["unit-opening"],
        invalidatedArtifactIds: ["context-artifact-atomic-dependent"],
        contextArtifact: {
          contextArtifactId: input.contextArtifactId,
          status: contextArtifactStatusValues.active,
          invalidatedAt: null,
        },
        redraftJob: {
          jobName: "context-correction.redraft",
          queueName: "context-correction",
          idempotencyKey: `context-correction:${input.correctionId}`,
          payload: expect.objectContaining({
            correctionId: input.correctionId,
            contextArtifactId: input.contextArtifactId,
            contextEntryVersionId: first.contextArtifact.headVersionId,
            affectedUnitIds: ["unit-opening"],
          }),
        },
      });
      expect(first.contextArtifact.headVersionId).toEqual(expect.any(String));
      const dependent = await repository.loadArtifact(localActor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        contextArtifactId: "context-artifact-atomic-dependent",
      });
      expect(dependent).toMatchObject({
        status: contextArtifactStatusValues.stale,
        invalidatedReason: `play_tester_context_correction:${input.correctionId}`,
      });

      const retry = await repository.persistContextCorrection(localActor, input);

      expect(retry).toMatchObject({
        duplicate: true,
        invalidatedArtifactIds: [],
        contextArtifact: { headVersionId: first.contextArtifact.headVersionId },
        redraftJob: { jobId: first.redraftJob.jobId },
      });
      await expect(
        repository.listEntryVersions(localActor, {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          contextArtifactId: input.contextArtifactId,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        new ItotoriEventQueueRepository(context.db).getJob(localActor, first.redraftJob.jobId),
      ).resolves.toMatchObject({ jobId: first.redraftJob.jobId, status: "queued" });
    } finally {
      await context.close();
    }
  });

  it("preserves active context and leaves no rerun job when an atomic correction cites an unknown unit", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedContextProject(context.db);
      const repository = new ItotoriContextArtifactRepository(context.db);
      await repository.upsertArtifact(localActor, {
        contextArtifactId: "context-artifact-atomic-preserved",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: contextArtifactCategoryValues.sceneSummary,
        title: "Preserved opening summary",
        body: "This artifact must remain active when a correction cannot append.",
        producedByTool: "context-artifact-atomic-test",
        producerVersion: "1.0.0",
        sourceUnits: [{ bridgeUnitId: "unit-opening", citation: "scene.001.opening" }],
      });
      const input = atomicCorrectionInput({
        correctionId: "context-correction-atomic-rejected",
        contextArtifactId: "context-artifact-atomic-rejected",
        requestedAffectedUnitIds: ["unit-opening", "missing-unit"],
      });

      await expect(repository.persistContextCorrection(localActor, input)).rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({ code: contextArtifactDiagnosticCodeValues.sourceUnitMissing }),
        ],
      });

      await expect(
        repository.loadArtifact(localActor, {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          contextArtifactId: "context-artifact-atomic-preserved",
        }),
      ).resolves.toMatchObject({
        status: contextArtifactStatusValues.active,
        invalidatedReason: null,
        invalidatedAt: null,
      });
      await expect(
        repository.loadArtifact(localActor, {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          contextArtifactId: input.contextArtifactId,
        }),
      ).resolves.toBeNull();
      const queuedJobs = await context.pool.query<{ job_id: string }>(
        "select job_id from itotori_jobs where queue_name = $1",
        ["context-correction"],
      );
      expect(queuedJobs.rows).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

function atomicCorrectionInput(
  overrides: Partial<PersistContextCorrectionInput> = {},
): PersistContextCorrectionInput {
  return {
    correctionId: "context-correction-atomic-success",
    contextArtifactId: "context-artifact-atomic-correction",
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-context:bundle-revision",
    category: contextArtifactCategoryValues.glossary,
    title: "Captain Wato",
    body: "The canonical title is Captain Wato.",
    reason: "Play-test evidence corrected the character title.",
    requestedAffectedUnitIds: ["unit-opening"],
    data: { origin: "atomic-context-artifact-repository-test" },
    producedByAgent: "play-tester",
    producedByTool: "tool.play-tester-context-correction",
    producerVersion: "1.0.0",
    provenance: { origin: "play_tester_edit" },
    ...overrides,
  };
}

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

async function advanceCitedUnitSourceRevision(
  db: ConstructorParameters<typeof ItotoriProjectRepository>[0],
): Promise<void> {
  await db
    .insert(sourceRevisions)
    .values({
      sourceRevisionId: "bridge-context:unit:unit-opening:v2",
      projectId: "project-context",
      revisionKind: "content_hash",
      // Deliberately byte-identical to the first revision.
      value: "hash:opening",
    })
    .onConflictDoNothing();

  await db
    .update(sourceUnits)
    .set({
      sourceRevisionId: "bridge-context:unit:unit-opening:v2",
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
