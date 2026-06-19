import {
  assertRuntimeReport,
  assertStyleGuideConversationTranscript,
  type StyleGuideConversationTranscript,
} from "@itotori/localization-bridge-schema";
import { createCatalogResolverFixtureArtifact } from "@itotori/db";
import type {
  CatalogExactExternalIdLinkRequest,
  CatalogFuzzyCandidateRequest,
  CatalogResolverFixtureInput,
  ItotoriCatalogExactExternalIdLinkerPort,
  ItotoriCatalogFuzzyCandidateGeneratorPort,
  StyleGuideFixtureFlowInput,
  StyleGuideFixtureFlowResult,
} from "@itotori/db";
import { assertBridgeInput } from "./api-schema.js";
import type { ManualFeedbackImportPort } from "./manual-feedback.js";
import type { ItotoriProjectWorkflowPort, ProjectState } from "./services/project-workflow.js";

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
    case "export-patch":
      await runExportPatch(args, dependencies);
      break;
    case "ingest-runtime":
      await runIngestRuntime(args, dependencies);
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
    case "style-guide-fixture-flow":
      await runStyleGuideFixtureFlow(args, dependencies);
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
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

function readProject(io: JsonFileStore, path: string): ProjectState {
  return io.readJson(path) as ProjectState;
}
