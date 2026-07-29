import { describe, expect, it } from "vitest";

import {
  catalogRecordedConfidenceForSourceFact,
  createDlsiteRecordedStorefrontAdapter,
  createSteamRecordedStorefrontAdapter,
  type CatalogRecordedStorefrontDiagnostic,
  type CatalogRecordedStorefrontDiagnosticCode,
  type CatalogRecordedStorefrontFixture,
  CatalogRecordedStorefrontSemanticError,
  mapDlsiteReleaseMappingsForRecordedResponse,
} from "../src/services/catalog-recorded-importers.js";
import {
  catalogConfidenceValues,
  catalogReleaseKindValues,
  catalogReleaseMappingKindValues,
  catalogReleasePackageKindValues,
  catalogTranslationPortabilityValues,
} from "../src/schema.js";

const dlsiteFixture = readStorefrontFixture("dlsite-storefront-replay.json");
const steamFixture = readStorefrontFixture("steam-storefront-replay.json");

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

import { storefrontSteps } from "./catalog-recorded-importers.test.shared-01.js";
import {
  readStorefrontFixture,
  record,
  requiredArray,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
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
});
