import {
  UNKNOWN_GENERATION_METADATA,
  type GenerationMetadata,
  type GenerationMetadataSource,
} from "./generation-metadata.js";

const GENERATION_LOOKUP_URL = "https://openrouter.ai/api/v1/generation";
// The /generation stats are eventually consistent — the served route is usually
// resolvable within ~5-8s of completion but can lag past 10s under load. The
// lookup returns the instant the route resolves, so a generous ceiling only
// affects the slow tail; too tight a window quarantines a legitimately-served
// call (observed: a 10s window missed a route that resolved moments later).
const MAX_LOOKUP_ATTEMPTS = 12;
const RETRY_DELAY_MS = 2_500;
const RETRY_WINDOW_MS = 30_000;

export interface OpenRouterGenerationLookupOptions {
  /** The existing ZDR-scoped OpenRouter credential. */
  readonly apiKey: string | undefined;
  /** Injection seam for deterministic tests; production uses the platform fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional cancellation for a run that owns this metadata source. */
  readonly signal?: AbortSignal;
  /** Test-only timing seam; production retains the bounded two-second backoff. */
  readonly retryDelayMs?: number;
}

/**
 * Resolve the final OpenRouter-served route after a streaming response. The
 * generation endpoint is eventually consistent, so a missing record or route
 * is retried briefly. A missing, malformed, failed, or cancelled lookup stays
 * unknown: this source never infers a provider from the requested route.
 */
export function openRouterGenerationLookup(
  options: OpenRouterGenerationLookupOptions,
): GenerationMetadataSource {
  const fetcher = options.fetch ?? globalThis.fetch;
  const retryDelayMs = boundedRetryDelay(options.retryDelayMs ?? RETRY_DELAY_MS);

  return {
    async lookup({ generationId }) {
      if (
        !isRouteValue(generationId) ||
        options.apiKey === undefined ||
        options.apiKey.trim().length === 0
      ) {
        return UNKNOWN_GENERATION_METADATA;
      }

      const lookup = boundedLookupSignal(options.signal);
      try {
        for (let attempt = 0; attempt < MAX_LOOKUP_ATTEMPTS; attempt += 1) {
          if (lookup.signal.aborted) return UNKNOWN_GENERATION_METADATA;

          const response = await fetcher(generationUrl(generationId), {
            method: "GET",
            headers: { Authorization: `Bearer ${options.apiKey}` },
            signal: lookup.signal,
          });
          const metadata = await responseMetadata(response, generationId);
          if (metadata !== null) return metadata;

          if (attempt === MAX_LOOKUP_ATTEMPTS - 1) return UNKNOWN_GENERATION_METADATA;
          const remainingMs = lookup.deadline - Date.now();
          if (remainingMs <= 0) return UNKNOWN_GENERATION_METADATA;
          await waitForRetry(Math.min(retryDelayMs, remainingMs), lookup.signal);
        }
      } catch {
        return UNKNOWN_GENERATION_METADATA;
      } finally {
        lookup.dispose();
      }

      return UNKNOWN_GENERATION_METADATA;
    },
  };
}

async function responseMetadata(
  response: Response,
  generationId: string,
): Promise<GenerationMetadata | null> {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenRouter generation lookup returned ${response.status}`);

  const root = asRecord(await response.json());
  const data = asRecord(root.data);
  const provider = routeValue(data.provider_name);
  const model = routeValue(data.model);
  if (provider === null || model === null) return null;

  const reportedCostUsd = decimalUsd(data.total_cost) ?? decimalUsd(data.usage);
  return {
    generationId,
    served: { status: "confirmed", provider, model },
    routerAttempts: routerAttempts(data.provider_responses),
    usage: usage(data),
    billing:
      reportedCostUsd === null
        ? { status: "billing_unknown" }
        : { status: "confirmed", costUsd: reportedCostUsd },
    reportedCostUsd,
  };
}

function generationUrl(generationId: string): string {
  const url = new URL(GENERATION_LOOKUP_URL);
  url.searchParams.set("id", generationId);
  return url.toString();
}

function routerAttempts(value: unknown): GenerationMetadata["routerAttempts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const attempt = asRecord(candidate);
    const provider = routeValue(attempt.provider_name);
    const model = routeValue(attempt.model_permaslug);
    const httpStatus = httpStatusCode(attempt.status);
    return provider === null || model === null || httpStatus === null
      ? []
      : [{ ordinal: index + 1, provider, model, httpStatus }];
  });
}

function usage(value: Readonly<Record<string, unknown>>): GenerationMetadata["usage"] {
  const promptTokens = nonnegativeInteger(value.tokens_prompt);
  const completionTokens = nonnegativeInteger(value.tokens_completion);
  if (promptTokens === null || completionTokens === null) return null;
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: nonnegativeInteger(value.native_tokens_reasoning) ?? 0,
    cachedTokens: nonnegativeInteger(value.native_tokens_cached) ?? 0,
  };
}

function boundedLookupSignal(parent: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  readonly deadline: number;
  dispose(): void;
} {
  const controller = new AbortController();
  const deadline = Date.now() + RETRY_WINDOW_MS;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), RETRY_WINDOW_MS);
  return {
    signal: controller.signal,
    deadline,
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

function boundedRetryDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, RETRY_WINDOW_MS)) : RETRY_DELAY_MS;
}

function routeValue(value: unknown): string | null {
  return isRouteValue(value) ? value : null;
}

function isRouteValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    value.toLowerCase() !== "unknown"
  );
}

function httpStatusCode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function decimalUsd(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const fixed = value.toFixed(12);
  if (Number(fixed) !== value) return null;
  return fixed.replace(/(?:\.0+|(?<fraction>\.\d*?)0+)$/u, "$<fraction>");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
