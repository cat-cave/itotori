import { readFileSync } from "node:fs";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictDiagnosticCodeValues,
  catalogPlatformLanguageConflictReasonCode,
  catalogPlatformLanguageConflictStatusValues,
  type CatalogPlatformLanguageConflictRequest,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/catalog-recorded-importers/platform-language-conflicts.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    expectedStatus: string;
    request: CatalogPlatformLanguageConflictRequest;
  }>;
};

describe("platform-language-conflicts app contract", () => {
  it("keeps platform conflict augmentation fixture-backed and offline", () => {
    const results = fixture.cases.map((testCase) => ({
      caseId: testCase.caseId,
      result: augmentCatalogPlatformLanguageConflicts(testCase.request),
    }));

    expect(results.map((entry) => [entry.caseId, entry.result.status])).toEqual([
      ["igdb-official-english-vs-vndb-dlsite-gaps", "conflict"],
      ["wikidata-official-english-vs-egs-unknown", "unknown"],
      ["steam-already-official-false-positive", "no_conflict"],
      ["local-corpus-unknown-remains-unknown", "unknown"],
    ]);
    expect(results[0]?.result.conflicts[0]).toMatchObject({
      reasonCode: catalogPlatformLanguageConflictReasonCode,
      metadata: expect.objectContaining({
        targetLanguage: "en-US",
        sources: expect.arrayContaining([
          expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
          expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
        ]),
      }),
    });
    expect(results[2]?.result.status).toBe(catalogPlatformLanguageConflictStatusValues.noConflict);
    expect(results[3]?.result.status).toBe(catalogPlatformLanguageConflictStatusValues.unknown);
    expect(results[3]?.result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogPlatformLanguageConflictDiagnosticCodeValues.candidateEvidenceUnknown,
        }),
      ]),
    );
  });
});
