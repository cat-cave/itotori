import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalogOpportunityDashboardSeedFixture } from "../src/services/catalog-opportunity-dashboard-fixtures.js";

const catalogOpportunityFixtureUrl = new URL(
  "../../../fixtures/catalog-opportunities/fixture.json",
  import.meta.url,
);

describe("catalog opportunity dashboard seed fixture", () => {
  it("loads compact public opportunity rows without private leakage", () => {
    const fixture = loadCatalogOpportunityDashboardSeedFixture();

    expect(fixture).toMatchObject({
      schemaVersion: "catalog.opportunity_dashboard_seed.v0.1",
      fixtureId: "catalog-opportunities-catalog-061",
      targetLanguage: "en-US",
    });
    expect(fixture.rows.map((row) => row.workId)).toEqual([
      "019ed161-0000-7000-8000-000000000101",
      "019ed161-0000-7000-8000-000000000102",
      "019ed161-0000-7000-8000-000000000103",
      "019ed161-0000-7000-8000-000000000104",
      "019ed161-0000-7000-8000-000000000108",
      "019ed161-0000-7000-8000-000000000105",
      "019ed161-0000-7000-8000-000000000106",
      "019ed161-0000-7000-8000-000000000107",
      "019ed161-0000-7000-8000-000000000109",
    ]);
    expect(fixture.rows[0]).toMatchObject({
      rank: 1,
      decision: "candidate",
      score: 94,
      demandBucket: "very_high",
      topFactors: [
        {
          factor: "translation_completeness",
          weightedScore: 30,
          explanationCode: "pool:no_english",
        },
        {
          factor: "adapter_readiness",
          weightedScore: 18,
          explanationCode: "adapter_readiness:extract_patch",
        },
        {
          factor: "dlsite_demand",
          weightedScore: 18,
          explanationCode: "demand_bucket:very_high",
        },
      ],
    });
    expect(JSON.stringify(fixture)).not.toMatch(
      /\/home|\/tmp|\/scratch|file:|pathHash|localScanEntryId|rawText|SECRET_KEY|private-story-title/u,
    );
  });

  it("rejects private leakage in the full expected default read model", () => {
    const fixture = JSON.parse(readFileSync(catalogOpportunityFixtureUrl, "utf8"));
    fixture.expectedDefaultReadModel.rows[0].provenance[0].fixtureId = "/scratch/private-story-title";
    const fixturePath = join(mkdtempSync(join(tmpdir(), "catalog-opportunity-")), "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

    expect(() => loadCatalogOpportunityDashboardSeedFixture(pathToFileURL(fixturePath))).toThrow(
      /private|forbidden/u,
    );
  });
});
