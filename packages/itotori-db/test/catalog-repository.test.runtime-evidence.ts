import { describe, expect, it } from "vitest";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";

import { ItotoriCatalogRepository } from "../src/repositories/catalog-repository.js";
import {
  catalogSourceRecordKindValues,
  catalogSourceValues,
  engineCapabilityEvidenceKindValues,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const fetchedAt = "2026-06-17T12:00:00.000Z";

/**
 * Asserts a catalog artifact-mapping validation failure exposes the expected
 * stable machine-readable code (not merely a matching message string), and
 * returns the caught error so callers can additionally assert the message.
 */

import {
  recordRuntimeReadinessCapabilityEvidence,
  runtimeReadinessWorkInput,
  provenance,
  uuid,
  requiredOpportunityRow,
  runtimeEvidenceFactor,
} from "./catalog-repository.test.support.js";

describe("ItotoriCatalogRepository", () => {
  it("counts public fixture and private aggregate runtime evidence in opportunity ranking", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const publicProvenance = await provenance(repo, 810, catalogSourceValues.dlsite, "RJRT810");
      const privateProvenance = await provenance(repo, 811, catalogSourceValues.dlsite, "RJRT811");
      const mixedProvenance = await provenance(repo, 812, catalogSourceValues.dlsite, "RJRT812");

      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "public-fixture-runtime-engine",
        idBase: 8100,
        publicFixture: true,
        privateLocalAggregate: false,
      });
      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "private-aggregate-runtime-engine",
        idBase: 8200,
        publicFixture: false,
        privateLocalAggregate: true,
      });
      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "mixed-runtime-engine",
        idBase: 8300,
        publicFixture: true,
        privateLocalAggregate: true,
      });

      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(810),
          title: "Public fixture runtime readiness",
          provenance: publicProvenance,
          sourceId: "RJRT810",
          adapterId: "public-fixture-runtime-engine",
          languageStatusId: uuid(8810),
        }),
      );
      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(811),
          title: "Private aggregate runtime readiness",
          provenance: privateProvenance,
          sourceId: "RJRT811",
          adapterId: "private-aggregate-runtime-engine",
          languageStatusId: uuid(8811),
        }),
      );
      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(812),
          title: "Mixed runtime readiness",
          provenance: mixedProvenance,
          sourceId: "RJRT812",
          adapterId: "mixed-runtime-engine",
          languageStatusId: uuid(8812),
        }),
      );

      const model = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const publicOnly = requiredOpportunityRow(model.rows, uuid(810));
      const privateOnly = requiredOpportunityRow(model.rows, uuid(811));
      const mixed = requiredOpportunityRow(model.rows, uuid(812));

      expect(publicOnly.runtimeEvidenceReadiness).toEqual({
        status: "public_fixture",
        publicFixtureEvidenceCount: 1,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(privateOnly.runtimeEvidenceReadiness).toEqual({
        status: "private_local_aggregate",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 1,
      });
      expect(mixed.runtimeEvidenceReadiness).toEqual({
        status: "public_and_aggregate",
        publicFixtureEvidenceCount: 1,
        privateLocalAggregateEvidenceCount: 1,
      });

      expect(runtimeEvidenceFactor(publicOnly)).toMatchObject({
        weightedScore: 4.2,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:0",
          "public_fixture_evidence_count:1",
        ],
        explanationCode: "runtime_evidence_readiness:public_fixture",
      });
      expect(runtimeEvidenceFactor(privateOnly)).toMatchObject({
        weightedScore: 3.3,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:1",
          "public_fixture_evidence_count:0",
        ],
        explanationCode: "runtime_evidence_readiness:private_local_aggregate",
      });
      expect(runtimeEvidenceFactor(mixed)).toMatchObject({
        weightedScore: 6,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:1",
          "public_fixture_evidence_count:1",
        ],
        explanationCode: "runtime_evidence_readiness:public_and_aggregate",
      });
      expect(runtimeEvidenceFactor(mixed).weightedScore).toBeGreaterThan(
        runtimeEvidenceFactor(publicOnly).weightedScore,
      );
      expect(runtimeEvidenceFactor(mixed).weightedScore).toBeGreaterThan(
        runtimeEvidenceFactor(privateOnly).weightedScore,
      );
    } finally {
      await context.close();
    }
  });

  it("does not count public_fixture adapter_matrix evidence as runtime readiness", async () => {
    // Locks the intentional source split clarified in catalog-repository.ts: only
    // `public_fixture` `key_validation` evidence increments publicFixtureEvidenceCount. A
    // `public_fixture` `adapter_matrix` row (the static capability matrix, which is what the
    // production catalog-local producer emits) must NOT advertise public runtime readiness, so the
    // read-model never promises a state the production producer fabricates.
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);
      const matrixProvenance = await provenance(repo, 820, catalogSourceValues.dlsite, "RJRT820");

      await recordRuntimeReadinessCapabilityEvidence(context.db, {
        adapterId: "public-matrix-only-engine",
        idBase: 8400,
        publicFixture: true,
        publicFixtureKind: engineCapabilityEvidenceKindValues.adapterMatrix,
        privateLocalAggregate: false,
      });

      await repo.upsertWork(
        localActor,
        runtimeReadinessWorkInput({
          workId: uuid(820),
          title: "Public matrix only runtime readiness",
          provenance: matrixProvenance,
          sourceId: "RJRT820",
          adapterId: "public-matrix-only-engine",
          languageStatusId: uuid(8820),
        }),
      );

      const model = await repo.catalogOpportunityRanking(localActor, {
        includeDemoted: true,
        limit: 20,
      });
      const matrixOnly = requiredOpportunityRow(model.rows, uuid(820));

      expect(matrixOnly.runtimeEvidenceReadiness).toEqual({
        status: "unknown",
        publicFixtureEvidenceCount: 0,
        privateLocalAggregateEvidenceCount: 0,
      });
      expect(runtimeEvidenceFactor(matrixOnly)).toMatchObject({
        weightedScore: 0,
        evidenceRefs: [
          "private_local_aggregate_evidence_count:0",
          "public_fixture_evidence_count:0",
        ],
        explanationCode: "runtime_evidence_readiness:unknown",
      });
    } finally {
      await context.close();
    }
  });

  it("rejects catalog writes and reads without catalog permissions", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repo = new ItotoriCatalogRepository(context.db);

      await expect(
        repo.recordSourceProvenance(
          { userId: "user-without-grants" },
          {
            catalogSource: catalogSourceValues.dlsite,
            sourceRecordKind: catalogSourceRecordKindValues.recordedFixture,
            sourceId: "RJ000001",
            fetchedAt,
          },
        ),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.catalogWrite,
      });

      await expect(
        repo.getWorkSnapshot({ userId: "user-without-grants" }, uuid(101)),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.catalogRead,
      });
    } finally {
      await context.close();
    }
  });
});
