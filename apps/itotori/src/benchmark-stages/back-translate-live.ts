// benchmark-back-translation-live-roundtrip — the REAL ZDR MT round-trip that
// populates the §3 deterministic back-translation TRIPWIRE input on the LIVE path.
//
// Methodology §3: back-translation is a cheap gross-meaning-loss TRIPWIRE, not a
// ranking score. The DETERMINISTIC tripwire (`backTranslationTripwire`) consumes
// an INJECTED `unit.backTranslation` — the target text machine-translated back to
// the source language — and trips when its character-bigram Dice similarity to the
// decoded source falls below the floor. That injected field is deliberately kept
// OUTSIDE the pure deterministic layer (no model / provider / clock there); THIS
// module is the live-path producer of it.
//
// Two paths, one seam (`BackTranslator`):
//   - TEST path — an injected fixture `BackTranslator` supplies the round-trip
//     result directly, so CI is deterministic and burns no budget (no real call).
//   - LIVE path — `ZdrBackTranslator` wraps an OpenRouter ZDR-routed
//     `ModelProvider` (the DEV_PAIR pair), back-translates each unit's target text
//     to the source language over the wire, asserts the serve was ZDR-routed
//     (§4.1-style privacy gate) before accepting a single byte, and carries the
//     provider's REAL `usage.cost` through `providerRun` — cost is NEVER
//     approximated or hardcoded (audit-no-hardcoded-cost).
//
// `populateBackTranslations` fans a `BackTranslator` over the contestant systems'
// units and returns the same systems with `unit.backTranslation` filled, so the
// enriched systems feed straight into `runDeterministicMetricSuite` and the
// tripwire fires on meaning-loss on the live path. `runBackTranslateLiveSmoke` is
// the env-gated real-OR proof (skips with no cost unless opted in), mirroring the
// blind-judge live smoke.

import { createHash } from "node:crypto";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  getModelCapabilities,
  openRouterApiKeyFromEnv,
  DEV_PAIR,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderInputClassification,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
  type ProviderRunRecord,
} from "../providers/index.js";
import { backTranslationTripwire } from "./deterministic-metrics/back-translation-tripwire.js";
import {
  DEFAULT_METRIC_CONFIG,
  type BackTranslationTripwire,
  type MetricSystemInput,
  type MetricUnit,
} from "./deterministic-metrics/index.js";

export class BackTranslateError extends Error {
  constructor(detail: string) {
    super(`benchmark back-translate refused: ${detail}`);
    this.name = "BackTranslateError";
  }
}

/** Opt-in flag for the real ZDR back-translate smoke (unset → skip, no cost). */
export const BACK_TRANSLATE_LIVE_FLAG = "ITOTORI_BACK_TRANSLATE_LIVE";
/** Tight per-call USD cap for each live back-translation invocation. */
export const BACK_TRANSLATE_LIVE_MAX_PRICE_USD = 0.05;

// ---------------------------------------------------------------------------
// The producer seam — fixture (test) vs ZDR (live).
// ---------------------------------------------------------------------------

/** One unit to back-translate: its target text plus the id it belongs to. */
export type BackTranslateUnitInput = {
  unitId: string;
  label: string;
  /** The contestant's rendered target-language text to translate back. */
  targetText: string;
};

/** The round-trip result for one unit: the back-translation + its provider run. */
export type BackTranslateOutcome = {
  unitId: string;
  /** Target text machine-translated back to the source language. */
  backTranslation: string;
  /**
   * The REAL provider run for this call. `providerRun.cost` is the authoritative
   * billed `usage.cost` (never approximated); the ZDR posture is on
   * `providerRun.routingPosture`. Absent on the fixture path (no real call).
   */
  providerRun?: ProviderRunRecord;
};

/**
 * The seam the deterministic suite's live-path producer depends on. The panel
 * orchestration is byte-identical across the fixture and ZDR implementations —
 * only the source of the back-translation (a canned fixture vs a real ZDR MT
 * call) differs, exactly like the blind-judge FixtureJudge / ZdrModelJudge split.
 */
export interface BackTranslator {
  backTranslate(input: BackTranslateUnitInput): Promise<BackTranslateOutcome>;
}

/** Options for the real ZDR back-translator. */
export type ZdrBackTranslatorOptions = {
  /** The ZDR-routed model provider (an OpenRouter pair on the live path). */
  provider: ModelProvider;
  /** The pinned (preferred) upstream provider id sent on the request. */
  providerId: string;
  /** The requested model id sent on the request. */
  modelId: string;
  /** Capability sheet the request is built against (structured-output modes, …). */
  capabilities: ModelCapabilities;
  /** Human-readable source-language name the target is translated BACK into (e.g. "Japanese"). */
  sourceLanguageName: string;
  /** Per-call USD cap mirrored to the request and enforced against usage.cost. */
  maxPriceUsd: number;
  /**
   * The privacy classification of the text being translated. The real benchmark
   * corpus is `private_corpus`; the synthetic-public smoke passes
   * `synthetic_public`. Either way the request carries `zdr:true`.
   */
  inputClassification: ProviderInputClassification;
};

