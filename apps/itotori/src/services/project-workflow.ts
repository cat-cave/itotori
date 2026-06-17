import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  ItotoriModelLedgerRepositoryPort,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProviderRunLedgerInput,
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
import {
  ModelProviderError,
  type JsonObject,
  type ModelInvocationResult,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunRecord,
  createProviderRunId,
} from "../providers/types.js";

export type ProjectState = ItotoriProjectRecord;
export type RuntimeReportInput = RuntimeVerificationReport | RuntimeEvidenceReportV02;

export type RuntimeIngestResult = {
  status: "hello_world_passed" | "hello_world_failed";
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
  getCostReport(projectId?: string): Promise<ProjectCostReport>;
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
    private readonly modelLedger?: ItotoriModelLedgerRepositoryPort,
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

  async getCostReport(projectId?: string): Promise<ProjectCostReport> {
    if (!this.modelLedger) {
      return emptyCostReport(projectId ?? "unknown");
    }
    return await this.modelLedger.getProjectCostReport(projectId);
  }

  async importBridge(bridge: BridgeBundle | BridgeBundleV02): Promise<ProjectState> {
    const project: ProjectState = {
      projectId: id("project", 1),
      bridge,
      localeBranchId: id("locale", 1),
      targetLocale: "en-US",
      drafts: {},
    };
    const importStatus = await this.repository.importSourceBundle(this.actor, project);
    return { ...project, importStatus };
  }

  async draftProject(project: ProjectState, locale: string): Promise<ProjectState> {
    const nextProject: ProjectState = {
      ...project,
      targetLocale: locale,
      drafts: { ...project.drafts },
    };
    for (const unit of nextProject.bridge.units) {
      const prompt = draftPromptPreset();
      const request: ModelInvocationRequest = {
        taskKind: "draft_translation",
        modelId: this.draftModelProvider.descriptor.defaultModelId,
        inputClassification: "private_corpus",
        prompt,
        messages: [
          {
            role: "system",
            content: draftPromptSystemMessage,
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
      };
      let result: ModelInvocationResult;
      const invocationStartedAt = new Date();
      try {
        result = await this.draftModelProvider.invoke(request);
      } catch (error) {
        await this.recordProviderFailure(nextProject, request, invocationStartedAt, error);
        throw error;
      }
      if (result.content === null) {
        const failedRun = failedProviderRunFromRun(result.providerRun, "provider_response_invalid");
        const error = new ModelProviderError(
          `draft provider returned no text for ${unit.bridgeUnitId}`,
          "provider_response_invalid",
          false,
          failedRun,
          result.adapterMetadata,
        );
        await this.recordProviderFailure(nextProject, request, invocationStartedAt, error);
        throw error;
      }
      await this.recordProviderRun(nextProject, result);
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
        protectedSpanMappings: protectedSpanMappingsForTarget(unit, targetText),
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
    const patchResultId = patchResultIdForRuntimeReport(runtimeReport);
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
        status: runtimeReport.status === "passed" ? "hello_world_passed" : "hello_world_failed",
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
    for (const providerRun of report.providerModelCostRecords) {
      await this.modelLedger?.recordProviderRun(
        this.actor,
        providerRunLedgerInputFromBenchmark(
          projectId,
          input.localeBranchId,
          report.benchmarkRunId,
          providerRun,
        ),
      );
    }
    return {
      benchmarkRunId: report.benchmarkRunId,
      artifactId: report.benchmarkRunId,
      status: report.status,
      systemCount: report.systemsCompared.length,
      findingCount: report.findingRecords.length,
    };
  }

  private async recordProviderRun(
    project: ProjectState,
    result: ModelInvocationResult,
  ): Promise<void> {
    if (!this.modelLedger) {
      return;
    }
    await this.modelLedger.recordProviderRun(
      this.actor,
      providerRunLedgerInputFromRun(project, result.providerRun, result.adapterMetadata),
    );
  }

  private async recordProviderFailure(
    project: ProjectState,
    request: ModelInvocationRequest,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    if (!this.modelLedger) {
      return;
    }
    const providerRun =
      error instanceof ModelProviderError && error.providerRun !== undefined
        ? error.providerRun
        : failedProviderRunFromRequest({
            descriptor: this.draftModelProvider.descriptor,
            request,
            startedAt,
            error,
          });
    const adapterMetadata = error instanceof ModelProviderError ? error.adapterMetadata : undefined;
    await this.modelLedger.recordProviderRun(
      this.actor,
      providerRunLedgerInputFromRun(project, providerRun, adapterMetadata),
    );
  }
}

const draftPromptSystemMessage =
  "Draft a localized target string. Preserve protected spans exactly and return only the target text.";

function draftPromptPreset() {
  const configSnapshot = {
    schemaVersion: "itotori.prompt-preset.v0",
    presetId: "itotori-draft-default-v1",
    templateVersion: "1.0.0",
    messages: [
      {
        role: "system",
        content: draftPromptSystemMessage,
      },
      {
        role: "user",
        contentTemplate:
          '{"sourceLocale":string,"targetLocale":string,"sourceText":string,"protectedSpans":string[]}',
      },
    ],
  } satisfies JsonObject;
  return {
    presetId: "itotori-draft-default-v1",
    templateVersion: "1.0.0",
    promptHash: hashJson(configSnapshot),
    schemaVersion: "itotori.prompt-preset.v0",
    configSnapshot,
  };
}

function failedProviderRunFromRun(run: ProviderRunRecord, errorClass: string): ProviderRunRecord {
  return {
    ...run,
    status: "failed",
    errorClasses: Array.from(new Set([...run.errorClasses, errorClass])),
    cost: {
      costKind: "unknown",
      currency: "USD",
    },
  };
}

function failedProviderRunFromRequest(input: {
  descriptor: ModelProvider["descriptor"];
  request: ModelInvocationRequest;
  startedAt: Date;
  error: unknown;
}): ProviderRunRecord {
  const completedAt = new Date();
  const requestedModelId = input.request.modelId ?? input.descriptor.defaultModelId;
  const fallbackPlan = fallbackPlanForRequest(input.request, requestedModelId);
  const run: ProviderRunRecord = {
    runId: input.request.runId ?? createProviderRunId(input.descriptor.family),
    taskKind: input.request.taskKind,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    latencyMs: completedAt.getTime() - input.startedAt.getTime(),
    status: "failed",
    provider: {
      providerFamily: input.descriptor.family,
      endpointFamily: input.descriptor.endpointFamily,
      providerName: input.descriptor.providerName,
      requestedModelId,
      actualModelId: requestedModelId,
    },
    structuredOutputMode: input.request.structuredOutput?.mode ?? "none",
    retryCount: 0,
    errorClasses: [providerFailureClass(input.error)],
    fallbackUsed: false,
    fallbackPlan,
    tokenUsage: {
      tokenCountSource: "unknown",
    },
    cost: {
      costKind: "unknown",
      currency: "USD",
    },
    prompt: input.request.prompt,
    dataHandling: input.descriptor.capabilities.dataHandling,
  };
  if (input.request.preset) {
    run.providerPreset = input.request.preset;
  }
  if (input.descriptor.capabilities.accountPrivacy) {
    run.accountPrivacy = input.descriptor.capabilities.accountPrivacy;
  }
  return run;
}

function providerFailureClass(error: unknown): string {
  if (error instanceof ModelProviderError) {
    return error.code;
  }
  return "provider_invocation_error";
}

function fallbackPlanForRequest(
  request: ModelInvocationRequest,
  requestedModelId: string,
): string[] {
  return Array.from(new Set([requestedModelId, ...(request.fallbackModels ?? [])]));
}

function providerRunLedgerInputFromRun(
  project: ProjectState,
  run: ProviderRunRecord,
  adapterMetadata: JsonObject | undefined,
): ProviderRunLedgerInput {
  const prompt: ProviderRunLedgerInput["prompt"] = {
    promptPresetId: run.prompt.presetId,
    promptTemplateVersion: run.prompt.templateVersion,
    promptHash: run.prompt.promptHash,
  };
  if (run.prompt.schemaVersion !== undefined) {
    prompt.presetSchemaVersion = run.prompt.schemaVersion;
  }
  if (run.prompt.configSnapshot !== undefined) {
    prompt.configSnapshot = run.prompt.configSnapshot;
  }
  return {
    providerRunId: run.runId,
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    taskKind: run.taskKind,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    latencyMs: run.latencyMs,
    status: run.status,
    provider: run.provider,
    prompt,
    structuredOutputMode: run.structuredOutputMode,
    retryCount: run.retryCount,
    errorClasses: run.errorClasses,
    fallbackUsed: run.fallbackUsed,
    fallbackPlan: run.fallbackPlan,
    tokenUsage: run.tokenUsage,
    cost: run.cost,
    dataHandling: run.dataHandling,
    ...(run.providerPreset === undefined ? {} : { providerPreset: run.providerPreset }),
    ...(run.accountPrivacy === undefined ? {} : { accountPrivacy: run.accountPrivacy }),
    ...(adapterMetadata === undefined ? {} : { adapterMetadata }),
  };
}

function providerRunLedgerInputFromBenchmark(
  projectId: string,
  localeBranchId: string | undefined,
  benchmarkRunId: string,
  providerRun: BenchmarkReportV02["providerModelCostRecords"][number],
): ProviderRunLedgerInput {
  const completedAt = requiredString(
    providerRun.completedAt,
    "providerModelCostRecords.completedAt",
  );
  const latencyMs = requiredNumber(providerRun.latencyMs, "providerModelCostRecords.latencyMs");
  const promptHash =
    providerRun.prompt.promptHash ??
    hashJson({
      source: "benchmark_report",
      benchmarkRunId,
      promptPresetId: providerRun.prompt.promptPresetId,
      promptTemplateVersion: providerRun.prompt.promptTemplateVersion,
    });
  const providerPreset = providerPresetFromBenchmarkPrompt(providerRun.prompt);
  return {
    providerRunId: providerRun.providerRunId,
    projectId,
    ...(localeBranchId === undefined ? {} : { localeBranchId }),
    systemId: providerRun.systemId,
    taskKind: providerRun.taskKind,
    startedAt: providerRun.startedAt,
    completedAt,
    latencyMs,
    status: providerRun.status,
    provider: providerRun.provider,
    prompt: {
      promptPresetId: providerRun.prompt.promptPresetId,
      promptTemplateVersion: providerRun.prompt.promptTemplateVersion,
      promptHash,
      presetSchemaVersion: "benchmark-report-v0.2",
      configSnapshot: {
        source: "benchmark_report",
        benchmarkRunId,
        systemId: providerRun.systemId,
      },
    },
    structuredOutputMode: providerRun.structuredOutputMode,
    retryCount: providerRun.retryCount,
    errorClasses: providerRun.errorClasses,
    fallbackUsed: providerRun.fallbackUsed,
    fallbackPlan: providerRun.fallbackPlan ?? [],
    tokenUsage: providerRun.tokenUsage,
    cost: providerRun.cost,
    dataHandling: {},
    ...(providerPreset === undefined ? {} : { providerPreset }),
    adapterMetadata: {
      source: "benchmark_report",
      routeSettingsHash: providerRun.provider.routeSettingsHash ?? null,
    },
  };
}

function providerPresetFromBenchmarkPrompt(
  prompt: BenchmarkReportV02["providerModelCostRecords"][number]["prompt"],
): ProviderRunLedgerInput["providerPreset"] | undefined {
  if (
    prompt.remotePresetSlug === undefined &&
    prompt.remotePresetVersion === undefined &&
    prompt.remotePresetConfigHash === undefined
  ) {
    return undefined;
  }
  return {
    slug: prompt.remotePresetSlug ?? "unknown",
    ...(prompt.remotePresetVersion === undefined ? {} : { version: prompt.remotePresetVersion }),
    ...(prompt.remotePresetConfigHash === undefined
      ? {}
      : { configHash: prompt.remotePresetConfigHash }),
    configSnapshot: {
      source: "benchmark_report",
      remotePresetSlug: prompt.remotePresetSlug ?? null,
      remotePresetVersion: prompt.remotePresetVersion ?? null,
      remotePresetConfigHash: prompt.remotePresetConfigHash ?? null,
    },
  };
}

function hashJson(value: JsonObject): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function emptyCostReport(projectId: string): ProjectCostReport {
  return {
    projectId,
    currency: "USD",
    runCount: 0,
    billedMicrosUsd: 0,
    estimatedMicrosUsd: 0,
    zeroRunCount: 0,
    unknownRunCount: 0,
    includesUnknownCost: false,
    totalsByCostKind: ["billed", "provider_estimate", "local_estimate", "zero", "unknown"].map(
      (costKind) => ({
        costKind: costKind as ProjectCostReport["totalsByCostKind"][number]["costKind"],
        runCount: 0,
        amountMicrosUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
    ),
    recentRuns: [],
  };
}

function id(kind: string, n: number): string {
  return `019ed000-0000-7000-8000-${kind.replaceAll("-", "").padEnd(8, "0").slice(0, 8)}${String(n).padStart(4, "0")}`;
}

function patchResultIdForRuntimeReport(runtimeReport: RuntimeReportInput): string {
  return `${runtimeReport.runtimeReportId}:patch-result`;
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

function protectedSpanMappingsForTarget(
  unit: BridgeUnit,
  targetText: string,
): PatchExport["entries"][number]["protectedSpanMappings"] {
  let searchStart = 0;
  return unit.protectedSpans.map((span) => {
    const targetStartCodeUnit = targetText.indexOf(span.raw, searchStart);
    if (targetStartCodeUnit < 0) {
      throw new Error(`draft for ${unit.bridgeUnitId} lost protected span ${span.raw}`);
    }
    const targetEndCodeUnit = targetStartCodeUnit + span.raw.length;
    searchStart = targetEndCodeUnit;
    return {
      raw: span.raw,
      targetStart: utf8ByteLength(targetText.slice(0, targetStartCodeUnit)),
      targetEnd: utf8ByteLength(targetText.slice(0, targetEndCodeUnit)),
    };
  });
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
