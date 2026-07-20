import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  DEFECT_BUNDLE_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  FACT_SCHEMA_VERSION,
  type DefectBundle,
  type Draft,
  type DraftBatch,
  type UnitFact,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { realliveSjisPolicy } from "../src/gates/index.js";
import {
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  assertRepairPatchMatchesScope,
  assertTargetEncodable,
  buildEditCall,
  deriveEditScope,
  dispatchEditCall,
  editLine,
  mergePatch,
  EditError,
  FinalizeError,
  type EditorRuntimeBase,
} from "../src/roles/p2/index.js";
import { specialistFor } from "../src/roster/index.js";

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
const PARENT = "draft:6010:whole";
const BUNDLE = "bundle:6010:1";

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
  const base = {
    id: "generation:p2",
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

function recordedRuntime(responses: readonly Response[], captured: Captured[]): EditorRuntimeBase {
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
      admission: { scope: "test:p2", confirmedCostCapUsd: "10" },
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

function unmask(skeleton: string, placeholders: readonly Placeholder[]): string {
  const byId = new Map(placeholders.map((p) => [p.placeholderId, p.sourceText]));
  return skeleton.replace(/\{\{([^{}]+)\}\}/gu, (_match, id: string) => byId.get(id) ?? _match);
}

function unitFact(
  index: number,
  options: { skeleton?: string; placeholders?: readonly Placeholder[] } = {},
): UnitFact {
  const sceneId = "6010";
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
    protectedPlaceholders: placeholders,
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

function currentDraftOf(units: readonly UnitFact[]): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: PARENT,
    scope: {
      kind: "whole-scene",
      sceneId: "6010",
      expectedUnitIds: units.map((u) => u.value.unitId),
    },
    drafts: units.map((u) => ({
      unitId: u.value.unitId,
      sourceHash: u.value.sourceHash,
      targetSkeleton: `EN>${u.value.sourceSkeleton}`,
      evidenceIds: [`fact:${u.value.unitId}`],
      basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
      uncertainty: ["none"],
    })),
  } as DraftBatch;
}

function reviewerDefect(unitId: string, index: number) {
  return {
    origin: "reviewer" as const,
    defectId: `defect:${index}`,
    unitId,
    severity: "minor" as const,
    span: { spanId: `span:${index}`, surface: "target" as const, text: "tone" },
    evidenceIds: [`fact:${unitId}`],
    basisFactIds: [`fact:${unitId}`],
    repairConstraint: "soften the register by one notch",
    implicatedGates: [],
    implicatedReviewLanes: ["Q2" as const],
    category: "voice" as const,
    reviewId: `review:${index}`,
    reviewLane: "Q2" as const,
  };
}

function repairBundleFor(
  unitIds: readonly string[],
  resolution: DefectBundle["resolution"] = "repair",
): DefectBundle {
  return {
    schemaVersion: DEFECT_BUNDLE_SCHEMA_VERSION,
    bundleId: BUNDLE,
    localizationSnapshotId: LOC,
    draftBatchId: PARENT,
    defects: unitIds.map((id, i) => reviewerDefect(id, i)),
    factDominance: [],
    resolution,
  } as DefectBundle;
}

function patchDraftFor(units: readonly UnitFact[], unitId: string, targetSkeleton?: string): Draft {
  const source = units.find((u) => u.value.unitId === unitId)!;
  return {
    unitId,
    sourceHash: source.value.sourceHash,
    targetSkeleton: targetSkeleton ?? `EN-EDIT>${source.value.sourceSkeleton}`,
    evidenceIds: [`fact:${unitId}`],
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
    uncertainty: ["none"],
  };
}

function repairPatchBatch(
  units: readonly UnitFact[],
  implicated: readonly string[],
  overrides: { targets?: Record<string, string> } = {},
): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: "draft:6010:patch",
    scope: {
      kind: "repair-patch",
      parentDraftBatchId: PARENT,
      defectBundleId: BUNDLE,
      repairMode: "author-continuation",
      failedUnitIds: [...implicated],
    },
    drafts: implicated.map((id) => patchDraftFor(units, id, overrides.targets?.[id])),
  } as DraftBatch;
}

const BASE = {
  contextSnapshotId: CTX,
  localizationSnapshotId: LOC,
  schemaHash: SCHEMA,
  runMode: "test-dev" as const,
  contextScope: "whole-game" as const,
  bibleRenderingIds: BIBLE,
  policy: realliveSjisPolicy,
};

