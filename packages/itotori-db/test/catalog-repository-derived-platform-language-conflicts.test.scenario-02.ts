import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  catalogCompletenessPoolValues,
  ItotoriCatalogRepository,
} from "../src/repositories/catalog-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import {
  catalogPlatformLanguageConflictOriginValues,
  catalogPlatformLanguageConflictReasonCode,
  catalogPlatformLanguageConflictStatusValues,
  type CatalogPlatformLanguageConflictEvidence,
} from "../src/services/catalog-platform-language-conflicts.js";
import { augmentCatalogPlatformLanguageConflicts } from "../src/services/catalog-platform-language-conflicts.js";
import { deriveCatalogPlatformLanguageConflictsFromRepository } from "../src/services/catalog-repository-derived-platform-language-conflicts.js";
import {
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
} from "../src/schema.js";

const actor: AuthorizationActor = { userId: localUserId };
const now = new Date("2026-06-18T13:00:00.000Z");

const officialEvidence: CatalogPlatformLanguageConflictEvidence = {
  catalogSource: "igdb",
  sourceId: "252001",
  externalIdKind: catalogExternalIdKindValues.sourceRecord,
  language: "en-US",
  status: catalogLanguageStatusValues.officialFull,
  statusScope: catalogLanguageStatusScopeValues.platform,
  platform: "pc",
  evidenceRef: "igdb.language_supports[1]",
};

import {
  externalIdIdentity,
  uuid,
} from "./catalog-repository-derived-platform-language-conflicts.test.shared-01.js";