const BACK_TRANSLATE_PRESET_ID = "itotori-benchmark-back-translate";

/**
 * The REAL ZDR back-translator. Wraps a `ModelProvider`, back-translates one
 * unit's target text to the source language over the wire, and — before
 * accepting any byte — DISQUALIFIES a non-ZDR serve (throws), mirroring the
 * §4.1 blind-judge ZDR gate. The provider's REAL `ProviderRunRecord` (carrying
 * `usage.cost`) is passed straight through; cost is never approximated here.
 */
export class ZdrBackTranslator implements BackTranslator {
  private readonly provider: ModelProvider;
  private readonly providerId: string;
  private readonly modelId: string;
  private readonly capabilities: ModelCapabilities;
  private readonly sourceLanguageName: string;
  private readonly maxPriceUsd: number;
  private readonly inputClassification: ProviderInputClassification;

  constructor(options: ZdrBackTranslatorOptions) {
    this.provider = options.provider;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.capabilities = options.capabilities;
    this.sourceLanguageName = options.sourceLanguageName;
    this.maxPriceUsd = options.maxPriceUsd;
    this.inputClassification = options.inputClassification;
  }

  async backTranslate(input: BackTranslateUnitInput): Promise<BackTranslateOutcome> {
    const request = this.buildRequest(input);
    const result = await this.provider.invoke(request);
    const run = result.providerRun;
    // Privacy gate: a serve whose wire routing posture is not zdr:true is
    // DISQUALIFIED (never consumed) — the round-trip is ZDR-routed only.
    if (run.routingPosture.zdr !== true) {
      throw new BackTranslateError(
        `unit '${input.unitId}' back-translation was not ZDR-routed (routingPosture.zdr=${String(run.routingPosture.zdr)})`,
      );
    }
    const content = result.content;
    if (content === null || content.trim().length === 0) {
      throw new BackTranslateError(
        `unit '${input.unitId}' back-translation returned empty content`,
      );
    }
    return { unitId: input.unitId, backTranslation: content.trim(), providerRun: run };
  }

  private buildRequest(input: BackTranslateUnitInput): ModelInvocationRequest {
    // Suppress the (unused-until-schema) capability sheet lint without dropping
    // it from the surface: a future structured-output variant reads it here.
    void this.capabilities;
    const promptHash = `sha256:${createHash("sha256")
      .update(`back-translate:${this.sourceLanguageName}:${input.unitId}`)
      .digest("hex")}`;
    return {
      taskKind: "experiment",
      modelId: this.modelId,
      providerId: this.providerId,
      inputClassification: this.inputClassification,
      messages: [
        {
          role: "system",
          content:
            `You are a back-translation engine for a localization benchmark. Translate the ` +
            `user's target-language text back into ${this.sourceLanguageName}, preserving its ` +
            `meaning as literally as possible. Output ONLY the ${this.sourceLanguageName} ` +
            `translation as plain text — no quotes, no notes, no romanization, no explanation.`,
        },
        { role: "user", content: input.targetText },
      ],
      // Plain completion (no structured output) — the ZDR-routable mode for the
      // DEV_PAIR pair; a back-translation is free-form source-language text.
      generation: { temperature: 0, maxOutputTokens: 1024 },
      maxPriceUsd: this.maxPriceUsd,
      prompt: {
        presetId: BACK_TRANSLATE_PRESET_ID,
        templateVersion: "1.0.0",
        promptHash,
        schemaVersion: "itotori.prompt-preset.v0",
        configSnapshot: { unitId: input.unitId, sourceLanguage: this.sourceLanguageName },
      },
      fallbackModels: [],
    };
  }
}

// ---------------------------------------------------------------------------
// The population step — fan the translator over every system's units.
// ---------------------------------------------------------------------------

/** The enriched systems plus every real provider run made to produce them. */
export type PopulateBackTranslationsResult = {
  /** The input systems with `unit.backTranslation` populated on every unit. */
  systems: MetricSystemInput[];
  /** Every REAL provider run (one per back-translated unit) — carries usage.cost. */
  runs: ProviderRunRecord[];
};

/**
 * Populate `unit.backTranslation` for every unit of every system via the given
 * `BackTranslator`, returning fresh enriched systems (input untouched) plus the
 * collected provider runs. The enriched systems feed straight into
 * `runDeterministicMetricSuite`, which runs the deterministic tripwire over the
 * now-present back-translations. On the live path the translator is a
 * `ZdrBackTranslator`; in CI it is an injected fixture.
 */
