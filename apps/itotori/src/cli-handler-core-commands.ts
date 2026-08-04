import {
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertPatchResultV02,
  assertRuntimeEvidenceReportV02,
  type ConformanceManifestV01,
  type ConformanceResultV01,
} from "@itotori/localization-bridge-schema";
import { assertProjectState } from "./api-schema/api-project-response-validation.js";
import { configuredServicePort } from "./services/configured-port.js";
import type {
  ItotoriCliDependencies,
  ItotoriCliServices,
  JsonFileStore,
} from "./cli-handler-contracts.js";
import { optionalFlag, requiredFlag } from "./cli/flags.js";
import {
  extractCapabilities,
  resolveExtractAdapter,
  runKaifuuExtract,
} from "./extract/kaifuu-extract-seam.js";
import { runLocalizeCommand } from "./cli/localize-command.js";
import { runLocalizePortfolioCommand } from "./cli/localize-portfolio-command.js";
import { runPlayCommand } from "./cli/play-command.js";
import { createRuntimeLauncherRegistry } from "./play/patch-runtime-launcher.js";
import { applyEnginePatchback, detectPatchbackEngine } from "./patchback/index.js";
import { runPatchbackProduceCommand } from "./patchback/produce-cli.js";
import type { ProjectState } from "./services/project-types.js";
import {
  resolveStructureProvider,
  runStructureProvider,
  structureProviderCapabilities,
  type StructureProviderResult,
} from "./structure-export/structure-provider-registry.js";

