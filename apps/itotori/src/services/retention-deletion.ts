import {
  ItotoriImmutableArtifactRetentionRepository,
  ItotoriLlmRetentionRepository,
  localUserId,
  withDatabase,
} from "@itotori/db";
import { createFieldMemoCipher } from "../composition/live/field-cipher.js";
import {
  createRetentionScheduler,
  type RetentionScheduler,
  type RetentionSchedulerEvent,
} from "./retention-scheduler.js";

/** Builds the production retention job. Each pass owns and closes its database
 * connection, so an idle daily timer holds no database resources open. */
export function createProductionRetentionScheduler(input: {
  readonly databaseUrl?: string;
  readonly observe?: (event: RetentionSchedulerEvent) => void;
}): RetentionScheduler {
  const schedulerInput = {
    deleteExpired: async () =>
      await withDatabase(async ({ pool, db }) => {
        const cipher = createFieldMemoCipher(process.env);
        const llm = await new ItotoriLlmRetentionRepository(pool, cipher).deleteExpired();
        const immutableArtifacts = await new ItotoriImmutableArtifactRetentionRepository(
          { pool, db },
          cipher,
        ).deleteExpired({ userId: localUserId });
        return { ...llm, immutableArtifacts };
      }, input.databaseUrl),
  };
  return input.observe === undefined
    ? createRetentionScheduler(schedulerInput)
    : createRetentionScheduler({ ...schedulerInput, observe: input.observe });
}
