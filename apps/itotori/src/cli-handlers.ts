import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertPatchResultV02,
  assertRuntimeReport,
  assertStyleGuideConversationTranscript,
  ITOTORI_PRODUCT_VERSION,
  type ConformanceManifestV01,
  type ConformanceResultV01,
  type StyleGuideConversationTranscript,
} from "@itotori/localization-bridge-schema";
import {
  capabilityLevelValues,
  createCatalogResolverFixtureArtifact,
  StyleGuideFixtureFlowRerunError,
} from "@itotori/db";
import type {
  AdapterCapabilityMatrixRecord,
  AuthorizationActor,
  CapabilityLevel,
  CatalogExactExternalIdLinkRequest,
  CatalogFuzzyCandidateRequest,
  CatalogResolverFixtureInput,
  ItotoriCatalogExactExternalIdLinkerPort,
  ItotoriCatalogFuzzyCandidateGeneratorPort,
  StyleGuideFixtureFlowInput,
  StyleGuideFixtureFlowResult,
} from "@itotori/db";
import type { EngineCapabilityReportPort } from "./services/engine-capability-report.js";
import {
  parseAssetDecisionPolicy,
  parseAssetKind,
  parseAssetRef,
  runAssetDecisionsList,
  runAssetDecisionsRecord,
  type AssetDecisionsCliPort,
} from "./asset-decisions/cli.js";
import { runQueueHealthCli, type QueueHealthCliPort } from "./queue/cli.js";
import type { ManualFeedbackImportPort } from "./manual-feedback.js";
import type { DraftFeedbackBatchInput, DraftFeedbackBatchPort } from "./draft-feedback/index.js";
import type { ItotoriProjectWorkflowPort, ProjectState } from "./services/project-workflow.js";
import type { PlanBatchesOutput } from "./batch-planner/index.js";
import {
  runPlanBatches,
  type PlanBatchesContextLoader,
  type PlanBatchesPersister,
  type PlannedProjectFile,
} from "./batch-planner/cli.js";
import type { ProviderFamily } from "./providers/types.js";
import { assertOpenRouterZdrAccount } from "./providers/account-zdr.js";
import { loadExternalEnvFile } from "./env/external-env-file.js";
import { runReconcileLedgerCostCommand } from "./providers/openrouter-cost-reconciler.js";
import {
  resolveSceneSummaryProvider,
  runCheckSceneSummariesCli,
  runGenerateSceneSummariesCli,
  type SceneSummaryCliDependencies,
} from "./agents/scene-summary/index.js";
import {
  resolveCharacterRelationshipProvider,
  runCheckCharacterRelationshipsCli,
  runGenerateCharacterRelationshipsCli,
  type CharacterRelationshipCliDependencies,
} from "./agents/character-relationship/index.js";
import { runAgenticLoopSmokeCommand } from "./orchestrator/agentic-loop-smoke-command.js";
import {
  buildAlphaProviderProofSummary,
  providerProofSummary,
  renderReadmeSafeProviderProofSummary,
  runProviderProofCommand,
  runRecordedProviderProof,
} from "./provider-proof/index.js";
import {
  rawMtlBaselineProofSummary,
  runRawMtlBaselineProofCommand,
} from "./raw-mtl-baseline-proof/index.js";
import {
  runLocalizeProjectStageCommand,
  type LocalizeProjectStageArgs,
} from "./orchestrator/localize-project-stage-command.js";
import { runLocalizeFullProjectLive } from "./orchestrator/localize-fullproject-cli.js";
import {
  runLocalizeGameCommand,
  LocalizeGameStageError,
  type RunLocalizeGameArgs,
} from "./orchestrator/localize-game-command.js";
import { runKaifuuRealliveExtract } from "./extract/kaifuu-extract-seam.js";
import { runExportPatchV2Command } from "./patch-export/index.js";
import {
  parseTelemetrySummaryCliFlags,
  parseTelemetrySummaryProviderRunFlags,
  renderTextSummary,
  runTelemetrySummaryCli,
  type TelemetrySummaryCliDeps,
} from "./telemetry/cli.js";
import {
  buildTelemetrySummaryFromProviderRunArtifacts,
  readProviderRunArtifactsFromDir,
} from "./telemetry/provider-run-artifact-source.js";
import type { TelemetryQuery } from "./telemetry/queries.js";
import {
  DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_STAGES_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_RUN_ID,
  DEFAULT_PUBLIC_BENCHMARK_GENERATED_AT,
  benchmarkSetReadModelFromSeedsFixture,
  benchmarkSetSelectionInputFromSetsFixture,
  buildPublicBenchmarkHarnessStages,
  loadBenchmarkStagesFixture,
  runBenchmarkHarnessCommand,
} from "./benchmark-harness/index.js";
import {
  composeExperimentBenchmarkReport,
  DEFAULT_PUBLIC_EXPERIMENT_MANIFEST_FIXTURE_PATH,
  DEFAULT_PUBLIC_PROVIDER_ROUTE_REPORT_FIXTURE_PATH,
  ExperimentReportCompositionError,
} from "./experiment-report/index.js";
import {
  composeAlphaReadiness,
  renderReadmeSafeAlphaSummary,
  type AlphaReadinessCostQualityArtifact,
  type AlphaReadinessPrivateLocalHandle,
} from "./alpha-readiness/index.js";
import { scanCatalogLocalRoot } from "./services/catalog-local-scan.js";
import {
  runVisionGateCommand,
  visionGateSummary,
  VisionGateRejectedError,
  type RedactionMode,
} from "./render-gate/index.js";
import {
  runUtsushiStructureExport,
  type RunUtsushiStructureResult,
} from "./structure-export/utsushi-structure-seam.js";
import { runNativeCli, type NativeCliRunner } from "./native-bin/cli-bin-resolver.js";
import { buildHelpText } from "./help-text.js";
import { runInitCommand, type InitCommandDeps } from "./init-command.js";

export type JsonFileStore = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
  /**
   * Persist a UTF-8 text artifact (e.g. the README-safe Markdown summary). The
   * real CLI store implements it; an in-memory test store may omit it, in which
   * case a handler that needs it throws a clear error rather than silently
   * dropping the artifact.
   */
  writeText?(path: string, contents: string): void;
};

