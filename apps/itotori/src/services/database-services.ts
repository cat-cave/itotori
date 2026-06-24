import {
  EngineCapabilityReportRepository,
  ItotoriFeedbackRepository,
  ItotoriExactSearchDocumentRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  ItotoriCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  ItotoriCatalogRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriSceneSummaryRepository,
  ItotoriStyleGuideFixtureFlowService,
  ItotoriStyleGuideRepository,
  ItotoriTerminologyRepository,
  ItotoriTranslationBatchRepository,
  ItotoriTranslationMemoryRepository,
  ItotoriTranslationMemoryService,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  migrate,
  type ItotoriCatalogExactExternalIdLinkerPort,
  type ItotoriCatalogFuzzyCandidateGeneratorPort,
  type ItotoriCatalogCrawlerRepositoryPort,
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
} from "@itotori/db";
import {
  EngineCapabilityReportService,
  type EngineCapabilityReportPort,
} from "./engine-capability-report.js";
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
import {
  ItotoriProjectWorkflowService,
  type ItotoriProjectWorkflowPort,
} from "./project-workflow.js";

export type ItotoriApplicationServices = {
  authorization: ItotoriAuthorizationPort;
  projectWorkflow: ItotoriProjectWorkflowPort;
  manualFeedback: ManualFeedbackImportPort;
  catalogRepository: {
    catalogConflictReview(
      filter?: CatalogConflictReviewFilter,
    ): Promise<CatalogConflictReviewReadModel>;
    catalogCompletenessBenchmarkPools(
      filter?: CatalogCompletenessPoolFilter,
    ): Promise<CatalogCompletenessBenchmarkPools>;
  };
  terminologyRepository: {
    searchTerms(input: TerminologySearchInput): Promise<TerminologySearchReadModel>;
  };
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
<<<<<<< HEAD
  sceneSummary: {
    cliDependencies(provider: ProviderFamily): Promise<SceneSummaryCliDependencies>;
    defaultModelId: string;
    defaultProviderFamily: ProviderFamily;
    defaultContextWindowTokens: number;
  };
=======
  engineCapabilityReports: EngineCapabilityReportPort;
>>>>>>> spec/kaifuu-053
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
<<<<<<< HEAD
    const sceneSummaryRepository = new ItotoriSceneSummaryRepository(context.db);
=======
    const engineCapabilityReportRepository = new EngineCapabilityReportRepository(context.db);
>>>>>>> spec/kaifuu-053
    return await callback({
      authorization: new ItotoriAuthorizationService(context.db, localUserActor),
      projectWorkflow: new ItotoriProjectWorkflowService(
        projectRepository,
        localUserActor,
        undefined,
        modelLedgerRepository,
        translationMemoryService,
      ),
      manualFeedback: new ManualFeedbackImportService(feedbackRepository, localUserActor),
      catalogRepository: {
        catalogConflictReview: (filter) =>
          catalogRepository.catalogConflictReview(localUserActor, filter),
        catalogCompletenessBenchmarkPools: (filter) =>
          catalogRepository.catalogCompletenessBenchmarkPools(localUserActor, filter),
      },
      terminologyRepository: {
        searchTerms: (input) => terminologyRepository.searchTerms(localUserActor, input),
      },
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
<<<<<<< HEAD
      sceneSummary: {
        cliDependencies: async (providerFamily) => ({
          actor: localUserActor,
          batchRepository: translationBatchRepository,
          summaryRepository: sceneSummaryRepository,
          provider: resolveSceneSummaryProvider(providerFamily),
        }),
        defaultModelId: "itotori-fake-scene-summary-v0",
        defaultProviderFamily: "fake",
        defaultContextWindowTokens: 16000,
      },
=======
      engineCapabilityReports: new EngineCapabilityReportService(
        engineCapabilityReportRepository,
        localUserActor,
      ),
>>>>>>> spec/kaifuu-053
    });
  } finally {
    await context.close();
  }
}
