// Universal LLM invocation supervision.
//
// Provider adapters are deliberately dumb physical transports. Every
// production caller enters through this module, which owns physical attempt
// identity, persist-before-dispatch hooks, deadline/cancellation, deterministic
// JSON salvage, schema/semantic validation, corrective retries, route
// advancement, and the operational pause boundary.

import { randomUUID } from "node:crypto";
import { repairJsonObject } from "../localization/patchback-safety.js";
import {
  ModelProviderError,
  providerRunFromThrownError,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelMessage,
  type ModelProvider,
  type ProviderDescriptor,
  type ProviderRunRecord,
} from "../providers/types.js";

export const INVOCATION_HARD_RETRY_CEILING = 12;
export const INVOCATION_DEFAULT_DEADLINE_MS = 30_000;

export type InvocationFailureClass =
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_unavailable"
  | "empty"
  | "refusal"
  | "invalid_json"
  | "schema_invalid"
  | "semantic_invalid"
  | "itotori_bug";

export type InvocationValidationResult =
  | "accepted"
  | "schema_invalid"
  | "semantic_invalid"
  | "provider_failed"
  | "not_evaluated";

export type InvocationRetryDecision = "retry" | "advance" | "write" | "pause";

export type OperationalBlocker = {
  kind: "budget_cap" | "provider_outage" | "itotori_bug";
  detail: string;
  evidence: string;
  raisedAt: string;
  operatorAction: string;
};

export type InvocationAttemptStarted = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  requestedModelId: string;
  requestedProviderId: string;
  providerRunId: string;
  zdr: boolean;
  startedAt: string;
};

export type InvocationAttemptCompleted = InvocationAttemptStarted & {
  providerRun?: ProviderRunRecord;
  finishState: string;
  refusalState: string | null;
  validationResult: InvocationValidationResult;
  failureClass: InvocationFailureClass | null;
  retryDecision: InvocationRetryDecision;
  retryDelayMs: number | null;
  artifactRef: string;
  completedAt: string;
};

/** Durable hooks. `attemptStarted` must commit before the physical dispatch. */
export type InvocationLifecycle = {
  attemptStarted(attempt: InvocationAttemptStarted): Promise<void>;
  attemptCompleted(attempt: InvocationAttemptCompleted): Promise<void>;
  pauseRun(runId: string, blocker: OperationalBlocker): Promise<void>;
};

/**
 * Node-4 seam. This node asks whether dispatch is admitted; the later atomic
 * reservation node replaces the implementation without changing supervision.
 */
export type InvocationCostAdmission = {
  admit(input: {
    runId: string;
    bridgeUnitId: string;
    stage: string;
    agentLabel: string;
    request: ModelInvocationRequest;
    maximumCostUsd: number | null;
  }): Promise<
    | { admitted: true }
    | { admitted: false; detail: string; evidence: string; operatorAction?: string }
  >;
};

export type InvocationRetryPolicy = {
  hardAttemptCeiling: number;
  deadlineMs: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  jitterRatio: number;
  sameRouteAttempts: Readonly<Record<InvocationFailureClass, number>>;
};

export const DEFAULT_INVOCATION_RETRY_POLICY: InvocationRetryPolicy = {
  hardAttemptCeiling: INVOCATION_HARD_RETRY_CEILING,
  deadlineMs: INVOCATION_DEFAULT_DEADLINE_MS,
  baseDelayMs: 10,
  maximumDelayMs: 100,
  jitterRatio: 0.2,
  sameRouteAttempts: {
    rate_limited: 2,
    timeout: 1,
    network: 2,
    provider_unavailable: 2,
    empty: 2,
    refusal: 2,
    invalid_json: 2,
    schema_invalid: 2,
    semantic_invalid: 2,
    itotori_bug: 1,
  },
};

export type InvocationSupervisorContext = {
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId?: string;
  modelId?: string;
  providerId?: string;
  fallbackModels?: readonly string[];
  maximumCostUsd?: number;
  zdr?: boolean;
};

