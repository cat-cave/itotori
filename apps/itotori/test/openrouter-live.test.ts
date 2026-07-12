// ITOTORI-221 — live OpenRouter integration test.
//
// Gated on ITOTORI_LIVE_PROVIDER=1 + OPENROUTER_API_KEY. When either is
// unset, the test prints a visible skip note (no silent pass) and
// returns. When both are set, it issues a trivial completion against
// the DEV_PAIR and asserts the response carries:
//
//   - providerRun.runId           (provider-assigned id)
//   - tokenUsage.promptTokens > 0
//   - tokenUsage.completionTokens > 0
//   - cost.amountMicrosUsd > 0
//   - upstreamProvider === DEV_PAIR.providerId  (pair pin verified)
//
// This is the live-LLM proof — running it once per major change
// confirms the pipeline actually works end-to-end against OpenRouter.
// `just check` does NOT run it; it has to be invoked explicitly with
// `pnpm exec vitest run apps/itotori/test/openrouter-live.test.ts`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_PAIR,
  LocalProviderRunArtifactRecorder,
  OpenRouterModelProvider,
} from "../src/providers/index.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const LIVE_ENABLED =
  process.env.ITOTORI_LIVE_PROVIDER === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

describe("ITOTORI-221 — live OpenRouter ModelProvider invocation", () => {
  it("invokes the DEV_PAIR end-to-end and verifies provider + tokens + cost", async () => {
    if (!LIVE_ENABLED) {
      // No silent pass: print a visible skip so anyone reading the
      // output sees the test was deliberately not exercised.
      // eslint-disable-next-line no-console
      console.warn(
        "[itotori-221] skipping live OpenRouter test — set ITOTORI_LIVE_PROVIDER=1 and OPENROUTER_API_KEY to run it",
      );
      return;
    }

    const provider = new OpenRouterModelProvider({
      artifactRecorder: new LocalProviderRunArtifactRecorder(
        mkdtempSync(join(tmpdir(), "itotori-openrouter-live-provider-runs-")),
      ),
    });

    const request: ModelInvocationRequest = {
      taskKind: "experiment",
      modelId: DEV_PAIR.modelId,
      providerId: DEV_PAIR.providerId,
      inputClassification: "synthetic_public",
      prompt: {
        presetId: "itotori-221-live-smoke",
        templateVersion: "1.0.0",
        promptHash: "sha256:" + "0".repeat(64),
      },
      messages: [
        {
          role: "user",
          content: "Respond with exactly the single word: pong. No punctuation, no extras.",
        },
      ],
      generation: {
        temperature: 0,
        maxOutputTokens: 32,
      },
    };

    const result = await provider.invoke(request);

    expect(result.providerRun.runId).toMatch(/^openrouter-/u);
    expect(result.providerRun.tokenUsage.promptTokens ?? 0).toBeGreaterThan(0);
    expect(result.providerRun.tokenUsage.completionTokens ?? 0).toBeGreaterThan(0);
    expect(result.providerRun.cost.amountMicrosUsd ?? 0).toBeGreaterThan(0);
    expect(result.providerRun.provider.upstreamProvider).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.requestedProviderId).toBe(DEV_PAIR.providerId);
    expect(result.providerRun.provider.requestedModelId).toBe(DEV_PAIR.modelId);
    expect(result.content).toBeTruthy();
  }, 60_000);
});
