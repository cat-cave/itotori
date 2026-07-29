import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { createIgdbRecordedPlatformAdapter } from "../src/services/catalog-recorded-importers.js";
import {
  catalogConflictKindValues,
  catalogConflicts,
  catalogConflictEvidence,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");

const igdbFixture = readPlatformFixture("igdb-platform-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import {
  servicesFor,
  runFixture,
  runStorefrontFixture,
  provenanceCatalogSourcesByIds,
} from "./catalog-recorded-importers.test.shared-01.js";
import {
  readFixture,
  readPlatformFixture,
  required,
} from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("preserves per-evidence sourceProvenanceId for platform-language conflict fixtures through storage and review", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      // Import the candidate source first so its provenance row exists, then the
      // official platform source whose recorded payload authors a platform-language
      // conflict citing the candidate as a cross-source evidence row.
      await runFixture(services, vndbFixture, "worker-vndb-before-per-evidence-provenance");
      await runStorefrontFixture(
        services,
        createIgdbRecordedPlatformAdapter(igdbFixture),
        "worker-igdb-per-evidence-provenance",
      );

      // The candidate VNDB source's stored external-id provenance — the ORIGINAL
      // source provenance the candidate evidence row must be attributed to.
      const vndbNoEnglish = required(
        await services.catalogRepository.getWorkByExternalId(actor, "vndb", "v1002"),
        "VNDB no-English work",
      );
      const vndbExternalId = required(
        vndbNoEnglish.externalIds.find(
          (row) => row.catalogSource === "vndb" && row.sourceId === "v1002",
        ),
        "VNDB external id row",
      );
      const vndbProvenanceId = required(
        vndbExternalId.sourceProvenanceId,
        "VNDB source provenance id",
      );
      // The official IGDB source's importer-payload provenance.
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

      // Storage assertion: the IGDB-authored platform-language conflict's evidence
      // rows each carry their OWN sourceProvenanceId — the official IGDB row points
      // at the IGDB importer-payload provenance, and the candidate VNDB row points
      // at the ORIGINAL VNDB source provenance (not collapsed to IGDB).
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

      const evidenceProvenanceCatalogSources = await provenanceCatalogSourcesByIds(
        context.db,
        evidenceRows.map((row) => row.sourceProvenanceId).filter((id): id is string => id !== null),
      );
      const provenanceCatalogSources = evidenceRows
        .map((row) =>
          row.sourceProvenanceId === null
            ? null
            : (evidenceProvenanceCatalogSources.get(row.sourceProvenanceId) ?? null),
        )
        .filter((value): value is string => value !== null);
      // The original IGDB and VNDB evidence sources are both named in storage.
      expect(provenanceCatalogSources).toEqual(expect.arrayContaining(["igdb", "vndb"]));

      // The candidate VNDB evidence row carries the ORIGINAL VNDB source provenance,
      // NOT the IGDB importer-payload provenance; the official IGDB evidence row
      // carries the IGDB importer-payload provenance. The two rows carry DISTINCT
      // provenance — per-evidence provenance is preserved rather than collapsed to a
      // single importer-payload provenance. (The authoritative per-evidence source
      // attribution lives in the sourceProvenanceId column, so rows are identified by
      // their provenance, not the importer-stamped metadata.)
      const vndbCandidateEvidence = evidenceRows.find(
        (row) => row.sourceProvenanceId === vndbProvenanceId,
      );
      const igdbOfficialEvidence = evidenceRows.find(
        (row) => row.sourceProvenanceId === igdbProvenanceId,
      );
      expect(vndbCandidateEvidence).toBeDefined();
      expect(igdbOfficialEvidence).toBeDefined();
      expect(vndbCandidateEvidence?.sourceProvenanceId).toBe(vndbProvenanceId);
      expect(igdbOfficialEvidence?.sourceProvenanceId).toBe(igdbProvenanceId);
      expect(vndbCandidateEvidence?.sourceProvenanceId).not.toBe(
        igdbOfficialEvidence?.sourceProvenanceId,
      );

      // Review read model assertion: the platform-language conflict review row
      // surfaces BOTH the official IGDB and the original VNDB source provenance.
      const review = await services.catalogRepository.catalogConflictReview(actor, {});
      const languageConflictRow = required(
        review.rows.find((row) => row.conflictKind === catalogConflictKindValues.languageStatus),
        "platform-language conflict review row",
      );
      expect(languageConflictRow.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ catalogSource: "igdb", sourceId: "252001" }),
          expect.objectContaining({ catalogSource: "vndb", sourceId: "v1002" }),
        ]),
      );
    } finally {
      await context.close();
    }
  });
});