export type InvocationSupervisorOptions = {
  provider: ModelProvider;
  context?: InvocationSupervisorContext;
  lifecycle?: InvocationLifecycle;
  costAdmission?: InvocationCostAdmission;
  retryPolicy?: Partial<InvocationRetryPolicy>;
  now?: () => Date;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

export type StructuredInvocationOptions<T> = {
  request: ModelInvocationRequest;
  /** Null only for unstructured/tool calls that return the invocation itself. */
  parse: ((raw: string, invocation: ModelInvocationResult) => T) | null;
  validateParsed: (parsed: T) => void;
  /** Existing agent-specific completeness guard, run after universal checks. */
  validateResponse?: (invocation: ModelInvocationResult) => string;
  isSchemaValidationError?: (error: unknown) => boolean;
  requiredUnitIds?: readonly string[];
  successDecision?: "write" | "advance";
  /**
   * Stages that already hold a usable written candidate may stop after one
   * bounded pass and retain it with an annotation. Translation and speaker
   * calls keep the default and must eventually produce usable content.
   */
  contentFailureMode?: "must_succeed" | "retain_existing";
  /**
   * True for a tool-only contract. A model that never emits a tool call is the
   * degenerate-misconfiguration ceiling path, never a fabricated result.
   */
  requiresToolCall?: boolean;
};

export type StructuredInvocationResult<T> = {
  invocation: ModelInvocationResult;
  parsed: T;
  priorAttempts: ModelInvocationResult[];
};

type InvocationFailure = {
  kind: InvocationFailureClass;
  detail: string;
  error: unknown;
  invocation?: ModelInvocationResult;
  rawContent: string | null;
  retryAfterMs?: number;
};

type EvaluatedInvocation<T> =
  | { accepted: true; parsed: T }
  | { accepted: false; failure: InvocationFailure };

const SUPERVISOR_BINDING = Symbol("itotori.invocation-supervisor.binding");

type SupervisorBoundProvider = ModelProvider & {
  readonly [SUPERVISOR_BINDING]: InvocationSupervisor;
};

export class InvocationOperationalPauseError extends Error {
  constructor(
    readonly blocker: OperationalBlocker,
    readonly causeValue?: unknown,
  ) {
    super(`invocation paused (${blocker.kind}): ${blocker.detail}`);
    this.name = "InvocationOperationalPauseError";
  }
}

export class InvocationRetryCeilingError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastFailure: InvocationFailureClass,
    readonly detail: string,
  ) {
    super(
      `InvocationSupervisor hard retry ceiling ${attempts} reached after ${lastFailure}: ${detail}`,
    );
    this.name = "InvocationRetryCeilingError";
  }
}

/**
 * Content failure from a non-writing stage after its bounded route pass. The
 * caller may retain an already-written primary candidate and annotate the
 * incomplete QA/enrichment/repair; this is never an operational pause.
 */
export class InvocationContentExhaustedError extends Error {
  constructor(
    readonly failureClass: InvocationFailureClass,
    readonly detail: string,
  ) {
    super(`bounded ${failureClass} recovery exhausted: ${detail}`);
    this.name = "InvocationContentExhaustedError";
  }
}

class InvocationDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`provider attempt exceeded ${deadlineMs}ms deadline`);
    this.name = "InvocationDeadlineError";
  }
}