export type ItotoriCliServices = {
  projectWorkflow: ItotoriProjectWorkflowPort;
  manualFeedback: ManualFeedbackImportPort;
  draftFeedbackBatch: DraftFeedbackBatchPort;
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
  catalogFuzzyCandidateGenerator: ItotoriCatalogFuzzyCandidateGeneratorPort;
  styleGuideFixtureFlow: {
    run(input: StyleGuideFixtureFlowInput): Promise<StyleGuideFixtureFlowResult>;
  };
  batchPlanner: {
    loadContext: PlanBatchesContextLoader;
    persist: PlanBatchesPersister;
  };
  sceneSummary?: {
    /**
     * Construct the per-invocation dependencies (provider, repositories,
     * actor). Optional so unit suites can omit it.
     *
     * semantic-agent-cli-provider-run-not-reconciled — `providerRunsDir` is the
     * run-scoped `--provider-runs-dir`. When supplied, the factory builds the
     * live provider with a `LocalProviderRunArtifactRecorder(providerRunsDir)`
     * so the run's served pair + billed `usage.cost` + ZDR posture land in the
     * reconciled telemetry surface (never the global scratch `.tmp/provider-runs`).
     */
    cliDependencies(
      provider: ProviderFamily,
      providerRunsDir?: string,
    ): Promise<SceneSummaryCliDependencies>;
    defaultModelId: string;
    /** ITOTORI-220 — default providerId for the scene-summary model. */
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
  characterRelationship?: {
    cliDependencies(
      provider: ProviderFamily,
      providerRunsDir?: string,
    ): Promise<CharacterRelationshipCliDependencies>;
    defaultModelId: string;
    /** ITOTORI-220 — default providerId for the character-relationship model. */
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
  engineCapabilityReports: EngineCapabilityReportPort;
  /**
   * Optional so unit suites can omit it. The CLI commands
   * `itotori:asset-decisions-list` / `-record` require it at runtime.
   */
  assetDecisions?: AssetDecisionsCliPort;
  /**
   * ITOTORI-223 — per-(modelId, providerId) telemetry query surface
   * powering the `itotori:telemetry-summary` command. Optional so
   * unit suites that don't exercise the telemetry command can omit
   * it; the CLI handler raises a typed error when missing.
   */
  telemetry?: {
    query: TelemetryQuery;
    actor: AuthorizationActor;
  };
  /**
   * ITOTORI-047 — queue-health read-model loader powering the
   * `queue-health` CLI command. Optional so unit suites that don't exercise
   * the queue command can omit it; the CLI handler raises a typed error when
   * missing.
   */
  queueHealth?: QueueHealthCliPort;
};

export type ItotoriCliDependencies = {
  io: JsonFileStore;
  migrateDatabase(): Promise<void>;
  withServices<T>(callback: (services: ItotoriCliServices) => Promise<T>): Promise<T>;
  nativeCli?: NativeCliRunner;
  /**
   * Optional override for the `itotori init` guided-setup dependencies.
   * In production the CLI constructs real readline/fs deps; tests inject
   * a mock to avoid interactive I/O.
   */
  initDeps?: InitCommandDeps;
};

export async function runItotoriCliCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // Load allowlisted live-provider vars from a caller-specified external
  // env-file (via `--env-file` or `ITOTORI_LOCAL_ENV_FILE`) BEFORE any command
  // handler reads process.env / constructs a provider — and BEFORE the
  // `--version` early return, so a specified-but-unreadable file FAILS LOUD
  // consistently regardless of the command (a bad --env-file is never silently
  // ignored by an early-return path). Precedence: an already-exported var wins;
  // only the allowlist loads. Values are never logged — only applied var NAMES.
  const envFileResult = loadExternalEnvFile({ args, env: process.env });
  if (envFileResult.path !== undefined && envFileResult.appliedKeys.length > 0) {
    process.stderr.write(
      `loaded ${envFileResult.appliedKeys.length} allowlisted var(s) from env file ` +
        `'${envFileResult.path}': ${envFileResult.appliedKeys.join(", ")}\n`,
    );
  }
  if (args.includes("--help") || args.includes("-h")) {
    const allCommands = args.includes("--all");
    process.stdout.write(`${buildHelpText(allCommands)}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`itotori ${ITOTORI_PRODUCT_VERSION}\n`);
    return;
  }
  const command = args[0];
  switch (command) {
    case "db-migrate":
      await dependencies.migrateDatabase();
      break;
    case "db-reset":
      await dependencies.withServices((services) => services.projectWorkflow.reset());
      break;
    case "dashboard-status":
      await runDashboardStatus(args, dependencies);
      break;
    case "agentic-loop-smoke":
      await runAgenticLoopSmoke(args, dependencies);
      break;
    case "localize-project-stage":
      await runLocalizeProjectStage(args, dependencies);
      break;
    case "localize":
      await runLocalizeFullProject(args, dependencies);
      break;
    case "localize-game":
      await runLocalizeGame(args, dependencies);
      break;
    case "extract":
      await runExtract(args, dependencies);
      break;
    case "provider-proof":
      await runProviderProof(args, dependencies);
      break;
    case "provider-proof-bundle":
      await runProviderProofBundle(args, dependencies);
      break;
    case "raw-mtl-baseline-proof":
      await runRawMtlBaselineProof(args, dependencies);
      break;
    case "export-patch-v2":
      await runExportPatchV2(args, dependencies);
      break;
    case "patch":
      await runPatchCommand(args, dependencies);
      break;
    case "validate":
      await runValidateCommand(args, dependencies);
      break;
    case "ingest-runtime":
      await runIngestRuntime(args, dependencies);
      break;
    case "ingest-patch-result":
      await runIngestPatchResult(args, dependencies);
      break;
    case "ingest-conformance":
      await runIngestConformance(args, dependencies);
      break;
    case "import-feedback":
      await runImportFeedback(args, dependencies);
      break;
    case "import-feedback-batch":
      await runImportFeedbackBatch(args, dependencies);
      break;
    case "catalog-link-exact":
      await runCatalogLinkExact(args, dependencies);
      break;
    case "catalog-fuzzy-candidates":
      await runCatalogFuzzyCandidates(args, dependencies);
      break;
    case "catalog-resolve-fixture":
      await runCatalogResolveFixture(args, dependencies);
      break;
    case "catalog-local-corpus-scan":
    case "catalog-local-scan":
      await runCatalogLocalScan(args, dependencies);
      break;
    case "style-guide-fixture-flow":
      await runStyleGuideFixtureFlow(args, dependencies);
      break;
    case "plan-batches":
      await runPlanBatchesHandler(args, dependencies);
      break;
    case "generate-scene-summaries":
      await runGenerateSceneSummariesHandler(args, dependencies);
      break;
    case "check-scene-summaries":
      await runCheckSceneSummariesHandler(args, dependencies);
      break;
    case "generate-character-relationships":
      await runGenerateCharacterRelationshipsHandler(args, dependencies);
      break;
    case "check-character-relationships":
      await runCheckCharacterRelationshipsHandler(args, dependencies);
      break;
    case "engine-capabilities-record":
      await runEngineCapabilitiesRecord(args, dependencies);
      break;
    case "engine-capabilities-list":
      await runEngineCapabilitiesList(args, dependencies);
      break;
    case "asset-decisions-list":
      await runAssetDecisionsListHandler(args, dependencies);
      break;
    case "asset-decisions-record":
      await runAssetDecisionsRecordHandler(args, dependencies);
      break;
    case "telemetry-summary":
      await runTelemetrySummaryHandler(args, dependencies);
      break;
    case "benchmark-harness-run":
      await runBenchmarkHarnessHandler(args, dependencies);
      break;
    case "experiment-report-compose":
      await runExperimentReportComposeHandler(args, dependencies);
      break;
    case "alpha-readiness-run":
      await runAlphaReadinessHandler(args, dependencies);
      break;
    case "vision-inspect":
      await runVisionInspectHandler(args, dependencies);
      break;
    case "structure-export":
      await runStructureExportHandler(args, dependencies);
      break;
    case "reconcile-ledger-cost":
      await runReconcileLedgerCostHandler(args, dependencies);
      break;
    case "queue-health":
      await runQueueHealthHandler(args, dependencies);
      break;
    case "help":
      process.stdout.write(`${buildHelpText(args.includes("--all"))}\n`);
      break;
    case "init":
      await runInitHandler(args, dependencies);
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
}

async function runPatchCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const sourceRoot = requiredFlag(args, "--source");
  const targetRoot = requiredFlag(args, "--target");
  const bundlePath = requiredFlag(args, "--bundle");
  const scope = requiredFlag(args, "--scope");
  if (scope !== "dialogue-only" && scope !== "dialogue+choices") {
    throw new Error(
      `itotori patch: --scope must be 'dialogue-only' or 'dialogue+choices', got '${scope}'`,
    );
  }
  const nativeArgs = [
    "patch",
    "--engine",
    "reallive",
    "--bundle",
    bundlePath,
    "--source",
    sourceRoot,
    "--target",
    targetRoot,
    "--scope",
    scope,
  ];
  if (args.includes("--force")) {
    nativeArgs.push("--force");
  }
  runNativeCommandOrThrow("patch", "kaifuu-cli", nativeArgs, dependencies.nativeCli);
}

async function runValidateCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const seenPath = requiredFlag(args, "--seen");
  const scene = requiredFlag(args, "--scene");
  const replayLogPath = requiredFlag(args, "--replay-log");
  const gameexePath = requiredFlag(args, "--gameexe");
  const gameDir = requiredFlag(args, "--game-dir");
  const artifactRoot = requiredFlag(args, "--artifact-root");
  const renderOutputPath = requiredFlag(args, "--render-output");
  const redaction = optionalFlag(args, "--redaction") ?? "on";
  if (redaction !== "on" && redaction !== "off") {
    throw new Error(`itotori validate: --redaction must be 'on' or 'off', got '${redaction}'`);
  }

  const replayArgs = [
    "replay-validate",
    "--engine",
    "reallive",
    "--seen",
    seenPath,
    "--scene",
    scene,
    "--print-replay-log",
    replayLogPath,
  ];
  if (args.includes("--print-textlines")) {
    replayArgs.push("--print-textlines");
  }
  runNativeCommandOrThrow("validate replay", "utsushi-cli", replayArgs, dependencies.nativeCli);

  const renderArgs = [
    "render-validate",
    "--engine",
    "reallive",
    "--seen",
    seenPath,
    "--scene",
    scene,
    "--gameexe",
    gameexePath,
    "--game-dir",
    gameDir,
    "--artifact-root",
    artifactRoot,
    "--redaction",
    redaction,
    "--output",
    renderOutputPath,
  ];
  appendOptionalFlag(renderArgs, args, "--source-seen");
  appendOptionalFlag(renderArgs, args, "--bg-asset");
  appendOptionalFlag(renderArgs, args, "--private-artifact-root");
  appendOptionalFlag(renderArgs, args, "--run-id");
  appendOptionalFlag(renderArgs, args, "--expect-text-contains");
  appendOptionalFlag(renderArgs, args, "--width");
  appendOptionalFlag(renderArgs, args, "--height");
  runNativeCommandOrThrow("validate render", "utsushi-cli", renderArgs, dependencies.nativeCli);
}

function runNativeCommandOrThrow(
  commandName: string,
  bin: "kaifuu-cli" | "utsushi-cli",
  args: string[],
  nativeCli: NativeCliRunner | undefined,
): void {
  const result = runNativeCli(bin, args, nativeCli);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "<no output>";
    throw new Error(
      `itotori ${commandName}: ${bin} failed with status ${String(result.status)}: ${detail}`,
    );
  }
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
}

async function runTelemetrySummaryHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // UTSUSHI-231 — when `--provider-runs-dir` is supplied, source the
  // summary from the per-run `provider-run.json` artifacts the
  // localize-project stage writes (the DB-free path) instead of the
  // draft-attempt provider ledger. The byPair, ZDR, and billed-cost
  // evidence come verbatim from the real served responses captured in
  // those artifacts — no DB, no withServices.
  if (args.includes("--provider-runs-dir")) {
    const flags = parseTelemetrySummaryProviderRunFlags(args);
    const artifacts = readProviderRunArtifactsFromDir(flags.providerRunsDir);
    if (artifacts.length === 0) {
      throw new Error(
        `telemetry-summary refused: no provider-run.json artifacts found under ${flags.providerRunsDir}`,
      );
    }
    const output = buildTelemetrySummaryFromProviderRunArtifacts({
      projectId: flags.projectId,
      artifacts,
      ...(flags.from === undefined ? {} : { from: flags.from }),
      ...(flags.to === undefined ? {} : { to: flags.to }),
    });
    dependencies.io.writeJson(flags.outputPath, output);
    if (flags.format === "text") {
      for (const line of renderTextSummary(
        output,
        {
          projectId: output.metadata.projectId,
          from: new Date(output.metadata.window.from),
          to: new Date(output.metadata.window.to),
        },
        output.postRunEvidence,
      )) {
        process.stdout.write(`${line}\n`);
      }
    }
    return;
  }
  const flags = parseTelemetrySummaryCliFlags(args);
  await dependencies.withServices(async (services) => {
    if (services.telemetry === undefined) {
      throw new Error(
        "telemetry service is not configured for this CLI context (telemetry port missing)",
      );
    }
    const deps: TelemetrySummaryCliDeps = {
      telemetry: services.telemetry.query,
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
      stdoutWrite: (line) => process.stdout.write(line),
    };
    await runTelemetrySummaryCli(
      {
        actor: services.telemetry.actor,
        projectId: flags.projectId,
        from: flags.from,
        to: flags.to,
        outputPath: flags.outputPath,
        groupByDay: flags.groupByDay,
        format: flags.format,
      },
      deps,
    );
  });
}

/**
 * ITOTORI-235 — reconcile persisted ledger rows against OpenRouter's canonical
 * settled cost (`GET /api/v1/generation?id=`) and exit NON-ZERO if any row's
 * `cost_amount` drifts from the re-fetched `total_cost` beyond 1e-9 USD.
 *
 * `--ledger-rows` is a JSON array of `{ generationId, costAmount|costAmountUsd,
 * rowRef? }` (the generation id is captured at `adapter_metadata.generationId`
 * on the recorded provider-run). Uses the live OPENROUTER_API_KEY and asserts
 * the account-wide ZDR posture before any live byte, mirroring the live suite.
 */
async function runReconcileLedgerCostHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const ledgerRowsPath = requiredFlag(args, "--ledger-rows");
  const outputPath = requiredFlag(args, "--output");
  const baseUrl = optionalFlag(args, "--base-url");
  const env = process.env;
  // Privacy gate BEFORE any live byte (mirrors the live OR test suite).
  assertOpenRouterZdrAccount(env);
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "reconcile-ledger-cost requires OPENROUTER_API_KEY to re-fetch canonical cost from /generation",
    );
  }
  const ledgerRowsInput = dependencies.io.readJson(ledgerRowsPath);
  await runReconcileLedgerCostCommand({
    ledgerRowsInput,
    deps: {
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
    writeReport: (report) => dependencies.io.writeJson(outputPath, report),
    log: (message) => process.stdout.write(`${message}\n`),
    exit: (code) => {
      process.exitCode = code;
    },
  });
}

async function runDashboardStatus(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const status = await dependencies.withServices((services) =>
    services.projectWorkflow.getDashboardStatus(),
  );
  dependencies.io.writeJson(outputPath, status);
}

async function runAgenticLoopSmoke(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const bridgePath = requiredFlag(args, "--bridge");
  const unitIndexRaw = requiredFlag(args, "--unit-index");
  const unitIndex = Number.parseInt(unitIndexRaw, 10);
  if (!Number.isFinite(unitIndex) || unitIndex < 0) {
    throw new Error(
      `agentic-loop-smoke refused: --unit-index '${unitIndexRaw}' must be a non-negative integer`,
    );
  }
  const pairPolicyPath = requiredFlag(args, "--pair-policy");
  const outputPath = requiredFlag(args, "--output");
  const draftArtifactOutputPath = optionalFlag(args, "--draft-artifact-output");
  await runAgenticLoopSmokeCommand({
    bridgePath,
    unitIndex,
    pairPolicyPath,
    outputPath,
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
    actor: { userId: "local-user" },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    ...(draftArtifactOutputPath === undefined ? {} : { draftArtifactOutputPath }),
  });
}

/**
 * visual-inspection-gate-for-all-render-nodes — the eyes-on-pixels
 * enforcement step every render/screenshot node runs on its emitted proof
 * frame. Sends the frame to a ZDR-routed OpenRouter VISION model, records the
 * structured verdict alongside render-evidence, and EXITS NONZERO when the
 * verdict marks the frame incoherent / target-text-illegible / redaction-
 * wrong. Live only (`ITOTORI_VISION_GATE_LIVE=1` + exported OpenRouter key +
 * account ZDR assertion); a non-live invocation is reported as `skipped`.
 *
 * Flags:
 *   --frame <png>              rendered proof-frame PNG (required)
 *   --expected-text <s>        localized target text expected in the frame
 *   --expected-text-file <p>   ...or read it from a file (model input only)
 *   --redaction on|off         the frame's redaction posture (required)
 *   --classification <c>       provider input classification (default private_corpus)
 *   --verdict-out <json>       write the verdict artifact here (private/uncommitted)
 */
async function runVisionInspectHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const framePath = requiredFlag(args, "--frame");
  const redactionRaw = requiredFlag(args, "--redaction");
  if (redactionRaw !== "on" && redactionRaw !== "off") {
    throw new Error(`vision-inspect: --redaction must be 'on' or 'off', got '${redactionRaw}'`);
  }
  const redactionMode: RedactionMode = redactionRaw;
  const expectedTextInline = optionalFlag(args, "--expected-text");
  const expectedTextFile = optionalFlag(args, "--expected-text-file");
  const expectedText =
    expectedTextInline ??
    (expectedTextFile !== undefined ? readFileSync(expectedTextFile, "utf8") : undefined);
  if (expectedText === undefined) {
    throw new Error("vision-inspect: provide --expected-text or --expected-text-file");
  }
  const classification = optionalFlag(args, "--classification");
  const verdictOut = optionalFlag(args, "--verdict-out");

  const outcome = await runVisionGateCommand({
    framePath,
    expectedText,
    redactionMode,
    ...(classification === undefined ? {} : { inputClassification: classification as never }),
  });

  if (outcome.status === "skipped") {
    process.stdout.write(
      `${JSON.stringify({ status: "skipped", reason: outcome.reason }, null, 2)}\n`,
    );
    return;
  }

  const { artifact } = outcome.result;
  if (verdictOut !== undefined) {
    dependencies.io.writeJson(verdictOut, artifact);
  }
  process.stdout.write(`${JSON.stringify(visionGateSummary(artifact), null, 2)}\n`);

  // GATE: a rejected frame FAILS the render proof (nonzero exit).
  if (outcome.status === "rejected") {
    throw new VisionGateRejectedError(outcome.result.gate.failures);
  }
}

/**
 * itotori-structure-export — the user-shaped front-door over the UTSUSHI-side
 * narrative-structure producer (`utsushi structure`). Wraps the utsushi-cli
 * binary so the structure-informed context the whole-game localize driver
 * (`itotori localize`) consumes as `utsushi.narrative-structure.v1` is a
 * first-class itotori command, not a foreign Rust bin.
 *
 * Required flags (no defaulting):
 *   --gameexe <PATH>   Gameexe.ini (resolves `SEEN_START` + `#NAMAE`)
 *   --seen <PATH>      Seen.txt compressed scene archive
 *   --output <PATH>    where the structure JSON is written (outside the repo;
 *                      carries copyrighted script text on real bytes)
 * Optional:
 *   --entry-scene <N>  override the `SEEN_START` entry scene (a route-specific
 *                      opening, etc.); drives the dispatch-order walk from it
 *   --max-scenes <N>   cap the dispatch-order walk at N crossed scenes
 *
 * The producer owns its own JSON write; a non-zero exit surfaces its stderr
 * verbatim (already prefixed `utsushi.structure.<step>:`) through a typed
 * `UtsushiStructureExportError`.
 */
async function runStructureExportHandler(
  args: string[],
  _dependencies: ItotoriCliDependencies,
): Promise<void> {
  const gameexePath = requiredFlag(args, "--gameexe");
  const seenPath = requiredFlag(args, "--seen");
  const outputPath = requiredFlag(args, "--output");
  const entrySceneRaw = optionalFlag(args, "--entry-scene");
  const maxScenesRaw = optionalFlag(args, "--max-scenes");

  let entryScene: number | undefined;
  if (entrySceneRaw !== undefined) {
    const parsed = Number.parseInt(entrySceneRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== entrySceneRaw) {
      throw new Error(
        `structure-export refused: --entry-scene '${entrySceneRaw}' must be a non-negative integer`,
      );
    }
    entryScene = parsed;
  }

  let maxScenes: number | undefined;
  if (maxScenesRaw !== undefined) {
    const parsed = Number.parseInt(maxScenesRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== maxScenesRaw) {
      throw new Error(
        `structure-export refused: --max-scenes '${maxScenesRaw}' must be a positive integer`,
      );
    }
    maxScenes = parsed;
  }

  const result: RunUtsushiStructureResult = runUtsushiStructureExport({
    gameexePath,
    seenPath,
    outputPath,
    ...(entryScene !== undefined ? { entryScene } : {}),
    ...(maxScenes !== undefined ? { maxScenes } : {}),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: "utsushi.narrative-structure.v1",
        outputPath,
        status: result.status,
      },
      null,
      2,
    )}\n`,
  );
}

async function runProviderProof(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // Recorded mode is the default (no credentials); `--live` opts in to a
  // bounded real ZDR call. The OpenRouter key is read from the environment
  // by the command and is NEVER passed on the CLI or printed.
  const live = args.includes("--live");
  const fixturePath = optionalFlag(args, "--fixture");
  const outputPath = optionalFlag(args, "--output");
  const maxRepairRaw = optionalFlag(args, "--max-repair-attempts");
  const maxRepairAttempts =
    maxRepairRaw === undefined ? undefined : Number.parseInt(maxRepairRaw, 10);
  if (maxRepairAttempts !== undefined && !Number.isInteger(maxRepairAttempts)) {
    throw new Error(
      `provider-proof refused: --max-repair-attempts '${String(maxRepairRaw)}' must be an integer`,
    );
  }
  const result = await runProviderProofCommand({
    mode: live ? "live" : "recorded",
    ...(fixturePath === undefined ? {} : { fixturePath }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
  });
  if (result.status === "skipped") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (outputPath !== undefined) {
    dependencies.io.writeJson(outputPath, result.bundle);
  }
  process.stdout.write(`${JSON.stringify(providerProofSummary(result.bundle), null, 2)}\n`);
}

async function runProviderProofBundle(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // ALPHA-008 — the sanitized provider-proof bundle command. Recorded mode is
  // the default (no credentials, runs in public CI); `--live` opts in to a
  // bounded real ZDR call. Emits the README-safe `AlphaProviderProofSummary`
  // (routed provider/model, fallback chain, retry state, token/cost,
  // data-policy flags, structured-output support) plus an optional Markdown
  // render. The OpenRouter key is read from the env by the command, NEVER
  // passed on the CLI or printed; no raw prompt/response/private text is
  // emitted (the summary carries ids/hashes/counts/routing/cost only).
  const live = args.includes("--live");
  const fixturePath = optionalFlag(args, "--fixture");
  const outputPath = optionalFlag(args, "--output");
  const markdownOutputPath = optionalFlag(args, "--markdown-output");
  const maxRepairRaw = optionalFlag(args, "--max-repair-attempts");
  const maxRepairAttempts =
    maxRepairRaw === undefined ? undefined : Number.parseInt(maxRepairRaw, 10);
  if (maxRepairAttempts !== undefined && !Number.isInteger(maxRepairAttempts)) {
    throw new Error(
      `provider-proof-bundle refused: --max-repair-attempts '${String(maxRepairRaw)}' must be an integer`,
    );
  }
  const result = await runProviderProofCommand({
    mode: live ? "live" : "recorded",
    ...(fixturePath === undefined ? {} : { fixturePath }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
  });
  if (result.status === "skipped") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const summary = buildAlphaProviderProofSummary(result.bundle);
  if (outputPath !== undefined) {
    dependencies.io.writeJson(outputPath, summary);
  }
  if (markdownOutputPath !== undefined) {
    if (dependencies.io.writeText === undefined) {
      throw new Error(
        `provider-proof-bundle: the CLI file store cannot write the Markdown summary to ${markdownOutputPath}`,
      );
    }
    dependencies.io.writeText(markdownOutputPath, renderReadmeSafeProviderProofSummary(summary));
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function runRawMtlBaselineProof(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // ITOTORI-117 — run the deliberately-naive raw-MTL degenerate baseline
  // through the SAME provider-proof path as a structured draft. Recorded mode
  // is the default (no credentials); `--live` opts in to a bounded real ZDR
  // call. The OpenRouter key is read from the environment by the command and
  // is NEVER passed on the CLI or printed.
  const live = args.includes("--live");
  const fixturePath = optionalFlag(args, "--fixture");
  const outputPath = optionalFlag(args, "--output");
  const maxRepairRaw = optionalFlag(args, "--max-repair-attempts");
  const maxRepairAttempts =
    maxRepairRaw === undefined ? undefined : Number.parseInt(maxRepairRaw, 10);
  if (maxRepairAttempts !== undefined && !Number.isInteger(maxRepairAttempts)) {
    throw new Error(
      `raw-mtl-baseline-proof refused: --max-repair-attempts '${String(maxRepairRaw)}' must be an integer`,
    );
  }
  const result = await runRawMtlBaselineProofCommand({
    mode: live ? "live" : "recorded",
    ...(fixturePath === undefined ? {} : { fixturePath }),
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
  });
  if (result.status === "skipped") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (outputPath !== undefined) {
    dependencies.io.writeJson(outputPath, result.artifact);
  }
  process.stdout.write(`${JSON.stringify(rawMtlBaselineProofSummary(result.artifact), null, 2)}\n`);
}

async function runLocalizeProjectStage(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // UTSUSHI-228 — live-LLM agentic-loop stage of the localize-project
  // recipe. Required flags (no defaulting):
  //   --bridge <PATH>                          bridge-bundle.json (v0.2)
  //   --pair-policy <PATH>                     pair-policy JSON
  //   --output <PATH>                          agentic-loop-bundle.v0.json
  //   --translated-bundle-output <PATH>        translated v0.2 bridge JSON
  //   --patch-report-output <PATH>             synthesised patch-report.json
  // Optional:
  //   --unit-index <N>                         default 0
  //   --max-repair-attempts <N>                default 1
  //   --cost-cap-usd <decimal>                 default 0.5
  //   --provider-run-artifacts-dir <PATH>      persist live provider-run artifacts here
  // The command runs the LIVE OpenRouter path only — there is no fake /
  // fixture provider option on this production CLI surface.
  const bridgePath = requiredFlag(args, "--bridge");
  const pairPolicyPath = requiredFlag(args, "--pair-policy");
  const outputPath = requiredFlag(args, "--output");
  const translatedBundleOutputPath = requiredFlag(args, "--translated-bundle-output");
  const patchReportOutputPath = requiredFlag(args, "--patch-report-output");
  const unitIndexRaw = optionalFlag(args, "--unit-index");
  const engineProfileRaw = optionalFlag(args, "--engine-profile");
  const maxRepairAttemptsRaw = optionalFlag(args, "--max-repair-attempts");
  const costCapUsdRaw = optionalFlag(args, "--cost-cap-usd");
  const providerRunArtifactDirectory = optionalFlag(args, "--provider-run-artifacts-dir");
  if (providerRunArtifactDirectory === undefined) {
    throw new Error(
      "localize-project-stage refused: --provider-run-artifacts-dir is required (the live OpenRouter path persists per-run provider artifacts there)",
    );
  }

  const callArgs: LocalizeProjectStageArgs = {
    bridgePath,
    pairPolicyPath,
    outputPath,
    translatedBundleOutputPath,
    patchReportOutputPath,
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
    actor: { userId: "local-user" },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  };
  if (unitIndexRaw !== undefined) {
    const parsed = Number.parseInt(unitIndexRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        `localize-project-stage refused: --unit-index '${unitIndexRaw}' must be a non-negative integer`,
      );
    }
    callArgs.unitIndex = parsed;
  }
  if (engineProfileRaw !== undefined) {
    if (engineProfileRaw !== "reallive" && engineProfileRaw !== "rpg-maker-mv-mz") {
      throw new Error(
        `localize-project-stage refused: --engine-profile '${engineProfileRaw}' must be 'reallive' or 'rpg-maker-mv-mz'`,
      );
    }
    callArgs.engineProfile = engineProfileRaw;
  }
  if (maxRepairAttemptsRaw !== undefined) {
    const parsed = Number.parseInt(maxRepairAttemptsRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        `localize-project-stage refused: --max-repair-attempts '${maxRepairAttemptsRaw}' must be a non-negative integer`,
      );
    }
    callArgs.maxRepairAttempts = parsed;
  }
  if (costCapUsdRaw !== undefined) {
    const parsed = Number.parseFloat(costCapUsdRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `localize-project-stage refused: --cost-cap-usd '${costCapUsdRaw}' must be a positive number`,
      );
    }
    callArgs.costCapUsd = parsed;
  }
  if (providerRunArtifactDirectory !== undefined) {
    callArgs.providerRunArtifactDirectory = providerRunArtifactDirectory;
  }
  await runLocalizeProjectStageCommand(callArgs);
}

/**
 * itotori-localize-fullproject-cli — the general `itotori localize <project>`
 * whole-game driver. Runs the FULL configured project (every in-scope unit)
 * through the multi-pass ledger against LIVE OpenRouter + real Postgres:
 * persists drafts + reviewer-queue items, exports a patch, and records the
 * pass (real usage.cost + ZDR). GAME-AGNOSTIC — the only inputs are the config
 * path + a run directory; the project/branch/revision ids + the pinned pair
 * arrive through the config + its pair-policy.
 *
 * Required flags (no defaulting):
 *   --config <PATH>       localize-fullproject config JSON
 *   --run-dir <PATH>      directory for the patch export + provider-run
 *                         artifacts + run summary
 * Optional:
 *   --cost-cap-usd <decimal>   per-process OpenRouter cost cap (default $0.50)
 *   --source <PATH>       read-only source game root (REALLIVEDATA/Seen.txt)
 *   --patch-target <PATH> writable output the patched archive lands under
 *
 * m1-wholegame-localize-to-patch-seam: pass BOTH --source and --patch-target to
 * reach an APPLYABLE, byte-correct patch — the run's real drafts pass the
 * export-patch preflight (production loader) then `kaifuu patch --engine
 * reallive --bundle translated-bridge.json` writes the patched output. Omit
 * both to stop at translated-bridge.json. (RealLive engine only.)
 */
async function runLocalizeFullProject(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const configPath = requiredFlag(args, "--config");
  const runDir = requiredFlag(args, "--run-dir");
  const costCapUsdRaw = optionalFlag(args, "--cost-cap-usd");
  // m1-wholegame-localize-to-patch-seam: --source (read-only game root) +
  // --patch-target (writable output) reach an APPLYABLE patch. Both or neither.
  const sourceRoot = optionalFlag(args, "--source");
  const patchTargetRoot = optionalFlag(args, "--patch-target");
  if ((sourceRoot === undefined) !== (patchTargetRoot === undefined)) {
    throw new Error(
      "localize refused: --source and --patch-target must be given together (both reach an applyable patch) or both omitted (stop at translated-bridge.json)",
    );
  }
  let costCapUsd: number | undefined;
  if (costCapUsdRaw !== undefined) {
    const parsed = Number.parseFloat(costCapUsdRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `localize refused: --cost-cap-usd '${costCapUsdRaw}' must be a positive number`,
      );
    }
    costCapUsd = parsed;
  }
  const { result, record, patchApply } = await runLocalizeFullProjectLive({
    configPath,
    runDir,
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
    ...(costCapUsd !== undefined ? { costCapUsd } : {}),
    ...(sourceRoot !== undefined ? { sourceRoot } : {}),
    ...(patchTargetRoot !== undefined ? { patchTargetRoot } : {}),
    ...(dependencies.nativeCli !== undefined ? { nativeCli: dependencies.nativeCli } : {}),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        passNumber: record.passNumber,
        priorPassNumber: record.priorPassNumber ?? null,
        unitsRun: result.unitsRun,
        acceptedDraftCount: result.acceptedDraftCount,
        deferredCount: result.deferredCount,
        failureCount: result.failures.length,
        reviewerQueueItemCount: result.reviewerQueueItemCount,
        acceptedDeltaCount: record.acceptedDeltas.length,
        totalUsageCostUsd: result.totalUsageCostUsd,
        zdrConfirmed: result.zdrConfirmed,
        budgetStopped: result.budgetStopped,
        patchApplied: patchApply !== undefined,
        ...(patchApply !== undefined
          ? {
              patchExportDraftCount: patchApply.patchExportBundle.drafts.length,
              patchTargetRoot,
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * itotori-cli-localize-game-vertical — the M1 CAPSTONE. ONE user-shaped
 * command an agent types to localize the WHOLE game end-to-end. Orchestrates,
 * against a writable target copy, the full vertical by COMPOSING the existing
 * gated subcommands / their in-process seams (it duplicates NONE of their
 * logic):
 *
 *   1. extract   — the whole-Seen bridge (`itotori extract --whole-seen` seam)
 *   2. structure — the narrative structure (`itotori structure-export` seam)
 *   3. localize  — the whole-game driver + M1 patch-apply seam (`itotori
 *      localize --source --patch-target`): drives every unit against live
 *      OpenRouter + real Postgres, then applies the byte-correct patch.
 *   4. validate  — replay + render of the patched target (`itotori validate`).
 *
 * The extract + structure artifacts land in `--run-dir`; the command derives
 * an EFFECTIVE localize config overriding the base config's bridgePath /
 * structureJsonPath with them, so the driver consumes exactly what this run
 * produced. `just localize-project` remains only the four-binary dev/test
 * runner — `itotori localize-game` is the USER surface.
 *
 * Required flags (no defaulting):
 *   --config <PATH>              base localize-fullproject config (v0)
 *   --source <PATH>              read-only source game root (REALLIVEDATA/Seen.txt)
 *   --target <PATH>              writable target the patched game lands under
 *   --run-dir <PATH>             per-run artifact directory
 *   --game-id / --game-version / --source-profile-id / --source-locale
 *                                RealLive identity for the whole-seen extract
 *   --scene <N>                  scene the validate stage replays + renders
 * Optional:
 *   --vault-canonical-id <ID>    source by-id through the read-only vault
 *   --game-root <PATH>           raw extract source root (defaults to --source)
 *   --gameexe <PATH> / --seen <PATH>  structure inputs (default <source>/REALLIVEDATA/*)
 *   --entry-scene <N>            structure dispatch-order entry scene override
 *   --expect-text <TEXT>         localized text the render frame must contain
 *   --redaction on|off           render-frame redaction posture (default on)
 *   --cost-cap-usd <decimal>     per-process OpenRouter budget cap
 */
async function runLocalizeGame(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const configPath = requiredFlag(args, "--config");
  const sourceRoot = requiredFlag(args, "--source");
  const targetRoot = requiredFlag(args, "--target");
  const runDir = requiredFlag(args, "--run-dir");
  const validateScene = requiredFlag(args, "--scene");
  const identity = {
    gameId: requiredFlag(args, "--game-id"),
    gameVersion: requiredFlag(args, "--game-version"),
    sourceProfileId: requiredFlag(args, "--source-profile-id"),
    sourceLocale: requiredFlag(args, "--source-locale"),
  };
  const vaultCanonicalId = optionalFlag(args, "--vault-canonical-id");
  const gameRoot = optionalFlag(args, "--game-root");
  const gameexePath = optionalFlag(args, "--gameexe");
  const seenPath = optionalFlag(args, "--seen");
  const entrySceneRaw = optionalFlag(args, "--entry-scene");
  const expectTextContains = optionalFlag(args, "--expect-text");
  const redactionRaw = optionalFlag(args, "--redaction") ?? "on";
  const costCapUsdRaw = optionalFlag(args, "--cost-cap-usd");

  if (redactionRaw !== "on" && redactionRaw !== "off") {
    throw new Error(`localize-game: --redaction must be 'on' or 'off', got '${redactionRaw}'`);
  }
  let entryScene: number | undefined;
  if (entrySceneRaw !== undefined) {
    entryScene = parseNonNegativeInteger(entrySceneRaw, "--entry-scene");
  }
  let costCapUsd: number | undefined;
  if (costCapUsdRaw !== undefined) {
    const parsed = Number.parseFloat(costCapUsdRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`localize-game: --cost-cap-usd '${costCapUsdRaw}' must be a positive number`);
    }
    costCapUsd = parsed;
  }

  const callArgs: RunLocalizeGameArgs = {
    configPath,
    sourceRoot,
    targetRoot,
    runDir,
    identity,
    validateScene,
    redaction: redactionRaw,
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
    ...(gameRoot !== undefined ? { gameRoot } : {}),
    ...(gameexePath !== undefined ? { gameexePath } : {}),
    ...(seenPath !== undefined ? { seenPath } : {}),
    ...(entryScene !== undefined ? { entryScene } : {}),
    ...(expectTextContains !== undefined ? { expectTextContains } : {}),
    ...(costCapUsd !== undefined ? { costCapUsd } : {}),
  };
  if (dependencies.nativeCli !== undefined) {
    const nativeCli = dependencies.nativeCli;
    // Bind the validate stage to the injected native runner (tests supply a
    // fake); the other three stages resolve their own seams.
    callArgs.stages = {
      extract: (extractArgs) => runKaifuuRealliveExtract(extractArgs),
      structure: (structureArgs) => runUtsushiStructureExport(structureArgs),
      localize: (localizeArgs) => runLocalizeFullProjectLive({ ...localizeArgs, nativeCli }),
      runNative: (bin, nativeArgs) => runNativeCli(bin, nativeArgs, nativeCli),
    };
  }

  try {
    const result = await runLocalizeGameCommand(callArgs);
    process.stdout.write(
      `${JSON.stringify(
        {
          runDir: result.runDir,
          effectiveConfigPath: result.effectiveConfigPath,
          patchTargetRoot: result.patchTargetRoot,
          unitsRun: result.localize.result.unitsRun,
          acceptedDraftCount: result.localize.result.acceptedDraftCount,
          totalUsageCostUsd: result.localize.result.totalUsageCostUsd,
          zdrConfirmed: result.localize.result.zdrConfirmed,
          patchApplied: result.localize.patchApply !== undefined,
          replayLogPath: result.replayLogPath,
          renderEvidencePath: result.renderEvidencePath,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (error instanceof LocalizeGameStageError) {
      // Surface WHICH stage broke on stderr before rethrowing so the top-level
      // handler exits non-zero with the failing-stage context visible.
      process.stderr.write(`[localize-game] STAGE FAILED: stage=${error.stage} ${error.message}\n`);
    }
    throw error;
  }
}

/**
 * itotori-cli-extract-command (P1, user-shaped CLI) — the user-shaped bridge
 * producer. Wraps `kaifuu-cli extract --engine reallive` so a user/agent
 * produces the v0.2 BridgeBundle `itotori localize` consumes WITHOUT knowing
 * about the Rust binary. Both RealLive modes are wired:
 *
 *   * per-scene:  `itotori extract --scene <N> ...`
 *   * whole-game: `itotori extract --whole-seen ...`
 *
 * Flags mirror kaifuu-cli extract (MIRROR the invocation shape). Sourcing is
 * `--vault-canonical-id <ID>` (by-id) OR `--game-root <PATH>` (raw-path helper;
 * kaifuu-cli also falls back to ITOTORI_REAL_GAME_ROOT). kaifuu writes the
 * bridge directly to `--bundle-output`; this handler does NOT touch bridge
 * bytes.
 */
async function runExtract(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  // The dispatcher contract is (args, dependencies); extract delegates to a
  // kaifuu-cli subprocess and does not touch the file store or services, so
  // `dependencies` is intentionally unused here.
  void dependencies;
  const engineRaw = optionalFlag(args, "--engine") ?? "reallive";
  if (engineRaw !== "reallive") {
    throw new Error(
      `extract refused: --engine '${engineRaw}' is not supported (only 'reallive' is wired)`,
    );
  }
  const wholeSeen = args.includes("--whole-seen");
  const sceneTokenPresent = args.includes("--scene");
  const sceneRaw = optionalFlag(args, "--scene");
  // Resolve the extract mode at the CLI dispatch layer (BEFORE delegating to
  // the seam) so a user-shaped `itotori extract ...` gets a clear, immediate
  // error. Without this, `--scene --whole-seen` would let `optionalFlag`
  // swallow `--whole-seen` as the scene value and trip a confusing u16 error
  // deep in the seam, and a missing mode would only surface at the spawn
  // boundary. Token presence is tracked separately from the value so an
  // empty `--scene` is reported as a missing value, not as "no mode given".
  if (wholeSeen && sceneTokenPresent) {
    throw new Error(
      "extract refused: --whole-seen and --scene are mutually exclusive (choose one extract mode)",
    );
  }
  if (sceneTokenPresent && (sceneRaw === undefined || sceneRaw.startsWith("--"))) {
    throw new Error(
      "extract refused: --scene requires a numeric value (0..65535, e.g. --scene 6010)",
    );
  }
  if (!wholeSeen && !sceneTokenPresent) {
    throw new Error(
      "extract refused: provide --scene <N> (per-scene) or --whole-seen (whole-game)",
    );
  }
  const gameRoot = optionalFlag(args, "--game-root");
  const vaultCanonicalId = optionalFlag(args, "--vault-canonical-id");
  const gameId = requiredFlag(args, "--game-id");
  const gameVersion = requiredFlag(args, "--game-version");
  const sourceProfileId = requiredFlag(args, "--source-profile-id");
  const sourceLocale = requiredFlag(args, "--source-locale");
  const bundleOutputPath = requiredFlag(args, "--bundle-output");
  const decompileReportOutputPath = optionalFlag(args, "--decompile-report-output");

  const result = runKaifuuRealliveExtract({
    gameId,
    gameVersion,
    sourceProfileId,
    sourceLocale,
    bundleOutputPath,
    ...(wholeSeen ? { wholeSeen: true } : {}),
    ...(sceneRaw !== undefined ? { scene: parseRealliveSceneId(sceneRaw) } : {}),
    ...(gameRoot !== undefined ? { gameRoot } : {}),
    ...(vaultCanonicalId !== undefined ? { vaultCanonicalId } : {}),
    ...(decompileReportOutputPath !== undefined ? { decompileReportOutputPath } : {}),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        engine: "reallive",
        mode: result.mode,
        bundleOutputPath: result.bundleOutputPath,
        status: result.status,
      },
      null,
      2,
    )}\n`,
  );
}

function parseRealliveSceneId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`extract refused: --scene '${value}' must be a u16 (0..65535)`);
  }
  return parsed;
}

async function runExportPatchV2(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const draftBundlePath = requiredFlag(args, "--draft-bundle");
  const outputPath = requiredFlag(args, "--output");
  const locale = requiredFlag(args, "--locale");
  const requestedBy = optionalFlag(args, "--requested-by") ?? "local-user";
  const draftSourceBridgeHash = optionalFlag(args, "--draft-source-bridge-hash");
  await dependencies.withServices(async (services) => {
    const port = requireAssetDecisionsPort(services);
    await runExportPatchV2Command({
      projectPath,
      draftBundlePath,
      outputPath,
      locale,
      requestedBy,
      ...(draftSourceBridgeHash === undefined ? {} : { draftSourceBridgeHash }),
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      actor: { userId: requestedBy },
      loadActiveDecisions: async (_actor, projectId, localeBranchId) =>
        port.loadActiveDecisions(projectId, localeBranchId),
      exit: (code) => {
        process.exitCode = code;
      },
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
    });
  });
}

async function runIngestRuntime(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const runtimeReportPath = requiredFlag(args, "--runtime-report");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const report = dependencies.io.readJson(runtimeReportPath);
  assertRuntimeReport(report);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestRuntimeReport(project, report),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.result);
}

async function runIngestPatchResult(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const patchResultPath = requiredFlag(args, "--patch-result");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const patchResult = dependencies.io.readJson(patchResultPath);
  assertPatchResultV02(patchResult);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestPatchResult(project, patchResult),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.result);
}

async function runIngestConformance(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const reportPath = requiredFlag(args, "--report-file");
  const manifestPath = optionalFlag(args, "--manifest-file");
  const outputPath = optionalFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const reportPayload = dependencies.io.readJson(reportPath);
  const results: ConformanceResultV01[] = Array.isArray(reportPayload)
    ? reportPayload.map((entry) => {
        assertConformanceResultV01(entry);
        return entry;
      })
    : (() => {
        assertConformanceResultV01(reportPayload);
        return [reportPayload];
      })();
  let manifest: ConformanceManifestV01 | undefined;
  if (manifestPath !== undefined) {
    const manifestPayload = dependencies.io.readJson(manifestPath);
    assertConformanceManifestV01(manifestPayload);
    manifest = manifestPayload;
  }
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestConformanceReport(project, {
      results,
      ...(manifest === undefined ? {} : { manifest }),
    }),
  );
  dependencies.io.writeJson(projectPath, result.project);
  if (outputPath !== undefined) {
    dependencies.io.writeJson(outputPath, result.result);
  }
}

async function runImportFeedback(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const feedbackPath = requiredFlag(args, "--feedback");
  const outputPath = requiredFlag(args, "--output");
  const feedback = dependencies.io.readJson(feedbackPath);
  const result = await dependencies.withServices((services) =>
    services.manualFeedback.importManualFeedback(feedback),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runImportFeedbackBatch(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const batchPath = requiredFlag(args, "--batch");
  const outputPath = requiredFlag(args, "--output");
  const batch = dependencies.io.readJson(batchPath) as DraftFeedbackBatchInput;
  const result = await dependencies.withServices((services) =>
    services.draftFeedbackBatch.submitBatch(batch),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runCatalogLinkExact(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogExactExternalIdLinkRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogExactExternalIdLinker.linkExactExternalIds(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runCatalogFuzzyCandidates(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogFuzzyCandidateRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runCatalogResolveFixture(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const fixturePath = optionalFlag(args, "--fixture") ?? "fixtures/catalog-resolver/fixture.json";
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/catalog/resolver-integration.json";
  const fixture = dependencies.io.readJson(fixturePath) as CatalogResolverFixtureInput;
  const artifact = createCatalogResolverFixtureArtifact(fixture);
  dependencies.io.writeJson(outputPath, artifact);
}

async function runCatalogLocalScan(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const rootPath = requiredFlag(args, "--root");
  const outputPath = requiredFlag(args, "--output");
  const rootLabel = optionalFlag(args, "--root-label");
  const ownedRaw = optionalFlag(args, "--owned");
  const maxDepthRaw = optionalFlag(args, "--max-depth");
  const hashKey = optionalFlag(args, "--hash-key") ?? process.env.ITOTORI_LOCAL_CORPUS_HASH_KEY;
  const report = await scanCatalogLocalRoot({
    rootPath,
    ...(rootLabel === undefined ? {} : { rootLabel }),
    ...(ownedRaw === undefined ? {} : { owned: parseBooleanFlag(ownedRaw, "--owned") }),
    ...(maxDepthRaw === undefined
      ? {}
      : { maxDepth: parseNonNegativeInteger(maxDepthRaw, "--max-depth") }),
    ...(hashKey === undefined ? {} : { hashKey }),
  });
  dependencies.io.writeJson(outputPath, report);
}

async function runStyleGuideFixtureFlow(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const fixturePath =
    optionalFlag(args, "--fixture") ?? "fixtures/itotori-style-guide/conversations/accepted.json";
  const seedWorkPath =
    optionalFlag(args, "--seed-work") ?? "fixtures/itotori-style-guide/seed-work.json";
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/itotori/style-guide-fixture-flow.json";
  const fixture = dependencies.io.readJson(fixturePath);
  assertStyleGuideConversationTranscript(fixture);
  // The recorded fixture flow is DATA + service LOGIC: the bridge/draft/
  // affected-work/benchmark seed records live in the seed-work DATA file, not
  // hardcoded in the service. Editing seed text is a data edit.
  const seedWork = dependencies.io.readJson(seedWorkPath);
  const fixtureId = optionalFlag(args, "--fixture-id");
  let result: StyleGuideFixtureFlowResult;
  try {
    result = await dependencies.withServices((services) =>
      services.styleGuideFixtureFlow.run({
        transcript: fixture satisfies StyleGuideConversationTranscript,
        seedWork,
        ...(fixtureId === undefined ? {} : { fixtureId }),
      }),
    );
  } catch (error) {
    if (error instanceof StyleGuideFixtureFlowRerunError) {
      // Seed-once flow: a rerun is rejected before any write. Surface the typed,
      // actionable diagnostic (no stack trace) and exit non-zero so the rerun is
      // an explicit expected failure rather than a partial-duplicated mutation.
      process.stderr.write(
        `style-guide-fixture-flow: rerun rejected [${error.code}]\n` +
          `  ${error.message}\n` +
          `  This flow seeds a deterministic style-guide version chain exactly once. ` +
          `Reset the database (or point --fixture at a fresh locale branch) before re-running.\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  dependencies.io.writeJson(outputPath, result);
}

async function runBenchmarkHarnessHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // Public-fixture-only run: every input defaults to a checked-in public
  // fixture, so the command completes with no private corpora and no live
  // provider credentials.
  const seedsPath =
    optionalFlag(args, "--benchmark-seeds") ?? DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH;
  const setsPath =
    optionalFlag(args, "--benchmark-sets") ?? DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH;
  const stagesFixturePath =
    optionalFlag(args, "--benchmark-stages") ?? DEFAULT_PUBLIC_BENCHMARK_STAGES_FIXTURE_PATH;
  const outputDir = optionalFlag(args, "--output-dir") ?? "artifacts/itotori/benchmark-harness";
  // Identity is threaded through args so a REAL run supplies its own values; the
  // public fixture pins its deterministic, replay-stable defaults when the flags
  // are omitted — keeping the checked-in fixture output byte-identical.
  const benchmarkRunId =
    optionalFlag(args, "--benchmark-run-id") ?? DEFAULT_PUBLIC_BENCHMARK_RUN_ID;
  const generatedAt = optionalFlag(args, "--generated-at") ?? DEFAULT_PUBLIC_BENCHMARK_GENERATED_AT;

  const benchmarkSetReadModel = benchmarkSetReadModelFromSeedsFixture(
    dependencies.io.readJson(seedsPath),
  );
  const benchmarkSetSelectionInput = benchmarkSetSelectionInputFromSetsFixture(
    dependencies.io.readJson(setsPath),
    benchmarkSetReadModel.targetLanguage,
  );
  const stages = buildPublicBenchmarkHarnessStages({
    benchmarkSetReadModel,
    benchmarkSetSelectionInput,
    stagesFixture: loadBenchmarkStagesFixture(dependencies.io.readJson(stagesFixturePath)),
  });

  const manifest = await runBenchmarkHarnessCommand({
    benchmarkRunId,
    benchmarkName: "itotori-026 public-fixture benchmark harness run",
    generatedAt,
    outputDir,
    stages,
    io: { writeJson: (path, value) => dependencies.io.writeJson(path, value) },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });

  if (manifest.status === "failed") {
    // The run manifest is already written with the visible failed stage;
    // escalate to a non-zero exit so the failure is not masked by exit 0.
    throw new Error(
      `benchmark-harness run failed at stage '${manifest.failedStageId ?? "unknown"}'; see ${outputDir}/run-manifest.json`,
    );
  }
}

async function runExperimentReportComposeHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // ITOTORI-039 — COMPOSE an ITOTORI-099 experiment-matrix run manifest and
  // an ITOTORI-100 provider route report into a benchmark report attachment.
  // Every input defaults to a checked-in PUBLIC fixture, so the command
  // completes with no private corpora and no live provider credentials. A
  // missing / stale / invalid composed artifact FAILS with a structured
  // finding that NAMES the artifact and escalates to a non-zero exit.
  const manifestPath =
    optionalFlag(args, "--experiment-manifest") ?? DEFAULT_PUBLIC_EXPERIMENT_MANIFEST_FIXTURE_PATH;
  const routeReportPath =
    optionalFlag(args, "--provider-route-report") ??
    DEFAULT_PUBLIC_PROVIDER_ROUTE_REPORT_FIXTURE_PATH;
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/itotori/experiment-report/attachment.json";

  const composition = composeExperimentBenchmarkReport({
    experimentManifestRef: {
      artifactName: "experiment-matrix run manifest",
      artifactPath: manifestPath,
    },
    providerRouteReportRef: {
      artifactName: "provider route report",
      artifactPath: routeReportPath,
    },
    // The reader throws ENOENT on a missing file; the command catches it and
    // turns it into a `missing_artifact` finding NAMING the artifact.
    readArtifact: (ref) => dependencies.io.readJson(ref.artifactPath),
    generatedAt: "2026-06-30T00:00:00.000Z",
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });

  if (composition.attachment !== null) {
    // The attachment (succeeded OR failed, with embedded findings) is written
    // so the diagnostics stay inspectable on disk.
    dependencies.io.writeJson(outputPath, composition.attachment);
  }

  if (composition.status !== "succeeded") {
    // Escalate so a missing/stale/invalid composed artifact is not masked by
    // exit 0. The error names every offending artifact + field.
    throw new ExperimentReportCompositionError(composition.findings);
  }
}

async function runAlphaReadinessHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // ALPHA-003 — COMPOSE the alpha readiness decision from PUBLIC-fixture
  // benchmark evidence: the ITOTORI-026 harness run (which wires the
  // ITOTORI-090/091/092 real stages, including the raw-MTL baseline and the
  // ledger-recomputed cost/quality report) plus the ITOTORI-039/100 provider
  // experiment-report (served pairs + artifact↔ledger cost reconciliation).
  //
  // Every input defaults to a checked-in PUBLIC fixture, so the command runs
  // WITHOUT any private-local corpus and without live provider credentials. A
  // private-local aggregate, when supplied, is recorded as supplementary
  // evidence (presence + content hash only) and never gates the decision.
  const seedsPath =
    optionalFlag(args, "--benchmark-seeds") ?? DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH;
  const setsPath =
    optionalFlag(args, "--benchmark-sets") ?? DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH;
  const stagesFixturePath =
    optionalFlag(args, "--benchmark-stages") ?? DEFAULT_PUBLIC_BENCHMARK_STAGES_FIXTURE_PATH;
  const experimentManifestPath =
    optionalFlag(args, "--experiment-manifest") ?? DEFAULT_PUBLIC_EXPERIMENT_MANIFEST_FIXTURE_PATH;
  const routeReportPath =
    optionalFlag(args, "--provider-route-report") ??
    DEFAULT_PUBLIC_PROVIDER_ROUTE_REPORT_FIXTURE_PATH;
  const outputDir = optionalFlag(args, "--output-dir") ?? "artifacts/itotori/alpha-readiness";
  const generatedAt = optionalFlag(args, "--generated-at") ?? "2026-06-30T00:00:00.000Z";
  const privateLocalPath = optionalFlag(args, "--private-local-aggregate");

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };

  // ── Run the benchmark harness over the public fixtures, capturing the
  // cost-quality artifact in-memory while still persisting every stage report. ─
  const benchmarkDir = `${outputDir}/benchmark`;
  const benchmarkSetReadModel = benchmarkSetReadModelFromSeedsFixture(
    dependencies.io.readJson(seedsPath),
  );
  const benchmarkSetSelectionInput = benchmarkSetSelectionInputFromSetsFixture(
    dependencies.io.readJson(setsPath),
    benchmarkSetReadModel.targetLanguage,
  );
  const stages = buildPublicBenchmarkHarnessStages({
    benchmarkSetReadModel,
    benchmarkSetSelectionInput,
    stagesFixture: loadBenchmarkStagesFixture(dependencies.io.readJson(stagesFixturePath)),
  });
  const captured = new Map<string, unknown>();
  const runManifest = await runBenchmarkHarnessCommand({
    benchmarkRunId: "019ed026-0000-7000-8000-000000000001",
    benchmarkName: "alpha readiness public-fixture benchmark run",
    generatedAt,
    outputDir: benchmarkDir,
    stages,
    io: {
      writeJson: (path, value) => {
        captured.set(path, value);
        dependencies.io.writeJson(path, value);
      },
    },
    log,
  });

  if (runManifest.status !== "succeeded") {
    // The public-fixture benchmark decides pass/fail; a failed harness run is a
    // failed alpha readiness. The run manifest is already persisted with the
    // visible failed stage — escalate so the failure is not masked by exit 0.
    throw new Error(
      `alpha-readiness benchmark run failed at stage '${runManifest.failedStageId ?? "unknown"}'; see ${benchmarkDir}/run-manifest.json`,
    );
  }

  const costQualityArtifact = captured.get(`${benchmarkDir}/cost-quality-report.json`) as
    | AlphaReadinessCostQualityArtifact
    | undefined;
  if (costQualityArtifact === undefined) {
    throw new Error(
      `alpha-readiness: harness did not produce ${benchmarkDir}/cost-quality-report.json`,
    );
  }

  // ── Compose the provider experiment-report (served pairs + cost reconcile). ─
  const providerProofPath = `${outputDir}/provider-proof/attachment.json`;
  const experimentComposition = composeExperimentBenchmarkReport({
    experimentManifestRef: {
      artifactName: "experiment-matrix run manifest",
      artifactPath: experimentManifestPath,
    },
    providerRouteReportRef: {
      artifactName: "provider route report",
      artifactPath: routeReportPath,
    },
    readArtifact: (ref) => dependencies.io.readJson(ref.artifactPath),
    generatedAt,
    log,
  });
  if (experimentComposition.attachment !== null) {
    dependencies.io.writeJson(providerProofPath, experimentComposition.attachment);
  }

  // ── ALPHA-008 — the real-call sanitized provider-proof bundle, consumed as
  //    structured provider-support evidence. Recorded mode is credential-free
  //    and deterministic so this runs in public CI; the summary carries only
  //    ids/hashes/counts/routing/cost (no raw prompt/response/key/private text).
  const proofResult = await runRecordedProviderProof();
  if (proofResult.status !== "passed") {
    throw new Error(
      `alpha-readiness: recorded provider-proof did not pass (status='${proofResult.status}')`,
    );
  }
  const providerProofSummaryBundle = buildAlphaProviderProofSummary(proofResult.bundle);
  const providerProofBundleDir = `${outputDir}/provider-proof-bundle`;
  dependencies.io.writeJson(`${providerProofBundleDir}/summary.json`, providerProofSummaryBundle);

  // ── Optional supplementary private-local aggregate: hash only, no contents. ─
  let privateLocalAggregate: AlphaReadinessPrivateLocalHandle | null = null;
  if (privateLocalPath !== undefined) {
    const raw = dependencies.io.readJson(privateLocalPath);
    const sha256 = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    privateLocalAggregate = { label: privateLocalPath, sha256: `sha256:${sha256}` };
  }

  const report = composeAlphaReadiness({
    runManifest,
    costQualityArtifact,
    experimentComposition,
    providerProofArtifactPath: providerProofPath,
    providerProofSummary: providerProofSummaryBundle,
    generatedAt,
    privateLocalAggregate,
  });

  // ── Persist the deliverables. ────────────────────────────────────────────
  dependencies.io.writeJson(`${outputDir}/alpha-readiness-report.json`, report);
  dependencies.io.writeJson(`${outputDir}/cost-report.json`, report.cost);
  dependencies.io.writeJson(`${outputDir}/quality-report.json`, report.quality);
  const summaryPath = `${outputDir}/README-summary.md`;
  if (dependencies.io.writeText === undefined) {
    throw new Error(
      `alpha-readiness: the CLI file store cannot write the README-safe summary to ${summaryPath}`,
    );
  }
  dependencies.io.writeText(summaryPath, renderReadmeSafeAlphaSummary(report));
  dependencies.io.writeText(
    `${providerProofBundleDir}/README.md`,
    renderReadmeSafeProviderProofSummary(providerProofSummaryBundle),
  );
  log(
    `alpha-readiness: decision=${report.decision} gates=${report.gates.length} failedGates=${report.failedGateIds.length}; wrote ${outputDir}/alpha-readiness-report.json`,
  );

  if (report.decision !== "pass") {
    // Keep a failed alpha readiness visible at the process level.
    throw new Error(
      `alpha-readiness decision='fail'; failing gates: ${report.failedGateIds.join(", ")}; see ${outputDir}/alpha-readiness-report.json`,
    );
  }
}

