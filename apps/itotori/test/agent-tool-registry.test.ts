import {
  ItotoriJobWorkerService,
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  type AuthorizationActor,
  type ItotoriEventQueueRepositoryPort,
  type ItotoriProjectRepositoryPort,
  type JobQueueRecord,
  type QueueFailureInput,
  type QueueJsonRecord,
} from "@itotori/db";
import type { TriageEventV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRegistry,
  AgentToolDurableJobAdapter,
  AgentToolRuntime,
  DeterministicToolRegistry,
  parseTranslationQualityJudgeOutput,
  protectedSpanCheck,
  protectedSpanCheckImplementationHash,
  protectedSpanCheckInputSchema,
  protectedSpanCheckJobFixture,
  protectedSpanCheckOutputFixture,
  protectedSpanCheckOutputSchema,
  translationQualityJudgeInputSchema,
  translationQualityJudgeJobFixture,
  translationQualityJudgeOutputFixture,
  translationQualityJudgeOutputSchema,
  type AgentDefinition,
  type DeterministicToolDefinition,
  type ProtectedSpanCheckInput,
  type ProtectedSpanCheckOutput,
  type TranslationQualityJudgeInput,
  type TranslationQualityJudgeOutput,
} from "../src/agents/index.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { JsonObject, ModelInvocationRequest, PromptPresetReference } from "../src/providers/index.js";

