import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  FACT_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  type DraftBatch,
  type UnitFact,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import type { LocalizerRuntimeBase } from "../src/roles/p1/index.js";
import {
  assembleFinalizedDrafts,
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  buildLocalizerCall,
  dispatchLocalizerCall,
  localizeScene,
  normalizeScene,
  planSceneLocalization,
  FinalizeError,
  PlanError,
} from "../src/roles/p1/index.js";
import { specialistFor } from "../src/roster/index.js";
import { confirmedGenerationMetadataSource } from "./llm-step-test-support.js";

// The certified P1 draft profile — its name/version must match the P1 call spec.
const DRAFT_PROFILE: MeasuredModelProfile = {
  name: "draft",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1",
};

const CTX = `sha256:${"a".repeat(64)}` as const;
const LOC = `sha256:${"b".repeat(64)}` as const;
const SCHEMA = `sha256:${"c".repeat(64)}` as const;
const REV_A = `sha256:${"d".repeat(64)}` as const;
const REV_B = `sha256:${"e".repeat(64)}` as const;
const BIBLE = ["rendering:1"] as const;

// ── an in-memory, offline memo store (no DB); the recorded transport path ─────
class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attempts = new Map<string, number>();
  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash)
        throw new LlmMemoConflictError(input.memoKey);
      return { ...existing, memoHit: true };
    }
    const ordinal = (this.#attempts.get(input.memoKey) ?? 0) + 1;
    if (ordinal > 3) throw new LlmRetriesExhaustedError(input.memoKey);
    this.#attempts.set(input.memoKey, ordinal);
    const execution = await input.execute({ ordinal, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: ordinal,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(
    "",
  );
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function draftBatchResponse(batch: DraftBatch): Response {
  const id = "generation:p1";
  const base = {
    id,
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    object: "chat.completion.chunk",
  };
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: JSON.stringify(batch) },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] },
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 30,
        total_tokens: 70,
        cost: 0.0000025, // itotori-225-audit-allow: synthetic recorded-transport usage for the offline proof, not a billed cost
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  ]);
}

interface Captured {
  body: Record<string, unknown>;
}

function recordedRuntime(
  responses: readonly Response[],
  captured: Captured[],
): LocalizerRuntimeBase {
  const queue = [...responses];
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: DRAFT_PROFILE,
      admission: { scope: "test:p1", confirmedCostCapUsd: "10" },
      generationMetadataSource: confirmedGenerationMetadataSource(),
      snapshots: {
        decodeRevisionHash: REV_A,
        glossaryRevisionHash: REV_B,
        styleRevisionHash: REV_A,
        acceptedOutputHeadHash: REV_B,
      },
    },
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      captured.push({ body: (await request.clone().json()) as Record<string, unknown> });
      const response = queue.shift();
      if (!response) throw new Error("unexpected extra provider request");
      return response;
    },
  };
}

// ── deterministic source-skeleton fixtures ───────────────────────────────────
function pad(base: string, bytes: number): string {
  return base.length >= bytes ? base.slice(0, bytes) : base + "-".repeat(bytes - base.length);
}

type Placeholder = {
  placeholderId: string;
  kind: "control-markup" | "variable" | "ruby";
  sourceText: string;
};

/** Un-mask a skeleton into its raw source surface — the canonical inverse the
 * source surface (required by the fact schema). */
function unmask(skeleton: string, placeholders: readonly Placeholder[]): string {
  const byId = new Map(placeholders.map((p) => [p.placeholderId, p.sourceText]));
  return skeleton.replace(/\{\{([^{}]+)\}\}/gu, (_match, id: string) => byId.get(id) ?? _match);
}

/** A coherent decode source fact. `overridePlaceholders` lets a test build a
 * DELIBERATELY malformed manifest (one that disagrees with the skeleton). */
