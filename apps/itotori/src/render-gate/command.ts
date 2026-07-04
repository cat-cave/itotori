// visual-inspection-gate-for-all-render-nodes — live command + render-validate wiring.
//
// This is the enforcement step every render/screenshot node runs on its
// emitted proof frame: it inspects the pixels with a ZDR-routed OpenRouter
// VISION call and records the structured verdict ALONGSIDE render-evidence.
// A frame the vision call marks incoherent / target-text-illegible /
// redaction-wrong FAILS the render proof (the command throws + exits nonzero).
//
// Live mode is gated exactly like provider-proof: an explicit opt-in flag +
// an exported OpenRouter key + the account-wide ZDR assertion (the privacy
// gate). The key is NEVER printed. The real billed cost comes from
// `usage.cost`; the served (model, providerId) pair is recorded verbatim.

import { readFileSync } from "node:fs";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  openRouterApiKeyFromEnv,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../providers/index.js";
import {
  runVisionGate,
  visionGateCapabilities,
  type RedactionMode,
  type VisionGateArtifact,
  type VisionGateResult,
} from "./vision-gate.js";

export const VISION_GATE_LIVE_FLAG = "ITOTORI_VISION_GATE_LIVE";
export const VISION_GATE_MODEL_ENV = "ITOTORI_VISION_GATE_MODEL";
export const VISION_GATE_PROVIDER_ID_ENV = "ITOTORI_VISION_GATE_PROVIDER_ID";
/** Tight per-request USD cap for the single live vision-inspection call. */
export const VISION_GATE_LIVE_MAX_PRICE_USD = 0.02;

/**
 * VISION_PAIR — the (modelId, providerId) preference for the eyes-on-pixels
 * gate. Imported by name; the provider literal lives here so it is not
 * scattered across the render-node surface (same discipline as DEV_PAIR).
 *
 * Why `qwen/qwen3-vl-235b-a22b-instruct` with `parasail` as the PREFERRED
 * provider (evidence-grounded, live-verified 2026-07-03):
 *
 *   - Vision + ZDR, PROVEN LIVE. A tiny image posted with
 *     `provider: { zdr:true, data_collection:"deny", allow_fallbacks:true }`
 *     returned HTTP 200 served by Parasail with a real `usage.cost`
 *     (`0.00001976`) — i.e. a ZDR-allow-list provider accepted image input
 *     under the ZDR posture (no 404 ZDR envelope). The candidate Anthropic /
 *     Google vision slugs returned a provider-side 400 "Could not process
 *     image" on the probe image (a Vertex constraint), so qwen3-vl is the
 *     validated ZDR vision pair.
 *   - `providerId` is the PREFERRED provider (`order[0]`), NOT a hard pin:
 *     with `allow_fallbacks:true` OpenRouter may serve another ZDR-allow-list
 *     vision provider (DeepInfra also served qwen3-vl live); `zdr:true`
 *     confines the fallback pool. The served pair is recorded verbatim.
 *   - Strong OCR / scene coherence — the two properties the gate depends on
 *     (is this a real composited scene; is the localized text legible).
 *
 * Overridable per-run via ITOTORI_VISION_GATE_MODEL / _PROVIDER_ID for
 * revalidation; the default lives in code so a swap is commit-visible.
 */
export const VISION_PAIR: { readonly modelId: string; readonly providerId: string } = Object.freeze(
  {
    modelId: "qwen/qwen3-vl-235b-a22b-instruct",
    providerId: "parasail",
  },
);

export type VisionGateCommandOptions = {
  /** Path to the rendered proof-frame PNG. */
  framePath: string;
  /** The localized target-language text expected in the frame (model input). */
  expectedText: string;
  redactionMode: RedactionMode;
  mode?: "live";
  /**
   * Provider input classification. Defaults to `private_corpus` (a real game
   * frame is private → forces `provider.zdr=true` on the wire). Tests / public
   * fixtures may pass `synthetic_public`.
   */
  inputClassification?: ModelInvocationRequest["inputClassification"];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /**
   * Test-only injection: drive the gate with a supplied provider instead of
   * constructing the live OpenRouter provider. Never used on the real path.
   */
  providerOverride?: ModelProvider;
  /** Per-request USD ceiling; defaults to {@link VISION_GATE_LIVE_MAX_PRICE_USD}. */
  maxPriceUsd?: number;
};

export type VisionGateCommandResult =
  | { status: "passed" | "rejected"; result: VisionGateResult }
  | { status: "skipped"; reason: "missing_opt_in" | "missing_provider_credential" };

/**
 * Run the vision gate on a rendered proof frame. Returns `rejected` (does not
 * throw) so the verdict is always recordable; the CLI wrapper turns a
 * `rejected` result into a nonzero exit so the render node's acceptance fails.
 */
export async function runVisionGateCommand(
  options: VisionGateCommandOptions,
): Promise<VisionGateCommandResult> {
  const env = options.env ?? process.env;
  const framePng = readFileSync(options.framePath);
  const inputClassification = options.inputClassification ?? "private_corpus";
  const maxPriceUsd = options.maxPriceUsd ?? VISION_GATE_LIVE_MAX_PRICE_USD;

  let provider: ModelProvider;
  let modelId: string;
  let providerId: string;

  if (options.providerOverride !== undefined) {
    provider = options.providerOverride;
    modelId = env[VISION_GATE_MODEL_ENV] ?? VISION_PAIR.modelId;
    providerId = env[VISION_GATE_PROVIDER_ID_ENV] ?? VISION_PAIR.providerId;
  } else {
    if (env[VISION_GATE_LIVE_FLAG] !== "1") {
      return { status: "skipped", reason: "missing_opt_in" };
    }
    const apiKey = openRouterApiKeyFromEnv(env);
    if (!apiKey) {
      return { status: "skipped", reason: "missing_provider_credential" };
    }
    // The privacy gate: account-wide ZDR must be asserted before any live byte.
    assertOpenRouterZdrAccount(env);

    modelId = env[VISION_GATE_MODEL_ENV] ?? VISION_PAIR.modelId;
    providerId = env[VISION_GATE_PROVIDER_ID_ENV] ?? VISION_PAIR.providerId;
    const recorder = memoryRecorder();
    const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
      modelId,
      apiKey,
      capabilities: visionGateCapabilities(),
      routing: { zdr: true, dataCollection: "deny", allowFallbacks: true },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    };
    if (options.fetch !== undefined) {
      providerOptions.fetch = options.fetch;
    }
    provider = new OpenRouterProvider(providerOptions);
  }

  const result = await runVisionGate({
    provider,
    modelId,
    providerId,
    framePng,
    expectedText: options.expectedText,
    redactionMode: options.redactionMode,
    inputClassification,
    maxPriceUsd,
  });

  return { status: result.gate.passed ? "passed" : "rejected", result };
}

export type { VisionGateArtifact };

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}
