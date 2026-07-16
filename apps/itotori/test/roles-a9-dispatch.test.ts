// A9 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A9 call spec is the
// certified A9 route (no provider named, ZDR policy, wiki-object terminal, ZERO
// tools), that the public dispatch entry asserts that certified route in EVERY
// mode — test-dev included — and rejects a forged spec BEFORE the transport, that
// a recorded arc draft returns through dispatch(), and that the production caller
// maps it while carrying the model's from/to only as ignored asserted re-timing.

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
  A9RoleError,
  assembleCharacterRouteArc,
  assertCertifiedRoute,
  buildA9CallSpec,
  characterIndex,
  dispatchA9,
  dispatchingA9Caller,
  readCharacterRouteEvidence,
  routeOccurrenceWindow,
  type A9ArcRequest,
  type A9Context,
} from "../src/roles/a9/index.js";
import {
  buildClaimFixture,
  unitFactIdAt,
  type FixtureCharacterSpec,
} from "./support/claim-fixture.js";
import {
  confirmedGenerationMetadataSource,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const A9_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const CONTEXT: A9Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

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
      profile: A9_PROFILE,
      admission: {
        scope: "test:roles-a9",
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

function arcRequest(): {
  model: ReturnType<typeof buildClaimFixture>["model"];
  request: A9ArcRequest;
} {
  const { model } = buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
  const character = characterIndex(model).find((c) => c.characterId === "nam-11")!;
  const evidence = readCharacterRouteEvidence(model, CONTEXT, character, "route-a");
  const windowUnitIds = routeOccurrenceWindow(model, evidence.sceneIds, "route-a").map(
    (u) => u.factId,
  );
  return { model, request: { evidence, windowUnitIds, sourceLanguage: model.sourceLanguage } };
}

/** A genuine recorded arc object the "provider" returns — a valid character-route-
 * arc with one decode-grounded shift. */
function recordedArc(model: ReturnType<typeof buildClaimFixture>["model"]): WikiObject {
  const { snapshot } = buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
  const character = characterIndex(model).find((c) => c.characterId === "nam-11")!;
  const evidence = readCharacterRouteEvidence(model, CONTEXT, character, "route-a");
  return assembleCharacterRouteArc(model, CONTEXT, character, evidence, {
    shifts: [
      {
        stateBefore: "よそよそしい",
        stateAfter: "打ち解ける",
        fromEvidenceId: unitFactIdAt(snapshot, 0),
        toEvidenceId: unitFactIdAt(snapshot, 2),
      },
    ],
  });
}

describe("A9 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A9 call spec is the certified, no-provider-named, wiki-object route with ZERO tools", () => {
    const { model, request } = arcRequest();
    const { spec } = buildA9CallSpec(model, CONTEXT, request);
    expect(spec.roleId).toBe("A9");
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
    const { model, request } = arcRequest();
    const { spec } = buildA9CallSpec(model, CONTEXT, request);
    expect(spec.runMode).toBe("test-dev");
    expect(() => assertCertifiedRoute(spec)).not.toThrow();
    const noZdr = { ...spec, providerPolicy: { ...spec.providerPolicy, zdr: false } } as CallSpec;
    expect(() => assertCertifiedRoute(noZdr)).toThrow(A9RoleError);
    const wrongModel = { ...spec, requestedModel: "openai/gpt-4o" } as CallSpec;
    expect(() => assertCertifiedRoute(wrongModel)).toThrow(/route-not-certified/u);
    const withTool = { ...spec, tools: [{ name: "web_search" } as never] } as CallSpec;
    expect(() => assertCertifiedRoute(withTool)).toThrow(/route-not-certified/u);
  });

  it("PROOF: dispatchA9 asserts the certified route BEFORE the transport (forged spec, zero fetches)", async () => {
    const { model, request } = arcRequest();
    const { spec, prompts } = buildA9CallSpec(model, CONTEXT, request);
    const wrongModel = { ...spec, requestedModel: "openai/gpt-4o" } as CallSpec;
    let fetches = 0;
    const configured = runtime([], () => {
      fetches += 1;
    });
    await expect(dispatchA9(wrongModel, prompts, configured)).rejects.toThrow(
      /route-not-certified/u,
    );
    expect(fetches).toBe(0);
  });

  it("PROOF: a recorded character-route-arc draft returns through dispatch()", async () => {
    const { model, request } = arcRequest();
    const { spec, prompts } = buildA9CallSpec(model, CONTEXT, request);
    let fetches = 0;
    const configured = runtime([structuredProviderResponse(recordedArc(model))], () => {
      fetches += 1;
    });
    const result = await dispatchA9(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("character-route-arc");
    expect(fetches).toBe(1);
  });

  it("PROOF: the production caller maps the dispatched draft (from/to carried only as asserted re-timing)", async () => {
    const { model, request } = arcRequest();
    const configured = runtime([structuredProviderResponse(recordedArc(model))]);
    const caller = dispatchingA9Caller(model, CONTEXT, configured);
    const draft = await caller(request);
    expect(draft.shifts[0]!.stateBefore).toBe("よそよそしい");
    expect(draft.shifts[0]!.fromEvidenceId).toBe(request.windowUnitIds[0]);
    expect(draft.shifts[0]!.toEvidenceId).toBe(request.windowUnitIds[2]);
    // The returned play order is only the model's ASSERTED re-timing.
    expect(draft.shifts[0]!.assertedFromPlayOrder).toBe(0);
    expect(draft.shifts[0]!.assertedToPlayOrder).toBe(2);
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request } = arcRequest();
    const { spec } = buildA9CallSpec(model, CONTEXT, request);
    const configured = runtime([structuredProviderResponse(recordedArc(model))]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