/** One implementation for every logical LLM call. */
export class InvocationSupervisor {
  readonly descriptor: ProviderDescriptor;
  private readonly context: InvocationSupervisorContext;
  private readonly standalone: boolean;
  private readonly policy: InvocationRetryPolicy;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(private readonly options: InvocationSupervisorOptions) {
    this.descriptor = options.provider.descriptor;
    this.standalone = options.context === undefined;
    this.context = options.context ?? standaloneContext();
    this.policy = mergeRetryPolicy(options.retryPolicy);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Execute and validate one structured logical call under the retry matrix. */
  async execute<T>(input: StructuredInvocationOptions<T>): Promise<StructuredInvocationResult<T>> {
    const routes = routeModels(this.context, input.request);
    const priorAttempts: ModelInvocationResult[] = [];
    const baseMessages = input.request.messages.map((message) => ({ ...message }));
    const logicalCallId =
      this.context.logicalCallId ??
      `${this.context.runId}:${this.context.bridgeUnitId}:${this.context.stage}:${this.context.agentLabel}:${randomUUID()}`;
    let request = applyContextPosture(input.request, this.context);
    let routeIndex = 0;
    let routeAttempt = 0;
    let totalAttempts = 0;
    let lastFailure: InvocationFailure | undefined;

    while (totalAttempts < this.policy.hardAttemptCeiling) {
      const requestedModelId = routes[routeIndex]!;
      const requestedProviderId = this.context.providerId ?? request.providerId;
      const attemptIndex = totalAttempts + 1;
      const attemptId = `llm-attempt-${randomUUID()}`;
      const startedAt = this.now().toISOString();
      const attemptStarted: InvocationAttemptStarted = {
        attemptId,
        runId: this.context.runId,
        bridgeUnitId: this.context.bridgeUnitId,
        stage: this.context.stage,
        agentLabel: this.context.agentLabel,
        logicalCallId,
        attemptIndex,
        requestedModelId,
        requestedProviderId,
        // Every adapter honors request.runId, so this physical identity is
        // known and durable before dispatch.
        providerRunId: attemptId,
        zdr: this.context.zdr ?? true,
        startedAt,
      };

      const routeRequest: ModelInvocationRequest = {
        ...request,
        modelId: requestedModelId,
        providerId: requestedProviderId,
        // A durable localization supervisor owns physical identity and
        // cross-model advancement. Standalone utility/fixture calls still pass
        // through this retry engine, but retain the adapter's own run identity
        // and fallback evidence because no attempt journal is attached.
        ...(this.standalone ? {} : { fallbackModels: [], runId: attemptId }),
      };

      await this.assertCostAdmission(routeRequest);
      await this.options.lifecycle?.attemptStarted(attemptStarted);
      totalAttempts += 1;

      let invocation: ModelInvocationResult;
      try {
        invocation = await this.dispatchWithDeadline(routeRequest);
      } catch (error) {
        const failure = classifyThrownFailure(error);
        lastFailure = failure;
        const routeAction = this.routeAction(failure, routeAttempt, routeIndex, routes.length);
        const retryDelayMs =
          routeAction.decision === "pause"
            ? null
            : this.retryDelay(failure, totalAttempts, routeAction.decision);
        await this.completeAttempt(attemptStarted, {
          failure,
          decision: routeAction.decision,
          retryDelayMs,
        });

        if (failure.kind === "itotori_bug") {
          if (this.standalone) throw error;
          await this.pauseAndThrow(
            "itotori_bug",
            failure.detail,
            evidenceForFailure(failure),
            "file and fix the itotori defect, then resume",
            error,
          );
        }
        if (routeAction.decision === "pause") {
          if (this.standalone) throw error;
          await this.pauseAndThrow(
            "provider_outage",
            `all configured routes exhausted after ${failure.kind}: ${failure.detail}`,
            evidenceForFailure(failure),
            "wait for provider recovery or change routing, then resume",
            error,
          );
        }
        const reachedOneRoutePass = routeAction.advance && routeIndex === routes.length - 1;
        if (reachedOneRoutePass && !isTransportFailure(failure.kind)) {
          if (this.standalone) throw error;
          if (mayReturnToExistingWrittenCandidate(this.context.stage)) {
            throw new InvocationContentExhaustedError(failure.kind, failure.detail);
          }
        }
        request = {
          ...request,
          messages: correctiveMessages(baseMessages, failure, input.requiredUnitIds ?? []),
        };
        ({ routeIndex, routeAttempt } = nextRoutePosition(
          routeAction,
          routeIndex,
          routeAttempt,
          routes.length,
        ));
        if (retryDelayMs !== null && retryDelayMs > 0) await this.sleep(retryDelayMs);
        continue;
      }

      const evaluated = evaluateStructuredInvocation(invocation, input);
      if (evaluated.accepted) {
        await this.options.lifecycle?.attemptCompleted({
          ...attemptStarted,
          providerRun: invocation.providerRun,
          finishState: invocation.finishReason,
          refusalState: null,
          validationResult: "accepted",
          failureClass: null,
          retryDecision: input.successDecision ?? "advance",
          retryDelayMs: null,
          artifactRef: `provider-run:${invocation.providerRun.runId}`,
          completedAt: this.now().toISOString(),
        });
        return { invocation, parsed: evaluated.parsed, priorAttempts };
      }

      const failure = evaluated.failure;
      lastFailure = failure;
      priorAttempts.push(invocation);
      const routeAction = this.routeAction(failure, routeAttempt, routeIndex, routes.length);
      const retryDelayMs = this.retryDelay(failure, totalAttempts, routeAction.decision);
      await this.completeAttempt(attemptStarted, {
        failure,
        decision: routeAction.decision,
        retryDelayMs,
      });

      if (failure.kind === "itotori_bug") {
        if (this.standalone) throw failure.error;
        await this.pauseAndThrow(
          "itotori_bug",
          failure.detail,
          evidenceForFailure(failure),
          "file and fix the itotori defect, then resume",
          failure.error,
        );
      }

      request = {
        ...request,
        messages: correctiveMessages(baseMessages, failure, input.requiredUnitIds ?? []),
      };
      const reachedOneRoutePass = routeAction.advance && routeIndex === routes.length - 1;
      if (reachedOneRoutePass) {
        // Direct agent/library calls have no durable run to pause or resume.
        // They still receive deterministic salvage + one bounded corrective
        // route pass, then preserve their established typed error contract.
        // Durable localization calls remain under the hard-ceiling/write or
        // retain-existing policies below.
        if (this.standalone && input.parse === null && failure.invocation !== undefined) {
          return {
            invocation: failure.invocation,
            parsed: failure.invocation as T,
            priorAttempts: priorAttempts.slice(0, -1),
          };
        }
        if (this.standalone) throw failure.error;
        if (
          input.contentFailureMode === "retain_existing" ||
          mayReturnToExistingWrittenCandidate(this.context.stage)
        ) {
          throw new InvocationContentExhaustedError(failure.kind, failure.detail);
        }
      }
      ({ routeIndex, routeAttempt } = nextRoutePosition(
        routeAction,
        routeIndex,
        routeAttempt,
        routes.length,
      ));
      if (retryDelayMs > 0) await this.sleep(retryDelayMs);
    }

    const ceilingFailure = lastFailure ?? {
      kind: "itotori_bug" as const,
      detail: "no provider attempt produced a classified result",
      error: new Error("unclassified retry ceiling"),
      rawContent: null,
    };
    const blocker = operationalBlocker(
      "itotori_bug",
      `hard retry ceiling ${this.policy.hardAttemptCeiling} reached; model/route cannot satisfy the invocation contract`,
      evidenceForFailure(ceilingFailure),
      "fix the model/tool/schema configuration, then resume",
      this.now(),
    );
    await this.options.lifecycle?.pauseRun(this.context.runId, blocker);
    throw new InvocationRetryCeilingError(
      this.policy.hardAttemptCeiling,
      ceilingFailure.kind,
      ceilingFailure.detail,
    );
  }

  private async assertCostAdmission(request: ModelInvocationRequest): Promise<void> {
    const providerAdmission = await this.options.provider.preflightInvocation?.(request);
    if (providerAdmission !== undefined && !providerAdmission.admitted) {
      await this.pauseAndThrow(
        "budget_cap",
        providerAdmission.detail,
        providerAdmission.evidence,
        providerAdmission.operatorAction ?? "raise the provider cost cap, then resume",
      );
    }
    const admission = await this.options.costAdmission?.admit({
      runId: this.context.runId,
      bridgeUnitId: this.context.bridgeUnitId,
      stage: this.context.stage,
      agentLabel: this.context.agentLabel,
      request,
      maximumCostUsd: this.context.maximumCostUsd ?? request.maxPriceUsd ?? null,
    });
    if (admission === undefined || admission.admitted) return;
    await this.pauseAndThrow(
      "budget_cap",
      admission.detail,
      admission.evidence,
      admission.operatorAction ?? "raise the cost cap, then resume",
    );
  }

  private async dispatchWithDeadline(
    request: ModelInvocationRequest,
  ): Promise<ModelInvocationResult> {
    const controller = new AbortController();
    const inheritedSignal = request.signal;
    const forwardAbort = (): void => controller.abort(inheritedSignal?.reason);
    if (inheritedSignal?.aborted) forwardAbort();
    inheritedSignal?.addEventListener("abort", forwardAbort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new InvocationDeadlineError(this.policy.deadlineMs));
          reject(new InvocationDeadlineError(this.policy.deadlineMs));
        }, this.policy.deadlineMs);
      });
      // This is the sole non-adapter physical dispatch in production.
      const dispatched = this.options.provider.invoke({ ...request, signal: controller.signal });
      return await Promise.race([dispatched, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      inheritedSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private routeAction(
    failure: InvocationFailure,
    routeAttempt: number,
    routeIndex: number,
    routeCount: number,
  ): { decision: InvocationRetryDecision; advance: boolean } {
    if (failure.kind === "itotori_bug") {
      return { decision: "pause", advance: true };
    }
    const attemptBound = this.policy.sameRouteAttempts[failure.kind];
    const advance = routeAttempt + 1 >= attemptBound;
    if (isTransportFailure(failure.kind) && advance && routeIndex === routeCount - 1) {
      return { decision: "pause", advance: true };
    }
    return { decision: advance ? "advance" : "retry", advance };
  }

  private retryDelay(
    failure: InvocationFailure,
    totalAttempts: number,
    decision: InvocationRetryDecision,
  ): number {
    if (decision === "pause") return 0;
    const retryAfter = failure.retryAfterMs;
    const exponential = Math.min(
      this.policy.maximumDelayMs,
      this.policy.baseDelayMs * 2 ** Math.max(0, totalAttempts - 1),
    );
    if (retryAfter !== undefined) {
      const honored = Math.min(this.policy.maximumDelayMs, retryAfter);
      const positiveJitter = honored * this.policy.jitterRatio * this.random();
      return Math.max(
        0,
        Math.min(this.policy.maximumDelayMs, Math.round(honored + positiveJitter)),
      );
    }
    const jitter = 1 - this.policy.jitterRatio + 2 * this.policy.jitterRatio * this.random();
    return Math.max(0, Math.round(exponential * jitter));
  }

  private async completeAttempt(
    started: InvocationAttemptStarted,
    args: {
      failure: InvocationFailure;
      decision: InvocationRetryDecision;
      retryDelayMs: number | null;
    },
  ): Promise<void> {
    const providerRun =
      args.failure.invocation?.providerRun ?? providerRunFromThrownError(args.failure.error);
    await this.options.lifecycle?.attemptCompleted({
      ...started,
      ...(providerRun !== undefined ? { providerRun } : {}),
      finishState: finishStateForFailure(args.failure),
      refusalState: args.failure.kind === "refusal" ? "refusal" : null,
      validationResult: validationResultForFailure(args.failure.kind),
      failureClass: args.failure.kind,
      retryDecision: args.decision,
      retryDelayMs: args.retryDelayMs,
      artifactRef: `provider-run:${started.providerRunId}`,
      completedAt: this.now().toISOString(),
    });
  }

  private async pauseAndThrow(
    kind: OperationalBlocker["kind"],
    detail: string,
    evidence: string,
    operatorAction: string,
    causeValue?: unknown,
  ): Promise<never> {
    const blocker = operationalBlocker(kind, detail, evidence, operatorAction, this.now());
    await this.options.lifecycle?.pauseRun(this.context.runId, blocker);
    throw new InvocationOperationalPauseError(blocker, causeValue);
  }
}

/** Bind run/journal supervision while retaining the provider descriptor API. */
export function supervisedModelProvider(supervisor: InvocationSupervisor): ModelProvider {
  const provider: SupervisorBoundProvider = {
    descriptor: supervisor.descriptor,
    [SUPERVISOR_BINDING]: supervisor,
    invoke: async (request) => executeModelInvocation(provider, request),
  };
  return provider;
}

/** Universal entry for unstructured/tool provider calls. */
export async function executeModelInvocation(
  provider: ModelProvider,
  request: ModelInvocationRequest,
): Promise<ModelInvocationResult> {
  const supervisor = supervisorFor(provider);
  const result = await supervisor.execute<ModelInvocationResult>({
    request,
    parse: null,
    validateParsed: () => undefined,
    successDecision: "advance",
  });
  return result.invocation;
}

/**
 * Raw delegation for a transport-decorating ModelProvider adapter that is
 * itself already executing beneath InvocationSupervisor (for example posture
 * injection or lazy provider construction). Production call sites must use
 * `executeModelInvocation`; the static guard limits direct dispatch surfaces.
 */
export function dispatchProviderAdapter(
  provider: ModelProvider,
  request: ModelInvocationRequest,
): Promise<ModelInvocationResult> {
  return provider.invoke(request);
}

/** Universal entry for schema/semantic structured calls. */
export function executeStructuredInvocation<T>(
  provider: ModelProvider,
  input: StructuredInvocationOptions<T>,
): Promise<StructuredInvocationResult<T>> {
  return supervisorFor(provider).execute(input);
}

export function isInvocationOperationalPause(
  error: unknown,
): error is InvocationOperationalPauseError {
  return error instanceof InvocationOperationalPauseError;
}

function supervisorFor(provider: ModelProvider): InvocationSupervisor {
  if (SUPERVISOR_BINDING in provider) {
    return (provider as SupervisorBoundProvider)[SUPERVISOR_BINDING];
  }
  return new InvocationSupervisor({ provider });
}

function standaloneContext(): InvocationSupervisorContext {
  const id = randomUUID();
  return {
    runId: `standalone-invocation-${id}`,
    bridgeUnitId: `standalone-unit-${id}`,
    stage: "standalone",
    agentLabel: "standalone",
  };
}

function mergeRetryPolicy(
  overrides: Partial<InvocationRetryPolicy> | undefined,
): InvocationRetryPolicy {
  const sameRouteAttempts = {
    ...DEFAULT_INVOCATION_RETRY_POLICY.sameRouteAttempts,
    ...overrides?.sameRouteAttempts,
  };
  const policy: InvocationRetryPolicy = {
    ...DEFAULT_INVOCATION_RETRY_POLICY,
    ...overrides,
    sameRouteAttempts,
  };
  if (
    !Number.isInteger(policy.hardAttemptCeiling) ||
    policy.hardAttemptCeiling < 1 ||
    policy.hardAttemptCeiling >= 100
  ) {
    throw new Error("InvocationSupervisor hardAttemptCeiling must be an integer from 1 through 99");
  }
  if (!Number.isFinite(policy.deadlineMs) || policy.deadlineMs <= 0) {
    throw new Error("InvocationSupervisor deadlineMs must be positive");
  }
  return policy;
}

function routeModels(
  context: InvocationSupervisorContext,
  request: ModelInvocationRequest,
): string[] {
  const models = [
    context.modelId ?? request.modelId,
    ...(context.fallbackModels ?? request.fallbackModels ?? []),
  ];
  return [...new Set(models.filter((model) => model.trim().length > 0))];
}

function applyContextPosture(
  request: ModelInvocationRequest,
  context: InvocationSupervisorContext,
): ModelInvocationRequest {
  return {
    ...request,
    modelId: context.modelId ?? request.modelId,
    providerId: context.providerId ?? request.providerId,
    ...(context.maximumCostUsd !== undefined ? { maxPriceUsd: context.maximumCostUsd } : {}),
    ...(context.fallbackModels !== undefined
      ? { fallbackModels: [...context.fallbackModels] }
      : {}),
  };
}

function evaluateStructuredInvocation<T>(
  invocation: ModelInvocationResult,
  input: StructuredInvocationOptions<T>,
): EvaluatedInvocation<T> {
  if (isRefusalFinish(invocation.finishReason)) {
    return failureResult(
      "refusal",
      `provider finish state '${invocation.finishReason}' refused or filtered the response`,
      new Error(`provider refusal: ${invocation.finishReason}`),
      invocation,
    );
  }
  if (input.requiresToolCall === true && invocation.toolCalls.length === 0) {
    return failureResult(
      "semantic_invalid",
      "required tool call was missing (toolCalls.length=0)",
      new Error("required tool call was missing"),
      invocation,
    );
  }
  const content = invocation.content;
  let validatedRaw: string | undefined;
  if (input.validateResponse !== undefined) {
    try {
      validatedRaw = input.validateResponse(invocation);
    } catch (error) {
      return failureResult(
        /partial|empty|finish|content/iu.test(errorDetail(error)) ? "empty" : "semantic_invalid",
        errorDetail(error),
        error,
        invocation,
      );
    }
  }
  if ((content === null || content.trim().length === 0) && invocation.toolCalls.length === 0) {
    return failureResult(
      "empty",
      `response body was blank (finishState='${invocation.finishReason}')`,
      new Error("blank provider response"),
      invocation,
    );
  }
  if (!isCompleteFinish(invocation.finishReason, invocation.toolCalls.length > 0)) {
    return failureResult(
      "empty",
      `response was partial (finishState='${invocation.finishReason}')`,
      new Error(`partial provider response: ${invocation.finishReason}`),
      invocation,
    );
  }

  // Unstructured callers use the invocation itself as their parsed result.
  if (input.parse === null) {
    return { accepted: true, parsed: invocation as T };
  }

  const raw = validatedRaw ?? content ?? "";

  let parsed: T;
  try {
    parsed = input.parse(raw, invocation);
  } catch (originalError) {
    const repaired = repairJsonObject(raw);
    if (repaired !== null && typeof repaired === "object") {
      try {
        parsed = input.parse(JSON.stringify(repaired), invocation);
      } catch (salvagedError) {
        return parseFailureResult(salvagedError, input, invocation, raw);
      }
    } else {
      return parseFailureResult(originalError, input, invocation, raw);
    }
  }

  try {
    input.validateParsed(parsed);
  } catch (error) {
    return failureResult(
      isProgrammerDefect(error) ? "itotori_bug" : "semantic_invalid",
      errorDetail(error),
      error,
      invocation,
      raw,
    );
  }
  return { accepted: true, parsed };
}

function parseFailureResult<T>(
  error: unknown,
  input: StructuredInvocationOptions<T>,
  invocation: ModelInvocationResult,
  raw: string,
): EvaluatedInvocation<T> {
  const invalidJson = isInvalidJsonError(error);
  const schemaInvalid = input.isSchemaValidationError?.(error) ?? false;
  return failureResult(
    invalidJson ? "invalid_json" : schemaInvalid ? "schema_invalid" : "semantic_invalid",
    errorDetail(error),
    error,
    invocation,
    raw,
  );
}

function failureResult<T>(
  kind: InvocationFailureClass,
  detail: string,
  error: unknown,
  invocation: ModelInvocationResult,
  rawContent: string | null = invocation.content,
): EvaluatedInvocation<T> {
  return {
    accepted: false,
    failure: { kind, detail, error, invocation, rawContent },
  };
}

function classifyThrownFailure(error: unknown): InvocationFailure {
  if (error instanceof InvocationDeadlineError || isTimeoutError(error)) {
    return {
      kind: "timeout",
      detail: errorDetail(error),
      error,
      rawContent: null,
    };
  }
  const status = httpStatusOf(error);
  if (status === 429) {
    const retryAfterMs = retryAfterMsOf(error);
    return {
      kind: "rate_limited",
      detail: `provider returned HTTP 429${retryAfterMs !== undefined ? ` (Retry-After ${retryAfterMs}ms)` : ""}`,
      error,
      rawContent: null,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return {
      kind: "provider_unavailable",
      detail: `provider returned HTTP ${status}`,
      error,
      rawContent: null,
    };
  }
  if (error instanceof ModelProviderError) {
    if (error.code === "cost_cap_exceeded") {
      return {
        kind: "itotori_bug",
        detail: `provider-side cost cap exceeded after dispatch: ${error.message}`,
        error,
        rawContent: null,
      };
    }
    if (error.code === "provider_http_error" && error.retryable) {
      return {
        kind: error.providerRun?.errorClasses.includes("provider_network_error")
          ? "network"
          : "provider_unavailable",
        detail: error.message,
        error,
        rawContent: null,
      };
    }
    if (error.code === "provider_response_invalid") {
      return {
        kind: "invalid_json",
        detail: error.message,
        error,
        rawContent: null,
      };
    }
    return {
      kind: "itotori_bug",
      detail: `${error.code}: ${error.message}`,
      error,
      rawContent: null,
    };
  }
  if (isNetworkError(error)) {
    return { kind: "network", detail: errorDetail(error), error, rawContent: null };
  }
  return { kind: "itotori_bug", detail: errorDetail(error), error, rawContent: null };
}

function nextRoutePosition(
  action: { advance: boolean },
  routeIndex: number,
  routeAttempt: number,
  routeCount: number,
): { routeIndex: number; routeAttempt: number } {
  if (!action.advance) return { routeIndex, routeAttempt: routeAttempt + 1 };
  return { routeIndex: (routeIndex + 1) % routeCount, routeAttempt: 0 };
}

function correctiveMessages(
  baseMessages: readonly ModelMessage[],
  failure: InvocationFailure,
  requiredUnitIds: readonly string[],
): ModelMessage[] {
  const exactIds =
    requiredUnitIds.length === 0
      ? ""
      : ` Required unit IDs (emit each exactly once, with no extras): ${requiredUnitIds.join(", ")}.`;
  return [
    ...baseMessages,
    ...(failure.rawContent === null || failure.rawContent.trim().length === 0
      ? []
      : [{ role: "assistant" as const, content: failure.rawContent }]),
    {
      role: "user",
      content:
        `Your previous response failed with ${failure.kind}: ${failure.detail}.` +
        exactIds +
        " Correct exactly that defect. Return the required structured result only: no markdown, commentary, omitted fields, duplicate IDs, extra IDs, or blank bodies.",
    },
  ];
}

function validationResultForFailure(kind: InvocationFailureClass): InvocationValidationResult {
  if (kind === "invalid_json" || kind === "schema_invalid") return "schema_invalid";
  if (kind === "empty" || kind === "refusal" || kind === "semantic_invalid") {
    return "semantic_invalid";
  }
  return "provider_failed";
}

function finishStateForFailure(failure: InvocationFailure): string {
  switch (failure.kind) {
    case "rate_limited":
    case "timeout":
    case "empty":
    case "refusal":
    case "invalid_json":
    case "schema_invalid":
    case "semantic_invalid":
      return failure.kind;
    case "network":
    case "provider_unavailable":
      return "network";
    case "itotori_bug":
      return providerRunFromThrownError(failure.error) !== undefined &&
        !(failure.error instanceof ModelProviderError)
        ? "post_call_error"
        : "provider_error";
  }
}

function isTransportFailure(kind: InvocationFailureClass): boolean {
  return (
    kind === "rate_limited" ||
    kind === "timeout" ||
    kind === "network" ||
    kind === "provider_unavailable"
  );
}

function mayReturnToExistingWrittenCandidate(stage: string): boolean {
  return stage === "context" || stage === "qa_findings" || stage === "repair";
}

function isRefusalFinish(finishReason: string): boolean {
  return /refusal|content[_-]?filter|safety|blocked/iu.test(finishReason);
}

function isCompleteFinish(finishReason: string, hasToolCalls: boolean): boolean {
  if (hasToolCalls && /tool|function/iu.test(finishReason)) return true;
  return /^(?:stop|end_turn|completed|complete|ok)$/iu.test(finishReason);
}

function isInvalidJsonError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (typeof error === "object" && error !== null) {
    const rule = (error as { rule?: unknown }).rule;
    if (rule === "json") return true;
  }
  return /invalid json|valid json|json parse|json:/iu.test(errorDetail(error));
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    record.name === "AbortError" ||
    record.code === "ETIMEDOUT" ||
    (typeof record.message === "string" && /timed? ?out|deadline|hang/iu.test(record.message))
  );
}

