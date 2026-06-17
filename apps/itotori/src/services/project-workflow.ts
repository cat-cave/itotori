import type {
  AuthorizationActor,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeUnit,
  BridgeBundle,
  BridgeBundleV02,
  LocalizationUnitV02,
  FindingRecordV02,
  PatchExport,
  RuntimeEvidenceReportV02,
  RuntimeVerificationReport,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
import { FakeModelProvider } from "../providers/fake.js";
import type { ModelProvider } from "../providers/types.js";

export type ProjectState = ItotoriProjectRecord;
export type RuntimeReportInput = RuntimeVerificationReport | RuntimeEvidenceReportV02;

export type RuntimeIngestResult = {
  status: "hello_world_passed";
  bridgeId: string;
  localeBranchId: string;
  patchExportId: string | undefined;
  patchResultId: string;
  runtimeReportId: string;
  dashboard: ProjectDashboardStatus;
};

export type FindingRecordResult = {
  findingId: string;
  status: "open" | "resolved" | "superseded";
};

export type DecisionRecordResult = {
  decisionId: string;
  eventKind: TriageEventV02["eventKind"];
  recorded: boolean;
};

export type BenchmarkRecordResult = {
  benchmarkRunId: string;
  artifactId: string;
  status: BenchmarkReportV02["status"];
  systemCount: number;
  findingCount: number;
};

export interface ItotoriProjectWorkflowPort {
  reset(): Promise<void>;
  getDashboardStatus(): Promise<ProjectDashboardStatus>;
  getRuntimeStatus(): Promise<RuntimeDashboardStatus>;
  importBridge(bridge: BridgeBundle | BridgeBundleV02): Promise<ProjectState>;
  draftProject(project: ProjectState, locale: string): Promise<ProjectState>;
  exportPatch(project: ProjectState): Promise<{
    project: ProjectState;
    patchExport: PatchExport;
  }>;
  ingestRuntimeReport(
    project: ProjectState,
    runtimeReport: RuntimeReportInput,
  ): Promise<{
    project: ProjectState;
    result: RuntimeIngestResult;
  }>;
  recordFinding(
    projectId: string,
    input: {
      localeBranchId?: string;
      finding: FindingRecordV02;
      status?: "open" | "resolved" | "superseded";
    },
  ): Promise<FindingRecordResult>;
  recordDecision(
    projectId: string,
    input: { localeBranchId?: string; event: TriageEventV02 },
  ): Promise<DecisionRecordResult>;
  recordBenchmarkReport(
    projectId: string,
    input: { localeBranchId?: string; benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult>;
}

export class ItotoriProjectWorkflowService implements ItotoriProjectWorkflowPort {
  constructor(
    private readonly repository: ItotoriProjectRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly draftModelProvider: ModelProvider = new FakeModelProvider(),
  ) {}

  async reset(): Promise<void> {
    await this.repository.reset(this.actor);
  }

  async getDashboardStatus(): Promise<ProjectDashboardStatus> {
    return await this.repository.getDashboardStatus();
  }

  async getRuntimeStatus(): Promise<RuntimeDashboardStatus> {
    return await this.repository.getRuntimeStatus();
  }

  async importBridge(bridge: BridgeBundle | BridgeBundleV02): Promise<ProjectState> {
    const project: ProjectState = {
      projectId: id("project", 1),
      bridge,
      localeBranchId: id("locale", 1),
      targetLocale: "en-US",
      drafts: {},
    };
    await this.repository.importSourceBundle(this.actor, project);
    return project;
  }

  async draftProject(project: ProjectState, locale: string): Promise<ProjectState> {
    const nextProject: ProjectState = {
      ...project,
      targetLocale: locale,
      drafts: { ...project.drafts },
    };
    for (const unit of nextProject.bridge.units) {
      const result = await this.draftModelProvider.invoke({
        taskKind: "draft_translation",
        modelId: this.draftModelProvider.descriptor.defaultModelId,
        inputClassification: "private_corpus",
        messages: [
          {
            role: "system",
            content:
              "Draft a localized target string. Preserve protected spans exactly and return only the target text.",
          },
          {
            role: "user",
            content: JSON.stringify({
              sourceLocale: unit.sourceLocale,
              targetLocale: locale,
              sourceText: unit.sourceText,
              protectedSpans: protectedSpanRaws(unit),
            }),
          },
        ],
      });
      if (result.content === null) {
        throw new Error(`draft provider returned no text for ${unit.bridgeUnitId}`);
      }
      nextProject.drafts[unit.bridgeUnitId] = result.content;
    }
    await this.repository.saveDrafts(this.actor, nextProject);
    return nextProject;
  }

  async exportPatch(project: ProjectState): Promise<{
    project: ProjectState;
    patchExport: PatchExport;
  }> {
    if (isBridgeBundleV02(project.bridge)) {
      throw new Error("v0.2 patch export is not supported by the deterministic local exporter");
    }
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
    const nextProject: ProjectState = { ...project, patchExport };
    await this.repository.savePatchExport(this.actor, nextProject, patchExport);
    return { project: nextProject, patchExport };
  }

  async ingestRuntimeReport(
    project: ProjectState,
    runtimeReport: RuntimeReportInput,
  ): Promise<{
    project: ProjectState;
    result: RuntimeIngestResult;
  }> {
    const patchResultId = id("patch-result", 1);
    const nextProject: ProjectState = { ...project, runtimeReport };
    const dashboard = await this.repository.saveRuntimeReport(
      this.actor,
      nextProject,
      runtimeReport,
      patchResultId,
    );
    return {
      project: nextProject,
      result: {
        status: "hello_world_passed",
        bridgeId: nextProject.bridge.bridgeId,
        localeBranchId: nextProject.localeBranchId,
        patchExportId: nextProject.patchExport?.patchExportId,
        patchResultId,
        runtimeReportId: runtimeReport.runtimeReportId,
        dashboard,
      },
    };
  }

  async recordFinding(
    projectId: string,
    input: {
      localeBranchId?: string;
      finding: FindingRecordV02;
      status?: "open" | "resolved" | "superseded";
    },
  ): Promise<FindingRecordResult> {
    const findingInput = {
      projectId,
      finding: input.finding,
    };
    await this.repository.recordFinding(this.actor, {
      ...findingInput,
      ...(input.localeBranchId === undefined ? {} : { localeBranchId: input.localeBranchId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return {
      findingId: input.finding.findingId,
      status: input.status ?? "open",
    };
  }

  async recordDecision(
    projectId: string,
    input: { localeBranchId?: string; event: TriageEventV02 },
  ): Promise<DecisionRecordResult> {
    await this.repository.appendEvent(this.actor, {
      projectId,
      event: input.event,
      ...(input.localeBranchId === undefined ? {} : { localeBranchId: input.localeBranchId }),
    });
    return {
      decisionId: input.event.eventId,
      eventKind: input.event.eventKind,
      recorded: true,
    };
  }

  async recordBenchmarkReport(
    projectId: string,
    input: { localeBranchId?: string; benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult> {
    const report = input.benchmarkReport;
    await this.repository.linkArtifact(this.actor, {
      artifactId: report.benchmarkRunId,
      projectId,
      artifactKind: "benchmark_report",
      metadata: {
        schemaVersion: report.schemaVersion,
        benchmarkName: report.benchmarkName,
        status: report.status,
        sourceLocale: report.sourceLocale,
        targetLocale: report.targetLocale,
        systemCount: report.systemsCompared.length,
        findingCount: report.findingRecords.length,
        penaltyTotal: report.penaltySummary.penaltyTotal,
      },
      ...(input.localeBranchId === undefined ? {} : { localeBranchId: input.localeBranchId }),
    });
    return {
      benchmarkRunId: report.benchmarkRunId,
      artifactId: report.benchmarkRunId,
      status: report.status,
      systemCount: report.systemsCompared.length,
      findingCount: report.findingRecords.length,
    };
  }
}

function id(kind: string, n: number): string {
  return `019ed000-0000-7000-8000-${kind.replaceAll("-", "").padEnd(8, "0").slice(0, 8)}${String(n).padStart(4, "0")}`;
}

function isBridgeBundleV02(bridge: BridgeBundle | BridgeBundleV02): bridge is BridgeBundleV02 {
  return bridge.schemaVersion === "0.2.0";
}

function protectedSpanRaws(unit: BridgeUnit | LocalizationUnitV02): string[] {
  if ("spans" in unit) {
    return unit.spans.map((span) => span.raw);
  }
  return unit.protectedSpans.map((span) => span.raw);
}
