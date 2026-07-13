import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  BenchmarkReportSummary,
  CostDrilldownFilter,
  CostDrilldownPage,
  DashboardDecisionReadModel,
  ItotoriConformanceRepositoryPort,
  ItotoriLocalizationJournalRepositoryPort,
  ItotoriModelLedgerRepositoryPort,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ItotoriTranslationMemoryService,
  LocaleBranchIdentity,
  ProjectCostReport,
  ProjectDashboardStatus,
  ProjectTelemetryTimeseries,
  ProviderRunLedgerInput,
  RuntimeDashboardStatus,
} from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  BridgeBundleV02,
  ConformanceManifestV01,
  ConformanceResultV01,
  FindingRecordV02,
  PatchResultStatusV02,
  PatchResultV02,
  RuntimeEvidenceReportV02,
  RuntimeVerificationReport,
} from "@itotori/localization-bridge-schema";
import {
  assertConformanceManifestResultJoinV01,
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertNormalizedSurfacePreservesIdentity,
  ConformanceIngestionError,
  computePatchResultOutputHashRollupV02,
  isLocaleTaggedSourceEcho,
  normalizeBridgeSurface,
  normalizedProtectedSpanRaws,
} from "@itotori/localization-bridge-schema";
import { assertProviderInvocationSupported } from "../providers/capability-guard.js";
import { summarizeBenchmarkReportMetadata } from "../benchmark-report-summary.js";
import {
  executeModelInvocation,
  InvocationRetryCeilingError,
} from "../orchestrator/invocation-supervisor.js";
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

/**
 * ovw-launch-pass-action — the authoritative scope a launch-pass drives. The
 * project + locale branch are resolved SERVER-SIDE (the HTTP boundary verifies
 * the branch against the project's ownership set) before this reaches the
 * driver.
 */
export type LaunchLocalizationPassInput = {
  projectId: string;
  localeBranchId: string;
  /** Existing durable run selected for an operator cancellation. */
  resumeRunId?: string;
  /** Cancel the selected run instead of launching/resuming provider work. */
  cancelled?: boolean;
};

/**
 * ovw-launch-pass-action — the driver outcome of a launch. `started` carries
 * the immutable durable journal run identity + start time; `refused` carries a
 * human reason. A refusal is a DOMAIN outcome (surfaced in-band), distinct
 * from a thrown error (misconfiguration / permission).
 */
export type LaunchLocalizationPassResult =
  | {
      outcome: "started";
      journalRunId: string;
      startedAt: Date;
      /** Present when the requested live operation synchronously aborted this run. */
      terminalStatus?: "aborted";
    }
  | { outcome: "refused"; refusalMessage: string };

/**
 * ovw-launch-pass-action — the driver seam the launch-pass mutation uses to
 * DRIVE the next localization pass with (the
 * project-driven-executor / localize-fullproject driver). It is a PORT so
 * production binds it to the real driver while a test binds a double (no game
 * bytes, no live pipeline). The driver itself is unchanged — this is the thin
 * adapter seam it is invoked behind.
 */
export interface LocalizationPassDriverPort {
  launchNextPass(
    input: LaunchLocalizationPassInput & { actor: AuthorizationActor },
  ): Promise<LaunchLocalizationPassResult>;
}

/**
 * ovw-launch-pass-action — thrown when the launch-pass workflow is invoked but
 * no real pass driver is wired (the pure-HTTP install has no game-bytes driver
 * configured). Mirrors {@link DraftProviderNotConfiguredError}: per the
 * strict-proof rule "fakes and mocks ONLY belong in tests, NEVER in real code",
 * the workflow refuses LOUDLY rather than fabricating a fake pass. A deployment
 * with the driver wired drives a real pass through the SAME handler seam; a
 * test injects an explicit driver double.
 */
