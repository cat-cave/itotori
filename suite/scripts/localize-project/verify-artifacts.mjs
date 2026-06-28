#!/usr/bin/env node
"use strict";

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_EXPECTED_MODEL_ID = "deepseek/deepseek-v4-flash";
const OLD_MODEL_ID = "deepseek/deepseek-chat-v4";

function usage() {
  return [
    "usage: node suite/scripts/localize-project/verify-artifacts.mjs --run-dir <DIR> --telemetry-summary <PATH> [--expected-model-id <MODEL>] [--output <PATH>]",
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
    throw new Error(
      `--telemetry-summary is required to prove cost_kind and ZDR counts\n\n${usage()}`,
    );
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
  const runSummary = existsSync(runSummaryPath)
    ? assertObject(readJson(runSummaryPath), "run-summary")
    : {};
  const artifacts = assertObject(runSummary.artifacts ?? {}, "run-summary.artifacts");
  return {
    runSummary: runSummaryPath,
    runSummaryObject: runSummary,
    agenticLoopBundle: artifacts.agenticLoopBundle ?? join(runDir, "agentic-loop-bundle.v0.json"),
    patchReport: artifacts.patchReport ?? join(runDir, "patch-report.json"),
    replayLog: artifacts.replayLog ?? join(runDir, "replay-log.json"),
    providerRunArtifacts: artifacts.providerRunArtifacts ?? join(runDir, "provider-runs"),
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

function pairKey(pair) {
  return `${pair.modelId}:${pair.providerId}`;
}

function parseFiniteUsd(value, label) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite USD amount`);
  }
  return parsed;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function readProviderRunArtifacts(providerRunArtifactsDir) {
  if (!existsSync(providerRunArtifactsDir)) {
    throw new Error(
      `required artifact missing: providerRunArtifacts at ${providerRunArtifactsDir}`,
    );
  }
  const artifacts = [];
  for (const entry of readdirSync(providerRunArtifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const artifactPath = join(providerRunArtifactsDir, entry.name, "provider-run.json");
    if (!existsSync(artifactPath)) continue;
    const artifact = assertObject(readJson(artifactPath), `provider-run artifact ${artifactPath}`);
    artifacts.push({ path: artifactPath, artifact });
  }
  return artifacts;
}

function providerRunStartedAtMs(providerRun, label) {
  const startedAt = assertNonEmptyString(providerRun.startedAt, `${label}.run.startedAt`);
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}.run.startedAt must be an ISO timestamp`);
  }
  return parsed;
}