describe("agent and deterministic tool registries", () => {
  it("registers and invokes LLM agents with provider-backed metadata and model-output provenance", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();

    const metadata = agents.register(translationQualityJudgeAgent());
    expect(metadata).toMatchObject({
      registryKind: "agent",
      agentName: "agent.translation-quality-judge",
      agentVersion: "1.0.0",
      taskKind: "llm_qa",
      providerFamily: "fake",
      providerName: "itotori-agent-fixture",
      defaultModelId: "itotori-fake-judge-v0",
      promptPresetId: "itotori-agent-judge-v1",
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    const result = await runtime.runAgentJob<
      TranslationQualityJudgeInput,
      TranslationQualityJudgeOutput
    >(translationQualityJudgeJobFixture);

    expect(result.output).toEqual(translationQualityJudgeOutputFixture);
    expect(result.metadata).toMatchObject({
      runtimeKind: "llm_agent",
      agentName: "agent.translation-quality-judge",
      agentVersion: "1.0.0",
      taskKind: "llm_qa",
      providerRun: expect.objectContaining({
        taskKind: "llm_qa",
        provider: expect.objectContaining({
          providerFamily: "fake",
          providerName: "itotori-agent-fixture",
          actualModelId: "itotori-fake-judge-v0",
        }),
      }),
    });
    expect(result.metadata.inputHash).toMatch(/^sha256:/u);
    expect(result.metadata.outputHash).toMatch(/^sha256:/u);
    expect(events).toEqual([result.event]);
    expect(result.event).toMatchObject({
      eventKind: "model_output_recorded",
      actor: { actorKind: "agent", displayName: "agent.translation-quality-judge@1.0.0" },
      taskId: translationQualityJudgeJobFixture.context.taskId,
      subjectRefs: translationQualityJudgeJobFixture.context.subjectRefs,
    });
    expect(result.event.provenance).toEqual([
      expect.objectContaining({
        provenanceKind: "model_output",
        provider: "fake/itotori-agent-fixture",
        model: "itotori-fake-judge-v0",
        outputHash: result.metadata.outputHash,
        promptHash: promptPreset.promptHash,
      }),
    ]);
    expect(result.event.payload).toMatchObject({
      registryKind: "agent_invocation",
      runtimeKind: "llm_agent",
      agentName: "agent.translation-quality-judge",
      providerRunId: result.metadata.providerRun.runId,
      actualModelId: "itotori-fake-judge-v0",
    });
    expect(JSON.stringify(result.output)).not.toMatch(/confidence/iu);
  });

  it("records deterministic tool reproducibility metadata and deterministic-check provenance", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const metadata = tools.register(protectedSpanTool());

    expect(metadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: "tool.protected-span-check",
      toolVersion: "1.0.0",
      taskKind: "deterministic_qa",
      capabilityKey: "protected_content.protected_span",
      reproducibility: {
        implementationHash: protectedSpanCheckImplementationHash,
        inputHashAlgorithm: "sha256-stable-json-v1",
        outputHashAlgorithm: "sha256-stable-json-v1",
        sideEffectFree: true,
      },
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    const first = await runtime.runDeterministicToolJob<
      ProtectedSpanCheckInput,
      ProtectedSpanCheckOutput
    >(protectedSpanCheckJobFixture, { verifyReproducible: true });
    const second = await runtime.runDeterministicToolJob<
      ProtectedSpanCheckInput,
      ProtectedSpanCheckOutput
    >(protectedSpanCheckJobFixture);

    expect(first.output).toEqual(protectedSpanCheckOutputFixture);
    expect(first.metadata.inputHash).toBe(second.metadata.inputHash);
    expect(first.metadata.outputHash).toBe(second.metadata.outputHash);
    expect(first.metadata.verification).toEqual({ rerunOutputHash: first.metadata.outputHash });
    expect(first.metadata).toMatchObject({
      runtimeKind: "deterministic_tool",
      toolName: "tool.protected-span-check",
      toolVersion: "1.0.0",
      capabilityKey: "protected_content.protected_span",
      reproducibility: expect.objectContaining({
        algorithmName: "protected-span-presence",
        algorithmVersion: "1.0.0",
        implementationHash: protectedSpanCheckImplementationHash,
      }),
    });
    expect(events).toHaveLength(2);
    expect(first.event).toMatchObject({
      eventKind: "qa_finding_reported",
      actor: { actorKind: "tool", displayName: "tool.protected-span-check@1.0.0" },
      taskId: protectedSpanCheckJobFixture.context.taskId,
    });
    expect(first.event.provenance).toEqual([
      expect.objectContaining({
        provenanceKind: "deterministic_check",
        checkName: "tool.protected-span-check",
        checkVersion: "1.0.0",
      }),
    ]);
    expect(first.event.payload).toMatchObject({
      registryKind: "deterministic_tool_invocation",
      runtimeKind: "deterministic_tool",
      toolName: "tool.protected-span-check",
      inputHash: first.metadata.inputHash,
      outputHash: first.metadata.outputHash,
    });
    expect(first.event.payload).not.toHaveProperty("providerRunId");
  });

  it("rejects non-reproducible deterministic tool output when verification is enabled", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    let runCount = 0;
    tools.register({
      ...protectedSpanTool(),
      toolVersion: "1.0.1",
      reproducibility: {
        ...protectedSpanTool().reproducibility,
        algorithmVersion: "1.0.1",
      },
      run: () => {
        runCount += 1;
        return {
          outputKind: "protected_span_check",
          missingProtectedSpans: [`run-${runCount}`],
          findings: [
            {
              span: "{player}",
              rationale: `run ${runCount}`,
            },
          ],
        };
      },
    });
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(
      runtime.runDeterministicToolJob(
        { ...protectedSpanCheckJobFixture, toolVersion: "1.0.1" },
        { verifyReproducible: true },
      ),
    ).rejects.toThrow(/reproducibility verification failed/u);
  });

  it("rejects deterministic tools registered as agents and agents registered as deterministic tools", () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();

    expect(() => agents.register(protectedSpanTool() as unknown as AgentDefinition)).toThrow(
      /deterministic tool definitions cannot be registered as agents/u,
    );
    expect(() =>
      tools.register(translationQualityJudgeAgent() as unknown as DeterministicToolDefinition),
    ).toThrow(/agent definitions cannot be registered as deterministic tools/u);
  });

  it("rejects confidence-only agent scoring output", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const outputWithConfidence = {
      ...translationQualityJudgeOutputFixture,
      confidence: 0.9,
    } as TranslationQualityJudgeOutput & JsonObject;
    agents.register(translationQualityJudgeAgent(outputWithConfidence));
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).rejects.toThrow(
      /confidence/u,
    );
  });

  it("rejects invalid registered job input before invocation", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(
      runtime.runDeterministicToolJob({
        ...protectedSpanCheckJobFixture,
        input: { targetText: "Hello." },
      } as unknown as typeof protectedSpanCheckJobFixture),
    ).rejects.toThrow(/protectedSpans.*required/u);
  });

  it("rejects invalid registered job output after invocation", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const outputWithoutScore = {
      outputKind: "score",
      rationales: ["A score output must include the numeric score field."],
      findings: [],
    } as unknown as TranslationQualityJudgeOutput;
    agents.register(translationQualityJudgeAgent(outputWithoutScore));
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).rejects.toThrow(
      /score.*required/u,
    );
  });

  it("rejects malformed finding objects in scoring agent output", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const outputWithMalformedFinding = {
      ...translationQualityJudgeOutputFixture,
      findings: [
        {
          findingKind: "protected_span_issue",
          severity: "P1",
          title: "Protected span was dropped",
          evidence: ["expected {player}"],
        },
      ],
    } as unknown as TranslationQualityJudgeOutput;
    agents.register(translationQualityJudgeAgent(outputWithMalformedFinding));
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).rejects.toThrow(
      /findings\[0\]\.rationale.*required/u,
    );
  });

  it("accepts valid descriptor-validated agent and tool examples", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    agents.register(translationQualityJudgeAgent());
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).resolves.toMatchObject({
      output: translationQualityJudgeOutputFixture,
    });
    await expect(runtime.runDeterministicToolJob(protectedSpanCheckJobFixture)).resolves.toMatchObject({
      output: protectedSpanCheckOutputFixture,
    });
  });

  it("requires rationales and findings for scoring agent output", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const outputWithoutEvidence = {
      outputKind: "score",
      score: 0.5,
      findings: [],
    } as unknown as TranslationQualityJudgeOutput;
    agents.register(translationQualityJudgeAgent(outputWithoutEvidence));
    const runtime = new AgentToolRuntime(agents, tools);

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).rejects.toThrow(
      /rationales.*required/u,
    );
  });

  it("maps durable agent task records to registered agents and persists project events", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    agents.register(translationQualityJudgeAgent());
    const runtime = new AgentToolRuntime(agents, tools);
    const appendEvent = vi.fn(async () => undefined);
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
    );

    const result = await adapter.handleJob(
      durableJobRecord({
        jobId: "job-agent-quality-judge",
        jobType: jobTaskTypeValues.agentTask,
        jobName: "agent.translation-quality-judge",
        payload: {
          ...translationQualityJudgeJobFixture,
          context: translationQualityJudgeJobFixture.context,
        },
      }),
    );

    expect(result).toMatchObject({
      jobKind: "agent_job",
      output: translationQualityJudgeOutputFixture,
      persistedEvent: {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        eventId: result.event.eventId,
      },
    });
    expect(appendEvent).toHaveBeenCalledWith(localActor, {
      projectId: "project-test",
      localeBranchId: "locale-en-us",
      event: expect.objectContaining({
        eventId: result.event.eventId,
        eventKind: "model_output_recorded",
        provenance: [
          expect.objectContaining({
            provenanceKind: "model_output",
            outputHash: result.metadata.outputHash,
          }),
        ],
      }),
    });
  });

  it("keeps durable agent event identities idempotent when identical retry output is produced", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    agents.register(translationQualityJudgeAgent());
    const runtime = new AgentToolRuntime(agents, tools);
    const { appendEvent, persistedEvents } = eventPersistenceFixture();
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
    );
    const job = durableJobRecord({
      jobId: "job-agent-quality-judge-retry",
      jobType: jobTaskTypeValues.agentTask,
      jobName: "agent.translation-quality-judge",
      payload: {
        ...translationQualityJudgeJobFixture,
        context: translationQualityJudgeJobFixture.context,
      },
    });

    const first = await adapter.handleJob(job);
    const second = await adapter.handleJob({
      ...job,
      attemptCount: 2,
      lockedAt: new Date("2026-06-17T12:02:00.000Z"),
      leaseExpiresAt: new Date("2026-06-17T12:03:00.000Z"),
      updatedAt: new Date("2026-06-17T12:02:00.000Z"),
    });

    const firstProvenance = first.event.provenance[0] as Record<string, unknown>;
    const secondProvenance = second.event.provenance[0] as Record<string, unknown>;
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(secondProvenance.provenanceId).toBe(firstProvenance.provenanceId);
    expect(secondProvenance.modelOutputId).toBe(firstProvenance.modelOutputId);
    expect(second.metadata.emittedEventId).toBe(first.event.eventId);
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect([...persistedEvents.keys()]).toEqual([first.event.eventId]);
  });

  it("keeps durable event persistence idempotent when the same durable job is handled twice", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);
    const { appendEvent, persistedEvents } = eventPersistenceFixture();
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
    );
    const job = durableJobRecord({
      jobId: "job-tool-protected-span-check-retry",
      jobType: jobTaskTypeValues.deterministicToolTask,
      jobName: "tool.protected-span-check",
      payload: {
        ...protectedSpanCheckJobFixture,
        context: protectedSpanCheckJobFixture.context,
      },
    });

    const first = await adapter.handleJob(job);
    const second = await adapter.handleJob({
      ...job,
      attemptCount: 2,
      lockedAt: new Date("2026-06-17T12:02:00.000Z"),
      leaseExpiresAt: new Date("2026-06-17T12:03:00.000Z"),
      updatedAt: new Date("2026-06-17T12:02:00.000Z"),
    });

    expect(first.event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    const firstProvenance = first.event.provenance[0] as Record<string, unknown>;
    const secondProvenance = second.event.provenance[0] as Record<string, unknown>;
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(secondProvenance.provenanceId).toBe(firstProvenance.provenanceId);
    expect(secondProvenance.checkId).toBe(firstProvenance.checkId);
    expect(second.persistedEvent.eventId).toBe(first.persistedEvent.eventId);
    expect(first.metadata.emittedEventId).toBe(first.event.eventId);
    expect(second.metadata.emittedEventId).toBe(first.event.eventId);
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect([...persistedEvents.keys()]).toEqual([first.event.eventId]);
    expect(persistedEvents.get(first.event.eventId)).toEqual(
      expect.objectContaining({
        eventId: first.event.eventId,
        eventKind: "qa_finding_reported",
        provenance: first.event.provenance,
        payload: expect.objectContaining({
          registryKind: "deterministic_tool_invocation",
          outputHash: first.metadata.outputHash,
        }),
      }),
    );
  });

  it("targets the same durable event identity when retry output changes", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    let runCount = 0;
    tools.register({
      ...protectedSpanTool(),
      toolVersion: "1.0.2",
      reproducibility: {
        ...protectedSpanTool().reproducibility,
        algorithmVersion: "1.0.2",
      },
      run: () => {
        runCount += 1;
        return {
          outputKind: "protected_span_check",
          missingProtectedSpans: ["{player}"],
          findings: [
            {
              span: "{player}",
              rationale: `retry run ${runCount}`,
            },
          ],
        };
      },
    });
    const runtime = new AgentToolRuntime(agents, tools);
    const { appendEvent, persistedEvents } = eventPersistenceFixture();
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
    );
    const job = durableJobRecord({
      jobId: "job-tool-protected-span-check-changed-output",
      jobType: jobTaskTypeValues.deterministicToolTask,
      jobName: "tool.protected-span-check",
      payload: {
        ...protectedSpanCheckJobFixture,
        toolVersion: "1.0.2",
        context: protectedSpanCheckJobFixture.context,
      },
    });

    const first = await adapter.handleJob(job);
    const second = await adapter.handleJob({
      ...job,
      attemptCount: 2,
      lockedAt: new Date("2026-06-17T12:02:00.000Z"),
      leaseExpiresAt: new Date("2026-06-17T12:03:00.000Z"),
      updatedAt: new Date("2026-06-17T12:02:00.000Z"),
    });

    const firstProvenance = first.event.provenance[0] as Record<string, unknown>;
    const secondProvenance = second.event.provenance[0] as Record<string, unknown>;
    expect(second.metadata.outputHash).not.toBe(first.metadata.outputHash);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(secondProvenance.provenanceId).toBe(firstProvenance.provenanceId);
    expect(secondProvenance.checkId).toBe(firstProvenance.checkId);
    expect(second.metadata.emittedEventId).toBe(first.event.eventId);
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect([...persistedEvents.keys()]).toEqual([first.event.eventId]);
    expect(persistedEvents.get(first.event.eventId)?.payload).toMatchObject({
      outputHash: first.metadata.outputHash,
    });
    expect(second.event.payload).toMatchObject({
      outputHash: second.metadata.outputHash,
    });
  });

  it("does not suppress unrelated duplicate insert violations", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);
    const duplicateFindingError = new Error(
      'duplicate key value violates unique constraint "itotori_findings_pkey"',
    ) as Error & { code: string; constraint: string };
    duplicateFindingError.code = "23505";
    duplicateFindingError.constraint = "itotori_findings_pkey";
    const appendEvent = vi.fn(async () => {
      throw duplicateFindingError;
    });
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
    );

    await expect(
      adapter.handleJob(
        durableJobRecord({
          jobId: "job-tool-protected-span-check-unrelated-duplicate",
          jobType: jobTaskTypeValues.deterministicToolTask,
          jobName: "tool.protected-span-check",
          payload: {
            ...protectedSpanCheckJobFixture,
            context: protectedSpanCheckJobFixture.context,
          },
        }),
      ),
    ).rejects.toBe(duplicateFindingError);
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  it("runs durable deterministic tool records through the existing job worker service", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);
    const appendEvent = vi.fn(async () => undefined);
    const adapter = new AgentToolDurableJobAdapter(
      runtime,
      { appendEvent } as unknown as ItotoriProjectRepositoryPort,
      localActor,
      { verifyDeterministicTools: true },
    );
    const queue = queueRepositoryFixture(
      durableJobRecord({
        jobId: "job-tool-protected-span-check",
        jobType: jobTaskTypeValues.deterministicToolTask,
        jobName: "tool.protected-span-check",
        payload: {
          ...protectedSpanCheckJobFixture,
          context: protectedSpanCheckJobFixture.context,
        },
      }),
    );
    const worker = new ItotoriJobWorkerService(
      queue.repository,
      localActor,
      "worker-agent-tool",
      adapter.jobHandlers(),
    );

    await expect(worker.runAvailable({ limit: 1 })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });

    expect(queue.completeJob).toHaveBeenCalledWith(
      localActor,
      "job-tool-protected-span-check",
      "worker-agent-tool",
      expect.objectContaining({
        jobKind: "deterministic_tool_job",
        output: protectedSpanCheckOutputFixture,
        metadata: expect.objectContaining({
          runtimeKind: "deterministic_tool",
          verification: expect.objectContaining({
            rerunOutputHash: expect.stringMatching(/^sha256:/u),
          }),
        }),
        event: expect.objectContaining({
          eventKind: "qa_finding_reported",
          provenance: [
            expect.objectContaining({
              provenanceKind: "deterministic_check",
              checkName: "tool.protected-span-check",
            }),
          ],
        }),
      }),
    );
    expect(appendEvent).toHaveBeenCalledWith(localActor, {
      projectId: "project-test",
      localeBranchId: "locale-en-us",
      event: expect.objectContaining({
        eventKind: "qa_finding_reported",
      }),
    });
  });
});

