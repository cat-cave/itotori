import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { type ItotoriCatalogRepositoryPort } from "../src/repositories/catalog-repository.js";

import {
  createCatalogRecordedImporterVerifier,
  createIgdbRecordedPlatformAdapter,
  type CatalogRecordedImporterFact,
  createWikidataRecordedPlatformAdapter,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogConflictKindValues,
  catalogExternalIdKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const igdbFixture = readPlatformFixture("igdb-platform-replay.json");
const wikidataFixture = readPlatformFixture("wikidata-platform-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runStorefrontFixture,
  storefrontSteps,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  readPlatformFixture,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
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
