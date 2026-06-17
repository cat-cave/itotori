import { readFileSync, writeFileSync } from "node:fs";
import {
  ItotoriProjectRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  migrate,
  type ItotoriProjectRecord,
} from "@itotori/db";
import {
  type BridgeBundle,
  type PatchExport,
  assertBridgeBundle,
  assertRuntimeReport,
} from "@itotori/localization-bridge-schema";
import { localUserActor } from "./auth.js";
import { importManualFeedbackWithDatabase } from "./manual-feedback.js";

type ProjectState = ItotoriProjectRecord & { bridge: BridgeBundle };

const args = process.argv.slice(2);
const command = args[0];

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  switch (command) {
    case "db-migrate":
      await migrate(databaseUrlFromEnv());
      break;
    case "db-reset":
      await withRepository((repo) => repo.reset(localUserActor));
      break;
    case "dashboard-status":
      await runDashboardStatus();
      break;
    case "import":
      await runImport();
      break;
    case "draft":
      await runDraft();
      break;
    case "export-patch":
      await runExportPatch();
      break;
    case "ingest-runtime":
      await runIngestRuntime();
      break;
    case "import-feedback":
      await runImportFeedback();
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
}

async function runDashboardStatus(): Promise<void> {
  const outputPath = requiredFlag("--output");
  const status = await withRepository((repo) => repo.getDashboardStatus());
  writeJson(outputPath, status);
}

async function runImport(): Promise<void> {
  const bridgePath = requiredFlag("--bridge");
  const projectPath = requiredFlag("--project");
  const bridge = readJson(bridgePath);
  assertBridgeBundle(bridge);
  const project: ProjectState = {
    projectId: id("project", 1),
    bridge,
    localeBranchId: id("locale", 1),
    targetLocale: "en-US",
    drafts: {},
  };
  writeJson(projectPath, project);
  await withRepository((repo) => repo.importSourceBundle(localUserActor, project));
}

async function runDraft(): Promise<void> {
  const projectPath = requiredFlag("--project");
  const locale = requiredFlag("--locale");
  const project = readProject(projectPath);
  project.targetLocale = locale;
  for (const unit of project.bridge.units) {
    project.drafts[unit.bridgeUnitId] = fakeTranslate(unit.sourceText);
  }
  writeJson(projectPath, project);
  await withRepository((repo) => repo.saveDrafts(localUserActor, project));
}

async function runExportPatch(): Promise<void> {
  const projectPath = requiredFlag("--project");
  const outputPath = requiredFlag("--output");
  const project = readProject(projectPath);
  const entries = project.bridge.units.map((unit, index) => {
    const targetText = project.drafts[unit.bridgeUnitId];
    if (!targetText) {
      throw new Error(`missing draft for ${unit.bridgeUnitId}`);
    }
    for (const span of unit.protectedSpans) {
      if (!targetText.includes(span.raw)) {
        throw new Error(`draft for ${unit.bridgeUnitId} lost protected span ${span.raw}`);
      }
    }
    return {
      entryId: id("entry", index + 1),
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      targetText,
      protectedSpanMappings: unit.protectedSpans.map((span) => ({
        raw: span.raw,
        targetStart: targetText.indexOf(span.raw),
        targetEnd: targetText.indexOf(span.raw) + span.raw.length,
      })),
    };
  });
  const patchExport: PatchExport = {
    schemaVersion: "0.1.0",
    patchExportId: id("patch", 1),
    sourceBridgeId: project.bridge.bridgeId,
    sourceBundleHash: project.bridge.sourceBundleHash,
    sourceLocale: project.bridge.sourceLocale,
    targetLocale: project.targetLocale,
    entries,
  };
  project.patchExport = patchExport;
  writeJson(projectPath, project);
  writeJson(outputPath, patchExport);
  await withRepository((repo) => repo.savePatchExport(localUserActor, project, patchExport));
}

async function runIngestRuntime(): Promise<void> {
  const projectPath = requiredFlag("--project");
  const runtimeReportPath = requiredFlag("--runtime-report");
  const outputPath = requiredFlag("--output");
  const project = readProject(projectPath);
  const report = readJson(runtimeReportPath);
  assertRuntimeReport(report);
  project.runtimeReport = report;
  const dashboard = await withRepository((repo) =>
    repo.saveRuntimeReport(localUserActor, project, report, id("patch-result", 1)),
  );
  writeJson(projectPath, project);
  writeJson(outputPath, {
    status: "hello_world_passed",
    bridgeId: project.bridge.bridgeId,
    localeBranchId: project.localeBranchId,
    patchExportId: project.patchExport?.patchExportId,
    patchResultId: id("patch-result", 1),
    runtimeReportId: report.runtimeReportId,
    dashboard,
  });
}

async function runImportFeedback(): Promise<void> {
  const feedbackPath = requiredFlag("--feedback");
  const outputPath = requiredFlag("--output");
  const feedback = readJson(feedbackPath);
  const result = await importManualFeedbackWithDatabase(feedback);
  writeJson(outputPath, result);
}

function fakeTranslate(sourceText: string): string {
  if (sourceText === "こんにちは、{player}。") {
    return "Hello, {player}.";
  }
  return `[en-US] ${sourceText}`;
}

function requiredFlag(name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) {
    throw new Error(`missing required flag ${name}`);
  }
  return value;
}

function readProject(path: string): ProjectState {
  return readJson(path) as ProjectState;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withRepository<T>(
  fn: (repository: ItotoriProjectRepository) => Promise<T>,
): Promise<T> {
  const context = createDatabaseContext();
  try {
    await bootstrapLocalUser(context.db);
    return await fn(new ItotoriProjectRepository(context.db));
  } finally {
    await context.close();
  }
}

function id(kind: string, n: number): string {
  return `019ed000-0000-7000-8000-${kind.replaceAll("-", "").padEnd(8, "0").slice(0, 8)}${String(n).padStart(4, "0")}`;
}
