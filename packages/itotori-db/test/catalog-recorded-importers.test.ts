import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriCatalogCrawlerRepository } from "../src/repositories/catalog-crawler-repository.js";
import {
  catalogCompletenessPoolValues,
  catalogSeedReadinessExplanationMetadataKey,
  ItotoriCatalogRepository,
  type ItotoriCatalogRepositoryPort,
} from "../src/repositories/catalog-repository.js";
import {
  createRecordedCatalogCrawlerAdapter,
  ItotoriCatalogCrawlerRunner,
  type CatalogCrawlerAdapterStep,
  type CatalogCrawlerSourceAdapter,
  type RecordedCatalogCrawlerFixture,
} from "../src/services/catalog-crawler-runner.js";
import {
  catalogRecordedConfidenceForSourceFact,
  createCatalogRecordedImporterIngestStep,
  createCatalogRecordedImporterVerifier,
  createDlsiteRecordedStorefrontAdapter,
  createIgdbRecordedPlatformAdapter,
  type CatalogRecordedImporterFact,
  type CatalogRecordedPlatformFixture,
  createSteamRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
  createWikidataRecordedPlatformAdapter,
  mapDlsiteReleaseMappingsForRecordedResponse,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogConflicts,
  catalogConflictEvidence,
  catalogDemandFactKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogSeedOriginValues,
  catalogSeedStatusValues,
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogTranslationPortabilityValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");
const egsFixture = readFixture("egs-recorded-replay.json");
const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");
const igdbFixture = readPlatformFixture("igdb-platform-replay.json");
const wikidataFixture = readPlatformFixture("wikidata-platform-replay.json");

const DLSITE_FIXTURE_ID = "catalog-recorded-importer-dlsite-storefront-v0.1";
const DLSITE_SOURCE_REVISION = "dlsite-storefront-synthetic-2026-06-18";
const STEAM_FIXTURE_ID = "catalog-recorded-importer-steam-storefront-v0.1";
const STEAM_SOURCE_REVISION = "steam-storefront-synthetic-2026-06-18";

type StorefrontDriftExpectation = {
  code: CatalogRecordedStorefrontDiagnosticCode;
  fixtureId: string;
  sourceRevision: string;
  stepKey: string;
  sourceId: string;
  sourceField: string;
};

type StorefrontDriftCase = {
  name: string;
  mutate: (fixture: CatalogRecordedStorefrontFixture) => CatalogRecordedStorefrontFixture;
  expected: StorefrontDriftExpectation;
};

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.
const dlsiteUnsupportedShapeMatrix: readonly StorefrontDriftCase[] = [
  {
    name: "missing required title field",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.title;
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "title"),
  },
  {
    name: "missing workno identity",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.workno;
      delete response.payload.product_id;
      delete response.payload.id;
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "workno"),
  },
  {
    name: "workno mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      response.payload.workno = "RJ09999999";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "workno"),
  },
  {
    name: "missing translation_info tree",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      delete response.payload.translation_info;
      return fixture;
    },
    expected: dlsiteExpectation("unsupported_response_shape", 0, "translation_info"),
  },
  {
    name: "language_editions is not an array",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      record(response.payload.translation_info, "translation_info").language_editions =
        "not-an-array";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions"),
  },
  {
    name: "language edition entry is not an object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      editions[0] = "not-an-object";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions[0]"),
  },
  {
    name: "language edition status enum drift",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      record(editions[0], "language edition").status = "official-ish";
      return fixture;
    },
    expected: dlsiteExpectation("parse_drift", 0, "translation_info.language_editions[0].status"),
  },
  {
    name: "language edition confidence enum drift",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "DLsite response");
      const editions = dlsiteLanguageEditions(response.payload);
      record(editions[1], "language edition").confidence = "pretty_sure";
      return fixture;
    },
    expected: dlsiteExpectation(
      "parse_drift",
      1,
      "translation_info.language_editions[1].confidence",
    ),
  },
];

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.
const steamUnsupportedShapeMatrix: readonly StorefrontDriftCase[] = [
  {
    name: "unsuccessful response without delisted status",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "Steam response");
      delete record(response.payload["2100099"], "appdetails envelope").delisting_status;
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 1, "2100099.success"),
  },
  {
    name: "delisted response app id mismatch",
    mutate: (fixture) => {
      const response = required(fixture.responses[1], "Steam response");
      record(response.payload["2100099"], "appdetails envelope").steam_appid = "9999999";
      return fixture;
    },
    expected: steamExpectation("parse_drift", 1, "2100099.steam_appid"),
  },
  {
    name: "successful response missing data object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": { success: true } };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "2100010.data"),
  },
  {
    name: "multi-key appdetails envelope",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = {
        "2100010": { success: true, data: { steam_appid: 2100010, name: "Promise" } },
        "2100011": { success: false, delisting_status: "delisted" },
      };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "appdetails"),
  },
  {
    name: "envelope value is not an object",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": "not-an-object" };
      return fixture;
    },
    expected: steamExpectation("unsupported_response_shape", 0, "2100010"),
  },
  {
    name: "envelope key mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100011": { success: true, data: { steam_appid: 2100011 } } };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "2100011"),
  },
  {
    name: "data.steam_appid mismatched against fixture source id",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = {
        "2100010": { success: true, data: { steam_appid: 2100011, name: "Drifted" } },
      };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "data.steam_appid"),
  },
  {
    name: "successful response missing name field",
    mutate: (fixture) => {
      const response = required(fixture.responses[0], "Steam response");
      response.payload = { "2100010": { success: true, data: { steam_appid: 2100010 } } };
      return fixture;
    },
    expected: steamExpectation("parse_drift", 0, "name"),
  },
];

function dlsiteExpectation(
  code: CatalogRecordedStorefrontDiagnosticCode,
  responseIndex: number,
  sourceField: string,
): StorefrontDriftExpectation {
  const response = required(dlsiteFixture.responses[responseIndex], "DLsite response");
  return {
    code,
    fixtureId: DLSITE_FIXTURE_ID,
    sourceRevision: DLSITE_SOURCE_REVISION,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField,
  };
}

function steamExpectation(
  code: CatalogRecordedStorefrontDiagnosticCode,
  responseIndex: number,
  sourceField: string,
): StorefrontDriftExpectation {
  const response = required(steamFixture.responses[responseIndex], "Steam response");
  return {
    code,
    fixtureId: STEAM_FIXTURE_ID,
    sourceRevision: STEAM_SOURCE_REVISION,
    stepKey: response.stepKey,
    sourceId: response.sourceId,
    sourceField,
  };
}

function dlsiteLanguageEditions(payload: Record<string, unknown>): unknown[] {
  const translationInfo = record(payload.translation_info, "translation_info");
  return requiredArray(translationInfo.language_editions, "language_editions");
}

function captureStorefrontSemanticDiagnostic(
  build: () => unknown,
): CatalogRecordedStorefrontDiagnostic {
  try {
    build();
  } catch (error) {
    if (error instanceof CatalogRecordedStorefrontSemanticError) {
      return error.diagnostic;
    }
    throw error;
  }
  throw new Error("expected a CatalogRecordedStorefrontSemanticError to be thrown");
}