async function runInitHandler(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  const initDeps: InitCommandDeps = dependencies.initDeps ?? constructDefaultInitDeps(dependencies);
  await runInitCommand(args, initDeps);
}

function constructDefaultInitDeps(dependencies: ItotoriCliDependencies): InitCommandDeps {
  void dependencies;
  return {
    env: process.env,
    existsPath: (path) => existsSync(path),
    writeText: (path, contents, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: mode ?? 0o600 });
      if (mode !== undefined) {
        chmodSync(path, mode);
      }
    },
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    defaultDatabaseUrl: () => defaultLocalDatabaseUrl(process.env),
    provisionDatabase: async (databaseUrl) => provisionLocalPostgresContainer(databaseUrl),
  };
}

function defaultLocalDatabaseUrl(env: Record<string, string | undefined>): string {
  const port = env.ITOTORI_DB_HOST_PORT ?? String(deriveLocalDatabasePort(env));
  return `postgres://itotori:itotori@127.0.0.1:${port}/itotori`;
}

function deriveLocalDatabasePort(env: Record<string, string | undefined>): number {
  const base = parsePort(env.ITOTORI_DB_HOST_PORT_BASE ?? "56000", "ITOTORI_DB_HOST_PORT_BASE");
  const span = parsePort(env.ITOTORI_DB_HOST_PORT_SPAN ?? "2000", "ITOTORI_DB_HOST_PORT_SPAN");
  if (base + span - 1 > 65535) {
    throw new Error("ITOTORI_DB_HOST_PORT_SPAN must keep the derived port range within 1..65535");
  }
  return base + (stableNumber(resolveWorktreeRoot(env)) % span);
}

