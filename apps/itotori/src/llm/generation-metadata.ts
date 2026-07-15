import type {
  LlmRouterAttemptEvidence,
  LlmServedPair,
  LlmStepBilling,
  LlmStepUsage,
} from "@itotori/db";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { z } from "zod";

const RouteValueSchema = z.string().min(1).max(256).refine(isTrimmed, "route value is not trimmed");
const DecimalUsdSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u);
const ServedPairSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("confirmed"),
      model: RouteValueSchema,
      provider: RouteValueSchema,
    })
    .strict()
    .refine(
      (value) => value.model !== "unknown" && value.provider !== "unknown",
      "confirmed served route cannot use an unknown sentinel",
    ),
  z.object({ status: z.literal("unknown") }).strict(),
]);
const RouterAttemptSchema = z
  .object({
    ordinal: z.number().int().positive(),
    model: RouteValueSchema,
    provider: RouteValueSchema,
    httpStatus: z.number().int().min(100).max(599),
  })
  .strict();
const UsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
  })
  .strict();
const BillingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), costUsd: DecimalUsdSchema }).strict(),
  z.object({ status: z.literal("billing_unknown") }).strict(),
]);
const GenerationMetadataSchema = z
  .object({
    generationId: RouteValueSchema.nullable(),
    served: ServedPairSchema,
    routerAttempts: z.array(RouterAttemptSchema).max(64),
    usage: UsageSchema.nullable(),
    billing: BillingSchema,
    reportedCostUsd: DecimalUsdSchema.nullable(),
  })
  .strict();

export interface GenerationMetadata {
  generationId: string | null;
  served: LlmServedPair;
  routerAttempts: readonly LlmRouterAttemptEvidence[];
  usage: LlmStepUsage | null;
  billing: LlmStepBilling;
  reportedCostUsd: string | null;
}

export interface GenerationMetadataSource {
  lookup(input: { generationId: string | null }): Promise<GenerationMetadata>;
}

export type GenerationReconciliation = GenerationMetadata & {
  source: "inline" | "generation-lookup" | "unknown";
};

export const UNKNOWN_GENERATION_METADATA: GenerationMetadata = {
  generationId: null,
  served: { status: "unknown" },
  routerAttempts: [],
  usage: null,
  billing: { status: "billing_unknown" },
  reportedCostUsd: null,
};

export const unknownGenerationMetadataSource: GenerationMetadataSource = {
  async lookup() {
    return UNKNOWN_GENERATION_METADATA;
  },
};

/**
 * Consume additive RUN_FINISHED route metadata when the TanStack adapter exposes it.
 * Until that upstream surface lands, one injected generation lookup is attempted and
 * an absent or failed lookup remains explicitly unknown.
 */
export async function reconcileGenerationMetadata(
  chunks: readonly StreamChunk[],
  source: GenerationMetadataSource = unknownGenerationMetadataSource,
): Promise<GenerationReconciliation> {
  const inline = inlineGenerationMetadata(chunks);
  if (isVerified(inline)) return { ...inline, source: "inline" };

  let lookup: GenerationMetadata;
  try {
    lookup = GenerationMetadataSchema.parse(
      await source.lookup({ generationId: inline.generationId }),
    );
  } catch {
    return { ...inline, source: "unknown" };
  }

  if (
    inline.generationId !== null &&
    lookup.generationId !== null &&
    inline.generationId !== lookup.generationId
  ) {
    return { ...inline, source: "unknown" };
  }

  const reconciled: GenerationMetadata = {
    generationId: lookup.generationId ?? inline.generationId,
    served: lookup.served.status === "confirmed" ? lookup.served : inline.served,
    routerAttempts:
      lookup.routerAttempts.length > 0 ? lookup.routerAttempts : inline.routerAttempts,
    usage: lookup.usage ?? inline.usage,
    billing: lookup.billing.status === "confirmed" ? lookup.billing : inline.billing,
    reportedCostUsd: lookup.reportedCostUsd ?? inline.reportedCostUsd,
  };
  return {
    ...reconciled,
    source: isVerified(reconciled) ? "generation-lookup" : "unknown",
  };
}

