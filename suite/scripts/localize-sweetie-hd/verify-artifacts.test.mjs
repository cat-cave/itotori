import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER_PATH = resolve(HERE, "verify-artifacts.mjs");

test("verify-artifacts proves ZDR, billed cost kind, corrected modelId, sentinel TextLine, and hashes offline", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-localize-verify-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const patchReportPath = join(runDir, "patch-report.json");
  const replayLogPath = join(runDir, "replay-log.json");
  const runSummaryPath = join(runDir, "run-summary.json");
  const telemetrySummaryPath = join(root, "telemetry-summary.json");
  const outputPath = join(root, "post-run-verification.json");

  writeJson(agenticLoopBundlePath, {
    schemaVersion: "itotori.agentic-loop-bundle.v2",
    stages: [
      {
        stageName: "translation",
        outcome: "accepted",
        invocations: [
          {
            invocationId: "translation:primary:proof-1",
            agentLabel: "translation-primary",
            pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
            tokensIn: 10,
            tokensOut: 5,
            costUsd: "0.00000100",
            latencyMs: 25,
            providerProofId: "proof-1",
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
  });
  writeJson(patchReportPath, {
    schemaVersion: "itotori.localize-sweetie-hd.patch-report.v0",
    pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
    enUsSentinel: "STELLA-ALPHA-EN-US-SENTINEL",
  });
  writeJson(replayLogPath, {
    schemaVersion: "utsushi-reallive-replay-log/0.1.0-alpha",
    sceneId: 1,
    events: [
      {
        kind: "text_line",
        bodyUtf8: "translated STELLA-ALPHA-EN-US-SENTINEL line",
        bodyShiftJisHex: "74657374",
        byteOffsetInScene: 1,
      },
    ],
    finalOutcome: { kind: "end_of_scene", events: 1 },
  });
  writeJson(runSummaryPath, {
    artifacts: {
      agenticLoopBundle: agenticLoopBundlePath,
      patchReport: patchReportPath,
      replayLog: replayLogPath,
    },
  });
  writeJson(telemetrySummaryPath, {
    totalCostUsd: "0.00000100",
    cacheSavingsUsd: "0.00000000",
    byPair: {},
    postRunEvidence: {
      zdr: {
        invocationCount: 1,
        zdrEnforcedCount: 1,
        unenforcedCount: 0,
        allInvocationsZdrEnforced: true,
        byPair: {},
      },
      costKind: {
        invocationCount: 1,
        billedCount: 1,
        nonBilledCount: 0,
        allInvocationsBilled: true,
        byPair: {},
        rows: [
          {
            pair: "deepseek/deepseek-v4-flash:fireworks",
            costKind: "billed",
            invocationCount: 1,
            amountMicrosUsd: 1,
          },
        ],
      },
    },
  });

  const result = spawnSync(
    process.execPath,
    [
      VERIFIER_PATH,
      "--run-dir",
      runDir,
      "--telemetry-summary",
      telemetrySummaryPath,
      "--output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const report = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(report.schemaVersion, "itotori.localize-sweetie-hd.post-run-verification.v0");
  assert.equal(report.patchReportPair.modelId, "deepseek/deepseek-v4-flash");
  assert.equal(report.agenticLoopZdrEnforcedCount, 1);
  assert.equal(report.telemetryProof.billedCount, 1);
  assert.equal(report.replaySentinelTextLineCount, 1);
  assert.match(report.artifactSha256.patchReport, /^[a-f0-9]{64}$/u);
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
