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
} from "./catalog-read-model-types.js";
import {
  CatalogOpportunityRankingReadModel,
  ItotoriCatalogRepositoryPort,
} from "./catalog-repository-port-and-enums.js";
import { readCatalogCompletenessBenchmarkPools } from "./catalog-conflict-completeness-read.js";
import {
  readCatalogAlphaBenchmarkOpportunityRanking,
  readCatalogBenchmarkSeedFinder,
} from "./catalog-benchmark-read.js";
import { readCatalogContextPanelCatalogReadModel } from "./catalog-completeness-helpers.js";
import {
  assertAlphaBenchmarkOpportunityRankingFilter,
  assertCompletenessPoolFilter,
  readCatalogOpportunityRanking,
} from "./catalog-completeness-filters.js";
import {
  assertBenchmarkSeedFinderFilter,
  assertCatalogOpportunityRankingFilter,
} from "./catalog-benchmark-ranking.js";
import { requiredString } from "../../required-string.js";
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
