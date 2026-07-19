import type {
  LlmRouterAttemptEvidence,
  LlmServedPair,
  LlmStepBilling,
  LlmStepUsage,
} from "@itotori/db";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { z } from "zod";

type TransportFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const RouteValueSchema = z.string().min(1).max(256).refine(isTrimmed, "route value is not trimmed");
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
export interface GenerationMetadata {
  generationId: string | null;
  served: LlmServedPair;
  routerAttempts: readonly LlmRouterAttemptEvidence[];
  usage: LlmStepUsage | null;
  billing: LlmStepBilling;
  reportedCostUsd: string | null;
}

/**
 * A one-shot, post-request lookup of the generation OpenRouter actually
 * served. The request policy deliberately chooses no provider; this is the
 * only point at which a concrete provider is recorded.
 */
export type GenerationLookup = (
  generationId: string,
  signal?: AbortSignal,
) => Promise<GenerationMetadata>;

/** Post-hoc reconciliation is the authority for the served pair; it never
 * influences the pre-request provider policy. */
export const generationReconciliation = {
  enabled: true,
  endpoint: "/generation?id=<generation-id>",
  retries: "none",
} as const;

/**
 * Build the generation lookup used by the live dispatcher. It makes exactly
 * one authenticated GET and returns explicit unknown metadata when OpenRouter
 * has not made a generation available yet. The response body is reduced to
 * safe routing/accounting metadata and is never logged or persisted here.
 */
export function createOpenRouterGenerationLookup(input: {
  readonly apiKey: string;
  readonly fetcher?: TransportFetcher;
}): GenerationLookup {
  const fetcher = input.fetcher ?? globalThis.fetch;
  return async (generationId, signal) => {
    const url = new URL("https://openrouter.ai/api/v1/generation");
    url.searchParams.set("id", generationId);
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return unknownGenerationMetadata(generationId);
      const data = asRecord(asRecord(await response.json()).data);
      // Refuse a mismatched response: a provider pair is useful only when it
      // is bound to the exact generation our request produced.
      if (firstRouteValue(data.id) !== generationId) return unknownGenerationMetadata(generationId);
      const served = confirmedServedPair(data.model, data.provider_name ?? data.providerName);
      return {
        generationId,
        served,
        routerAttempts: decodeLookupRouterAttempts(
          data.provider_responses ?? data.providerResponses,
        ),
        usage: null,
        billing: lookupBilling(data.total_cost ?? data.totalCost),
        reportedCostUsd: decimalCost(data.total_cost ?? data.totalCost),
      };
    } catch {
      // A delayed/failed lookup must not turn a completed model response into
      // a fabricated route or expose provider error content. The durable
      // record remains explicitly unknown and can be reconciled later.
      return unknownGenerationMetadata(generationId);
    }
  };
}

/** Combine adapter-normalized metadata with the authoritative post-hoc lookup.
 * Inline metadata remains a compatibility fallback when the lookup is not
 * configured or cannot identify the generation. */
export async function reconcileGenerationMetadata(
  captured: GenerationMetadata,
  observedGenerationId: string | null,
  lookup: GenerationLookup | undefined,
): Promise<GenerationMetadata> {
  const generationId = observedGenerationId ?? captured.generationId;
  if (generationId === null || lookup === undefined) return captured;
  const reconciled = await lookup(generationId);
  return {
    ...reconciled,
    // Adapter-normalized usage is available before OpenRouter finishes its
    // accounting projection, so retain it whenever the lookup cannot provide
    // it. The served pair itself always comes from the lookup above.
    usage: reconciled.usage ?? captured.usage,
    billing: reconciled.billing.status === "confirmed" ? reconciled.billing : captured.billing,
    reportedCostUsd: reconciled.reportedCostUsd ?? captured.reportedCostUsd,
  };
}

/** Capture only metadata normalized by the upstream TanStack adapter. */
export function captureGenerationMetadata(chunks: readonly StreamChunk[]): GenerationMetadata {
  const finished = chunks.findLast((chunk) => chunk.type === EventType.RUN_FINISHED);
  if (!finished) return unknownGenerationMetadata();

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
  const unverifiedServed = decodeServedPair(event, rawEvent, openRouter);
  const routerAttempts = decodeRouterAttempts(openRouter.attempts);
  const usage = decodeUsage(event.usage);
  const reportedCostUsd = decimalCost(asRecord(event.usage).cost);
  const billing: LlmStepBilling =
    reportedCostUsd === null
      ? { status: "billing_unknown" }
      : { status: "confirmed", costUsd: reportedCostUsd };
  return {
    generationId,
    served:
      generationId !== null && unverifiedServed.status === "confirmed"
        ? unverifiedServed
        : { status: "unknown" },
    routerAttempts,
    usage,
    billing,
    reportedCostUsd,
  };
}

function unknownGenerationMetadata(generationId: string | null = null): GenerationMetadata {
  return {
    generationId,
    served: { status: "unknown" },
    routerAttempts: [],
    usage: null,
    billing: { status: "billing_unknown" },
    reportedCostUsd: null,
  };
}

function decodeLookupRouterAttempts(value: unknown): LlmRouterAttemptEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const attempt = asRecord(candidate);
    const parsed = RouterAttemptSchema.safeParse({
      ordinal: index + 1,
      model: attempt.model_permaslug ?? attempt.modelPermaslug,
      provider: attempt.provider_name ?? attempt.providerName,
      httpStatus: attempt.status,
    });
    return parsed.success ? [parsed.data] : [];
  });
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

function lookupBilling(value: unknown): LlmStepBilling {
  const costUsd = decimalCost(value);
  return costUsd === null ? { status: "billing_unknown" } : { status: "confirmed", costUsd };
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
