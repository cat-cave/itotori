import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import {
  createIgdbRecordedPlatformAdapter,
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConflictKindValues,
  catalogConflicts,
  catalogConflictEvidence,
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

import {
  servicesFor,
  runFixture,
  runStorefrontFixture,
  provenanceCatalogSourcesByIds,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  readFixture,
  readStorefrontFixture,
  readPlatformFixture,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
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
});
