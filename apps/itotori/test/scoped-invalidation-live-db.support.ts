import { createHash } from "node:crypto";
import {
  ItotoriLlmAcceptedOutputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import type { DependencyRef } from "../src/contracts/index.js";
import { dispatch } from "../src/llm/dispatch.js";
import {
  bindScopedTargets,
  buildPatchExportV02,
  type NativePatchbackInput,
} from "../src/patchback/index.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import {
  ScopedInvalidationService,
  computeImpactSet,
  diffUpstreamObject,
  type ImpactSet,
  type ImpactedConsumer,
} from "../src/wiki/scoped-invalidation/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  localizedRenderingExample,
  reviewVerdictExample,
  wikiObjectExample,
} from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";
import { buildRb024Snapshot, loadBridgeBundle, makeAccepted } from "./support/gate-fixtures.js";

export const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

export const CREATED_AT = "2026-07-15T12:00:00.000Z";

export const UPSTREAM_ID = "wiki:upstream:1";

export const CHANGED_FIELD = ["body", "registerPolicy"] as const;

export const R1 = { kind: "route", routeId: "route:r1" } as const;

export const R2 = { kind: "route", routeId: "route:r2" } as const;

export function byObject(impact: ImpactSet, objectId: string): ImpactedConsumer {
  const consumer = impact.consumers.find((candidate) => candidate.downstreamObjectId === objectId);
  if (!consumer) throw new Error(`expected ${objectId} in the impact set`);
  return consumer;
}

export function upstream(contextId: string, version: number, registerPolicy: string): unknown {
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

export function consumer(
  contextId: string,
  objectId: string,
  dependencies: DependencyRef[],
  editedBy: "human" | "agent",
  version = 1,
): unknown {
  return {
    ...wikiObjectExample,
    objectId,
    version,
    ...(version > 1 ? { supersedesVersion: version - 1 } : {}),
    dependencies,
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId, editedBy },
  };
}

export function fieldDep(
  fieldPath: readonly string[],
  scope: DependencyRef["scope"],
): DependencyRef {
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

export function claimDep(claimId: string, scope: DependencyRef["scope"]): DependencyRef {
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

export async function seed(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
): Promise<{ service: ScopedInvalidationService; contextId: string }> {
  const contextId = await putContextSnapshot(context);
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const options = { expectedHead: null, createdAt: CREATED_AT };

  await persistWikiObject(wiki, upstream(contextId, 1, "Use a direct register."), options);
  // Six consumers of ONE upstream object, each consuming a different piece or
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
  // The OLD version cited registerPolicy, but the current v2 version no longer
  // does. Historical consumption must not leak into the current work set.
  const superseded = await persistWikiObject(
    wiki,
    consumer(contextId, "wiki:consumer:changed-mind", [fieldDep(CHANGED_FIELD, R1)], "agent"),
    options,
  );
  await persistWikiObject(wiki, consumer(contextId, "wiki:consumer:changed-mind", [], "agent", 2), {
    expectedHead: superseded,
    createdAt: CREATED_AT,
  });

  return { service: new ScopedInvalidationService({ wiki }), contextId };
}

export async function seedUnrelatedArtifacts(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  contextId: string,
): Promise<() => number> {
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
  // Exercise the LLM dispatch primitive through its production dispatch/memo
  // boundary. The recorded response keeps this test offline; a second
  // identical dispatch proves the durable memo absorbs a restart/replay
  // without a second call.
  const prompt = "Return the recorded unrelated review verdict.";
  const harness = dispatchHarness({
    pool: context.pool,
    cipher,
    prompt,
    responses: [structuredProviderResponse(reviewVerdictExample)],
  });
  const first = await dispatch(physicalCallSpec(prompt), harness.runtime);
  if (first.status !== "success") throw new Error("expected a persisted unrelated memo");
  const replayed = await dispatch(physicalCallSpec(prompt), harness.runtime);
  if (replayed.status !== "success") throw new Error("expected a replayed unrelated memo");
  expect(replayed.memoKey).toBe(first.memoKey);
  expect(harness.transportCalls()).toBe(1);

  // The accepted unit is committed through its CAS repository against that
  // verified durable memo, not planted by SQL. It is unrelated to the changed
  // wiki object and must remain content-identical after planning impact.
  await new ItotoriLlmAcceptedOutputRepository(context.pool, cipher).acceptAndAdvance({
    outputId: "accepted:unit:99",
    semanticKey: hashOf("accepted-sem"),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: 1,
    supersedesOutputId: null,
    parentOutputIds: [],
    memoKeys: [first.memoKey],
    snapshotKind: "localization",
    snapshotId: localization.snapshotId,
    subjectType: "unit",
    subjectId: "unit:99",
    stage: "final",
    sourceHash: hashOf("src"),
    outputJson: JSON.stringify({ target: "unrelated accepted target" }),
    acceptedAt: CREATED_AT,
    expectedHead: null,
  });
  return harness.transportCalls;
}

export async function artifactHashes(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<{
  wiki: unknown;
  memos: unknown;
  accepted: unknown;
  unrelatedObject: string;
  localizedRendering: string;
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
    localizedRendering: hashFor(wiki.rows, "object_id", "rendering:unrelated", "wiki_content_hash"),
    memo: onlyHash(memos.rows, "response_content_hash"),
    acceptedUnit: hashFor(accepted.rows, "output_id", "accepted:unit:99", "output_content_hash"),
    deletionStates: deletionStates.rows,
  };
}

export function onlyHash(rows: readonly Record<string, unknown>[], hashColumn: string): string {
  if (rows.length !== 1) throw new Error(`expected one row holding ${hashColumn}`);
  return String(rows[0]![hashColumn]);
}

export function hashFor(
  rows: readonly Record<string, unknown>[],
  keyColumn: string,
  keyValue: string,
  hashColumn: string,
): string {
  const row = rows.find((candidate) => candidate[keyColumn] === keyValue);
  if (!row) throw new Error(`no row where ${keyColumn}=${keyValue}`);
  return String(row[hashColumn]);
}

export function unrelatedPatchExportHash(): `sha256:${string}` {
  const snapshot = buildRb024Snapshot();
  const bridge = loadBridgeBundle();
  const bridgeUnitById = new Map(bridge.units.map((unit) => [unit.bridgeUnitId, unit]));
  const accepted = snapshot.orderedUnits.map((unit, index) => {
    const protectedBody = (bridgeUnitById.get(unit.bridgeUnitId)?.spans ?? [])
      .filter((span) => span.outOfBand !== true)
      .map((span) => span.raw)
      .join("");
    return makeAccepted(unit, `[EN ${index}] ${unit.sourceUnitKey}${protectedBody}`);
  });
  const input: NativePatchbackInput = {
    snapshot,
    accepted,
    rawBridge: bridge,
    workScope: { inScopeUnitFactIds: snapshot.orderedUnits.map((unit) => unit.factId) },
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
  };
  return hashOf(JSON.stringify(buildPatchExportV02(input, bindScopedTargets(input))));
}

export async function consumerRow(
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

export async function putContextSnapshot(
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

export function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

export function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
