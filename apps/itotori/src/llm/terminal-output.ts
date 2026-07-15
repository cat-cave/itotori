import { z } from "zod";
import {
  DefectBundleSchema,
  DraftBatchSchema,
  LocalizedRenderingSchema,
  ReviewVerdictSchema,
  WikiObjectSchema,
  type CallSpec,
  type TerminalOutput,
} from "../contracts/index.js";

export function terminalOutputSchema(output: CallSpec["output"]): z.ZodType<TerminalOutput> {
  switch (output.name) {
    case "wiki-object":
      return WikiObjectSchema;
    case "localized-rendering":
      return LocalizedRenderingSchema;
    case "draft-batch":
      return DraftBatchSchema;
    case "review-verdict":
      return ReviewVerdictSchema;
    case "defect-bundle":
      return DefectBundleSchema;
  }
}

function replaceExclusiveUnions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceExclusiveUnions);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, child]) => [
    key === "oneOf" ? "anyOf" : key,
    replaceExclusiveUnions(child),
  ]);
  return Object.fromEntries(entries);
}

export function providerTerminalSchema(output: CallSpec["output"]): z.ZodType<TerminalOutput> {
  const schema = terminalOutputSchema(output);
  const standard = schema["~standard"];
  // The adapter rejects oneOf before sending; Zod still performs exact local validation.
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: (options) =>
          replaceExclusiveUnions(standard.jsonSchema.input(options)) as Record<string, unknown>,
        output: (options) =>
          replaceExclusiveUnions(standard.jsonSchema.output(options)) as Record<string, unknown>,
      },
    },
  } as z.ZodType<TerminalOutput>;
}
