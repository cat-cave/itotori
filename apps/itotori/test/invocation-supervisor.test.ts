import { describe, expect, it } from "vitest";
import {
  executeModelInvocation,
  InvocationRetryCeilingError,
  InvocationSupervisor,
  supervisedModelProvider,
  type InvocationAttemptCompleted,
  type InvocationAttemptStarted,
  type InvocationLifecycle,
  type OperationalBlocker,
} from "../src/orchestrator/invocation-supervisor.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
} from "../src/providers/types.js";

const UNIT_ID = "019ed100-0000-7000-8000-000000000001";
const VALID_BODY = "A usable translated line.";

type DraftPayload = { drafts: Array<{ bridgeUnitId: string; body: string }> };

class RecordingLifecycle implements InvocationLifecycle {
  readonly events: string[] = [];
  readonly started: InvocationAttemptStarted[] = [];
  readonly completed: InvocationAttemptCompleted[] = [];
  readonly blockers: OperationalBlocker[] = [];

  constructor(private readonly attemptSignal?: AbortSignal) {}

  async attemptStarted(attempt: InvocationAttemptStarted): Promise<AbortSignal | void> {
    this.events.push(`started:${attempt.attemptId}`);
    this.started.push(attempt);
    return this.attemptSignal;
  }

  async attemptCompleted(attempt: InvocationAttemptCompleted): Promise<void> {
    this.events.push(`completed:${attempt.attemptId}`);
    this.completed.push(attempt);
  }

  async pauseRun(_runId: string, blocker: OperationalBlocker): Promise<void> {
    this.events.push(`paused:${blocker.kind}`);
    this.blockers.push(blocker);
  }
}

class ScriptedProvider implements ModelProvider {
  readonly descriptor = new FakeModelProvider().descriptor;
  readonly requests: ModelInvocationRequest[] = [];

  constructor(
    private readonly script: Array<
      { content: string | null; finishReason?: string } | { throw: unknown } | { hang: true }
    >,
    private readonly beforeDispatch?: () => void,
  ) {}

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    this.beforeDispatch?.();
    this.requests.push(request);
    const step = this.script.shift() ?? { content: validContent() };
    if ("throw" in step) throw step.throw;
    if ("hang" in step) {
      return await new Promise<ModelInvocationResult>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted hung provider"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    const inner = new FakeModelProvider({ generate: () => step.content ?? "" });
    const result = await inner.invoke(request);
    return {
      ...result,
      content: step.content,
      finishReason: step.finishReason ?? "stop",
    };
  }
}

