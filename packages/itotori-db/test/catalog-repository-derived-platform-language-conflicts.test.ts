import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  catalogCompletenessPoolValues,
  ItotoriCatalogRepository,
  type CatalogExternalIdRecord,
  type CatalogLanguageStatusRecord,
  type CatalogWorkSnapshot,
} from "../src/repositories/catalog-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import {
  catalogPlatformLanguageConflictOriginValues,
  catalogPlatformLanguageConflictReasonCode,
  catalogPlatformLanguageConflictStatusValues,
  type CatalogPlatformLanguageConflictEvidence,
} from "../src/services/catalog-platform-language-conflicts.js";
import { augmentCatalogPlatformLanguageConflicts } from "../src/services/catalog-platform-language-conflicts.js";
import {
  catalogRepositoryDerivedConflictDiagnosticCodeValues,
  deriveCatalogPlatformLanguageConflictsFromRepository,
  type CatalogRepositoryDerivedConflictReader,
} from "../src/services/catalog-repository-derived-platform-language-conflicts.js";
import {
  catalogConfidenceValues,
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogRawContentRedactionClassValues,
  catalogSourceRecordKindValues,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
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

describe("repository-derived platform-language conflicts", () => {
  it("derives candidate evidence from the repository's VNDB/EGS/DLsite/local rows and labels it repository-derived", async () => {
    const snapshot = buildSnapshot({
      externalIds: [
        externalId("vndb", "v1002", "prov-vndb", catalogExternalIdKindValues.sourceRecord),
        externalId("egs", "101002", "prov-egs", catalogExternalIdKindValues.sourceRecord),
        externalId("dlsite", "RJ02222222", "prov-dlsite", catalogExternalIdKindValues.storeProduct),
        externalId(
          "local_corpus",
          "sha256:fixture-local-install",
          "prov-local",
          catalogExternalIdKindValues.localDetection,
        ),
      ],
      languageStatuses: [
        languageStatus("ls-vndb", "prov-vndb", catalogLanguageStatusValues.none),
        languageStatus("ls-egs", "prov-egs", catalogLanguageStatusValues.mtl),
        languageStatus("ls-dlsite", "prov-dlsite", catalogLanguageStatusValues.none),
        languageStatus("ls-local", "prov-local", catalogLanguageStatusValues.fanPartial),
      ],
    });
    const reader = readerFor(snapshot);

    const result = await deriveCatalogPlatformLanguageConflictsFromRepository(reader, actor, {
      targetLanguage: "en-US",
      officialEvidence,
      workLookup: { catalogSource: "igdb", sourceId: "252001" },
    });

    expect(result.origin).toBe(catalogPlatformLanguageConflictOriginValues.repositoryDerived);
    expect(result.status).toBe(catalogPlatformLanguageConflictStatusValues.conflict);
    expect(result.workId).toBe("work-derived");

    // Compared against ALL four candidate catalogues, with source identity + provenance
    // preserved verbatim (never reassigned).
    expect(result.comparedCandidateRows).toEqual([
      row("vndb", "v1002", catalogExternalIdKindValues.sourceRecord, "ls-vndb", "prov-vndb"),
      row("egs", "101002", catalogExternalIdKindValues.sourceRecord, "ls-egs", "prov-egs"),
      row(
        "dlsite",
        "RJ02222222",
        catalogExternalIdKindValues.storeProduct,
        "ls-dlsite",
        "prov-dlsite",
      ),
      row(
        "local_corpus",
        "sha256:fixture-local-install",
        catalogExternalIdKindValues.localDetection,
        "ls-local",
        "prov-local",
      ),
    ]);

    const conflict = result.conflicts[0];
    expect(conflict?.metadata.conflictOrigin).toBe(
      catalogPlatformLanguageConflictOriginValues.repositoryDerived,
    );
    expect(conflict?.reasonCode).toBe(catalogPlatformLanguageConflictReasonCode);
    // The derived candidate gaps carry the real repository external ids, not new ones.
    expect(conflict?.metadata.candidateGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
        expect.objectContaining({ catalogSource: "egs", sourceId: "101002" }),
        expect.objectContaining({ catalogSource: "dlsite", sourceId: "RJ02222222" }),
        expect.objectContaining({
          catalogSource: "local_corpus",
          sourceId: "sha256:fixture-local-install",
        }),
      ]),
    );
  });

  it("is non-destructive: it only reads and never mutates the candidate rows", async () => {
    const snapshot = buildSnapshot({
      externalIds: [
        externalId("vndb", "v1002", "prov-vndb", catalogExternalIdKindValues.sourceRecord),
      ],
      languageStatuses: [languageStatus("ls-vndb", "prov-vndb", catalogLanguageStatusValues.none)],
    });
    const snapshotBefore = structuredClone(snapshot);
    let writes = 0;
    const reader: CatalogRepositoryDerivedConflictReader = {
      getWorkByExternalId: async () => snapshot,
    };
    // Guard: any accidental write-shaped method access would be caught here.
    const guarded = new Proxy(reader, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /upsert|record|delete|merge|reassign|write/i.test(prop)) {
          writes += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await deriveCatalogPlatformLanguageConflictsFromRepository(guarded, actor, {
      officialEvidence,
      workLookup: { catalogSource: "igdb", sourceId: "252001" },
    });

    expect(writes).toBe(0);
    // The candidate rows (external ids + language statuses) are untouched.
    expect(snapshot).toEqual(snapshotBefore);
  });

  it("skips target-language rows whose provenance does not map to a stored external id (no id reassignment)", async () => {
    const snapshot = buildSnapshot({
      externalIds: [
        externalId("vndb", "v1002", "prov-vndb", catalogExternalIdKindValues.sourceRecord),
      ],
      languageStatuses: [
        languageStatus("ls-vndb", "prov-vndb", catalogLanguageStatusValues.none),
        // Orphan status: its provenance is not backed by any stored external id.
        languageStatus("ls-orphan", "prov-orphan", catalogLanguageStatusValues.none),
      ],
    });
    const result = await deriveCatalogPlatformLanguageConflictsFromRepository(
      readerFor(snapshot),
      actor,
      { officialEvidence, workLookup: { catalogSource: "igdb", sourceId: "252001" } },
    );

    expect(result.comparedCandidateRows.map((entry) => entry.languageStatusId)).toEqual([
      "ls-vndb",
    ]);
    expect(result.readDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogRepositoryDerivedConflictDiagnosticCodeValues.candidateRowUnattributed,
        }),
      ]),
    );
  });

  it("does not stamp the last-wins source when two external ids share one provenance (collision diagnosed, status skipped)", async () => {
    const snapshot = buildSnapshot({
      externalIds: [
        // Two external ids sharing ONE provenance — attribution via it is ambiguous.
        externalId("vndb", "v1002", "prov-shared", catalogExternalIdKindValues.sourceRecord),
        externalId("egs", "101002", "prov-shared", catalogExternalIdKindValues.sourceRecord),
        externalId("dlsite", "RJ02222222", "prov-dlsite", catalogExternalIdKindValues.storeProduct),
      ],
      languageStatuses: [
        languageStatus("ls-shared", "prov-shared", catalogLanguageStatusValues.none),
        languageStatus("ls-dlsite", "prov-dlsite", catalogLanguageStatusValues.none),
      ],
    });
    const result = await deriveCatalogPlatformLanguageConflictsFromRepository(
      readerFor(snapshot),
      actor,
      { officialEvidence, workLookup: { catalogSource: "igdb", sourceId: "252001" } },
    );

    // The ambiguous status is NOT attributed to either colliding source (no last-wins stamp):
    // only the unambiguous dlsite row is compared.
    const comparedIds = result.comparedCandidateRows.map((entry) => entry.languageStatusId);
    expect(comparedIds).toEqual(["ls-dlsite"]);
    expect(comparedIds).not.toContain("ls-shared");
    expect(
      result.comparedCandidateRows.some((entry) => entry.sourceProvenanceId === "prov-shared"),
    ).toBe(false);

    // The collision itself is diagnosed, naming both colliding external ids.
    expect(result.readDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogRepositoryDerivedConflictDiagnosticCodeValues.provenanceCollision,
          metadata: expect.objectContaining({
            sourceProvenanceId: "prov-shared",
            externalIds: expect.arrayContaining([
              expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
              expect.objectContaining({ catalogSource: "egs", sourceId: "101002" }),
            ]),
          }),
        }),
      ]),
    );
    // ...and the status routed through the ambiguous provenance is recorded as unattributed
    // rather than mis-stamped with the wrong source.
    expect(result.readDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogRepositoryDerivedConflictDiagnosticCodeValues.candidateRowUnattributed,
          metadata: expect.objectContaining({ languageStatusId: "ls-shared" }),
        }),
      ]),
    );
    // Exactly one collision diagnostic for the shared provenance (no duplicate emission).
    expect(
      result.readDiagnostics.filter(
        (diag) =>
          diag.code === catalogRepositoryDerivedConflictDiagnosticCodeValues.provenanceCollision,
      ),
    ).toHaveLength(1);
  });

  it("emits a work-not-found diagnostic when the lookup resolves nothing", async () => {
    const reader: CatalogRepositoryDerivedConflictReader = {
      getWorkByExternalId: async () => null,
    };
    const result = await deriveCatalogPlatformLanguageConflictsFromRepository(reader, actor, {
      officialEvidence,
      workLookup: { catalogSource: "igdb", sourceId: "does-not-exist" },
    });
    expect(result.workId).toBeNull();
    expect(result.conflicts).toEqual([]);
    expect(result.readDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: catalogRepositoryDerivedConflictDiagnosticCodeValues.workNotFound,
        }),
      ]),
    );
  });

  it("labels a hand-authored candidate payload as fixture-authored (distinct from repository-derived)", () => {
    const fixtureAuthored = augmentCatalogPlatformLanguageConflicts({
      targetLanguage: "en-US",
      officialEvidence,
      candidateEvidence: [
        {
          catalogSource: "vndb",
          sourceId: "v1002",
          externalIdKind: catalogExternalIdKindValues.sourceRecord,
          language: "en-US",
          status: catalogLanguageStatusValues.none,
          statusScope: catalogLanguageStatusScopeValues.work,
        },
      ],
    });
    expect(fixtureAuthored.conflicts[0]?.metadata.conflictOrigin).toBe(
      catalogPlatformLanguageConflictOriginValues.fixtureAuthored,
    );
  });
});

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

