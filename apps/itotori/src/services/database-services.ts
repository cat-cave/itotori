import { randomUUID } from "node:crypto";
import {
  EngineCapabilityReportRepository,
  ItotoriAssetLocalizationDecisionRepository,
  ItotoriAuthBillingSeatRepository,
  ItotoriAuthMemberManagementRepository,
  ItotoriAuthSessionService,
  ItotoriAuthSsoSettingsRepository,
  ItotoriBenchmarkRunRepository,
  ItotoriBranchReferenceRepository,
  ItotoriEventQueueRepository,
  ItotoriFeedbackRepository,
  ItotoriExactSearchDocumentRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  ItotoriCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  ItotoriCatalogRepository,
  ItotoriContextArtifactRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationResultRevisionRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriModelLedgerRepository,
  ItotoriModelRoutingSettingsRepository,
  ItotoriTranslationScopeSettingsRepository,
  ItotoriPrincipalRepository,
  ItotoriProjectRepository,
  ItotoriReviewerQueueRepository,
  ItotoriSceneCoverageRepository,
  ItotoriSemanticContextReadRepository,
  ItotoriSourceUnitRepository,
  ItotoriStyleGuideFixtureFlowService,
  ItotoriStyleGuideService,
  ItotoriStyleGuideRepository,
  ItotoriTerminologyRepository,
  ItotoriWikiContextRepository,
  ItotoriTranslationBatchRepository,
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  ItotoriWorkspaceCorrectionRepository,
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  localOperatorPrincipalId,
  listAccountPermissionSets,
  loadPermissionSetAccountId,
  migrate,
  type ItotoriCatalogExactExternalIdLinkerPort,
  type ItotoriCatalogFuzzyCandidateGeneratorPort,
  type ItotoriCatalogCrawlerRepositoryPort,
  type CatalogBenchmarkSeedFinderFilter,
  type CatalogBenchmarkSeedFinderReadModel,
  type CatalogContextPanelCatalogReadModel,
  type CatalogOpportunityRankingFilter,
  type CatalogOpportunityRankingReadModel,
  type CatalogConflictReviewFilter,
  type CatalogConflictReviewReadModel,
  type CatalogCompletenessBenchmarkPools,
  type CatalogCompletenessPoolFilter,
  type JobQueueRecord,
  type JobWorkerResult,
  type LoadQueueHealthOptions,
  type LoadJobsRunTableOptions,
  type JobsRunTableReadModel,
  type ModelRoutingSettingsRecord,
  type SaveModelRoutingSettingsInput,
  type TranslationScopeSettingsRecord,
  type LocalizationPassRunConfigRecord,
  type QueueHealthReadModel,
  type AuthSessionAdminRecord,
  type AuthAccountSeatUsageRecord,
  type TerminologySearchInput,
  type TerminologySearchReadModel,
  type RefreshExactSearchDocumentsInput,
  type RefreshExactSearchDocumentsResult,
  type SearchExactInput,
  type SearchExactToolResult,
  type StyleGuideFixtureFlowInput,
  type StyleGuideFixtureFlowResult,
  type AssetDecisionRecord,
  type AssetLocalizationDecisionAssetKind,
  type CandidateAssetRecord,
  type ConfigureAuthSsoSettingsInput,
  type AuthSsoSettingsRecord,
  type ActorIdentityRecord,
  type BranchPolicyGlossaryReferenceRecord,
  type MemberInvitationRecord,
  type MemberRecord,
  type PermissionSetRecord,
  type StyleGuideVersionRecord,
} from "@itotori/db";
import type {
  ApiAcceptMemberInvitationRequest,
  ApiBranchPolicyGlossaryReference,
  ApiBranchPolicyPolicy,
  ApiBranchPolicyRule,
  ApiBranchPolicySettingsResponse,
  ApiBranchPolicyVersion,
  ApiInviteMemberRequest,
  ApiPrincipalPermissionSetGrantRequest,
  ApiRemoveMemberRequest,
  ApiRevokeAuthSessionRequest,
  ApiSaveBranchPolicySettingsRequest,
  ApiTranslationScopeSettingsResponse,
  ApiSaveTranslationScopeSettingsRequest,
  ApiLocalizationRunConfigResponse,
  ApiSaveLocalizationRunConfigRequest,
} from "../api-schema.js";
import {
  EngineCapabilityReportService,
  type EngineCapabilityReportPort,
} from "./engine-capability-report.js";
import type { AssetDecisionsCliPort } from "../asset-decisions/cli.js";
import { persistBatches } from "../batch-planner/index.js";
import {
  resolveSceneSummaryProvider,
  type SceneSummaryCliDependencies,
} from "../agents/scene-summary/index.js";
import {
  resolveCharacterRelationshipProvider,
  type CharacterRelationshipCliDependencies,
} from "../agents/character-relationship/index.js";
import type { ProviderFamily } from "../providers/types.js";
import { LocalProviderRunArtifactRecorder } from "../providers/artifacts.js";
import type {
  PlanBatchesContextLoader,
  PlanBatchesPersister,
  PlannedProjectFile,
} from "../batch-planner/cli.js";
import type { TerminologyTermSnapshot } from "../batch-planner/shapes.js";
import {
  ItotoriAuthorizationService,
  localUserActor as defaultLocalUserActor,
  type ItotoriAuthorizationPort,
} from "../auth.js";
import { ManualFeedbackImportService, type ManualFeedbackImportPort } from "../manual-feedback.js";
import { DraftFeedbackBatchService, type DraftFeedbackBatchPort } from "../draft-feedback/index.js";
import {
  ReviewerQueueApiService,
  type ReviewerQueueApiServicePort,
} from "../reviewer/api-service.js";
import { ReviewerQueueActionService } from "../reviewer/action-service.js";
import {
  LocalizationWorkspaceApiService,
  type LocalizationWorkspaceApiServicePort,
} from "../workspace/api-service.js";
import {
  WorkspaceCorrectionService,
  type WorkspaceCorrectionServicePort,
} from "../workspace/correction-service.js";
import {
  ContextCorrectionService,
  type ApplyContextCorrectionInput,
  type ContextCorrectionRerunResult,
  type ContextCorrectionRerunStatus,
} from "../orchestrator/context-correction-service.js";
import { WikiBrainService, type WikiBrainServicePort } from "../wiki/service.js";
import {
  bindPlayTesterResultRevisionService,
  PlayTesterResultRevisionService,
  type BoundPlayTesterResultRevisionServicePort,
} from "../play/result-revision-service.js";
import { ProductionPlayTesterPatchArtifactMaterializer } from "../play/production-patch-revision-materializer.js";
import {
  ItotoriProjectWorkflowService,
  type ItotoriProjectWorkflowPort,
} from "./project-workflow.js";
import { createDecodeExtractRunner } from "../extract/decode-extract-runner.js";
import {
  createDbBackedDraftModelProvider,
  createDbBackedLivePassRunner,
  createDbBackedLocalizationPassDriver,
} from "./db-live-workflow-ports.js";
import {
  DbBackedContextCorrectionRedrafter,
  DbBackedContextCorrectionRerunVerifier,
  type ContextCorrectionRedraftRunner,
} from "./context-correction-redrafter.js";
import { ContextCorrectionRerunWorker } from "../orchestrator/context-correction-worker.js";
import {
  composeBmkCockpitReadModel,
  loadBmkCockpitRunHistory,
  type BmkCockpitReadModel,
  type BmkCockpitRunHistoryPage,
} from "../bmk-cockpit-read-model.js";
import { LedgerTelemetryQuery } from "../telemetry/queries-impl.js";
import type { TelemetryQuery } from "../telemetry/queries.js";
import { readOnlyApiServices, type ItotoriReadOnlyApiServices } from "../api-handlers.js";
import type { AuthorizationActor, ItotoriDatabase } from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  SceneCoverageService,
  type SceneCoverageServicePort,
} from "../play/scene-coverage-service.js";
import {
  RouteMapReadModelService,
  type RouteMapReadModelPort,
} from "../play/route-map-read-model.js";