function providerRunEndedAtMs(providerRun, label) {
  for (const field of ["completedAt", "endedAt", "endAt", "finishedAt"]) {
    if (providerRun[field] === undefined) continue;
    const endedAt = assertNonEmptyString(providerRun[field], `${label}.run.${field}`);
    const parsed = Date.parse(endedAt);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label}.run.${field} must be an ISO timestamp`);
    }
    return parsed;
  }
  return undefined;
}

function verifyProviderRunArtifacts(args) {
  const { providerRunArtifactsDir, invocations, expectedModelId, expectedProviderId } = args;
  const artifacts = readProviderRunArtifacts(providerRunArtifactsDir);
  if (artifacts.length === 0) {
    throw new Error("provider-run artifact evidence missing");
  }

  const expectedByRunId = new Map();
  for (const invocation of invocations) {
    const providerProofId = assertNonEmptyString(
      invocation.providerProofId,
      "agentic-loop invocation.providerProofId",
    );
    if (expectedByRunId.has(providerProofId)) {
      throw new Error(`duplicate providerProofId in agentic-loop-bundle: ${providerProofId}`);
    }
    const invocationPair = assertObject(invocation.pair, "agentic-loop invocation.pair");
    const invocationModelId = assertNonEmptyString(
      invocationPair.modelId,
      "agentic-loop invocation.pair.modelId",
    );
    const invocationProviderId = assertNonEmptyString(
      invocationPair.providerId,
      "agentic-loop invocation.pair.providerId",
    );
    if (invocationModelId !== expectedModelId || invocationProviderId !== expectedProviderId) {
      throw new Error(
        `agentic-loop invocation pair mismatch for ${providerProofId}: expected ${expectedModelId}:${expectedProviderId}, got ${invocationModelId}:${invocationProviderId}`,
      );
    }
    if (parseFiniteUsd(invocation.costUsd, "agentic-loop invocation.costUsd") <= 0) {
      throw new Error(
        `agentic-loop invocation ${providerProofId} has non-billed live success costUsd=${String(invocation.costUsd)}`,
      );
    }
    expectedByRunId.set(providerProofId, invocation);
  }

  const artifactByRunId = new Map();
  for (const { path, artifact } of artifacts) {
    if (artifact.schemaVersion !== "itotori.provider-run.v0") {
      throw new Error(`provider-run artifact ${path} has unsupported schemaVersion`);
    }
    const run = assertObject(artifact.run, `provider-run artifact ${path}.run`);
    const runId = assertNonEmptyString(run.runId, `provider-run artifact ${path}.run.runId`);
    if (artifactByRunId.has(runId)) {
      throw new Error(`duplicate provider-run artifact for runId ${runId}`);
    }
    artifactByRunId.set(runId, { path, artifact, run });
  }

  for (const runId of expectedByRunId.keys()) {
    if (!artifactByRunId.has(runId)) {
      throw new Error(`missing provider-run artifact for providerProofId/runId ${runId}`);
    }
  }
  for (const runId of artifactByRunId.keys()) {
    if (!expectedByRunId.has(runId)) {
      throw new Error(`unmatched provider-run artifact for runId ${runId}`);
    }
  }

  const runStartedAtMs = [];
  const runEndedAtMs = [];
  for (const [runId, { path, artifact, run }] of artifactByRunId.entries()) {
    const invocation = expectedByRunId.get(runId);
    const provider = assertObject(run.provider, `provider-run artifact ${path}.run.provider`);
    if (
      provider.providerFamily !== "openrouter" ||
      provider.endpointFamily !== "openrouter-chat-completions"
    ) {
      throw new Error(
        `provider-run artifact ${runId} is not a live OpenRouter artifact: providerFamily=${String(provider.providerFamily)} endpointFamily=${String(provider.endpointFamily)}`,
      );
    }
    if (run.status !== "succeeded") {
      throw new Error(
        `provider-run artifact ${runId} status is not succeeded: ${String(run.status)}`,
      );
    }
    if (
      provider.requestedModelId !== expectedModelId ||
      provider.actualModelId !== expectedModelId
    ) {
      throw new Error(
        `provider-run artifact ${runId} model mismatch: expected ${expectedModelId}, requested=${String(provider.requestedModelId)} actual=${String(provider.actualModelId)}`,
      );
    }
    if (provider.requestedProviderId !== expectedProviderId) {
      throw new Error(
        `provider-run artifact ${runId} provider mismatch: expected ${expectedProviderId}, got ${String(provider.requestedProviderId)}`,
      );
    }
    const request = assertObject(artifact.request, `provider-run artifact ${path}.request`);
    if (request.requestedModelId !== expectedModelId) {
      throw new Error(
        `provider-run artifact ${runId} request model mismatch: expected ${expectedModelId}, got ${String(request.requestedModelId)}`,
      );
    }
    const cost = assertObject(run.cost, `provider-run artifact ${path}.run.cost`);
    if (
      cost.costKind !== "billed" ||
      assertInteger(cost.amountMicrosUsd, `${path}.run.cost.amountMicrosUsd`) <= 0
    ) {
      throw new Error(
        `provider-run artifact ${runId} has non-billed live success cost: costKind=${String(cost.costKind)} amountMicrosUsd=${String(cost.amountMicrosUsd)}`,
      );
    }
    const routingPosture = assertObject(
      run.routingPosture,
      `provider-run artifact ${path}.run.routingPosture`,
    );
    if (routingPosture.zdr !== true) {
      throw new Error(`provider-run artifact ${runId} missing ZDR routing proof`);
    }
    if (routingPosture.allow_fallbacks !== false) {
      throw new Error(`provider-run artifact ${runId} did not pin allow_fallbacks=false`);
    }
    if (
      !Array.isArray(routingPosture.only) ||
      routingPosture.only.length !== 1 ||
      routingPosture.only[0] !== expectedProviderId
    ) {
      throw new Error(
        `provider-run artifact ${runId} routing provider mismatch: expected only=[${expectedProviderId}]`,
      );
    }
    if (routingPosture.data_collection !== "deny") {
      throw new Error(
        `provider-run artifact ${runId} missing non-collection routing proof: data_collection=${String(routingPosture.data_collection)}`,
      );
    }
    if (invocation.providerProofId !== run.runId) {
      throw new Error(
        `provider-run artifact ${runId} does not match invocation providerProofId ${invocation.providerProofId}`,
      );
    }
    runStartedAtMs.push(providerRunStartedAtMs(run, `provider-run artifact ${path}`));
    const endedAtMs = providerRunEndedAtMs(run, `provider-run artifact ${path}`);
    if (endedAtMs !== undefined) {
      runEndedAtMs.push(endedAtMs);
    }
  }

  return {
    artifacts,
    runStartedAtMs,
    runEndedAtMs,
  };
}

export function verifyProviderRunArtifactEvidence(args) {
  const agenticLoopBundlePath = resolvePath(args.agenticLoopBundlePath);
  const patchReportPath = resolvePath(args.patchReportPath);
  const providerRunArtifactsDir = resolvePath(args.providerRunArtifactsDir);

  const agenticLoopBundle = assertObject(readJson(agenticLoopBundlePath), "agentic-loop-bundle");
  const patchReport = assertObject(readJson(patchReportPath), "patch-report");
  const invocations = collectInvocations(agenticLoopBundle);
  if (invocations.length === 0) {
    throw new Error("agentic-loop-bundle must contain at least one invocation");
  }
  const nonZdrInvocations = invocations.filter((invocation) => invocation.zdr !== true);
  if (nonZdrInvocations.length > 0) {
    throw new Error(
      `agentic-loop-bundle has ${nonZdrInvocations.length} invocation(s) with zdr != true`,
    );
  }

  const pair = assertObject(patchReport.pair, "patch-report.pair");
  const modelId = assertNonEmptyString(pair.modelId, "patch-report.pair.modelId");
  const providerId = assertNonEmptyString(pair.providerId, "patch-report.pair.providerId");
  if (args.expectedModelId !== undefined && modelId !== args.expectedModelId) {
    throw new Error(`patch-report modelId mismatch: expected ${args.expectedModelId}, got ${modelId}`);
  }
  if (args.expectedProviderId !== undefined && providerId !== args.expectedProviderId) {
    throw new Error(
      `patch-report providerId mismatch: expected ${args.expectedProviderId}, got ${providerId}`,
    );
  }
  if (modelId === OLD_MODEL_ID || JSON.stringify(patchReport).includes(OLD_MODEL_ID)) {
    throw new Error(`patch-report contains stale modelId ${OLD_MODEL_ID}`);
  }

  const providerProof = verifyProviderRunArtifacts({
    providerRunArtifactsDir,
    invocations,
    expectedModelId: modelId,
    expectedProviderId: providerId,
  });

  return {
    agenticLoopBundle,
    patchReport,
    invocations,
    modelId,
    providerId,
    providerRunArtifactCount: providerProof.artifacts.length,
    artifacts: providerProof.artifacts,
    runStartedAtMs: providerProof.runStartedAtMs,
    runEndedAtMs: providerProof.runEndedAtMs,
  };
}

function telemetryMetadata(telemetrySummary) {
  const metadata = assertObject(telemetrySummary.metadata, "telemetry-summary.metadata");
  const projectId = assertNonEmptyString(
    metadata.projectId,
    "telemetry-summary.metadata.projectId",
  );
  const window = assertObject(metadata.window, "telemetry-summary.metadata.window");
  const from = assertNonEmptyString(window.from, "telemetry-summary.metadata.window.from");
  const to = assertNonEmptyString(window.to, "telemetry-summary.metadata.window.to");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error("telemetry metadata window must be a valid inclusive ISO range");
  }
  const generatedAt = assertNonEmptyString(
    metadata.generatedAt,
    "telemetry-summary.metadata.generatedAt",
  );
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("telemetry-summary.metadata.generatedAt must be an ISO timestamp");
  }
  return {
    projectId,
    from,
    to,
    fromMs,
    toMs,
    generatedAt,
    generatedAtMs: Date.parse(generatedAt),
  };
}

function countsByPair(invocations) {
  const counts = new Map();
  for (const invocation of invocations) {
    const pair = assertObject(invocation.pair, "agentic-loop invocation.pair");
    const key = pairKey({
      modelId: assertNonEmptyString(pair.modelId, "agentic-loop invocation.pair.modelId"),
      providerId: assertNonEmptyString(pair.providerId, "agentic-loop invocation.pair.providerId"),
    });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function assertPairCountsMatch(rows, expectedCounts, label, rowCountKey) {
  const actualCounts = new Map();
  for (const row of rows) {
    const rowObject = assertObject(row, `${label}.row`);
    const key = assertNonEmptyString(rowObject.pair, `${label}.row.pair`);
    actualCounts.set(
      key,
      (actualCounts.get(key) ?? 0) +
        assertInteger(rowObject[rowCountKey], `${label}.row.${rowCountKey}`),
    );
  }
  const expectedKeys = Array.from(expectedCounts.keys()).sort();
  const actualKeys = Array.from(actualCounts.keys()).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} pair rows mismatch: expected ${expectedKeys.join(",")}, got ${actualKeys.join(",")}`,
    );
  }
  for (const key of expectedKeys) {
    if (actualCounts.get(key) !== expectedCounts.get(key)) {
      throw new Error(
        `${label} invocation count mismatch for ${key}: expected ${expectedCounts.get(key)}, got ${actualCounts.get(key)}`,
      );
    }
  }
}