export function inlineGenerationMetadata(chunks: readonly StreamChunk[]): GenerationMetadata {
  const finished = chunks.findLast((chunk) => chunk.type === EventType.RUN_FINISHED);
  if (!finished) return UNKNOWN_GENERATION_METADATA;

  const event = asRecord(finished);
  const rawEvent = asRecord(event.rawEvent);
  const providerMetadata = asRecord(event.providerMetadata);
  const openRouter =
    firstRecord(
      event.openrouterMetadata,
      event.openrouter_metadata,
      rawEvent.openrouterMetadata,
      rawEvent.openrouter_metadata,
      providerMetadata.openrouter,
    ) ?? {};
  const generationId = firstRouteValue(
    event.generationId,
    event.generation_id,
    rawEvent.generationId,
    rawEvent.generation_id,
    rawEvent.id,
  );
  const served = decodeServedPair(event, rawEvent, openRouter);
  const routerAttempts = decodeRouterAttempts(openRouter.attempts);
  const usage = decodeUsage(event.usage);
  const reportedCostUsd = decimalCost(asRecord(event.usage).cost);
  const billing: LlmStepBilling =
    reportedCostUsd === null
      ? { status: "billing_unknown" }
      : { status: "confirmed", costUsd: reportedCostUsd };
  return {
    generationId,
    served,
    routerAttempts,
    usage,
    billing,
    reportedCostUsd,
  };
}

function decodeServedPair(
  event: Readonly<Record<string, unknown>>,
  rawEvent: Readonly<Record<string, unknown>>,
  openRouter: Readonly<Record<string, unknown>>,
): LlmServedPair {
  const direct = firstRecord(event.served, rawEvent.served);
  if (direct !== null) {
    const parsed = ServedPairSchema.safeParse(direct);
    return parsed.success ? parsed.data : { status: "unknown" };
  }
  const hasDirectPair =
    Object.hasOwn(event, "servedModel") ||
    Object.hasOwn(rawEvent, "servedModel") ||
    Object.hasOwn(event, "servedProvider") ||
    Object.hasOwn(rawEvent, "servedProvider");
  if (hasDirectPair) {
    return confirmedServedPair(
      Object.hasOwn(event, "servedModel") ? event.servedModel : rawEvent.servedModel,
      Object.hasOwn(event, "servedProvider") ? event.servedProvider : rawEvent.servedProvider,
    );
  }

  const endpoints = asRecord(openRouter.endpoints);
  const available = Array.isArray(endpoints.available) ? endpoints.available : [];
  const selected = available.filter((candidate) => asRecord(candidate).selected === true);
  if (selected.length !== 1) return { status: "unknown" };
  const endpoint = asRecord(selected[0]);
  return confirmedServedPair(endpoint.model, endpoint.provider);
}

function confirmedServedPair(model: unknown, provider: unknown): LlmServedPair {
  const parsed = ServedPairSchema.safeParse({ status: "confirmed", model, provider });
  return parsed.success ? parsed.data : { status: "unknown" };
}

function decodeRouterAttempts(value: unknown): LlmRouterAttemptEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const attempt = asRecord(candidate);
    const parsed = RouterAttemptSchema.safeParse({
      ordinal: index + 1,
      model: attempt.model,
      provider: attempt.provider,
      httpStatus: attempt.status,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function decodeUsage(value: unknown): LlmStepUsage | null {
  const usage = asRecord(value);
  const parsed = UsageSchema.safeParse({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: asRecord(usage.completionTokensDetails).reasoningTokens ?? 0,
    cachedTokens: asRecord(usage.promptTokensDetails).cachedTokens ?? 0,
  });
  return parsed.success ? parsed.data : null;
}

function decimalCost(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const fixed = value.toFixed(12);
  if (Number(fixed) !== value) return null;
  return fixed.replace(/(?:\.0+|(?<fraction>\.\d*?)0+)$/u, "$<fraction>");
}

function isVerified(metadata: GenerationMetadata): boolean {
  return metadata.generationId !== null && metadata.served.status === "confirmed";
}

function firstRecord(...values: readonly unknown[]): Readonly<Record<string, unknown>> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return null;
}

function firstRouteValue(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const parsed = RouteValueSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function isTrimmed(value: string): boolean {
  return value.trim() === value;
}
