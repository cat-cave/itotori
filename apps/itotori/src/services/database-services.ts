import {
  ItotoriFeedbackRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  ItotoriCatalogCrawlerRepository,
  ItotoriCatalogCrawlerRunner,
  ItotoriCatalogRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
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
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
  catalogFuzzyCandidateGenerator: ItotoriCatalogFuzzyCandidateGeneratorPort;
  catalogCrawlerRepository: ItotoriCatalogCrawlerRepositoryPort;
  catalogCrawlerRunner: ItotoriCatalogCrawlerRunner;
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
    return await callback({
      authorization: new ItotoriAuthorizationService(context.db, localUserActor),
      projectWorkflow: new ItotoriProjectWorkflowService(
        projectRepository,
        localUserActor,
        undefined,
        modelLedgerRepository,
      ),
      manualFeedback: new ManualFeedbackImportService(feedbackRepository, localUserActor),
      catalogRepository: {
        catalogConflictReview: (filter) =>
          catalogRepository.catalogConflictReview(localUserActor, filter),
        catalogCompletenessBenchmarkPools: (filter) =>
          catalogRepository.catalogCompletenessBenchmarkPools(localUserActor, filter),
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
    });
  } finally {
    await context.close();
  }
}
