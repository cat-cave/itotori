// benchmark-back-translation-live-roundtrip — CI-safe wiring tests (NO real calls).
//
// Exercises the live-path producer of the §3 back-translation TRIPWIRE input with
// an INLINE fake ModelProvider (a canned response) and an injected fixture
// translator — never a network call. It proves:
//   - `ZdrBackTranslator` back-translates over the provider, passes the real
//     ProviderRunRecord through (cost source), and DISQUALIFIES a non-ZDR serve;
//   - `populateBackTranslations` fills `unit.backTranslation` on every unit so the
//     deterministic tripwire fires on meaning-loss on the (fixture-driven) live
//     path and stays quiet on a faithful unit;
//   - `runBackTranslateLiveSmoke` SKIPS (no cost) with no opt-in / no credential.
// The real ZDR round-trip is covered by the gated live-OR test the orchestrator
// runs; here the source of the back-translation is a fixture, so CI burns no budget.

import { describe, expect, it } from "vitest";
import {
  BACK_TRANSLATE_LIVE_FLAG,
  BackTranslateError,
  ZdrBackTranslator,
  backTranslationTripwire,
  populateBackTranslations,
  runBackTranslateLiveSmoke,
  type BackTranslateOutcome,
  type BackTranslateUnitInput,
  type BackTranslator,
  type MetricSystemInput,
} from "../../src/benchmark-stages/index.js";
import {
  ZERO_COST,
  localOnlyRoutingPosture,
  openRouterDefaultCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type OpenRouterRoutingPosture,
  type ProviderRunRecord,
} from "../../src/providers/index.js";

function fakeProviderRun(zdr: boolean): ProviderRunRecord {
  const posture: OpenRouterRoutingPosture = zdr
    ? localOnlyRoutingPosture("fake-provider")
    : { ...localOnlyRoutingPosture("fake-provider"), zdr: false };
  return {
    runId: "fake-back-translate-run",
    taskKind: "experiment",
    startedAt: "1970-01-01T00:00:00.000Z",
    completedAt: "1970-01-01T00:00:00.000Z",
    latencyMs: 0,
    status: "succeeded",
    provider: {
      providerFamily: "fake",
      endpointFamily: "recorded-fixture",
      providerName: "fake-back-translate",
      requestedModelId: "fake/model",
      actualModelId: "fake/model",
      requestedProviderId: "fake-provider",
    },
    structuredOutputMode: "none",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: [],
    tokenUsage: { tokenCountSource: "deterministic_counter", totalTokens: 0 },
    cost: ZERO_COST,
    routingPosture: posture,
    usageResponseJson: {},
    prompt: { presetId: "fake", templateVersion: "1.0.0", promptHash: "sha256:fake" },
  };
}

function fakeProvider(content: string, zdr: boolean): ModelProvider {
  return {
    descriptor: {
      family: "fake",
      endpointFamily: "recorded-fixture",
      providerName: "fake-back-translate",
      defaultModelId: "fake/model",
      capabilities: openRouterDefaultCapabilities,
    },
    invoke: async (_request: ModelInvocationRequest): Promise<ModelInvocationResult> => ({
      content,
      toolCalls: [],
      finishReason: "stop",
      providerRun: fakeProviderRun(zdr),
    }),
  };
}

function makeTranslator(content: string, zdr: boolean): ZdrBackTranslator {
  return new ZdrBackTranslator({
    provider: fakeProvider(content, zdr),
    providerId: "fake-provider",
    modelId: "fake/model",
    capabilities: openRouterDefaultCapabilities,
    sourceLanguageName: "Japanese",
    maxPriceUsd: 0.05,
    inputClassification: "synthetic_public",
  });
}

/** A canned fixture translator keyed by unitId → back-translation (NO real call). */
class FixtureBackTranslator implements BackTranslator {
  calls = 0;
  constructor(private readonly byUnit: Record<string, string>) {}
  async backTranslate(input: BackTranslateUnitInput): Promise<BackTranslateOutcome> {
    this.calls += 1;
    const backTranslation = this.byUnit[input.unitId];
    if (backTranslation === undefined) {
      throw new Error(`no fixture back-translation for ${input.unitId}`);
    }
    // Fixture path: NO providerRun (no real call, no cost).
    return { unitId: input.unitId, backTranslation };
  }
}

const FAITHFUL_ID = "019ed010-0000-7000-8000-00000000c001";
const MEANING_LOSS_ID = "019ed010-0000-7000-8000-00000000c002";

