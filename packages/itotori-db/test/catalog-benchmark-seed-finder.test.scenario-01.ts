import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { EngineCapabilityReportRepository } from "../src/repositories/engine-capability-report-repository.js";
import {
  type CatalogBenchmarkSeedFinderReadModel,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import {
  capabilityLevelValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

const publicSeedFinderFixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/catalog-benchmark-seeds/fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  expectedDefaultReadModel: Omit<CatalogBenchmarkSeedFinderReadModel, "generatedAt"> & {
    generatedAt: string;
  };
  publicLeakagePolicy: { forbiddenSubstrings: string[] };
};

import {
  recordCapabilityMatrices,
  recordAmbiguousAdapterWork,
  recordPatchOnlyCapabilityBait,
  recordSeedFinderCatalog,
  recordSeedFinderProvenance,
  hash,
} from "./catalog-benchmark-seed-finder.test.shared-01.js";
import {
  requiredTestRow,
  normalizeBenchmarkSeedReadModel,
} from "./catalog-benchmark-seed-finder.test.shared-02.js";
describe("catalogBenchmarkSeedFinder", () => {
  it("returns readiness-aware aggregate-safe benchmark seeds with deterministic ranking and filters", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordSeedFinderProvenance(repo);
      await recordCapabilityMatrices(capabilityRepo);
      const ids = await recordSeedFinderCatalog(repo, provenance);

      const readModel = await repo.catalogBenchmarkSeedFinder(localActor, { limit: 20 });
      expect(readModel.schemaVersion).toBe("catalog.benchmark_seed_finder.v0.1");
      expect(
        normalizeBenchmarkSeedReadModel(
          readModel,
          publicSeedFinderFixture.expectedDefaultReadModel.generatedAt,
        ),
      ).toEqual(publicSeedFinderFixture.expectedDefaultReadModel);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.noEnglishOwned);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.fanPartialIdentifyOnly);
      expect(readModel.rows.map((row) => row.workId)).toContain(ids.mtlPartialExtract);
      expect(readModel.rows.map((row) => row.workId)).not.toContain(ids.conflict);

      const rankedIds = readModel.rows.map((row) => row.workId);
      expect(rankedIds.indexOf(ids.noEnglishOwned)).toBeLessThan(
        rankedIds.indexOf(ids.fanPartialIdentifyOnly),
      );

      const noEnglishOwned = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.noEnglishOwned),
        "owned no-English seed",
      );
      expect(noEnglishOwned).toMatchObject({
        completenessPool: "no_english",
        decision: "seed",
        seedRank: 1,
        localOwnership: "owned",
        localEvidenceCount: 2,
        demandBucket: "very_high",
        readiness: {
          adapterId: "rpg-maker-mv",
          identify: "supported",
          inventory: "supported",
          extract: "supported",
          patch: "supported",
          helper: "unknown",
          runtime: "unknown",
        },
      });
      expect(noEnglishOwned.sourceIds).toEqual([
        {
          catalogSource: catalogSourceValues.dlsite,
          sourceId: "RJSEED001",
          externalIdKind: catalogExternalIdKindValues.storeProduct,
        },
      ]);
      expect(noEnglishOwned.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: catalogSourceValues.dlsite,
            sourceId: "RJSEED001",
            fixtureId: "catalog-benchmark-seeds/dlsite/RJSEED001.json",
            redactionClass: catalogRawContentRedactionClassValues.publicMetadata,
          }),
        ]),
      );
      expect(noEnglishOwned.explanationCodes).toEqual(
        expect.arrayContaining([
          "demand_bucket:very_high",
          "helper_readiness_unknown",
          "local_ownership:owned",
          "pool:no_english",
          "runtime_readiness_unknown",
        ]),
      );

      const fanPartial = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.fanPartialIdentifyOnly),
        "fan-partial row",
      );
      expect(fanPartial).toMatchObject({
        completenessPool: "fan_partial",
        decision: "candidate",
        demandBucket: "medium",
        readiness: expect.objectContaining({
          identify: "supported",
          inventory: "unsupported",
          extract: "unsupported",
          patch: "unsupported",
        }),
      });
      expect(fanPartial.explanationCodes).toEqual(
        expect.arrayContaining([
          "extract_readiness_unsupported",
          "identify_readiness_supported",
          "inventory_readiness_unsupported",
          "patch_readiness_unsupported",
        ]),
      );

      const mtlPartial = requiredTestRow(
        readModel.rows.filter((row) => row.workId === ids.mtlPartialExtract),
        "MTL partial row",
      );
      expect(mtlPartial).toMatchObject({
        completenessPool: "mtl_only",
        decision: "candidate",
        readiness: expect.objectContaining({ extract: "partial" }),
      });

      const extractReady = await repo.catalogBenchmarkSeedFinder(localActor, {
        minCapabilityLevel: capabilityLevelValues.extract,
        limit: 20,
      });
      expect(extractReady.rows.map((row) => row.workId)).toContain(ids.noEnglishOwned);
      expect(extractReady.rows.map((row) => row.workId)).not.toContain(ids.fanPartialIdentifyOnly);
      expect(extractReady.rows.map((row) => row.workId)).not.toContain(ids.mtlPartialExtract);

      const localOwned = await repo.catalogBenchmarkSeedFinder(localActor, {
        localOwnership: "owned",
        limit: 20,
      });
      expect(localOwned.rows.map((row) => row.workId)).toEqual([ids.noEnglishOwned]);

      const veryHighDemand = await repo.catalogBenchmarkSeedFinder(localActor, {
        demandBucket: "very_high",
        limit: 20,
      });
      expect(veryHighDemand.rows.map((row) => row.workId)).toEqual([ids.noEnglishOwned]);

      const noEnglish = await repo.catalogBenchmarkSeedFinder(localActor, {
        translationCompleteness: [catalogLanguageStatusValues.none],
        limit: 20,
      });
      expect(noEnglish.rows.every((row) => row.completenessPool === "no_english")).toBe(true);

      const patchOnlyBait = await recordPatchOnlyCapabilityBait(repo, provenance.dlsite);
      const strictCapabilityWindow = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["no_english"],
        minCapabilityLevel: capabilityLevelValues.patch,
        requiredCapabilities: [capabilityLevelValues.inventory, capabilityLevelValues.patch],
        adapterIds: ["patch-only-engine", "rpg-maker-mv"],
        limit: 1,
      });
      expect(strictCapabilityWindow.rows.map((row) => row.workId)).toEqual([ids.noEnglishOwned]);
      expect(strictCapabilityWindow.rows.map((row) => row.workId)).not.toContain(patchOnlyBait);

      const patchOnlyDiagnostics = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["no_english"],
        minCapabilityLevel: capabilityLevelValues.patch,
        requiredCapabilities: [capabilityLevelValues.inventory, capabilityLevelValues.patch],
        adapterIds: ["patch-only-engine"],
        includeDemoted: true,
        limit: 20,
      });
      expect(
        requiredTestRow(
          patchOnlyDiagnostics.rows.filter((row) => row.workId === patchOnlyBait),
          "patch-only capability bait",
        ),
      ).toMatchObject({
        decision: "excluded",
        explanationCodes: expect.arrayContaining([
          "excluded_required_capability_inventory_unsupported",
        ]),
      });
    } finally {
      await context.close();
    }
  });

  it("keeps conflicts and unrecorded rows explainable without leaking local corpus details", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordSeedFinderProvenance(repo);
      await recordCapabilityMatrices(capabilityRepo);
      const ids = await recordSeedFinderCatalog(repo, provenance);

      const withDemotions = await repo.catalogBenchmarkSeedFinder(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const conflict = requiredTestRow(
        withDemotions.rows.filter((row) => row.workId === ids.conflict),
        "demoted conflict row",
      );
      expect(conflict).toMatchObject({ decision: "demoted" });
      expect(conflict.explanationCodes).toEqual(
        expect.arrayContaining([`demoted_open_conflict:${ids.conflictId}`]),
      );

      const requestedConflict = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["conflict"],
        limit: 20,
      });
      expect(requestedConflict.rows).toEqual([
        expect.objectContaining({
          workId: ids.conflict,
          completenessPool: "conflict",
          decision: "seed",
          explanationCodes: expect.arrayContaining(["conflict_pool_requested"]),
        }),
      ]);

      const withExcluded = await repo.catalogBenchmarkSeedFinder(localActor, {
        provenanceRequired: true,
        includeDemoted: true,
        limit: 20,
      });
      const unrecorded = requiredTestRow(
        withExcluded.rows.filter((row) => row.workId === ids.unrecorded),
        "unrecorded row",
      );
      expect(unrecorded).toMatchObject({ decision: "excluded", provenance: [] });
      expect(unrecorded.explanationCodes).toEqual(
        expect.arrayContaining(["excluded_provenance_required", "unrecorded_or_local_only"]),
      );

      const publicPayload = JSON.stringify(withDemotions);
      for (const forbidden of publicSeedFinderFixture.publicLeakagePolicy.forbiddenSubstrings) {
        expect(publicPayload).not.toContain(forbidden);
      }
      expect(publicPayload).not.toMatch(/\/home|\/tmp|[A-Z]:\\\\|file:|\.zip/u);
      expect(publicPayload).not.toContain("private-story-title");
      expect(publicPayload).not.toContain("local-scan-entry-secret");
      expect(publicPayload).not.toContain("path_hash");
      expect(publicPayload).not.toContain("rawPayloadSecret");
      expect(publicPayload).not.toContain(hash("/home/private/RJSEED001.zip/story.ks"));
    } finally {
      await context.close();
    }
  });

  it("uses explicit adapter ids to avoid ambiguous normalized-prefix readiness matches", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const capabilityRepo = new EngineCapabilityReportRepository(context.db);
      const provenance = await recordSeedFinderProvenance(repo);
      await recordCapabilityMatrices(capabilityRepo);
      const ambiguousWorkId = await recordAmbiguousAdapterWork(repo, provenance.dlsite);

      const unscoped = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["no_english"],
        minCapabilityLevel: capabilityLevelValues.extract,
        limit: 20,
      });
      expect(
        requiredTestRow(
          unscoped.rows.filter((row) => row.workId === ambiguousWorkId),
          "unscoped ambiguous adapter row",
        ).readiness,
      ).toMatchObject({ adapterId: "ambiguous-engine-alpha", extract: "supported" });

      const betaScoped = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["no_english"],
        minCapabilityLevel: capabilityLevelValues.extract,
        adapterIds: ["ambiguous-engine-beta"],
        includeDemoted: true,
        limit: 20,
      });
      expect(
        requiredTestRow(
          betaScoped.rows.filter((row) => row.workId === ambiguousWorkId),
          "beta-scoped ambiguous adapter row",
        ),
      ).toMatchObject({
        decision: "excluded",
        readiness: expect.objectContaining({
          adapterId: "ambiguous-engine-beta",
          extract: "unsupported",
        }),
      });

      const stillAmbiguous = await repo.catalogBenchmarkSeedFinder(localActor, {
        pools: ["no_english"],
        minCapabilityLevel: capabilityLevelValues.extract,
        adapterIds: ["ambiguous-engine-alpha", "ambiguous-engine-beta"],
        includeDemoted: true,
        limit: 20,
      });
      expect(
        requiredTestRow(
          stillAmbiguous.rows.filter((row) => row.workId === ambiguousWorkId),
          "multi-adapter ambiguous row",
        ),
      ).toMatchObject({
        decision: "excluded",
        readiness: expect.objectContaining({ adapterId: null, extract: "unknown" }),
        explanationCodes: expect.arrayContaining([
          "readiness_adapter_unknown",
          "excluded_min_capability_extract_unknown",
        ]),
      });
    } finally {
      await context.close();
    }
  });
});