describe("P2 line editor — author-thread continuation over draft + defects + bible", () => {
  it("patches ONLY the implicated ids, continues the thread, and dispatches once via ZDR", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const implicated = ["unit:6010:1", "unit:6010:3"];
    const bundle = repairBundleFor(implicated);
    const patch = repairPatchBatch(units, implicated);
    const captured: Captured[] = [];
    const edit = await editLine(
      { ...BASE, currentDraft: current, defectBundle: bundle, units },
      recordedRuntime([draftBatchResponse(patch)], captured),
    );

    // AUTHOR-CONTINUATION repair for exactly the implicated units, in play order.
    expect(edit.repairMode).toBe("author-continuation");
    expect(edit.implicatedUnitIds).toEqual(implicated);
    expect(edit.patchBatch.scope).toMatchObject({
      kind: "repair-patch",
      repairMode: "author-continuation",
      parentDraftBatchId: PARENT,
      defectBundleId: BUNDLE,
      failedUnitIds: implicated,
    });
    // PATCHES ONLY IMPLICATED: the patch names no unimplicated unit.
    expect(edit.patchBatch.drafts.map((d) => d.unitId)).toEqual(implicated);

    // NEVER a whole-QA rerun / blind retranslation: exactly ONE dispatch, and the
    // seed carries only the implicated units — not the whole scene.
    expect(captured).toHaveLength(1);
    const wire = JSON.stringify(captured[0]);
    expect(wire).not.toContain("unit:6010:0");
    expect(wire).not.toContain("unit:6010:2");
    // The author thread carries the CURRENT authored line of the implicated units.
    expect(wire).toContain("EN>s1");
    expect(wire).toContain("EN>s3");
    // The changed basis is present: the defect's repair constraint + the bible.
    expect(wire).toContain("soften the register by one notch");
    expect(wire).toContain("rendering:1");

    // Dispatched through the sole ZDR boundary: exact model, no provider pin.
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
    expect(edit.result.status).toBe("success");
  });

  it("leaves every UNAFFECTED unit byte-identical after the merge (same bytes, same object)", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const implicated = ["unit:6010:1"];
    const bundle = repairBundleFor(implicated);
    const patch = repairPatchBatch(units, implicated);
    const captured: Captured[] = [];
    const edit = await editLine(
      { ...BASE, currentDraft: current, defectBundle: bundle, units },
      recordedRuntime([draftBatchResponse(patch)], captured),
    );

    expect(edit.patchedDrafts).toHaveLength(units.length);
    // The implicated unit took the patched line.
    const patched = edit.patchedDrafts.find((d) => d.unitId === "unit:6010:1")!;
    expect(patched.targetSkeleton).toBe("EN-EDIT>s1--------");
    // Every unaffected unit is BYTE-IDENTICAL — the same object reference the
    // current draft carried, so not a single byte changed.
    for (const id of ["unit:6010:0", "unit:6010:2", "unit:6010:3"]) {
      const before = current.drafts.find((d) => d.unitId === id)!;
      const after = edit.patchedDrafts.find((d) => d.unitId === id)!;
      expect(after).toBe(before);
      expect(after.targetSkeleton).toBe(before.targetSkeleton);
    }
  });

  it("rejects a patch that carries an UNIMPLICATED unit — an unaffected unit may not be touched", () => {
    const units = [0, 1, 2].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);
    // A well-formed patch batch that ALSO carries an unimplicated unit's line.
    const forged = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      drafts: [patchDraftFor(units, "unit:6010:1"), patchDraftFor(units, "unit:6010:0")],
    } as DraftBatch;
    expect(() => mergePatch(current, scope, forged, realliveSjisPolicy)).toThrow(
      /unaffected-mutated/u,
    );
  });
});

describe("P2 line editor — output preserves placeholders, spans, and Shift-JIS", () => {
  const placeholders = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
  const units = [
    unitFact(0),
    unitFact(1, { skeleton: "hp {{ph:0}} left", placeholders }),
    unitFact(2),
  ];
  const current = currentDraftOf(units);
  const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);

  it("accepts a patch that preserves the protected placeholder and rejects a dropped one", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} remaining" },
    });
    expect(() => assertPlaceholdersPreserved(scope, good.drafts)).not.toThrow();

    const dropped = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp remaining" },
    });
    expect(() => assertPlaceholdersPreserved(scope, dropped.drafts)).toThrow(FinalizeError);
  });

  it("rejects a repaired target that introduces an un-encodable (non-Shift-JIS) codepoint", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} left!" },
    });
    expect(() => assertTargetEncodable(good.drafts, realliveSjisPolicy)).not.toThrow();

    const emoji = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} left \u{1F600}" },
    });
    expect(() => assertTargetEncodable(emoji.drafts, realliveSjisPolicy)).toThrow(/encoding/u);
  });
});

