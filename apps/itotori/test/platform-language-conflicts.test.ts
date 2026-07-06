import { readFileSync } from "node:fs";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictCompatibilityBasisValues,
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
      ["igdb-official-english-pc-vs-switch-incompatible", "unknown"],
      ["igdb-official-english-pc-vs-switch-declared-comparable", "conflict"],
      ["igdb-official-english-pc-vs-pc-same-platform", "conflict"],
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

    const byCaseId = new Map(results.map((entry) => [entry.caseId, entry.result]));

    // Official PC vs a Switch-only gap must not benchmark-demote: it stays review-only.
    const incompatible = required(byCaseId.get("igdb-official-english-pc-vs-switch-incompatible"));
    expect(incompatible.status).toBe(catalogPlatformLanguageConflictStatusValues.unknown);
    expect(incompatible.conflicts).toEqual([]);
    expect(incompatible.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogPlatformLanguageConflictDiagnosticCodeValues.candidatePlatformIncompatible,
        }),
      ]),
    );

    // An explicit cross-platform declaration restores the demotion.
    const declared = required(
      byCaseId.get("igdb-official-english-pc-vs-switch-declared-comparable"),
    );
    expect(declared.status).toBe(catalogPlatformLanguageConflictStatusValues.conflict);
    expect(declared.conflicts[0]?.metadata.candidateGaps).toEqual([
      expect.objectContaining({
        catalogSource: "vndb",
        compatibilityBasis:
          catalogPlatformLanguageConflictCompatibilityBasisValues.crossPlatformDeclared,
      }),
    ]);

    // A same-platform gap demotes on the same_platform basis.
    const samePlatform = required(byCaseId.get("igdb-official-english-pc-vs-pc-same-platform"));
    expect(samePlatform.status).toBe(catalogPlatformLanguageConflictStatusValues.conflict);
    expect(samePlatform.conflicts[0]?.metadata.candidateGaps).toEqual([
      expect.objectContaining({
        compatibilityBasis: catalogPlatformLanguageConflictCompatibilityBasisValues.samePlatform,
      }),
    ]);

    const steam = required(byCaseId.get("steam-already-official-false-positive"));
    expect(steam.status).toBe(catalogPlatformLanguageConflictStatusValues.noConflict);
    const localCorpus = required(byCaseId.get("local-corpus-unknown-remains-unknown"));
    expect(localCorpus.status).toBe(catalogPlatformLanguageConflictStatusValues.unknown);
    expect(localCorpus.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogPlatformLanguageConflictDiagnosticCodeValues.candidateEvidenceUnknown,
        }),
      ]),
    );
  });
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("missing required test fixture value");
  }
  return value;
}
