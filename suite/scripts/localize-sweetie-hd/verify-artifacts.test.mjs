import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER_PATH = resolve(HERE, "verify-artifacts.mjs");
const { verify } = await import(VERIFIER_PATH);

const MODEL_ID = "deepseek/deepseek-v4-flash";
const OLD_MODEL_ID = "deepseek/deepseek-chat-v4";
const PROVIDER_ID = "fireworks";
const PROJECT_ID = "sweetie-hd-alpha";
const RUN_ID = "openrouter-proof-1";
const SENTINEL = "STELLA-ALPHA-EN-US-SENTINEL";
const STARTED_AT = "2026-06-27T12:00:00.000Z";
const COMPLETED_AT = "2026-06-27T12:00:01.000Z";

test("verify-artifacts proves provider-run, telemetry, ZDR, billed cost, sentinel, and hashes offline", () => {
  const fixture = createFixture();
  const result = runVerifier(fixture);

  assert.equal(result.status, 0, childOutput(result));
  const report = result.report;
  assert.equal(report.schemaVersion, "itotori.localize-sweetie-hd.post-run-verification.v0");
  assert.equal(report.patchReportPair.modelId, MODEL_ID);
  assert.equal(report.agenticLoopZdrEnforcedCount, 1);
  assert.equal(report.providerRunArtifactCount, 1);
  assert.equal(report.telemetryProof.billedCount, 1);
  assert.equal(report.telemetryProof.metadata.projectId, PROJECT_ID);
  assert.equal(report.replaySentinelTextLineCount, 1);
  assert.match(report.artifactSha256.patchReport, /^[a-f0-9]{64}$/u);
});

test("verify-artifacts rejects missing provider-run artifact evidence", () => {
  const fixture = createFixture({ providerArtifacts: [] });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /provider-run artifact evidence missing/u);
});

