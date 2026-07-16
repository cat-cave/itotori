// A10 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A10 call spec is the
// certified A10 route (no provider named, ZDR policy, wiki-object terminal), that
// the certified route is asserted in EVERY mode (test-dev included), that it
// actually reaches `dispatch()`, and that the production caller maps the draft.

import { createHash } from "node:crypto";

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import type { SpeakerContextV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import { CallSpecSchema, type CallSpec, type WikiObject } from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import {
  assembleSpeakerHypothesis,
  assertA10CertifiedRoute,
  buildA10CallSpec,
  dispatchA10,
  dispatchingA10Caller,
  hindsightCandidateIds,
  hindsightRevealSceneIds,
  readUnknownSpeakerUnits,
  verifyCandidateCharacter,
  verifyRevealScene,
  type A10Context,
  type A10HypothesisRequest,
} from "../src/roles/a10/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";
import {
  confirmedGenerationMetadataSource,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const A10_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const CONTEXT: A10Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
];

const PARSER_UNKNOWN_SPEAKER: SpeakerContextV02 = {
  knowledgeState: "parser_unknown",
  rawSpeakerText: "？？？",
};

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

function runtime(responses: Response[], onFetch?: () => void): DispatchRuntime {
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
      profile: A10_PROFILE,
      admission: {
        scope: "test:roles-a10",
        confirmedCostCapUsd: "10", // itotori-225-audit-allow: synthetic admission cap for the recorded-transport proof, not a billed cost
      },
      generationMetadataSource: confirmedGenerationMetadataSource(),
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
      return response;
    },
  };
}

function hypothesisRequest(): {
  model: ReturnType<typeof buildClaimFixture>["model"];
  request: A10HypothesisRequest;
} {
  const { model } = buildClaimFixture({
    characters: CHARACTERS,
    unitSpeakers: new Map<string, SpeakerContextV02>([
      ["reallive:scene-0002#0000", PARSER_UNKNOWN_SPEAKER],
    ]),
  });
  const unit = readUnknownSpeakerUnits(model, CONTEXT)[0]!;
  return {
    model,
    request: {
      unit,
      sourceLanguage: model.sourceLanguage,
      candidateCharacterIds: hindsightCandidateIds(model),
      revealSceneIds: hindsightRevealSceneIds(model, CONTEXT),
    },
  };
}

function recordedHypothesis(
  model: ReturnType<typeof buildClaimFixture>["model"],
  request: A10HypothesisRequest,
): WikiObject {
  const occ = verifyCandidateCharacter(model, CONTEXT, "nam-11");
  const node = verifyRevealScene(model, CONTEXT, "2");
  return assembleSpeakerHypothesis(
    model,
    CONTEXT,
    request.unit,
    {
      candidateCharacterId: "nam-11",
      confidence: "medium",
      revealSceneId: "2",
      rationale: "推測。",
    },
    occ,
    node,
  );
}

describe("A10 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A10 call spec is the certified, no-provider-named, wiki-object route", () => {
    const { model, request } = hypothesisRequest();
    const { spec, prompts } = buildA10CallSpec(model, CONTEXT, request);
    expect(spec.roleId).toBe("A10");
    expect(spec.purpose).toBe("analysis");
    expect(spec.modelProfile).toBe("reasoning");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy.zdr).toBe(true);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.tools).toHaveLength(0);
    expect(spec.contextSnapshotId).toBe(model.snapshotId);
    expect(prompts[0]!.ref.contentHash).toBe(
      `sha256:${createHash("sha256").update(prompts[0]!.text).digest("hex")}`,
    );
    expect(() => CallSpecSchema.parse(spec)).not.toThrow();
  });

  it("PROOF: the certified route is asserted in EVERY mode — test-dev included", () => {
    const { model, request } = hypothesisRequest();
    const { spec } = buildA10CallSpec(model, CONTEXT, request);
    expect(spec.runMode).toBe("test-dev");
    // A10's own assertion has no test-dev bypass: the certified route holds here.
    expect(() => assertA10CertifiedRoute(spec)).not.toThrow();
    // A route drifted off the certified deepseek-v4-flash model is caught in
    // test-dev too (the shared certified-route check would have skipped it).
    const drifted: CallSpec = { ...spec, requestedModel: "deepseek/some-other-model" };
    expect(() => assertA10CertifiedRoute(drifted)).toThrowError(/certified deepseek-v4-flash/u);
  });

  it("PROOF: a recorded speaker-hypothesis draft returns through dispatch()", async () => {
    const { model, request } = hypothesisRequest();
    const { spec, prompts } = buildA10CallSpec(model, CONTEXT, request);
    let fetches = 0;
    const configured = runtime(
      [structuredProviderResponse(recordedHypothesis(model, request))],
      () => {
        fetches += 1;
      },
    );
    const result = await dispatchA10(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("speaker-hypothesis");
    expect(fetches).toBe(1); // it really reached the transport boundary
  });

  it("PROOF: the production caller maps the dispatched draft", async () => {
    const { model, request } = hypothesisRequest();
    const configured = runtime([structuredProviderResponse(recordedHypothesis(model, request))]);
    const caller = dispatchingA10Caller(model, CONTEXT, configured);
    const draft = await caller(request);
    expect(draft.candidateCharacterId).toBe("nam-11");
    expect(draft.confidence).toBe("medium");
    expect(draft.revealSceneId).toBe("2");
    expect(draft.rationale.length).toBeGreaterThan(0);
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request } = hypothesisRequest();
    const { spec } = buildA10CallSpec(model, CONTEXT, request);
    const configured = runtime([structuredProviderResponse(recordedHypothesis(model, request))]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
