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
  type DefectBundle,
  type DraftBatch,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { specialistFor, toolsForRole } from "../src/roster/index.js";
import {
  assertBlindedGroundedFork,
  assertRepairPatchBatch,
  buildRepairCall,
  normalizeRepairRequest,
  repairSemanticDefects,
  REPAIR_MODE,
  RepairError,
  RepairFinalizeError,
  type RepairCandidateUnit,
  type RepairRequest,
  type RepairRuntimeBase,
} from "../src/roles/p3/index.js";

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
const PARENT_BATCH = "draft:6010:whole";
const BUNDLE_ID = "bundle:6010:1";

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
    id: "generation:p3",
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

function recordedRuntime(responses: readonly Response[], captured: Captured[]): RepairRuntimeBase {
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
      admission: { scope: "test:p3", confirmedCostCapUsd: "10" },
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

// ── deterministic fixtures ────────────────────────────────────────────────────
function candidate(
  index: number,
  placeholders: RepairCandidateUnit["protectedPlaceholders"] = [],
): RepairCandidateUnit {
  const skeleton = `s${index}`;
  return {
    unitId: `unit:6010:${index}`,
    sourceHash: sha256(skeleton),
    sourceSkeleton: skeleton,
    protectedPlaceholders: placeholders,
    currentTargetSkeleton: `MT>${skeleton}`,
  };
}

function meaningDefect(unitId: string, defectId: string): DefectBundle["defects"][number] {
  return {
    origin: "reviewer",
    defectId,
    unitId,
    severity: "major",
    span: { spanId: `span:${defectId}`, surface: "target", text: "wrong referent" },
    evidenceIds: [`fact:${unitId}`],
    basisFactIds: [`fact:${unitId}`],
    repairConstraint: "restore the source's referent without adding honorifics",
    implicatedGates: [],
    implicatedReviewLanes: ["Q1"],
    category: "meaning",
    reviewId: `review:${defectId}`,
    reviewLane: "Q1",
  };
}

function defectBundle(units: readonly string[]): DefectBundle {
  return {
    schemaVersion: DEFECT_BUNDLE_SCHEMA_VERSION,
    bundleId: BUNDLE_ID,
    localizationSnapshotId: LOC,
    draftBatchId: PARENT_BATCH,
    defects: units.map((unitId, i) => meaningDefect(unitId, `defect:${i}`)),
    factDominance: [],
    resolution: "repair",
  } as DefectBundle;
}

function patchDraft(c: RepairCandidateUnit) {
  return {
    unitId: c.unitId,
    sourceHash: c.sourceHash,
    targetSkeleton: `EN>${c.sourceSkeleton}`,
    evidenceIds: [`fact:${c.unitId}`],
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
    uncertainty: ["none"],
  };
}

function repairPatchBatch(
  cands: readonly RepairCandidateUnit[],
  failedUnitIds: readonly string[],
): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `patch:${BUNDLE_ID}`,
    scope: {
      kind: "repair-patch",
      parentDraftBatchId: PARENT_BATCH,
      defectBundleId: BUNDLE_ID,
      repairMode: REPAIR_MODE,
      failedUnitIds: [...failedUnitIds],
    },
    drafts: cands.map(patchDraft),
  } as DraftBatch;
}

function request(cands: readonly RepairCandidateUnit[]): RepairRequest {
  return {
    defectBundle: defectBundle(cands.map((c) => c.unitId)),
    candidateBatchId: PARENT_BATCH,
    candidates: cands,
    bibleRenderingIds: BIBLE,
    preDraftContext: {
      sourceFacts: cands.map((candidate) => ({
        unitId: candidate.unitId,
        sourceHash: candidate.sourceHash,
        sourceSkeleton: candidate.sourceSkeleton,
        protectedPlaceholders: candidate.protectedPlaceholders,
        surfaceKind: candidate.surfaceKind ?? null,
        choiceContext: candidate.choiceContext ?? null,
      })),
      wikiFacts: cands.map((candidate) => ({
        factId: `fact:${candidate.unitId}`,
        kind: "meaning-evidence",
        text: `Pinned meaning evidence for ${candidate.unitId}`,
      })),
      bible: BIBLE.map((renderingId) => ({
        renderingId,
        text: "Use neutral register for the heroine's dialogue.",
      })),
    },
    tripwires: ["do not add an honorific the source lacks"],
  };
}

