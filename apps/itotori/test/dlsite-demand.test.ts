import { readFileSync } from "node:fs";
import {
  catalogDemandFactKindValues,
  createDlsiteRecordedStorefrontAdapter,
  mapDlsiteDemandFactsForRecordedResponse,
  type CatalogRecordedStorefrontFixture,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

const fixture = readStorefrontFixture("dlsite-storefront-replay.json");
const parseDriftFixture = readStorefrontFixture("dlsite-demand-parse-drift-replay.json");

describe("dlsite-demand recorded fixture mapper", () => {
  it("maps recorded DLsite demand fields into typed facts with source diagnostics", () => {
    const normal = responseBySourceId(fixture, "RJ01111111");
    const mapped = mapDlsiteDemandFactsForRecordedResponse(fixture, normal);

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.dlCount,
          factValue: { count: 18420 },
          metadata: expect.objectContaining({ sourceField: "dl_count", workno: "RJ01111111" }),
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.ratingSummary,
          factValue: { average: 4.72, count: 512 },
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.ratingHistogram,
          factValue: expect.objectContaining({ "5": 401 }),
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.wishlistCount,
          factValue: { count: 9321 },
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.rank,
          factValue: expect.objectContaining({ scope: "daily", rank: 8 }),
          observedAt: "2026-06-18",
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.workType,
          factValue: { workType: "ADV" },
        }),
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.translationTree,
          factValue: expect.objectContaining({ original_workno: "RJ00001001" }),
        }),
      ]),
    );
  });

  it("accepts valid rank observed_at date-time strings", () => {
    const normal = structuredClone(responseBySourceId(fixture, "RJ01111111"));
    const rankFacts = normal.payload["rank_facts"];
    if (!Array.isArray(rankFacts) || rankFacts[0] === null || typeof rankFacts[0] !== "object") {
      throw new Error("RJ01111111 fixture must include rank_facts[0]");
    }
    (rankFacts[0] as { observed_at?: unknown }).observed_at = "2026-06-18T00:00Z";

    const mapped = mapDlsiteDemandFactsForRecordedResponse(fixture, normal);

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factKind: catalogDemandFactKindValues.rank,
          observedAt: "2026-06-18T00:00Z",
        }),
      ]),
    );
  });

  it("keeps missing DLsite demand fields as diagnostics instead of zero-valued facts", () => {
    const missing = responseBySourceId(fixture, "RJ02222222");
    const mapped = mapDlsiteDemandFactsForRecordedResponse(fixture, missing);

    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_demand_field",
          sourceField: "wishlist_count",
        }),
        expect.objectContaining({ code: "missing_demand_field", sourceField: "rank_facts" }),
      ]),
    );
    expect(mapped.facts.map((fact) => fact.factKind)).toEqual(
      expect.not.arrayContaining([
        catalogDemandFactKindValues.wishlistCount,
        catalogDemandFactKindValues.rank,
      ]),
    );
  });

  it("covers recovered Japan-locked products and parse-drift responses without live DLsite access", () => {
    const recovered = responseBySourceId(fixture, "RJ03333333");
    const mapped = mapDlsiteDemandFactsForRecordedResponse(fixture, recovered);

    expect(recovered.metadata).toMatchObject({
      geoRecovery: { status: "japan_locked_recovered" },
    });
    expect(
      mapped.facts.filter((fact) => fact.factKind === catalogDemandFactKindValues.rank),
    ).toHaveLength(2);
    expect(() => createDlsiteRecordedStorefrontAdapter(parseDriftFixture)).toThrow(
      /parse_drift .*sourceId=RJ09999999 sourceField=dl_count/u,
    );
  });

  it("reports malformed rank facts as DLsite parse drift", () => {
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999990"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999990 sourceField=rank_facts\[0\]/u);
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999991"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999991 sourceField=rank_facts\[0\]\.category/u);
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999992"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999992 sourceField=rank_facts\[0\]\.rank/u);
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999993"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999993 sourceField=rank_facts\[0\]\.observed_at/u);
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999994"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999994 sourceField=rank_facts\[0\]\.observed_at/u);
    expect(() =>
      createDlsiteRecordedStorefrontAdapter(
        fixtureWithResponseBySourceId(parseDriftFixture, "RJ09999995"),
      ),
    ).toThrow(/parse_drift .*sourceId=RJ09999995 sourceField=rank_facts\[0\]\.observed_at/u);
  });
});

function responseBySourceId(fixture: CatalogRecordedStorefrontFixture, sourceId: string) {
  const response = fixture.responses.find((entry) => entry.sourceId === sourceId);
  if (response === undefined) {
    throw new Error(`missing fixture response ${sourceId}`);
  }
  return response;
}

function fixtureWithResponseBySourceId(
  fixture: CatalogRecordedStorefrontFixture,
  sourceId: string,
): CatalogRecordedStorefrontFixture {
  return { ...fixture, responses: [responseBySourceId(fixture, sourceId)] };
}

function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}
