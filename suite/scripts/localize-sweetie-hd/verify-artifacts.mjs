#!/usr/bin/env node
"use strict";

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";

const DEFAULT_EXPECTED_MODEL_ID = "deepseek/deepseek-v4-flash";
const OLD_MODEL_ID = "deepseek/deepseek-chat-v4";

function usage() {
  return [
    "usage: node suite/scripts/localize-sweetie-hd/verify-artifacts.mjs --run-dir <DIR> --telemetry-summary <PATH> [--expected-model-id <MODEL>] [--output <PATH>]",
    "",
    "Offline verifier for UTSUSHI-231 post-run evidence. Reads only saved JSON artifacts; it does not call providers.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    runDir: undefined,
    telemetrySummaryPath: undefined,
    expectedModelId: DEFAULT_EXPECTED_MODEL_ID,
    outputPath: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--run-dir":
        args.runDir = requireValue(argv, ++i, "--run-dir");
        break;
      case "--telemetry-summary":
        args.telemetrySummaryPath = requireValue(argv, ++i, "--telemetry-summary");
        break;
      case "--expected-model-id":
        args.expectedModelId = requireValue(argv, ++i, "--expected-model-id");
        break;
      case "--output":
        args.outputPath = requireValue(argv, ++i, "--output");
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}\n\n${usage()}`);
    }
  }
  if (args.runDir === undefined) throw new Error(`--run-dir is required\n\n${usage()}`);
  if (args.telemetrySummaryPath === undefined) {
    throw new Error(`--telemetry-summary is required to prove cost_kind and ZDR counts\n\n${usage()}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read JSON ${path}: ${error.message}`);
  }
}

function sha256OfFile(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function artifactPaths(runDir) {
  const runSummaryPath = join(runDir, "run-summary.json");
  const runSummary = existsSync(runSummaryPath) ? assertObject(readJson(runSummaryPath), "run-summary") : {};
  const artifacts = assertObject(runSummary.artifacts ?? {}, "run-summary.artifacts");
  return {
    runSummary: runSummaryPath,
    agenticLoopBundle: artifacts.agenticLoopBundle ?? join(runDir, "agentic-loop-bundle.v0.json"),
    patchReport: artifacts.patchReport ?? join(runDir, "patch-report.json"),
    replayLog: artifacts.replayLog ?? join(runDir, "replay-log.json"),
  };
}

function collectInvocations(bundle) {
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  return stages.flatMap((stage) => (Array.isArray(stage.invocations) ? stage.invocations : []));
}

function findSentinelTextLines(replayLog, sentinel) {
  const events = Array.isArray(replayLog.events) ? replayLog.events : [];
  return events.filter(
    (event) =>
      event &&
      typeof event === "object" &&
      event.kind === "text_line" &&
      typeof event.bodyUtf8 === "string" &&
      event.bodyUtf8.includes(sentinel),
  );
}

function verifyTelemetry(telemetrySummary) {
  const evidence = assertObject(telemetrySummary.postRunEvidence, "telemetry-summary.postRunEvidence");
  const zdr = assertObject(evidence.zdr, "telemetry-summary.postRunEvidence.zdr");
  const costKind = assertObject(evidence.costKind, "telemetry-summary.postRunEvidence.costKind");

  if (zdr.allInvocationsZdrEnforced !== true) {
    throw new Error(
      `telemetry ZDR proof failed: zdrEnforcedCount=${String(zdr.zdrEnforcedCount)} invocationCount=${String(zdr.invocationCount)}`,
    );
  }
  if (!Number.isInteger(zdr.invocationCount) || zdr.invocationCount <= 0) {
    throw new Error("telemetry ZDR proof must cover at least one invocation");
  }
  if (zdr.zdrEnforcedCount !== zdr.invocationCount) {
    throw new Error("telemetry ZDR proof count mismatch");
  }

  if (costKind.allInvocationsBilled !== true) {
    throw new Error(
      `telemetry cost-kind proof failed: billedCount=${String(costKind.billedCount)} nonBilledCount=${String(costKind.nonBilledCount)}`,
    );
  }
  if (!Number.isInteger(costKind.invocationCount) || costKind.invocationCount <= 0) {
    throw new Error("telemetry cost-kind proof must cover at least one invocation");
  }
  if (costKind.billedCount !== costKind.invocationCount || costKind.nonBilledCount !== 0) {
    throw new Error("telemetry cost-kind proof count mismatch");
  }

  return {
    zdrEnforcedCount: zdr.zdrEnforcedCount,
    invocationCount: zdr.invocationCount,
    billedCount: costKind.billedCount,
    nonBilledCount: costKind.nonBilledCount,
  };
}

function verify(args) {
  const runDir = resolvePath(args.runDir);
  const paths = artifactPaths(runDir);
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) {
      throw new Error(`required artifact missing: ${name} at ${path}`);
    }
  }
  const telemetrySummaryPath = resolvePath(args.telemetrySummaryPath);
  if (!existsSync(telemetrySummaryPath)) {
    throw new Error(`required telemetry summary missing: ${telemetrySummaryPath}`);
  }

  const agenticLoopBundle = assertObject(readJson(paths.agenticLoopBundle), "agentic-loop-bundle");
  const patchReport = assertObject(readJson(paths.patchReport), "patch-report");
  const replayLog = assertObject(readJson(paths.replayLog), "replay-log");
  const telemetrySummary = assertObject(readJson(telemetrySummaryPath), "telemetry-summary");

  const invocations = collectInvocations(agenticLoopBundle);
  if (invocations.length === 0) {
    throw new Error("agentic-loop-bundle must contain at least one invocation");
  }
  const nonZdrInvocations = invocations.filter((invocation) => invocation.zdr !== true);
  if (nonZdrInvocations.length > 0) {
    throw new Error(`agentic-loop-bundle has ${nonZdrInvocations.length} invocation(s) with zdr != true`);
  }

  const pair = assertObject(patchReport.pair, "patch-report.pair");
  const modelId = assertNonEmptyString(pair.modelId, "patch-report.pair.modelId");
  const providerId = assertNonEmptyString(pair.providerId, "patch-report.pair.providerId");
  if (modelId !== args.expectedModelId) {
    throw new Error(
      `patch-report modelId mismatch: expected ${args.expectedModelId}, got ${modelId}`,
    );
  }
  if (modelId === OLD_MODEL_ID || JSON.stringify(patchReport).includes(OLD_MODEL_ID)) {
    throw new Error(`patch-report contains stale modelId ${OLD_MODEL_ID}`);
  }

  const sentinel = assertNonEmptyString(patchReport.enUsSentinel, "patch-report.enUsSentinel");
  const sentinelTextLines = findSentinelTextLines(replayLog, sentinel);
  if (sentinelTextLines.length === 0) {
    throw new Error(`replay-log contains no text_line bodyUtf8 with sentinel ${sentinel}`);
  }

  const telemetryProof = verifyTelemetry(telemetrySummary);
  const artifactSha256 = {
    agenticLoopBundle: sha256OfFile(paths.agenticLoopBundle),
    patchReport: sha256OfFile(paths.patchReport),
    replayLog: sha256OfFile(paths.replayLog),
    telemetrySummary: sha256OfFile(telemetrySummaryPath),
  };
  if (existsSync(paths.runSummary)) {
    artifactSha256.runSummary = sha256OfFile(paths.runSummary);
  }

  return {
    schemaVersion: "itotori.localize-sweetie-hd.post-run-verification.v0",
    verifiedAt: new Date().toISOString(),
    runDir,
    expectedModelId: args.expectedModelId,
    patchReportPair: { modelId, providerId },
    enUsSentinel: sentinel,
    invocationCount: invocations.length,
    agenticLoopZdrEnforcedCount: invocations.length - nonZdrInvocations.length,
    replaySentinelTextLineCount: sentinelTextLines.length,
    telemetryProof,
    artifactSha256,
    reproducibleChecks: {
      artifactSha256Algorithm: "sha256",
      verifierInputs: {
        runDir,
        telemetrySummary: telemetrySummaryPath,
        expectedModelId: args.expectedModelId,
      },
    },
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = verify(args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath !== undefined) {
    writeFileSync(args.outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
} catch (error) {
  process.stderr.write(`[localize-sweetie-hd.verify] FAILED: ${error.message}\n`);
  process.exit(1);
}