function isProgrammerDefect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof URIError
  );
}

function isNetworkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    ["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN", "EPIPE"].includes(code)
  );
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const direct =
      (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode;
    if (typeof direct === "number") return direct;
  }
  const providerRun = providerRunFromThrownError(error);
  for (const errorClass of providerRun?.errorClasses ?? []) {
    const match = /^http_(\d{3})$/u.exec(errorClass);
    if (match !== null) return Number(match[1]);
  }
  const message = errorDetail(error);
  const match = /HTTP\s+(\d{3})/iu.exec(message);
  return match === null ? undefined : Number(match[1]);
}

function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { retryAfterMs?: unknown }).retryAfterMs;
  const metadata =
    error instanceof ModelProviderError ? error.adapterMetadata?.retryAfterMs : undefined;
  const value = direct ?? metadata;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function evidenceForFailure(failure: InvocationFailure): string {
  const providerRun = failure.invocation?.providerRun ?? providerRunFromThrownError(failure.error);
  return providerRun === undefined
    ? `${failure.kind}:${failure.detail}`
    : `provider-run:${providerRun.runId};${failure.kind}:${failure.detail}`;
}

function operationalBlocker(
  kind: OperationalBlocker["kind"],
  detail: string,
  evidence: string,
  operatorAction: string,
  now: Date,
): OperationalBlocker {
  return { kind, detail, evidence, raisedAt: now.toISOString(), operatorAction };
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