describe("InvocationSupervisor failure matrix", () => {
  it.each([
    {
      name: "429",
      first: { throw: Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 1 }) },
      expected: "rate_limited",
    },
    {
      name: "empty",
      first: { content: "" },
      expected: "empty",
    },
    {
      name: "refusal",
      first: { content: "I cannot help.", finishReason: "content_filter" },
      expected: "refusal",
    },
    {
      name: "schema-invalid",
      first: { content: JSON.stringify({ drafts: "not-an-array" }) },
      expected: "schema_invalid",
    },
    {
      name: "semantic-invalid",
      first: {
        content: JSON.stringify({ drafts: [{ bridgeUnitId: "extra-unit", body: "wrong" }] }),
      },
      expected: "semantic_invalid",
    },
  ])("recovers $name with a corrective retry and writes nonblank output", async (fixture) => {
    const lifecycle = new RecordingLifecycle();
    const provider = new ScriptedProvider([fixture.first, { content: validContent() }]);
    const supervisor = supervisorFor(provider, lifecycle);

    const result = await executeDraft(supervisor);

    expect(result.parsed.drafts[0]?.body).toBe(VALID_BODY);
    expect(result.parsed.drafts[0]?.body.trim()).not.toBe("");
    expect(provider.requests).toHaveLength(2);
    expect(lifecycle.completed[0]).toMatchObject({
      failureClass: fixture.expected,
      retryDecision: "retry",
    });
    const correction = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(correction).toContain(String(fixture.expected));
    expect(correction).toContain(UNIT_ID);
    expect(correction).toContain(lifecycle.completed[0]?.failureClass ?? "");
  });

  it("aborts a hung route at its deadline, advances, and writes from the next route", async () => {
    const lifecycle = new RecordingLifecycle();
    const provider = new ScriptedProvider([{ hang: true }, { content: validContent() }]);
    const supervisor = supervisorFor(provider, lifecycle, {
      fallbackModels: ["fallback-model"],
      deadlineMs: 2,
    });

    const result = await executeDraft(supervisor);

    expect(result.parsed.drafts[0]?.body).toBe(VALID_BODY);
    expect(provider.requests.map((request) => request.modelId)).toEqual([
      "primary-model",
      "fallback-model",
    ]);
    expect(lifecycle.completed[0]).toMatchObject({
      failureClass: "timeout",
      retryDecision: "advance",
    });
  });

  it("fails promptly when the attempt lease signal aborts even if the provider ignores it", async () => {
    const leaseController = new AbortController();
    const lifecycle = new RecordingLifecycle(leaseController.signal);
    let markProviderEntered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      markProviderEntered = resolve;
    });
    const provider: ModelProvider = {
      descriptor: new FakeModelProvider().descriptor,
      invoke: async () => {
        markProviderEntered();
        return await new Promise<ModelInvocationResult>(() => undefined);
      },
    };
    const execution = executeDraft(
      supervisorFor(provider, lifecycle, {
        // The lease abort, not the ordinary deadline, must settle this test.
        deadlineMs: 60_000,
      }),
    );

    await providerEntered;
    const renewalFailure = new Error("run lease renewal failed");
    leaseController.abort(renewalFailure);

    await expect(execution).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "itotori_bug" },
      causeValue: renewalFailure,
    });
    expect(lifecycle.completed[0]).toMatchObject({ failureClass: "itotori_bug" });
    expect(lifecycle.blockers).toEqual([expect.objectContaining({ kind: "itotori_bug" })]);
  });

  it("salvages invalid JSON deterministically without another provider dispatch", async () => {
    const lifecycle = new RecordingLifecycle();
    const trailingCommaJson = `${validContent().slice(0, -1)},}`;
    const provider = new ScriptedProvider([
      { content: `\`\`\`json\n${trailingCommaJson}\n\`\`\`` },
    ]);

    const result = await executeDraft(supervisorFor(provider, lifecycle));

    expect(result.parsed.drafts[0]?.body).toBe(VALID_BODY);
    expect(provider.requests).toHaveLength(1);
    expect(lifecycle.completed[0]).toMatchObject({ validationResult: "accepted" });
  });

  it("commits the attempt identity before entering the provider transport", async () => {
    const lifecycle = new RecordingLifecycle();
    const provider = new ScriptedProvider([{ content: validContent() }], () => {
      expect(lifecycle.started).toHaveLength(1);
      expect(lifecycle.events[0]).toMatch(/^started:/u);
    });

    await executeDraft(supervisorFor(provider, lifecycle));

    expect(lifecycle.events[0]).toMatch(/^started:/u);
    expect(lifecycle.events[1]).toMatch(/^completed:/u);
    expect(provider.requests[0]?.runId).toBe(lifecycle.started[0]?.attemptId);
  });

  it("pauses before dispatch when cost admission denies, then resumes successfully", async () => {
    const lifecycle = new RecordingLifecycle();
    const provider = new ScriptedProvider([{ content: validContent() }]);
    const denied = new InvocationSupervisor({
      provider,
      context: context(),
      lifecycle,
      costAdmission: {
        admit: async () => ({
          admitted: false,
          detail: "run cost cap reached",
          evidence: "cost-account:test",
        }),
      },
      sleep: async () => undefined,
    });

    await expect(executeDraft(denied)).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "budget_cap" },
    });
    expect(provider.requests).toHaveLength(0);
    expect(lifecycle.started).toHaveLength(0);
    expect(lifecycle.blockers).toEqual([
      expect.objectContaining({ kind: "budget_cap", operatorAction: expect.any(String) }),
    ]);

    const resumed = new InvocationSupervisor({
      provider,
      context: context(),
      lifecycle,
      costAdmission: { admit: async () => ({ admitted: true }) },
      sleep: async () => undefined,
    });
    expect((await executeDraft(resumed)).parsed.drafts[0]?.body).toBe(VALID_BODY);
  });

  it("checks a provider-owned legacy cap before opening the attempt row", async () => {
    const lifecycle = new RecordingLifecycle();
    const transport = new ScriptedProvider([{ content: validContent() }]);
    const provider: ModelProvider = {
      descriptor: transport.descriptor,
      preflightInvocation: async () => ({
        admitted: false,
        detail: "provider process cap reached",
        evidence: "provider:fixture;remaining-usd:0",
      }),
      invoke: (candidate) => transport.invoke(candidate),
    };

    await expect(executeDraft(supervisorFor(provider, lifecycle))).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "budget_cap", detail: "provider process cap reached" },
    });
    expect(lifecycle.started).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("pauses on all-routes outage and succeeds when the same durable action is resumed", async () => {
    const lifecycle = new RecordingLifecycle();
    const unavailable = (): { throw: unknown } => ({
      throw: Object.assign(new Error("HTTP 503"), { status: 503 }),
    });
    const provider = new ScriptedProvider([
      unavailable(),
      unavailable(),
      unavailable(),
      unavailable(),
    ]);
    const first = supervisorFor(provider, lifecycle, { fallbackModels: ["fallback-model"] });

    await expect(executeDraft(first)).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: { kind: "provider_outage" },
    });
    expect(lifecycle.blockers.at(-1)).toMatchObject({ kind: "provider_outage" });

    const recoveredProvider = new ScriptedProvider([{ content: validContent() }]);
    const resumed = supervisorFor(recoveredProvider, lifecycle, {
      fallbackModels: ["fallback-model"],
    });
    expect((await executeDraft(resumed)).parsed.drafts[0]?.body).toBe(VALID_BODY);
  });

  it("errors at the hard ceiling for a model that cannot satisfy the contract", async () => {
    const lifecycle = new RecordingLifecycle();
    const invalid = JSON.stringify({ drafts: [{ bridgeUnitId: UNIT_ID, body: "" }] });
    const provider = new ScriptedProvider(Array.from({ length: 5 }, () => ({ content: invalid })));
    const supervisor = supervisorFor(provider, lifecycle, { hardAttemptCeiling: 5 });

    await expect(executeDraft(supervisor)).rejects.toBeInstanceOf(InvocationRetryCeilingError);
    expect(provider.requests).toHaveLength(5);
    expect(lifecycle.blockers.at(-1)).toMatchObject({ kind: "itotori_bug" });
    expect(lifecycle.completed.every((attempt) => attempt.validationResult !== "accepted")).toBe(
      true,
    );
  });

  it("keeps a standalone plain-text call under supervision until it becomes usable", async () => {
    const provider = new ScriptedProvider([
      { content: "" },
      { content: "" },
      { content: "Usable plain-text response." },
    ]);
    const standalone = supervisedModelProvider(
      new InvocationSupervisor({
        provider,
        retryPolicy: { hardAttemptCeiling: 3 },
        sleep: async () => undefined,
      }),
    );

    const result = await executeModelInvocation(standalone, request());

    expect(result.content).toBe("Usable plain-text response.");
    expect(provider.requests).toHaveLength(3);
  });

  it.each([
    { name: "blank", response: { content: "" } },
    {
      name: "refusal",
      response: { content: "I cannot comply.", finishReason: "content_filter" },
    },
    { name: "partial", response: { content: "unfinished", finishReason: "max_tokens" } },
  ])(
    "never returns an evaluator-rejected $name standalone invocation as success",
    async ({ response }) => {
      const provider = new ScriptedProvider(Array.from({ length: 3 }, () => ({ ...response })));
      const standalone = supervisedModelProvider(
        new InvocationSupervisor({
          provider,
          retryPolicy: { hardAttemptCeiling: 3 },
          sleep: async () => undefined,
        }),
      );

      await expect(executeModelInvocation(standalone, request())).rejects.toMatchObject({
        name: "InvocationRetryCeilingError",
        attempts: 3,
        lastInvocation: {
          content: response.content,
          finishReason: response.finishReason ?? "stop",
        },
      });
      expect(provider.requests).toHaveLength(3);
    },
  );
});

