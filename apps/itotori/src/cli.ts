import { readFileSync, writeFileSync } from "node:fs";
import {
  type BridgeBundle,
  type PatchExport,
  type RuntimeVerificationReport,
  assertBridgeBundle,
  assertRuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";

type ProjectState = {
  projectId: string;
  bridge: BridgeBundle;
  localeBranchId: string;
  targetLocale: string;
  drafts: Record<string, string>;
  patchExport?: PatchExport;
  runtimeReport?: RuntimeVerificationReport;
};

const args = process.argv.slice(2);
const command = args[0];

try {
  switch (command) {
    case "import":
      runImport();
      break;
    case "draft":
      runDraft();
      break;
    case "export-patch":
      runExportPatch();
      break;
    case "ingest-runtime":
      runIngestRuntime();
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function runImport(): void {
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
}

function runDraft(): void {
  const projectPath = requiredFlag("--project");
  const locale = requiredFlag("--locale");
  const project = readProject(projectPath);
  project.targetLocale = locale;
  for (const unit of project.bridge.units) {
    project.drafts[unit.bridgeUnitId] = fakeTranslate(unit.sourceText);
  }
  writeJson(projectPath, project);
}

function runExportPatch(): void {
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
}

function runIngestRuntime(): void {
  const projectPath = requiredFlag("--project");
  const runtimeReportPath = requiredFlag("--runtime-report");
  const outputPath = requiredFlag("--output");
  const project = readProject(projectPath);
  const report = readJson(runtimeReportPath);
  assertRuntimeVerificationReport(report);
  project.runtimeReport = report;
  writeJson(projectPath, project);
  writeJson(outputPath, {
    status: "hello_world_passed",
    bridgeId: project.bridge.bridgeId,
    localeBranchId: project.localeBranchId,
    patchExportId: project.patchExport?.patchExportId,
    patchResultId: id("patch-result", 1),
    runtimeReportId: report.runtimeReportId,
  });
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

function id(kind: string, n: number): string {
  return `019ed000-0000-7000-8000-${kind.replaceAll("-", "").padEnd(8, "0").slice(0, 8)}${String(n).padStart(4, "0")}`;
}
