// A8 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A8 call spec is the
// certified A8 route (no provider named, ZDR policy, wiki-object terminal, ZERO
// tools), that the public dispatch entry asserts that certified route in EVERY
// mode — test-dev included — and rejects a forged spec BEFORE the transport, that
// a recorded draft returns through dispatch(), and that the production caller
// maps it.

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import { CallSpecSchema, type CallSpec, type WikiObject } from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import {
  assembleCharacterBio,
  buildCharacterPortrait,
  characterIndex as a7CharacterIndex,
  readCharacterEvidence as a7ReadEvidence,
  type A7BioDraft,
  type A7Context,
  type A7PortraitProvider,
} from "../src/roles/a7/index.js";
import {
  A8RoleError,
  assembleCharacterBackground,
  assertCertifiedRoute,
  buildA8CallSpec,
  characterIndex,
  counterpartIds,
  dispatchA8,
  dispatchingA8Caller,
  readCharacterEvidence,
  sceneEvidenceId,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
} from "../src/roles/a8/index.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";
import { structuredProviderResponse } from "./llm-step-test-support.js";

const A8_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const CONTEXT: A8Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const A7_CONTEXT: A7Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

const portraits: A7PortraitProvider = (characterId) => ({
  status: "available",
  facts: {
    artifactUri: `https://artifacts.example/artifact-store/portrait-${characterId}.png`,
    contentHash: `sha256:${"a".repeat(64)}`,
    mediaType: "image/png",
    dimensions: { width: 256, height: 256 },
    access: { redaction: "default-redacted", permission: "project-member" },
  },
});

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
      profile: A8_PROFILE,
      admission: {
        scope: "test:roles-a8",
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
      return response;
    },
  };
}

function bioFor(model: ReturnType<typeof buildClaimFixture>["model"], characterId: string) {
  const character = a7CharacterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = a7ReadEvidence(model, A7_CONTEXT, character);
  const draft: A7BioDraft = {
    storyRole: `${evidence.decodedLabel} は物語を動かす。`,
    definingTraits: ["まっすぐ"],
    notableMomentEvidenceIds: [evidence.notableUnitIds[0]!],
    claims: [],
  };
  return assembleCharacterBio(
    model,
    A7_CONTEXT,
    evidence,
    draft,
    buildCharacterPortrait(characterId, portraits(characterId)),
  );
}

function backgroundRequest(): {
  model: ReturnType<typeof buildClaimFixture>["model"];
  request: A8BackgroundRequest;
} {
  const { model } = buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
  const character = characterIndex(model).find((c) => c.characterId === "nam-11")!;
  const evidence = readCharacterEvidence(model, CONTEXT, character);
  return {
    model,
    request: {
      character: evidence,
      bio: bioFor(model, "nam-11"),
      counterpartIds: counterpartIds(model),
      sourceLanguage: model.sourceLanguage,
    },
  };
}

function recordedBackground(
  model: ReturnType<typeof buildClaimFixture>["model"],
  request: A8BackgroundRequest,
): WikiObject {
  const draft: A8BackgroundDraft = {
    background: "生い立ち。",
    relationships: [
      {
        counterpartId: "nam-22",
        relationship: "幼なじみ。",
        confidence: "high",
        scope: { kind: "global" },
        establishingSceneIds: [sceneEvidenceId(1)],
      },
    ],
  };
  return assembleCharacterBackground(model, CONTEXT, request.character, request, draft);
}

describe("A8 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A8 call spec is the certified, no-provider-named, wiki-object route with ZERO tools", () => {
    const { model, request } = backgroundRequest();
    const { spec } = buildA8CallSpec(model, CONTEXT, request);
    expect(spec.roleId).toBe("A8");
    expect(spec.purpose).toBe("analysis");
    expect(spec.modelProfile).toBe("reasoning");
    expect(spec.requestedModel).toBe("deepseek/deepseek-v4-flash");
    expect(spec.providerPolicy.zdr).toBe(true);
    expect(spec.output.name).toBe("wiki-object");
    expect(spec.tools).toHaveLength(0);
    expect(spec.contextSnapshotId).toBe(model.snapshotId);
    expect(() => CallSpecSchema.parse(spec)).not.toThrow();
  });

  it("PROOF: assertCertifiedRoute passes the real spec and REJECTS a forged one in EVERY mode (test-dev)", () => {
    const { model, request } = backgroundRequest();
    const { spec } = buildA8CallSpec(model, CONTEXT, request);
    expect(spec.runMode).toBe("test-dev");
    expect(() => assertCertifiedRoute(spec)).not.toThrow();
    // A dropped-ZDR route is rejected even under test-dev.
    const noZdr = { ...spec, providerPolicy: { ...spec.providerPolicy, zdr: false } } as CallSpec;
    expect(() => assertCertifiedRoute(noZdr)).toThrow(A8RoleError);
    // An off-route model is rejected.
    const wrongModel = { ...spec, requestedModel: "openai/gpt-4o" } as CallSpec;
    expect(() => assertCertifiedRoute(wrongModel)).toThrow(/route-not-certified/u);
    // A spec that smuggles in a tool is rejected — A8 holds no tool grant.
    const withTool = { ...spec, tools: [{ name: "web_search" } as never] } as CallSpec;
    expect(() => assertCertifiedRoute(withTool)).toThrow(/route-not-certified/u);
  });

  it("PROOF: dispatchA8 asserts the certified route BEFORE the transport (forged spec, zero fetches)", async () => {
    const { model, request } = backgroundRequest();
    const { spec, prompts } = buildA8CallSpec(model, CONTEXT, request);
    const wrongModel = { ...spec, requestedModel: "openai/gpt-4o" } as CallSpec;
    let fetches = 0;
    const configured = runtime([], () => {
      fetches += 1;
    });
    await expect(dispatchA8(wrongModel, prompts, configured)).rejects.toThrow(
      /route-not-certified/u,
    );
    expect(fetches).toBe(0); // rejected before any provider request
  });

  it("PROOF: a recorded character-background draft returns through dispatch()", async () => {
    const { model, request } = backgroundRequest();
    const { spec, prompts } = buildA8CallSpec(model, CONTEXT, request);
    let fetches = 0;
    const configured = runtime(
      [structuredProviderResponse(recordedBackground(model, request))],
      () => {
        fetches += 1;
      },
    );
    const result = await dispatchA8(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("character-background");
    expect(fetches).toBe(1); // it really reached the transport boundary
  });

  it("PROOF: the production caller maps the dispatched draft", async () => {
    const { model, request } = backgroundRequest();
    const configured = runtime([structuredProviderResponse(recordedBackground(model, request))]);
    const caller = dispatchingA8Caller(model, CONTEXT, configured);
    const draft = await caller(request);
    expect(draft.background).toBe("生い立ち。");
    expect(draft.relationships[0]!.counterpartId).toBe("nam-22");
    expect(draft.relationships[0]!.establishingSceneIds).toEqual([sceneEvidenceId(1)]);
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request } = backgroundRequest();
    const { spec } = buildA8CallSpec(model, CONTEXT, request);
    const configured = runtime([structuredProviderResponse(recordedBackground(model, request))]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
