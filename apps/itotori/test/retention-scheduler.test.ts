import { describe, expect, it } from "vitest";
import {
  createRetentionScheduler,
  type RetentionSchedulerEvent,
} from "../src/services/retention-scheduler.js";

describe("retention scheduler", () => {
  it("keeps a deletion failure's identity in its emitted event", async () => {
    const failure = new Error("retention store is unavailable");
    const failedEvent = await new Promise<
      Extract<RetentionSchedulerEvent, { kind: "retention_deletion_failed" }>
    >((resolve) => {
      const scheduler = createRetentionScheduler({
        deleteExpired: async () => {
          throw failure;
        },
        observe: (event) => {
          if (event.kind !== "retention_deletion_failed") return;
          scheduler.stop();
          resolve(event);
        },
      });
      scheduler.start();
    });

    expect(failedEvent).toMatchObject({
      cause: {
        name: "Error",
        message: "retention store is unavailable",
      },
    });
  });
});