function telemetryByPairRows(telemetrySummary) {
  const byPair = assertObject(telemetrySummary.byPair, "telemetry-summary.byPair");
  return Object.entries(byPair).map(([pair, row]) => {
    const rowObject = assertObject(row, `telemetry-summary.byPair.${pair}`);
    return {
      pair,
      invocationCount: assertInteger(
        rowObject.invocationCount,
        `telemetry-summary.byPair.${pair}.invocationCount`,
      ),
    };
  });
}

function verifyTelemetry(args) {
  const {
    telemetrySummary,
    expectedInvocationCount,
    expectedPairCounts,
    expectedModelId,
    providerRunStartedAtMs,
    providerRunEndedAtMs,
    expectedProjectId,
  } = args;
  const metadata = telemetryMetadata(telemetrySummary);
  if (expectedProjectId !== undefined && metadata.projectId !== expectedProjectId) {
    throw new Error(
      `telemetry project mismatch: expected ${expectedProjectId}, got ${metadata.projectId}`,
    );
  }
  for (const startedAtMs of providerRunStartedAtMs) {
    if (startedAtMs < metadata.fromMs || startedAtMs > metadata.toMs) {
      throw new Error("telemetry window does not cover provider-run timestamps");
    }
  }
  const freshnessFloorMs =
    providerRunEndedAtMs.length > 0
      ? Math.max(...providerRunEndedAtMs)
      : Math.max(...providerRunStartedAtMs);
  if (metadata.generatedAtMs < freshnessFloorMs) {
    throw new Error("telemetry summary generatedAt is stale relative to provider-run timestamps");
  }
  if (JSON.stringify(telemetrySummary).includes(OLD_MODEL_ID)) {
    throw new Error(`telemetry summary contains stale modelId ${OLD_MODEL_ID}`);
  }
  const summaryRows = telemetryByPairRows(telemetrySummary);
  if (summaryRows.length === 0) {
    throw new Error("telemetry summary must include byPair evidence");
  }
  for (const row of summaryRows) {
    if (!row.pair.startsWith(`${expectedModelId}:`)) {
      throw new Error(`telemetry summary byPair row has stale/mismatched modelId: ${row.pair}`);
    }
  }
  assertPairCountsMatch(
    summaryRows,
    expectedPairCounts,
    "telemetry summary byPair",
    "invocationCount",
  );
  const evidence = assertObject(
    telemetrySummary.postRunEvidence,
    "telemetry-summary.postRunEvidence",
  );
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
  if (zdr.invocationCount !== expectedInvocationCount) {
    throw new Error(
      `telemetry ZDR invocation count mismatch: expected ${expectedInvocationCount}, got ${zdr.invocationCount}`,
    );
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
  if (costKind.invocationCount !== expectedInvocationCount) {
    throw new Error(
      `telemetry cost-kind invocation count mismatch: expected ${expectedInvocationCount}, got ${costKind.invocationCount}`,
    );
  }
  if (zdr.invocationCount !== costKind.invocationCount) {
    throw new Error("telemetry ZDR and cost-kind invocation counts differ");
  }

  const zdrRows = Array.isArray(zdr.rows) ? zdr.rows : [];
  if (zdrRows.length === 0) {
    throw new Error("telemetry ZDR proof must include per-pair rows");
  }
  const costKindRows = Array.isArray(costKind.rows) ? costKind.rows : [];
  if (costKindRows.length === 0) {
    throw new Error("telemetry cost-kind proof must include per-pair rows");
  }
  for (const row of zdrRows) {
    const rowObject = assertObject(row, "telemetry ZDR row");
    const key = assertNonEmptyString(rowObject.pair, "telemetry ZDR row.pair");
    if (!key.startsWith(`${expectedModelId}:`)) {
      throw new Error(`telemetry ZDR row has stale/mismatched modelId: ${key}`);
    }
    if (rowObject.zdrEnforcedCount !== rowObject.invocationCount) {
      throw new Error(`telemetry ZDR row count mismatch for ${key}`);
    }
  }
  for (const row of costKindRows) {
    const rowObject = assertObject(row, "telemetry cost-kind row");
    const key = assertNonEmptyString(rowObject.pair, "telemetry cost-kind row.pair");
    if (!key.startsWith(`${expectedModelId}:`)) {
      throw new Error(`telemetry cost-kind row has stale/mismatched modelId: ${key}`);
    }
    if (rowObject.costKind !== "billed") {
      throw new Error(`telemetry cost-kind row for ${key} is not billed`);
    }
  }
  assertPairCountsMatch(zdrRows, expectedPairCounts, "telemetry ZDR", "invocationCount");
  assertPairCountsMatch(costKindRows, expectedPairCounts, "telemetry cost-kind", "invocationCount");

  return {
    metadata,
    zdrEnforcedCount: zdr.zdrEnforcedCount,
    invocationCount: zdr.invocationCount,
    billedCount: costKind.billedCount,
    nonBilledCount: costKind.nonBilledCount,
  };
}

export function verify(args) {
  const runDir = resolvePath(args.runDir);
  const paths = artifactPaths(runDir);
  for (const [name, path] of Object.entries(paths)) {
    if (name === "runSummaryObject") continue;
    if (!existsSync(path)) {
      throw new Error(`required artifact missing: ${name} at ${path}`);
    }
  }
  const telemetrySummaryPath = resolvePath(args.telemetrySummaryPath);
  if (!existsSync(telemetrySummaryPath)) {
    throw new Error(`required telemetry summary missing: ${telemetrySummaryPath}`);
  }

  const replayLog = assertObject(readJson(paths.replayLog), "replay-log");
  const telemetrySummary = assertObject(readJson(telemetrySummaryPath), "telemetry-summary");
  const runSummary = assertObject(paths.runSummaryObject, "run-summary");

  const providerProof = verifyProviderRunArtifactEvidence({
    agenticLoopBundlePath: paths.agenticLoopBundle,
    patchReportPath: paths.patchReport,
    providerRunArtifactsDir: paths.providerRunArtifacts,
    expectedModelId: args.expectedModelId,
  });
  const { patchReport, invocations, modelId, providerId } = providerProof;

  const sentinel = assertNonEmptyString(patchReport.enUsSentinel, "patch-report.enUsSentinel");
  const sentinelTextLines = findSentinelTextLines(replayLog, sentinel);
  if (sentinelTextLines.length === 0) {
    throw new Error(`replay-log contains no text_line bodyUtf8 with sentinel ${sentinel}`);
  }

  const telemetryProof = verifyTelemetry({
    telemetrySummary,
    expectedInvocationCount: invocations.length,
    expectedPairCounts: countsByPair(invocations),
    expectedModelId: modelId,
    providerRunStartedAtMs: providerProof.runStartedAtMs,
    providerRunEndedAtMs: providerProof.runEndedAtMs,
    expectedProjectId:
      typeof runSummary.project === "string" && runSummary.project.length > 0
        ? runSummary.project
        : undefined,
  });
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
    schemaVersion: "itotori.localize-project.post-run-verification.v0",
    verifiedAt: new Date().toISOString(),
    runDir,
    expectedModelId: args.expectedModelId,
    patchReportPair: { modelId, providerId },
    enUsSentinel: sentinel,
    invocationCount: invocations.length,
    agenticLoopZdrEnforcedCount: invocations.length,
    providerRunArtifactCount: providerProof.artifacts.length,
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
    process.stderr.write(`[localize-project.verify] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
