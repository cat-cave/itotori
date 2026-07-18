// A4 dispatch boundary — the model-calling role routes deepseek-v4-flash through
// the SOLE ZDR dispatch boundary, proven offline on a recorded/memo path.
//
// No network and no Postgres: an in-memory memo store plus a recorded SSE
// response stand in for the provider. The proofs show the A4 call spec is the
// certified route-arc route (no provider named, ZDR policy, wiki-object
// terminal), that it actually reaches dispatch(), and that the production caller
// maps the returned route-arc into a draft the reconciler then settles.

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { WikiObject } from "../src/contracts/index.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import {
  foldRoute,
  type A3Context,
  type A3ModelCaller,
  type A3SceneNarrative,
} from "../src/roles/a3/index.js";
import {
  buildA4CallSpec,
  dispatchA4,
  dispatchingA4Caller,
  reconcileRoute,
  type A4Context,
  type A4ModelCaller,
  type A4ReconcileRequest,
  type A4RouteSpine,
} from "../src/roles/a4/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";
import {
  confirmedGenerationMetadataSource,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

const A4_PROFILE: MeasuredModelProfile = {
  name: "reasoning",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1", // itotori-225-audit-allow: synthetic per-attempt ceiling for the recorded-transport proof, not a billed cost
};

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const A3_CONTEXT: A3Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const CONTEXT: A4Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
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
      profile: A4_PROFILE,
      admission: {
        scope: "test:roles-a4",
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

function a3Recorded(): A3ModelCaller {
  return async (request) => {
    const anchor = String(request.scene.units[0]!.value.playOrderIndex);
    const narrative: A3SceneNarrative = {
      beat: "b",
      subtext: "s",
      sceneOpenThreads: [],
      sceneClaims: [
        { statement: "導入。", kind: "beat", confidence: "high", evidenceUnitIds: [anchor] },
      ],
      storySummary: `シーン${request.scene.sceneId}までの物語。`,
      storyOpenThreads: [],
      storyClaims: [
        {
          statement: "一貫。",
          kind: "story-so-far",
          confidence: "medium",
          evidenceUnitIds: [anchor],
        },
      ],
    };
    return narrative;
  };
}

async function scenario(): Promise<{
  model: ReturnType<typeof buildClaimFixture>["model"];
  spine: A4RouteSpine;
  request: A4ReconcileRequest;
  routeArc: WikiObject;
}> {
  const { model, snapshot } = buildClaimFixture();
  const folded = await foldRoute(model, A3_CONTEXT, a3Recorded());
  const spine: A4RouteSpine = {
    finalStorySoFar: folded.finalStorySoFar,
    coveredSceneIds: folded.coveredSceneIds,
  };
  const request: A4ReconcileRequest = {
    spine,
    routeScope: folded.finalStorySoFar.scope,
    sourceLanguage: model.sourceLanguage,
  };
  // A genuine, validated route-arc object stands in for the provider's return.
  const recorded: A4ModelCaller = async () => ({
    arcSummary: "ルートの弧。",
    callbacks: [
      {
        description: "後の場面が最初の決断を呼び戻す。",
        originEvidenceId: unitFactIdAt(snapshot, 0),
        destinationEvidenceId: unitFactIdAt(snapshot, 3),
      },
    ],
    foreshadows: [],
    relationshipDeltas: [
      {
        counterpartId: "char-a",
        before: "他人",
        after: "友人",
        fromEvidenceId: unitFactIdAt(snapshot, 0),
        toEvidenceId: unitFactIdAt(snapshot, 3),
      },
    ],
  });
  const result = await reconcileRoute(model, CONTEXT, spine, recorded);
  return { model, spine, request, routeArc: result.routeArc };
}

describe("A4 dispatches through the sole ZDR boundary", () => {
  it("PROOF: the A4 call spec is the certified, no-provider-named, route-arc route", async () => {
    const { model, request } = await scenario();
    const { spec, prompts } = buildA4CallSpec(model, CONTEXT, request);
    expect(spec.roleId).toBe("A4");
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
  });

  it("PROOF: a recorded route-arc draft returns through dispatch()", async () => {
    const { model, request, routeArc } = await scenario();
    const { spec, prompts } = buildA4CallSpec(model, CONTEXT, request);
    let fetches = 0;
    const configured = runtime([structuredProviderResponse(routeArc)], () => {
      fetches += 1;
    });
    const result = await dispatchA4(spec, prompts, configured);
    expect(result.status).toBe("success");
    expect(result.status === "success" ? result.value.kind : null).toBe("route-arc");
    expect(fetches).toBe(1); // it really reached the transport boundary
  });

  it("PROOF: the production caller maps the returned route-arc into a settled draft", async () => {
    const { model, request, routeArc } = await scenario();
    const configured = runtime([structuredProviderResponse(routeArc)]);
    const caller = dispatchingA4Caller(model, CONTEXT, configured);
    const draft = await caller(request);
    expect(draft.arcSummary).toBe("ルートの弧。");
    expect(draft.callbacks).toHaveLength(1);
    expect(draft.callbacks[0]!.originEvidenceId).not.toBeNull();
    expect(draft.callbacks[0]!.destinationEvidenceId).not.toBeNull();
    // The delta's endpoints are recovered from its paired relationship claim.
    expect(draft.relationshipDeltas[0]!.fromEvidenceId).not.toBe("");
    expect(draft.relationshipDeltas[0]!.toEvidenceId).not.toBe("");
  });

  it("PROOF: raw dispatch() rejects when the ZDR operator assertions are absent", async () => {
    const { model, request, routeArc } = await scenario();
    const { spec } = buildA4CallSpec(model, CONTEXT, request);
    const configured = runtime([structuredProviderResponse(routeArc)]);
    await expect(dispatch(spec, { ...configured, env: {} })).rejects.toThrow(
      /operator assertions/u,
    );
  });
});