function unitFact(
  index: number,
  options: {
    sceneId?: string;
    skeleton?: string;
    placeholders?: readonly Placeholder[];
    overridePlaceholders?: readonly Placeholder[];
  } = {},
): UnitFact {
  const sceneId = options.sceneId ?? "6010";
  const unitId = `unit:${sceneId}:${index}`;
  const skeleton = options.skeleton ?? pad(`s${index}`, 10);
  const placeholders = [...(options.placeholders ?? [])];
  const surface = unmask(skeleton, placeholders);
  const value = {
    kind: "unit" as const,
    unitId,
    bridgeUnitId: `bridge:${unitId}`,
    sceneId,
    playOrderIndex: index,
    sourceHash: sha256(surface),
    sourceSurface: surface,
    sourceSkeleton: skeleton,
    surfaceKind: "dialogue" as const,
    speaker: null,
    choiceContext: null,
    protectedPlaceholders: [...(options.overridePlaceholders ?? placeholders)],
    sourceAssetRef: "asset:seen",
    byteOffset: index * 100,
    byteLength: 40,
    rawByteHandle: `bridge:${unitId}`,
    routeScopes: [{ kind: "global" as const }],
  };
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    factId: unitId,
    snapshotId: CTX,
    hash: sha256(value),
    visibility: { routeScope: { kind: "global" }, fromPlayOrder: index, throughPlayOrder: null },
    source: "decode",
    value,
  };
}

function draftFor(unit: UnitFact, uncertainty: string[] = ["none"]) {
  return {
    unitId: unit.value.unitId,
    sourceHash: unit.value.sourceHash,
    targetSkeleton: `EN>${unit.value.sourceSkeleton}`,
    evidenceIds: [`fact:${unit.value.unitId}`],
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
    uncertainty,
  };
}

function wholeSceneBatch(
  sceneId: string,
  units: readonly UnitFact[],
  flags: Record<string, string[]> = {},
): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `draft:${sceneId}:whole`,
    scope: { kind: "whole-scene", sceneId, expectedUnitIds: units.map((u) => u.value.unitId) },
    drafts: units.map((u) => draftFor(u, flags[u.value.unitId] ?? ["none"])),
  } as DraftBatch;
}

function chunkBatch(
  sceneId: string,
  all: readonly UnitFact[],
  coreIds: readonly string[],
  overlapIds: readonly string[],
  chunkIndex: number,
  chunkCount: number,
): DraftBatch {
  const byId = new Map(all.map((u) => [u.value.unitId, u]));
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `draft:${sceneId}:${chunkIndex}`,
    scope: {
      kind: "overlapping-chunk",
      sceneId,
      chunkIndex,
      chunkCount,
      coreUnitIds: [...coreIds],
      overlapUnitIds: [...overlapIds],
    },
    drafts: coreIds.map((id) => draftFor(byId.get(id)!)),
  } as DraftBatch;
}

const BASE = {
  contextSnapshotId: CTX,
  localizationSnapshotId: LOC,
  schemaHash: SCHEMA,
  runMode: "test-dev" as const,
  contextScope: "whole-game" as const,
};

describe("P1 whole-scene localizer — whole-scene mode", () => {
  it("emits exact cardinality, order, and source hashes for a complete scene", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const batch = wholeSceneBatch("6010", units, { "unit:6010:2": ["term"] });
    const captured: Captured[] = [];
    const result = await localizeScene(
      { ...BASE, units, bibleRenderingIds: BIBLE, budgetBytes: 10_000, overlapUnits: 1 },
      recordedRuntime([draftBatchResponse(batch)], captured),
    );

    expect(result.mode).toBe("whole-scene");
    expect(result.plan.segments).toHaveLength(1);
    // EXACT CARDINALITY: one finalized unit per source unit, no more, no fewer.
    expect(result.finalizedDrafts).toHaveLength(units.length);
    // EXACT ORDER + SOURCE HASH: finalized ids/hashes equal the source, in order.
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    expect(result.finalizedDrafts.map((d) => d.sourceHash)).toEqual(
      units.map((u) => u.value.sourceHash),
    );
    // TYPED uncertainty surfaces (never a silent guess).
    expect(result.uncertainUnits).toEqual([{ unitId: "unit:6010:2", uncertainty: ["term"] }]);
    // dispatched through the sole ZDR boundary: no provider pin, exact model.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    expect(result.results.every((r) => r.status === "success")).toBe(true);
  });

  it("preserves protected placeholders and rejects a dropped one", () => {
    const placeholders = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
    const units = [unitFact(0, { skeleton: "hp {{ph:0}} left", placeholders })];
    const scene = normalizeScene(units);
    const good = wholeSceneBatch("6010", units);
    expect(() => assertPlaceholdersPreserved(scene.units, good.drafts)).not.toThrow();

    const dropped = {
      ...good,
      drafts: [{ ...good.drafts[0]!, targetSkeleton: "hp left" }],
    } as DraftBatch;
    expect(() => assertPlaceholdersPreserved(scene.units, dropped.drafts)).toThrow(FinalizeError);
  });
});

