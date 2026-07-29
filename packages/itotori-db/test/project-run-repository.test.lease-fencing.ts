import { describe, expect, it } from "vitest";
import { ItotoriProjectRunRepositoryError } from "../src/repositories/project-run-repository.js";
import { actor, leaseInput, runFixture, runInput } from "./project-run-test-fixtures.js";

describe("ItotoriProjectRunRepository", () => {
  it("renews a lease, rejects a stale fence, and resumes with a newer fencing token", async () => {
    const fixture = await runFixture("lease");
    try {
      await fixture.runs.createRun(actor, runInput(fixture, "run-lease", 100));
      const first = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-lease", "driver-first"),
      );
      const renewed = await fixture.runs.renewLease(actor, {
        lease: first,
        leaseDurationSeconds: 120,
      });
      expect(renewed.fenceToken).toBe(first.fenceToken);
      await expect(
        fixture.runs.acquireLease(actor, leaseInput(fixture, "run-lease", "driver-other")),
      ).rejects.toMatchObject({
        code: "lease_unavailable",
      } satisfies Partial<ItotoriProjectRunRepositoryError>);
      await fixture.runs.advanceRun(actor, { lease: renewed, status: "running" });
      await fixture.runs.advanceRun(actor, { lease: renewed, status: "paused" });
      await fixture.runs.releaseLease(actor, renewed);

      const resumed = await fixture.runs.acquireLease(
        actor,
        leaseInput(fixture, "run-lease", "driver-resumed"),
      );
      expect(resumed.fenceToken).toBeGreaterThan(first.fenceToken);
      await expect(
        fixture.runs.advanceRun(actor, { lease: renewed, status: "running" }),
      ).rejects.toMatchObject({
        code: "fence_rejected",
      } satisfies Partial<ItotoriProjectRunRepositoryError>);
      const run = await fixture.runs.advanceRun(actor, { lease: resumed, status: "running" });
      expect(run.status).toBe("running");
    } finally {
      await fixture.context.close();
    }
  });
});