function assertCompleteStorefrontDiagnostic(
  diagnostic: CatalogRecordedStorefrontDiagnostic,
  expected: StorefrontDriftExpectation,
): void {
  expect(diagnostic.code).toBe(expected.code);
  expect(diagnostic.fixtureId).toBe(expected.fixtureId);
  expect(diagnostic.sourceRevision).toBe(expected.sourceRevision);
  expect(diagnostic.stepKey).toBe(expected.stepKey);
  expect(diagnostic.sourceId).toBe(expected.sourceId);
  expect(diagnostic.sourceField).toBe(expected.sourceField);
  expect(diagnostic.severity).toBe("error");
  // Every parse-drift case must carry the COMPLETE semantic metadata: a
  // diagnostic missing any of the five fields (empty/undefined) fails here.
  for (const field of [
    "fixtureId",
    "sourceRevision",
    "stepKey",
    "sourceId",
    "sourceField",
  ] as const) {
    expect(diagnostic[field], `diagnostic.${field} must be present`).toBeTruthy();
  }
}

describe("catalog recorded source importers", () => {
  it("imports VNDB dump facts with releases, language facts, source ids, and source-version provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, vndbFixture, "worker-vndb");

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "v1001",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1001"],
            alreadyImported: false,
          },
          {
            sourceId: "v1002",
            fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=vndb|sourceId=v1002"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2019,
      });
      expect(starlight?.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: "r5001",
            releaseTitle: "星影の約束",
            language: "ja-JP",
            editionName: "Japanese complete edition",
            milestone: "v1001",
            packageKind: catalogReleasePackageKindValues.installer,
          }),
          expect.objectContaining({
            sourceReleaseId: "r5002",
            releaseTitle: "Promise Under Starlight",
            releaseKind: "official_translation",
            language: "en-US",
            editionName: "English complete edition",
            milestone: "v1001",
            packageKind: catalogReleasePackageKindValues.installer,
          }),
        ]),
      );

      // VNDB milestone-like evidence is promoted to first-class release mappings
      // (same-milestone + translation parent-child), not left in a metadata blob.
      const r5001Id = starlight?.releases.find(
        (release) => release.sourceReleaseId === "r5001",
      )?.releaseId;
      const r5002Id = starlight?.releases.find(
        (release) => release.sourceReleaseId === "r5002",
      )?.releaseId;
      expect(starlight?.releaseMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: r5002Id,
            targetReleaseId: r5001Id,
            relationKind: catalogReleaseMappingKindValues.sameMilestoneAs,
          }),
          expect.objectContaining({
            sourceReleaseId: r5002Id,
            targetReleaseId: r5001Id,
            relationKind: catalogReleaseMappingKindValues.translationOf,
            portability: catalogTranslationPortabilityValues.likelyPortable,
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            parserVersion: "catalog-recorded-importers.v0.1",
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            parserVersion: "catalog-recorded-importers.v0.1",
          }),
        ]),
      );
      expect(starlight?.metadata).toMatchObject({
        sourceId: "v1001",
        sourceVersion: "vndb-dump-synthetic-2026-06-18",
        fixtureId: "catalog-recorded-importer-vndb-dump-v0.1",
        alternateTitles: ["星影の約束", "Promise Under Starlight"],
      });

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      expect(sourceExternalId).toMatchObject({
        catalogSource: "vndb",
        sourceId: "v1001",
      });
      expect(sourceExternalId?.metadata).toMatchObject({
        stableImportKey: result.replayValidation[0]?.stableImportKey,
        importTransactionId: result.replayValidation[0]?.stableImportKey,
      });

      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      // A recorded-fixture REPLAY (this import runs the crawler in
      // `recorded_fixture` mode) must persist its source provenance as
      // `recorded_fixture`, NOT `raw_cache`: fixture-replay evidence must never
      // masquerade as a live raw-cache crawl on the public explanation surface.
      expect(provenance).toMatchObject({
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "v1001",
        sourceVersion: "vndb-dump-synthetic-2026-06-18",
        requestId: "dump://vndb/vn+releases/v1001",
        ok: true,
      });

      const seedTargets = await services.catalogRepository.listSeedTargets(actor);
      expect(seedTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "vndb",
            sourceId: "v1001",
            seedOrigin: catalogSeedOriginValues.importer,
            sourceProvenanceId: sourceExternalId?.sourceProvenanceId,
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("stores recorded importer seed hints as inert and gates them out of benchmark selection until CATALOG-004 consumes them", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-seed-gating");

      // The recorded importer authored a seed HINT for v1001. It is persisted as
      // INERT evidence — carrying its source-fact provenance, but never directly
      // benchmark-selectable.
      const allSeeds = await services.catalogRepository.listSeedTargets(actor);
      const importerSeed = required(
        allSeeds.find(
          (seed) =>
            seed.sourceId === "v1001" && seed.seedOrigin === catalogSeedOriginValues.importer,
        ),
        "importer seed hint for v1001",
      );
      expect(importerSeed.status).toBe(catalogSeedStatusValues.inert);
      expect(importerSeed.sourceProvenanceId).not.toBeNull();

      // A raw importer hint is excluded from both the actionable pending set and
      // the benchmark-selectable candidate query.
      const pendingSeeds = await services.catalogRepository.listSeedTargets(
        actor,
        catalogSeedStatusValues.pending,
      );
      expect(pendingSeeds.map((seed) => seed.sourceId)).not.toContain("v1001");

      const selectableBefore =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      expect(selectableBefore.map((seed) => seed.sourceId)).not.toContain("v1001");

      // CATALOG-004 readiness filtering consumes the inert hint: it promotes the
      // same seed target (natural key preserved) to a selectable status and records
      // a readiness explanation, while preserving the source-fact provenance.
      await services.catalogRepository.recordSeedTarget(actor, {
        seedTargetId: importerSeed.seedTargetId,
        catalogSource: importerSeed.catalogSource,
        sourceId: importerSeed.sourceId,
        seedOrigin: importerSeed.seedOrigin,
        originRef: importerSeed.originRef ?? undefined,
        sourceProvenanceId: importerSeed.sourceProvenanceId ?? undefined,
        status: catalogSeedStatusValues.pending,
        priority: importerSeed.priority,
        metadata: {
          ...importerSeed.metadata,
          [catalogSeedReadinessExplanationMetadataKey]: {
            readiness: "supported",
            explanationCodes: ["readiness_adapter_supported"],
          },
        },
      });

      const selectableAfter =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      const selected = required(
        selectableAfter.find((seed) => seed.sourceId === "v1001"),
        "benchmark-selectable v1001 after CATALOG-004 consumption",
      );
      expect(selected.status).toBe(catalogSeedStatusValues.pending);
      expect(selected.metadata[catalogSeedReadinessExplanationMetadataKey]).toMatchObject({
        readiness: "supported",
      });
      expect(selected.sourceProvenanceId).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it("imports EGS (ErogameScape) SQL rows with game ids, JP score facts, DLsite links, and request provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runFixture(services, egsFixture, "worker-egs");

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "egs",
        "101001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "星影の約束",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        sourceId: "101001",
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18",
        requestIdentity:
          "POST /~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php sql=gamelist_by_id id=101001",
        erogamescape: {
          gameId: "101001",
          gamename: "星影の約束",
          brandname: "Fixture Circle",
          sellday: "2021-09-10",
          median: 82,
          count2: 64,
          dlsiteId: "RJ01111111",
        },
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "101001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "dlsite",
            sourceId: "RJ01111111",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
            metadata: expect.objectContaining({
              sourceField: "gamelist.dlsite_id",
              linkedFrom: "egs:101001",
            }),
          }),
        ]),
      );
      expect(
        starlight?.externalIds.filter(
          (externalId) =>
            externalId.catalogSource === "egs" &&
            externalId.externalIdKind === catalogExternalIdKindValues.storeProduct,
        ),
      ).toEqual([]);
      await expect(
        services.catalogRepository.getWorkByExternalId(
          actor,
          "dlsite",
          "RJ01111111",
          catalogExternalIdKindValues.storeProduct,
        ),
      ).resolves.toMatchObject({ workId: starlight?.workId });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            metadata: expect.objectContaining({
              assumption: "ErogameScape catalog row is Japanese-market source metadata",
            }),
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.unknown,
            confidence: catalogConfidenceValues.low,
          }),
        ]),
      );
      expect(starlight?.demandFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "egs",
            sourceId: "101001",
            factKind: catalogDemandFactKindValues.ratingSummary,
            factValue: {
              median: 82,
              count2: 64,
              audience: "ja-JP",
              scoreScale: "0-100",
            },
            metadata: expect.objectContaining({
              sourceField: "gamelist.median,count2",
              provenance: "ErogameScape Japanese-audience score",
            }),
          }),
        ]),
      );

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "egs",
        sourceId: "101001",
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18",
        requestId:
          "POST /~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php sql=gamelist_by_id id=101001",
        fetchedAt: new Date("2026-06-18T13:05:00.000Z"),
      });
    } finally {
      await context.close();
    }
  });

  it("guards CATALOG-011 EGS fixtures and spec text against Epic storefront semantics", () => {
    const fixtureText = readFixtureText("egs-recorded-replay.json");
    const platformLanguageConflictText = readFixtureText("platform-language-conflicts.json");
    const platformLanguageConflictFixture = JSON.parse(platformLanguageConflictText) as {
      cases: Array<{
        caseId: string;
        request: {
          candidateEvidence?: Array<{
            catalogSource?: string;
            sourceId?: string;
            externalIdKind?: string;
            statusScope?: string;
            platform?: string | null;
            evidenceRef?: string;
          }>;
        };
      }>;
    };
    const specDag = record(
      JSON.parse(readFileSync(new URL("../../../roadmap/spec-dag.json", import.meta.url), "utf8")),
      "spec DAG",
    );
    const catalog011Node = record(
      required(
        requiredArray(specDag.nodes, "spec DAG nodes").find(
          (node) => record(node, "spec DAG node").id === "CATALOG-011",
        ),
        "CATALOG-011 spec node",
      ),
      "CATALOG-011 spec node",
    );
    const catalog011AuditFocus = requiredArray(
      catalog011Node.audit_focus,
      "CATALOG-011 audit_focus",
    );
    const catalog011Text = [
      catalog011Node.title,
      catalog011Node.spec,
      catalog011Node.acceptance,
      ...catalog011AuditFocus,
    ].join("\n");

    const egsReleasePlatforms = egsFixture.steps.flatMap((step) =>
      step.facts.flatMap((fact) =>
        (fact.releases ?? [])
          .filter((release) => release.platform !== undefined)
          .map((release) => ({
            stepKey: step.stepKey,
            sourceReleaseId: release.sourceReleaseId,
            platform: release.platform,
          })),
      ),
    );
    expect(egsReleasePlatforms).toEqual([]);

    const egsConflictEvidence = platformLanguageConflictFixture.cases.flatMap((testCase) =>
      (testCase.request.candidateEvidence ?? [])
        .filter((evidence) => evidence.catalogSource === "egs")
        .map((evidence) => ({ caseId: testCase.caseId, ...evidence })),
    );
    expect(egsConflictEvidence.length).toBeGreaterThan(0);
    for (const evidence of egsConflictEvidence) {
      expect(evidence.sourceId).not.toMatch(/^prod-/u);
      expect(evidence.externalIdKind).toBe(catalogExternalIdKindValues.sourceRecord);
      expect(evidence.statusScope).toBe("work");
      expect(evidence.platform ?? null).toBeNull();
      expect(evidence.evidenceRef).not.toMatch(/product|locales/u);
    }

    for (const text of [fixtureText, platformLanguageConflictText, catalog011Text]) {
      expect(text).not.toContain("Epic Games Store");
      expect(text).not.toContain("GET /storefront/products");
      expect(text).not.toContain("catalogItemId");
      expect(text).not.toContain('"namespace"');
      expect(text).not.toContain('"slug"');
      expect(text).not.toContain("prod-moonlit-099");
      expect(text).not.toContain("egs.product.locales");
    }
    expect(fixtureText).not.toContain('"platform": "egs"');
    expect(fixtureText).toContain("sql_for_erogamer_form.php");
    expect(catalog011Text).toContain("ErogameScape");
  });

  it("imports DLsite recorded storefront responses with demand facts, translation metadata, and provenance diagnostics", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite",
      );

      expect(result).toMatchObject({
        fetchedSteps: 3,
        importedSteps: 3,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "RJ01111111",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=dlsite|sourceId=RJ01111111"],
            alreadyImported: false,
          },
          {
            sourceId: "RJ02222222",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=dlsite|sourceId=RJ02222222"],
            alreadyImported: false,
          },
          {
            sourceId: "RJ03333333",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=dlsite|sourceId=RJ03333333"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ01111111",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
        workKind: "ADV",
      });
      expect(starlight?.metadata).toMatchObject({
        storefront: "dlsite",
        workno: "RJ01111111",
        workType: "ADV",
        translationInfo: {
          original_workno: "RJ00001001",
          child_worknos: ["RJ01111111"],
        },
        demand: {
          dlCount: 18420,
          ratingSummary: { average: 4.72, count: 512 },
          ratingHistogram: { "5": 401 },
          wishlistCount: 9321,
          rankFacts: [{ scope: "daily", category: "ADV", rank: 8 }],
        },
        translationTree: {
          original: { workno: "RJ00001001", locale: "ja-JP" },
          translations: [{ workno: "RJ01111111", locale: "en-US" }],
        },
      });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "ja-JP",
            status: catalogLanguageStatusValues.officialFull,
            platform: "dlsite",
          }),
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "dlsite",
          }),
        ]),
      );

      const glass = await services.catalogRepository.getWorkByExternalId(
        actor,
        "dlsite",
        "RJ02222222",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(glass?.metadata).toMatchObject({
        storefront: "dlsite",
        demand: {
          dlCount: 640,
          ratingSummary: { average: 4.1, count: 27 },
          ratingHistogram: { "5": 13 },
        },
        diagnostics: [
          expect.objectContaining({
            code: "missing_demand_field",
            fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
            sourceRevision: "dlsite-storefront-synthetic-2026-06-18",
            sourceField: "demand.wishlist_count",
          }),
          expect.objectContaining({
            code: "missing_demand_field",
            sourceField: "demand.rank_facts",
          }),
        ],
      });

      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "dlsite",
        sourceId: "RJ01111111",
        requestId: "GET /maniax/work/=/product_id/RJ01111111.html?locale=en_US",
        sourceVersion: "dlsite-storefront-synthetic-2026-06-18",
        metadata: expect.objectContaining({
          fixtureId: "catalog-recorded-importer-dlsite-storefront-v0.1",
          sourceRevision: "dlsite-storefront-synthetic-2026-06-18",
          diagnostics: [],
        }),
      });
      expect(
        await services.crawlerRepository.getCheckpoint(actor, {
          catalogSource: "dlsite",
          adapterName: "dlsite-recorded-storefront-importer",
          partitionKey: "public-dlsite-storefront",
        }),
      ).toMatchObject({ lastStepKey: "dlsite-rj03333333-jp-recovered" });
      await expect(
        rateLimitByAdapter(context.pool, "dlsite-recorded-storefront-importer"),
      ).resolves.toMatchObject({
        catalog_source: "dlsite",
        remaining: 18,
        limit: 20,
        request_identity: "GET /maniax/work/=/product_id/RJ01111111.html?locale=en_US",
        metadata: { policy: "recorded-fixture", source: "dlsite" },
      });
      await expect(services.catalogRepository.listSeedTargets(actor)).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("imports Steam recorded storefront responses with locale metadata, package status, delisting status, and rate limits", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createSteamRecordedStorefrontAdapter(steamFixture),
        "worker-steam",
      );

      expect(result).toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "steam",
        "2100010",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        firstReleaseYear: 2021,
      });
      expect(starlight?.metadata).toMatchObject({
        storefront: "steam",
        appId: "2100010",
        packageStatus: "packages_recorded",
        packages: [710001, 710002],
        delistingStatus: "listed",
        localeMetadata: {
          parsedLocales: ["en-US", "ja-JP", "zh-Hans"],
        },
      });
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ language: "en-US", platform: "steam" }),
          expect.objectContaining({ language: "ja-JP", platform: "steam" }),
          expect.objectContaining({ language: "zh-Hans", platform: "steam" }),
        ]),
      );

      const delisted = await services.catalogRepository.getWorkByExternalId(
        actor,
        "steam",
        "2100099",
        catalogExternalIdKindValues.storeProduct,
      );
      expect(delisted).toMatchObject({
        canonicalTitle: "Moonlit Glass Journey",
        metadata: {
          storefront: "steam",
          appId: "2100099",
          packageStatus: "delisted",
          delistingStatus: "delisted",
        },
      });

      await expect(
        rateLimitByAdapter(context.pool, "steam-recorded-storefront-importer"),
      ).resolves.toMatchObject({
        catalog_source: "steam",
        remaining: 199,
        limit: 200,
        request_identity: "GET /api/appdetails?appids=2100010&cc=us&l=english",
        metadata: { policy: "recorded-fixture", source: "steam" },
      });
      const sourceExternalId = starlight?.externalIds.find(
        (externalId) => externalId.externalIdKind === catalogExternalIdKindValues.sourceRecord,
      );
      const provenance = await sourceProvenanceById(
        context.db,
        required(sourceExternalId?.sourceProvenanceId, "source provenance id"),
      );
      expect(provenance).toMatchObject({
        catalogSource: "steam",
        sourceId: "2100010",
        requestId: "GET /api/appdetails?appids=2100010&cc=us&l=english",
      });
      await expect(services.catalogRepository.listSeedTargets(actor)).resolves.toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("imports IGDB recorded platform releases and language facts with source provenance", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const result = await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb",
      );

      expect(result).toMatchObject({
        fetchedSteps: 1,
        importedSteps: 1,
        skippedSteps: 0,
        replayValidation: [
          {
            sourceId: "252001",
            fixtureId: "catalog-recorded-importer-igdb-platform-v0.1",
            factCount: 1,
            factIdentities: ["catalogSource=igdb|sourceId=252001"],
            alreadyImported: false,
          },
        ],
      });

      const starlight = await services.catalogRepository.getWorkByExternalId(
        actor,
        "igdb",
        "252001",
      );
      expect(starlight).toMatchObject({
        canonicalTitle: "Promise Under Starlight",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2021,
      });
      expect(starlight?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "igdb",
            sourceId: "252001",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
            confidence: catalogConfidenceValues.high,
          }),
          expect.objectContaining({
            catalogSource: "wikidata",
            sourceId: "Q130001",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
          }),
          expect.objectContaining({
            catalogSource: "steam",
            sourceId: "2100011",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
          }),
        ]),
      );
      expect(starlight?.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceReleaseId: "770001",
            platform: "pc",
            releaseYear: 2021,
            isOfficial: true,
          }),
        ]),
      );
      expect(starlight?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            statusScope: "platform",
            platform: "pc",
            confidence: catalogConfidenceValues.high,
          }),
        ]),
      );
      expect(starlight?.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: expect.stringContaining("IGDB reports official English"),
            metadata: expect.objectContaining({
              reasonCode: "official_english_platform_disagreement",
              severity: "warning",
            }),
          }),
        ]),
      );

      const pools = await services.catalogRepository.catalogCompletenessBenchmarkPools(actor, {
        targetLanguage: "en-US",
      });
      expect(pools.pools[catalogCompletenessPoolValues.noEnglish]).toHaveLength(0);
      expect(
        pools.pools[catalogCompletenessPoolValues.conflict].map((work) => work.workId),
      ).toEqual([required(starlight?.workId, "IGDB work id")]);
      expect(pools.publicReport.statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: catalogLanguageStatusValues.officialFull,
            factCount: 1,
          }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("imports Wikidata entity links, qualifier-backed language statements, and reviewable conflicts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-before-wikidata");
      const vndbBefore = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1002",
      );

      const result = await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata",
      );
      expect(result).toMatchObject({
        fetchedSteps: 1,
        importedSteps: 1,
        skippedSteps: 0,
      });

      const moon = await services.catalogRepository.getWorkByExternalId(
        actor,
        "wikidata",
        "Q130099",
      );
      expect(moon).toMatchObject({
        canonicalTitle: "Moonlit Glass Journey",
        originalLanguage: "ja-JP",
        firstReleaseYear: 2022,
      });
      expect(moon?.externalIds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogSource: "wikidata",
            sourceId: "Q130099",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
          }),
          expect.objectContaining({
            catalogSource: "igdb",
            sourceId: "252099",
            externalIdKind: catalogExternalIdKindValues.knowledgeBaseEntity,
          }),
          expect.objectContaining({
            catalogSource: "steam",
            sourceId: "2100998",
            externalIdKind: catalogExternalIdKindValues.storeProduct,
          }),
        ]),
      );
      expect(
        moon?.externalIds.some(
          (externalId) => externalId.catalogSource === "vndb" && externalId.sourceId === "v1002",
        ),
      ).toBe(false);
      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1002"),
      ).resolves.toMatchObject({ workId: vndbBefore?.workId });

      expect(moon?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "nintendo_switch",
            confidence: catalogConfidenceValues.medium,
            metadata: expect.objectContaining({
              qualifiers: expect.objectContaining({
                basis: "official platform language statement with platform qualifier",
              }),
            }),
          }),
        ]),
      );
      expect(moon?.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            summary: expect.stringContaining("Wikidata reports official English"),
          }),
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.externalId,
            summary: expect.stringContaining("links vndb v1002"),
            metadata: expect.objectContaining({
              reasonCode: "external_id_already_attached",
              linkedCatalogSource: "vndb",
            }),
          }),
        ]),
      );

      const conflictRows = await services.catalogRepository.catalogConflictReview(actor, {
        catalogRecordId: required(moon?.workId, "Wikidata work id"),
      });
      expect(conflictRows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            reasonCode: "official_english_platform_disagreement",
            sourceIds: expect.arrayContaining([{ catalogSource: "wikidata", sourceId: "Q130099" }]),
          }),
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.externalId,
            reasonCode: "external_id_already_attached",
          }),
        ]),
      );

      // Public explanation surface: the conflict-review provenance carries the
      // source RECORD KIND. Because both facts were imported by replaying a
      // recorded fixture (not a live crawl), every provenance entry must be
      // labelled `recorded_fixture` and NOT `raw_cache` — so a reviewer reading
      // the public explanation can tell replayed fixture evidence apart from
      // live raw-cache evidence.
      const conflictProvenanceKinds = conflictRows.rows.flatMap((row) =>
        row.provenance.map((entry) => entry.sourceRecordKind),
      );
      expect(conflictProvenanceKinds.length).toBeGreaterThan(0);
      expect(conflictProvenanceKinds).toContain(catalogSourceRecordKindValues.recordedFixture);
      expect(conflictProvenanceKinds).not.toContain(catalogSourceRecordKindValues.rawCache);

      const pools = await services.catalogRepository.catalogCompletenessBenchmarkPools(actor, {
        targetLanguage: "en-US",
      });
      expect(
        pools.pools[catalogCompletenessPoolValues.noEnglish].map((work) => work.workId),
      ).toEqual(expect.not.arrayContaining([moon?.workId]));
      expect(
        pools.pools[catalogCompletenessPoolValues.conflict].map((work) => work.workId),
      ).toEqual(expect.arrayContaining([required(moon?.workId, "Wikidata work id")]));
    } finally {
      await context.close();
    }
  });

  it("labels a live crawl as raw_cache and a recorded-fixture replay as recorded_fixture", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);

      // A LIVE crawl (default/live mode) persists its fetched cache as
      // `raw_cache` — genuine live raw-cache evidence.
      await services.runner.run(liveLikeCrawlAdapter("900001"), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-live-crawl",
        mode: "live",
      });
      // The SAME adapter run in `recorded_fixture` mode is a fixture replay and
      // must be marked `recorded_fixture`, not raw_cache.
      await services.runner.run(liveLikeCrawlAdapter("900002"), {
        repository: services.crawlerRepository,
        actor,
        workerId: "worker-fixture-replay",
        mode: "recorded_fixture",
      });

      const live = await provenanceBySourceId(context.db, "900001");
      const replay = await provenanceBySourceId(context.db, "900002");
      // Same public `sourceProvenanceFromRow` projection reads both rows; the
      // live crawl is NOT mislabeled and the fixture replay is clearly distinct.
      expect(live.sourceRecordKind).toBe(catalogSourceRecordKindValues.rawCache);
      expect(replay.sourceRecordKind).toBe(catalogSourceRecordKindValues.recordedFixture);
      expect(live.sourceRecordKind).not.toBe(replay.sourceRecordKind);
    } finally {
      await context.close();
    }
  });

  it("demotes recorded IGDB and Wikidata platform-language conflicts from alpha benchmark seeds", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-before-platform-ranking");
      const vndbNoEnglish = await services.catalogRepository.getWorkByExternalId(
        actor,
        "vndb",
        "v1002",
      );

      const before = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US" },
      );
      const beforeNoEnglish = required(
        before.rows.find((row) => row.workId === vndbNoEnglish?.workId),
        "VNDB no-English ranking row before platform imports",
      );
      expect(beforeNoEnglish).toMatchObject({
        candidatePool: catalogCompletenessPoolValues.noEnglish,
        decision: "seed",
        seedRank: 1,
        demotions: [],
      });

      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-platform-ranking",
      );
      await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata-platform-ranking",
      );

      const after = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US" },
      );
      const afterNoEnglish = required(
        after.rows.find((row) => row.workId === vndbNoEnglish?.workId),
        "VNDB no-English ranking row after platform imports",
      );
      expect(afterNoEnglish).toMatchObject({
        candidatePool: catalogCompletenessPoolValues.noEnglish,
        decision: "demoted",
        seedRank: null,
        explanation: expect.stringContaining("official_english_platform_disagreement"),
      });
      expect(afterNoEnglish.score).toBeLessThan(beforeNoEnglish.score);
      expect(afterNoEnglish.demotions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: "official_english_platform_disagreement",
            reasonDetail: expect.stringContaining("IGDB reports official English"),
            sourceIds: expect.arrayContaining([
              { catalogSource: "igdb", sourceId: "252001" },
              { catalogSource: "vndb", sourceId: "v1002" },
            ]),
            // CATALOG-089: demotion provenance names the ORIGINAL evidence source
            // for each evidence row (official IGDB + candidate VNDB), not collapsed
            // to the single importer-payload (IGDB) provenance.
            provenance: expect.arrayContaining([
              expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
              expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
            ]),
          }),
          expect.objectContaining({
            reasonCode: "official_english_platform_disagreement",
            reasonDetail: expect.stringContaining("Wikidata reports official English"),
            sourceIds: expect.arrayContaining([
              { catalogSource: "wikidata", sourceId: "Q130099" },
              { catalogSource: "vndb", sourceId: "v1002" },
            ]),
            provenance: expect.arrayContaining([
              expect.objectContaining({ catalogSource: "wikidata", sourceId: "Q130099" }),
              expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
            ]),
          }),
        ]),
      );

      const seedOnly = await services.catalogRepository.catalogAlphaBenchmarkOpportunityRanking(
        actor,
        { targetLanguage: "en-US", includeDemoted: false },
      );
      expect(seedOnly.rows.map((row) => row.workId)).toEqual(
        expect.not.arrayContaining([required(vndbNoEnglish?.workId, "VNDB no-English work id")]),
      );
    } finally {
      await context.close();
    }
  });

  it("preserves per-evidence sourceProvenanceId for platform-language conflict fixtures through storage and review", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      // Import the candidate source first so its provenance row exists, then the
      // official platform source whose recorded payload authors a platform-language
      // conflict citing the candidate as a cross-source evidence row.
      await runFixture(services, vndbFixture, "worker-vndb-before-per-evidence-provenance");
      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-per-evidence-provenance",
      );

      // The candidate VNDB source's stored external-id provenance — the ORIGINAL
      // source provenance the candidate evidence row must be attributed to.
      const vndbNoEnglish = required(
        await services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1002"),
        "VNDB no-English work",
      );
      const vndbExternalId = required(
        vndbNoEnglish.externalIds.find(
          (row) => row.catalogSource === "vndb" && row.sourceId === "v1002",
        ),
        "VNDB external id row",
      );
      const vndbProvenanceId = required(
        vndbExternalId.sourceProvenanceId,
        "VNDB source provenance id",
      );
      // The official IGDB source's importer-payload provenance.
      const igdbWork = required(
        await services.catalogRepository.getWorkByExternalId(actor, "igdb", "252001"),
        "IGDB work",
      );
      const igdbExternalId = required(
        igdbWork.externalIds.find(
          (row) => row.catalogSource === "igdb" && row.sourceId === "252001",
        ),
        "IGDB external id row",
      );
      const igdbProvenanceId = required(
        igdbExternalId.sourceProvenanceId,
        "IGDB source provenance id",
      );

      // Storage assertion: the IGDB-authored platform-language conflict's evidence
      // rows each carry their OWN sourceProvenanceId — the official IGDB row points
      // at the IGDB importer-payload provenance, and the candidate VNDB row points
      // at the ORIGINAL VNDB source provenance (not collapsed to IGDB).
      const evidenceRows = await context.db
        .select({
          conflictId: catalogConflictEvidence.conflictId,
          subjectKind: catalogConflictEvidence.subjectKind,
          subjectId: catalogConflictEvidence.subjectId,
          sourceProvenanceId: catalogConflictEvidence.sourceProvenanceId,
          metadata: catalogConflictEvidence.metadata,
        })
        .from(catalogConflictEvidence)
        .innerJoin(
          catalogConflicts,
          eq(catalogConflicts.conflictId, catalogConflictEvidence.conflictId),
        )
        .where(eq(catalogConflicts.conflictKind, catalogConflictKindValues.languageStatus));

      expect(evidenceRows.length).toBeGreaterThan(0);

      const evidenceProvenanceCatalogSources = await provenanceCatalogSourcesByIds(
        context.db,
        evidenceRows.map((row) => row.sourceProvenanceId).filter((id): id is string => id !== null),
      );
      const provenanceCatalogSources = evidenceRows
        .map((row) =>
          row.sourceProvenanceId === null
            ? null
            : (evidenceProvenanceCatalogSources.get(row.sourceProvenanceId) ?? null),
        )
        .filter((value): value is string => value !== null);
      // The original IGDB and VNDB evidence sources are both named in storage.
      expect(provenanceCatalogSources).toEqual(expect.arrayContaining(["igdb", "vndb"]));

      // The candidate VNDB evidence row carries the ORIGINAL VNDB source provenance,
      // NOT the IGDB importer-payload provenance; the official IGDB evidence row
      // carries the IGDB importer-payload provenance. The two rows carry DISTINCT
      // provenance — per-evidence provenance is preserved rather than collapsed to a
      // single importer-payload provenance. (The authoritative per-evidence source
      // attribution lives in the sourceProvenanceId column, so rows are identified by
      // their provenance, not the importer-stamped metadata.)
      const vndbCandidateEvidence = evidenceRows.find(
        (row) => row.sourceProvenanceId === vndbProvenanceId,
      );
      const igdbOfficialEvidence = evidenceRows.find(
        (row) => row.sourceProvenanceId === igdbProvenanceId,
      );
      expect(vndbCandidateEvidence).toBeDefined();
      expect(igdbOfficialEvidence).toBeDefined();
      expect(vndbCandidateEvidence?.sourceProvenanceId).toBe(vndbProvenanceId);
      expect(igdbOfficialEvidence?.sourceProvenanceId).toBe(igdbProvenanceId);
      expect(vndbCandidateEvidence?.sourceProvenanceId).not.toBe(
        igdbOfficialEvidence?.sourceProvenanceId,
      );

      // Review read model assertion: the platform-language conflict review row
      // surfaces BOTH the official IGDB and the original VNDB source provenance.
      const review = await services.catalogRepository.catalogConflictReview(actor, {});
      const languageConflictRow = required(
        review.rows.find((row) => row.conflictKind === catalogConflictKindValues.languageStatus),
        "platform-language conflict review row",
      );
      expect(languageConflictRow.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
          expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("reruns updated VNDB and EGS fixtures idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-initial");
      await runFixture(services, egsFixture, "worker-egs-initial");
      const initialCounts = await catalogCounts(context.pool);

      const noOp = await runFixture(services, vndbFixture, "worker-vndb-noop");
      expect(noOp).toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);

      const updatedVndb = withUpdatedFact(vndbFixture, "v1001", {
        sourceVersion: "vndb-dump-synthetic-2026-06-18-revision-2",
        canonicalTitle: "Promise Under Starlight HD",
        releaseTitle: "Promise Under Starlight HD",
      });
      const updatedEgs = withUpdatedFact(egsFixture, "101001", {
        sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18-revision-2",
        canonicalTitle: "星影の約束 改訂版",
        releaseTitle: "星影の約束 改訂版",
      });

      await expect(runFixture(services, updatedVndb, "worker-vndb-update")).resolves.toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      await expect(runFixture(services, updatedEgs, "worker-egs-update")).resolves.toMatchObject({
        fetchedSteps: 2,
        importedSteps: 2,
        skippedSteps: 0,
      });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);

      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1001"),
      ).resolves.toMatchObject({
        canonicalTitle: "Promise Under Starlight HD",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "Promise Under Starlight HD" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "vndb-dump-synthetic-2026-06-18-revision-2",
        }),
      });
      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "egs", "101001"),
      ).resolves.toMatchObject({
        canonicalTitle: "星影の約束 改訂版",
        releases: expect.arrayContaining([
          expect.objectContaining({ releaseTitle: "星影の約束 改訂版" }),
        ]),
        metadata: expect.objectContaining({
          sourceVersion: "egs-erogamescape-sql-synthetic-2026-06-18-revision-2",
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("reruns DLsite and Steam storefront adapters idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runStorefrontFixture(
        services,
        createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
        "worker-dlsite-initial",
      );
      await runStorefrontFixture(
        services,
        createSteamRecordedStorefrontAdapter(steamFixture),
        "worker-steam-initial",
      );
      const initialCounts = await catalogCounts(context.pool);

      await expect(
        runStorefrontFixture(
          services,
          createDlsiteRecordedStorefrontAdapter(dlsiteFixture),
          "worker-dlsite-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(
        runStorefrontFixture(
          services,
          createSteamRecordedStorefrontAdapter(steamFixture),
          "worker-steam-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);
    } finally {
      await context.close();
    }
  });

  it("reruns IGDB and Wikidata platform adapters idempotently without duplicate facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-initial",
      );
      await runStorefrontFixture(
        services,
        createWikidataRecordedPlatformAdapter(wikidataFixture),
        "worker-wikidata-initial",
      );
      const initialCounts = await catalogCounts(context.pool);

      await expect(
        runStorefrontFixture(
          services,
          createIgdbRecordedPlatformAdapter(igdbFixture),
          "worker-igdb-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(
        runStorefrontFixture(
          services,
          createWikidataRecordedPlatformAdapter(wikidataFixture),
          "worker-wikidata-noop",
        ),
      ).resolves.toMatchObject({ fetchedSteps: 0, importedSteps: 0, skippedSteps: 0 });
      await expect(catalogCounts(context.pool)).resolves.toEqual(initialCounts);
    } finally {
      await context.close();
    }
  });

  it("maps platform source confidence without upgrading weak Wikidata language statements", () => {
    expect(catalogRecordedConfidenceForSourceFact("igdb", "language_status")).toBe(
      catalogConfidenceValues.high,
    );
    expect(
      catalogRecordedConfidenceForSourceFact("wikidata", "language_status", {
        qualifierProvenance: "official platform qualifier",
      }),
    ).toBe(catalogConfidenceValues.medium);
    expect(catalogRecordedConfidenceForSourceFact("wikidata", "language_status")).toBe(
      catalogConfidenceValues.low,
    );
    expect(catalogRecordedConfidenceForSourceFact("wikidata", "external_id")).toBe(
      catalogConfidenceValues.high,
    );
  });

  describe("unsupported recorded storefront response shapes carry complete semantic diagnostics", () => {
    for (const driftCase of dlsiteUnsupportedShapeMatrix) {
      it(`DLsite ${driftCase.name} asserts full diagnostic metadata`, () => {
        const diagnostic = captureStorefrontSemanticDiagnostic(() =>
          createDlsiteRecordedStorefrontAdapter(driftCase.mutate(structuredClone(dlsiteFixture))),
        );
        assertCompleteStorefrontDiagnostic(diagnostic, driftCase.expected);
      });
    }

    for (const driftCase of steamUnsupportedShapeMatrix) {
      it(`Steam ${driftCase.name} asserts full diagnostic metadata`, () => {
        const diagnostic = captureStorefrontSemanticDiagnostic(() =>
          createSteamRecordedStorefrontAdapter(driftCase.mutate(structuredClone(steamFixture))),
        );
        assertCompleteStorefrontDiagnostic(diagnostic, driftCase.expected);
      });
    }
  });

  it("projects DLsite translation_info into first-class edition/milestone/mapping facts", () => {
    const response = required(dlsiteFixture.responses[0], "DLsite response");
    const { releases, releaseMappings, diagnostics } = mapDlsiteReleaseMappingsForRecordedResponse(
      dlsiteFixture,
      response,
    );

    // The two language_editions (RJ00001001 ja original + RJ01111111 en) become
    // two first-class releases carrying edition/milestone/package-kind columns —
    // NOT a single blob of translation_info metadata.
    expect(releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceReleaseId: "RJ00001001:dlsite",
          releaseKind: catalogReleaseKindValues.original,
          editionName: "Japanese",
          milestone: "RJ00001001",
          packageKind: catalogReleasePackageKindValues.dlsiteProduct,
          language: "ja-JP",
        }),
        expect.objectContaining({
          sourceReleaseId: "RJ01111111:dlsite",
          releaseKind: catalogReleaseKindValues.officialTranslation,
          editionName: "English",
          milestone: "RJ00001001",
          packageKind: catalogReleasePackageKindValues.dlsiteProduct,
          language: "en-US",
        }),
      ]),
    );

    // The parent-child translation edge becomes a first-class release mapping.
    expect(releaseMappings).toEqual([
      expect.objectContaining({
        sourceReleaseId: "RJ01111111:dlsite",
        targetReleaseId: "RJ00001001:dlsite",
        relationKind: catalogReleaseMappingKindValues.translationOf,
        portability: catalogTranslationPortabilityValues.likelyPortable,
      }),
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("emits an explicit unsupported-shape diagnostic for unmappable DLsite translation evidence", () => {
    const fixture = structuredClone(dlsiteFixture);
    const response = required(fixture.responses[0], "DLsite response");
    const editions = dlsiteLanguageEditions(response.payload);
    // A foreign-workno edition with an unrecognized translation_role cannot be
    // mapped to a known relation kind.
    record(editions[1], "language edition").workno = "RJ07777777";
    record(editions[1], "language edition").translation_role = "bespoke_remix";

    const { releaseMappings, diagnostics } = mapDlsiteReleaseMappingsForRecordedResponse(
      fixture,
      response,
    );

    // The unmappable edition is surfaced explicitly instead of silently dropped.
    expect(releaseMappings).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported_response_shape",
        severity: "warning",
        fixtureId: DLSITE_FIXTURE_ID,
        sourceRevision: DLSITE_SOURCE_REVISION,
        stepKey: response.stepKey,
        sourceId: response.sourceId,
        sourceField: "translation_info.language_editions[1].translation_role",
      }),
    ]);
  });

  it("preserves unmapped Steam locale diagnostics", async () => {
    const unknownSteamLocale = structuredClone(steamFixture);
    const unknownSteamLocaleResponse = required(unknownSteamLocale.responses[0], "Steam response");
    const appdetails = record(
      unknownSteamLocaleResponse.payload["2100010"],
      "Steam appdetails envelope",
    );
    const data = record(appdetails.data, "Steam appdetails data");
    data.supported_languages = "English<strong>*</strong>, Martian";
    const steps = await storefrontSteps(createSteamRecordedStorefrontAdapter(unknownSteamLocale));
    const step = required(steps[0], "Steam step");
    expect(step.metadata).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "parse_drift",
          fixtureId: "catalog-recorded-importer-steam-storefront-v0.1",
          sourceRevision: "steam-storefront-synthetic-2026-06-18",
          stepKey: "steam-2100010",
          sourceId: "2100010",
          sourceField: "data.supported_languages",
        }),
      ],
    });
    expect(step.facts[0]?.metadata).toMatchObject({
      localeMetadata: {
        parsedLocales: ["en-US"],
        unknownLocaleLabels: ["Martian"],
      },
    });
  });

  it("omits originalLanguage when IGDB and Wikidata payloads carry no language evidence", async () => {
    const igdbNoLanguage = structuredClone(igdbFixture);
    const igdbResponse = required(igdbNoLanguage.responses[0], "IGDB response");
    igdbResponse.payload = { ...igdbResponse.payload };
    delete igdbResponse.payload.language_supports;
    const igdbStep = required(
      (await storefrontSteps(createIgdbRecordedPlatformAdapter(igdbNoLanguage)))[0],
      "IGDB step",
    );
    const igdbFact = required(igdbStep.facts[0], "IGDB fact");
    expect(igdbFact.languageStatuses ?? []).toHaveLength(0);
    expect(igdbFact.originalLanguage).toBeUndefined();

    const wikidataNoLanguage = structuredClone(wikidataFixture);
    const wikidataResponse = required(wikidataNoLanguage.responses[0], "Wikidata response");
    const claims = record(wikidataResponse.payload.claims, "Wikidata claims");
    delete claims.language_statements;
    wikidataResponse.payload = { ...wikidataResponse.payload, claims };
    const wikidataStep = required(
      (await storefrontSteps(createWikidataRecordedPlatformAdapter(wikidataNoLanguage)))[0],
      "Wikidata step",
    );
    const wikidataFact = required(wikidataStep.facts[0], "Wikidata fact");
    expect(wikidataFact.languageStatuses ?? []).toHaveLength(0);
    expect(wikidataFact.originalLanguage).toBeUndefined();

    // Evidence-bearing payloads still carry the genuinely-known original language.
    const igdbWithLanguage = required(
      (await storefrontSteps(createIgdbRecordedPlatformAdapter(igdbFixture)))[0],
      "IGDB step",
    );
    expect(igdbWithLanguage.facts[0]?.originalLanguage).toBe("ja-JP");
  });

  it("verifies persisted fact identities reconstructed from data read back from the repository", async () => {
    const expectedFactIdentities = ["catalogSource=igdb|sourceId=252001"];
    const stableImportKey = "stable-import-key";
    const importTransactionId = "import-txn-1";
    const facts: CatalogRecordedImporterFact[] = [
      { sourceId: "252001", canonicalTitle: "Promise Under Starlight" },
    ];

    const buildVerifier = (persistedSourceId: string) =>
      createCatalogRecordedImporterVerifier({
        actor,
        catalogRepository: {
          getWorkByExternalId: () =>
            Promise.resolve({
              externalIds: [
                {
                  externalIdId: "ext-1",
                  workId: "work-1",
                  catalogSource: "igdb",
                  sourceId: persistedSourceId,
                  externalIdKind: catalogExternalIdKindValues.sourceRecord,
                  sourceProvenanceId: "prov-1",
                  confidence: catalogConfidenceValues.high,
                  discoveredAt: new Date(),
                  metadata: { stableImportKey, importTransactionId },
                },
              ],
            }),
        } as unknown as ItotoriCatalogRepositoryPort,
      });

    const context = {
      adapter: { catalogSource: "igdb" },
      stableImportKey,
      importTransactionId,
      expectedFactIdentities,
      facts,
      proof: {
        stableImportKey,
        strategy: "upsert",
        factCount: facts.length,
        factIdentities: expectedFactIdentities,
      },
    } as unknown as Parameters<ReturnType<typeof createCatalogRecordedImporterVerifier>>[0];

    // Persisted identity matches expectation -> evidence asserts persisted import.
    await expect(buildVerifier("252001")(context)).resolves.toMatchObject({ persisted: true });
    // Persisted sourceId diverges -> the now-genuine comparison can fail.
    expect(await buildVerifier("999999")(context)).toBeNull();
  });

  it("records untyped generic conflicts with a neutral conflict kind instead of languageStatus", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      const igdbWithGenericConflict = structuredClone(igdbFixture);
      const igdbResponse = required(igdbWithGenericConflict.responses[0], "IGDB response");
      const conflicts = requiredArray(igdbResponse.payload.conflicts, "IGDB conflicts");
      conflicts.push({
        summary: "Untyped catalog disagreement requires manual review",
        reason_code: "manual_review",
        severity: "warning",
      });
      igdbResponse.payload = { ...igdbResponse.payload, conflicts };

      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbWithGenericConflict),
        "worker-igdb-generic-conflict",
      );

      const work = await services.catalogRepository.getWorkByExternalId(actor, "igdb", "252001");
      const generic = required(
        work?.conflicts.find((conflict) =>
          conflict.summary.includes("Untyped catalog disagreement"),
        ),
        "generic conflict",
      );
      expect(generic.conflictKind).toBe(catalogConflictKindValues.unknown);
      expect(generic.conflictKind).not.toBe(catalogConflictKindValues.languageStatus);
    } finally {
      await context.close();
    }
  });
});

