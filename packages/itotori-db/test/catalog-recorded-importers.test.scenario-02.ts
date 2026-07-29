import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";

import { catalogSeedReadinessExplanationMetadataKey } from "../src/repositories/catalog-repository.js";

import { catalogSeedOriginValues, catalogSeedStatusValues } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const vndbFixture = readFixture("vndb-dump-replay.json");

// Each DLsite parse-drift / unsupported-shape case: a synthetic mutation of the
// recorded fixture that drives one diagnostic, plus the COMPLETE diagnostic
// metadata (fixtureId/sourceRevision/stepKey/sourceId/sourceField) it must emit.

// Each Steam parse-drift / unsupported-shape case, with the complete diagnostic
// metadata the appdetails envelope parser must emit.

import { servicesFor, runFixture } from "./catalog-recorded-importers.test.shared-01.js";
import { readFixture, required } from "./catalog-recorded-importers.test.shared-02.js";
describe("catalog recorded source importers", () => {
  it("stores recorded importer seed hints as inert and gates them out of benchmark selection until CATALOG-004 consumes them", async () => {
    const context = await isolatedMigratedContext();
    try {
      const services = servicesFor(context.db);
      await runFixture(services, vndbFixture, "worker-vndb-seed-gating");

      // The recorded importer authored a seed HINT for v1001. It is persisted as
      // INERT evidence — carrying its source-fact provenance, but never directly
      // benchmark-selectable.
      const allSeeds = await services.catalogRepository.listSeedTargets(actor);
      const importerSeed = required(
        allSeeds.find(
          (seed) =>
            seed.sourceId === "v1001" && seed.seedOrigin === catalogSeedOriginValues.importer,
        ),
        "importer seed hint for v1001",
      );
      expect(importerSeed.status).toBe(catalogSeedStatusValues.inert);
      expect(importerSeed.sourceProvenanceId).not.toBeNull();

      // A raw importer hint is excluded from both the actionable pending set and
      // the benchmark-selectable candidate query.
      const pendingSeeds = await services.catalogRepository.listSeedTargets(
        actor,
        catalogSeedStatusValues.pending,
      );
      expect(pendingSeeds.map((seed) => seed.sourceId)).not.toContain("v1001");

      const selectableBefore =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      expect(selectableBefore.map((seed) => seed.sourceId)).not.toContain("v1001");

      // CATALOG-004 readiness filtering consumes the inert hint: it promotes the
      // same seed target (natural key preserved) to a selectable status and records
      // a readiness explanation, while preserving the source-fact provenance.
      await services.catalogRepository.recordSeedTarget(actor, {
        seedTargetId: importerSeed.seedTargetId,
        catalogSource: importerSeed.catalogSource,
        sourceId: importerSeed.sourceId,
        seedOrigin: importerSeed.seedOrigin,
        originRef: importerSeed.originRef ?? undefined,
        sourceProvenanceId: importerSeed.sourceProvenanceId ?? undefined,
        status: catalogSeedStatusValues.pending,
        priority: importerSeed.priority,
        metadata: {
          ...importerSeed.metadata,
          [catalogSeedReadinessExplanationMetadataKey]: {
            readiness: "supported",
            explanationCodes: ["readiness_adapter_supported"],
          },
        },
      });

      const selectableAfter =
        await services.catalogRepository.listBenchmarkSelectableSeedTargets(actor);
      const selected = required(
        selectableAfter.find((seed) => seed.sourceId === "v1001"),
        "benchmark-selectable v1001 after CATALOG-004 consumption",
      );
      expect(selected.status).toBe(catalogSeedStatusValues.pending);
      expect(selected.metadata[catalogSeedReadinessExplanationMetadataKey]).toMatchObject({
        readiness: "supported",
      });
      expect(selected.sourceProvenanceId).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