export class LocalizationPassDriverNotConfiguredError extends Error {
  constructor() {
    super(
      "launchNextLocalizationPass refused: no localization-pass driver is configured for this " +
        "workflow. The production launch path must inject a real pass driver (the " +
        "project-driven-executor / localize-fullproject driver, over real game bytes); refusing " +
        "to fabricate a fake pass. Tests must inject an explicit driver double.",
    );
    this.name = "LocalizationPassDriverNotConfiguredError";
  }
}

/**
 * p3-in-studio-decode-extract-trigger — the sourcing + identity + mode inputs a
 * single in-studio decode/extract needs. Mirrors the CLI `itotori extract`
 * surface (`KaifuuExtractArgs`): sourcing is EITHER a by-id vault handle OR a
 * raw game root; identity is the four RealLive metadata fields; mode is
 * per-scene OR whole-Seen. The Studio's "decode from game path" trigger passes
 * exactly this to run the REAL identify -> inventory -> extract pipeline (the
 * same `kaifuu-cli extract --engine reallive` the CLI drives) and receive the
 * produced v0.2 BridgeBundle back for ingestion.
 */
export type DecodeExtractInput = {
  /** Sourcing (alpha production): resolve the corpus by-id through the vault. */
  vaultCanonicalId?: string;
  /** Sourcing (raw-path helper): a game root containing REALLIVEDATA/Seen.txt. */
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  /** Per-scene mode: the RealLive scene id (u16). Mutually exclusive with wholeSeen. */
  scene?: number;
  /** Whole-game mode: one bridge over the entire Seen.txt. */
  wholeSeen?: boolean;
};

/**
 * The outcome of a real in-studio decode/extract: the v0.2 BridgeBundle kaifuu
 * produced (read back from the file kaifuu wrote), plus the resolved mode and
 * the exact command the runner spawned (surfaced for operator diagnostics).
 */
export type DecodeExtractOutcome = {
  bridge: BridgeBundleV02;
  mode: "per-scene" | "whole-seen";
  /** The resolved kaifuu-cli invocation (binary + argv), for diagnostics. */
  command: string;
};

/**
 * p3-in-studio-decode-extract-trigger — the injection seam that drives the REAL
 * `kaifuu-cli extract` decode path and hands back the produced bridge. Production
 * binds it to the real runner (`../extract/decode-extract-runner.js`); a test
 * binds a double (no game bytes, no subprocess). The extract binary itself is
 * unchanged — this is the thin adapter the workflow is invoked behind.
 */
export interface DecodeExtractPort {
  runDecodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome>;
}

/**
 * p3-in-studio-decode-extract-trigger — thrown when the decode/extract workflow
 * is invoked but no real decode runner is wired (a pure-HTTP install with no
 * native kaifuu-cli / game-bytes access). Mirrors
 * {@link DraftProviderNotConfiguredError}: the workflow refuses LOUDLY rather
 * than fabricating a fake bridge. A deployment with the runner wired drives a
 * real decode through the SAME handler seam; a test injects an explicit double.
 */
