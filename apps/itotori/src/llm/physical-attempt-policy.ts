import {
  LlmRetriesExhaustedError,
  isLlmDurabilityFault,
  type LlmAttemptFailure,
  type LlmCallMemoStore,
  type LlmDurabilityFaultInjector,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
  type LlmStepAttemptContext,
  type LlmStepExecution,
} from "@itotori/db";
import type { CallSpec } from "../contracts/index.js";
import { currentPhysicalAttemptCostObserver } from "./physical-attempt-cost-context.js";

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
  /**
   * A run-local observer that reserves bounded exposure immediately before a
   * real provider attempt and settles only the provider-confirmed result. It
   * is absent outside a project-run driver, so memo replay remains write-free.
   */
  runCostObserver?: PhysicalAttemptCostObserver;
  signal?: AbortSignal;
  retry?: Partial<RetryRuntime>;
  /** Live-Postgres recovery matrix seam; absent from normal dispatch. */
  durabilityFaults?: LlmDurabilityFaultInjector;
}

export interface PhysicalAttemptCostObserver {
  onAttemptStarted(input: {
    readonly memoKey: string;
    readonly attempt: LlmStepAttemptContext;
    readonly maxAttemptExposureUsd: string;
  }): Promise<void>;
  onAttemptCompleted(input: {
    readonly memoKey: string;
    readonly attempt: LlmStepAttemptContext;
    readonly execution: Extract<LlmStepExecution, { kind: "completed" }>;
  }): Promise<void>;
}

export type TransportObservation =
  | {
      kind: "response";
      httpStatus: number;
      retryAfterMs: number | null;
    }
  | { kind: "transport-error" }
  // The adapter can turn the injected process-death error into a generic
  // RUN_ERROR chunk. Preserve the provenance at the transport boundary so
  // the physical-step catch does not misclassify that chunk as transport.
  | { kind: "durability-fault" };

export interface TransportObserver {
  fetcher: TransportFetcher;
  beginAttempt(): void;
  take(): TransportObservation | null;
  /** The generation id observed from the provider response body, never from a
   * response header. It is used only for the post-request `/generation`
   * reconciliation path. */
  takeGenerationId(): Promise<string | null>;
}

/**
 * Which phase of a physical attempt raised a failure. `stream` covers the model
 * request itself being in flight (the transport boundary); `completion` covers
 * processing an already-collected stream. A transport-shaped failure raised in
 * the `stream` phase — even after a good (<400) response header — is a transient
 * mid-flight drop and is safe to retry; the same shape in the `completion` phase
 * is a deterministic error and must not be retried.
 */
export type AttemptPhase = "stream" | "completion";

export interface PhysicalAttemptControl {
  signal: AbortSignal;
  race<T>(pending: Promise<T>): Promise<T>;
  failure(error?: unknown, phase?: AttemptPhase): LlmAttemptFailure | null;
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
  durabilityFaults?: LlmDurabilityFaultInjector,
): TransportObserver {
  let observation: TransportObservation | null = null;
  let generationId: Promise<string | null> = Promise.resolve(null);
  return {
    beginAttempt() {
      observation = null;
      generationId = Promise.resolve(null);
    },
    take() {
      const current = observation;
      observation = null;
      return current;
    },
    takeGenerationId() {
      return generationId;
    },
    async fetcher(input, init) {
      let pending: Promise<Response> | undefined;
      try {
        // The remote operation is underway before this boundary is exposed.
        // A fault here models a caller dying while a provider may still bill.
        pending = base(input, init);
        await durabilityFaults?.killAt("in-flight");
        const response = await pending;
        observation = {
          kind: "response",
          httpStatus: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        };
        generationId = observeGenerationId(response);
        return response;
      } catch (error: unknown) {
        // A request may settle after its caller is terminated. Consume a late
        // rejection only; it must not overwrite the persisted ambiguity.
        void pending?.catch(() => undefined);
        observation = isLlmDurabilityFault(error)
          ? { kind: "durability-fault" }
          : { kind: "transport-error" };
        throw error;
      }
    },
  };
}