export type ItotoriApplicationServices = {
  authorization: ItotoriAuthorizationPort;
  projectWorkflow: ItotoriProjectWorkflowPort;
  manualFeedback: ManualFeedbackImportPort;
  draftFeedbackBatch: DraftFeedbackBatchPort;
  catalogRepository: {
    catalogConflictReview(
      filter?: CatalogConflictReviewFilter,
    ): Promise<CatalogConflictReviewReadModel>;
    catalogCompletenessBenchmarkPools(
      filter?: CatalogCompletenessPoolFilter,
    ): Promise<CatalogCompletenessBenchmarkPools>;
    catalogBenchmarkSeedFinder(
      filter?: CatalogBenchmarkSeedFinderFilter,
    ): Promise<CatalogBenchmarkSeedFinderReadModel>;
    catalogContextPanelForWork(input: {
      workId: string;
      targetLanguage: string;
    }): Promise<CatalogContextPanelCatalogReadModel | null>;
    catalogOpportunityRanking(
      filter?: CatalogOpportunityRankingFilter,
    ): Promise<CatalogOpportunityRankingReadModel>;
  };
  terminologyRepository: {
    searchTerms(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  };
  /** Shared node-6 browse + node-8 edit surface for dashboard, API, and CLI. */
  wiki: WikiBrainServicePort;
  reviewerQueue: ReviewerQueueApiServicePort;
  workspace: LocalizationWorkspaceApiServicePort;
  /** Read-only before/after context for the workspace correction preview. */
  workspaceCorrections: WorkspaceCorrectionServicePort;
  /** Direct play-tester shared-brain correction API + installed worker drain. */
  contextCorrections: ContextCorrectionServicePort;
  /** p0-core-result-revision-hitl — play-tester target edit → result + patch revision. */
  playTesterResultRevision: BoundPlayTesterResultRevisionServicePort;
  exactSearch: {
    refreshDocuments(
      input: RefreshExactSearchDocumentsInput,
    ): Promise<RefreshExactSearchDocumentsResult>;
    searchExact(input: SearchExactInput): Promise<SearchExactToolResult>;
  };
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
  catalogFuzzyCandidateGenerator: ItotoriCatalogFuzzyCandidateGeneratorPort;
  catalogCrawlerRepository: ItotoriCatalogCrawlerRepositoryPort;
  catalogCrawlerRunner: ItotoriCatalogCrawlerRunner;
  styleGuideFixtureFlow: {
    run(input: StyleGuideFixtureFlowInput): Promise<StyleGuideFixtureFlowResult>;
  };
  batchPlanner: {
    loadContext: PlanBatchesContextLoader;
    persist: PlanBatchesPersister;
  };
  sceneSummary: {
    cliDependencies(
      provider: ProviderFamily,
      providerRunsDir?: string,
    ): Promise<SceneSummaryCliDependencies>;
    defaultModelId: string;
    /** ITOTORI-220 — default providerId for the scene-summary model. */
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
  characterRelationship: {
    cliDependencies(
      provider: ProviderFamily,
      providerRunsDir?: string,
    ): Promise<CharacterRelationshipCliDependencies>;
    defaultModelId: string;
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
  localizeProjectStage: {
    contextArtifactRepository: ItotoriContextArtifactRepository;
    prepareContextScope(input: {
      actor: AuthorizationActor;
      bridge: BridgeBundleV02;
      projectId: string;
      localeBranchId: string;
      targetLocale: string;
    }): Promise<void>;
  };
  engineCapabilityReports: EngineCapabilityReportPort;
  assetDecisions: Omit<AssetDecisionsCliPort, "loadActiveDecisions"> & {
    loadActiveDecisions(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: AssetLocalizationDecisionAssetKind },
    ): Promise<AssetDecisionRecord[]>;
    loadCandidateAssets(
      projectId: string,
      localeBranchId: string,
      opts?: { kindFilter?: AssetLocalizationDecisionAssetKind },
    ): Promise<CandidateAssetRecord[]>;
  };
  /**
   * ITOTORI-223 — per-(modelId, providerId) telemetry query surface
   * over durable journal attempts.
   */
  telemetry: {
    query: TelemetryQuery;
    actor: AuthorizationActor;
  };
  /**
   * ITOTORI-047 — queue-health read-model loader (outbox/job lag, retries,
   * dead-letter) powering the `queue.health` API route and the
   * `queue-health` CLI command. Read-only; gated on `queue.read`.
   */
  queueHealth: {
    loadQueueHealth(options?: LoadQueueHealthOptions): Promise<QueueHealthReadModel>;
  };
  jobs: {
    loadRunTable(options?: LoadJobsRunTableOptions): Promise<JobsRunTableReadModel>;
  };
  benchmarkCockpit: {
    loadCockpit(input: {
      projectId: string;
      runId?: string;
      localeBranchId?: string | null;
    }): Promise<BmkCockpitReadModel>;
    loadHistory(input: {
      projectId: string;
      localeBranchId?: string | null;
      limit?: number;
      offset?: number;
    }): Promise<BmkCockpitRunHistoryPage>;
  };
  authSsoSettings: {
    configureSettings(input: ConfigureAuthSsoSettingsInput): Promise<AuthSsoSettingsRecord>;
  };
  modelRouting: {
    loadSettings(projectId: string): Promise<ModelRoutingSettingsRecord>;
    saveRoute(input: SaveModelRoutingSettingsInput): Promise<ModelRoutingSettingsRecord>;
  };
  branchPolicy: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<ApiBranchPolicySettingsResponse>;
    saveSettings(
      input: ApiSaveBranchPolicySettingsRequest,
    ): Promise<ApiBranchPolicySettingsResponse>;
  };
  translationScope: {
    loadSettings(input: {
      projectId: string;
      localeBranchId: string;
    }): Promise<ApiTranslationScopeSettingsResponse>;
    saveSettings(
      input: ApiSaveTranslationScopeSettingsRequest,
    ): Promise<ApiTranslationScopeSettingsResponse>;
  };
  localizationRunConfig: {
    saveRunConfig(
      input: ApiSaveLocalizationRunConfigRequest,
    ): Promise<ApiLocalizationRunConfigResponse>;
  };
  authMembers: {
    listMembers(accountId: string): Promise<MemberRecord[]>;
    inviteMember(input: ApiInviteMemberRequest): Promise<MemberInvitationRecord>;
    acceptInvitation(
      invitationId: string,
      input: ApiAcceptMemberInvitationRequest,
    ): Promise<MemberRecord>;
    removeMember(membershipId: string, input: ApiRemoveMemberRequest): Promise<MemberRecord>;
  };
  authBilling: {
    loadSeatUsage(accountId: string): Promise<AuthAccountSeatUsageRecord>;
  };
  authPermissions: {
    listPermissionSets(accountId: string): Promise<PermissionSetRecord[]>;
    grantPermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: ApiPrincipalPermissionSetGrantRequest;
    }): Promise<MemberRecord>;
    revokePermissionSet(input: {
      principalId: string;
      permissionSetId: string;
      request: ApiPrincipalPermissionSetGrantRequest;
    }): Promise<MemberRecord>;
  };
  authSessions: {
    listPrincipalSessions(principalId: string): Promise<AuthSessionAdminRecord[]>;
    revokePrincipalSession(
      principalId: string,
      sessionId: string,
      input: ApiRevokeAuthSessionRequest,
    ): Promise<AuthSessionAdminRecord>;
  };
  authIdentity: {
    loadIdentity(): Promise<ActorIdentityRecord>;
  };
  playRouteMap: RouteMapReadModelPort;
  sceneCoverage: SceneCoverageServicePort;
};

