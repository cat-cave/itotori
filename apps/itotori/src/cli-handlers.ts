import {
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertPatchResultV02,
  assertRuntimeReport,
  assertStyleGuideConversationTranscript,
  type ConformanceManifestV01,
  type ConformanceResultV01,
  type StyleGuideConversationTranscript,
} from "@itotori/localization-bridge-schema";
import { capabilityLevelValues, createCatalogResolverFixtureArtifact } from "@itotori/db";
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
import { assertBridgeInput } from "./api-schema.js";
import type { ManualFeedbackImportPort } from "./manual-feedback.js";
import type { ItotoriProjectWorkflowPort, ProjectState } from "./services/project-workflow.js";
import type { PlanBatchesOutput } from "./batch-planner/index.js";
import {
  runPlanBatches,
  type PlanBatchesContextLoader,
  type PlanBatchesPersister,
  type PlannedProjectFile,
} from "./batch-planner/cli.js";
import type { ProviderFamily } from "./providers/types.js";
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
  runLocalizeProjectStageCommand,
  type LocalizeProjectStageArgs,
} from "./orchestrator/localize-project-stage-command.js";
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
import { runReviewQueueFixtureCommand } from "./reviewer/review-queue-fixture-command.js";
import {
  DEFAULT_PUBLIC_BENCHMARK_REPORT_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH,
  benchmarkSetReadModelFromSeedsFixture,
  benchmarkSetSelectionInputFromSetsFixture,
  buildPublicBenchmarkHarnessStages,
  runBenchmarkHarnessCommand,
} from "./benchmark-harness/index.js";
import { scanCatalogLocalRoot } from "./services/catalog-local-scan.js";

export type JsonFileStore = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type ItotoriCliServices = {
  projectWorkflow: ItotoriProjectWorkflowPort;
  manualFeedback: ManualFeedbackImportPort;
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
     */
    cliDependencies(provider: ProviderFamily): Promise<SceneSummaryCliDependencies>;
    defaultModelId: string;
    /** ITOTORI-220 — default providerId for the scene-summary model. */
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
  characterRelationship?: {
    cliDependencies(provider: ProviderFamily): Promise<CharacterRelationshipCliDependencies>;
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
};

export type ItotoriCliDependencies = {
  io: JsonFileStore;
  migrateDatabase(): Promise<void>;
  withServices<T>(callback: (services: ItotoriCliServices) => Promise<T>): Promise<T>;
};

export async function runItotoriCliCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
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
    case "import":
      await runImport(args, dependencies);
      break;
    case "draft":
      await runDraft(args, dependencies);
      break;
    case "agentic-loop-smoke":
      await runAgenticLoopSmoke(args, dependencies);
      break;
    case "localize-project-stage":
      await runLocalizeProjectStage(args, dependencies);
      break;
    case "export-patch":
      await runExportPatch(args, dependencies);
      break;
    case "export-patch-v2":
      await runExportPatchV2(args, dependencies);
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
    case "review-queue-fixture":
      await runReviewQueueFixtureHandler(args, dependencies);
      break;
    case "benchmark-harness-run":
      await runBenchmarkHarnessHandler(args, dependencies);
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
}

async function runReviewQueueFixtureHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = optionalFlag(args, "--output");
  await runReviewQueueFixtureCommand({
    ...(outputPath === undefined ? {} : { outputPath }),
    writeJson: (path, value) => dependencies.io.writeJson(path, value),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
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

async function runImport(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  const bridgePath = requiredFlag(args, "--bridge");
  const projectPath = requiredFlag(args, "--project");
  const bridge = dependencies.io.readJson(bridgePath);
  assertBridgeInput(bridge);
  const project = await dependencies.withServices((services) =>
    services.projectWorkflow.importBridge(bridge),
  );
  dependencies.io.writeJson(projectPath, project);
}

async function runDraft(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const locale = requiredFlag(args, "--locale");
  const project = readProject(dependencies.io, projectPath);
  const nextProject = await dependencies.withServices((services) =>
    services.projectWorkflow.draftProject(project, locale),
  );
  dependencies.io.writeJson(projectPath, nextProject);
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
  //   --provider-kind <live|fake>              default live; fake requires
  //                                            ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1
  //   --cost-cap-usd <decimal>                 default 0.5
  //   --provider-run-artifacts-dir <PATH>      persist live provider-run artifacts here
  const bridgePath = requiredFlag(args, "--bridge");
  const pairPolicyPath = requiredFlag(args, "--pair-policy");
  const outputPath = requiredFlag(args, "--output");
  const translatedBundleOutputPath = requiredFlag(args, "--translated-bundle-output");
  const patchReportOutputPath = requiredFlag(args, "--patch-report-output");
  const unitIndexRaw = optionalFlag(args, "--unit-index");
  const engineProfileRaw = optionalFlag(args, "--engine-profile");
  const maxRepairAttemptsRaw = optionalFlag(args, "--max-repair-attempts");
  const providerKindRaw = optionalFlag(args, "--provider-kind");
  const costCapUsdRaw = optionalFlag(args, "--cost-cap-usd");
  const providerRunArtifactDirectory = optionalFlag(args, "--provider-run-artifacts-dir");
  const providerKind = providerKindRaw ?? "live";
  if (providerKind !== "live" && providerKind !== "fake") {
    throw new Error(
      `localize-project-stage refused: --provider-kind '${providerKind}' must be 'live' or 'fake'`,
    );
  }
  if (providerKind === "live" && providerRunArtifactDirectory === undefined) {
    throw new Error(
      "localize-project-stage refused: --provider-run-artifacts-dir is required when --provider-kind is live",
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
  if (providerKindRaw !== undefined) {
    callArgs.providerKind = providerKind;
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

async function runExportPatch(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.exportPatch(project),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.patchExport);
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
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/itotori/style-guide-fixture-flow.json";
  const fixture = dependencies.io.readJson(fixturePath);
  assertStyleGuideConversationTranscript(fixture);
  const fixtureId = optionalFlag(args, "--fixture-id");
  const result = await dependencies.withServices((services) =>
    services.styleGuideFixtureFlow.run({
      transcript: fixture satisfies StyleGuideConversationTranscript,
      ...(fixtureId === undefined ? {} : { fixtureId }),
    }),
  );
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
  const reportPath =
    optionalFlag(args, "--benchmark-report") ?? DEFAULT_PUBLIC_BENCHMARK_REPORT_FIXTURE_PATH;
  const outputDir = optionalFlag(args, "--output-dir") ?? "artifacts/itotori/benchmark-harness";

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
    benchmarkReport: dependencies.io.readJson(reportPath),
  });

  const manifest = await runBenchmarkHarnessCommand({
    benchmarkRunId: "019ed026-0000-7000-8000-000000000001",
    benchmarkName: "itotori-026 public-fixture benchmark harness run",
    generatedAt: "2026-06-26T00:00:00.000Z",
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

  await dependencies.withServices(async (services) => {
    if (!services.sceneSummary) {
      throw new Error("scene-summary service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.sceneSummary.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.sceneSummary.cliDependencies(providerFamily);
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

  await dependencies.withServices(async (services) => {
    if (!services.characterRelationship) {
      throw new Error("character-relationship service factory is not configured in this CLI build");
    }
    const providerFamily =
      providerRaw === undefined
        ? services.characterRelationship.defaultProviderFamily
        : asProviderFamily(providerRaw);
    const deps = await services.characterRelationship.cliDependencies(providerFamily);
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
// the dashboard and any wrapping tooling can render — see
// `apps/itotori/src/dashboard.ts:renderEngineCapabilityRows`.
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
