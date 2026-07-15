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

// ITOTORI-241 - ZDR is a SETTING (a capability + privacy filter), NOT a
// provider pin. A provider policy enforces exactly three things: (a) the
// capabilities every role needs - strict structured/JSON-schema final
// output and typed tool-calling, gated by `requireParameters: true` so
// OpenRouter only routes to providers that honor them; (b) the ZDR /
// data-collection privacy posture (`zdr: true` + `dataCollection: "deny"`),
// which is also what CONFINES fallback to the account ZDR allow-list; and
// (c) OpenRouter automatic fallback across every compliant provider
// (`allowFallbacks: true`).
//
// It names NO provider. A single-provider pin - a non-empty `only`, a
// hardcoded provider `order`, or `allowFallbacks: false` - is what turned a
// transient upstream HTTP 429 into a total outage; it is structurally
// impossible here. `.strict()` rejects an `only` or `order` key outright,
// and `allowFallbacks` must be literally `true`. The actually-served
// (model, provider) pair is RECORDED per call as telemetry, never pinned as
// input.
export const ProviderPolicySchema = z
  .object({
    allowFallbacks: z.literal(true),
    zdr: z.literal(true),
    dataCollection: z.literal("deny"),
    requireParameters: z.literal(true),
  })
  .strict();

/**
 * Fail loud, with a domain message, when a raw provider-policy input tries
 * to pin a single provider. `ProviderPolicySchema` already rejects these
 * structurally; this guard is the construction seam that explains WHY, so
 * the ITOTORI-241 anti-pattern can never be reintroduced silently.
 */
export function assertNoProviderPin(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  const pins: string[] = [];
  if ("only" in record) pins.push("only");
  if ("order" in record) pins.push("order");
  if (record.allowFallbacks === false) pins.push("allowFallbacks:false");
  if (pins.length > 0) {
    throw new Error(
      `provider policy must not pin a provider (found ${pins.join(
        ", ",
      )}): ZDR is a setting, not a provider pin - enforce capability + ZDR + automatic fallback (allowFallbacks:true) and name no provider`,
    );
  }
}

// ITOTORI-241 - OpenRouter inference-PROVIDER (routing endpoint) slugs, distinct
// from model-family/vendor names. A profile identity keyed by model+capability
// must never embed one of these, or a provider would be smuggled back into the
// identity (e.g. `deepseek-v4-flash-fireworks`) even when the policy is
// provider-free. Model-vendor tokens (deepseek, gpt, claude, ...) are NOT here,
// so a legitimate model-keyed id like `deepseek-v4-flash` is accepted.
export const KNOWN_OPENROUTER_PROVIDER_TOKENS: ReadonlySet<string> = new Set([
  "fireworks",
  "parasail",
  "deepinfra",
  "together",
  "novita",
  "hyperbolic",
  "lambda",
  "nebius",
  "sambanova",
  "cerebras",
  "groq",
  "avian",
  "featherless",
  "inflection",
  "mancer",
  "atoma",
  "phala",
  "enfer",
  "gmicloud",
  "ncompass",
  "kluster",
  "friendli",
  "baseten",
  "crusoe",
]);

/**
 * Fail loud when a profile IDENTITY names an inference provider. Identity is
 * keyed by model + capability, never by a provider; a provider-bearing id
 * (e.g. `deepseek-v4-flash-fireworks`) re-smuggles a pin into the identity
 * even when the policy is provider-free. Matched on hyphen/underscore/dot
 * delimited tokens so a model-keyed id (`deepseek-v4-flash`) is accepted.
 */
export function assertProfileIdNamesNoProvider(profileId: string): void {
  const named = profileId
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => KNOWN_OPENROUTER_PROVIDER_TOKENS.has(token));
  if (named.length > 0) {
    throw new Error(
      `profile identity must not name a provider (found ${named.join(
        ", ",
      )}): identity is keyed by model + capability, not by a provider`,
    );
  }
}

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
export type EncryptedPayloadRef = z.infer<typeof EncryptedPayloadRefSchema>;