function translationQualityJudgeAgent(
  output: TranslationQualityJudgeOutput = translationQualityJudgeOutputFixture,
): AgentDefinition<TranslationQualityJudgeInput, TranslationQualityJudgeOutput> {
  const provider = new FakeModelProvider({
    providerName: "itotori-agent-fixture",
    modelId: "itotori-fake-judge-v0",
    generate: () => JSON.stringify(output),
  });
  return {
    registryKind: "agent_definition",
    agentName: "agent.translation-quality-judge",
    agentVersion: "1.0.0",
    description: "Scores translation quality with evidence-bearing rationales and findings.",
    taskKind: "llm_qa",
    provider,
    prompt: promptPreset,
    inputSchema: translationQualityJudgeInputSchema,
    outputSchema: translationQualityJudgeOutputSchema,
    createRequest: (input): ModelInvocationRequest => ({
      taskKind: "llm_qa",
      modelId: provider.descriptor.defaultModelId,
      inputClassification: "synthetic_public",
      prompt: promptPreset,
      structuredOutput: { mode: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return JSON with score, rationales, and findings. Do not return confidence.",
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    }),
    parseResult: (result) => parseTranslationQualityJudgeOutput(result.content),
  };
}

function protectedSpanTool(): DeterministicToolDefinition<
  ProtectedSpanCheckInput,
  ProtectedSpanCheckOutput
> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: "tool.protected-span-check",
    toolVersion: "1.0.0",
    description: "Checks that required protected spans are present in target text.",
    taskKind: "deterministic_qa",
    capabilityKey: "protected_content.protected_span",
    inputSchema: protectedSpanCheckInputSchema,
    outputSchema: protectedSpanCheckOutputSchema,
    reproducibility: {
      algorithmName: "protected-span-presence",
      algorithmVersion: "1.0.0",
      implementationHash: protectedSpanCheckImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: (input) => protectedSpanCheck(input),
  };
}

