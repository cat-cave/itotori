import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  catalogCompletenessPoolValues,
  ItotoriCatalogRepository,
  type CatalogJsonRecord,
} from "../src/repositories/catalog-repository.js";
import {
  augmentCatalogPlatformLanguageConflicts,
  catalogPlatformLanguageConflictDiagnosticCodeValues,
  catalogPlatformLanguageConflictReasonCode,
  catalogPlatformLanguageConflictStatusValues,
  type CatalogPlatformLanguageConflictRequest,
} from "../src/services/catalog-platform-language-conflicts.js";
import {
  catalogConflictKindValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const fixture = readFixture();

describe("platform-language-conflicts augmenter", () => {
  it("creates conflicts for official-English evidence against platform gaps and keeps unknowns non-negative", () => {
    const byCase = new Map(fixture.cases.map((entry) => [entry.caseId, entry]));

    for (const testCase of fixture.cases) {
      const result = augmentCatalogPlatformLanguageConflicts(testCase.request);
      expect(result.status, testCase.caseId).toBe(testCase.expectedStatus);
    }

    const trueConflict = augmentCatalogPlatformLanguageConflicts(
      required(byCase.get("igdb-official-english-vs-vndb-dlsite-gaps")).request,
    );
    expect(trueConflict.conflicts).toEqual([
      expect.objectContaining({
        conflictKind: catalogConflictKindValues.languageStatus,
        reasonCode: catalogPlatformLanguageConflictReasonCode,
        metadata: expect.objectContaining({
          targetLanguage: "en-US",
          platformScope: "pc",
          officialEvidence: expect.objectContaining({
            catalogSource: "igdb",
            sourceId: "252001",
            language: "en-US",
            status: catalogLanguageStatusValues.officialFull,
            platform: "pc",
          }),
          candidateGaps: expect.arrayContaining([
            expect.objectContaining({
              catalogSource: "vndb",
              sourceId: "v1002",
              status: catalogLanguageStatusValues.none,
            }),
            expect.objectContaining({
              catalogSource: "dlsite",
              sourceId: "RJ02222222",
              externalIdKind: catalogExternalIdKindValues.storeProduct,
            }),
          ]),
        }),
      }),
    ]);

    const unknown = augmentCatalogPlatformLanguageConflicts(
      required(byCase.get("local-corpus-unknown-remains-unknown")).request,
    );
    expect(unknown.conflicts).toEqual([]);
    expect(unknown.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogPlatformLanguageConflictDiagnosticCodeValues.candidateEvidenceUnknown,
          severity: "info",
        }),
      ]),
    );

    const falsePositive = augmentCatalogPlatformLanguageConflicts(
      required(byCase.get("steam-already-official-false-positive")).request,
    );
    expect(falsePositive.conflicts).toEqual([]);
    expect(falsePositive.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogPlatformLanguageConflictDiagnosticCodeValues.candidateAlreadyOfficial,
          severity: "info",
        }),
      ]),
    );
  });

  it("demotes benchmark opportunities using generated conflict facts without deleting original facts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const officialProvenance = await repo.recordSourceProvenance(actor, {
        sourceProvenanceId: uuid(1001),
        catalogSource: "igdb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "252001",
        sourceVersion: "platform-language-conflicts-v0.1",
        requestId: "recorded://igdb/games/252001",
        ok: true,
        rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
        fetchedAt: "2026-06-18T13:20:00.000Z",
        metadata: { fixtureId: fixture.fixtureId },
      });
      const candidateProvenance = await repo.recordSourceProvenance(actor, {
        sourceProvenanceId: uuid(1002),
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "v1002",
        sourceVersion: "platform-language-conflicts-v0.1",
        requestId: "dump://vndb/vn+releases/v1002",
        ok: true,
        rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
        fetchedAt: "2026-06-18T13:00:00.000Z",
        metadata: { fixtureId: fixture.fixtureId },
      });

      const generated = augmentCatalogPlatformLanguageConflicts({
        ...required(
          fixture.cases.find(
            (testCase) => testCase.caseId === "igdb-official-english-vs-vndb-dlsite-gaps",
          ),
        ).request,
        officialEvidence: {
          ...required(
            fixture.cases.find(
              (testCase) => testCase.caseId === "igdb-official-english-vs-vndb-dlsite-gaps",
            ),
          ).request.officialEvidence,
          sourceProvenanceId: officialProvenance.sourceProvenanceId,
        },
        candidateEvidence: [
          {
            ...required(
              fixture.cases.find(
                (testCase) => testCase.caseId === "igdb-official-english-vs-vndb-dlsite-gaps",
              ),
            ).request.candidateEvidence[0],
            sourceProvenanceId: candidateProvenance.sourceProvenanceId,
            languageStatusId: uuid(3001),
          },
        ],
      });
      expect(generated.status).toBe(catalogPlatformLanguageConflictStatusValues.conflict);
      const conflict = required(generated.conflicts[0]);

      await repo.upsertWork(actor, {
        workId: uuid(2001),
        canonicalTitle: "Moonlit Glass Journey",
        originalLanguage: "ja-JP",
        externalIds: [
          {
            catalogSource: "vndb",
            sourceId: "v1002",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
            sourceProvenanceId: candidateProvenance.sourceProvenanceId,
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(3001),
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            statusScope: catalogLanguageStatusScopeValues.work,
            sourceProvenanceId: candidateProvenance.sourceProvenanceId,
          },
        ],
        conflicts: [
          {
            conflictId: uuid(4001),
            conflictKind: conflict.conflictKind,
            status: conflict.status,
            summary: conflict.summary,
            metadata: conflict.metadata,
            evidence: conflict.evidence,
          },
        ],
      });

      const snapshot = await repo.getWorkByExternalId(actor, "vndb", "v1002");
      expect(snapshot?.languageStatuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            language: "en-US",
            status: catalogLanguageStatusValues.none,
          }),
        ]),
      );
      expect(snapshot?.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conflictKind: catalogConflictKindValues.languageStatus,
            metadata: expect.objectContaining({
              reasonCode: catalogPlatformLanguageConflictReasonCode,
              sources: expect.arrayContaining([
                expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
                expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
              ]),
            }),
          }),
        ]),
      );

      const ranking = await repo.catalogAlphaBenchmarkOpportunityRanking(actor, {
        targetLanguage: "en-US",
      });
      expect(ranking.rows).toEqual([
        expect.objectContaining({
          workId: snapshot?.workId,
          candidatePool: catalogCompletenessPoolValues.noEnglish,
          decision: "demoted",
          seedRank: null,
          demotions: [
            expect.objectContaining({
              reasonCode: catalogPlatformLanguageConflictReasonCode,
              sourceIds: expect.arrayContaining([
                { catalogSource: "igdb", sourceId: "252001" },
                { catalogSource: "vndb", sourceId: "v1002" },
              ]),
              provenance: expect.arrayContaining([
                expect.objectContaining({
                  catalogSource: "igdb",
                  sourceId: "252001",
                }),
              ]),
            }),
          ],
        }),
      ]);
    } finally {
      await context.close();
    }
  });
});

function readFixture(): {
  fixtureId: string;
  cases: Array<{
    caseId: string;
    expectedStatus: string;
    request: CatalogPlatformLanguageConflictRequest;
  }>;
} {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/catalog-recorded-importers/platform-language-conflicts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    fixtureId: string;
    cases: Array<{
      caseId: string;
      expectedStatus: string;
      request: CatalogPlatformLanguageConflictRequest;
    }>;
  };
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("missing required test fixture value");
  }
  return value;
}

function uuid(seed: number): string {
  return `019ed070-0000-7000-8000-${String(seed).padStart(12, "0")}`;
}