function resolveWorktreeRoot(env: Record<string, string | undefined>): string {
  if (env.ITOTORI_DB_WORKTREE_ROOT !== undefined && env.ITOTORI_DB_WORKTREE_ROOT.length > 0) {
    return env.ITOTORI_DB_WORKTREE_ROOT;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top.length > 0) {
      return top;
    }
  } catch {
    // Installed packages and non-git directories use the current directory.
  }
  return process.cwd();
}

function stableNumber(root: string): number {
  return Number.parseInt(
    createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 12),
    16,
  );
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function provisionLocalPostgresContainer(databaseUrl: string): { ok: boolean; message: string } {
  const runtime = firstRunnableCommand(["docker", "podman"]);
  if (runtime === undefined) {
    return {
      ok: false,
      message:
        "Could not auto-start local Postgres because Docker/Podman is unavailable. " +
        "Install Docker/Podman, set DATABASE_URL for a system Postgres, or set ITOTORI_POSTGRES_BIN_DIR.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return {
      ok: false,
      message: "Could not auto-start local Postgres because DATABASE_URL is invalid.",
    };
  }

  const port = parsed.port || "5432";
  const user = decodeURIComponent(parsed.username || "itotori");
  const password = decodeURIComponent(parsed.password || "itotori");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, "") || "itotori");
  const containerName = `itotori-postgres-${port}-${safeContainerSuffix(
    basename(resolveWorktreeRoot(process.env)),
  )}`;

  const start = spawnSync(runtime, ["start", containerName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (start.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started existing local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started existing local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }

  let envFilePath: string;
  try {
    envFilePath = writePostgresContainerEnvFile({ user, password, database });
  } catch (error) {
    return {
      ok: false,
      message: `Could not auto-start local Postgres because DATABASE_URL contains an unsupported credential value: ${errorMessage(
        error,
      )}`,
    };
  }

  const run = spawnSync(
    runtime,
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--env-file",
      envFilePath,
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:18",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  removeSensitiveFile(envFilePath);
  if (run.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }

  const detail = (run.stderr || run.stdout || "unknown container runtime error").trim();
  return {
    ok: false,
    message: `Could not auto-start local Postgres with ${runtime}: ${detail}`,
  };
}

function writePostgresContainerEnvFile(input: {
  user: string;
  password: string;
  database: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "itotori-postgres-env-"));
  const path = join(dir, "postgres.env");
  const contents = [
    envFileLine("POSTGRES_USER", input.user),
    envFileLine("POSTGRES_PASSWORD", input.password),
    envFileLine("POSTGRES_DB", input.database),
    "",
  ].join("\n");
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function envFileLine(name: string, value: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`${name} may not contain newline or NUL characters`);
  }
  return `${name}=${value}`;
}