describe("P1 whole-scene localizer — overlapping-chunk mode", () => {
  const units = [0, 1, 2, 3, 4, 5].map((index) =>
    unitFact(index, { skeleton: pad(`c${index}`, 10) }),
  );
  const sceneId = "6010";

  it("chunks only when the measured limit requires it and cores partition the scene exactly", () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    expect(plan.mode).toBe("overlapping-chunks");
    const chunks = plan.segments.filter((s) => s.mode === "overlapping-chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The cores COVER every unit exactly once, in play order (a partition).
    const cores = chunks.flatMap((s) => (s.mode === "overlapping-chunk" ? s.coreUnitIds : []));
    expect(cores).toEqual(units.map((u) => u.value.unitId));
    // Cores are pairwise DISJOINT (no unit appears in two cores).
    expect(new Set(cores).size).toBe(cores.length);
    // Overlap regions are context only — never part of any core.
    for (const s of chunks) {
      if (s.mode !== "overlapping-chunk") continue;
      const coreSet = new Set(s.coreUnitIds);
      expect(s.overlapUnitIds.some((id) => coreSet.has(id))).toBe(false);
      // Every dispatched prompt window stays within the measured budget.
      const promptBytes = s.promptUnitIds.reduce(
        (sum, id) =>
          sum + Buffer.byteLength(scene.units.find((u) => u.unitId === id)!.sourceSkeleton, "utf8"),
        0,
      );
      expect(promptBytes).toBeLessThanOrEqual(40);
    }
  });

  it("finalizes ONLY non-overlap cores and continues the thread with prior accepted target", async () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const chunkSegs = plan.segments.filter((s) => s.mode === "overlapping-chunk");
    const responses = chunkSegs.map((s) =>
      s.mode === "overlapping-chunk"
        ? draftBatchResponse(
            chunkBatch(sceneId, units, s.coreUnitIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount),
          )
        : draftBatchResponse(wholeSceneBatch(sceneId, units)),
    );
    const captured: Captured[] = [];
    const result = await localizeScene(
      { ...BASE, units, bibleRenderingIds: BIBLE, budgetBytes: 40, overlapUnits: 1 },
      recordedRuntime(responses, captured),
    );

    expect(result.mode).toBe("overlapping-chunks");
    // Exactly one finalized draft per source unit — no double-finalize across the
    // overlapping chunks — in source order, with matching hashes.
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    expect(new Set(result.finalizedDrafts.map((d) => d.unitId)).size).toBe(units.length);
    expect(() => assertExactAgainstSource(scene.units, result.finalizedDrafts)).not.toThrow();

    // THREAD CONTINUATION: chunk 1's dispatched call carries chunk 0's accepted
    // target forward as an assistant author-thread turn.
    const chunk1 = chunkSegs[1]!;
    const prior = new Map<string, string>();
    for (const id of chunkSegs[0]!.mode === "overlapping-chunk" ? chunkSegs[0]!.coreUnitIds : []) {
      prior.set(id, `EN>${units.find((u) => u.value.unitId === id)!.value.sourceSkeleton}`);
    }
    const call = buildLocalizerCall({
      specialist: specialistFor("P1"),
      segment: chunk1,
      unitsById: new Map(scene.units.map((u) => [u.unitId, u])),
      bibleRenderingIds: BIBLE,
      priorAcceptedTarget: prior,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    const threadMessages = call.spec.messages.filter(
      (m) => m.kind === "text" && m.role === "assistant",
    );
    expect(threadMessages).toHaveLength(1);
    const threadRef =
      threadMessages[0]!.kind === "text" ? threadMessages[0]!.contentEncrypted.storageRef : "";
    const threadText = call.payloads.get(threadRef)!;
    const leadingOverlap =
      chunk1.mode === "overlapping-chunk"
        ? chunk1.overlapUnitIds.filter((id) => prior.has(id))
        : [];
    expect(leadingOverlap.length).toBeGreaterThan(0);
    for (const id of leadingOverlap) {
      expect(threadText).toContain(
        `EN>${units.find((u) => u.value.unitId === id)!.value.sourceSkeleton}`,
      );
    }
  });

  it("rejects a batch that would finalize an overlap (context) unit — no double-finalize", () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const segs = plan.segments;
    const forged = segs.map((s, index) => {
      if (s.mode !== "overlapping-chunk") return wholeSceneBatch(sceneId, units);
      // Chunk 0 illegally emits a draft for a trailing OVERLAP unit as if it were core.
      const coreIds = index === 0 ? [...s.coreUnitIds, s.overlapUnitIds[0]!] : s.coreUnitIds;
      return chunkBatch(sceneId, units, coreIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount);
    });
    // The forged chunk-0 batch is itself invalid (core/overlap not disjoint) — build
    // it directly to exercise the finalize guard on a well-formed-but-wrong batch.
    const guarded = segs.map((s) =>
      s.mode === "overlapping-chunk"
        ? chunkBatch(sceneId, units, s.coreUnitIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount)
        : wholeSceneBatch(sceneId, units),
    );
    // Move a core unit's draft into an earlier chunk's drafts → double-finalize.
    const clash = guarded.map((b) => ({ ...b }) as DraftBatch);
    (clash[0]!.drafts as unknown[]).push(clash[1]!.drafts[0]!);
    expect(() => assembleFinalizedDrafts(plan.segments, clash)).toThrow(FinalizeError);
    void forged;
  });
});