type Services = ReturnType<typeof servicesFor>;

function servicesFor(db: Parameters<typeof ItotoriCatalogRepository>[0]): {
  catalogRepository: ItotoriCatalogRepository;
  crawlerRepository: ItotoriCatalogCrawlerRepository;
  runner: ItotoriCatalogCrawlerRunner;
} {
  return {
    catalogRepository: new ItotoriCatalogRepository(db),
    crawlerRepository: new ItotoriCatalogCrawlerRepository(db),
    runner: new ItotoriCatalogCrawlerRunner(),
  };
}

async function runFixture(
  services: Services,
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(createRecordedCatalogCrawlerAdapter(fixture), {
    repository: services.crawlerRepository,
    actor,
    workerId,
    mode: "recorded_fixture",
    ingestStep: createCatalogRecordedImporterIngestStep({
      catalogRepository: services.catalogRepository,
      actor,
    }),
    verifyFactImport: createCatalogRecordedImporterVerifier({
      catalogRepository: services.catalogRepository,
      actor,
    }),
  });
}

async function runStorefrontFixture(
  services: Services,
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
  workerId: string,
) {
  return services.runner.run(adapter, {
    repository: services.crawlerRepository,
    actor,
    workerId,
    mode: "recorded_fixture",
    ingestStep: createCatalogRecordedImporterIngestStep({
      catalogRepository: services.catalogRepository,
      actor,
    }),
    verifyFactImport: createCatalogRecordedImporterVerifier({
      catalogRepository: services.catalogRepository,
      actor,
    }),
  });
}

