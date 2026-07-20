// A3 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A3 call spec is the
// certified A3 route (no provider named, ZDR policy, wiki-object terminal), that
// it actually reaches `dispatch()`, and that the production caller maps the two
// returned drafts into a narrative the fold then validates.

import { createHash } from "node:crypto";

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import type { WikiObject } from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import {
  assembleSceneSummary,
  assembleStorySoFar,
  buildA3CallSpec,
  citeableSceneUnits,
  dispatchA3,
  dispatchingA3Caller,
  readCompleteScene,
  type A3Context,
  type A3SceneNarrative,
  type A3SceneRequest,
} from "../src/roles/a3/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { buildClaimFixture } from "./support/claim-fixture.js";
import { rawTransportDropError, structuredProviderResponse } from "./llm-step-test-support.js";

/** A measured profile whose identity matches the certified A3 reasoning route,
 * so the memo boundary accepts the A3 call spec. */
const A3_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
type ProviderResponse = Response | Error;

const CONTEXT: A3Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const SCENE_1 = "scene:0001";

/** In-memory memo store — the durable memoization seam, no Postgres. */
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

function runtime(responses: ProviderResponse[], onFetch?: () => void): DispatchRuntime {
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
      profile: A3_PROFILE,
      // Deterministic, instant backoff so the retry proof carries no real sleep.
      retry: { random: () => 0, sleep: async () => undefined },
      admission: {
        scope: "test:roles-a3",
        confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for the recorded-transport proof, not a billed cost
      },
      snapshots: {
        decodeRevisionHash: HASH_A,
        glossaryRevisionHash: HASH_B,
        styleRevisionHash: HASH_A,
        acceptedOutputHeadHash: HASH_B,
      },
    },
    readPayload: async () => {
      throw new Error("unexpected fallback payload read");
    },
    fetcher: async () => {
      onFetch?.();
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra provider request");
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function sceneRequest(): {
  model: ReturnType<typeof buildClaimFixture>["model"];
  request: A3SceneRequest;
} {
  const { model } = buildClaimFixture();
  const scene = readCompleteScene(model, CONTEXT, SCENE_1);
  return { model, request: { scene, priorStory: null, sourceLanguage: model.sourceLanguage } };
}

function recordedSummary(
  model: ReturnType<typeof buildClaimFixture>["model"],
  request: A3SceneRequest,
): WikiObject {
  const anchor = citeableSceneUnits(request.scene)[0]!.label;
  const narrative: A3SceneNarrative = {
    beat: "けいこは決断する。",
    subtext: "静かな決意。",
    sceneOpenThreads: [],
    sceneClaims: [
      {
        statement: "直接的な語り口。",
        kind: "beat",
        confidence: "high",
        evidenceUnitIds: [anchor],
      },
    ],
    storySummary: "物語が動き出す。",
    storyOpenThreads: [],
    storyClaims: [
      {
        statement: "一貫した導入。",
        kind: "story-so-far",
        confidence: "medium",
        evidenceUnitIds: [anchor],
      },
    ],
  };
  const resolved = assembleSceneSummary(model, CONTEXT, request.scene, narrative);
  // The provider returns an UNTRUSTED model draft. Its evidenceId is the label
  // copied from the prompt, before A3 assembly replaces it with the real fact id.
  return {
    ...resolved,
    claims: resolved.claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => ({ ...citation, evidenceId: anchor })),
    })),
  };
}