/** Production correction mutation plus its exact rerun outcome and worker drain seam. */
export type ContextCorrectionServicePort = {
  apply(input: ApplyContextCorrectionInput): Promise<ContextCorrectionRerunResult>;
  drain(): Promise<JobWorkerResult>;
};

export type ItotoriServiceFactory = <T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
  options?: ItotoriServiceFactoryOptions,
) => Promise<T>;

export type ItotoriServiceFactoryOptions = {
  actor?: AuthorizationActor;
  sessionId?: string;
};

/**
 * ITOTORI-043 — the least-privilege factory for the read-only (query) API
 * handlers. A callback wired through this factory receives ONLY the read/query
 * dependency surface ({@link ItotoriReadOnlyApiServices}); it is structurally
 * unable to reach a mutation service (`draftProject`, `recordFinding`,
 * `executeBatch`, …). The narrowed services are PROJECTED
 * from the same shared {@link ItotoriApplicationServices} the full factory
 * builds (`readOnlyApiServices` copies only the read methods, delegating to the
 * shared instances), so no repository is re-wired and no shared service is
 * bypassed.
 */
export type ItotoriReadOnlyServiceFactory = <T>(
  callback: (services: ItotoriReadOnlyApiServices) => Promise<T>,
  options?: ItotoriServiceFactoryOptions,
) => Promise<T>;

/**
 * ITOTORI-043 — derive a read-only service factory from a full one. Every read
 * callback runs against the read-only projection of the shared services the
 * full factory produced (reused instances, no duplicated wiring).
 */
export function toReadOnlyServiceFactory(
  factory: ItotoriServiceFactory,
): ItotoriReadOnlyServiceFactory {
  return (callback, options) =>
    factory((services) => callback(readOnlyApiServices(services)), options);
}

/**
 * ITOTORI-043 — the DB-backed read-only API service factory. Opens the shared
 * database-backed services exactly once (same construction the full factory
 * uses) and hands the callback ONLY their read-only projection.
 */
export function withDatabaseReadOnlyApiServices<T>(
  options: DatabaseServiceOptions,
  callback: (services: ItotoriReadOnlyApiServices) => Promise<T>,
): Promise<T> {
  return withDatabaseItotoriServices(options, (services) =>
    callback(readOnlyApiServices(services)),
  );
}

export type DatabaseServiceOptions = {
  databaseUrl?: string;
  bootstrapLocalUser?: boolean;
  actor?: AuthorizationActor;
  sessionId?: string;
  /**
   * Test-only deterministic runner seam. Production leaves this unset so
   * queued corrections call the registered full-project live redrafter.
   */
  contextCorrectionRedraftRunner?: ContextCorrectionRedraftRunner;
};

export type DatabaseContextCorrectionWorkerRuntime = {
  /** Stop future polls. A current leased redraft is allowed to finish safely. */
  stop(): void;
  /** Trigger an immediate single-flight production drain (primarily operational/test use). */
  runNow(): Promise<void>;
};

export type DatabaseContextCorrectionWorkerRuntimeOptions = {
  /** Poll cadence for retry_waiting and recovered abandoned jobs. */
  pollIntervalMs?: number;
  /** Observability hook for factory/poll failures that escaped job-level retry handling. */
  onError?: (error: unknown) => void;
};

const contextCorrectionPollIntervalMs = 5_000;

export class ItotoriInvalidAuthSessionError extends Error {
  override readonly name = "ItotoriInvalidAuthSessionError";

  constructor() {
    super("invalid or expired auth session");
  }
}

export async function migrateItotoriDatabase(databaseUrl = databaseUrlFromEnv()): Promise<void> {
  await migrate(databaseUrl);
}

type BatchPlannerLoaderDeps = {
  styleGuideRepository: ItotoriStyleGuideRepository;
  terminologyRepository: ItotoriTerminologyRepository;
};

/**
 * Default DB-backed context loader for the batch planner CLI. This minimal
 * implementation pulls the locale-branch's current source revision and the
 * latest style guide rules. Glossary, scene summary, and character map
 * inputs default to empty here — programmatic callers (services that want
 * richer context) should call {@link planBatches} directly with the inputs
 * they have, and richer DB loaders can be added in follow-up nodes.
 */
function createBatchPlannerContextLoader(deps: BatchPlannerLoaderDeps): PlanBatchesContextLoader {
  return async (project: PlannedProjectFile, _locale: string) => {
    const context = await deps.styleGuideRepository.getLocaleBranchContext(
      project.projectId,
      project.localeBranchId,
    );
    if (context === null) {
      throw new Error(
        `locale branch ${project.localeBranchId} does not exist for project ${project.projectId}`,
      );
    }
    const approved = await deps.styleGuideRepository.getApprovedVersionByLocaleBranchId(
      project.localeBranchId,
    );
    const styleGuide = approved
      ? {
          styleGuideVersionId: approved.styleGuideVersionId,
          rules: extractRulesFromPolicy(approved.policy),
        }
      : undefined;

    // The minimal default loader exposes only the surfaces that have stable
    // repository APIs today. Programmatic callers needing glossary,
    // character map, scene summaries, or translation memory should pass
    // them directly to planBatches.
    const glossary: ReadonlyArray<TerminologyTermSnapshot> = [];
    return {
      sourceRevisionId: context.sourceRevisionReference.sourceRevisionId,
      glossary,
      styleGuide,
    };
  };
}