/**
 * The TanStack adapter does not currently forward the OpenRouter generation
 * identifier. Read only that identifier from a cloned response stream so the
 * original response remains exclusively owned by the adapter. We deliberately
 * retain no response text and impose a small bound before abandoning an
 * unrecognised stream.
 */
async function observeGenerationId(response: Response): Promise<string | null> {
  try {
    const copy = response.clone();
    const contentType = copy.headers.get("content-type") ?? "";
    if (/application\/json/iu.test(contentType)) {
      return routeIdFromRecord(await copy.json());
    }
    if (!/text\/event-stream/iu.test(contentType) || copy.body === null) return null;
    const reader = copy.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return null;
        buffered += decoder.decode(next.value, { stream: true });
        if (buffered.length > 65_536) return null;
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline).replace(/\r$/u, "");
          buffered = buffered.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const generationId = routeIdFromJson(line.slice("data:".length).trim());
          if (generationId !== null) return generationId;
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  } catch {
    // Metadata capture must never interfere with a successful provider
    // response. Reconciliation will remain explicit-unknown for this step.
    return null;
  }
}

function routeIdFromJson(value: string): string | null {
  try {
    return routeIdFromRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function routeIdFromRecord(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id
    ? id
    : null;
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
  const runCostObserver = input.runtime.runCostObserver ?? currentPhysicalAttemptCostObserver();
  while (true) {
    throwIfCancelled(input.runtime.signal);
    let completedAttempt:
      | {
          readonly attempt: LlmStepAttemptContext;
          readonly execution: Extract<LlmStepExecution, { kind: "completed" }>;
        }
      | undefined;
    const stored = await input.store.singleflight({
      ...input.memo,
      ...(input.runtime.durabilityFaults
        ? { durabilityFaults: input.runtime.durabilityFaults }
        : {}),
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
          await runCostObserver?.onAttemptStarted({
            memoKey: input.memo.memoKey,
            attempt,
            maxAttemptExposureUsd: input.runtime.profile.maxAttemptExposureUsd,
          });
          const execution = await input.execute(attempt, deadline.control);
          if (execution.kind === "completed") completedAttempt = { attempt, execution };
          return execution;
        } finally {
          deadline.clear();
        }
      },
    });
    if (stored.kind === "completed") {
      if (!stored.memoHit && completedAttempt !== undefined) {
        await runCostObserver?.onAttemptCompleted({
          memoKey: input.memo.memoKey,
          ...completedAttempt,
        });
      }
      return stored;
    }
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
      race(pending) {
        return raceWithAbort(pending, signal);
      },
      failure(error?: unknown, phase?: AttemptPhase) {
        if (isLlmDurabilityFault(error)) {
          return {
            classification: "cancelled",
            kind: "cancelled",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
        const observation = observer.take();
        if (observation?.kind === "durability-fault") {
          return {
            classification: "cancelled",
            kind: "cancelled",
            httpStatus: null,
            retryAfterMs: null,
          };
        }
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
          if (observation.httpStatus >= 400) {
            return {
              classification: retryableHttpStatus(observation.httpStatus)
                ? "transient"
                : "permanent",
              kind: "http",
              httpStatus: observation.httpStatus,
              retryAfterMs: observation.retryAfterMs,
            };
          }
          // A good (<400) response header whose model stream then failed
          // mid-flight is a transient transport drop: the completion never
          // fully arrived, so the request is safe to retry under the bounded
          // attempt budget. A failure raised while PROCESSING an already
          // collected stream (`completion` phase) is a deterministic error and
          // stays out of the retry path.
          if (error !== undefined && phase === "stream") {
            return {
              classification: "transient",
              kind: "transport",
              httpStatus: null,
              retryAfterMs: null,
            };
          }
          return null;
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

function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("physical attempt aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("physical attempt aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
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
