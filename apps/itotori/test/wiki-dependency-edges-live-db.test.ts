// Fine-grained dependency edges — EXACT dependency queries over real rows.
//
// Every downstream object records the exact upstream claim/field it consumed, so
// a dependency query returns precisely the downstream that consumed THIS claim/
// field — not every consumer of the upstream object. This is what makes RB-034
// field-scoped invalidation possible. The proofs below persist three downstream
// objects that each consume a different piece of ONE upstream object and show
// the query resolving each consumer exactly, while the coarse object-wide query
// returns all three.

import { createHash } from "node:crypto";

import { ItotoriLlmSnapshotRepository, ItotoriLlmWikiRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";

import type { DependencyRef } from "../src/contracts/index.js";
import { persistWikiObject } from "../src/wiki/object-persistence.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { wikiObjectExample } from "./contract-fixtures-core.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const CREATED_AT = "2026-07-15T12:00:00.000Z";
const UPSTREAM_ID = "wiki:upstream:1";

type Dependency = DependencyRef;

function downstream(contextId: string, objectId: string, dependencies: Dependency[]): unknown {
  return {
    ...wikiObjectExample,
    objectId,
    dependencies,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  };
}

function claimDep(claimId: string): Dependency {
  return {
    upstreamObjectId: UPSTREAM_ID,
    upstreamVersion: 1,
    claimId,
    fieldPath: [],
    renderingId: null,
    scope: { kind: "global" },
    fromPlayOrder: null,
    throughPlayOrder: null,
  };
}

function fieldDep(fieldPath: string[]): Dependency {
  return {
    upstreamObjectId: UPSTREAM_ID,
    upstreamVersion: 1,
    claimId: null,
    fieldPath,
    renderingId: null,
    scope: { kind: "global" },
    fromPlayOrder: null,
    throughPlayOrder: null,
  };
}

postgresDescribe("fine-grained dependency edges resolve exact consumers", () => {
  it("PROOF: querying a claim returns EXACTLY its consumer, not the whole object", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const contextId = await putContextSnapshot(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const options = { expectedHead: null, createdAt: CREATED_AT };

      // The upstream object with two distinct claims other objects will consume.
      await persistWikiObject(repository, downstream(contextId, UPSTREAM_ID, []), options);
      // Three downstream consumers of ONE upstream object, each consuming a
      // different piece: claim:A, claim:B, and the register-policy field.
      const c1 = await persistWikiObject(
        repository,
        downstream(contextId, "wiki:consumer:a", [claimDep("claim:A")]),
        options,
      );
      const c2 = await persistWikiObject(
        repository,
        downstream(contextId, "wiki:consumer:b", [claimDep("claim:B")]),
        options,
      );
      const c3 = await persistWikiObject(
        repository,
        downstream(contextId, "wiki:consumer:field", [fieldDep(["body", "registerPolicy"])]),
        options,
      );

      // EXACT: the consumers of claim:A are exactly [wiki:consumer:a].
      const claimAConsumers = await repository.queryDependents({
        upstreamObjectId: UPSTREAM_ID,
        claimId: "claim:A",
      });
      expect(claimAConsumers.map((edge) => edge.downstreamObjectId)).toEqual(["wiki:consumer:a"]);
      expect(claimAConsumers[0]!.downstreamWikiVersionId).toBe(c1.wikiVersionId);
      expect(claimAConsumers[0]!.claimId).toBe("claim:A");

      // EXACT: the consumers of claim:B are exactly [wiki:consumer:b] — the
      // claim:A consumer is NOT returned even though both cite the same object.
      const claimBConsumers = await repository.queryDependents({
        upstreamObjectId: UPSTREAM_ID,
        claimId: "claim:B",
      });
      expect(claimBConsumers.map((edge) => edge.downstreamObjectId)).toEqual(["wiki:consumer:b"]);
      expect(claimBConsumers[0]!.downstreamWikiVersionId).toBe(c2.wikiVersionId);

      // EXACT: the register-policy FIELD consumer is resolved by field path.
      const fieldConsumers = await repository.queryDependents({
        upstreamObjectId: UPSTREAM_ID,
        fieldPath: ["body", "registerPolicy"],
      });
      expect(fieldConsumers.map((edge) => edge.downstreamObjectId)).toEqual([
        "wiki:consumer:field",
      ]);
      expect(fieldConsumers[0]!.downstreamWikiVersionId).toBe(c3.wikiVersionId);

      // COARSE: the object-wide query (the thing exact edges replace) returns
      // ALL THREE consumers — proving the claim/field queries above are strictly
      // narrower, not merely reflecting a sparsely-populated table.
      const allConsumers = await repository.queryDependents({ upstreamObjectId: UPSTREAM_ID });
      expect(allConsumers.map((edge) => edge.downstreamObjectId)).toEqual([
        "wiki:consumer:a",
        "wiki:consumer:b",
        "wiki:consumer:field",
      ]);

      // A claim nobody consumed has zero consumers (no fabricated edge).
      const none = await repository.queryDependents({
        upstreamObjectId: UPSTREAM_ID,
        claimId: "claim:unused",
      });
      expect(none).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("PROOF: a dependency identifying no consumed content is rejected (no fabricated edge)", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const contextId = await putContextSnapshot(context);
      const repository = new ItotoriLlmWikiRepository(context.pool, cipher);
      const empty: Dependency = {
        upstreamObjectId: UPSTREAM_ID,
        upstreamVersion: 1,
        claimId: null,
        fieldPath: [],
        renderingId: null,
        scope: { kind: "global" },
        fromPlayOrder: null,
        throughPlayOrder: null,
      };
      // The strict contract rejects a locator-free dependency before any write.
      await expect(
        persistWikiObject(repository, downstream(contextId, "wiki:consumer:bad", [empty]), {
          expectedHead: null,
          createdAt: CREATED_AT,
        }),
      ).rejects.toThrow();
      const rows = await context.pool.query(
        "select count(*)::int as n from itotori_llm_dependency_edges",
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await context.close();
    }
  });
});

async function putContextSnapshot(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<string> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const snapshot = await repository.putContext({
    sourceLanguage: "ja",
    decode: revision("decode:1"),
    sourceUnits: [{ unitId: "unit:1", sourceHash: hashOf("unit:1") }],
    facts: [{ factId: "scene:1", playOrderIndex: 0, routeScope: { kind: "global" } }],
    structure: revision("structure:1"),
    routeGraph: revision("route-graph:1"),
    glossary: revision("glossary:1"),
    style: revision("style:1"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("human-corrections:1"),
    externalSources: null,
    contextScope: "whole-game",
  });
  return snapshot.snapshotId;
}

function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
