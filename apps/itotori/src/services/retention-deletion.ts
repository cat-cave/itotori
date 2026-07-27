import { ItotoriLlmRetentionRepository, withDatabase } from "@itotori/db";
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
      await withDatabase(async ({ pool }) => {
        const cipher = createFieldMemoCipher(process.env);
        return await new ItotoriLlmRetentionRepository(pool, cipher).deleteExpired();
      }, input.databaseUrl),
  };
  return input.observe === undefined
    ? createRetentionScheduler(schedulerInput)
    : createRetentionScheduler({ ...schedulerInput, observe: input.observe });
}