function extractRulesFromPolicy(policy: Record<string, unknown>): {
  ruleId: string;
  applicability: string;
  body?: string | undefined;
  rulePath?: string | undefined;
}[] {
  const rules = (policy as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    return [];
  }
  const out: {
    ruleId: string;
    applicability: string;
    body?: string | undefined;
    rulePath?: string | undefined;
  }[] = [];
  for (const entry of rules) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const ruleId = typeof record.ruleId === "string" ? record.ruleId : undefined;
    const applicability =
      typeof record.applicability === "string" ? record.applicability : "always_on";
    if (!ruleId) {
      continue;
    }
    out.push({
      ruleId,
      applicability,
      body: typeof record.body === "string" ? record.body : undefined,
      rulePath: typeof record.rulePath === "string" ? record.rulePath : undefined,
    });
  }
  return out;
}

async function loadBranchPolicySettings(input: {
  actor: AuthorizationActor;
  styleGuideRepository: ItotoriStyleGuideRepository;
  branchReferenceRepository: ItotoriBranchReferenceRepository;
  projectId: string;
  localeBranchId: string;
}): Promise<ApiBranchPolicySettingsResponse> {
  const context = await input.styleGuideRepository.getLocaleBranchContext(
    input.projectId,
    input.localeBranchId,
  );
  if (context === null) {
    throw new Error(
      `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
    );
  }
  const [latestVersion, approvedVersion, branchReference] = await Promise.all([
    input.styleGuideRepository.getLatestVersionByLocaleBranchId(input.localeBranchId),
    input.styleGuideRepository.getApprovedVersionByLocaleBranchId(input.localeBranchId),
    input.branchReferenceRepository.resolveBranchPolicyGlossaryReference(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    }),
  ]);
  const activeVersion = latestVersion ?? approvedVersion;
  return {
    schemaVersion: "itotori.settings.branch-policy.v0",
    projectId: context.projectId,
    localeBranchId: context.localeBranchId,
    targetLocale: context.targetLocale,
    sourceRevision: context.sourceRevisionReference,
    latestVersion: branchPolicyVersionBody(latestVersion),
    approvedVersion: branchPolicyVersionBody(approvedVersion),
    branchReference: branchPolicyReferenceBody(branchReference),
    policy:
      activeVersion === null
        ? emptyBranchPolicy()
        : branchPolicyPolicyBody(activeVersion.policy, activeVersion.styleGuideVersionId),
  };
}

function translationScopeSettingsResponseBody(
  record: TranslationScopeSettingsRecord,
): ApiTranslationScopeSettingsResponse {
  return {
    schemaVersion: "itotori.settings.translation-scope.v0",
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    scope: record.scope,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function localizationRunConfigResponseBody(
  record: LocalizationPassRunConfigRecord,
): ApiLocalizationRunConfigResponse {
  return {
    schemaVersion: "itotori.settings.localization-run-config.v0",
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    configPath: record.configPath,
    dataRoot: record.dataRoot,
    pairPolicyPath: record.pairPolicyPath,
    modelId: record.modelId,
    providerId: record.providerId,
    runDir: record.runDir,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function branchPolicyVersionBody(
  version: StyleGuideVersionRecord | null,
): ApiBranchPolicyVersion | null {
  if (version === null) {
    return null;
  }
  return {
    styleGuideVersionId: version.styleGuideVersionId,
    status: version.status,
    versionSequence: version.versionSequence,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    approvedAt: version.approvedAt?.toISOString() ?? null,
    policy: branchPolicyPolicyBody(version.policy, version.styleGuideVersionId),
  };
}

function branchPolicyReferenceBody(
  reference: BranchPolicyGlossaryReferenceRecord | null,
): ApiBranchPolicyGlossaryReference | null {
  if (reference === null) {
    return null;
  }
  return {
    referenceId: reference.referenceId,
    versionSequence: reference.versionSequence,
    styleGuideVersionId: reference.styleGuideVersionId,
    glossaryContentHash: reference.glossaryContentHash,
    glossaryTermCount: reference.glossaryTermRefs.length,
    glossaryReviewItemCount: reference.glossaryReviewItemRefs.length,
    updateReason: reference.updateReason,
    createdAt: reference.createdAt.toISOString(),
  };
}

function branchPolicyPolicyBody(
  policy: Record<string, unknown>,
  fallbackRulePrefix: string,
): ApiBranchPolicyPolicy {
  const sections = policy.sections;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
    return emptyBranchPolicy();
  }
  const record = sections as Record<string, unknown>;
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: {
      tone: branchPolicyRules(record.tone, `${fallbackRulePrefix}:tone`),
      terminology: branchPolicyRules(record.terminology, `${fallbackRulePrefix}:terminology`),
      honorifics: branchPolicyRules(record.honorifics, `${fallbackRulePrefix}:honorifics`),
      formatting: branchPolicyRules(record.formatting, `${fallbackRulePrefix}:formatting`),
      protectedSpans: branchPolicyRules(
        record.protectedSpans,
        `${fallbackRulePrefix}:protectedSpans`,
      ),
    },
  };
}

function branchPolicyRules(value: unknown, fallbackRulePrefix: string): ApiBranchPolicyRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const guidance = typeof record.guidance === "string" ? record.guidance.trim() : "";
    if (guidance.length === 0) {
      return [];
    }
    const ruleId =
      typeof record.ruleId === "string" && record.ruleId.trim().length > 0
        ? record.ruleId.trim()
        : `${fallbackRulePrefix}:${index + 1}`;
    return [{ ruleId, guidance }];
  });
}

function emptyBranchPolicy(): ApiBranchPolicyPolicy {
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: {
      tone: [],
      terminology: [],
      honorifics: [],
      formatting: [],
      protectedSpans: [],
    },
  };
}

export async function withDatabaseItotoriServices<T>(
  options: DatabaseServiceOptions,
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  const context = createDatabaseContext(options.databaseUrl);
  try {
    if (options.bootstrapLocalUser ?? true) {
      // The legacy single-user actor (direct grants) stays intact for
      // backward-compat, and the local operator is ALSO materialized as its
      // multi-user principal representation (auth-003). Both are idempotent.
      await bootstrapLocalUser(context.db);
      await bootstrapDefaultAccountPrincipal(context.db);
    }
    const localUserActor = await resolveDatabaseServiceActor(context.db, options);
    const projectRepository = new ItotoriProjectRepository(context.db);
    const feedbackRepository = new ItotoriFeedbackRepository(context.db);
    const reviewerQueueRepository = new ItotoriReviewerQueueRepository(context.db);
    const modelLedgerRepository = new ItotoriModelLedgerRepository(context.db);
    const modelRoutingSettingsRepository = new ItotoriModelRoutingSettingsRepository(context.db);
    const translationScopeSettingsRepository = new ItotoriTranslationScopeSettingsRepository(
      context.db,
    );
    const localizationPassRunConfigRepository = new ItotoriLocalizationPassRunConfigRepository(
      context.db,
    );
    const journalRepository = new ItotoriLocalizationJournalRepository(context.db);
    const catalogRepository = new ItotoriCatalogRepository(context.db);
    const catalogCrawlerRepository = new ItotoriCatalogCrawlerRepository(context.db);
    const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
    const styleGuideService = new ItotoriStyleGuideService(styleGuideRepository);
    const branchReferenceRepository = new ItotoriBranchReferenceRepository(context.db);
    const terminologyRepository = new ItotoriTerminologyRepository(context.db);
    const wikiContextRepository = new ItotoriWikiContextRepository(context.db);
    const exactSearchRepository = new ItotoriExactSearchDocumentRepository(context.db);
    const translationMemoryRepository = new ItotoriTranslationMemoryRepository(context.db);
    const translationMemoryService = new ItotoriTranslationMemoryService(
      translationMemoryRepository,
    );
    const translationBatchRepository = new ItotoriTranslationBatchRepository(context.db);
    const contextArtifactRepository = new ItotoriContextArtifactRepository(context.db);
    const sourceUnitRepository = new ItotoriSourceUnitRepository(context.db);
    const semanticContextReadRepository = new ItotoriSemanticContextReadRepository(context.db);
    const sceneCoverageRepository = new ItotoriSceneCoverageRepository(context.db);
    const engineCapabilityReportRepository = new EngineCapabilityReportRepository(context.db);
    const assetDecisionRepository = new ItotoriAssetLocalizationDecisionRepository(context.db);
    const authSsoSettingsRepository = new ItotoriAuthSsoSettingsRepository(context.db);
    const authMemberManagementRepository = new ItotoriAuthMemberManagementRepository(context.db);
    const authBillingSeatRepository = new ItotoriAuthBillingSeatRepository(context.db);
    const authSessionService = new ItotoriAuthSessionService(context.db);
    const principalRepository = new ItotoriPrincipalRepository(context.db);
    let actorPrincipalIdPromise: Promise<string> | undefined;
    const resolveActorPrincipalId = (): Promise<string> => {
      actorPrincipalIdPromise ??= resolveDatabaseServiceActorPrincipalId(
        principalRepository,
        localUserActor,
      );
      return actorPrincipalIdPromise;
    };
    const benchmarkRunRepository = new ItotoriBenchmarkRunRepository(context.db);
    // Physical attempt telemetry and the jobs run table both read the
    // durable journal. There is intentionally no draft-attempt ledger path.
    const telemetryQuery = new LedgerTelemetryQuery(journalRepository);
    const reviewerQueueApiService = new ReviewerQueueApiService({
      repository: {
        loadItemsByBranch: (localeBranchId) =>
          reviewerQueueRepository.loadItemsByBranch(localUserActor, localeBranchId),
        loadTransitionsByItem: (reviewItemId) =>
          reviewerQueueRepository.loadTransitionsByItem(localUserActor, reviewItemId),
        getItem: (reviewItemId) => reviewerQueueRepository.getItem(localUserActor, reviewItemId),
      },
      actionService: new ReviewerQueueActionService(reviewerQueueRepository),
    });
    // ITOTORI-118 — workspace mutation layer: durable correction edit history.
    const workspaceCorrectionRepository = new ItotoriWorkspaceCorrectionRepository(context.db);
    // ITOTORI-040 — read-oriented workspace composes existing read-model
    // ports; no direct DB access of its own.
    const workspaceApiService = new LocalizationWorkspaceApiService({
      readPort: {
        getDashboardStatus: () => projectRepository.getDashboardStatus(),
        listLocaleBranchIdentities: (projectId) =>
          projectRepository.listLocaleBranchIdentities(projectId),
        loadSceneSummaries: (query) =>
          semanticContextReadRepository.loadSceneSummaries(localUserActor, {
            ...query,
            includeStale: true,
          }),
        loadBridgeUnitsForSummary: (bridgeUnitIds) =>
          sourceUnitRepository.loadSourceUnits(localUserActor, { bridgeUnitIds }),
        loadActiveAssetDecisions: (projectId, localeBranchId) =>
          assetDecisionRepository.loadActiveDecisions(localUserActor, projectId, localeBranchId),
        loadCandidateAssets: (projectId, localeBranchId) =>
          assetDecisionRepository.loadCandidateAssets(localUserActor, projectId, localeBranchId),
        searchExact: (input) => exactSearchRepository.searchExact(localUserActor, input),
        searchTerminology: (input) => terminologyRepository.searchTerms(localUserActor, input),
        loadRunTable: (input) => journalRepository.loadJobsRunTable(localUserActor, input),
        loadReviewerDashboard: (input) => reviewerQueueApiService.loadDashboard(input),
        loadReviewItemIdsByBridgeUnit: (input) =>
          reviewerQueueApiService.loadReviewItemIdsByBridgeUnit(input),
        loadComparisonContext: (input) => reviewerQueueApiService.loadDetailContext(input),
      },
    });
    // Play-tester corrections retain a feedback audit row but intentionally do
    // not inject that feedback into a reviewer queue. The canonical context
    // service atomically versions + invalidates + enqueues; this production
    // factory owns the installed worker and drains it through the real
    // registered-pass redrafter before the request context closes.
    const eventQueueRepository = new ItotoriEventQueueRepository(context.db);
    const atomicContextCorrectionService = new ContextCorrectionService({
      actor: localUserActor,
      contextArtifacts: contextArtifactRepository,
    });
    const contextCorrectionWorker = new ContextCorrectionRerunWorker({
      queue: eventQueueRepository,
      // A queued worker is a privileged, installed service actor. The request
      // actor has already been authorized by the atomic correction write;
      // background draft/journal/queue actions must not inherit a narrowly
      // scoped feedback.import-only session.
      actor: defaultLocalUserActor,
      // Every short-lived request/poll factory gets a distinct lease owner.
      // A stale process must never be able to complete a later worker's lease
      // merely because both used a shared static id.
      workerId: `database-services-context-correction-rerun-worker-${randomUUID()}`,
      redrafter: new DbBackedContextCorrectionRedrafter({
        actor: defaultLocalUserActor,
        projectRepository,
        resolveRunConfig: (input) =>
          localizationPassRunConfigRepository.resolveRunConfig(
            input.projectId,
            input.localeBranchId,
          ),
        ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
        ...(options.contextCorrectionRedraftRunner !== undefined
          ? { runLive: options.contextCorrectionRedraftRunner }
          : {}),
      }),
      verifier: new DbBackedContextCorrectionRerunVerifier({
        actor: defaultLocalUserActor,
        projectRepository,
        journalRepository,
      }),
    });
    const contextCorrectionService: ContextCorrectionServicePort = {
      apply: async (input) => {
        const correction = await atomicContextCorrectionService.apply(input);
        // `drain` is intentionally awaited: this is the production handler
        // registration/drain point, not a test-only worker. It can reject for
        // an unexpected worker/DB failure; deliberately let that propagate
        // rather than converting it into a successful wiki receipt.
        await contextCorrectionWorker.runUntilIdle();
        // The aggregate worker result may include adjacent queue work, so read
        // the exact correction job before responding. Its durable state is the
        // only honest per-edit answer: retry_waiting/running stays pending and
        // a dead-lettered/cancelled redraft is failed, even though the canonical
        // version above correctly remains persisted.
        const redraftJob = await eventQueueRepository.getJob(
          defaultLocalUserActor,
          correction.redraftJob.jobId,
        );
        if (redraftJob === null) {
          throw new Error(
            `context correction ${correction.correctionId} lost its queued redraft job ${correction.redraftJob.jobId}`,
          );
        }
        return {
          ...correction,
          rerun: contextCorrectionRerunStatus(redraftJob),
        };
      },
      drain: async () => await contextCorrectionWorker.runUntilIdle(),
    };
    const wikiBrainService = new WikiBrainService({
      // Bind the actor once at composition time. All dashboard/API/CLI calls
      // use this exact node-6 projection rather than a separate wiki store.
      readRepository: {
        listEntries: (input) => wikiContextRepository.listEntries(localUserActor, input),
        showEntry: (input) => wikiContextRepository.showEntry(localUserActor, input),
        listEntryHistory: (input) => wikiContextRepository.listEntryHistory(localUserActor, input),
      },
      // The only mutation dependency is the installed node-8 service, which
      // atomically versions + invalidates + queues and drains the redraft.
      contextCorrections: contextCorrectionService,
    });
    const manualFeedbackService = new ManualFeedbackImportService(
      feedbackRepository,
      localUserActor,
      contextCorrectionService,
    );
    const workspaceCorrectionService = new WorkspaceCorrectionService({
      importPort: new ManualFeedbackImportService(feedbackRepository, localUserActor),
      // The correction service's edit-history port is write-only; reads of the
      // edit history bypass the service and hit
      // `ItotoriWorkspaceCorrectionRepository.loadCorrectionEditsByBranch` directly
      // (follow-on read-route gap; the DB capability is preserved unchanged).
      editRepository: {
        recordCorrectionEdit: (input) =>
          workspaceCorrectionRepository.recordCorrectionEdit(localUserActor, input),
      },
      comparisonPort: {
        loadComparisonContext: (input) => reviewerQueueApiService.loadDetailContext(input),
      },
      contextCorrections: contextCorrectionService,
    });
    const resultRevisionRepository = new ItotoriLocalizationResultRevisionRepository(
      context.db,
      new ProductionPlayTesterPatchArtifactMaterializer(),
    );
    const playTesterResultRevisionService = new PlayTesterResultRevisionService({
      repository: resultRevisionRepository,
    });
    return await callback({
      authorization: new ItotoriAuthorizationService(context.db, localUserActor),
      projectWorkflow: new ItotoriProjectWorkflowService(
        projectRepository,
        localUserActor,
        // itotori-db-draft-route-provider-not-wired — the draft model provider
        // is now WIRED LIVE (no longer `undefined`, which made `projects.draft`
        // throw `DraftProviderNotConfiguredError` against the live DB-backed
        // server). This is a DEFERRED, pinned-pair OpenRouter provider: the real
        // `OpenRouterModelProvider` (account-wide ZDR assertion + missing-key
        // refusal in its constructor, cost from real `usage.cost`) is built
        // LAZILY on the first draft, so opening these services for a read route
        // never requires an LLM key.
        createDbBackedDraftModelProvider(),
        modelLedgerRepository,
        translationMemoryService,
        undefined,
        journalRepository,
        // p3-wire-or-explicitly-retire-localizationpassdriverport — the pass
        // driver is now WIRED (no longer `undefined`, which made the Overview
        // "Launch pass" action throw `LocalizationPassDriverNotConfiguredError`).
        // It does a real DB branch-ownership read and returns an in-band DOMAIN
        // refusal for the pure-HTTP install (which carries no game bytes), rather
        // than a thrown misconfiguration; an install that registers a project's
        // data-root + pair-policy drives a real whole-project pass through it.
        createDbBackedLocalizationPassDriver({
          actor: localUserActor,
          projectRepository,
          resolveRunConfig: (input) =>
            localizationPassRunConfigRepository.resolveRunConfig(
              input.projectId,
              input.localeBranchId,
            ),
          runLive: createDbBackedLivePassRunner(),
        }),
        // p3-in-studio-decode-extract-trigger — the decode/extract runner is
        // WIRED (no longer omitted, which made `projects.decodeExtract` throw
        // `DecodeExtractNotConfiguredError`). It drives the REAL `kaifuu-cli
        // extract --engine reallive` decode path (identify -> inventory ->
        // extract, resolved + spawned through the ONE sanitized native-CLI
        // boundary) and hands the produced v0.2 bridge back for ingestion, so the
        // Studio "decode from game path" trigger replaces the manual bridge
        // upload. On an install with no native kaifuu-cli / game bytes the spawn
        // itself refuses LOUDLY (never a fabricated bridge).
        createDecodeExtractRunner(),
      ),
      manualFeedback: manualFeedbackService,
      draftFeedbackBatch: new DraftFeedbackBatchService(manualFeedbackService),
      catalogRepository: {
        catalogConflictReview: (filter) =>
          catalogRepository.catalogConflictReview(localUserActor, filter),
        catalogCompletenessBenchmarkPools: (filter) =>
          catalogRepository.catalogCompletenessBenchmarkPools(localUserActor, filter),
        catalogBenchmarkSeedFinder: (filter) =>
          catalogRepository.catalogBenchmarkSeedFinder(localUserActor, filter),
        catalogContextPanelForWork: (input) =>
          catalogRepository.catalogContextPanelForWork(localUserActor, input),
        catalogOpportunityRanking: (filter) =>
          catalogRepository.catalogOpportunityRanking(localUserActor, filter),
      },
      terminologyRepository: {
        searchTerms: (input) => terminologyRepository.searchTerms(localUserActor, input),
      },
      wiki: wikiBrainService,
      reviewerQueue: reviewerQueueApiService,
      workspace: workspaceApiService,
      workspaceCorrections: workspaceCorrectionService,
      contextCorrections: contextCorrectionService,
      playTesterResultRevision: bindPlayTesterResultRevisionService(
        playTesterResultRevisionService,
        localUserActor,
      ),
      exactSearch: {
        refreshDocuments: (input) => exactSearchRepository.refreshDocuments(localUserActor, input),
        searchExact: (input) => exactSearchRepository.searchExact(localUserActor, input),
      },
      catalogExactExternalIdLinker: new ItotoriCatalogExactExternalIdLinkerService(
        catalogRepository,
        localUserActor,
      ),
      catalogFuzzyCandidateGenerator: new ItotoriCatalogFuzzyCandidateGeneratorService(
        catalogRepository,
        localUserActor,
      ),
      catalogCrawlerRepository,
      catalogCrawlerRunner: new ItotoriCatalogCrawlerRunner(),
      styleGuideFixtureFlow: new ItotoriStyleGuideFixtureFlowService(
        projectRepository,
        styleGuideRepository,
        localUserActor,
      ),
      batchPlanner: {
        loadContext: createBatchPlannerContextLoader({
          styleGuideRepository,
          terminologyRepository,
        }),
        persist: async (batches, identity) => {
          await persistBatches(translationBatchRepository, localUserActor, batches, identity);
        },
      },
      sceneSummary: {
        // semantic-agent-cli-provider-run-not-reconciled — thread the
        // run-scoped `--provider-runs-dir` into the live provider as a
        // `LocalProviderRunArtifactRecorder(providerRunsDir)` so the standalone
        // CLI run's served (model, provider) pair + billed `usage.cost` + ZDR
        // posture are recorded into the reconciled telemetry surface the
        // reconciler reads — mirroring localize-project-stage-command.ts. The
        // resolver now REFUSES the live `openrouter` family without it (no
        // silent global `.tmp/provider-runs` default).
        cliDependencies: async (providerFamily, providerRunsDir) => ({
          actor: localUserActor,
          batchRepository: translationBatchRepository,
          sourceUnitRepository,
          contextArtifactRepository,
          provider: resolveSceneSummaryProvider(
            providerFamily,
            providerRunsDir === undefined
              ? undefined
              : { artifactRecorder: new LocalProviderRunArtifactRecorder(providerRunsDir) },
          ),
        }),
        // itotori-semantic-agent-clis-no-fake-context-on-real-path — the
        // production scene-summary wiring must NEVER default to a fake
        // provider. The old defaults (`fake` / `fake-fixture` /
        // `itotori-fake-scene-summary-v0`) meant `generate-scene-summaries`
        // silently populated REAL DB context artifacts with FAKE summaries
        // that then fed real translation prompts. The default family is now
        // the real production family (`openrouter`) with its intended
        // (modelId, providerId) pair. `resolveSceneSummaryProvider` now WIRES
        // that live path to the real, ZDR-gated `OpenRouterModelProvider`
        // (config-driven pair, cost from real `usage.cost`; the account-wide
        // ZDR assertion + missing-key refusal fire in its constructor). A fake
        // provider is reachable only via the explicit
        // `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1` opt-in plus `--provider fake`
        // (test/dev), never as a production default.
        defaultModelId: "anthropic/claude-3-5-sonnet",
        defaultProviderId: "anthropic",
        defaultProviderFamily: "openrouter",
        defaultContextWindowTokens: 16000,
      },
      characterRelationship: {
        cliDependencies: async (providerFamily, providerRunsDir) => ({
          actor: localUserActor,
          contextArtifactRepository,
          provider: resolveCharacterRelationshipProvider(
            providerFamily,
            providerRunsDir === undefined
              ? undefined
              : { artifactRecorder: new LocalProviderRunArtifactRecorder(providerRunsDir) },
          ),
          loadInputContext: async (_actor, input) => {
            const units = await sourceUnitRepository.loadSourceUnitsForScope(localUserActor, {
              projectId: input.projectId,
              localeBranchId: input.localeBranchId,
            });
            return {
              units: units.map((unit) => ({
                bridgeUnitId: unit.bridgeUnitId,
                sourceUnitKey: unit.sourceUnitKey,
                sourceText: unit.sourceText,
                sourceHash: unit.sourceHash,
                ...(unit.speaker === null ? {} : { speaker: unit.speaker }),
              })),
              curatedCharacters: [],
              glossaryExcerpt: [],
            };
          },
        }),
        defaultModelId: "anthropic/claude-3-5-sonnet",
        defaultProviderId: "anthropic",
        defaultProviderFamily: "openrouter",
        defaultContextWindowTokens: 16000,
      },
      localizeProjectStage: {
        contextArtifactRepository,
        prepareContextScope: async (input) => {
          await projectRepository.importSourceBundle(input.actor, {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            targetLocale: input.targetLocale,
            drafts: {},
            bridge: input.bridge,
          });
        },
      },
      engineCapabilityReports: new EngineCapabilityReportService(
        engineCapabilityReportRepository,
        localUserActor,
      ),
      assetDecisions: {
        loadActiveDecisions: (projectId, localeBranchId, opts) =>
          assetDecisionRepository.loadActiveDecisions(
            localUserActor,
            projectId,
            localeBranchId,
            opts,
          ),
        loadCandidateAssets: (projectId, localeBranchId, opts) =>
          assetDecisionRepository.loadCandidateAssets(
            localUserActor,
            projectId,
            localeBranchId,
            opts,
          ),
        recordDecision: (input) => assetDecisionRepository.recordDecision(localUserActor, input),
      },
      telemetry: {
        query: telemetryQuery,
        actor: localUserActor,
      },
      queueHealth: {
        loadQueueHealth: (options) => eventQueueRepository.loadQueueHealth(localUserActor, options),
      },
      jobs: {
        loadRunTable: (options) => journalRepository.loadJobsRunTable(localUserActor, options),
      },
      benchmarkCockpit: {
        loadCockpit: (input) =>
          composeBmkCockpitReadModel({
            actor: localUserActor,
            repository: benchmarkRunRepository,
            ...input,
          }),
        loadHistory: (input) =>
          loadBmkCockpitRunHistory({
            actor: localUserActor,
            repository: benchmarkRunRepository,
            ...input,
          }),
      },
      authSsoSettings: {
        configureSettings: (input) =>
          authSsoSettingsRepository.configureSettings(localUserActor, input),
      },
      modelRouting: {
        loadSettings: (projectId) =>
          modelRoutingSettingsRepository.loadSettings(localUserActor, projectId),
        saveRoute: (input) => modelRoutingSettingsRepository.saveRoute(localUserActor, input),
      },
      branchPolicy: {
        loadSettings: (input) =>
          loadBranchPolicySettings({
            actor: localUserActor,
            styleGuideRepository,
            branchReferenceRepository,
            ...input,
          }),
        saveSettings: async (input) => {
          const submitted = await styleGuideService.submitVersion(localUserActor, {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            expectedPreviousVersionId: input.expectedPreviousVersionId,
            policy: input.policy,
          });
          if (submitted.status !== "created" || submitted.version === undefined) {
            throw new Error(
              `branch policy save rejected: ${submitted.diagnostics
                .map((entry) => entry.message)
                .join("; ")}`,
            );
          }
          await branchReferenceRepository.updateBranchPolicyGlossaryReference(localUserActor, {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            styleGuideVersionId: submitted.version.styleGuideVersionId,
            updateReason: input.updateReason,
            metadata: { source: "settings.branch-policy" },
          });
          return loadBranchPolicySettings({
            actor: localUserActor,
            styleGuideRepository,
            branchReferenceRepository,
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
          });
        },
      },
      translationScope: {
        loadSettings: async (input) =>
          translationScopeSettingsResponseBody(
            await translationScopeSettingsRepository.loadSettings(localUserActor, input),
          ),
        saveSettings: async (input) =>
          translationScopeSettingsResponseBody(
            await translationScopeSettingsRepository.saveSettings(localUserActor, {
              projectId: input.projectId,
              localeBranchId: input.localeBranchId,
              scope: input.scope,
            }),
          ),
      },
      localizationRunConfig: {
        saveRunConfig: async (input) =>
          localizationRunConfigResponseBody(
            await localizationPassRunConfigRepository.saveRunConfig(localUserActor, input),
          ),
      },
      authMembers: {
        listMembers: (accountId) =>
          authMemberManagementRepository.listMembers(localUserActor, accountId),
        inviteMember: (input) => {
          const { reason, requestId, ...required } = input;
          return authMemberManagementRepository.inviteMember(localUserActor, {
            ...required,
            actorPrincipalId: localOperatorPrincipalId,
            expiresAt: new Date(input.expiresAt),
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
        },
        acceptInvitation: (invitationId, input) => {
          const { externalIdentity, reason, requestId, ...required } = input;
          return authMemberManagementRepository.acceptInvitation(localUserActor, {
            ...required,
            invitationId,
            actorPrincipalId: localOperatorPrincipalId,
            ...(externalIdentity === null ? {} : { externalIdentity }),
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
        },
        removeMember: (membershipId, input) => {
          const { reason, requestId } = input;
          return authMemberManagementRepository.removeMember(localUserActor, {
            membershipId,
            actorPrincipalId: localOperatorPrincipalId,
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
        },
      },
      authBilling: {
        loadSeatUsage: (accountId) =>
          authBillingSeatRepository.loadSeatUsage(localUserActor, accountId),
      },
      authPermissions: {
        listPermissionSets: (accountId) =>
          listAccountPermissionSets(context.db, localUserActor, accountId),
        grantPermissionSet: async ({ principalId, permissionSetId, request }) => {
          const { reason, requestId } = request;
          await principalRepository.grantPermissionSet(localUserActor, {
            actorPrincipalId: await resolveActorPrincipalId(),
            targetPrincipalId: principalId,
            permissionSetId,
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
          const accountId = await loadPermissionSetAccountId(
            context.db,
            localUserActor,
            permissionSetId,
          );
          return loadMemberByPrincipalId({
            accountId,
            principalId,
            listMembers: (id) => authMemberManagementRepository.listMembers(localUserActor, id),
          });
        },
        revokePermissionSet: async ({ principalId, permissionSetId, request }) => {
          const { reason, requestId } = request;
          const accountId = await loadPermissionSetAccountId(
            context.db,
            localUserActor,
            permissionSetId,
          );
          await principalRepository.revokePermissionSet(localUserActor, {
            actorPrincipalId: await resolveActorPrincipalId(),
            targetPrincipalId: principalId,
            permissionSetId,
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
          return loadMemberByPrincipalId({
            accountId,
            principalId,
            listMembers: (id) => authMemberManagementRepository.listMembers(localUserActor, id),
          });
        },
      },
      authSessions: {
        listPrincipalSessions: async (principalId) =>
          authSessionService.listPrincipalSessions(localUserActor, {
            actorPrincipalId: await resolveActorPrincipalId(),
            targetPrincipalId: principalId,
          }),
        revokePrincipalSession: async (principalId, sessionId, input) => {
          const { reason, requestId } = input;
          return authSessionService.revokePrincipalSession(localUserActor, {
            actorPrincipalId: await resolveActorPrincipalId(),
            targetPrincipalId: principalId,
            sessionId,
            ...(reason === null ? {} : { reason }),
            ...(requestId === null ? {} : { requestId }),
          });
        },
      },
      authIdentity: {
        loadIdentity: () => principalRepository.loadActorIdentity(localUserActor),
      },
      playRouteMap: new RouteMapReadModelService({
        contextArtifacts: semanticContextReadRepository,
      }),
      sceneCoverage: new SceneCoverageService({
        coverage: sceneCoverageRepository,
        contextArtifacts: semanticContextReadRepository,
      }),
    });
  } finally {
    await context.close();
  }
}

/**
 * Start the production retry/recovery lifecycle for context-correction jobs.
 *
 * Request-time `apply()` drains immediately for low latency, but it cannot
 * service a retry_waiting job after its backoff when no new request arrives.
 * This small single-flight poller repeatedly opens the normal DB service
 * composition, so it uses the same installed redrafter/verifier/worker as the
 * HTTP path and closes each DB context after the pass.
 */
export function startDatabaseContextCorrectionWorker(
  options: DatabaseServiceOptions,
  runtimeOptions: DatabaseContextCorrectionWorkerRuntimeOptions = {},
): DatabaseContextCorrectionWorkerRuntime {
  const pollIntervalMs = runtimeOptions.pollIntervalMs ?? contextCorrectionPollIntervalMs;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("context-correction worker pollIntervalMs must be a positive integer");
  }
  const onError =
    runtimeOptions.onError ??
    ((error: unknown) => {
      console.error(
        "context-correction production worker poll failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  // Never inherit a request session/actor into the background worker. The
  // worker itself uses its installed privileged actor; this factory actor is
  // only needed to build the surrounding application services.
  const workerServiceOptions: DatabaseServiceOptions = {
    ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
    bootstrapLocalUser: options.bootstrapLocalUser ?? false,
    ...(options.contextCorrectionRedraftRunner === undefined
      ? {}
      : { contextCorrectionRedraftRunner: options.contextCorrectionRedraftRunner }),
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runNow();
    }, pollIntervalMs);
    timer.unref();
  };

  const runNow = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const drain = withDatabaseItotoriServices(workerServiceOptions, async (services) => {
      await services.contextCorrections.drain();
    }).catch((error: unknown) => {
      onError(error);
    });
    inFlight = drain;
    try {
      await drain;
    } finally {
      // Retain the exact in-flight promise until it has settled. That keeps an
      // external/manual `runNow()` from starting a second worker in the tiny
      // completion window before this pass schedules its next tick.
      if (inFlight === drain) {
        inFlight = undefined;
        scheduleNext();
      }
    }
  };

  // Start immediately so jobs that predate server startup are recovered too.
  void runNow();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
    runNow,
  };
}

async function resolveDatabaseServiceActor(
  db: ItotoriDatabase,
  options: DatabaseServiceOptions,
): Promise<AuthorizationActor> {
  if (options.actor !== undefined) {
    return options.actor;
  }
  if (options.sessionId !== undefined && options.sessionId.trim() !== "") {
    const resolved = await new ItotoriAuthSessionService(db).resolveActorFromSessionId(
      options.sessionId,
    );
    if (resolved === null) {
      throw new ItotoriInvalidAuthSessionError();
    }
    return resolved.actor;
  }
  return defaultLocalUserActor;
}

async function resolveDatabaseServiceActorPrincipalId(
  principalRepository: ItotoriPrincipalRepository,
  actor: AuthorizationActor,
): Promise<string> {
  const identity = await principalRepository.loadActorIdentity(actor);
  if (identity.principalId === null) {
    throw new Error(`authenticated actor ${actor.userId} has no principal identity`);
  }
  return identity.principalId;
}

async function loadMemberByPrincipalId(input: {
  accountId: string;
  principalId: string;
  listMembers(accountId: string): Promise<readonly MemberRecord[]>;
}): Promise<MemberRecord> {
  const members = await input.listMembers(input.accountId);
  const member = members.find((entry) => entry.principalId === input.principalId);
  if (member === undefined) {
    throw new Error(`principal ${input.principalId} is not a member of account ${input.accountId}`);
  }
  return member;
}

/**
 * Project the exact durable redraft job into the receipt returned to a wiki
 * caller. `runUntilIdle()` reports a batch aggregate; this job record supplies
 * the per-correction truth without attributing an adjacent correction's
 * failure or lease loss to this receipt.
 */
function contextCorrectionRerunStatus(job: JobQueueRecord): ContextCorrectionRerunStatus {
  switch (job.status) {
    case "succeeded":
      return { state: "succeeded", jobStatus: "succeeded", error: null };
    case "queued":
    case "running":
    case "retry_waiting":
      return { state: "pending", jobStatus: job.status, error: job.lastError };
    case "dead_letter":
    case "cancelled":
      return { state: "failed", jobStatus: job.status, error: job.lastError };
  }
}
