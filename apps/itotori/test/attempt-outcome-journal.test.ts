import { describe, expect, it } from "vitest";
import { DEV_POLICY } from "../src/orchestrator/agentic-loop.js";
import { capturePhysicalProviderAttempts } from "../src/orchestrator/attempt-outcome-journal.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import {
  ModelProviderError,
  OpenRouterProvider,
  openRouterDefaultCapabilities,
  type ModelInvocationRequest,
  type ProviderRunArtifact,
} from "../src/providers/index.js";

describe("capturePhysicalProviderAttempts", () => {
  it("physical-call-captured-on-non-provider-error", async () => {
    const artifactPersistenceError = Object.assign(
      new Error("cannot persist provider artifact: read-only filesystem"),
      { code: "EROFS" },
    );
    let physicalCallCount = 0;
    let artifact: ProviderRunArtifact | undefined;
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: "test-key",
      capabilities: openRouterDefaultCapabilities,
      fetch: async () => {
        physicalCallCount += 1;
        return response({
          id: "generation-post-call-artifact-error",
          model: DEV_PAIR.modelId,
          provider: "Fireworks",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Translated text." },
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            cost: 0.000004, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
          },
        });
      },
      live: {
        enabled: true,
        rawCapture: "disabled",
        artifactRecorder: {
          recordProviderRun: async (received) => {
            artifact = received;
            // This is intentionally not a ModelProviderError: the remote
            // call succeeded, then local artifact persistence failed.
            throw artifactPersistenceError;
          },
        },
      },
    });
    const captured = capturePhysicalProviderAttempts({
      runId: "journal-run-post-call-artifact-error",
      bridgeUnitId: "bridge-unit-post-call-artifact-error",
      source: () => provider,
    });
    const capturingProvider = captured.providerFactory({
      stage: "translation",
      agentLabel: "primary",
      pair: DEV_POLICY.translation.primary,
    });

    expect(artifactPersistenceError).not.toBeInstanceOf(ModelProviderError);
    const caught = await capturingProvider.invoke(request()).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "itotori_bug" },
      causeValue: artifactPersistenceError,
    });
    expect(physicalCallCount).toBe(1);
    expect(artifact?.run.status).toBe("succeeded");

    // This mirrors the failed-unit path before its attempts are sent to the
    // journal persistence sink.
    captured.markFailed(caught);

    expect(captured.attempts).toHaveLength(1);
    expect(captured.attempts[0]).toMatchObject({
      runId: "journal-run-post-call-artifact-error",
      bridgeUnitId: "bridge-unit-post-call-artifact-error",
      stage: "translation",
      agentLabel: "primary",
      providerRunId: artifact?.run.runId,
      modelId: DEV_PAIR.modelId,
      providerId: "Fireworks",
      finishState: "post_call_error",
      validationResult: "provider_failed",
      failureClass: "itotori_bug",
      retryDecision: "pause",
    });
  });
});

function request(): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId: DEV_PAIR.modelId,
    providerId: DEV_PAIR.providerId,
    inputClassification: "private_corpus",
    messages: [{ role: "user", content: "Translate this line." }],
    prompt: {
      presetId: "attempt-outcome-journal-test",
      templateVersion: "1.0.0",
      promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
