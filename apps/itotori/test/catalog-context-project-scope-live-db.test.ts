import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectDashboardStatus } from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleItotoriApiRequest } from "../src/api-handlers.js";
import {
  type ItotoriApplicationServices,
  withDatabaseItotoriServices,
} from "../src/services/database-services.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

type CatalogContextProject = {
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
};

const localeBranchIdentity: (branch: ProjectDashboardStatus["localeBranches"][number]) => string = (
  branch,
) => branch.localeBranchId;
void localeBranchIdentity;

const requestedProject: CatalogContextProject = {
  projectId: "catalog-context-requested",
  localeBranchId: "catalog-context-requested-branch",
  targetLocale: "en-US",
};

const latestOtherProject: CatalogContextProject = {
  projectId: "catalog-context-latest-other",
  localeBranchId: "catalog-context-latest-other-branch",
  targetLocale: "de-DE",
};

postgresDescribe("catalog-context project scope", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("selects the requested locale branch by identity before loading catalog context", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        await seedProject(services, requestedProject);
        await seedProject(services, latestOtherProject);
        await markLatestProject(context, latestOtherProject);

        let catalogLookup: { workId: string; targetLanguage: string } | undefined;
        const response = await handleItotoriApiRequest(
          {
            method: "GET",
            pathname: `/api/projects/${requestedProject.projectId}/locale-branches/${requestedProject.localeBranchId}/catalog-context/catalog-work-requested`,
          },
          {
            ...services,
            authorization: { requirePermission: async () => undefined },
            catalogRepository: {
              ...services.catalogRepository,
              async catalogContextPanelForWork(input: { workId: string; targetLanguage: string }) {
                catalogLookup = input;
                return null;
              },
            },
          },
        );

        expect(response).toEqual({
          statusCode: 404,
          body: {
            code: "not_found",
            error: "catalog context for work catalog-work-requested was not found",
          },
        });
        expect(catalogLookup).toEqual({
          workId: "catalog-work-requested",
          targetLanguage: requestedProject.targetLocale,
        });
      });
    } finally {
      await context.close();
    }
  });
});

async function seedProject(
  services: ItotoriApplicationServices,
  project: CatalogContextProject,
): Promise<void> {
  await services.projectWorkflow.ensureRunProjectScope({
    projectId: project.projectId,
    localeBranchId: project.localeBranchId,
    sourceRevisionId: `${project.projectId}-revision`,
    sourceLocale: "ja-JP",
    targetLocale: project.targetLocale,
    engineFamily: "synthetic_fixture",
    sourceRoot: `/fixture/${project.projectId}/source`,
    buildRoot: `/fixture/${project.projectId}/build`,
    extractProfile: { surface: "catalog-context-project-scope" },
  });
}

async function markLatestProject(
  context: { pool: { query(text: string, values: unknown[]): Promise<unknown> } },
  project: CatalogContextProject,
): Promise<void> {
  await context.pool.query(
    `update itotori_projects set updated_at = now() + interval '1 hour' where project_id = $1`,
    [project.projectId],
  );
}