function removeSensitiveFile(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

function waitForLocalPostgresReady(
  runtime: string,
  containerName: string,
  user: string,
  database: string,
  messages: { readyMessage: string; timeoutMessage: string },
): { ok: boolean; message: string } {
  const timeoutMs = parseReadyTimeoutMs(process.env.ITOTORI_DB_READY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "readiness query did not succeed";
  do {
    const ready = spawnSync(
      runtime,
      [
        "exec",
        containerName,
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "select 1"',
        "itotori-postgres-ready",
        user,
        database,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (ready.status === 0) {
      return { ok: true, message: messages.readyMessage };
    }
    lastDetail = (ready.stderr || ready.stdout || lastDetail).trim();
    sleepSync(250);
  } while (Date.now() < deadline);

  return {
    ok: false,
    message: `${messages.timeoutMessage} Last readiness check: ${lastDetail}`,
  };
}

function parseReadyTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return 30_000;
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return 30_000;
  }
  return timeoutMs;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstRunnableCommand(commands: string[]): string | undefined {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      return command;
    }
  }
  return undefined;
}

function safeContainerSuffix(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gu, "-")
    .replace(/^[^a-z0-9]+/u, "");
  return safe.length > 0 ? safe : "local";
}

function requiredFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) {
    throw new Error(`missing required flag ${name}`);
  }
  return value;
}

function optionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value ? value : undefined;
}

function appendOptionalFlag(target: string[], source: string[], name: string): void {
  const value = optionalFlag(source, name);
  if (value !== undefined) {
    target.push(name, value);
  }
}

function parseBooleanFlag(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readProject(io: JsonFileStore, path: string): ProjectState {
  return io.readJson(path) as ProjectState;
}

async function runPlanBatchesHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const locale = requiredFlag(args, "--locale");
  const outputPath = optionalFlag(args, "--output");
  const modelId = optionalFlag(args, "--model");
  // ITOTORI-220 — the routing provider of the (modelId, providerId) pair. The
  // planner refuses to size a named model without it rather than persisting an
  // unknown-provider sentinel on every batch.
  const providerId = optionalFlag(args, "--provider-id");
  const providerFamilyRaw = optionalFlag(args, "--provider");
  const maxTokensRaw = optionalFlag(args, "--max-tokens");
  const fillRatioRaw = optionalFlag(args, "--target-fill-ratio");
  const priorExampleLimitRaw = optionalFlag(args, "--prior-example-limit");
  const dryRun = args.includes("--dry-run");
  const providerFamily =
    providerFamilyRaw === undefined ? undefined : asProviderFamily(providerFamilyRaw);
  const maxTokens = maxTokensRaw === undefined ? undefined : Number.parseInt(maxTokensRaw, 10);
  const targetFillRatio = fillRatioRaw === undefined ? undefined : Number.parseFloat(fillRatioRaw);
  const priorExampleLimit =
    priorExampleLimitRaw === undefined ? undefined : Number.parseInt(priorExampleLimitRaw, 10);

  await dependencies.withServices(async (services) => {
    const result: PlanBatchesOutput = await runPlanBatches(
      {
        projectPath,
        outputPath,
        locale,
        modelId,
        providerId,
        providerFamily,
        maxTokens,
        targetFillRatio,
        priorExampleLimit,
        dryRun,
      },
      {
        loadProject: (path) => dependencies.io.readJson(path) as PlannedProjectFile,
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
        loadContext: (project, planLocale) =>
          services.batchPlanner.loadContext(project, planLocale),
        persist: (batches, identity) => services.batchPlanner.persist(batches, identity),
        log: (message) => {
          process.stdout.write(`${message}\n`);
        },
      },
    );
    return result;
  });
}

