// Cultural Adaptation Analyst dispatch boundary — the model-calling role routes
// deepseek-v4-flash through the SOLE ZDR dispatch boundary, route-bound in EVERY
// run mode, proven offline.
//
// The proofs show: the A6 call spec is the certified route (no provider named,
// ZDR policy, wiki-object terminal); the certified-route assertion binds in every
// mode INCLUDING test-dev — where the shared boundary waives its own check — so a
// forged, non-certified model is rejected BEFORE the wire; and the public entry
// forwards a certified spec to dispatch() only after the route is proven.

import { describe, expect, it } from "vitest";

import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type RunModeValue,
} from "../src/contracts/index.js";
import type { DispatchRuntime } from "../src/llm/dispatch.js";
import {
  assertCallUsesCertifiedRoleModelProfile,
  deepSeekV4FlashProfile,
} from "../src/llm/role-model-profiles.js";
import {
  AdaptationRouteError,
  assembleAdaptationCallSpec,
  assertCertifiedRouteEveryMode,
  dispatchAdaptationAnalyst,
  dispatchingAdaptationModel,
  type AdaptationRequest,
  type FlaggedAdaptationCandidate,
} from "../src/roles/a6/index.js";

const HASH = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as `sha256:${string}`;

const CANDIDATE: FlaggedAdaptationCandidate = {
  unitFactId: "unit-fact-1",
  sourceUnitKey: "reallive:scene-0001#0000",
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  categories: ["honorific"],
  markers: ["先輩"],
  hasRubyWordplay: false,
  sourceText: "先輩、おはよう",
  playOrderIndex: 0,
};

function request(runMode: RunModeValue): AdaptationRequest {
  return {
    contextSnapshotId: HASH("a"),
    sourceLanguage: "ja-JP",
    operatorBrief: "brief",
    runMode,
    contextScope: "whole-game",
  };
}

const ref = (id: string): EncryptedPayloadRef => ({
  storageRef: id,
  contentHash: HASH("b"),
  encryption: "operator-managed",
});

function spec(runMode: RunModeValue): CallSpec {
  return assembleAdaptationCallSpec(request(runMode), CANDIDATE, {
    systemRef: ref("s"),
    userRef: ref("u"),
  });
}

/** A certified spec whose requestedModel has been swapped for a non-certified
 * one — the forgery the every-mode assertion must reject. */
function forgedModelSpec(runMode: RunModeValue): CallSpec {
  return { ...spec(runMode), requestedModel: "openai/gpt-forgery" };
}

/** A schema-valid adaptation-note terminal — enough for CallResult to parse; its
 * content is never inspected by the dispatch boundary. */
const TERMINAL_VALUE = {
  schemaVersion: "itotori.wiki-object.v1",
  objectId: "note:disp",
  version: 1,
  lang: "ja-JP",
  subject: { kind: "unit", id: "unit-fact-1" },
  scope: { kind: "global" },
  kind: "adaptation-note",
  body: {
    subjectId: "unit-fact-1",
    communicativeFunction: "敬称が関係性を示す。",
    constraints: [],
    boundedOptions: [{ optionId: "opt-1", strategy: "保持する。", tradeoffs: ["含みを保つ"] }],
  },
  claims: [],
  media: [],
  dependencies: [],
  provisional: false,
  provenance: {
    contextSnapshotId: HASH("a"),
    contextScope: "whole-game",
    runMode: "test-dev",
    snapshotKind: "context",
  },
};

function recordedSuccess(): CallResult {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    status: "success",
    memoKey: HASH("b"),
    requested: { model: deepSeekV4FlashProfile.model },
    memoHit: true,
    value: TERMINAL_VALUE,
    responseEventId: HASH("c"),
    served: { status: "confirmed", model: deepSeekV4FlashProfile.model, provider: "fireworks" },
    generationId: "generation:a6-disp",
    verification: "verified",
    usage: { promptTokens: 10, completionTokens: 10, reasoningTokens: 0, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.0001" },
    events: [],
  });
}

describe("A6 dispatch — the certified route is bound", () => {
  it("PROOF: the assembled spec routes deepseek-v4-flash, ZDR, no provider, via A6/analysis/wiki-object", () => {
    const built = spec("production");
    expect(built.roleId).toBe("A6");
    expect(built.purpose).toBe("analysis");
    expect(built.requestedModel).toBe(deepSeekV4FlashProfile.model);
    expect(built.output.name).toBe("wiki-object");
    expect(built.providerPolicy).toMatchObject({ allowFallbacks: true, zdr: true });
    // No provider is named or pinned anywhere in the route.
    expect(JSON.stringify(built.providerPolicy)).not.toMatch(/only|order/);
  });

  it("PROOF: a certified spec passes the every-mode assertion in production AND test-dev", () => {
    expect(() => assertCertifiedRouteEveryMode(spec("production"))).not.toThrow();
    expect(() => assertCertifiedRouteEveryMode(spec("test-dev"))).not.toThrow();
  });
});

describe("A6 dispatch — route-bound in EVERY mode, including test-dev", () => {
  it("PROOF: the every-mode assertion rejects a forged model in test-dev, where the shared boundary waives its check", () => {
    // The shared boundary WAIVES its certified-route check under test-dev — the
    // very gap A6 must not inherit: this forged test-dev spec sails through it.
    expect(() =>
      assertCallUsesCertifiedRoleModelProfile(forgedModelSpec("test-dev")),
    ).not.toThrow();
    // A6's own entry rejects the same forged spec, in test-dev, before the wire.
    expect(() => assertCertifiedRouteEveryMode(forgedModelSpec("test-dev"))).toThrow(
      AdaptationRouteError,
    );
    // And in production too — the route is certified in every mode.
    expect(() => assertCertifiedRouteEveryMode(forgedModelSpec("production"))).toThrow(
      AdaptationRouteError,
    );
  });

  it("PROOF: a forged test-dev spec is rejected BEFORE the wire — the dispatcher is never reached", async () => {
    let reached = false;
    const spyDispatcher = (async () => {
      reached = true;
      return recordedSuccess();
    }) as unknown as typeof import("../src/llm/dispatch.js").dispatch;
    const port = dispatchingAdaptationModel({} as DispatchRuntime, spyDispatcher);

    await expect(
      dispatchAdaptationAnalyst(forgedModelSpec("test-dev"), port),
    ).rejects.toBeInstanceOf(AdaptationRouteError);
    expect(reached).toBe(false);
  });

  it("PROOF: a certified spec is forwarded to dispatch() only after the route is proven", async () => {
    let seen: { spec: CallSpec; runtime: DispatchRuntime } | null = null;
    const runtime = { marker: "runtime" } as unknown as DispatchRuntime;
    const spyDispatcher = (async (s: CallSpec, r: DispatchRuntime) => {
      seen = { spec: s, runtime: r };
      return recordedSuccess();
    }) as unknown as typeof import("../src/llm/dispatch.js").dispatch;
    const port = dispatchingAdaptationModel(runtime, spyDispatcher);

    const result = await dispatchAdaptationAnalyst(spec("test-dev"), port);
    expect(result.status).toBe("success");
    expect(seen).not.toBeNull();
    expect(seen!.spec.roleId).toBe("A6");
    expect(seen!.runtime).toBe(runtime);
  });
});
