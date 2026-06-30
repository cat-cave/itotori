import {
  EngineCapabilityReportRepository,
  ItotoriAssetLocalizationDecisionRepository,
  ItotoriDraftAttemptProviderLedgerRepository,
  ItotoriFeedbackRepository,
  ItotoriExactSearchDocumentRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  ItotoriCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  ItotoriCatalogRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriReviewerQueueRepository,
  ItotoriSceneSummaryRepository,
  ItotoriStyleGuideFixtureFlowService,
  ItotoriStyleGuideRepository,
  ItotoriTerminologyRepository,
  ItotoriTranslationBatchRepository,
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  ItotoriWorkspaceCorrectionRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  migrate,
  type ItotoriCatalogExactExternalIdLinkerPort,
  type ItotoriCatalogFuzzyCandidateGeneratorPort,
  type ItotoriCatalogCrawlerRepositoryPort,
  type CatalogBenchmarkSeedFinderFilter,
  type CatalogBenchmarkSeedFinderReadModel,
  type CatalogOpportunityRankingFilter,
  type CatalogOpportunityRankingReadModel,
  type CatalogConflictReviewFilter,
  type CatalogConflictReviewReadModel,
  type CatalogCompletenessBenchmarkPools,
  type CatalogCompletenessPoolFilter,
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
} from "@itotori/db";
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
import type { ProviderFamily } from "../providers/types.js";
import type {
  PlanBatchesContextLoader,
  PlanBatchesPersister,
  PlannedProjectFile,
} from "../batch-planner/cli.js";
import type { TerminologyTermSnapshot } from "../batch-planner/shapes.js";
import {
  ItotoriAuthorizationService,
  localUserActor,
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
  ItotoriProjectWorkflowService,
  type ItotoriProjectWorkflowPort,
} from "./project-workflow.js";
import { LedgerTelemetryQuery } from "../telemetry/queries-impl.js";
import type { TelemetryQuery } from "../telemetry/queries.js";
import type { AuthorizationActor } from "@itotori/db";

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
    catalogOpportunityRanking(
      filter?: CatalogOpportunityRankingFilter,
    ): Promise<CatalogOpportunityRankingReadModel>;
  };
  terminologyRepository: {
    searchTerms(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  };
  reviewerQueue: ReviewerQueueApiServicePort;
  workspace: LocalizationWorkspaceApiServicePort;
  workspaceCorrections: WorkspaceCorrectionServicePort;
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
    cliDependencies(provider: ProviderFamily): Promise<SceneSummaryCliDependencies>;
    defaultModelId: string;
    /** ITOTORI-220 — default providerId for the scene-summary model. */
    defaultProviderId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
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
   * over the draft-attempt provider ledger.
   */
  telemetry: {
    query: TelemetryQuery;
    actor: AuthorizationActor;
  };
};

export type ItotoriServiceFactory = <T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
) => Promise<T>;

export type DatabaseServiceOptions = {
  databaseUrl?: string;
  bootstrapLocalUser?: boolean;
};

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