test("verify-artifacts rejects stale provider-run artifacts with mismatched model proof", () => {
  const fixture = createFixture({
    providerArtifactPatch: {
      run: {
        provider: {
          requestedModelId: OLD_MODEL_ID,
          actualModelId: OLD_MODEL_ID,
        },
      },
      request: {
        requestedModelId: OLD_MODEL_ID,
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /model mismatch/u);
});

test("verify-artifacts rejects fake or local provider artifacts", () => {
  const fixture = createFixture({
    providerArtifactPatch: {
      run: {
        provider: {
          providerFamily: "local-openai-compatible",
          endpointFamily: "local-chat-completions",
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /not a live OpenRouter artifact/u);
});

test("verify-artifacts rejects provider artifacts missing ZDR routing proof", () => {
  const fixture = createFixture({
    providerArtifactPatch: {
      run: {
        routingPosture: {
          zdr: false,
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /missing ZDR routing proof/u);
});

test("verify-artifacts rejects non-billed successful provider-run cost", () => {
  const fixture = createFixture({
    providerArtifactPatch: {
      run: {
        cost: {
          costKind: "zero",
          amountMicrosUsd: 0,
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /non-billed live success cost/u);
});

test("verify-artifacts rejects stale telemetry windows", () => {
  const fixture = createFixture({
    telemetryPatch: {
      metadata: {
        window: {
          from: "2026-06-26T00:00:00.000Z",
          to: "2026-06-26T23:59:59.000Z",
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /telemetry window does not cover provider-run timestamps/u);
});

test("verify-artifacts rejects telemetry rows with stale model IDs", () => {
  const stalePair = `${OLD_MODEL_ID}:${PROVIDER_ID}`;
  const fixture = createFixture({
    telemetryPatch: {
      postRunEvidence: {
        zdr: {
          byPair: {
            [stalePair]: {
              invocationCount: 1,
              zdrEnforcedCount: 1,
              unenforcedCount: 0,
            },
          },
          rows: [
            {
              pair: stalePair,
              invocationCount: 1,
              zdrEnforcedCount: 1,
            },
          ],
        },
        costKind: {
          byPair: {
            [stalePair]: {
              billed: 1,
              zero: 0,
              amountMicrosUsd: 1,
            },
          },
          rows: [
            {
              pair: stalePair,
              costKind: "billed",
              invocationCount: 1,
              amountMicrosUsd: 1,
            },
          ],
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /stale modelId/u);
});

test("verify-artifacts rejects non-billed telemetry cost-kind rows", () => {
  const fixture = createFixture({
    telemetryPatch: {
      postRunEvidence: {
        costKind: {
          billedCount: 0,
          nonBilledCount: 1,
          allInvocationsBilled: false,
          rows: [
            {
              pair: `${MODEL_ID}:${PROVIDER_ID}`,
              costKind: "zero",
              invocationCount: 1,
              amountMicrosUsd: 0,
            },
          ],
        },
      },
    },
  });
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0);
  assert.match(childOutput(result), /telemetry cost-kind proof failed/u);
});

function childOutput(result) {
  return result.error instanceof Error ? result.error.message : String(result.error);
}

function runVerifier(fixture) {
  try {
    return {
      status: 0,
      report: verify({
        runDir: fixture.runDir,
        telemetrySummaryPath: fixture.telemetrySummaryPath,
        outputPath: fixture.outputPath,
        expectedModelId: MODEL_ID,
      }),
    };
  } catch (error) {
    return { status: 1, error };
  }
}

function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "itotori-localize-verify-"));
  const runDir = join(root, "run");
  const providerRunArtifactsDir = join(runDir, "provider-runs");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(providerRunArtifactsDir, { recursive: true });

  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const patchReportPath = join(runDir, "patch-report.json");
  const replayLogPath = join(runDir, "replay-log.json");
  const runSummaryPath = join(runDir, "run-summary.json");
  const telemetrySummaryPath = join(root, "telemetry-summary.json");
  const outputPath = join(root, "post-run-verification.json");

  writeJson(agenticLoopBundlePath, agenticLoopBundle());
  writeJson(patchReportPath, patchReport());
  writeJson(replayLogPath, replayLog());
  writeJson(runSummaryPath, {
    project: PROJECT_ID,
    artifacts: {
      agenticLoopBundle: agenticLoopBundlePath,
      patchReport: patchReportPath,
      replayLog: replayLogPath,
      providerRunArtifacts: providerRunArtifactsDir,
    },
  });

  const providerArtifacts =
    options.providerArtifacts ??
    [deepMerge(providerRunArtifact(), options.providerArtifactPatch ?? {})];
  for (const artifact of providerArtifacts) {
    const artifactRunDir = join(providerRunArtifactsDir, artifact.run.runId);
    mkdirSync(artifactRunDir, { recursive: true });
    writeJson(join(artifactRunDir, "provider-run.json"), artifact);
  }

  writeJson(
    telemetrySummaryPath,
    deepMerge(telemetrySummary(), options.telemetryPatch ?? {}),
  );

  return {
    root,
    runDir,
    telemetrySummaryPath,
    outputPath,
  };
}

function agenticLoopBundle() {
  return {
    schemaVersion: "itotori.agentic-loop-bundle.v2",
    stages: [
      {
        stageName: "translation",
        outcome: "accepted",
        invocations: [
          {
            invocationId: `translation:primary:${RUN_ID}`,
            agentLabel: "translation-primary",
            pair: { modelId: MODEL_ID, providerId: PROVIDER_ID },
            tokensIn: 10,
            tokensOut: 5,
            costUsd: "0.00000100",
            latencyMs: 25,
            providerProofId: RUN_ID,
            zdr: true,
            seed: 1,
          },
        ],
        tokensIn: 10,
        tokensOut: 5,
        costUsd: "0.00000100",
        latencyMs: 25,
      },
    ],
  };
}

function patchReport() {
  return {
    schemaVersion: "itotori.localize-sweetie-hd.patch-report.v0",
    pair: { modelId: MODEL_ID, providerId: PROVIDER_ID },
    enUsSentinel: SENTINEL,
  };
}

function replayLog() {
  return {
    schemaVersion: "utsushi-reallive-replay-log/0.1.0-alpha",
    sceneId: 1,
    events: [
      {
        kind: "text_line",
        bodyUtf8: `translated ${SENTINEL} line`,
        bodyShiftJisHex: "74657374",
        byteOffsetInScene: 1,
      },
    ],
    finalOutcome: { kind: "end_of_scene", events: 1 },
  };
}

function providerRunArtifact() {
  return {
    schemaVersion: "itotori.provider-run.v0",
    run: {
      runId: RUN_ID,
      taskKind: "translation",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      latencyMs: 1000,
      status: "succeeded",
      provider: {
        providerFamily: "openrouter",
        endpointFamily: "openrouter-chat-completions",
        providerName: "OpenRouter",
        requestedModelId: MODEL_ID,
        requestedProviderId: PROVIDER_ID,
        actualModelId: MODEL_ID,
      },
      structuredOutputMode: "none",
      retryCount: 0,
      errorClasses: [],
      fallbackUsed: false,
      fallbackPlan: [MODEL_ID],
      tokenUsage: {
        tokenCountSource: "provider_reported",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      cost: {
        costKind: "billed",
        currency: "USD",
        amountMicrosUsd: 1,
      },
      routingPosture: {
        only: [PROVIDER_ID],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
      usageResponseJson: { cost: 0.000001 },
      prompt: {
        presetId: "itotori-agentic-loop-translation-primary",
        templateVersion: "itotori-agentic-loop-translation-v0",
        promptHash: "sha256:test",
      },
    },
    request: {
      messageCount: 2,
      inputClassification: "private_corpus",
      requestedModelId: MODEL_ID,
      structuredOutputMode: "none",
      toolCount: 0,
      rawTextCaptured: false,
      prompt: {
        presetId: "itotori-agentic-loop-translation-primary",
        templateVersion: "itotori-agentic-loop-translation-v0",
        promptHash: "sha256:test",
      },
    },
    response: {
      finishReason: "stop",
      contentLength: 12,
      toolCallCount: 0,
    },
  };
}

function telemetrySummary() {
  const pair = `${MODEL_ID}:${PROVIDER_ID}`;
  return {
    metadata: {
      projectId: PROJECT_ID,
      window: {
        from: "2026-06-27T11:59:00.000Z",
        to: "2026-06-27T12:01:00.000Z",
      },
      generatedAt: "2026-06-27T12:02:00.000Z",
    },
    totalCostUsd: "0.00000100",
    cacheSavingsUsd: "0.00000000",
    byPair: {
      [pair]: {
        totalCostUsd: "0.00000100",
        totalTokensIn: 10,
        totalTokensOut: 5,
        avgLatencyMs: 1000,
        p95LatencyMs: 1000,
        invocationCount: 1,
        cacheHitCount: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        cacheSavingsUsd: "0.00000000",
      },
    },
    postRunEvidence: {
      zdr: {
        invocationCount: 1,
        zdrEnforcedCount: 1,
        unenforcedCount: 0,
        allInvocationsZdrEnforced: true,
        byPair: {
          [pair]: {
            invocationCount: 1,
            zdrEnforcedCount: 1,
            unenforcedCount: 0,
          },
        },
        rows: [
          {
            pair,
            invocationCount: 1,
            zdrEnforcedCount: 1,
          },
        ],
      },
      costKind: {
        invocationCount: 1,
        billedCount: 1,
        nonBilledCount: 0,
        allInvocationsBilled: true,
        byPair: {
          [pair]: {
            billed: 1,
            zero: 0,
            amountMicrosUsd: 1,
          },
        },
        rows: [
          {
            pair,
            costKind: "billed",
            invocationCount: 1,
            amountMicrosUsd: 1,
          },
        ],
      },
    },
  };
}

function deepMerge(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return right;
  }
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
