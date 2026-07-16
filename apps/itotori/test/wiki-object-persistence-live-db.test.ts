import { createHash } from "node:crypto";
import {
  canonicalLlmJson,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { localizedRenderingExample, wikiObjectExample } from "./contract-fixtures-core.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

const CREATED_AT = "2026-07-14T12:00:00.000Z";

postgresDescribe("strict WikiObject persistence over real contracts", () => {
  it("PROOF: a strict source WikiObject round-trips and stays target-agnostic while a rendering carries the target", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { contextId, localizationId } = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const sourceObject = withContextSnapshot(contextId);

      const head = await persistWikiObject(repository, sourceObject, {
        expectedHead: null,
        createdAt: CREATED_AT,
      });
      expect(head.version).toBe(1);

      // The stored source object is byte-identical to the strict object written.
      const projected = await repository.readProjectableObject({
        wikiKind: "source-object",
        objectId: sourceObject.objectId,
      });
      expect(projected).toBe(canonicalLlmJson(sourceObject as never));

      // Target-agnostic: the source row records the context snapshot and no target.
      const sourceRow = await context.pool.query(
        `select snapshot_kind, object_language, localization_snapshot_id, source_object_id
         from itotori_llm_wiki_versions where wiki_version_id = $1`,
        [head.wikiVersionId],
      );
      expect(sourceRow.rows[0]).toEqual({
        snapshot_kind: "context",
        object_language: "ja",
        localization_snapshot_id: null,
        source_object_id: null,
      });

      // The per-target rendering carries the target language and localization snapshot.
      const rendering = withLocalizationSnapshot(localizationId, sourceObject.objectId);
      const renderingHead = await persistLocalizedRendering(repository, rendering, {
        expectedHead: null,
        createdAt: CREATED_AT,
      });
      const renderingRow = await context.pool.query(
        `select snapshot_kind, object_language, localization_snapshot_id, source_object_id
         from itotori_llm_wiki_versions where wiki_version_id = $1`,
        [renderingHead.wikiVersionId],
      );
      expect(renderingRow.rows[0]).toEqual({
        snapshot_kind: "localization",
        object_language: "en-US",
        localization_snapshot_id: localizationId,
        source_object_id: sourceObject.objectId,
      });
    } finally {
      await context.close();
    }
  });

  it("PROOF: a forged provenance kind is rejected before any row is written", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { contextId } = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const forged = {
        ...withContextSnapshot(contextId),
        provenance: {
          ...wikiObjectExample.provenance,
          contextSnapshotId: contextId,
          // A source object cannot claim a localization provenance.
          snapshotKind: "localization",
        },
      };
      await expect(
        persistWikiObject(repository, forged, { expectedHead: null, createdAt: CREATED_AT }),
      ).rejects.toThrow();
      const rows = await context.pool.query(
        "select count(*)::int as n from itotori_llm_wiki_versions",
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("PROOF: a forged scope is rejected before any row is written", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { contextId } = await putSnapshots(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const forged = {
        ...withContextSnapshot(contextId),
        // A route-set scope with unsorted, duplicated routes is not a valid scope.
        scope: { kind: "route-set", routeIds: ["route:b", "route:a", "route:a"] },
      };
      await expect(
        persistWikiObject(repository, forged, { expectedHead: null, createdAt: CREATED_AT }),
      ).rejects.toThrow();
      const rows = await context.pool.query(
        "select count(*)::int as n from itotori_llm_wiki_versions",
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await context.close();
    }
  });
});

function withContextSnapshot(contextId: string): typeof wikiObjectExample {
  return {
    ...wikiObjectExample,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  };
}

function withLocalizationSnapshot(
  localizationId: string,
  sourceObjectId: string,
): typeof localizedRenderingExample {
  return {
    ...localizedRenderingExample,
    sourceObjectId,
    provenance: { ...localizedRenderingExample.provenance, localizationSnapshotId: localizationId },
  };
}

async function putSnapshots(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<{ contextId: string; localizationId: string }> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await repository.putContext({
    sourceLanguage: "ja",
    decode: revision("decode:1"),
    sourceUnits: [{ unitId: "unit:1", sourceHash: hashOf("unit:1") }],
    facts: [
      {
        factId: "scene:1",
        playOrderIndex: 0,
        routeScope: { kind: "global" },
      },
    ],
    structure: revision("structure:1"),
    routeGraph: revision("route-graph:1"),
    glossary: revision("glossary:1"),
    style: revision("style:1"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("human-corrections:1"),
    externalSources: null,
    contextScope: "whole-game",
  });
  const localization = await repository.putLocalization({
    contextSnapshotId: contextSnapshot.snapshotId,
    targetLocale: "en-US",
    localeBranchId: "branch:primary",
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  });
  return { contextId: contextSnapshot.snapshotId, localizationId: localization.snapshotId };
}

function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