async function storefrontSteps(
  adapter: CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact>,
): Promise<CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[]> {
  const steps: CatalogCrawlerAdapterStep<CatalogRecordedImporterFact>[] = [];
  for await (const step of adapter.steps({ checkpointCursor: null, mode: "recorded_fixture" })) {
    steps.push(step);
  }
  return steps;
}

async function sourceProvenanceById(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  id: string,
) {
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(eq(catalogSourceProvenance.sourceProvenanceId, id))
    .limit(1);
  return required(rows[0], `source provenance ${id}`);
}

async function provenanceBySourceId(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  sourceId: string,
) {
  const rows = await db
    .select()
    .from(catalogSourceProvenance)
    .where(eq(catalogSourceProvenance.sourceId, sourceId))
    .limit(1);
  return required(rows[0], `source provenance for sourceId ${sourceId}`);
}

// Resolve the catalogSource for each provenance id in `ids`, so tests can assert
// which original evidence source each stored conflict-evidence row points at.
async function provenanceCatalogSourcesByIds(
  db: Parameters<typeof ItotoriCatalogRepository>[0],
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      sourceProvenanceId: catalogSourceProvenance.sourceProvenanceId,
      catalogSource: catalogSourceProvenance.catalogSource,
    })
    .from(catalogSourceProvenance)
    .where(inArray(catalogSourceProvenance.sourceProvenanceId, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.sourceProvenanceId, row.catalogSource]));
}