const OPTIONS = {
  contextSnapshotId: CTX,
  localizationSnapshotId: LOC,
  schemaHash: SCHEMA,
  runMode: "test-dev" as const,
  contextScope: "whole-game" as const,
};

describe("P3 semantic repair — fresh blinded grounded fork", () => {
  it("dispatches a fresh grounded fork through the sole ZDR boundary and patches the failed units", async () => {
    const cands = [candidate(0), candidate(1)];
    const captured: Captured[] = [];
    const outcome = await repairSemanticDefects(
      request(cands),
      OPTIONS,
      recordedRuntime(
        [
          draftBatchResponse(
            repairPatchBatch(
              cands,
              cands.map((c) => c.unitId),
            ),
          ),
        ],
        captured,
      ),
    );

    expect(outcome.kind).toBe("repaired");
    if (outcome.kind !== "repaired") throw new Error("expected repaired");
    expect(outcome.resolution).toBe("repair");
    expect(outcome.provisional).toBe(true);
    expect(outcome.patches.map((p) => p.unitId)).toEqual(cands.map((c) => c.unitId));
    expect(outcome.repairedDefectIds).toEqual(["defect:0", "defect:1"]);

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
  });

  it("builds a call with no author-thread turn, no author identity, and real grounding", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    const call = buildRepairCall({
      specialist: specialistFor("P3"),
      normalized,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });

    // FRESH FORK: exactly a system turn and a user turn — no assistant author thread.
    const roles = call.spec.messages.map((m) => (m.kind === "text" ? m.role : m.kind));
    expect(roles).toEqual(["system", "user"]);
    expect(roles).not.toContain("assistant");
    expect(call.spec.purpose).toBe("repair");

    // GROUNDED + BLINDED: the seed carries source + bible, and NO author identity.
    const userRef =
      call.spec.messages[1]?.kind === "text"
        ? call.spec.messages[1].contentEncrypted.storageRef
        : "";
    const seedText = call.payloads.get(userRef)!;
    expect(seedText).toContain(cands[0]!.sourceSkeleton);
    expect(seedText).toContain(BIBLE[0]);
    expect(seedText).toContain("Pinned meaning evidence");
    expect(seedText).toContain("Use neutral register");
    for (const key of [
      "authoredBy",
      "producedBy",
      "producingRole",
      "authorRole",
      "authorModel",
      "priorAuthor",
    ]) {
      expect(seedText).not.toContain(key);
    }
    expect(seedText).not.toContain("P1");

    // The blinded/grounded guard accepts it.
    expect(() => assertBlindedGroundedFork(call)).not.toThrow();
  });

  it("rejects a fork that leaks author identity or drops grounding", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    const call = buildRepairCall({
      specialist: specialistFor("P3"),
      normalized,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    // Tamper: inject an author-identity attribution into the seed payload.
    const userRef =
      call.spec.messages[1]?.kind === "text"
        ? call.spec.messages[1].contentEncrypted.storageRef
        : "";
    const leaked = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"authoredBy":"P1","preDraftContext":{"sourceFacts":[{"sourceSkeleton":"s0"}],"wikiFacts":[{}],"bible":[{}]},"units":[{"sourceSkeleton":"s0"}]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(leaked)).toThrow(RepairFinalizeError);

    // Tamper: drop the grounding (no bible / no source).
    const ungrounded = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"preDraftContext":{"sourceFacts":[],"wikiFacts":[],"bible":[]},"units":[]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(ungrounded)).toThrow(/not-grounded/u);

    const rationaleLeak = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"priorRepairRationale":"try a synonym","preDraftContext":{"sourceFacts":[{"sourceSkeleton":"s0"}],"wikiFacts":[{}],"bible":[{}]},"units":[{"sourceSkeleton":"s0"}]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(rationaleLeak)).toThrow(/prior repair rationale/u);
  });
});