function externalIdIdentity(record: CatalogExternalIdRecord) {
  return {
    externalIdId: record.externalIdId,
    catalogSource: record.catalogSource,
    sourceId: record.sourceId,
    externalIdKind: record.externalIdKind,
    sourceProvenanceId: record.sourceProvenanceId,
  };
}

function uuid(seed: number): string {
  return `019ed071-0000-7000-8000-${String(seed).padStart(12, "0")}`;
}

function readerFor(snapshot: CatalogWorkSnapshot): CatalogRepositoryDerivedConflictReader {
  return { getWorkByExternalId: async () => snapshot };
}

function row(
  catalogSource: CatalogSource,
  sourceId: string,
  externalIdKind: CatalogExternalIdKind,
  languageStatusId: string,
  sourceProvenanceId: string,
) {
  return expect.objectContaining({
    catalogSource,
    sourceId,
    externalIdKind,
    languageStatusId,
    sourceProvenanceId,
    language: "en-US",
  });
}

function buildSnapshot(parts: {
  externalIds: CatalogExternalIdRecord[];
  languageStatuses: CatalogLanguageStatusRecord[];
}): CatalogWorkSnapshot {
  return {
    workId: "work-derived",
    canonicalTitle: "Moonlit Glass Journey",
    originalLanguage: "ja-JP",
    firstReleaseYear: 2020,
    workKind: "visual_novel",
    engineName: null,
    engineSource: null,
    engineConfidence: null,
    engineProvenanceId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    externalIds: parts.externalIds,
    releases: [],
    releaseMappings: [],
    installStates: [],
    languageStatuses: parts.languageStatuses,
    demandFacts: [],
    conflicts: [],
    localScanEntries: [],
    seedTargets: [],
  };
}

function externalId(
  catalogSource: CatalogSource,
  sourceId: string,
  sourceProvenanceId: string,
  externalIdKind: CatalogExternalIdKind,
): CatalogExternalIdRecord {
  return {
    externalIdId: `ext-${sourceProvenanceId}`,
    workId: "work-derived",
    catalogSource,
    sourceId,
    externalIdKind,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    discoveredAt: now,
    metadata: {},
  };
}

function languageStatus(
  languageStatusId: string,
  sourceProvenanceId: string,
  status: CatalogLanguageStatus,
  statusScope: CatalogLanguageStatusScope = catalogLanguageStatusScopeValues.work,
): CatalogLanguageStatusRecord {
  return {
    languageStatusId,
    workId: "work-derived",
    language: "en-US",
    status,
    statusScope,
    platform: null,
    releaseId: null,
    sourceProvenanceId,
    confidence: catalogConfidenceValues.high,
    isCurrent: true,
    observedAt: now,
    importedAt: now,
    parserVersion: "test",
    rawContentRedactionClass: catalogRawContentRedactionClassValues.publicMetadata,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