export async function withDatabaseItotoriServices<T>(
  options: DatabaseServiceOptions,
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  const context = createDatabaseContext(options.databaseUrl);
  try {
    if (options.bootstrapLocalUser ?? true) {
      await bootstrapLocalUser(context.db);
    }
    const projectRepository = new ItotoriProjectRepository(context.db);
    const feedbackRepository = new ItotoriFeedbackRepository(context.db);
    const reviewerQueueRepository = new ItotoriReviewerQueueRepository(context.db);
    const modelLedgerRepository = new ItotoriModelLedgerRepository(context.db);
    const catalogRepository = new ItotoriCatalogRepository(context.db);
    const catalogCrawlerRepository = new ItotoriCatalogCrawlerRepository(context.db);
    const styleGuideRepository = new ItotoriStyleGuideRepository(context.db);
    const terminologyRepository = new ItotoriTerminologyRepository(context.db);
    const exactSearchRepository = new ItotoriExactSearchDocumentRepository(context.db);
    const translationMemoryRepository = new ItotoriTranslationMemoryRepository(context.db);
    const translationMemoryService = new ItotoriTranslationMemoryService(
      translationMemoryRepository,
    );
    const translationBatchRepository = new ItotoriTranslationBatchRepository(context.db);
    const sceneSummaryRepository = new ItotoriSceneSummaryRepository(context.db);
    const engineCapabilityReportRepository = new EngineCapabilityReportRepository(context.db);
    const assetDecisionRepository = new ItotoriAssetLocalizationDecisionRepository(context.db);
    const draftAttemptProviderLedgerRepository = new ItotoriDraftAttemptProviderLedgerRepository(
      context.db,
    );
    // ITOTORI-230 — modelLedgerRepository drives the
    // `countZdrEnforcedCallsByPair` query (reads routing_posture from
    // itotori_provider_runs). The draft-attempt port handles all the
    // cost / token / latency aggregates as before.
    const telemetryQuery = new LedgerTelemetryQuery(
      draftAttemptProviderLedgerRepository,
      modelLedgerRepository,
    );
    const manualFeedbackService = new ManualFeedbackImportService(
      feedbackRepository,
      localUserActor,
      reviewerQueueRepository,
    );
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
        loadSceneSummaries: (query) => sceneSummaryRepository.loadSummaries(localUserActor, query),
        loadBridgeUnitsForSummary: (bridgeUnitIds) =>
          sceneSummaryRepository.loadBridgeUnitsForSummary(localUserActor, { bridgeUnitIds }),
        loadActiveAssetDecisions: (projectId, localeBranchId) =>
          assetDecisionRepository.loadActiveDecisions(localUserActor, projectId, localeBranchId),
        loadCandidateAssets: (projectId, localeBranchId) =>
          assetDecisionRepository.loadCandidateAssets(localUserActor, projectId, localeBranchId),
        searchExact: (input) => exactSearchRepository.searchExact(localUserActor, input),
        searchTerminology: (input) => terminologyRepository.searchTerms(localUserActor, input),
        loadComparisonContext: (input) => reviewerQueueApiService.loadDetailContext(input),
      },
    });
    // ITOTORI-118 — the mutation service composes the feedback intake (so
    // corrections enter the same decision + targeted-rerun loop), the durable
    // edit-history repository, and the reviewer-detail comparison read-model
    // for the before/after preview. Repository calls are bound to the local
    // authorization actor, exactly like the read workspace.
    const workspaceCorrectionService = new WorkspaceCorrectionService({
      importPort: manualFeedbackService,
      editRepository: {
        recordCorrectionEdit: (input) =>
          workspaceCorrectionRepository.recordCorrectionEdit(localUserActor, input),
        loadCorrectionEditsByBranch: (localeBranchId) =>
          workspaceCorrectionRepository.loadCorrectionEditsByBranch(localUserActor, localeBranchId),
      },
      comparisonPort: {
        loadComparisonContext: (input) => reviewerQueueApiService.loadDetailContext(input),
      },
    });
    return await callback({
      authorization: new ItotoriAuthorizationService(context.db, localUserActor),
      projectWorkflow: new ItotoriProjectWorkflowService(
        projectRepository,
        localUserActor,
        undefined,
        modelLedgerRepository,
        translationMemoryService,
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
        catalogOpportunityRanking: (filter) =>
          catalogRepository.catalogOpportunityRanking(localUserActor, filter),
      },
      terminologyRepository: {
        searchTerms: (input) => terminologyRepository.searchTerms(localUserActor, input),
      },
      reviewerQueue: reviewerQueueApiService,
      workspace: workspaceApiService,
      workspaceCorrections: workspaceCorrectionService,
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
        cliDependencies: async (providerFamily) => ({
          actor: localUserActor,
          batchRepository: translationBatchRepository,
          summaryRepository: sceneSummaryRepository,
          provider: resolveSceneSummaryProvider(providerFamily),
        }),
        defaultModelId: "itotori-fake-scene-summary-v0",
        defaultProviderId: "fake-fixture",
        defaultProviderFamily: "fake",
        defaultContextWindowTokens: 16000,
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
    });
  } finally {
    await context.close();
  }
}