export class DecodeExtractNotConfiguredError extends Error {
  constructor() {
    super(
      "decodeExtract refused: no decode/extract runner is configured for this workflow. The " +
        "production decode path must inject a real runner (driving `kaifuu-cli extract --engine " +
        "reallive` over real game bytes); refusing to fabricate a fake bridge. Tests must inject " +
        "an explicit runner double.",
    );
    this.name = "DecodeExtractNotConfiguredError";
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
  /**
   * p3-in-studio-decode-extract-trigger — run the REAL identify -> inventory ->
   * extract pipeline (driving `kaifuu-cli extract --engine reallive`) from a game
   * source path/handle and return the produced v0.2 BridgeBundle. Refuses LOUDLY
   * with {@link DecodeExtractNotConfiguredError} when no real decode runner is
   * wired (never a fake bridge). The returned bridge feeds the SAME
   * `importBridge` ingestion path the manual upload used.
   */
  decodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome>;
  draftProject(project: ProjectState, locale: string): Promise<ProjectState>;
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
  recordBenchmarkReport(
    projectId: string,
    input: { benchmarkReport: BenchmarkReportV02 },
  ): Promise<BenchmarkRecordResult>;
  /**
   * ovw-launch-pass-action — DRIVE the next localization pass for the
   * (server-resolved) project + locale branch via the
   * injected pass driver. `canSteer`-gated at the HTTP boundary (the
   * `draft.write` steer permission). Throws
   * {@link LocalizationPassDriverNotConfiguredError} when no driver is wired.
   */
  launchNextLocalizationPass(
    input: LaunchLocalizationPassInput,
  ): Promise<LaunchLocalizationPassResult>;
}

export class ItotoriProjectWorkflowService implements ItotoriProjectWorkflowPort {
  constructor(
    private readonly repository: ItotoriProjectRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly draftModelProvider?: ModelProvider,
    private readonly modelLedger?: ItotoriModelLedgerRepositoryPort,
    private readonly translationMemory?: Pick<ItotoriTranslationMemoryService, "prefillDrafts">,
    private readonly conformanceRepository?: ItotoriConformanceRepositoryPort,
    private readonly journal?: ItotoriLocalizationJournalRepositoryPort,
    // ovw-launch-pass-action — the real localization-pass driver. Optional: a
    // pure-HTTP install without a game-bytes driver leaves it undefined, so
    // `launchNextLocalizationPass` refuses LOUDLY (no fake pass) rather than
    // fabricating one. Tests inject an explicit driver double.
    private readonly passDriver?: LocalizationPassDriverPort,
    // p3-in-studio-decode-extract-trigger — the real decode/extract runner. Left
    // undefined on a pure-HTTP install (no native kaifuu-cli / game bytes), in
    // which case `decodeExtract` refuses LOUDLY rather than fabricating a fake
    // bridge. Production injects the real runner; tests inject a double.
    private readonly decodeExtractRunner?: DecodeExtractPort,
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
    // locale-branch set (the set that scopes the execution journal) into this
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
    const [decisions, cost, telemetry, costDrilldown, benchmarkReports] = await Promise.all([
      this.getDashboardDecisions(projectId),
      this.getCostReport(projectId),
      this.getTelemetryTimeseries(projectId),
      this.getCostDrilldown(costDrilldownFilter),
      this.getBenchmarkReports(projectId),
    ]);
    return await composeProjectOverviewReadModel({
      actor: this.actor,
      status,
      decisions,
      cost,
      telemetry,
      costDrilldown,
      benchmarkReports,
      ...(this.journal !== undefined ? { journalRepository: this.journal } : {}),
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

  async getTelemetryTimeseries(projectId?: string): Promise<ProjectTelemetryTimeseries> {
    if (!this.modelLedger) {
      return emptyTelemetryTimeseries(projectId ?? "unknown");
    }
    return await this.modelLedger.getProjectTelemetryTimeseries(this.actor, projectId);
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

  async decodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome> {
    // p3-in-studio-decode-extract-trigger — refuse LOUDLY when no real decode
    // runner is wired rather than silently returning a fabricated bridge. The
    // runner drives the SAME `kaifuu-cli extract --engine reallive` decode path
    // the CLI `itotori extract` command uses.
    const runner = this.decodeExtractRunner;
    if (runner === undefined) {
      throw new DecodeExtractNotConfiguredError();
    }
    return await runner.runDecodeExtract(input);
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
        // Keep the single-shot route bounded: a draft unit only needs a short
        // target string, and the live provider still enforces its USD cap.
        generation: { temperature: 0, maxOutputTokens: 128 },
      };
      let result: ModelInvocationResult;
      const invocationStartedAt = new Date();
      try {
        assertProviderInvocationSupported({
          descriptor: provider.descriptor,
          request,
          requestedModelId: request.modelId ?? provider.descriptor.defaultModelId,
        });
        result = await executeModelInvocation(provider, request);
      } catch (error) {
        const workflowError = workflowDraftInvocationError(error, unit.bridgeUnitId);
        await this.recordProviderFailure(
          provider,
          nextProject,
          request,
          invocationStartedAt,
          workflowError,
        );
        throw workflowError;
      }
      const validatedDraft = validateWorkflowDraftText({
        draftText: result.content,
        sourceTexts: [unit.sourceText, normalizedSurface.sourceText],
      });
      if (!validatedDraft.valid) {
        const failedRun = failedProviderRunFromRun(result.providerRun, "provider_response_invalid");
        const error = new ModelProviderError(
          `draft provider returned ${validatedDraft.reason} for ${unit.bridgeUnitId}`,
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
      nextProject.drafts[unit.bridgeUnitId] = validatedDraft.text;
    }
    await this.repository.saveDrafts(this.actor, nextProject);
    return nextProject;
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

  async launchNextLocalizationPass(
    input: LaunchLocalizationPassInput,
  ): Promise<LaunchLocalizationPassResult> {
    // ovw-launch-pass-action — the workflow is a thin adapter over the injected
    // pass driver: it drives the next pass. The driver consumes prior written
    // outcomes through the durable journal. With
    // no driver wired the install has no
    // game-bytes pipeline, so it refuses LOUDLY (never a fabricated pass),
    // mirroring the draft path's provider-not-configured refusal.
    if (this.passDriver === undefined) {
      throw new LocalizationPassDriverNotConfiguredError();
    }
    return await this.passDriver.launchNextPass({ ...input, actor: this.actor });
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
    const unitsById = new Map(project.bridge.units.map((unit) => [unit.bridgeUnitId, unit]));
    for (const reuse of result.reuses) {
      const unit = unitsById.get(reuse.target.bridgeUnitId);
      if (unit === undefined) {
        continue;
      }
      const validatedDraft = validateWorkflowDraftText({
        draftText: reuse.event.targetText,
        sourceTexts: [unit.sourceText],
      });
      if (!validatedDraft.valid) {
        continue;
      }
      project.drafts[reuse.target.bridgeUnitId] = validatedDraft.text;
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
  "Draft a localized target string. Preserve protected spans exactly; return only trimmed, non-blank target text, never a locale-tagged or source-repeated value.";

type WorkflowDraftTextValidation = { valid: true; text: string } | { valid: false; reason: string };

/**
 * The legacy project-draft route has no canonical outcome persistence yet, so
 * it must at least refuse malformed/source-repeated provider text rather than
 * persisting it as a target draft. A later invocation supervisor owns retries.
 */
function validateWorkflowDraftText(args: {
  draftText: string | null;
  sourceTexts: ReadonlyArray<string>;
}): WorkflowDraftTextValidation {
  if (args.draftText === null) {
    return { valid: false, reason: "no text" };
  }
  const text = args.draftText;
  if (text.trim().length === 0) {
    return { valid: false, reason: "blank text" };
  }
  if (text !== text.trim()) {
    return { valid: false, reason: "untrimmed text" };
  }
  if (isLocaleTaggedSourceEcho(text)) {
    return { valid: false, reason: "a locale-tagged source replay" };
  }
  if (args.sourceTexts.some((sourceText) => text === sourceText.trim())) {
    return { valid: false, reason: "a source replay" };
  }
  return { valid: true, text };
}

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

function workflowDraftInvocationError(error: unknown, bridgeUnitId: string): unknown {
  if (!(error instanceof InvocationRetryCeilingError) || error.lastInvocation === undefined) {
    return error;
  }
  const lastInvocation = error.lastInvocation;
  return new ModelProviderError(
    `draft provider never returned usable content for ${bridgeUnitId} (${error.lastFailure})`,
    "provider_response_invalid",
    false,
    failedProviderRunFromRun(lastInvocation.providerRun, "provider_response_invalid"),
    lastInvocation.adapterMetadata,
    error,
  );
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

function emptyTelemetryTimeseries(projectId: string): ProjectTelemetryTimeseries {
  return {
    projectId,
    bucket: "day",
    rows: [],
    throughputSeries: [],
    costPerRunSeries: [],
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
