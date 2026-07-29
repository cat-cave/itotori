import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

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
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
} from "../src/schema.js";

const actor: AuthorizationActor = { userId: localUserId };

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
  readerFor,
  row,
  buildSnapshot,
  externalId,
  languageStatus,
} from "./catalog-repository-derived-platform-language-conflicts.test.support.js";

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
