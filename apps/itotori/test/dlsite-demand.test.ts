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

  it("keeps missing DLsite demand fields as diagnostics instead of zero-valued facts", () => {
    const missing = responseBySourceId(fixture, "RJ02222222");
    const mapped = mapDlsiteDemandFactsForRecordedResponse(fixture, missing);

    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_demand_field", sourceField: "demand.wishlist_count" }),
        expect.objectContaining({ code: "missing_demand_field", sourceField: "demand.rank_facts" }),
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
    expect(mapped.facts.filter((fact) => fact.factKind === catalogDemandFactKindValues.rank)).toHaveLength(
      2,
    );
    expect(() => createDlsiteRecordedStorefrontAdapter(parseDriftFixture)).toThrow(
      /parse_drift .*sourceId=RJ09999999 sourceField=dl_count/u,
    );
  });
});

function responseBySourceId(fixture: CatalogRecordedStorefrontFixture, sourceId: string) {
  const response = fixture.responses.find((entry) => entry.sourceId === sourceId);
  if (response === undefined) {
    throw new Error(`missing fixture response ${sourceId}`);
  }
  return response;
}

function readStorefrontFixture(name: string): CatalogRecordedStorefrontFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/catalog-recorded-importers/${name}`, import.meta.url),
      "utf8",
    ),
  ) as CatalogRecordedStorefrontFixture;
}
