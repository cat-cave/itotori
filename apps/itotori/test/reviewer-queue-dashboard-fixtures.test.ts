import { describe, expect, it } from "vitest";
import { reviewQueueDashboardFixtures } from "../src/reviewer/index.js";

describe("reviewQueueDashboardFixtures", () => {
  it("covers pending, resolved, deferred, escalated, and batch-applied decisions", () => {
    const fixtures = reviewQueueDashboardFixtures();

    expect(fixtures.decisions.map((decision) => decision.dashboardState).sort()).toEqual([
      "batch_applied",
      "deferred",
      "escalated",
      "pending",
      "resolved",
    ]);
    expect(fixtures.decisions.every((decision) => decision.contextRefs.source.bridgeUnitId)).toBe(
      true,
    );
    expect(fixtures.batchAppliedPreview.allAllowed).toBe(true);
  });
});
