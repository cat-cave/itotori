// Field/claim-scoped invalidation — the deterministic, model-free impact set.
//
// A one-field change to an upstream object must reach EXACTLY the consumers that
// cited that field within an overlapping route/play window — never the whole
// object's consumers — and must leave every unrelated artifact byte-identical. A
// human-touched consumer must survive as a protected reviewer target, enhanced,
// never erased. These proofs persist one upstream object with five distinct
// consumers plus unrelated object / memo / accepted-unit / patch rows, run a
// one-field change through the planner, and assert the minimal, deterministic,
// non-destructive work set.

import { createHash } from "node:crypto";

import { ItotoriLlmSnapshotRepository, ItotoriLlmWikiRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";

import type { DependencyRef } from "../src/contracts/index.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import {
  ScopedInvalidationService,
  computeImpactSet,
  diffUpstreamObject,
  type ImpactSet,
  type ImpactedConsumer,
} from "../src/wiki/scoped-invalidation/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { localizedRenderingExample, wikiObjectExample } from "./contract-fixtures-core.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const CREATED_AT = "2026-07-15T12:00:00.000Z";
const UPSTREAM_ID = "wiki:upstream:1";
const CHANGED_FIELD = ["body", "registerPolicy"] as const;
const R1 = { kind: "route", routeId: "route:r1" } as const;
const R2 = { kind: "route", routeId: "route:r2" } as const;

postgresDescribe("field/claim-scoped invalidation", () => {
  it("PROOF (minimal): a one-field change invalidates EXACTLY its in-scope citing consumers", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const impact = await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });

      // EXACTLY the two register-policy consumers, in deterministic order. The
      // honorific-field consumer, the claim consumer, and the out-of-route
      // consumer are NOT swept in — this is field/scope-precise, not object-wide.
      expect(impact.consumers.map((consumer) => consumer.downstreamObjectId)).toEqual([
        "wiki:consumer:field",
        "wiki:consumer:human",
      ]);

      const field = byObject(impact, "wiki:consumer:field");
      expect(field.workKind).toBe("enhancement");
      expect(field.protectedHuman).toBe(false);
      expect(field.matchedFieldPaths).toEqual([["body", "registerPolicy"]]);
      expect(impact.enhancementWork).toEqual([field.downstreamWikiVersionId]);

      // The excluded consumers really exist as edges (proving exclusion is
      // selectivity, not an empty table): the coarse object-wide query sees all.
      const allConsumers = await new ItotoriLlmWikiRepository(context.pool, cipher).queryDependents(
        {
          upstreamObjectId: UPSTREAM_ID,
        },
      );
      expect(new Set(allConsumers.map((edge) => edge.downstreamObjectId))).toEqual(
        new Set([
          "wiki:consumer:field",
          "wiki:consumer:human",
          "wiki:consumer:honorific",
          "wiki:consumer:claim",
          "wiki:consumer:outofscope",
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("PROOF (byte-identical): the one-field change leaves unrelated object/memo/accepted-unit/patch hashes untouched", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      await seedUnrelatedArtifacts(context, cipher, contextId);

      const before = await artifactHashes(context.pool);
      await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });
      const after = await artifactHashes(context.pool);

      // The planner is READ-ONLY: EVERY stored content hash is byte-identical.
      expect(after).toEqual(before);
      // And spelled out per artifact class the guarantee names.
      expect(after.unrelatedObject).toBe(before.unrelatedObject);
      expect(after.memo).toBe(before.memo);
      expect(after.acceptedUnit).toBe(before.acceptedUnit);
      expect(after.patch).toBe(before.patch);
      // Neither the unrelated nor the human consumer was erased.
      expect(after.deletionStates).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("PROOF (protected human): a human-touched consumer is an ENHANCE target, never erased", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const humanBefore = await consumerRow(context.pool, "wiki:consumer:human");

      const impact = await service.planInvalidation({
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      });

      const human = byObject(impact, "wiki:consumer:human");
      // Enhanced, reviewed, protected — the impact set has NO erase/delete kind.
      expect(human.protectedHuman).toBe(true);
      expect(human.workKind).toBe("review");
      expect(impact.reviewerWork).toEqual([human.downstreamWikiVersionId]);

      // The human version survives byte-for-byte and stays active (not erased).
      const humanAfter = await consumerRow(context.pool, "wiki:consumer:human");
      expect(humanAfter).toEqual(humanBefore);
      expect(humanAfter.deletion_state).toBe("active");
    } finally {
      await context.close();
    }
  });

  it("PROOF (deterministic, model-free): the same diff + edges yield the same content-addressed set", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { service, contextId } = await seed(context, cipher);
      const request = {
        priorObjectJson: upstream(contextId, 1, "Use a direct register."),
        nextObjectJson: upstream(contextId, 2, "Use a WARM, direct register."),
      };

      // No runner/model is accepted anywhere in the path — the service is
      // constructed with a repository alone and the impact set is a value.
      const first = await service.planInvalidation(request);
      const second = await service.planInvalidation(request);
      expect(second.impactSetHash).toBe(first.impactSetHash);
      expect(second).toEqual(first);

      // The core is a PURE synchronous function of (change set, edges): computed
      // twice off the same inputs it is identical, with no I/O in between.
      const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
      const changeSet = diffUpstreamObject(request.priorObjectJson, request.nextObjectJson);
      const edges = await wiki.queryDependents({ upstreamObjectId: UPSTREAM_ID });
      expect(computeImpactSet(changeSet, edges).impactSetHash).toBe(
        computeImpactSet(changeSet, edges).impactSetHash,
      );
      expect(computeImpactSet(changeSet, edges).impactSetHash).toBe(first.impactSetHash);
    } finally {
      await context.close();
    }
  });
});