const providerFamilyValues: readonly ProviderFamily[] = [
  "fake",
  "recorded",
  "openrouter",
  "local-openai-compatible",
];

function asProviderFamily(value: string): ProviderFamily {
  if ((providerFamilyValues as readonly string[]).includes(value)) {
    return value as ProviderFamily;
  }
  throw new Error(`unknown provider family: ${value}`);
}

async function runGenerateSceneSummariesHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale-branch");
  const sourceLocale = requiredFlag(args, "--source-locale");
  const sourceRevisionId = requiredFlag(args, "--source-revision");
  const modelId = optionalFlag(args, "--model");
  const providerRaw = optionalFlag(args, "--provider");
  const sceneId = optionalFlag(args, "--scene-id");
  const includeStale = args.includes("--include-stale");
  const dryRun = args.includes("--dry-run");
  const contextWindowRaw = optionalFlag(args, "--context-window");
  const maxOutputRaw = optionalFlag(args, "--max-output-tokens");
  // semantic-agent-cli-provider-run-not-reconciled — run-scoped provider-run
  // directory. Threaded into the provider so its served pair + billed cost +
  // ZDR posture are reconciled (never dropped into the global scratch dir).
  const providerRunsDir = optionalFlag(args, "--provider-runs-dir");

  await dependencies.withServices(async (services) => {
    if (!services.sceneSummary) {
      throw new Error("scene-summary service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.sceneSummary.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.sceneSummary.cliDependencies(providerFamily, providerRunsDir);
    const result = await runGenerateSceneSummariesCli(
      {
        projectId,
        localeBranchId,
        sourceLocale,
        sourceRevisionId,
        modelProfile: {
          providerFamily,
          modelId: modelId ?? services.sceneSummary.defaultModelId,
          providerId: services.sceneSummary.defaultProviderId,
          contextWindowTokens:
            contextWindowRaw === undefined
              ? services.sceneSummary.defaultContextWindowTokens
              : Number.parseInt(contextWindowRaw, 10),
          ...(maxOutputRaw === undefined
            ? {}
            : { maxOutputTokens: Number.parseInt(maxOutputRaw, 10) }),
        },
        ...(sceneId === undefined ? {} : { sceneIdFilter: sceneId }),
        includeStale,
        dryRun,
      },
      deps,
    );
    process.stdout.write(
      `generated=${result.generatedCount} skipped_fresh=${result.skippedFreshCount}\n`,
    );
  });
}

async function runCheckSceneSummariesHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale-branch");
  const sourceRevisionId = requiredFlag(args, "--source-revision");
  const markStale = args.includes("--mark-stale");
  const providerRaw = optionalFlag(args, "--provider");

  await dependencies.withServices(async (services) => {
    if (!services.sceneSummary) {
      throw new Error("scene-summary service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.sceneSummary.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.sceneSummary.cliDependencies(providerFamily);
    const result = await runCheckSceneSummariesCli(
      {
        projectId,
        localeBranchId,
        sourceRevisionId,
        markStale,
      },
      deps,
    );
    process.stdout.write(
      `scanned=${result.scannedSummaryCount} drifted=${result.driftedSummaries.length} marked_stale=${result.markedStaleCount}\n`,
    );
  });
}

// Helper used internally during the legacy CLI bridging so unused-import lints
// pass while the resolveSceneSummaryProvider symbol stays public for embedders.
export const _internalResolveSceneSummaryProviderForCliHandlers = resolveSceneSummaryProvider;

async function runGenerateCharacterRelationshipsHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale-branch");
  const sourceLocale = requiredFlag(args, "--source-locale");
  const sourceRevisionId = requiredFlag(args, "--source-revision");
  const modelId = optionalFlag(args, "--model");
  const providerRaw = optionalFlag(args, "--provider");
  const characterId = optionalFlag(args, "--character-id");
  const includeStale = args.includes("--include-stale");
  const dryRun = args.includes("--dry-run");
  const contextWindowRaw = optionalFlag(args, "--context-window");
  const maxOutputRaw = optionalFlag(args, "--max-output-tokens");
  // semantic-agent-cli-provider-run-not-reconciled — run-scoped provider-run
  // directory threaded into the provider (see scene-summary handler).
  const providerRunsDir = optionalFlag(args, "--provider-runs-dir");

  await dependencies.withServices(async (services) => {
    if (!services.characterRelationship) {
      throw new Error("character-relationship service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.characterRelationship.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.characterRelationship.cliDependencies(
      providerFamily,
      providerRunsDir,
    );
    const result = await runGenerateCharacterRelationshipsCli(
      {
        projectId,
        localeBranchId,
        sourceLocale,
        sourceRevisionId,
        modelProfile: {
          providerFamily,
          modelId: modelId ?? services.characterRelationship.defaultModelId,
          providerId: services.characterRelationship.defaultProviderId,
          contextWindowTokens:
            contextWindowRaw === undefined
              ? services.characterRelationship.defaultContextWindowTokens
              : Number.parseInt(contextWindowRaw, 10),
          ...(maxOutputRaw === undefined
            ? {}
            : { maxOutputTokens: Number.parseInt(maxOutputRaw, 10) }),
        },
        ...(characterId === undefined ? {} : { characterIdFilter: characterId }),
        includeStale,
        dryRun,
      },
      deps,
    );
    process.stdout.write(
      `bios_generated=${result.generatedBioCount} relationships_generated=${result.generatedRelationshipCount} bios_skipped_fresh=${result.skippedFreshBioCount}\n`,
    );
  });
}

async function runCheckCharacterRelationshipsHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale-branch");
  const sourceRevisionId = requiredFlag(args, "--source-revision");
  const markStale = args.includes("--mark-stale");
  const providerRaw = optionalFlag(args, "--provider");

  await dependencies.withServices(async (services) => {
    if (!services.characterRelationship) {
      throw new Error("character-relationship service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.characterRelationship.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.characterRelationship.cliDependencies(providerFamily);
    const result = await runCheckCharacterRelationshipsCli(
      {
        projectId,
        localeBranchId,
        sourceRevisionId,
        markStale,
      },
      deps,
    );
    process.stdout.write(
      `scanned_bios=${result.scannedBioCount} scanned_relationships=${result.scannedRelationshipCount} drifted_bios=${result.driftedBios.length} drifted_relationships=${result.driftedRelationships.length} marked_stale_bios=${result.markedStaleBioCount} marked_stale_relationships=${result.markedStaleRelationshipCount}\n`,
    );
  });
}

export const _internalResolveCharacterRelationshipProviderForCliHandlers =
  resolveCharacterRelationshipProvider;

// KAIFUU-053: CLI commands for the capability-leveled engine detector
// registry. `engine-capabilities-record` upserts one adapter's matrix
// from a JSON file (used to import what `EngineAdapter::capabilities()`
// produced upstream); `engine-capabilities-list` writes a JSON report
// the dashboard and any wrapping tooling can render (the engine-capability
// matrix is exposed via the `/api/*` layer the React SPA consumes).
async function runEngineCapabilitiesRecord(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const matrixPath = requiredFlag(args, "--matrix");
  const matrix = dependencies.io.readJson(matrixPath);
  assertAdapterCapabilityMatrixRecord(matrix);
  await dependencies.withServices((services) =>
    services.engineCapabilityReports.recordMatrix(matrix),
  );
}

async function runEngineCapabilitiesList(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const levelRaw = optionalFlag(args, "--level");
  const level = levelRaw === undefined ? undefined : asCapabilityLevel(levelRaw);
  const result = await dependencies.withServices(async (services) => {
    const summaries = await services.engineCapabilityReports.listAdapterSummaries();
    if (level === undefined) {
      return { adapters: summaries };
    }
    const supporting = await services.engineCapabilityReports.adaptersSupporting(level);
    const supportingSet = new Set(supporting);
    return {
      adapters: summaries,
      level,
      adaptersSupporting: supporting,
      identifyOnlyAdapterIds: summaries
        .filter((summary) => !supportingSet.has(summary.adapterId))
        .map((summary) => summary.adapterId),
    };
  });
  dependencies.io.writeJson(outputPath, result);
}

function asCapabilityLevel(value: string): CapabilityLevel {
  switch (value) {
    case capabilityLevelValues.identify:
    case capabilityLevelValues.inventory:
    case capabilityLevelValues.extract:
    case capabilityLevelValues.patch:
      return value;
    default:
      throw new Error(`unknown capability level: ${value}`);
  }
}

function assertAdapterCapabilityMatrixRecord(
  value: unknown,
): asserts value is AdapterCapabilityMatrixRecord {
  if (!value || typeof value !== "object") {
    throw new Error("AdapterCapabilityMatrix payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.adapterId !== "string" || record.adapterId.length === 0) {
    throw new Error("AdapterCapabilityMatrix.adapterId must be a non-empty string");
  }
  for (const level of [
    capabilityLevelValues.identify,
    capabilityLevelValues.inventory,
    capabilityLevelValues.extract,
    capabilityLevelValues.patch,
  ]) {
    assertCapabilityLevelStatus(record[level], `AdapterCapabilityMatrix.${level}`);
  }
}

function assertCapabilityLevelStatus(value: unknown, label: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "supported":
      return;
    case "partial":
      if (!Array.isArray(record.limitations) || record.limitations.length === 0) {
        throw new Error(`${label}.limitations must be a non-empty string array`);
      }
      for (const entry of record.limitations) {
        if (typeof entry !== "string") {
          throw new Error(`${label}.limitations entries must be strings`);
        }
      }
      return;
    case "unsupported":
      if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
        throw new Error(`${label}.reason must be a non-empty string`);
      }
      return;
    default:
      throw new Error(`${label}.kind must be supported, partial, or unsupported`);
  }
}

// ITOTORI-035: asset localization decision CLI commands. The handlers
// expose the same writes the dashboard does, intended primarily for CI
// scripts and recorded-fixture authoring.

async function runAssetDecisionsListHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale");
  const outputPath = requiredFlag(args, "--output");
  await dependencies.withServices(async (services) => {
    const port = requireAssetDecisionsPort(services);
    await runAssetDecisionsList({ projectId, localeBranchId, outputPath }, port, dependencies.io);
  });
}

async function runAssetDecisionsRecordHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale");
  const assetRef = parseAssetRef(requiredFlag(args, "--asset-ref"));
  const assetKind = parseAssetKind(requiredFlag(args, "--asset-kind"));
  const policy = parseAssetDecisionPolicy(requiredFlag(args, "--policy"));
  const rationale = optionalFlag(args, "--rationale");
  const outputPath = optionalFlag(args, "--output");
  await dependencies.withServices(async (services) => {
    const port = requireAssetDecisionsPort(services);
    const recordArgs: Parameters<typeof runAssetDecisionsRecord>[0] = {
      projectId,
      localeBranchId,
      assetRef,
      assetKind,
      policy,
    };
    if (rationale !== undefined) {
      recordArgs.rationale = rationale;
    }
    if (outputPath !== undefined) {
      recordArgs.outputPath = outputPath;
    }
    await runAssetDecisionsRecord(recordArgs, port, dependencies.io);
  });
}

