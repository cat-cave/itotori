import { z } from "zod";
import {
  IdentifierSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./shared.js";
import { ToolResultSchema } from "./tools.js";

export const DispatchEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run-started"), iteration: NonNegativeIntegerSchema }).strict(),
  z
    .object({
      kind: z.literal("model-step-finished"),
      iteration: NonNegativeIntegerSchema,
      servedModel: IdentifierSchema,
      finishReason: z.enum(["stop", "tool-calls", "length", "content-filter", "unknown"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-step-finished"),
      iteration: NonNegativeIntegerSchema,
      toolCallId: IdentifierSchema,
      tool: ToolNameSchema,
      argumentsHash: Sha256Schema,
      result: ToolResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("run-finished"),
      iterationCount: NonNegativeIntegerSchema,
      toolCallCount: NonNegativeIntegerSchema,
      finishReason: z.enum(["stop", "length", "content-filter", "unknown"]),
    })
    .strict(),
]);

export type DispatchEvent = z.infer<typeof DispatchEventSchema>;
