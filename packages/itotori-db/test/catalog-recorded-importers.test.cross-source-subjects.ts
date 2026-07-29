import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { createIgdbRecordedPlatformAdapter } from "../src/services/catalog-recorded-importers.js";
import {
  catalogConflictKindValues,
  catalogConflictSubjectKindValues,
  catalogConflicts,
  catalogConflictEvidence,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const igdbFixture = readPlatformFixture("igdb-platform-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import { servicesFor, runStorefrontFixture } from "./catalog-recorded-importers.test.support.js";
import {
  readPlatformFixture,
  required,
} from "./catalog-recorded-importers.test.fixture-support.js";
describe("catalog recorded source importers", () => {
  it("preserves the cross-source subject identity for evidence citing a not-yet-ingested source (CATALOG-089 follow-up)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      // Import the OFFICIAL platform source FIRST — its recorded payload authors a
      // platform-language conflict that cites the candidate VNDB source as cross-source
      // evidence BEFORE VNDB has been crawled. This is the CATALOG-079 forward-reference
      // case: the conflict legitimately names `vndb:v1002` without a persisted row.
      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-before-vndb-forward-reference",
      );

      // The IGDB importer-payload provenance — what an unresolved cross-source row
      // must NOT be mis-attributed to.
      const igdbWork = required(
        await services.catalogRepository.getWorkByExternalId(actor, "igdb", "252001"),
        "IGDB work",
      );
      const igdbExternalId = required(
        igdbWork.externalIds.find(
          (row) => row.catalogSource === "igdb" && row.sourceId === "252001",
        ),
        "IGDB external id row",
      );
      const igdbProvenanceId = required(
        igdbExternalId.sourceProvenanceId,
        "IGDB source provenance id",
      );
      // The candidate VNDB source is NOT yet ingested — no work, no provenance row.
      await expect(
        services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1002"),
      ).resolves.toBeNull();

      // Storage assertion: the candidate VNDB cross-source evidence row carries a
      // NULL sourceProvenanceId (NOT the IGDB importer-payload provenance) and a
      // `vndb:v1002` subject identity — the REAL cited source is preserved.
      const evidenceRows = await context.db
        .select({
          conflictId: catalogConflictEvidence.conflictId,
          subjectKind: catalogConflictEvidence.subjectKind,
          subjectId: catalogConflictEvidence.subjectId,
          sourceProvenanceId: catalogConflictEvidence.sourceProvenanceId,
          metadata: catalogConflictEvidence.metadata,
        })
        .from(catalogConflictEvidence)
        .innerJoin(
          catalogConflicts,
          eq(catalogConflicts.conflictId, catalogConflictEvidence.conflictId),
        )
        .where(eq(catalogConflicts.conflictKind, catalogConflictKindValues.languageStatus));

      expect(evidenceRows.length).toBeGreaterThan(0);

      // The candidate VNDB evidence row: NULL provenance, `vndb:v1002` subject identity.
      const vndbCandidateEvidence = evidenceRows.find((row) => row.subjectId === "vndb:v1002");
      expect(vndbCandidateEvidence).toBeDefined();
      expect(vndbCandidateEvidence?.sourceProvenanceId).toBeNull();
      expect(vndbCandidateEvidence?.subjectKind).toBe(
        catalogConflictSubjectKindValues.sourceProvenance,
      );

      // The official IGDB evidence row still carries the IGDB importer-payload
      // provenance (own-source evidence legitimately uses the importer provenance).
      const igdbOfficialEvidence = evidenceRows.find(
        (row) => row.sourceProvenanceId === igdbProvenanceId,
      );
      expect(igdbOfficialEvidence).toBeDefined();
      // The candidate row is NOT mis-attributed to the IGDB importer provenance.
      expect(vndbCandidateEvidence?.sourceProvenanceId).not.toBe(igdbProvenanceId);

      // Review read model assertion: the platform-language conflict review row
      // surfaces the cited VNDB source in `sourceIds` even though no provenance
      // row exists for it — review/demotion names the REAL cited source.
      const review = await services.catalogRepository.catalogConflictReview(actor, {});
      const languageConflictRow = required(
        review.rows.find((row) => row.conflictKind === catalogConflictKindValues.languageStatus),
        "platform-language conflict review row",
      );
      expect(languageConflictRow.sourceIds).toEqual(
        expect.arrayContaining([
          { catalogSource: "igdb", sourceId: "252001" },
          { catalogSource: "vndb", sourceId: "v1002" },
        ]),
      );
      // The VNDB source has no provenance row (it is not yet ingested), so it
      // cannot appear in the `provenance` projection — but it MUST NOT be
      // mis-attributed to the IGDB importer provenance either.
      expect(languageConflictRow.provenance.map((entry) => entry.catalogSource)).toEqual(
        expect.arrayContaining(["igdb"]),
      );
      expect(
        languageConflictRow.provenance.filter(
          (entry) => entry.catalogSource === "vndb" && entry.sourceId === "v1002",
        ),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