describe("P2 line editor — exactness + scope-binding guards", () => {
  const units = [0, 1, 2].map((index) => unitFact(index));
  const current = currentDraftOf(units);
  const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);

  it("rejects a wrong source hash, a wrong cardinality, and a reordering", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"]).drafts;
    expect(() => assertExactAgainstSource(scope, good)).not.toThrow();

    const wrongHash = [{ ...good[0]!, sourceHash: `sha256:${"0".repeat(64)}` }];
    expect(() => assertExactAgainstSource(scope, wrongHash)).toThrow(/source-hash/u);

    const twoScope = deriveEditScope(
      current,
      repairBundleFor(["unit:6010:1", "unit:6010:2"]),
      units,
    );
    expect(() => assertExactAgainstSource(twoScope, good)).toThrow(/unit-cardinality/u);

    const reordered = deriveEditScope(
      currentDraftOf(units),
      repairBundleFor(["unit:6010:1", "unit:6010:2"]),
      units,
    );
    const swapped = [patchDraftFor(units, "unit:6010:2"), patchDraftFor(units, "unit:6010:1")];
    expect(() => assertExactAgainstSource(reordered, swapped)).toThrow(/unit-order/u);
  });

  it("rejects a fresh-grounded-fork patch, a wrong parent, and a wrong bundle", () => {
    const forkMode = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      scope: {
        kind: "repair-patch" as const,
        parentDraftBatchId: PARENT,
        defectBundleId: BUNDLE,
        repairMode: "fresh-grounded-fork" as const,
        failedUnitIds: ["unit:6010:1"],
      },
    } as DraftBatch;
    expect(() => assertRepairPatchMatchesScope(scope, forkMode)).toThrow(/repair-mode-mismatch/u);

    const wrongParent = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      scope: {
        kind: "repair-patch" as const,
        parentDraftBatchId: "draft:other",
        defectBundleId: BUNDLE,
        repairMode: "author-continuation" as const,
        failedUnitIds: ["unit:6010:1"],
      },
    } as DraftBatch;
    expect(() => assertRepairPatchMatchesScope(scope, wrongParent)).toThrow(
      /parent-batch-mismatch/u,
    );
  });
});

describe("P2 line editor — never blind-retranslates / whole-QA reruns", () => {
  it("refuses a non-repair (adjudication) bundle BEFORE any dispatch", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"], "adjudication");
    const captured: Captured[] = [];
    await expect(
      editLine(
        { ...BASE, currentDraft: current, defectBundle: bundle, units },
        recordedRuntime([], captured),
      ),
    ).rejects.toThrow(/not-a-repair-bundle/u);
    // Nothing was dispatched — a non-repair bundle never reaches the model.
    expect(captured).toHaveLength(0);
  });

  it("refuses a defect that names a unit absent from the current draft", () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:9"]);
    expect(() => deriveEditScope(current, bundle, units)).toThrow(/unknown-implicated-unit/u);
  });

  it("refuses an implicated unit that lacks a source fact", () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"]);
    expect(() => deriveEditScope(current, bundle, [units[0]!])).toThrow(/missing-source-fact/u);
  });
});

describe("P2 line editor — certified route binding", () => {
  it("rejects a test-dev wrong-model call at the public dispatch boundary", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);
    const call = buildEditCall({
      specialist: specialistFor("P2"),
      scope,
      bibleRenderingIds: BIBLE,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    const forged = { ...call, spec: { ...call.spec, requestedModel: "openai/gpt-4.1" } };
    const captured: Captured[] = [];
    await expect(
      dispatchEditCall(
        forged,
        recordedRuntime([draftBatchResponse(repairPatchBatch(units, ["unit:6010:1"]))], captured),
      ),
    ).rejects.toThrow(/certified deepseek-v4-flash/u);
    expect(captured).toHaveLength(0);
  });

  it("surfaces a dispatch failure as a typed EditError, never a fabricated patch", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"]);
    const refusal = sse([
      {
        id: "generation:p2",
        created: 1,
        model: "deepseek/deepseek-v4-flash",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
    ]);
    await expect(
      editLine(
        { ...BASE, currentDraft: current, defectBundle: bundle, units },
        recordedRuntime([refusal], []),
      ),
    ).rejects.toBeInstanceOf(EditError);
  });
});

describe("P2 line editor — scope resolves the exact implicated set", () => {
  it("orders the implicated units by current-draft play order and refuses a bundle for another draft", () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    // Defects supplied out of play order still resolve in play order.
    const bundle = repairBundleFor(["unit:6010:3", "unit:6010:1"]);
    const scope = deriveEditScope(current, bundle, units);
    expect(scope.implicatedUnitIds).toEqual(["unit:6010:1", "unit:6010:3"]);

    const wrongBatch = { ...bundle, draftBatchId: "draft:elsewhere" } as DefectBundle;
    expect(() => deriveEditScope(current, wrongBatch, units)).toThrow(/bundle-batch-mismatch/u);
  });
});
