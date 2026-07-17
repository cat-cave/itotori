import { createHash } from "node:crypto";
import {
  LlmAcceptedOutputCasError,
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type AcceptLlmOutputInput,
  type LlmAcceptedOutputHead,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallSpec } from "../src/contracts/index.js";
import type { EditorRuntimeBase } from "../src/roles/p2/index.js";
import type { LocalizerRuntimeBase } from "../src/roles/p1/index.js";
import type { RepairRuntimeBase } from "../src/roles/p3/index.js";
import { dispatch } from "../src/llm/dispatch.js";
import { resolveRoleModelProfile } from "../src/llm/role-model-profiles.js";
import { TransientStepError, type UnitStage, type WorkflowScene } from "../src/workflow/index.js";
import {
  createCertifiedDispatch,
  createDispatchRuntime,
  createLiveWorkflowArtifactStore,
  projectDecodeStructure,
  type AcceptedOutputCas,
  type AcceptedUnitOutput,
} from "../src/composition/live/index.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  confirmedGenerationMetadataSource,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";

// ── shared offline substrate ─────────────────────────────────────────────────

const REV_A = `sha256:${"a".repeat(64)}` as const;
const REV_B = `sha256:${"b".repeat(64)}` as const;
const REV_C = `sha256:${"c".repeat(64)}` as const;
const REV_D = `sha256:${"d".repeat(64)}` as const;

// An in-memory `LlmCallMemoStore` — the recorded-transport single-flight, no DB.
class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attempts = new Map<string, number>();
  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash) {
        throw new LlmMemoConflictError(input.memoKey);
      }
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

interface Captured {
  body: Record<string, unknown>;
}

// The certified reviewer route's measured profile — its name + version MUST match
// the spec's certified `modelProfile` / `modelProfileVersion` (the attempt policy
// asserts the runtime profile matches the spec).
const REVIEWER_PROFILE = resolveRoleModelProfile("Q1");
const REVIEWER_MEASURED_PROFILE: MeasuredModelProfile = {
  name: REVIEWER_PROFILE.modelProfile,
  version: REVIEWER_PROFILE.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the offline recorded-transport proof, not a billed model cost
};

function recordedDispatchRuntime(captured: Captured[], response: Response): LocalizerRuntimeBase {
  const queue = [response];
  return createDispatchRuntime({
    memoStore: new MemoryMemoStore(),
    contentAccess: { requireContentRead: async () => undefined },
    profile: REVIEWER_MEASURED_PROFILE,
    admission: { scope: "test:composition-live", confirmedCostCapUsd: "10" },
    generationMetadataSource: confirmedGenerationMetadataSource(),
    snapshots: {
      decodeRevisionHash: REV_A,
      glossaryRevisionHash: REV_B,
      styleRevisionHash: REV_C,
      acceptedOutputHeadHash: REV_D,
    },
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      captured.push({ body: (await request.clone().json()) as Record<string, unknown> });
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra provider request");
      return next;
    },
  });
}

// ── Builder 1: the live dispatch runtime ─────────────────────────────────────