function byObject(impact: ImpactSet, objectId: string): ImpactedConsumer {
  const consumer = impact.consumers.find((candidate) => candidate.downstreamObjectId === objectId);
  if (!consumer) throw new Error(`expected ${objectId} in the impact set`);
  return consumer;
}

/** The upstream object at a version, with one body field parameterized so a
 * one-field change is exactly that: a single differing leaf. */
function upstream(contextId: string, version: number, registerPolicy: string): unknown {
  return {
    ...wikiObjectExample,
    objectId: UPSTREAM_ID,
    version,
    ...(version > 1 ? { supersedesVersion: version - 1 } : {}),
    scope: R1,
    body: { ...wikiObjectExample.body, registerPolicy },
    claims: [{ ...wikiObjectExample.claims[0], scope: R1 }],
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  };
}

function consumer(
  contextId: string,
  objectId: string,
  dependencies: DependencyRef[],
  editedBy: "human" | "agent",
): unknown {
  return {
    ...wikiObjectExample,
    objectId,
    dependencies,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId, editedBy },
  };
}

function fieldDep(fieldPath: readonly string[], scope: DependencyRef["scope"]): DependencyRef {
  return {
    upstreamObjectId: UPSTREAM_ID,
    upstreamVersion: 1,
    claimId: null,
    fieldPath: [...fieldPath],
    renderingId: null,
    scope,
    fromPlayOrder: null,
    throughPlayOrder: null,
  };
}

function claimDep(claimId: string, scope: DependencyRef["scope"]): DependencyRef {
  return {
    upstreamObjectId: UPSTREAM_ID,
    upstreamVersion: 1,
    claimId,
    fieldPath: [],
    renderingId: null,
    scope,
    fromPlayOrder: null,
    throughPlayOrder: null,
  };
}

async function seed(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
): Promise<{ service: ScopedInvalidationService; contextId: string }> {
  const contextId = await putContextSnapshot(context);
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const options = { expectedHead: null, createdAt: CREATED_AT };

  await persistWikiObject(wiki, upstream(contextId, 1, "Use a direct register."), options);
  // Five consumers of ONE upstream object, each consuming a different piece or
  // under a different scope. Only the two in-route register-policy consumers are
  // reached by a register-policy change.
  await persistWikiObject(
    wiki,
    consumer(contextId, "wiki:consumer:field", [fieldDep(CHANGED_FIELD, R1)], "agent"),
    options,
  );
  await persistWikiObject(
    wiki,
    consumer(contextId, "wiki:consumer:human", [fieldDep(CHANGED_FIELD, R1)], "human"),
    options,
  );
  await persistWikiObject(
    wiki,
    consumer(
      contextId,
      "wiki:consumer:honorific",
      [fieldDep(["body", "honorificPolicy"], R1)],
      "agent",
    ),
    options,
  );
  await persistWikiObject(
    wiki,
    consumer(contextId, "wiki:consumer:claim", [claimDep("claim:style:1", R1)], "agent"),
    options,
  );
  await persistWikiObject(
    wiki,
    consumer(contextId, "wiki:consumer:outofscope", [fieldDep(CHANGED_FIELD, R2)], "agent"),
    options,
  );

  return { service: new ScopedInvalidationService({ wiki }), contextId };
}

/** Unrelated artifacts across the pipeline layers the guarantee names: a source
 * object, a memoized call, an accepted unit, and a patch-bound localized
 * rendering. None cites the changed upstream, so none may move. */
