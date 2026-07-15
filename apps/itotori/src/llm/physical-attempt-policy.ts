import {
  LlmRetriesExhaustedError,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
  type LlmStepAttemptContext,
  type LlmStepExecution,
} from "@itotori/db";
import type { CallSpec } from "../contracts/index.js";

const MAX_PHYSICAL_ATTEMPTS = 3;
const MAX_JITTER_MS = 8_000;

type TransportFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MeasuredModelProfile {
  name: CallSpec["modelProfile"];
  version: string;
  deadlines: { normalMs: number; deepMs: number };
  maxAttemptExposureUsd: string;
}

export interface RetryRuntime {
  random: () => number;
  sleep: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface PhysicalAttemptRuntime {
  profile: MeasuredModelProfile;
  admission: { scope: string; confirmedCostCapUsd: string };
  signal?: AbortSignal;
  retry?: Partial<RetryRuntime>;
}

export type TransportObservation =
  | { kind: "response"; httpStatus: number; retryAfterMs: number | null }
  | { kind: "transport-error" };

export interface TransportObserver {
  fetcher: TransportFetcher;
  beginAttempt(): void;
  take(): TransportObservation | null;
}

export interface PhysicalAttemptControl {
  signal: AbortSignal;
  failure(error?: unknown): LlmAttemptFailure | null;
}

export class LlmPhysicalAttemptError extends Error {
  constructor(readonly failure: LlmAttemptFailure) {
    super(`physical model attempt stopped: ${failure.classification}/${failure.kind}`);
    this.name = "LlmPhysicalAttemptError";
  }
}

export function resolveAttemptDeadlineMs(spec: CallSpec, profile: MeasuredModelProfile): number {
  assertProfile(spec, profile);
  return spec.limits.timeoutClass === "deep"
    ? profile.deadlines.deepMs
    : profile.deadlines.normalMs;
}

export function createTransportObserver(
  base: TransportFetcher = globalThis.fetch,
): TransportObserver {
  let observation: TransportObservation | null = null;
  return {
    beginAttempt() {
      observation = null;
    },
    take() {
      const current = observation;
      observation = null;
      return current;
    },
    async fetcher(input, init) {
      try {
        const response = await base(input, init);
        observation = {
          kind: "response",
          httpStatus: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        };
        return response;
      } catch (error: unknown) {
        observation = { kind: "transport-error" };
        throw error;
      }
    },
  };
}

export async function memoizedPhysicalAttempt(input: {
  store: LlmCallMemoStore;
  memo: Omit<LlmMemoSingleflightInput, "admission" | "execute">;
  spec: CallSpec;
  runtime: PhysicalAttemptRuntime;
  observer: TransportObserver;
  execute: (
    attempt: LlmStepAttemptContext,
    control: PhysicalAttemptControl,
  ) => Promise<LlmStepExecution>;
}): Promise<LlmMemoSingleflightResult> {
  const deadlineMs = resolveAttemptDeadlineMs(input.spec, input.runtime.profile);
  const retry = retryRuntime(input.runtime.retry);
  while (true) {
    throwIfCancelled(input.runtime.signal);
    const stored = await input.store.singleflight({
      ...input.memo,
      admission: {
        scope: input.runtime.admission.scope,
        confirmedCostCapUsd: input.runtime.admission.confirmedCostCapUsd,
        maxAttemptExposureUsd: input.runtime.profile.maxAttemptExposureUsd,
        deadlineMs,
      },
      execute: async (attempt) => {
        input.observer.beginAttempt();
        const deadline = attemptDeadline(deadlineMs, input.runtime.signal, input.observer);
        try {
          return await input.execute(attempt, deadline.control);
        } finally {
          deadline.clear();
        }
      },
    });
    if (stored.kind === "completed") return stored;
    if (stored.failure.classification !== "transient") {
      throw new LlmPhysicalAttemptError(stored.failure);
    }
    if (stored.attemptOrdinal >= MAX_PHYSICAL_ATTEMPTS) {
      throw new LlmRetriesExhaustedError(stored.memoKey, stored.attemptOrdinal);
    }
    const delayMs = retryDelayMs(stored.attemptOrdinal, stored.failure.retryAfterMs, retry.random);
    await retry.sleep(delayMs, input.runtime.signal);
  }
}

function attemptDeadline(
  deadlineMs: number,
  cancellation: AbortSignal | undefined,
  observer: TransportObserver,
): { control: PhysicalAttemptControl; clear: () => void } {
  const controller = new AbortController();
  let deadlineExpired = false;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error(`physical attempt exceeded profile deadline ${deadlineMs}ms`));
  }, deadlineMs);
  const signal = cancellation
    ? AbortSignal.any([cancellation, controller.signal])
    : controller.signal;
  return {
    clear: () => clearTimeout(timer),
    control: {
      signal,
      failure(error?: unknown) {
        const observation = observer.take();
        if (deadlineExpired) {
          return {
            classification: "transient",
            kind: "deadline",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
        if (cancellation?.aborted) {
          return {
            classification: "cancelled",
            kind: "cancelled",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
        if (observation?.kind === "response") {
          return observation.httpStatus >= 400
            ? {
                classification: retryableHttpStatus(observation.httpStatus)
                  ? "transient"
                  : "permanent",
                kind: "http",
                httpStatus: observation.httpStatus,
                retryAfterMs: observation.retryAfterMs,
              }
            : null;
        }
        if (observation?.kind === "transport-error") {
          return {
            classification: "transient",
            kind: "transport",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
        if (error !== undefined) {
          return {
            classification: "permanent",
            kind: "transport",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
        return null;
      },
    },
  };
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(
  attemptOrdinal: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const ceiling = Math.min(MAX_JITTER_MS, 1_000 * 2 ** (attemptOrdinal - 1));
  return Math.floor(clamp(random(), 0, 1) * ceiling);
}

function retryRuntime(overrides: Partial<RetryRuntime> | undefined): RetryRuntime {
  return {
    random: overrides?.random ?? Math.random,
    sleep: overrides?.sleep ?? abortableSleep,
  };
}

function abortableSleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(cancelledError());
      },
      { once: true },
    );
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): LlmPhysicalAttemptError {
  return new LlmPhysicalAttemptError({
    classification: "cancelled",
    kind: "cancelled",
    httpStatus: null,
    retryAfterMs: null,
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function assertProfile(spec: CallSpec, profile: MeasuredModelProfile): void {
  if (profile.name !== spec.modelProfile || profile.version !== spec.modelProfileVersion) {
    throw new Error("measured model profile does not match the call specification");
  }
  for (const [name, value] of Object.entries(profile.deadlines)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`model profile ${name} deadline must be a positive safe integer`);
    }
  }
  if (profile.deadlines.deepMs < profile.deadlines.normalMs) {
    throw new Error("model profile deep deadline cannot be shorter than normal");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(profile.maxAttemptExposureUsd)) {
    throw new Error("model profile attempt exposure must be an exact nonnegative decimal");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
