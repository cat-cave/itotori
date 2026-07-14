import { z } from "zod";

export const RUN_MODE_SCHEMA_VERSION = "itotori.run-mode.v1" as const;
export const CONTEXT_SCOPE_SCHEMA_VERSION = "itotori.context-scope.v1" as const;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:#/-]*$/u);

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const NonEmptyTextSchema = z.string().min(1).max(32_768);
export const ShortTextSchema = z.string().min(1).max(1_024);
export const LanguageTagSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const IsoDateSchema = z.iso.date();
export const DecimalUsdSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u);
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();

export const RunModeValueSchema = z.enum(["production", "pilot", "test-dev"]);

export const RunModeSchema = z
  .object({
    schemaVersion: z.literal(RUN_MODE_SCHEMA_VERSION),
    runMode: RunModeValueSchema,
  })
  .strict();

export const ContextScopeValueSchema = z.union([
  z.literal("whole-game"),
  z.literal("external-augmented"),
  z.string().regex(/^narrowed:[^\s].{0,127}$/u),
]);

export const ContextScopeSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_SCOPE_SCHEMA_VERSION),
    contextScope: ContextScopeValueSchema,
  })
  .strict();

export const RouteScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("route"), routeId: IdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("route-set"),
      routeIds: z.array(IdentifierSchema).min(1).max(128),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.routeIds).size !== value.routeIds.length) {
        context.addIssue({ code: "custom", message: "routeIds must be unique" });
      }
      if (
        value.routeIds.some((routeId, index) => index > 0 && routeId <= value.routeIds[index - 1]!)
      ) {
        context.addIssue({ code: "custom", message: "routeIds must be sorted" });
      }
    }),
]);

export const EntityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("game"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("route"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("scene"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("unit"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("character"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("glossary-term"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("choice"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("organization"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("user"), id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("genre"), id: IdentifierSchema }).strict(),
]);

export const RoleIdSchema = z.enum([
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
  "P1",
  "P2",
  "P3",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
]);

export const ToolNameSchema = z.enum([
  "decode_get_units",
  "decode_get_neighbors",
  "decode_get_route_graph",
  "decode_get_character_occurrences",
  "glossary_lookup",
  "outputs_get_accepted",
  "references_search",
  "web_search",
  "back_translate",
  "render_and_ocr",
]);

export const HashRefSchema = z
  .object({
    id: IdentifierSchema,
    hash: Sha256Schema,
  })
  .strict();

export const RevisionRefSchema = z
  .object({
    revisionId: IdentifierSchema,
    contentHash: Sha256Schema,
  })
  .strict();

export const AcceptedHeadSchema = z
  .object({
    headId: IdentifierSchema,
    version: PositiveIntegerSchema,
    contentHash: Sha256Schema,
  })
  .strict();

/** Content-bearing JSON is stored behind an authenticated encrypted reference. */
export const EncryptedPayloadRefSchema = z
  .object({
    storageRef: IdentifierSchema,
    contentHash: Sha256Schema,
    encryption: z.literal("operator-managed"),
  })
  .strict();

export const TokenUsageSchema = z
  .object({
    promptTokens: NonNegativeIntegerSchema,
    completionTokens: NonNegativeIntegerSchema,
    reasoningTokens: NonNegativeIntegerSchema,
    cachedTokens: NonNegativeIntegerSchema,
  })
  .strict();

export const ProviderPolicySchema = z
  .object({
    order: z.array(IdentifierSchema).min(1).max(8),
    only: z.array(IdentifierSchema).min(1).max(8),
    allowFallbacks: z.literal(false),
    zdr: z.literal(true),
    dataCollection: z.literal("deny"),
    requireParameters: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    const only = new Set(value.only);
    if (only.size !== value.only.length || new Set(value.order).size !== value.order.length) {
      context.addIssue({ code: "custom", message: "provider lists must be unique" });
    }
    if (
      value.order.length !== value.only.length ||
      value.order.some((provider) => !only.has(provider))
    ) {
      context.addIssue({ code: "custom", message: "provider order and only must match" });
    }
  });

export const SourceSpanSchema = z
  .object({
    spanId: IdentifierSchema,
    surface: z.enum(["source", "target"]),
    text: ShortTextSchema,
  })
  .strict();

export const ColorRgbSchema = z
  .object({
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  })
  .strict();

export const VisibilitySchema = z
  .object({
    routeScope: RouteScopeSchema,
    fromPlayOrder: NonNegativeIntegerSchema,
    throughPlayOrder: NonNegativeIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.throughPlayOrder !== null && value.throughPlayOrder < value.fromPlayOrder) {
      context.addIssue({ code: "custom", message: "visibility range is reversed" });
    }
  });

export type RunModeValue = z.infer<typeof RunModeValueSchema>;
export type RunMode = z.infer<typeof RunModeSchema>;
export type ContextScopeValue = z.infer<typeof ContextScopeValueSchema>;
export type ContextScope = z.infer<typeof ContextScopeSchema>;
export type RouteScope = z.infer<typeof RouteScopeSchema>;
export type EntityRef = z.infer<typeof EntityRefSchema>;
export type RoleId = z.infer<typeof RoleIdSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