async function seedUnrelatedArtifacts(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  contextId: string,
): Promise<void> {
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const options = { expectedHead: null, createdAt: CREATED_AT };
  await persistWikiObject(wiki, consumer(contextId, "wiki:unrelated:src", [], "agent"), options);
  const localization = await new ItotoriLlmSnapshotRepository(context.pool).putLocalization({
    contextSnapshotId: contextId,
    targetLocale: "en-US",
    localeBranchId: "branch:1",
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  });
  await persistLocalizedRendering(
    wiki,
    {
      ...localizedRenderingExample,
      renderingId: "rendering:unrelated",
      sourceObjectId: "wiki:unrelated:src",
      provenance: {
        ...localizedRenderingExample.provenance,
        localizationSnapshotId: localization.snapshotId,
      },
    },
    options,
  );
  const memoKey = hashOf("memo");
  await context.pool.query(
    `insert into itotori_llm_call_memos (
       memo_key, semantic_hash, schema_version,
       request_ciphertext, request_key_ref, request_content_hash,
       response_ciphertext, response_key_ref, response_content_hash,
       outcome_ciphertext, outcome_key_ref, outcome_content_hash,
       outcome_kind, verification_status, generation_id, requested_model,
       provider_policy, served_model, served_provider, served_pair_status,
       billing_state, cost_usd, completed_at, retention_deadline
     ) values ($1,$2,'schema:1',$3,'k',$4,$3,'k',$5,$3,'k',$6,'terminal','verified',
       'gen:1','m','{}'::jsonb,'m','p','confirmed','billing_unknown',null,$7::timestamptz,$7::timestamptz)`,
    [
      memoKey,
      hashOf("memo-sem"),
      Buffer.from([0]),
      hashOf("req"),
      hashOf("resp"),
      hashOf("outcome"),
      CREATED_AT,
    ],
  );
  await context.pool.query(
    `insert into itotori_llm_accepted_outputs (
       output_id, semantic_key, schema_version, output_version, supersedes_output_id,
       parent_output_ids, memo_keys, snapshot_kind, snapshot_id, subject_type, subject_id,
       stage, source_hash, output_ciphertext, output_key_ref, output_content_hash,
       accepted_at, retention_deadline, deletion_state
     ) values ('accepted:unit:99',$1,'schema:1',1,null,'{}',array[$2],'localization',$3,'unit','unit:99',
       'final',$4,$5,'k',$6,$7::timestamptz,$7::timestamptz,'active')`,
    [
      hashOf("accepted-sem"),
      memoKey,
      hashOf("snap"),
      hashOf("src"),
      Buffer.from([0]),
      hashOf("accepted"),
      CREATED_AT,
    ],
  );
}

async function artifactHashes(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<{
  wiki: unknown;
  memos: unknown;
  accepted: unknown;
  unrelatedObject: string;
  patch: string;
  memo: string;
  acceptedUnit: string;
  deletionStates: unknown[];
}> {
  const wiki = await pool.query(
    "select object_id, object_version, wiki_content_hash from itotori_llm_wiki_versions order by wiki_version_id",
  );
  const memos = await pool.query(
    "select memo_key, request_content_hash, response_content_hash, outcome_content_hash from itotori_llm_call_memos order by memo_key",
  );
  const accepted = await pool.query(
    "select output_id, output_content_hash from itotori_llm_accepted_outputs order by output_id",
  );
  const deletionStates = await pool.query(
    "select wiki_version_id from itotori_llm_wiki_versions where deletion_state <> 'active' order by wiki_version_id",
  );
  return {
    wiki: wiki.rows,
    memos: memos.rows,
    accepted: accepted.rows,
    unrelatedObject: hashFor(wiki.rows, "object_id", "wiki:unrelated:src", "wiki_content_hash"),
    patch: hashFor(wiki.rows, "object_id", "rendering:unrelated", "wiki_content_hash"),
    memo: hashFor(memos.rows, "memo_key", hashOf("memo"), "response_content_hash"),
    acceptedUnit: hashFor(accepted.rows, "output_id", "accepted:unit:99", "output_content_hash"),
    deletionStates: deletionStates.rows,
  };
}

function hashFor(
  rows: readonly Record<string, unknown>[],
  keyColumn: string,
  keyValue: string,
  hashColumn: string,
): string {
  const row = rows.find((candidate) => candidate[keyColumn] === keyValue);
  if (!row) throw new Error(`no row where ${keyColumn}=${keyValue}`);
  return String(row[hashColumn]);
}

async function consumerRow(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  objectId: string,
): Promise<{ wiki_content_hash: string; deletion_state: string; provenance_edited_by: string }> {
  const result = await pool.query<{
    wiki_content_hash: string;
    deletion_state: string;
    provenance_edited_by: string;
  }>(
    "select wiki_content_hash, deletion_state, provenance_edited_by from itotori_llm_wiki_versions where object_id = $1",
    [objectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no consumer ${objectId}`);
  return row;
}

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