function twoUnitSystem(): MetricSystemInput {
  return {
    systemId: "wiring-smoke",
    systemKind: "itotori_draft",
    units: [
      {
        unitId: FAITHFUL_ID,
        label: "faithful",
        sourceText: "剣を取れ、勇者よ。",
        targetText: "Take up the sword, hero.",
      },
      {
        unitId: MEANING_LOSS_ID,
        label: "meaning-loss",
        sourceText: "剣を取れ、勇者よ。",
        targetText: "The weather is lovely today, isn't it?",
      },
    ],
  };
}

describe("ZdrBackTranslator — round-trip + passthrough + ZDR gate", () => {
  it("back-translates over the provider and passes the real provider run through", async () => {
    const translator = makeTranslator("剣を取れ、勇者よ。", true);
    const outcome = await translator.backTranslate({
      unitId: FAITHFUL_ID,
      label: "faithful",
      targetText: "Take up the sword, hero.",
    });
    expect(outcome.unitId).toBe(FAITHFUL_ID);
    expect(outcome.backTranslation).toBe("剣を取れ、勇者よ。");
    expect(outcome.providerRun?.cost.costKind).toBe("zero");
    expect(outcome.providerRun?.routingPosture.zdr).toBe(true);
  });

  it("DISQUALIFIES a non-ZDR serve (privacy gate)", async () => {
    const translator = makeTranslator("剣を取れ、勇者よ。", false);
    await expect(
      translator.backTranslate({
        unitId: FAITHFUL_ID,
        label: "x",
        targetText: "Take up the sword.",
      }),
    ).rejects.toThrow(/not ZDR-routed/);
  });

  it("rejects empty back-translation content", async () => {
    const translator = makeTranslator("   ", true);
    await expect(
      translator.backTranslate({
        unitId: FAITHFUL_ID,
        label: "x",
        targetText: "Take up the sword.",
      }),
    ).rejects.toThrow(BackTranslateError);
  });
});

describe("populateBackTranslations — fills the tripwire input; tripwire fires on meaning-loss", () => {
  it("populates unit.backTranslation and trips ONLY on the meaning-loss unit", async () => {
    // Faithful unit back-translates ≈ source (no trip); meaning-loss unit
    // back-translates to unrelated JP (trips) — the injected fixture stands in
    // for the real ZDR MT round-trip, so this runs the exact live-path shape.
    const fixture = new FixtureBackTranslator({
      [FAITHFUL_ID]: "剣を取れ、勇者よ。",
      [MEANING_LOSS_ID]: "今日は良い天気ですね。",
    });
    const populated = await populateBackTranslations([twoUnitSystem()], fixture);
    expect(fixture.calls).toBe(2);
    // No real call on the fixture path → no provider runs / no cost.
    expect(populated.runs).toHaveLength(0);

    const [system] = populated.systems;
    expect(system?.units[0]?.backTranslation).toBe("剣を取れ、勇者よ。");
    expect(system?.units[1]?.backTranslation).toBe("今日は良い天気ですね。");

    const outcome = backTranslationTripwire(system!, 0.3);
    const byLabel = new Map(outcome.tripwires.map((t) => [t.label, t.tripped]));
    expect(byLabel.get("faithful")).toBe(false);
    expect(byLabel.get("meaning-loss")).toBe(true);
    expect(outcome.findings.length).toBe(1);
    // Structural proof it is a tripwire, not a score.
    expect((outcome as unknown as { score?: number }).score).toBeUndefined();
  });

  it("rejects a translator that returns a mismatched unit id", async () => {
    const rogue: BackTranslator = {
      backTranslate: async () => ({ unitId: "wrong", backTranslation: "x" }),
    };
    await expect(populateBackTranslations([twoUnitSystem()], rogue)).rejects.toThrow(
      BackTranslateError,
    );
  });
});

describe("runBackTranslateLiveSmoke — env gating (no cost when unset)", () => {
  it("skips with missing_opt_in when the flag is unset", async () => {
    const result = await runBackTranslateLiveSmoke({ env: {} });
    expect(result).toEqual({ status: "skipped", reason: "missing_opt_in" });
  });

  it("skips with missing_provider_credential when opted in without a key", async () => {
    const result = await runBackTranslateLiveSmoke({
      env: { [BACK_TRANSLATE_LIVE_FLAG]: "1" },
    });
    expect(result).toEqual({ status: "skipped", reason: "missing_provider_credential" });
  });
});