describe("P3 semantic repair — minimal patch, failed ids only", () => {
  it("accepts a patch for exactly the failed units and preserves placeholders", () => {
    const cands = [candidate(0), candidate(1)];
    const normalized = normalizeRepairRequest(request(cands));
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );
    expect(() => assertRepairPatchBatch(normalized, batch)).not.toThrow();
  });

  it("rejects a patch that touches a PASSING id (not in the failed set)", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    // A schema-valid patch that inflates the scope with a passing unit + its draft.
    const passing = candidate(9);
    const inflated = repairPatchBatch([cands[0]!, passing], [cands[0]!.unitId, passing.unitId]);
    expect(() => assertRepairPatchBatch(normalized, inflated)).toThrow(RepairFinalizeError);
    expect(() => assertRepairPatchBatch(normalized, inflated)).toThrow(/failed-ids-mismatch/u);
  });

  it("rejects a candidate supplied for a passing unit at normalization", () => {
    const cands = [candidate(0)];
    const passing = candidate(9);
    // A candidate whose unit has no defect is a passing unit smuggled in.
    const req: RepairRequest = { ...request(cands), candidates: [cands[0]!, passing] };
    expect(() => normalizeRepairRequest(req)).toThrow(RepairError);
    expect(() => normalizeRepairRequest(req)).toThrow(/candidate-passing-unit/u);
  });

  it("rejects a patch that drops a protected placeholder", () => {
    const ph = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
    const cands = [candidate(0, ph)];
    const normalized = normalizeRepairRequest(request(cands));
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );
    // Overwrite the patch target so the protected placeholder is gone.
    const dropped = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "no placeholder here" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, dropped)).toThrow(/protected-span/u);

    // A patch that keeps the placeholder is accepted.
    const kept = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "hp {{ph:0}} left" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, kept)).not.toThrow();
  });

  it("requires resolving finding evidence and preserves Shift-JIS and choice-label encoding", () => {
    const choice = {
      ...candidate(0),
      surfaceKind: "choice_label",
      choiceContext: {
        choiceId: "choice:6010",
        optionIndex: 0,
        branchTargetSceneId: "scene:6011",
      },
    } as const;
    const normalized = normalizeRepairRequest(request([choice]));
    const batch = repairPatchBatch([choice], [choice.unitId]);
    expect(() => assertRepairPatchBatch(normalized, batch)).not.toThrow();

    const ungroundedPatch = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, evidenceIds: ["fact:unrelated"] }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, ungroundedPatch)).toThrow(
      /resolving-evidence/u,
    );

    const nonSjis = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "🙂" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, nonSjis)).toThrow(/encoding/u);

    const splitChoice = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "First\nSecond" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, splitChoice)).toThrow(/choice-encoding/u);
  });

  it("uses P3's immutable localizer profile and its live semantic validator", () => {
    const p3 = specialistFor("P3");
    expect(p3.shape).toBe("localizer");
    expect(p3.version).toBe("itotori.role.P3.v2");
    expect(p3.tools).toEqual(toolsForRole("P3"));
    expect(p3.limits.maxSteps).toBe(1);
    expect(p3.validate(undefined)).not.toEqual([]);
  });
});

describe("P3 semantic repair — bounded to one repair", () => {
  it("repairs once, then routes a second attempt on the same defect to adjudication without dispatch", async () => {
    const cands = [candidate(0)];
    const req = request(cands);
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );

    // First attempt: a real repair, one dispatch.
    const firstCaptured: Captured[] = [];
    const first = await repairSemanticDefects(
      req,
      OPTIONS,
      recordedRuntime([draftBatchResponse(batch)], firstCaptured),
    );
    expect(first.kind).toBe("repaired");
    if (first.kind !== "repaired") throw new Error("expected repaired");
    expect(firstCaptured).toHaveLength(1);
    expect(first.repairedDefectIds).toEqual(["defect:0"]);

    // Fold the repaired defects into the ledger and re-enter with the SAME bundle.
    const ledger = new Set(first.repairedDefectIds);
    const secondCaptured: Captured[] = [];
    const second = await repairSemanticDefects(
      req,
      { ...OPTIONS, repairedDefectLedger: ledger },
      // No response queued — a dispatch here would throw "unexpected extra request".
      recordedRuntime([], secondCaptured),
    );

    // BOUNDED: the second attempt does NOT repair again — it routes to Q6/human
    // and dispatches nothing.
    expect(second.kind).toBe("routed");
    if (second.kind !== "routed") throw new Error("expected routed");
    expect(second.route).toBe("adjudication");
    expect(second.resolution).toBe("adjudication");
    expect(second.defectIds).toEqual(["defect:0"]);
    expect(second.humanReviewArtifact).toMatchObject({
      kind: "semantic-repair-exhausted",
      defectBundleId: BUNDLE_ID,
      repairPassLimit: 1,
    });
    expect(secondCaptured).toHaveLength(0);
  });
});
