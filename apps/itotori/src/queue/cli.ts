import type { LoadQueueHealthOptions, QueueHealthReadModel } from "@itotori/db";
import { assertQueueHealthReadModel } from "../api-schema.js";

/**
 * ITOTORI-047 — CLI-facing surface for queue-health inspection. Closes over
 * the authorization actor so CLI handlers do not thread it through. The returned
 * read-model is the SAME typed {@link QueueHealthReadModel} the
 * `queue.health` API route emits (dashboard + CLI share one typed contract,
 * never dumped strings).
 */
export type QueueHealthCliPort = {
  loadQueueHealth(options?: LoadQueueHealthOptions): Promise<QueueHealthReadModel>;
};

export type QueueHealthCliArgs = {
  outputPath: string;
  deadLetterLimit?: number;
  projectId?: string;
};

export type QueueHealthCliWriter = {
  writeJson(path: string, value: unknown): void;
};

/**
 * ITOTORI-047 — load the typed queue-health read-model and write it to the
 * output path. The written JSON is asserted against the `queue.health` API
 * response contract BEFORE it is persisted, so the CLI output IS a validated
 * typed API response (not a dumped string) and a read-model/CLI divergence
 * fails loudly here rather than silently shipping a different shape.
 */
export async function runQueueHealthCli(
  args: QueueHealthCliArgs,
  port: QueueHealthCliPort,
  io: QueueHealthCliWriter,
): Promise<QueueHealthReadModel> {
  const options: LoadQueueHealthOptions = {};
  if (args.deadLetterLimit !== undefined) {
    options.deadLetterLimit = args.deadLetterLimit;
  }
  if (args.projectId !== undefined) {
    options.projectId = args.projectId;
  }
  const model = await port.loadQueueHealth(options);
  assertQueueHealthReadModel(model);
  io.writeJson(args.outputPath, model);
  return model;
}