function requireAssetDecisionsPort(services: ItotoriCliServices): AssetDecisionsCliPort {
  if (services.assetDecisions === undefined) {
    throw new Error(
      "asset-decisions service is not configured for this CLI context (assetDecisions port missing)",
    );
  }
  return services.assetDecisions;
}

// ITOTORI-047: queue-health inspection CLI command. Surfaces the typed
// QueueHealthReadModel (outbox/job lag, pending counts by status, retry counts,
// dead-letter review) via a validated typed API response — the SAME contract
// the `queue.health` dashboard route emits.

async function runQueueHealthHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const deadLetterLimitRaw = optionalFlag(args, "--dead-letter-limit");
  const projectId = optionalFlag(args, "--project");
  await dependencies.withServices(async (services) => {
    const port = requireQueueHealthPort(services);
    const cliArgs: Parameters<typeof runQueueHealthCli>[0] = { outputPath };
    if (deadLetterLimitRaw !== undefined) {
      cliArgs.deadLetterLimit = parseNonNegativeInteger(deadLetterLimitRaw, "--dead-letter-limit");
    }
    if (projectId !== undefined) {
      cliArgs.projectId = projectId;
    }
    await runQueueHealthCli(cliArgs, port, dependencies.io);
  });
}

function requireQueueHealthPort(services: ItotoriCliServices): QueueHealthCliPort {
  if (services.queueHealth === undefined) {
    throw new Error(
      "queue-health service is not configured for this CLI context (queueHealth port missing)",
    );
  }
  return services.queueHealth;
}