function supervisorFor(
  provider: ModelProvider,
  lifecycle: InvocationLifecycle,
  overrides: {
    fallbackModels?: string[];
    deadlineMs?: number;
    hardAttemptCeiling?: number;
  } = {},
): InvocationSupervisor {
  return new InvocationSupervisor({
    provider,
    context: { ...context(), fallbackModels: overrides.fallbackModels ?? [] },
    lifecycle,
    retryPolicy: {
      ...(overrides.deadlineMs !== undefined ? { deadlineMs: overrides.deadlineMs } : {}),
      ...(overrides.hardAttemptCeiling !== undefined
        ? { hardAttemptCeiling: overrides.hardAttemptCeiling }
        : {}),
    },
    random: () => 0.5,
    sleep: async () => undefined,
  });
}

function context() {
  return {
    runId: "run-supervisor-test",
    bridgeUnitId: UNIT_ID,
    stage: "translation",
    agentLabel: "translation-primary",
    logicalCallId: "logical-call-supervisor-test",
    modelId: "primary-model",
    providerId: "fixture-provider",
    maximumCostUsd: 1,
    zdr: true,
  } as const;
}

function executeDraft(supervisor: InvocationSupervisor) {
  return supervisor.execute<DraftPayload>({
    request: request(),
    parse: (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw Object.assign(new Error(`invalid JSON: ${String(error)}`), { rule: "json" });
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !Array.isArray((value as DraftPayload).drafts)
      ) {
        throw Object.assign(new Error("drafts must be an array"), { rule: "type" });
      }
      return value as DraftPayload;
    },
    isSchemaValidationError: (error) =>
      typeof error === "object" && error !== null && "rule" in error,
    validateParsed: (payload) => {
      if (payload.drafts.length !== 1) {
        throw new Error(`expected exactly one unit id ${UNIT_ID}; got ${payload.drafts.length}`);
      }
      const draft = payload.drafts[0]!;
      if (draft.bridgeUnitId !== UNIT_ID) {
        throw new Error(`missing unit id ${UNIT_ID}; extra unit id ${draft.bridgeUnitId}`);
      }
      if (draft.body.trim().length === 0) throw new Error(`blank body for unit id ${UNIT_ID}`);
    },
    requiredUnitIds: [UNIT_ID],
    successDecision: "write",
  });
}

function request(): ModelInvocationRequest {
  return {
    taskKind: "draft_translation",
    modelId: "primary-model",
    providerId: "fixture-provider",
    inputClassification: "synthetic_public",
    messages: [{ role: "user", content: `Translate unit ${UNIT_ID}.` }],
    prompt: {
      presetId: "invocation-supervisor-failure-matrix",
      templateVersion: "1",
      promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
}

function validContent(): string {
  return JSON.stringify({ drafts: [{ bridgeUnitId: UNIT_ID, body: VALID_BODY }] });
}
