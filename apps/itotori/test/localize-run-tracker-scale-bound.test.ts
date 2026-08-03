import { describe, expect, it } from "vitest";
import {
  LocalizeRunTracker,
  STARTUP_PROGRESS_BATCH_SIZE,
} from "../src/cli/localize-run-tracker.js";

describe("LocalizeRunTracker startup scale bound", () => {
  it("keeps 80k startup progress writes at the hard batch cap", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    let writes = 0;
    const tracker = new LocalizeRunTracker(
      {
        async createOrResumeRun() {
          return undefined as never;
        },
        async acquireLease() {
          return {
            projectId: "scale-project",
            runId: "scale-run",
            leaseOwnerId: "scale-worker",
            fenceToken: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          };
        },
        async renewLease() {
          throw new Error("renewal should not run during this test");
        },
        async releaseLease() {},
        async advanceRun() {
          return undefined as never;
        },
        async recordProgress() {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          writes += 1;
          await new Promise((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return undefined as never;
        },
        async reserveCost() {
          return undefined as never;
        },
        async settleCost() {
          return undefined as never;
        },
        async releaseCost(input) {
          return {
            reservationId: input.reservationId,
            reservedMicrosUsd: 0,
            settledMicrosUsd: null,
            state: "released" as const,
            createdAt: new Date(),
            settledAt: null,
            releasedAt: new Date(),
          };
        },
        async loadLiveReadModel() {
          return null;
        },
      },
      {
        projectId: "scale-project",
        runId: "scale-run",
        localeBranchId: "scale-branch",
        contextSnapshotId: "scale-context",
        localizationSnapshotId: "scale-localization",
        leaseOwnerId: "scale-worker",
        capMicrosUsd: null,
      },
    );

    await tracker.start(Array.from({ length: 80_000 }, (_, index) => `unit-${index}`));

    expect(writes).toBe(80_000);
    expect(peakInFlight).toBe(STARTUP_PROGRESS_BATCH_SIZE);
    await tracker.fail();
  });
});
