import {
  ItotoriFeedbackRepository,
  ItotoriExactSearchDocumentRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  ItotoriCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  ItotoriCatalogRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  ItotoriStyleGuideFixtureFlowService,
  ItotoriStyleGuideRepository,
  ItotoriTerminologyRepository,
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
    });
  } finally {
    await context.close();
  }
}
