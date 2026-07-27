import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { ItotoriLlmRetentionRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import {
  FIELD_CIPHER_KEY_ENV_VAR,
  createFieldMemoCipher,
} from "../src/composition/live/field-cipher.js";
import { startItotoriServer } from "../src/server-runtime.js";
import {
  createRetentionScheduler,
  type RetentionSchedulerEvent,
} from "../src/services/retention-scheduler.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("server retention scheduler", () => {
  it("runs after the server listens and deletes expired persisted ciphertext", async () => {
    const context = await isolatedMigratedContext();
    const cipher = createFieldMemoCipher({
      [FIELD_CIPHER_KEY_ENV_VAR]: randomBytes(32).toString("base64"),
    });
    const sealed = await cipher.seal("scheduled-retention-sentinel");
    const events: RetentionSchedulerEvent[] = [];
    const scheduler = createRetentionScheduler({
      deleteExpired: () =>
        new ItotoriLlmRetentionRepository(context.pool, cipher).deleteExpired(
          new Date("2020-01-03T00:00:00.000Z"),
        ),
      observe: (event) => events.push(event),
    });
    let server: ReturnType<typeof startItotoriServer> | undefined;
    try {
      await context.pool.query(
        `insert into itotori_llm_human_inputs (
           input_id, input_kind, subject_ref, human_input_ciphertext, human_input_key_ref,
           human_input_content_hash, created_at, retention_deadline
         ) values ($1, 'feedback', 'scheduler-proof', $2, $3, $4, $5, $6)`,
        [
          "scheduler-expired-input",
          Buffer.from(sealed.ciphertext),
          sealed.keyRef,
          `sha256:${createHash("sha256").update("scheduled-retention-sentinel").digest("hex")}`,
          "2020-01-01T00:00:00.000Z",
          "2020-01-02T00:00:00.000Z",
        ],
      );

      server = startItotoriServer({ port: 0, retentionScheduler: scheduler });
      await once(server, "listening");
      const completed = await waitForCompletion(events);
      expect(events[0]).toMatchObject({ kind: "retention_scheduler_started" });
      expect(completed.report).toMatchObject({ deletedRows: 1, releasedKeyRefs: 1 });
      await expect(
        context.pool.query(
          `select human_input_ciphertext, deletion_state, deleted_at
           from itotori_llm_human_inputs where input_id = 'scheduler-expired-input'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            human_input_ciphertext: null,
            deletion_state: "deleted",
            deleted_at: expect.any(Date),
          },
        ],
      });
    } finally {
      if (server !== undefined) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
      await context.close();
    }
  });
});

async function waitForCompletion(
  events: readonly RetentionSchedulerEvent[],
): Promise<Extract<RetentionSchedulerEvent, { kind: "retention_deletion_completed" }>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const completed = events.find(
      (
        event,
      ): event is Extract<RetentionSchedulerEvent, { kind: "retention_deletion_completed" }> =>
        event.kind === "retention_deletion_completed",
    );
    if (completed !== undefined) return completed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("retention scheduler never completed after server startup");
}
