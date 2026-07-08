import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriConformanceRepositoryPort,
  ItotoriLocalizationPassLedgerRepositoryPort,
  ItotoriModelLedgerRepositoryPort,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ItotoriTranslationMemoryService,
  LocaleBranchIdentity,
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
  ConformanceManifestV01,
  ConformanceResultV01,
  FindingRecordV02,
  PatchExport,
  PatchResultStatusV02,
  PatchResultV02,
  RuntimeEvidenceReportV02,
  RuntimeVerificationReport,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
import {
  assertConformanceManifestResultJoinV01,
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertNormalizedSurfacePreservesIdentity,
  ConformanceIngestionError,
  computePatchResultOutputHashRollupV02,
  normalizeBridgeSurface,
  normalizedProtectedSpanRaws,
} from "@itotori/localization-bridge-schema";
import { assertProviderInvocationSupported } from "../providers/capability-guard.js";
import { summarizeBenchmarkReportMetadata } from "../benchmark-report-summary.js";
import {
  ModelProviderError,
  type JsonObject,
  type ModelInvocationResult,
  type ModelInvocationRequest,
  type ModelProvider,
  type ProviderRunRecord,
  createProviderRunId,
  localOnlyRoutingPosture,
} from "../providers/types.js";
import {
  DeterministicPreExportQaError,
  runDeterministicPreExportQa,
} from "./deterministic-pre-export-qa.js";
import {
  composeProjectOverviewReadModel,
  type ProjectOverviewReadModel,
  type ProjectOverviewReadModelOptions,
} from "../project-overview-read-model.js";

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

export type PatchResultIngestionDiagnostic = {
  code: string;
  message: string;
  pointer?: string;
};

export type PatchResultIngestionResult = {
  patchResultId: string;
  patchExportId: string;
  status: PatchResultStatusV02;
  diagnostics: PatchResultIngestionDiagnostic[];
};

export type ConformanceIngestInput = {
  manifest?: ConformanceManifestV01;
  results: ConformanceResultV01[];
  reportArtifactId?: string;
  manifestArtifactId?: string;
};

export type ConformanceIngestOutcomeCounts = {
  passCount: number;
  failCount: number;
  skipCount: number;
  unsupportedCount: number;
  resultCount: number;
};

export type ConformanceIngestResult = {
  conformanceRunId: string;
  adapterId: string;
  schemaVersion: string;
  manifestFidelityTier: string | null;
  counts: ConformanceIngestOutcomeCounts;
  resultIds: string[];
  results: Array<{
    conformanceResultId: string;
    profileId: ConformanceResultV01["profileId"];
    outcomeKind: ConformanceResultV01["outcome"]["kind"];
    passEvidenceTier: string | null;
    semanticCode: string | null;
  }>;
};

/**
 * itotori-purge-fakemodelprovider-from-production — the DB-backed draft
 * workflow (`projects.draft` HTTP route + CLI `draft`) MUST draft with a
 * REAL model provider whose cost is read from the live call. Per the
 * strict-proof rule "fakes and mocks ONLY belong in tests, NEVER in real
 * code", the service no longer defaults to a zero-cost FakeModelProvider.
 * When the production wiring has no real provider configured, `draftProject`
 * refuses LOUDLY with this typed error rather than silently drafting a fake,
 * zero-cost translation. Tests inject an explicit test double.
 */
export class DraftProviderNotConfiguredError extends Error {
  constructor() {
    super(
      "draftProject refused: no real model provider is configured for the draft workflow. " +
        "The production draft path must inject a live OpenRouterModelProvider (real call, real cost); " +
        "refusing to draft with a fake, zero-cost provider. Tests must inject an explicit test double.",
    );
    this.name = "DraftProviderNotConfiguredError";
  }
}

export class PatchResultIngestionError extends Error {
  constructor(
    readonly diagnostic: PatchResultIngestionDiagnostic,
    readonly diagnostics: PatchResultIngestionDiagnostic[],
  ) {
    super(`patch result ingestion rejected: ${diagnostic.code} ${diagnostic.message}`);
    this.name = "PatchResultIngestionError";
  }
}

