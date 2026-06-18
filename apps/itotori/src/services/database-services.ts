import {
  ItotoriFeedbackRepository,
  ItotoriCatalogExactExternalIdLinkerService,
  ItotoriCatalogRepository,
  ItotoriModelLedgerRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  migrate,
  type ItotoriCatalogExactExternalIdLinkerPort,
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
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
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
    return await callback({
      authorization: new ItotoriAuthorizationService(context.db, localUserActor),
      projectWorkflow: new ItotoriProjectWorkflowService(
        projectRepository,
        localUserActor,
        undefined,
        modelLedgerRepository,
      ),
      manualFeedback: new ManualFeedbackImportService(feedbackRepository, localUserActor),
      catalogExactExternalIdLinker: new ItotoriCatalogExactExternalIdLinkerService(
        catalogRepository,
        localUserActor,
      ),
    });
  } finally {
    await context.close();
  }
}