function recordedStory(
  model: ReturnType<typeof buildClaimFixture>["model"],
  request: A3SceneRequest,
): WikiObject {
  const anchor = citeableSceneUnits(request.scene)[0]!.label;
  const narrative: A3SceneNarrative = {
    beat: "b",
    subtext: "s",
    sceneOpenThreads: [],
    sceneClaims: [],
    storySummary: "シーン1までの物語。",
    storyOpenThreads: ["未解決の伏線"],
    storyClaims: [
      {
        statement: "一貫した導入。",
        kind: "story-so-far",
        confidence: "medium",
        evidenceUnitIds: [anchor],
      },
    ],
  };
  const resolved = assembleStorySoFar(
    model,
    CONTEXT,
    request.scene,
    request.scene.scope,
    narrative,
    null,
  );
  return {
    ...resolved,
    claims: resolved.claims.map((claim) => ({
      ...claim,
      citations: claim.citations.map((citation) => ({ ...citation, evidenceId: anchor })),
    })),
  };
}

describe("A3 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A3 call spec is the certified, no-provider-named, wiki-object route", () => {
    const { model, request } = sceneRequest();
    const { spec, prompts } = buildA3CallSpec(model, CONTEXT, request, "scene-summary");
    expect(spec.roleId).toBe("A3");
    expect(spec.purpose).toBe("analysis");
    expect(spec.modelProfile).toBe("reasoning");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy.zdr).toBe(true);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.tools).toHaveLength(0);
    expect(spec.contextSnapshotId).toBe(model.snapshotId);
    // The prompt payload is content-addressed by its own bytes.
    expect(prompts[0]!.ref.contentHash).toBe(
      `sha256:${createHash("sha256").update(prompts[0]!.text).digest("hex")}`,
    );
    expect(prompts[0]!.text).toContain(
      "cite every claim using the short bracketed [uN] label shown for its unit",
    );
    // The prompt shows small scene-local labels the flash model can copy, not the
    // large global play-order index.
    expect(prompts[0]!.text).toContain("[u1]");
  });

  it("PROOF: a recorded scene-summary draft returns through dispatch()", async () => {
    const { model, request } = sceneRequest();
    const { spec, prompts } = buildA3CallSpec(model, CONTEXT, request, "scene-summary");
    let fetches = 0;
    const configured = runtime(
      [structuredProviderResponse(recordedSummary(model, request))],
      () => {
        fetches += 1;
      },
    );
    const result = await dispatchA3(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("scene-summary");
    expect(fetches).toBe(1); // it really reached the transport boundary
  });

  it("PROOF: the production caller folds two dispatched drafts into one narrative", async () => {
    const { model, request } = sceneRequest();
    const configured = runtime([
      structuredProviderResponse(recordedSummary(model, request)),
      structuredProviderResponse(recordedStory(model, request)),
    ]);
    const caller = dispatchingA3Caller(model, CONTEXT, configured);
    const narrative = await caller(request);
    expect(narrative.beat).toBe("けいこは決断する。");
    expect(narrative.storySummary).toBe("シーン1までの物語。");
    expect(narrative.sceneClaims[0]!.evidenceUnitIds).toEqual([
      citeableSceneUnits(request.scene)[0]!.label,
    ]);
  });

  it("PROOF: raw transport exceptions are retried so the A3 caller still gets its narrative", async () => {
    // A raw connection reset reaches the streaming execute catch before the
    // adapter can report RUN_ERROR, so retrying the scene-summary dispatch is
    // safe and the whole-game build proceeds.
    const { model, request } = sceneRequest();
    let fetches = 0;
    const configured = runtime(
      [
        rawTransportDropError(),
        rawTransportDropError(),
        structuredProviderResponse(recordedSummary(model, request)),
        structuredProviderResponse(recordedStory(model, request)),
      ],
      () => {
        fetches += 1;
      },
    );
    const caller = dispatchingA3Caller(model, CONTEXT, configured);
    const narrative = await caller(request);
    expect(narrative.beat).toBe("けいこは決断する。");
    expect(narrative.storySummary).toBe("シーン1までの物語。");
    // Two retried raw transport failures + one summary success + one story success.
    expect(fetches).toBe(4);
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request } = sceneRequest();
    const { spec } = buildA3CallSpec(model, CONTEXT, request, "scene-summary");
    const configured = runtime([structuredProviderResponse(recordedSummary(model, request))]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
