import { AuthorizationActor, permissionValues, requirePermission } from "./dependencies.js";
import {
  CatalogAlphaBenchmarkOpportunityRanking,
  CatalogAlphaBenchmarkOpportunityRankingFilter,
  CatalogBenchmarkSeedFinderFilter,
  CatalogBenchmarkSeedFinderReadModel,
  CatalogCompletenessBenchmarkPools,
  CatalogCompletenessPoolFilter,
  CatalogContextPanelCatalogReadModel,
  CatalogOpportunityRankingFilter,
} from "./catalog-domain-03.js";
import {
  CatalogOpportunityRankingReadModel,
  ItotoriCatalogRepositoryPort,
} from "./catalog-domain-04.js";
import { readCatalogCompletenessBenchmarkPools } from "./catalog-domain-05.js";
import {
  readCatalogAlphaBenchmarkOpportunityRanking,
  readCatalogBenchmarkSeedFinder,
} from "./catalog-domain-06.js";
import { readCatalogContextPanelCatalogReadModel } from "./catalog-domain-07.js";
import {
  assertAlphaBenchmarkOpportunityRankingFilter,
  assertCompletenessPoolFilter,
  readCatalogOpportunityRanking,
} from "./catalog-domain-08.js";
import {
  assertBenchmarkSeedFinderFilter,
  assertCatalogOpportunityRankingFilter,
} from "./catalog-domain-09.js";
import { requiredString } from "./catalog-domain-22.js";
import { CatalogRepositoryScans } from "./catalog-repository-scans.js";

export class ItotoriCatalogRepository
  extends CatalogRepositoryScans
  implements ItotoriCatalogRepositoryPort
{
  async catalogCompletenessBenchmarkPools(
    actor: AuthorizationActor,
    filter: CatalogCompletenessPoolFilter = {},
  ): Promise<CatalogCompletenessBenchmarkPools> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogCompletenessBenchmarkPools(this.db, assertCompletenessPoolFilter(filter));
  }

  async catalogAlphaBenchmarkOpportunityRanking(
    actor: AuthorizationActor,
    filter: CatalogAlphaBenchmarkOpportunityRankingFilter = {},
  ): Promise<CatalogAlphaBenchmarkOpportunityRanking> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogAlphaBenchmarkOpportunityRanking(
      this.db,
      assertAlphaBenchmarkOpportunityRankingFilter(filter),
    );
  }

  async catalogBenchmarkSeedFinder(
    actor: AuthorizationActor,
    filter: CatalogBenchmarkSeedFinderFilter = {},
  ): Promise<CatalogBenchmarkSeedFinderReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogBenchmarkSeedFinder(this.db, assertBenchmarkSeedFinderFilter(filter));
  }

  async catalogContextPanelForWork(
    actor: AuthorizationActor,
    input: { workId: string; targetLanguage: string },
  ): Promise<CatalogContextPanelCatalogReadModel | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogContextPanelCatalogReadModel(this.db, {
      workId: requiredString(input.workId, "workId"),
      targetLanguage: requiredString(input.targetLanguage, "targetLanguage"),
    });
  }

  async catalogOpportunityRanking(
    actor: AuthorizationActor,
    filter: CatalogOpportunityRankingFilter = {},
  ): Promise<CatalogOpportunityRankingReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return readCatalogOpportunityRanking(this.db, assertCatalogOpportunityRankingFilter(filter));
  }
}
