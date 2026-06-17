import { assertBridgeBundle, assertRuntimeReport } from "@itotori/localization-bridge-schema";
import type { ManualFeedbackImportPort } from "./manual-feedback.js";
import type { ItotoriProjectWorkflowPort, ProjectState } from "./services/project-workflow.js";

export type JsonFileStore = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type ItotoriCliServices = {
  projectWorkflow: ItotoriProjectWorkflowPort;
  manualFeedback: ManualFeedbackImportPort;
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
  assertBridgeBundle(bridge);
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

function requiredFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) {
    throw new Error(`missing required flag ${name}`);
  }
  return value;
}

function readProject(io: JsonFileStore, path: string): ProjectState {
  return io.readJson(path) as ProjectState;
}