describe("live dispatch runtime — the sole ZDR boundary substrate", () => {
  const runModes: readonly CallSpec["runMode"][] = ["production", "pilot", "test-dev"];

  // A spec bound to the role's certified route so the boundary admits it in EVERY
  // run mode (the certification is skipped only under test-dev).
  function certifiedReviewerSpec(runMode: CallSpec["runMode"]): CallSpec {
    return physicalCallSpec("Return a verdict.", {
      runMode,
      modelProfile: REVIEWER_PROFILE.modelProfile,
      modelProfileVersion: REVIEWER_PROFILE.version,
      requestedModel: REVIEWER_PROFILE.model,
      providerPolicy: REVIEWER_PROFILE.providerPolicy,
    });
  }

  for (const runMode of runModes) {
    it(`hits dispatch.ts with a certified, provider-free ZDR request and records the served pair (${runMode})`, async () => {
      const captured: Captured[] = [];
      const runtime = recordedDispatchRuntime(
        captured,
        structuredProviderResponse(reviewVerdictExample),
      );
      const spec = certifiedReviewerSpec(runMode);
      // The role supplies its own payload resolver; the runtime carries no payloads.
      const result = await dispatch(spec, {
        ...runtime,
        readPayload: async () => "Return a verdict.",
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("expected success");
      // The served (model, provider) pair is a recorded OUTPUT, never a routing input.
      expect(result.served).toEqual({
        status: "confirmed",
        model: "served/model:fixture",
        provider: "provider:served-fixture",
      });
      // The wire request names NO upstream provider — only the certified model +
      // the ZDR fallback POLICY object travel on the request.
      expect(captured).toHaveLength(1);
      const body = captured[0]!.body;
      expect(body.model).toBe("deepseek/deepseek-v4-flash");
      expect(body.provider).toMatchObject({ zdr: true, allow_fallbacks: true });
      expect(typeof body.provider).toBe("object");
    });
  }

  it("satisfies the P1/P2/P3 runtime bases and forms the certified Q6 dispatch seam", async () => {
    const captured: Captured[] = [];
    const runtime = recordedDispatchRuntime(
      captured,
      structuredProviderResponse(reviewVerdictExample),
    );
    // Structural proof: one runtime object is all three role runtime bases.
    const asLocalizer: LocalizerRuntimeBase = runtime;
    const asEditor: EditorRuntimeBase = runtime;
    const asRepair: RepairRuntimeBase = runtime;
    expect(asLocalizer).toBe(asEditor);
    expect(asEditor).toBe(asRepair);

    const certifiedDispatch = createCertifiedDispatch(runtime, async () => "Return a verdict.");
    const result = await certifiedDispatch(certifiedReviewerSpec("test-dev"));
    expect(result.status).toBe("success");
  });
});

// ── Builder 2: the live workflow artifact store (in-memory CAS proof) ─────────

const SNAPSHOT_ID = `sha256:${"e".repeat(64)}` as const;

// An in-memory CAS mirroring the real accept-and-advance head semantics.
class MemoryAcceptedOutputCas implements AcceptedOutputCas {
  readonly #heads = new Map<string, LlmAcceptedOutputHead>();

  async readHead(input: {
    snapshotId: string;
    subjectType: string;
    subjectId: string;
    stage: string;
  }): Promise<LlmAcceptedOutputHead | null> {
    return this.#heads.get(headKey(input)) ?? null;
  }

  async acceptAndAdvance(input: AcceptLlmOutputInput): Promise<LlmAcceptedOutputHead> {
    const key = headKey(input);
    const current = this.#heads.get(key) ?? null;
    const expected = input.expectedHead;
    const same =
      (current === null && expected === null) ||
      (current !== null &&
        expected !== null &&
        current.outputId === expected.outputId &&
        current.version === expected.version &&
        current.contentHash === expected.contentHash);
    if (!same) throw new LlmAcceptedOutputCasError();
    const head: LlmAcceptedOutputHead = {
      outputId: input.outputId,
      version: input.outputVersion,
      contentHash: sha256(input.outputJson),
    };
    this.#heads.set(key, head);
    return head;
  }
}

function acceptedOutputFor(input: {
  unitId: string;
  stage: UnitStage;
  contentHash: `sha256:${string}`;
  priorHead: LlmAcceptedOutputHead | null;
}): AcceptedUnitOutput {
  const version = (input.priorHead?.version ?? 0) + 1;
  return {
    outputId: `${input.unitId}:${input.stage}:v${version}`,
    semanticKey: sha256(`semantic:${input.unitId}:${input.stage}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputJson: JSON.stringify({ unitId: input.unitId, target: input.contentHash }),
    memoKeys: [sha256(`memo:${input.unitId}:v${version}`)],
    sourceHash: sha256(`source:${input.unitId}`),
  };
}

describe("live workflow artifact store — CAS heads + attempt lineage (in-memory)", () => {
  it("round-trips readUnitHead / finalizeUnit across independent per-unit heads", async () => {
    const store = createLiveWorkflowArtifactStore({
      accepted: new MemoryAcceptedOutputCas(),
      snapshotId: SNAPSHOT_ID,
      resolveFinalizeArtifact: acceptedOutputFor,
    });
    // A null head is the "must produce" signal.
    expect(await store.readUnitHead("unit:a", "final")).toBeNull();

    const hashA = `sha256:${"1".repeat(64)}` as const;
    const finalized = await store.finalizeUnit({
      unitId: "unit:a",
      stage: "final",
      contentHash: hashA,
      shippable: true,
    });
    expect(finalized).toMatchObject({ unitId: "unit:a", stage: "final", version: 1 });

    const head = await store.readUnitHead("unit:a", "final");
    expect(head).toEqual(finalized);

    // A second unit's head is independent — never coupled to unit:a's.
    expect(await store.readUnitHead("unit:b", "final")).toBeNull();

    // Re-finalize advances the SAME head to v2 (chained through the prior head).
    const hashA2 = `sha256:${"2".repeat(64)}` as const;
    const advanced = await store.finalizeUnit({
      unitId: "unit:a",
      stage: "final",
      contentHash: hashA2,
      shippable: true,
    });
    expect(advanced.version).toBe(2);
    expect((await store.readUnitHead("unit:a", "final"))?.version).toBe(2);
  });

  it("counts every physical attempt, retries a TransientStepError, and skips a memo hit", async () => {
    const store = createLiveWorkflowArtifactStore({
      accepted: new MemoryAcceptedOutputCas(),
      snapshotId: SNAPSHOT_ID,
      resolveFinalizeArtifact: acceptedOutputFor,
    });

    let calls = 0;
    const first = await store.runMemoizedStep("step:draft:1", async ({ ordinal }) => {
      calls += 1;
      if (ordinal < 3) throw new TransientStepError(`attempt ${ordinal}`);
      return { drafted: ordinal };
    });
    expect(first).toEqual({ memoHit: false, value: { drafted: 3 } });
    expect(calls).toBe(3);
    expect(store.attemptLineage()).toEqual([
      { memoKey: "step:draft:1", ordinal: 1, outcome: "transient-retry" },
      { memoKey: "step:draft:1", ordinal: 2, outcome: "transient-retry" },
      { memoKey: "step:draft:1", ordinal: 3, outcome: "completed" },
    ]);

    // A restart hit returns the cached value WITHOUT invoking produce again.
    const second = await store.runMemoizedStep("step:draft:1", async () => {
      throw new Error("produce must not run on a memo hit");
    });
    expect(second).toEqual({ memoHit: true, value: { drafted: 3 } });
  });

  it("records a failed attempt and rethrows a non-transient producer error", async () => {
    const store = createLiveWorkflowArtifactStore({
      accepted: new MemoryAcceptedOutputCas(),
      snapshotId: SNAPSHOT_ID,
      resolveFinalizeArtifact: acceptedOutputFor,
    });
    await expect(
      store.runMemoizedStep("step:review:1", async () => {
        throw new Error("permanent role fault");
      }),
    ).rejects.toThrow(/permanent role fault/u);
    expect(store.attemptLineage()).toEqual([
      { memoKey: "step:review:1", ordinal: 1, outcome: "failed" },
    ]);
  });
});

// ── Builder 3: the decode → WorkflowScene[] adapter ──────────────────────────

describe("decode → WorkflowScene[] adapter", () => {
  function fixtureStructure(): unknown {
    const path = join(__dirname, "fixtures", "narrative-structure-v2-units.json");
    return JSON.parse(readFileSync(path, "utf8"));
  }

  it("projects a real fixture structure into dispatch-ordered scenes with decode identity", () => {
    const projection = projectDecodeStructure(fixtureStructure());
    const scenes: readonly WorkflowScene[] = projection.scenes;

    // The dispatch-only scene 300 (no translatable units) is skipped.
    expect(scenes.map((scene) => scene.sceneId)).toEqual(["100", "200"]);

    // Units are ordered by play order (the array is deliberately out of order).
    expect(scenes[0]!.units.map((unit) => unit.unitId)).toEqual(["unit:100:1", "unit:100:2"]);

    // firstAppearance is a speaker's first occurrence across the dispatch order.
    expect(scenes[0]!.units.map((unit) => unit.firstAppearance)).toEqual([true, true]);
    const rinAgain = scenes[1]!.units.find((unit) => unit.unitId === "unit:200:1");
    expect(rinAgain?.firstAppearance).toBe(false);
    expect(rinAgain?.speakerId).toBe("char:rin");
    // routeId falls back from unit to the scene's route membership.
    expect(scenes[0]!.units[0]!.routeId).toBe("route:common");
    expect(rinAgain?.routeId).toBe("route:rin");

    // Source hashes are content-addressed over the decode source text.
    expect(scenes[0]!.units[0]!.sourceHash).toBe(sha256("はじめまして。"));

    // The per-unit fact + rendering maps back the draft assembler.
    expect(projection.renderingIdsByUnit.get("unit:100:1")).toEqual(["line:100:1"]);
    expect(projection.factsByUnit.get("unit:200:1")).toMatchObject({
      sceneId: "200",
      speakerId: "char:rin",
      routeId: "route:rin",
      surfaceKind: "dialogue",
    });
  });
});

function headKey(input: {
  snapshotId: string;
  subjectType: string;
  subjectId: string;
  stage: string;
}): string {
  return `${input.snapshotId} ${input.subjectType} ${input.subjectId} ${input.stage}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