const promptPreset = {
  presetId: "itotori-agent-judge-v1",
  templateVersion: "1.0.0",
  promptHash: "sha256:ab2cf9b2b6e565f6ad9b5850f2fc924626ac39a4452bdbd52c943ed4cf83827c",
  schemaVersion: "1.0.0",
  configSnapshot: {
    outputContract: "score-with-rationales-and-findings",
  },
} satisfies PromptPresetReference;

const localActor: AuthorizationActor = { userId: "local-user" };

function eventPersistenceFixture(): {
  appendEvent: ReturnType<typeof vi.fn>;
  persistedEvents: Map<string, TriageEventV02>;
} {
  const persistedEvents = new Map<string, TriageEventV02>();
  const appendEvent = vi.fn(
    async (
      _actor: AuthorizationActor,
      input: { projectId: string; localeBranchId?: string; event: TriageEventV02 },
    ) => {
      if (persistedEvents.has(input.event.eventId)) {
        throw duplicateEventPrimaryKeyError(input.event.eventId);
      }
      persistedEvents.set(input.event.eventId, input.event);
    },
  );
  return { appendEvent, persistedEvents };
}

function duplicateEventPrimaryKeyError(eventId: string): Error & {
  code: string;
  constraint: string;
  detail: string;
} {
  const error = new Error(
    'duplicate key value violates unique constraint "itotori_events_pkey"',
  ) as Error & { code: string; constraint: string; detail: string };
  error.code = "23505";
  error.constraint = "itotori_events_pkey";
  error.detail = `Key (event_id)=(${eventId}) already exists.`;
  return error;
}

