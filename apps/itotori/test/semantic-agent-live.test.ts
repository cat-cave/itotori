// itotori-semantic-agents-live-provider-wiring — live proof that a semantic
// agent's resolved provider is the REAL, ZDR-gated OpenRouter provider.
//
// Gated on ITOTORI_LIVE_PROVIDER=1 + OPENROUTER_API_KEY +
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1. When any is unset the test prints a
// visible skip note (no silent pass) and returns, so `just check` / CI stay
// green and free. When all three are set it resolves the scene-summary
// provider through the SAME `resolveSemanticAgentProvider` seam the four
// semantic-agent CLIs use, issues one cheap `private_corpus` completion against
// the DEV_PAIR, and asserts the served run carries:
//
//   - a provider-assigned runId
//   - tokenUsage.promptTokens / completionTokens > 0
//   - cost.amountMicrosUsd > 0            (real cost, from usage.cost)
//   - an upstream provider id             (the real served pair)
//   - routingPosture.zdr === true         (ZDR enforced on the wire)
//
// `private_corpus` is the classification the real semantic-agent requests use
// (see agents/*/agent.ts), so this exercises the fail-closed ZDR path the
// production agents run on. Invoke explicitly with:
//   pnpm exec vitest run apps/itotori/test/semantic-agent-live.test.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSceneSummaryProvider } from "../src/agents/scene-summary/cli.js";
import { DEV_PAIR, LocalProviderRunArtifactRecorder } from "../src/providers/index.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const LIVE_ENABLED =
  process.env.ITOTORI_LIVE_PROVIDER === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0 &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1";

describe("itotori-semantic-agents-live-provider-wiring — live semantic-agent OpenRouter provider", () => {
  it("resolves a real ZDR provider and records real cost + served pair", async () => {
    if (!LIVE_ENABLED) {
      // No silent pass: print a visible skip so the output shows the test was
      // deliberately not exercised.
      // eslint-disable-next-line no-console
      console.warn(
        "[semantic-agents-live] skipping — set ITOTORI_LIVE_PROVIDER=1, OPENROUTER_API_KEY, and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 to run it",
      );
      return;
    }

    // Resolved through the SAME seam the semantic-agent CLIs use. `openrouter`
    // is the production default family; a scratch recorder preserves the
    // proof's served-pair evidence. The (modelId, providerId) pair is config-driven:
    // it travels on the request below (mirroring the agents' modelProfile),
    // never hard-coded in the resolver.
    const provider = resolveSceneSummaryProvider("openrouter", {
      artifactRecorder: new LocalProviderRunArtifactRecorder(
        mkdtempSync(join(tmpdir(), "itotori-semantic-agent-live-runs-")),
      ),
    });

    const request: ModelInvocationRequest = {
      taskKind: "experiment",
      modelId: DEV_PAIR.modelId,
      providerId: DEV_PAIR.providerId,
      // The real semantic-agent classification: forces provider.zdr=true on
      // the wire so a non-ZDR serve fails closed (OpenRouter 404 ZDR envelope).
      inputClassification: "private_corpus",
      prompt: {
        presetId: "semantic-agents-live-smoke",
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
    // Real cost from usage.cost.
    expect(result.providerRun.cost.costKind).toBe("billed");
    expect(result.providerRun.cost.amountMicrosUsd ?? 0).toBeGreaterThan(0);
    // Real served pair.
    expect(result.providerRun.provider.requestedModelId).toBe(DEV_PAIR.modelId);
    expect(result.providerRun.provider.upstreamProvider).toBeTruthy();
    // ZDR enforced on the wire for the private_corpus classification.
    expect(result.providerRun.routingPosture.zdr).toBe(true);
    expect(result.content).toBeTruthy();

    // eslint-disable-next-line no-console
    console.warn(
      `[semantic-agents-live] served pair model=${result.providerRun.provider.requestedModelId} ` +
        `provider=${result.providerRun.provider.upstreamProvider} ` +
        `costMicrosUsd=${result.providerRun.cost.amountMicrosUsd} zdr=true`,
    );
  }, 60_000);
});