describe("P1 whole-scene localizer — exactness guards", () => {
  const units = [0, 1, 2].map((index) => unitFact(index));
  const scene = normalizeScene(units);

  it("rejects a wrong source hash, a missing unit, and a reordering", () => {
    const good = wholeSceneBatch("6010", units).drafts;
    expect(() => assertExactAgainstSource(scene.units, good)).not.toThrow();

    const wrongHash = [{ ...good[0]!, sourceHash: `sha256:${"0".repeat(64)}` }, good[1]!, good[2]!];
    expect(() => assertExactAgainstSource(scene.units, wrongHash)).toThrow(/source-hash/u);

    expect(() => assertExactAgainstSource(scene.units, [good[0]!, good[1]!])).toThrow(
      /unit-cardinality/u,
    );

    const reordered = [good[1]!, good[0]!, good[2]!];
    expect(() => assertExactAgainstSource(scene.units, reordered)).toThrow(/unit-order/u);
  });

  it("fails loud when a single unit exceeds the whole context budget", () => {
    const big = normalizeScene([unitFact(0, { skeleton: pad("big", 200) })]);
    expect(() => planSceneLocalization(big, { budgetBytes: 50, overlapUnits: 1 })).toThrow(
      PlanError,
    );
  });
});

// End-to-end rejection tests: malformed / forged inputs travel the SAME public
// entry (localizeScene / dispatchLocalizerCall) a real caller uses, and the run
// is refused BEFORE any tainted or mis-routed request reaches the wire.
describe("P1 whole-scene localizer — end-to-end rejection", () => {
  it("(a) rejects a source skeleton whose placeholder manifest is malformed", async () => {
    // A manifest that omits a {{ph}} token actually present in the skeleton would
    // let a dropped variable slip through the byte-level patch — reject it loud.
    const manifestGap = unitFact(0, {
      skeleton: "HP {{ph:0}} left",
      placeholders: [{ placeholderId: "ph:0", kind: "variable", sourceText: "%d" }],
      overridePlaceholders: [],
    });
    const captured: Captured[] = [];
    await expect(
      localizeScene(
        {
          ...BASE,
          units: [manifestGap],
          bibleRenderingIds: BIBLE,
          budgetBytes: 10_000,
          overlapUnits: 1,
        },
        recordedRuntime([], captured),
      ),
    ).rejects.toThrow(/malformed-source-skeleton/u);
    // Nothing was dispatched — the malformed skeleton was refused up front.
    expect(captured).toHaveLength(0);
  });

  it("(b) never dispatches an unvalidated (scope-forged) target into the author thread", async () => {
    const sceneUnits = [0, 1, 2, 3, 4, 5].map((index) =>
      unitFact(index, { skeleton: pad(`c${index}`, 10) }),
    );
    const scene = normalizeScene(sceneUnits);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const chunk0 = plan.segments[0]!;
    if (chunk0.mode !== "overlapping-chunk") throw new Error("expected a chunked plan");
    // Forge a schema-valid first chunk that declares a PLAN-OVERLAP unit as its
    // own core, carrying a target that was never accepted under P1's scope.
    const forgedCore = [...chunk0.coreUnitIds, chunk0.overlapUnitIds[0]!];
    const forgedBatch = {
      schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
      localizationSnapshotId: LOC,
      batchId: "draft:6010:forged",
      scope: {
        kind: "overlapping-chunk" as const,
        sceneId: "6010",
        chunkIndex: 0,
        chunkCount: chunk0.chunkCount,
        coreUnitIds: forgedCore,
        overlapUnitIds: [],
      },
      drafts: forgedCore.map((id) => ({
        unitId: id,
        sourceHash: sceneUnits.find((u) => u.value.unitId === id)!.value.sourceHash,
        targetSkeleton: id === chunk0.overlapUnitIds[0] ? "FORGED-UNACCEPTED-TARGET" : `EN>${id}`,
        evidenceIds: [`fact:${id}`],
        basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
        uncertainty: ["none"],
      })),
    } as DraftBatch;

    const captured: Captured[] = [];
    await expect(
      localizeScene(
        { ...BASE, units: sceneUnits, bibleRenderingIds: BIBLE, budgetBytes: 40, overlapUnits: 1 },
        recordedRuntime([draftBatchResponse(forgedBatch)], captured),
      ),
    ).rejects.toThrow(FinalizeError);
    // Only the FIRST chunk was dispatched; validation refused the forged batch
    // BEFORE the thread could carry its target into a second request.
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("FORGED-UNACCEPTED-TARGET");
  });

  it("(c) rejects a test-dev wrong-model call at the public dispatch boundary", async () => {
    const units = [unitFact(0)];
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 10_000, overlapUnits: 1 });
    const call = buildLocalizerCall({
      specialist: specialistFor("P1"),
      segment: plan.segments[0]!,
      unitsById: new Map(scene.units.map((u) => [u.unitId, u])),
      bibleRenderingIds: BIBLE,
      priorAcceptedTarget: new Map(),
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    // Forge only the model — exactly the test-dev escape the audit exercised.
    const forged = { ...call, spec: { ...call.spec, requestedModel: "openai/gpt-4.1" } };
    const captured: Captured[] = [];
    await expect(
      dispatchLocalizerCall(
        forged,
        recordedRuntime([draftBatchResponse(wholeSceneBatch("6010", units))], captured),
      ),
    ).rejects.toThrow(/certified deepseek-v4-flash/u);
    // The re-routed call never reached the wire.
    expect(captured).toHaveLength(0);
  });
});

describe("P1 whole-scene localizer — prior accepted target thread", () => {
  it("continues the thread with prior accepted target supplied through localizeScene", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    // Prior accepted target for an in-prompt unit, from the trusted accepted-
    // output store. A plain typed value — no provenance proof, just substrate.
    const prior = [{ unitId: "unit:6010:0", targetSkeleton: "EN>ACCEPTED-PRIOR-TARGET" }];
    const captured: Captured[] = [];
    const result = await localizeScene(
      {
        ...BASE,
        units,
        bibleRenderingIds: BIBLE,
        priorAcceptedTarget: prior,
        budgetBytes: 10_000,
        overlapUnits: 1,
      },
      recordedRuntime([draftBatchResponse(wholeSceneBatch("6010", units))], captured),
    );
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    // The prior accepted target continues the author thread on the wire.
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).toContain("ACCEPTED-PRIOR-TARGET");
  });
});