export async function populateBackTranslations(
  systems: readonly MetricSystemInput[],
  translator: BackTranslator,
): Promise<PopulateBackTranslationsResult> {
  const enriched: MetricSystemInput[] = [];
  const runs: ProviderRunRecord[] = [];
  for (const system of systems) {
    const units: MetricUnit[] = [];
    for (const unit of system.units) {
      const outcome = await translator.backTranslate({
        unitId: unit.unitId,
        label: unit.label,
        targetText: unit.targetText,
      });
      if (outcome.unitId !== unit.unitId) {
        throw new BackTranslateError(
          `translator returned outcome for '${outcome.unitId}' when asked for '${unit.unitId}'`,
        );
      }
      if (outcome.providerRun !== undefined) {
        runs.push(outcome.providerRun);
      }
      units.push({ ...unit, backTranslation: outcome.backTranslation });
    }
    enriched.push({ ...system, units });
  }
  return { systems: enriched, runs };
}

// ---------------------------------------------------------------------------
// The env-gated REAL ZDR smoke (mirrors the blind-judge live smoke).
// ---------------------------------------------------------------------------

export type BackTranslateLiveOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
};

/** One trip signal from the smoke proof (the deterministic tripwire outcome). */
export type BackTranslateLiveResult =
  | {
      status: "passed";
      /** The served (model, provider) pair recorded off the real runs. */
      servedPair: { model: string; provider: string | undefined };
      /** Every real provider run (each carries the authoritative usage.cost). */
      runs: ProviderRunRecord[];
      /** The deterministic tripwire signals over the live back-translations. */
      tripwires: BackTranslationTripwire[];
      /** True iff at least one unit tripped (proves the tripwire fires live). */
      tripped: boolean;
    }
  | { status: "skipped"; reason: "missing_opt_in" | "missing_provider_credential" };

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

/**
 * A tiny synthetic-public 1-system, 2-unit smoke feed (no private bytes): one
 * unit whose target is FAITHFUL to the Japanese source, and one whose target
 * carries a GROSS meaning loss. After the real round-trip the faithful unit's
 * back-translation stays close to the source (no trip) and the meaning-loss
 * unit's diverges (trips) — proving the tripwire fires on meaning-loss live.
 */
function smokeSystem(): MetricSystemInput {
  return {
    systemId: "back-translate-live-smoke",
    systemKind: "itotori_draft",
    units: [
      {
        unitId: "019ed010-0000-7000-8000-00000000c001",
        label: "smoke#faithful",
        sourceText: "剣を取れ、勇者よ。",
        targetText: "Take up the sword, hero.",
      },
      {
        unitId: "019ed010-0000-7000-8000-00000000c002",
        label: "smoke#meaning-loss",
        sourceText: "剣を取れ、勇者よ。",
        targetText: "The weather is lovely today, isn't it?",
      },
    ],
  };
}

/**
 * Run the REAL ZDR back-translation round-trip over a bounded synthetic-public
 * smoke system, then run the deterministic tripwire over the live-produced
 * back-translations. Skips (no cost) unless opted in with a valid credential.
 * The account-wide ZDR assertion is checked BEFORE any live byte.
 */
export async function runBackTranslateLiveSmoke(
  options: BackTranslateLiveOptions = {},
): Promise<BackTranslateLiveResult> {
  const env = options.env ?? process.env;
  if (env[BACK_TRANSLATE_LIVE_FLAG] !== "1") {
    return { status: "skipped", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", reason: "missing_provider_credential" };
  }
  // Privacy gate: account-wide ZDR must be asserted before any live byte.
  assertOpenRouterZdrAccount(env);

  const capabilities = getModelCapabilities(DEV_PAIR);
  const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
    modelId: DEV_PAIR.modelId,
    apiKey,
    capabilities,
    routing: { zdr: true, dataCollection: "deny", allowFallbacks: true },
    live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
  };
  if (options.fetch !== undefined) {
    providerOptions.fetch = options.fetch;
  }
  const translator = new ZdrBackTranslator({
    provider: new OpenRouterProvider(providerOptions),
    providerId: DEV_PAIR.providerId,
    modelId: DEV_PAIR.modelId,
    capabilities,
    sourceLanguageName: "Japanese",
    maxPriceUsd: BACK_TRANSLATE_LIVE_MAX_PRICE_USD,
    inputClassification: "synthetic_public",
  });

  const populated = await populateBackTranslations([smokeSystem()], translator);
  const [system] = populated.systems;
  if (system === undefined) {
    throw new BackTranslateError("smoke produced no enriched system");
  }
  const outcome = backTranslationTripwire(
    system,
    DEFAULT_METRIC_CONFIG.backTranslationTripwireFloor,
  );
  const lastRun = populated.runs[populated.runs.length - 1];
  const servedPair = {
    model: lastRun?.provider.actualModelId ?? DEV_PAIR.modelId,
    provider: lastRun?.provider.upstreamProvider,
  };
  return {
    status: "passed",
    servedPair,
    runs: populated.runs,
    tripwires: outcome.tripwires,
    tripped: outcome.tripwires.some((t) => t.tripped),
  };
}