function durableJobRecord(overrides: Partial<JobQueueRecord>): JobQueueRecord {
  const now = new Date("2026-06-17T12:00:00.000Z");
  return {
    jobId: "job-agent-tool",
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceEventId: null,
    triggerOutboxEventId: null,
    jobType: jobTaskTypeValues.deterministicToolTask,
    jobName: "tool.protected-span-check",
    queueName: "default",
    status: jobStatusValues.running,
    idempotencyPolicy: jobIdempotencyPolicyValues.idempotent,
    idempotencyKey: "job:agent-tool",
    correlationId: "correlation-agent-tool",
    causationId: null,
    subjectRefs: protectedSpanCheckJobFixture.context.subjectRefs,
    payload: protectedSpanCheckJobFixture,
    priority: 0,
    availableAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "worker-agent-tool",
    lockedAt: now,
    leaseExpiresAt: new Date("2026-06-17T12:01:00.000Z"),
    completedAt: null,
    lastError: null,
    errorHistory: [],
    result: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queueRepositoryFixture(job: JobQueueRecord): {
  repository: ItotoriEventQueueRepositoryPort;
  completeJob: ReturnType<typeof vi.fn>;
} {
  let claimed = false;
  const completeJob = vi.fn(
    async (
      _actor: AuthorizationActor,
      _jobId: string,
      _workerId: string,
      result: QueueJsonRecord = {},
    ): Promise<JobQueueRecord> => ({
      ...job,
      status: jobStatusValues.succeeded,
      lockedBy: null,
      completedAt: new Date("2026-06-17T12:00:01.000Z"),
      result,
    }),
  );
  const failJob = vi.fn(
    async (
      _actor: AuthorizationActor,
      _jobId: string,
      _workerId: string,
      input: QueueFailureInput,
    ): Promise<JobQueueRecord> => ({
      ...job,
      status: jobStatusValues.deadLetter,
      lockedBy: null,
      lastError: input.error instanceof Error ? input.error.message : String(input.error),
    }),
  );
  const repository = {
    claimJobs: vi.fn(async () => {
      if (claimed) {
        return [];
      }
      claimed = true;
      return [job];
    }),
    completeJob,
    failJob,
  } as unknown as ItotoriEventQueueRepositoryPort;
  return { repository, completeJob };
}