describe("repository-derived platform-language conflicts on real Postgres", () => {
  it("generates a repository-derived demotion from live candidate rows and preserves external ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const candidate = [
        {
          source: "vndb" as const,
          sourceId: "v1002",
          kind: catalogExternalIdKindValues.sourceRecord,
          prov: uuid(102),
        },
        {
          source: "egs" as const,
          sourceId: "101002",
          kind: catalogExternalIdKindValues.sourceRecord,
          prov: uuid(103),
        },
        {
          source: "dlsite" as const,
          sourceId: "RJ02222222",
          kind: catalogExternalIdKindValues.storeProduct,
          prov: uuid(104),
        },
        {
          source: "local_corpus" as const,
          sourceId: "sha256:fixture-local-install",
          kind: catalogExternalIdKindValues.localDetection,
          prov: uuid(105),
        },
      ];
      await repo.recordSourceProvenance(actor, {
        sourceProvenanceId: uuid(101),
        catalogSource: "igdb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "252001",
        requestId: "recorded://igdb/games/252001",
        ok: true,
        rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
        fetchedAt: "2026-06-18T13:20:00.000Z",
      });
      for (const entry of candidate) {
        await repo.recordSourceProvenance(actor, {
          sourceProvenanceId: entry.prov,
          catalogSource: entry.source,
          sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
          sourceId: entry.sourceId,
          requestId: `dump://${entry.source}/${entry.sourceId}`,
          ok: true,
          rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
          fetchedAt: "2026-06-18T13:00:00.000Z",
        });
      }

      await repo.upsertWork(actor, {
        workId: uuid(201),
        canonicalTitle: "Moonlit Glass Journey",
        originalLanguage: "ja-JP",
        externalIds: candidate.map((entry, index) => ({
          externalIdId: uuid(300 + index),
          catalogSource: entry.source,
          sourceId: entry.sourceId,
          externalIdKind: entry.kind,
          sourceProvenanceId: entry.prov,
        })),
        languageStatuses: candidate.map((entry, index) => ({
          languageStatusId: uuid(400 + index),
          language: "en-US",
          status: catalogLanguageStatusValues.none,
          statusScope: catalogLanguageStatusScopeValues.work,
          sourceProvenanceId: entry.prov,
        })),
      });

      const before = await repo.getWorkByExternalId(actor, "vndb", "v1002");
      const externalIdsBefore = before?.externalIds.map(externalIdIdentity);

      const derived = await deriveCatalogPlatformLanguageConflictsFromRepository(repo, actor, {
        targetLanguage: "en-US",
        officialEvidence: { ...officialEvidence, sourceProvenanceId: uuid(101) },
        workLookup: { catalogSource: "vndb", sourceId: "v1002" },
      });
      expect(derived.origin).toBe(catalogPlatformLanguageConflictOriginValues.repositoryDerived);
      expect(derived.status).toBe(catalogPlatformLanguageConflictStatusValues.conflict);
      // Compared against all four live candidate catalogues.
      expect(derived.comparedCandidateRows.map((entry) => entry.catalogSource).sort()).toEqual(
        ["dlsite", "egs", "local_corpus", "vndb"].sort(),
      );
      const conflict = derived.conflicts[0];
      expect(conflict).toBeDefined();

      // Persisting the generated conflict does not merge works or reassign external ids.
      await repo.upsertWork(actor, {
        workId: uuid(201),
        canonicalTitle: "Moonlit Glass Journey",
        originalLanguage: "ja-JP",
        conflicts: [
          {
            conflictId: uuid(500),
            conflictKind: conflict!.conflictKind,
            status: conflict!.status,
            summary: conflict!.summary,
            metadata: conflict!.metadata,
            evidence: conflict!.evidence,
          },
        ],
      });

      const after = await repo.getWorkByExternalId(actor, "vndb", "v1002");
      expect(after?.externalIds.map(externalIdIdentity)).toEqual(externalIdsBefore);

      const ranking = await repo.catalogAlphaBenchmarkOpportunityRanking(actor, {
        targetLanguage: "en-US",
        includeDemoted: true,
      });
      const rankRow = ranking.rows.find((entry) => entry.workId === uuid(201));
      expect(rankRow?.decision).toBe("demoted");
      expect(rankRow?.demotions).toEqual([
        expect.objectContaining({
          reasonCode: catalogPlatformLanguageConflictReasonCode,
          conflictOrigin: catalogPlatformLanguageConflictOriginValues.repositoryDerived,
        }),
      ]);
      expect(rankRow?.explanation).toContain("repository-derived");
    } finally {
      await context.close();
    }
  });

  it("labels a fixture-authored conflict's demotion distinctly from a repository-derived one", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      await repo.recordSourceProvenance(actor, {
        sourceProvenanceId: uuid(601),
        catalogSource: "vndb",
        sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
        sourceId: "v2002",
        requestId: "dump://vndb/v2002",
        ok: true,
        rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
        fetchedAt: "2026-06-18T13:00:00.000Z",
      });

      // A hand-authored conflict fact (no conflictOrigin => fixture_authored).
      const fixtureAuthored = augmentCatalogPlatformLanguageConflicts({
        targetLanguage: "en-US",
        officialEvidence,
        candidateEvidence: [
          {
            catalogSource: "vndb",
            sourceId: "v2002",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            statusScope: catalogLanguageStatusScopeValues.work,
            sourceProvenanceId: uuid(601),
            languageStatusId: uuid(701),
          },
        ],
      });
      const conflict = fixtureAuthored.conflicts[0];
      expect(conflict?.metadata.conflictOrigin).toBe(
        catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
      );

      await repo.upsertWork(actor, {
        workId: uuid(801),
        canonicalTitle: "Aurora Bridge Chronicle",
        originalLanguage: "ja-JP",
        externalIds: [
          {
            catalogSource: "vndb",
            sourceId: "v2002",
            externalIdKind: catalogExternalIdKindValues.sourceRecord,
            sourceProvenanceId: uuid(601),
          },
        ],
        languageStatuses: [
          {
            languageStatusId: uuid(701),
            language: "en-US",
            status: catalogLanguageStatusValues.none,
            statusScope: catalogLanguageStatusScopeValues.work,
            sourceProvenanceId: uuid(601),
          },
        ],
        conflicts: [
          {
            conflictId: uuid(900),
            conflictKind: conflict!.conflictKind,
            status: conflict!.status,
            summary: conflict!.summary,
            metadata: conflict!.metadata,
            evidence: conflict!.evidence,
          },
        ],
      });

      const ranking = await repo.catalogAlphaBenchmarkOpportunityRanking(actor, {
        targetLanguage: "en-US",
        includeDemoted: true,
      });
      const rankRow = ranking.rows.find((entry) => entry.workId === uuid(801));
      expect(rankRow?.candidatePool).toBe(catalogCompletenessPoolValues.noEnglish);
      expect(rankRow?.demotions).toEqual([
        expect.objectContaining({
          conflictOrigin: catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
        }),
      ]);
      expect(rankRow?.explanation).toContain("fixture-authored");
      expect(rankRow?.explanation).not.toContain("repository-derived");
    } finally {
      await context.close();
    }
  });
});
