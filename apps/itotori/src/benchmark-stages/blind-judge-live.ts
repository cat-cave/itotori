// benchmark-blind-judge-panel — env-gated REAL multi-family ZDR smoke (§4).
//
// The live counterpart to the deterministic fixture-judge tests. It is BOUND
// tightly and gated behind an explicit opt-in flag + an exported OpenRouter key
// + the account-wide ZDR assertion (the privacy gate), so CI never burns budget:
// with the flag unset it returns `skipped`, exactly like the provider-proof live
// path. When enabled it stands up ≥2 judges from DIFFERENT model families (from
// `ITOTORI_BLIND_JUDGE_PANEL`), each an OpenRouter ZDR-routed pair, and runs the
// SAME `runBlindJudgePanel` orchestrator the tests drive — reading the REAL
// `usage.cost` off every judge call (§4.1), never approximating.

import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  openRouterApiKeyFromEnv,
  openRouterDefaultCapabilities,
  type ModelCapabilities,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../providers/index.js";
import { buildDecodedContextFeed, type DecodedContextFeedInput } from "./decoded-context-feed.js";
import { runBlindJudgePanel, type BlindJudgePanelResult } from "./blind-judge-panel.js";
import { ZdrModelJudge } from "./blind-judge-zdr-adapter.js";
import type { NarrativeStructure } from "../structure/index.js";

export const BLIND_JUDGE_LIVE_FLAG = "ITOTORI_BLIND_JUDGE_LIVE";
export const BLIND_JUDGE_PANEL_ENV = "ITOTORI_BLIND_JUDGE_PANEL";
/** Tight per-call USD cap for each live judge invocation. */
export const BLIND_JUDGE_LIVE_MAX_PRICE_USD = 0.05;

/** One configured live judge — a (model, provider) pair on a named family. */
export type BlindJudgeLiveConfig = {
  judgeId: string;
  modelFamily: string;
  modelId: string;
  providerId: string;
};

export type BlindJudgeLiveResult =
  | { status: "passed"; result: BlindJudgePanelResult }
  | {
      status: "skipped";
      reason: "missing_opt_in" | "missing_provider_credential" | "insufficient_panel_config";
    };

export type BlindJudgeLiveOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Override the configured panel (else parsed from `ITOTORI_BLIND_JUDGE_PANEL`). */
  judges?: BlindJudgeLiveConfig[];
};

/**
 * Parse the panel config from `ITOTORI_BLIND_JUDGE_PANEL`: a JSON array of
 * `{ judgeId, modelFamily, modelId, providerId }`. Returns `[]` when unset or
 * malformed (the caller then skips) — the config is Trevor's to supply (§12.4).
 */
export function parseBlindJudgePanelConfig(raw: string | undefined): BlindJudgeLiveConfig[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: BlindJudgeLiveConfig[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const { judgeId, modelFamily, modelId, providerId } = record;
    if (
      typeof judgeId === "string" &&
      typeof modelFamily === "string" &&
      typeof modelId === "string" &&
      typeof providerId === "string"
    ) {
      out.push({ judgeId, modelFamily, modelId, providerId });
    }
  }
  return out;
}

/** ZDR-routable capabilities — plain_json is the proven ZDR mode (see provider-proof). */
function zdrJudgeCapabilities(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "unsupported",
      jsonObject: "unsupported",
      plainJsonExtraction: "supported",
      preferredModes: ["plain_json"],
    },
  };
}

/** A tiny synthetic-public 1-unit feed for the live smoke (no private bytes). */
function smokeFeed(): DecodedContextFeedInput {
  const structure: NarrativeStructure = {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 1,
    sceneDispatchOrder: [1],
    scenes: [
      {
        sceneId: 1,
        selectionControl: "text-window",
        nextScene: null,
        messages: [
          { order: 0, speaker: "Guide", text: "The gate is open, traveler.", textSurface: null },
        ],
        choices: [],
      },
    ],
  };
  const unitId = "019ed010-0000-7000-8000-00000000b001";
  return {
    structure,
    unitRefs: [{ unitId, sceneId: 1, messageOrder: 0 }],
    candidates: [
      { contestantId: "system-one", unitId, candidateText: "The gate is open now, traveler." },
      { contestantId: "system-two", unitId, candidateText: "Gate open. You go." },
    ],
  };
}

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
 * Run the real multi-family ZDR judge panel over a bounded synthetic-public
 * smoke unit. Skips (no cost) unless opted in with a valid ≥2-family config.
 */
export async function runBlindJudgePanelLiveSmoke(
  options: BlindJudgeLiveOptions = {},
): Promise<BlindJudgeLiveResult> {
  const env = options.env ?? process.env;
  if (env[BLIND_JUDGE_LIVE_FLAG] !== "1") {
    return { status: "skipped", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", reason: "missing_provider_credential" };
  }
  // Privacy gate: account-wide ZDR must be asserted before any live byte.
  assertOpenRouterZdrAccount(env);

  const configs = options.judges ?? parseBlindJudgePanelConfig(env[BLIND_JUDGE_PANEL_ENV]);
  const families = new Set(configs.map((c) => c.modelFamily));
  if (configs.length < 2 || families.size < 2) {
    return { status: "skipped", reason: "insufficient_panel_config" };
  }

  const capabilities = zdrJudgeCapabilities();
  const judges = configs.map((config) => {
    const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
      modelId: config.modelId,
      apiKey,
      capabilities,
      routing: { zdr: true, dataCollection: "deny", allowFallbacks: true },
      live: { enabled: true, artifactRecorder: memoryRecorder(), rawCapture: "disabled" },
    };
    if (options.fetch !== undefined) {
      providerOptions.fetch = options.fetch;
    }
    return new ZdrModelJudge({
      judgeId: config.judgeId,
      modelId: config.modelId,
      providerId: config.providerId,
      modelFamily: config.modelFamily,
      provider: new OpenRouterProvider(providerOptions),
      capabilities,
      maxPriceUsd: BLIND_JUDGE_LIVE_MAX_PRICE_USD,
    });
  });

  const feed = buildDecodedContextFeed(smokeFeed());
  const result = await runBlindJudgePanel({
    feed,
    judges,
    panelSeed: "blind-judge-live-smoke",
  });
  return { status: "passed", result };
}