// A minimal LIVE-style crawler adapter: unlike the recorded-fixture adapter it
// yields regardless of run mode, so the same adapter can be driven in `live`
// (raw_cache) and `recorded_fixture` (recorded_fixture) mode to prove the runner
// stamps the correct source provenance record kind for each.
function liveLikeCrawlAdapter(
  sourceId: string,
): CatalogCrawlerSourceAdapter<CatalogRecordedImporterFact> {
  return {
    catalogSource: "igdb",
    adapterName: `live-demo-${sourceId}`,
    adapterVersion: "v0.1",
    sourceVersion: "live-demo-source-2026-07-06",
    parserVersion: "live-demo-parser-2026-07-06",
    *steps() {
      yield {
        stepKey: `step-${sourceId}`,
        sourceId,
        requestIdentity: `https://api.igdb.com/v4/games/${sourceId}`,
        fetchedAt: "2026-07-06T00:00:00.000Z",
        checkpointCursor: null,
        payload: { id: sourceId, name: `Live demo ${sourceId}` },
        facts: [],
      };
    },
  };
}

async function catalogCounts(pool: {
  query<T extends object = object>(sql: string): Promise<{ rows: T[] }>;
}) {
  const result = await pool.query<{
    works: string;
    external_ids: string;
    releases: string;
    language_statuses: string;
    demand_facts: string;
    seed_targets: string;
  }>(`
    select
      (select count(*) from itotori_catalog_works)::text as works,
      (select count(*) from itotori_catalog_external_ids)::text as external_ids,
      (select count(*) from itotori_catalog_releases)::text as releases,
      (select count(*) from itotori_catalog_language_statuses)::text as language_statuses,
      (select count(*) from itotori_catalog_demand_facts)::text as demand_facts,
      (select count(*) from itotori_catalog_seed_targets)::text as seed_targets
  `);
  return result.rows[0];
}