export interface ItotoriProjectWorkflowPort {
  reset(): Promise<void>;
  /**
   * ITOTORI-050 — the server-side project/branch ownership lookup. Returns the
   * locale branches the DB attributes to `projectId` (read-only). Project
   * mutation routes consume this to derive the authoritative branch scope
   * server-side rather than trusting a client-supplied ProjectState / branch
   * id. See `services/project-mutation-scope.ts`.
   */
  listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]>;
  getDashboardStatus(): Promise<ProjectDashboardStatus>;
  getRuntimeStatus(runtimeRunId?: string): Promise<RuntimeDashboardStatus>;
  getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel>;
  getProjectOverview(options?: ProjectOverviewReadModelOptions): Promise<ProjectOverviewReadModel>;
  getCostReport(projectId?: string): Promise<ProjectCostReport>;
  getCostDrilldown(filter?: CostDrilldownFilter): Promise<CostDrilldownPage>;
  getBenchmarkReports(projectId?: string): Promise<BenchmarkReportSummary[]>;
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
  ingestPatchResult(
    project: ProjectState,
    patchResult: PatchResultV02,
  ): Promise<{
    project: ProjectState;
    result: PatchResultIngestionResult;
  }>;
  ingestConformanceReport(
    project: ProjectState,
    input: ConformanceIngestInput,
  ): Promise<{
    project: ProjectState;
    result: ConformanceIngestResult;
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
    input: { benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult>;
}

export class ItotoriProjectWorkflowService implements ItotoriProjectWorkflowPort {
  constructor(
    private readonly repository: ItotoriProjectRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly draftModelProvider?: ModelProvider,
    private readonly modelLedger?: ItotoriModelLedgerRepositoryPort,
    private readonly translationMemory?: Pick<ItotoriTranslationMemoryService, "prefillDrafts">,
    private readonly conformanceRepository?: ItotoriConformanceRepositoryPort,
    private readonly passLedger?: ItotoriLocalizationPassLedgerRepositoryPort,
  ) {}

  async reset(): Promise<void> {
    await this.repository.reset(this.actor);
  }

  async listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]> {
    // ITOTORI-050 — server-side project/branch ownership lookup. Delegates to
    // the repository's `where project_id = <projectId>` read; the returned set
    // is the authoritative scope a project mutation may target.
    return await this.repository.listLocaleBranchIdentities(projectId);
  }

  async getDashboardStatus(): Promise<ProjectDashboardStatus> {
    return await this.repository.getDashboardStatus();
  }

  async getRuntimeStatus(runtimeRunId?: string): Promise<RuntimeDashboardStatus> {
    // gate-runtime-status-reads-and-redact-evidence-previews — thread the
    // workflow actor into the repository read so the repository-layer
    // permission gate enforces the privileged runtime report even for this
    // internal caller (defense in depth). The HTTP handler additionally
    // redacts the evidence previews / finding text / artifact URIs for
    // unprivileged callers, but the actor check lives where the data is read.
    return await this.repository.getRuntimeStatus(this.actor, runtimeRunId);
  }

  async getDashboardDecisions(projectId?: string): Promise<DashboardDecisionReadModel> {
    return await this.repository.getDashboardDecisions(projectId);
  }

  async getProjectOverview(
    options: ProjectOverviewReadModelOptions = {},
  ): Promise<ProjectOverviewReadModel> {
    // P2 — scope the dashboard status to the SAME target project as every
    // other composed piece. `getDashboardStatus()` with no argument returns the
    // globally-latest project, which would splice ANOTHER project's progress +
    // locale-branch set (the set that scopes the pass ledger) into this
    // overview. Passing the requested projectId keeps the whole payload
    // single-project.
    const requestedProjectId = options.projectId;
    const status = await this.repository.getDashboardStatus(requestedProjectId);
    const projectId = requestedProjectId ?? status.projectId;
    const costDrilldownFilter: CostDrilldownFilter = {
      ...options.costDrilldown,
      ...(options.projectId !== undefined && options.costDrilldown?.projectId === undefined
        ? { projectId }
        : {}),
    };
    const [decisions, cost, costDrilldown, benchmarkReports] = await Promise.all([
      this.getDashboardDecisions(projectId),
      this.getCostReport(projectId),
      this.getCostDrilldown(costDrilldownFilter),
      this.getBenchmarkReports(projectId),
    ]);
    return await composeProjectOverviewReadModel({
      actor: this.actor,
      status,
      decisions,
      cost,
      costDrilldown,
      benchmarkReports,
      ...(this.passLedger !== undefined ? { passLedgerRepository: this.passLedger } : {}),
      options: { ...options, projectId },
    });
  }

  async getCostReport(projectId?: string): Promise<ProjectCostReport> {
    if (!this.modelLedger) {
      return emptyCostReport(projectId ?? "unknown");
    }
    // gate-project-status-and-cost-reads — thread the workflow actor into
    // the ledger read so the repository-layer permission gate enforces the
    // privileged cost report even for this internal caller (defense in
    // depth). The HTTP handler additionally redacts for unprivileged
    // callers, but the actor check lives where the data is read.
    return await this.modelLedger.getProjectCostReport(this.actor, projectId);
  }

  async getCostDrilldown(filter: CostDrilldownFilter = {}): Promise<CostDrilldownPage> {
    if (!this.modelLedger) {
      return emptyCostDrilldown(filter);
    }
    // gate-project-status-and-cost-reads — thread the workflow actor into the
    // ledger read so the repository-layer permission gate enforces the
    // privileged drilldown (provider/adapter metadata + run ledger) even for
    // this internal caller. The HTTP handler additionally redacts for
    // unprivileged callers.
    return await this.modelLedger.getCostLedgerDrilldown(this.actor, filter);
  }

  async getBenchmarkReports(projectId?: string): Promise<BenchmarkReportSummary[]> {
    const targetProjectId = projectId ?? (await this.repository.getDashboardStatus()).projectId;
    return await this.repository.listBenchmarkReports(targetProjectId);
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
    // itotori-purge-fakemodelprovider-from-production — refuse LOUDLY when no
    // real provider is wired rather than silently drafting a zero-cost fake.
    const provider = this.draftModelProvider;
    if (provider === undefined) {
      throw new DraftProviderNotConfiguredError();
    }
    const nextProject: ProjectState = {
      ...project,
      targetLocale: locale,
      drafts: { ...project.drafts },
    };
    const reusedDraftUnitIds = await this.prefillTranslationMemoryDrafts(nextProject, locale);
    for (const unit of nextProject.bridge.units) {
      if (reusedDraftUnitIds.has(unit.bridgeUnitId)) {
        continue;
      }
      const prompt = draftPromptPreset();
      // SHARED-020 — normalize the unit's surface through the shared,
      // surface-identity + protected-span preserving path. The expanded
      // surface kind flows into the request (never collapsed to generic
      // dialogue) and the assertion below fails loudly if normalization ever
      // corrupts a span's offset / identity / semantic meaning.
      const normalizedSurface = normalizeBridgeSurface(unit);
      assertNormalizedSurfacePreservesIdentity(
        unit,
        normalizedSurface,
        `draft.${unit.bridgeUnitId}`,
      );
      const request: ModelInvocationRequest = {
        taskKind: "draft_translation",
        modelId: provider.descriptor.defaultModelId,
        // ITOTORI-220 — pin the descriptor's providerName as the
        // providerId for this internal workflow path. The recorded
        // provider surfaces the captured upstream identity, and the live
        // providers will surface their pinned providerId.
        providerId: provider.descriptor.providerName,
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
              surfaceKind: normalizedSurface.surfaceKind,
              sourceText: normalizedSurface.sourceText,
              protectedSpans: normalizedProtectedSpanRaws(normalizedSurface),
            }),
          },
        ],
      };
      let result: ModelInvocationResult;
      const invocationStartedAt = new Date();
      try {
        assertProviderInvocationSupported({
          descriptor: provider.descriptor,
          request,
          requestedModelId: request.modelId ?? provider.descriptor.defaultModelId,
        });
        result = await provider.invoke(request);
      } catch (error) {
        await this.recordProviderFailure(
          provider,
          nextProject,
          request,
          invocationStartedAt,
          error,
        );
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
        await this.recordProviderFailure(
          provider,
          nextProject,
          request,
          invocationStartedAt,
          error,
        );
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
    const deterministicQa = runDeterministicPreExportQa(project);
    if (deterministicQa.failures.length > 0) {
      for (const finding of deterministicQa.findings) {
        await this.repository.recordFinding(this.actor, {
          projectId: project.projectId,
          localeBranchId: project.localeBranchId,
          finding,
          status: "open",
        });
      }
      throw new DeterministicPreExportQaError(deterministicQa.failures);
    }
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

  async ingestPatchResult(
    project: ProjectState,
    patchResult: PatchResultV02,
  ): Promise<{
    project: ProjectState;
    result: PatchResultIngestionResult;
  }> {
    const diagnostics: PatchResultIngestionDiagnostic[] = [];
    const reject = (code: string, message: string, pointer?: string): never => {
      const diagnostic: PatchResultIngestionDiagnostic = pointer
        ? { code, message, pointer }
        : { code, message };
      diagnostics.push(diagnostic);
      throw new PatchResultIngestionError(diagnostic, diagnostics);
    };

    const recordedExportId = project.patchExport?.patchExportId;
    if (recordedExportId !== undefined && recordedExportId !== patchResult.patchExportId) {
      reject(
        "kaifuu.patch_result.mismatched_export_id",
        `patchResult.patchExportId (${patchResult.patchExportId}) does not match project.patchExport.patchExportId (${recordedExportId})`,
        "/patchExportId",
      );
    }

    if (patchResult.status === "passed") {
      const touchedAssets = patchResult.touchedAssets ?? [];
      const rollup = computePatchResultOutputHashRollupV02(touchedAssets);
      if (patchResult.outputHash !== rollup) {
        reject(
          "kaifuu.patch_result.output_hash_drift",
          `patchResult.outputHash drift: expected ${rollup} from touchedAssets rollup, found ${String(
            patchResult.outputHash,
          )}`,
          "/outputHash",
        );
      }
      if (patchResult.partialWrite !== undefined) {
        reject(
          "kaifuu.patch_result.silent_partial_write",
          "patchResult.partialWrite must be omitted when status is passed",
          "/partialWrite",
        );
      }
    }

    if (patchResult.partialWrite?.disposition === "retained_partial") {
      diagnostics.push({
        code: "kaifuu.patch_result.silent_partial_write",
        message:
          "patchResult.partialWrite.disposition is retained_partial; an open P0 finding must reference this patch result",
        pointer: "/partialWrite/disposition",
      });
      await this.repository.recordFinding(this.actor, {
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        finding: buildRetainedPartialFinding(patchResult),
        status: "open",
      });
    }

    const nextProject: ProjectState = { ...project, patchResult };
    return {
      project: nextProject,
      result: {
        patchResultId: patchResult.patchResultId,
        patchExportId: patchResult.patchExportId,
        status: patchResult.status,
        diagnostics,
      },
    };
  }

  async ingestConformanceReport(
    project: ProjectState,
    input: ConformanceIngestInput,
  ): Promise<{
    project: ProjectState;
    result: ConformanceIngestResult;
  }> {
    if (input.manifest !== undefined) {
      assertConformanceManifestV01(input.manifest);
    }
    for (const result of input.results) {
      assertConformanceResultV01(result);
    }
    if (input.results.length > 0) {
      const expectedAdapter = input.manifest?.adapterId ?? input.results[0]!.adapterId;
      for (const result of input.results) {
        if (result.adapterId !== expectedAdapter) {
          throw new ConformanceIngestionError({
            code: "itotori.conformance.adapter_id_mismatch",
            message: `result.adapterId (${result.adapterId}) does not match expected adapterId ${expectedAdapter}`,
          });
        }
      }
    }
    if (input.manifest !== undefined) {
      assertConformanceManifestResultJoinV01(input.manifest, input.results);
    }

    const counts: ConformanceIngestOutcomeCounts = {
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      unsupportedCount: 0,
      resultCount: input.results.length,
    };
    const persistedResults: ConformanceIngestResult["results"] = [];
    const conformanceRunId = deterministicConformanceRunId(project, input);
    const resultEntries = input.results.map((result, index) => {
      const conformanceResultId = `${conformanceRunId}:result:${String(index).padStart(3, "0")}`;
      switch (result.outcome.kind) {
        case "pass":
          counts.passCount += 1;
          persistedResults.push({
            conformanceResultId,
            profileId: result.profileId,
            outcomeKind: "pass",
            passEvidenceTier: result.outcome.evidenceTier,
            semanticCode: null,
          });
          break;
        case "fail":
          counts.failCount += 1;
          persistedResults.push({
            conformanceResultId,
            profileId: result.profileId,
            outcomeKind: "fail",
            passEvidenceTier: null,
            semanticCode: result.outcome.semanticCode,
          });
          break;
        case "skip":
          counts.skipCount += 1;
          persistedResults.push({
            conformanceResultId,
            profileId: result.profileId,
            outcomeKind: "skip",
            passEvidenceTier: null,
            semanticCode: result.outcome.semanticCode,
          });
          break;
        case "unsupported":
          counts.unsupportedCount += 1;
          persistedResults.push({
            conformanceResultId,
            profileId: result.profileId,
            outcomeKind: "unsupported",
            passEvidenceTier: null,
            semanticCode: result.outcome.semanticCode,
          });
          break;
      }
      return { conformanceResultId, result };
    });

    const adapterId = input.manifest?.adapterId ?? input.results[0]?.adapterId ?? "unknown-adapter";
    const schemaVersion =
      input.manifest?.schemaVersion ?? input.results[0]?.schemaVersion ?? "0.2.0-alpha";
    const manifestFidelityTier = manifestFidelityTierFromManifest(input.manifest);
    const recordedAt = mostRecentRecordedAt(input.results);

    if (this.conformanceRepository !== undefined) {
      const reportArtifactId = input.reportArtifactId ?? `${conformanceRunId}:report-artifact`;
      await this.conformanceRepository.saveConformanceRun(this.actor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        manifestArtifactId: input.manifestArtifactId ?? null,
        reportArtifactId,
        ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
        manifestFidelityTier,
        results: resultEntries,
        recordedAt,
        metadata: {
          adapterId,
          schemaVersion,
        },
      });
    }

    return {
      project,
      result: {
        conformanceRunId,
        adapterId,
        schemaVersion,
        manifestFidelityTier,
        counts,
        resultIds: resultEntries.map((entry) => entry.conformanceResultId),
        results: persistedResults,
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
    input: { benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult> {
    const report = input.benchmarkReport;
    // ITOTORI-059 — the locale branch comes from the report itself, not a
    // separate channel. A report without it never reaches here (the API + the
    // bridge schema reject it), but the workflow re-asserts so the artifact +
    // every cost-ledger row are branch-scoped with no project-level fallback.
    const localeBranchId = report.localeBranchId;
    if (localeBranchId === undefined) {
      throw new Error(
        "recordBenchmarkReport: benchmarkReport.localeBranchId is required (cannot record a project-level benchmark)",
      );
    }
    await this.repository.recordBenchmarkArtifactWithProviderLedger(this.actor, {
      artifact: {
        artifactId: report.benchmarkRunId,
        projectId,
        artifactKind: "benchmark_report",
        // ITOTORI-027 — persist the QA-agent calibration (incl. FP/FN)
        // + cost/quality headline alongside the benchmark artifact so the
        // dashboard reads REAL recorded data, never a re-estimate.
        metadata: summarizeBenchmarkReportMetadata(report),
        localeBranchId,
      },
      providerRuns: report.providerModelCostRecords.map((providerRun) =>
        providerRunLedgerInputFromBenchmark(
          projectId,
          localeBranchId,
          report.benchmarkRunId,
          providerRun,
        ),
      ),
    });
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

  private async prefillTranslationMemoryDrafts(
    project: ProjectState,
    locale: string,
  ): Promise<Set<string>> {
    if (!this.translationMemory) {
      return new Set();
    }
    const result = await this.translationMemory.prefillDrafts(this.actor, {
      projectId: project.projectId,
      localeBranchId: project.localeBranchId,
      requestedTargetLocale: locale,
      bridgeUnitIds: project.bridge.units.map((unit) => unit.bridgeUnitId),
      applyDrafts: true,
      includeFuzzy: false,
      requestId: `draft:${project.projectId}:${project.localeBranchId}:${locale}`,
    });
    if (result.status !== "completed") {
      return new Set();
    }

    const reusedDraftUnitIds = new Set<string>();
    for (const reuse of result.reuses) {
      project.drafts[reuse.target.bridgeUnitId] = reuse.event.targetText;
      reusedDraftUnitIds.add(reuse.target.bridgeUnitId);
    }
    return reusedDraftUnitIds;
  }

  private async recordProviderFailure(
    provider: ModelProvider,
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
            descriptor: provider.descriptor,
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
    // ITOTORI-225 — failed runs incurred no upstream charge.
    cost: {
      costKind: "zero",
      currency: "USD",
      amountUsd: "0",
      amountMicrosUsd: 0,
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
  const requestedModelId = input.request.modelId;
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
      requestedProviderId: input.request.providerId,
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
    // ITOTORI-225 — failed runs incurred no upstream charge.
    cost: {
      costKind: "zero",
      currency: "USD",
      amountUsd: "0",
      amountMicrosUsd: 0,
    },
    // ITOTORI-230 — the call never reached the wire (pre-fetch
    // failure), so we record the local-only posture as a structurally
    // honest stand-in. A future capture path could carry the
    // already-built routing block for HTTP-level failures.
    routingPosture: localOnlyRoutingPosture(input.request.providerId),
    // ITOTORI-232 — pre-fetch failures never produced a `usage` block;
    // record the typed sentinel so the ledger row is object-shaped and
    // the partial-NULL CHECK exempts it (no `cost` key).
    usageResponseJson: { _pre_fetch_failure: true },
    prompt: input.request.prompt,
  };
  if (input.request.preset) {
    run.providerPreset = input.request.preset;
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
    // ITOTORI-230 — the captured OR routing posture for THIS run lands
    // verbatim in the ledger row's `routing_posture` jsonb. Every
    // ProviderRunRecord MUST carry one (LIVE OR builds it from the
    // wire block; fake / local / recorded fill in their canonical or
    // captured posture); writing the ledger row without it would
    // leave the ZDR-enforcement count blind.
    routingPosture: run.routingPosture as unknown as Record<string, unknown>,
    ...(run.providerPreset === undefined ? {} : { providerPreset: run.providerPreset }),
    ...(adapterMetadata === undefined ? {} : { adapterMetadata }),
  };
}

function providerRunLedgerInputFromBenchmark(
  projectId: string,
  localeBranchId: string,
  benchmarkRunId: string,
  providerRun: BenchmarkReportV02["providerModelCostRecords"][number],
): ProviderRunLedgerInput {
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
    localeBranchId,
    systemId: providerRun.systemId,
    taskKind: providerRun.taskKind,
    startedAt: providerRun.startedAt,
    ...(providerRun.completedAt === undefined ? {} : { completedAt: providerRun.completedAt }),
    ...(providerRun.latencyMs === undefined ? {} : { latencyMs: providerRun.latencyMs }),
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
    fallbackPlan: normalizeBenchmarkFallbackPlan(providerRun),
    tokenUsage: providerRun.tokenUsage,
    cost: narrowBenchmarkCostToItotoriShape(providerRun.cost),
    // ITOTORI-230 — benchmark reports come from the cross-app bridge
    // schema (BenchmarkReportV02), which does NOT carry the captured
    // OR routing posture today. We persist the same sentinel the SQL
    // migration uses for pre-migration rows
    // (`_pre_itotori_230: true`) so telemetry queries that filter on
    // `routing_posture->>'zdr' = 'true'` correctly do NOT count these
    // toward ZDR-enforcement: there is no captured evidence. A
    // follow-up will extend the bridge schema to carry posture so
    // benchmark-ingested runs can prove their wire-level posture too.
    routingPosture: { _pre_itotori_230: true },
    ...(providerPreset === undefined ? {} : { providerPreset }),
    adapterMetadata: {
      source: "benchmark_report",
      routeSettingsHash: providerRun.provider.routeSettingsHash ?? null,
    },
  };
}

/**
 * ITOTORI-225 — benchmarks (`BenchmarkCostAmountV02` from the cross-app
 * bridge schema) still emit the legacy `'billed' | 'provider_estimate' |
 * 'local_estimate' | 'zero' | 'unknown'` enum. Itotori's `ProviderCost` is
 * narrowed to `'billed' | 'zero'`. Map at the ingest boundary:
 *  - rows with a non-null amount are treated as the real billed spend
 *    (the benchmark recorded what was actually charged at run time);
 *  - rows without an amount are treated as zero (no charge incurred — a
 *    skipped or failed run).
 *
 * We intentionally do not preserve the estimate/unknown distinction
 * downstream; the audit rule is "no estimates, no unknowns". If a
 * benchmark ingest needs a fully-faithful round-trip of the legacy enum,
 * that belongs in the bridge-schema layer, not in itotori's ledger.
 */
function narrowBenchmarkCostToItotoriShape(
  cost: BenchmarkReportV02["providerModelCostRecords"][number]["cost"],
): ProviderRunLedgerInput["cost"] {
  if (cost.amountMicrosUsd === undefined || cost.amountMicrosUsd === null) {
    return {
      costKind: "zero",
      currency: cost.currency,
      amountMicrosUsd: 0,
      ...(cost.pricingSnapshotId === undefined
        ? {}
        : { pricingSnapshotId: cost.pricingSnapshotId }),
    };
  }
  return {
    costKind: cost.amountMicrosUsd === 0 ? "zero" : "billed",
    currency: cost.currency,
    amountMicrosUsd: cost.amountMicrosUsd,
    ...(cost.pricingSnapshotId === undefined ? {} : { pricingSnapshotId: cost.pricingSnapshotId }),
  };
}

function normalizeBenchmarkFallbackPlan(
  providerRun: BenchmarkReportV02["providerModelCostRecords"][number],
): string[] {
  const fallbackPlan = providerRun.fallbackPlan ?? [];
  const normalized = new Set([providerRun.provider.requestedModelId, ...fallbackPlan]);
  if (providerRun.fallbackUsed) {
    normalized.add(providerRun.provider.actualModelId);
  }
  return [...normalized];
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

function emptyCostReport(projectId: string): ProjectCostReport {
  return {
    projectId,
    currency: "USD",
    runCount: 0,
    billedMicrosUsd: 0,
    zeroRunCount: 0,
    totalsByCostKind: (["billed", "provider_estimate", "zero"] as const).map((costKind) => ({
      costKind,
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })),
    recentRuns: [],
    translationMemoryReuse: emptyTranslationMemoryReuseCostReport(),
  };
}

function emptyCostDrilldown(filter: CostDrilldownFilter): CostDrilldownPage {
  const limit =
    filter.limit === undefined || !Number.isInteger(filter.limit) || filter.limit < 1
      ? 20
      : Math.min(filter.limit, 100);
  const offset =
    filter.offset === undefined || !Number.isInteger(filter.offset) || filter.offset < 0
      ? 0
      : filter.offset;
  return {
    filter: {
      projectId: filter.projectId ?? "unknown",
      systemId: filter.systemId ?? null,
      from: filter.from ? filter.from.toISOString() : null,
      to: filter.to ? filter.to.toISOString() : null,
    },
    pagination: {
      total: 0,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageCount: 0,
      hasMore: false,
      nextOffset: null,
    },
    rows: [],
  };
}

function emptyTranslationMemoryReuseCostReport(): ProjectCostReport["translationMemoryReuse"] {
  return {
    reuseEventCount: 0,
    appliedCount: 0,
    suggestedCount: 0,
    providerCallAvoidedCount: 0,
    estimatedPromptTokensSaved: 0,
    estimatedCompletionTokensSaved: 0,
    estimatedTotalTokensSaved: 0,
    estimatedCostUsdSaved: null,
    recentEvents: [],
    malformedCostImpactCount: 0,
    diagnostics: [],
  };
}

function id(kind: string, n: number): string {
  return `019ed000-0000-7000-8000-${kind.replaceAll("-", "").padEnd(8, "0").slice(0, 8)}${String(n).padStart(4, "0")}`;
}

function patchResultIdForRuntimeReport(runtimeReport: RuntimeReportInput): string {
  return `${runtimeReport.runtimeReportId}:patch-result`;
}

function deterministicConformanceRunId(
  project: ProjectState,
  input: ConformanceIngestInput,
): string {
  const adapterId = input.manifest?.adapterId ?? input.results[0]?.adapterId ?? "unknown-adapter";
  const seed = `${project.projectId}:${project.localeBranchId}:${adapterId}:${mostRecentRecordedAt(input.results).toISOString()}`;
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `019ed028-0000-7000-8000-${suffix}`;
}

function mostRecentRecordedAt(results: ReadonlyArray<ConformanceResultV01>): Date {
  if (results.length === 0) {
    return new Date(0);
  }
  let max = new Date(results[0]!.recordedAt);
  for (const result of results.slice(1)) {
    const candidate = new Date(result.recordedAt);
    if (candidate.getTime() > max.getTime()) {
      max = candidate;
    }
  }
  return max;
}

function manifestFidelityTierFromManifest(
  manifest: ConformanceManifestV01 | undefined,
): string | null {
  if (manifest === undefined) {
    return null;
  }
  const extension = manifest.optionalExtensions?.find(
    (ext) => ext.key === "manifest-fidelity-tier",
  );
  if (extension === undefined) {
    return null;
  }
  return extension.note;
}

function buildRetainedPartialFinding(patchResult: PatchResultV02): FindingRecordV02 {
  const seed = `${patchResult.patchResultId}:retained_partial`;
  const findingId = deterministicPatchResultUuid("finding", seed);
  const provenanceId = deterministicPatchResultUuid("provenance", seed);
  const evidenceId = deterministicPatchResultUuid("evidence", seed);
  const checkId = deterministicPatchResultUuid("check", seed);
  const affected = patchResult.partialWrite?.attemptedAssetIds ?? [];
  return {
    findingId,
    findingKind: "patching_issue",
    severity: "P0",
    qualityCategory: "technical_integrity",
    title: `Retained partial patch write for ${patchResult.patchResultId}`,
    description:
      "Patch result reports partialWrite.disposition=retained_partial; partial bytes remain on disk and require operator intervention before any re-apply.",
    impact:
      "The target executable is in a partially-patched state until this finding is resolved; do not re-export until rollback is confirmed.",
    createdAt: "2026-06-23T00:00:00.000Z",
    affectedRefs: affected.map((assetId) => ({
      subjectKind: "asset",
      subjectId: assetId,
      label: "retained_partial asset",
    })),
    evidence: [
      {
        evidenceId,
        evidenceKind: "validator_message",
        summary:
          "kaifuu.patch_result.silent_partial_write: retained_partial disposition recorded without rollback",
        expectedValue: "rolled_back or cleaned_up",
        observedValue: "retained_partial",
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "deterministic_check",
        checkId,
        checkName: "kaifuu.patch_result.silent_partial_write",
        checkVersion: "kaifuu-010.1",
      },
    ],
    causalLinks: [],
  };
}

function deterministicPatchResultUuid(kind: string, seed: string): string {
  const suffix = createHash("sha256").update(`${kind}:${seed}`).digest("hex").slice(0, 12);
  return `019ed010-0000-7000-8000-${suffix}`;
}

function isBridgeBundleV02(bridge: BridgeBundle | BridgeBundleV02): bridge is BridgeBundleV02 {
  return bridge.schemaVersion === "0.2.0";
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