export async function runPatchCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  switch (args[1]) {
    case "produce":
      runPatchProduce(args, dependencies);
      return;
    case "play":
      await runPlay(args, dependencies);
      return;
  }
  const sourceRoot = requiredFlag(args, "--source");
  const targetRoot = requiredFlag(args, "--target");
  const bundlePath = requiredFlag(args, "--bundle");
  const patchExportPath = optionalFlag(args, "--patch");
  const scope = requiredFlag(args, "--scope");
  if (scope !== "dialogue-only" && scope !== "dialogue+choices") {
    throw new Error(
      `itotori patch: --scope must be 'dialogue-only' or 'dialogue+choices', got '${scope}'`,
    );
  }
  const engine = detectPatchbackEngine(sourceRoot);
  applyEnginePatchback({
    engineId: engine.engineId,
    sourceRoot,
    targetRoot,
    translatedBundlePath: bundlePath,
    ...(patchExportPath !== undefined ? { patchExportPath } : {}),
    scope,
    force: args.includes("--force"),
    ...(dependencies.nativeCli !== undefined ? { nativeCli: dependencies.nativeCli } : {}),
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

function runPatchProduce(args: string[], dependencies: ItotoriCliDependencies): void {
  const scope = requiredFlag(args, "--scope");
  const runId = optionalFlag(args, "--run-id");
  if (scope !== "dialogue-only" && scope !== "dialogue+choices") {
    throw new Error(
      `itotori patch produce: --scope must be 'dialogue-only' or 'dialogue+choices', got '${scope}'`,
    );
  }
  const receipt = runPatchbackProduceCommand({
    inputPath: requiredFlag(args, "--input"),
    outputPath: requiredFlag(args, "--output"),
    sourceRoot: requiredFlag(args, "--source"),
    buildRoot: requiredFlag(args, "--build-root"),
    scope,
    ...(runId === undefined ? {} : { runId }),
    ...(args.includes("--force") ? { force: true } : {}),
    ...(dependencies.nativeCli === undefined ? {} : { nativeCli: dependencies.nativeCli }),
    log: (message) => process.stderr.write(`${message}\n`),
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        capabilityId: receipt.capabilityId,
        patchVersionId: receipt.patch.patchVersionId,
        patchTarget: receipt.patch.artifactRefs.patchTarget,
      },
      null,
      2,
    )}\n`,
  );
}

async function runPlay(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  await dependencies.withServices(async (services) => {
    const playDeps = configuredServicePort(services, "patchPlay");
    if (playDeps === undefined) {
      throw new Error(
        "patch play is not configured in this CLI build (patchPlay port missing — the new-pipeline surface loader + runtime launcher are not installed)",
      );
    }
    await runPlayCommand(args, {
      io: { writeJson: (path, value) => dependencies.io.writeJson(path, value) },
      resolvePlayDeps: () => playDeps,
    });
  });
}

export async function runValidateCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const adapterId = requiredFlag(args, "--engine");
  const registry = createRuntimeLauncherRegistry(
    dependencies.nativeCli === undefined ? {} : { nativeCli: dependencies.nativeCli },
  );
  registry.validate(adapterId, args);
}

export async function runDashboardStatus(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const status = await dependencies.withServices((services) =>
    services.projectWorkflow.getDashboardStatus(),
  );
  dependencies.io.writeJson(outputPath, status);
}

export async function runStructureExportHandler(
  args: string[],
  _dependencies: ItotoriCliDependencies,
): Promise<void> {
  const engine = optionalFlag(args, "--engine");
  if (engine === undefined) {
    throw new Error(
      `structure-export refused: --engine <engine> is required (registered providers: ${structureProviderCapabilities()
        .map((capability) => capability.engine)
        .join(", ")})`,
    );
  }
  const provider = resolveStructureProvider(engine);
  const source = provider.parseCli(args);
  const result: StructureProviderResult = runStructureProvider(source);
  const status = result.execution === "native-process" ? result.process.status : 0;
  process.stdout.write(
    `${JSON.stringify(
      { engine: provider.engine, outputPath: source.outputPath, status },
      null,
      2,
    )}\n`,
  );
}

export async function runLocalize(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  await dependencies.withServices(async (services) => {
    const substrate = configuredServicePort(services, "localizationSubstrate");
    if (substrate === undefined) {
      throw new Error(
        "localize is not configured in this CLI build (localizationSubstrate port missing — the new-pipeline WorkflowPortDeps assemblers are not installed)",
      );
    }
    await runLocalizeCommand(args, {
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      projectWorkflow: services.projectWorkflow,
      resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
      ...(substrate.providerBudgetCohorts === undefined
        ? {}
        : { providerBudgetCohorts: substrate.providerBudgetCohorts }),
    });
  });
}

export async function runLocalizePortfolio(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  await dependencies.withServices(async (services) => {
    const substrate = configuredServicePort(services, "localizationSubstrate");
    if (substrate === undefined) {
      throw new Error(
        "localize-portfolio is not configured in this CLI build (localizationSubstrate port missing — the new-pipeline WorkflowPortDeps assemblers are not installed)",
      );
    }
    await runLocalizePortfolioCommand(args, {
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      projectWorkflow: services.projectWorkflow,
      resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
      ...(substrate.providerBudgetCohorts === undefined
        ? {}
        : { providerBudgetCohorts: substrate.providerBudgetCohorts }),
    });
  });
}

export async function runExtract(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  void dependencies;
  const engineRaw = optionalFlag(args, "--engine");
  if (engineRaw === undefined) {
    const available = extractCapabilities()
      .map((capability) => capability.engine)
      .join(", ");
    throw new Error(
      `extract refused: --engine <engine> is required (registered adapters: ${available})`,
    );
  }
  const adapter = resolveExtractAdapter(engineRaw);
  const source = adapter.parseCli(args);
  const bundleOutputPath = requiredFlag(args, "--bundle-output");
  const result = runKaifuuExtract({
    ...source,
    bundleOutputPath,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        engine: result.engine,
        mode: result.mode,
        bundleOutputPath: result.bundleOutputPath,
        status: result.status,
      },
      null,
      2,
    )}\n`,
  );
}

export async function runIngestRuntime(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const runtimeReportPath = requiredFlag(args, "--runtime-report");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const report = dependencies.io.readJson(runtimeReportPath);
  assertRuntimeEvidenceReportV02(report);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestRuntimeReport(project, report),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.result);
}

type IngestPatchResultDependencies = Pick<ItotoriCliDependencies, "io"> & {
  withServices<T>(
    callback: (services: {
      projectWorkflow: Pick<ItotoriCliServices["projectWorkflow"], "ingestPatchResult">;
    }) => Promise<T>,
  ): Promise<T>;
};

export async function runIngestPatchResult(
  args: string[],
  dependencies: IngestPatchResultDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const patchResultPath = requiredFlag(args, "--patch-result");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const patchResult = dependencies.io.readJson(patchResultPath);
  assertPatchResultV02(patchResult);
  await dependencies.withServices((services) =>
    services.projectWorkflow.ingestPatchResult(project, patchResult),
  );
  dependencies.io.writeJson(outputPath, {
    outcome: "ingested",
    patchResultId: patchResult.patchResultId,
    patchExportId: patchResult.patchExportId,
    status: patchResult.status,
  });
}

export async function runIngestConformance(
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
  if (outputPath !== undefined) dependencies.io.writeJson(outputPath, result.result);
}

function readProject(io: JsonFileStore, path: string): ProjectState {
  const project = io.readJson(path);
  assertProjectState(project);
  return project;
}