async function rateLimitByAdapter(
  pool: {
    query<T extends object = object>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  },
  adapterName: string,
) {
  const result = await pool.query<{
    catalog_source: string;
    remaining: number | null;
    limit: number | null;
    request_identity: string | null;
    metadata: Record<string, unknown>;
  }>(
    `
      select catalog_source, remaining, "limit", request_identity, metadata
      from itotori_catalog_crawler_rate_limits
      where adapter_name = $1
      limit 1
    `,
    [adapterName],
  );
  return required(result.rows[0], `rate limit for ${adapterName}`);
}

function readFixture(name: string): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  return JSON.parse(
    readFixtureText(name),
  ) as RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>;
}

function readFixtureText(name: string): string {
  return readFileSync(
    new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
    "utf8",
  );
}

function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}

function readPlatformFixture(name: string): CatalogRecordedPlatformFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedPlatformFixture;
}

function withUpdatedFact(
  fixture: RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact>,
  sourceId: string,
  update: { sourceVersion: string; canonicalTitle: string; releaseTitle: string },
): RecordedCatalogCrawlerFixture<CatalogRecordedImporterFact> {
  const copy = structuredClone(fixture);
  copy.sourceVersion = update.sourceVersion;
  for (const step of copy.steps) {
    if (step.sourceId !== sourceId) {
      continue;
    }
    step.payload = { ...step.payload, updateRevision: update.sourceVersion };
    const fact = step.facts[0];
    if (fact === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no fact`);
    }
    fact.canonicalTitle = update.canonicalTitle;
    const release = fact.releases?.at(-1);
    if (release === undefined) {
      throw new Error(`fixture step ${step.stepKey} has no release`);
    }
    release.releaseTitle = update.releaseTitle;
  }
  return copy;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`);
  }
  return value;
}
