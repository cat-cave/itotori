import {
  ItotoriJobWorkerService,
  jobIdempotencyPolicyValues,
  jobStatusValues,
  jobTaskTypeValues,
  type ContextArtifactRetrievalResult,
  type SearchExactToolResult,
  type GlossaryContextReadModel,
  type SemanticGlossarySearchReadModel,
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
  assertRegistrySchemaValue,
  deriveImplementationHash,
  deterministicPreExportQaImplementationHash,
  deterministicPreExportQaJobFixture,
  deterministicPreExportQaOutputFixture,
  deterministicPreExportQaTool,
  fixtureInvocationContext,
  parseTranslationQualityJudgeOutput,
  protectedSpanCheck,
  protectedSpanCheckImplementationHash,
  protectedSpanCheckInputSchema,
  protectedSpanCheckJobFixture,
  protectedSpanCheckOutputFixture,
  protectedSpanCheckOutputSchema,
  searchExactRegistryToolName,
  searchExactTool,
  searchExactToolImplementationHash,
  contextArtifactRetrievalRegistryToolName,
  contextArtifactRetrievalTool,
  contextArtifactRetrievalToolImplementationHash,
  contextArtifactRetrievalToolOutput,
  contextArtifactRetrievalToolOutputSchema,
  glossaryContextRegistryToolName,
  glossaryContextTool,
  glossaryContextToolImplementationHash,
  glossaryContextToolOutput,
  glossaryContextToolOutputSchema,
  semanticGlossarySearchRegistryToolName,
  semanticGlossarySearchTool,
  semanticGlossarySearchToolImplementationHash,
  semanticGlossarySearchToolOutput,
  semanticGlossarySearchToolOutputSchema,
  toolImplementationHashArtifacts,
  translationQualityJudgeInputSchema,
  translationQualityJudgeJobFixture,
  translationQualityJudgeOutputFixture,
  translationQualityJudgeOutputSchema,
  verifyImplementationHash,
  type AgentDefinition,
  type DeterministicPreExportQaInput,
  type DeterministicPreExportQaOutput,
  type DeterministicToolDefinition,
  type DeterministicToolJobInput,
  type ImplementationHashArtifacts,
  type ProtectedSpanCheckInput,
  type ProtectedSpanCheckOutput,
  type ContextArtifactRetrievalToolInput,
  type ContextArtifactRetrievalToolOutput,
  type SearchExactToolInput,
  type SearchExactToolOutput,
  type GlossaryContextToolInput,
  type GlossaryContextToolOutput,
  type SemanticGlossarySearchToolInput,
  type SemanticGlossarySearchToolOutput,
  type TranslationQualityJudgeInput,
  type TranslationQualityJudgeOutput,
} from "../src/agents/index.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type {
  CapabilitySupport,
  JsonObject,
  ModelInvocationRequest,
  ModelProvider,
  PromptPresetReference,
} from "../src/providers/index.js";

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

  it("correctively retries schema-invalid agent output before accepting the attempt", async () => {
    const requests: ModelInvocationRequest[] = [];
    const schemaInvalidOutput = {
      outputKind: "score",
      rationales: ["The first response omitted the required score."],
      findings: [],
    };
    let invocationCount = 0;
    const provider = new FakeModelProvider({
      providerName: "itotori-agent-schema-retry-fixture",
      modelId: "itotori-fake-judge-v0",
      generate: (request) => {
        requests.push(request);
        invocationCount += 1;
        return JSON.stringify(
          invocationCount === 1 ? schemaInvalidOutput : translationQualityJudgeOutputFixture,
        );
      },
    });
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    agents.register({ ...translationQualityJudgeAgent(), provider });

    const result = await new AgentToolRuntime(agents, tools).runAgentJob(
      translationQualityJudgeJobFixture,
    );

    expect(result.output).toEqual(translationQualityJudgeOutputFixture);
    expect(invocationCount).toBe(2);
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/schema_invalid.*score.*required/iu);
  });

  it("correctively retries semantic agent-contract failures before accepting the attempt", async () => {
    const requests: ModelInvocationRequest[] = [];
    const semanticInvalidOutput = {
      ...translationQualityJudgeOutputFixture,
      rationales: [],
    };
    let invocationCount = 0;
    const provider = new FakeModelProvider({
      providerName: "itotori-agent-semantic-retry-fixture",
      modelId: "itotori-fake-judge-v0",
      generate: (request) => {
        requests.push(request);
        invocationCount += 1;
        return JSON.stringify(
          invocationCount === 1 ? semanticInvalidOutput : translationQualityJudgeOutputFixture,
        );
      },
    });
    const definition = translationQualityJudgeAgent();
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    agents.register({
      ...definition,
      provider,
      // Keep the descriptor deliberately broad in this focused test so the
      // runtime's additional judgment contract is the rejecting boundary.
      outputSchema: {
        ...definition.outputSchema,
        jsonSchema: { type: "object" },
      },
    });

    const result = await new AgentToolRuntime(agents, tools).runAgentJob(
      translationQualityJudgeJobFixture,
    );

    expect(result.output).toEqual(translationQualityJudgeOutputFixture);
    expect(invocationCount).toBe(2);
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/semantic_invalid.*include rationales/iu);
  });

  it("rejects unsupported agent structured-output requirements before provider execution", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const baseDefinition = translationQualityJudgeAgent();
    const invoke = vi.fn(baseDefinition.provider.invoke.bind(baseDefinition.provider));
    const jsonObjectSupport = "unsupported" satisfies CapabilitySupport;
    const provider: ModelProvider = {
      descriptor: {
        ...baseDefinition.provider.descriptor,
        capabilities: {
          ...baseDefinition.provider.descriptor.capabilities,
          structuredOutputs: {
            ...baseDefinition.provider.descriptor.capabilities.structuredOutputs,
            jsonObject: jsonObjectSupport,
          },
        },
      },
      invoke,
    };

    agents.register({ ...baseDefinition, provider });
    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    await expect(runtime.runAgentJob(translationQualityJudgeJobFixture)).rejects.toMatchObject({
      code: "capability_unsupported",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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

  it("runs the full deterministic pre-export QA suite as a registered tool job", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const metadata = tools.register(deterministicPreExportQaTool());

    expect(metadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: "tool.deterministic-pre-export-qa",
      toolVersion: "1.0.0",
      taskKind: "deterministic_qa",
      capabilityKey: "localization.pre_export_qa",
      reproducibility: {
        algorithmName: "deterministic-pre-export-qa",
        algorithmVersion: "itotori-020.1",
        implementationHash: deterministicPreExportQaImplementationHash,
      },
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    const result = await runtime.runDeterministicToolJob<
      DeterministicPreExportQaInput,
      DeterministicPreExportQaOutput
    >(deterministicPreExportQaJobFixture, { verifyReproducible: true });

    expect(result.output.failures).toEqual(deterministicPreExportQaOutputFixture.failures);
    expect(result.output.findings).toHaveLength(1);
    expect(result.output.findings[0]).toMatchObject({
      findingKind: "protected_span_issue",
      qualityCategory: "protected_content",
      description: expect.stringContaining(
        "Repair hint: Restore protected span {player} exactly in hello.scene.001.line.001",
      ),
    });
    expect(result.metadata).toMatchObject({
      runtimeKind: "deterministic_tool",
      toolName: "tool.deterministic-pre-export-qa",
      toolVersion: "1.0.0",
      capabilityKey: "localization.pre_export_qa",
      verification: { rerunOutputHash: result.metadata.outputHash },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKind: "qa_finding_reported",
      actor: { actorKind: "tool", displayName: "tool.deterministic-pre-export-qa@1.0.0" },
      payload: expect.objectContaining({
        registryKind: "deterministic_tool_invocation",
        toolName: "tool.deterministic-pre-export-qa",
        outputHash: result.metadata.outputHash,
      }),
    });
  });

  it("registers and executes search.exact through the deterministic tool registry", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const searchExact = vi.fn(async () => exactSearchServiceResult());
    const metadata = tools.register(searchExactTool({ searchExact }));

    expect(metadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: searchExactRegistryToolName,
      toolVersion: "1.0.0",
      taskKind: "extract",
      capabilityKey: "search.exact",
      inputSchemaId: "itotori.tool.search-exact.input",
      outputSchemaId: "itotori.tool.search-exact.output",
      reproducibility: {
        algorithmName: "search.exact",
        algorithmVersion: "1.0.0",
        implementationHash: searchExactToolImplementationHash,
      },
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });
    const job = {
      jobKind: "deterministic_tool_job",
      toolName: searchExactRegistryToolName,
      toolVersion: "1.0.0",
      context: fixtureInvocationContext,
      input: {
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        query: "Hero",
        sourceRevisionId: "bridge-search:bundle-revision",
        sourceArtifactTypes: ["source_unit"],
        limit: 5,
      },
    } satisfies DeterministicToolJobInput<SearchExactToolInput>;

    const result = await runtime.runDeterministicToolJob<
      SearchExactToolInput,
      SearchExactToolOutput
    >(job);

    expect(searchExact).toHaveBeenCalledWith(job.input);
    expect(result.output).toMatchObject({
      outputKind: "search_exact",
      status: "completed",
      toolName: "search.exact",
      toolVersion: "1.0.0",
      normalizedQuery: "hero",
      matches: [
        expect.objectContaining({
          searchDocumentId: "exact-search-doc:fixture",
          sourceArtifactType: "source_unit",
          sourceArtifactId: "unit-hero",
          refreshedAt: "2026-06-17T12:00:00.000Z",
          provenance: expect.objectContaining({
            toolName: "search.exact",
            toolVersion: "1.0.0",
            searchDocumentId: "exact-search-doc:fixture",
            sourceRevisionId: "bridge-search:bundle-revision",
          }),
        }),
      ],
      diagnostics: [],
    });
    expect(result.metadata).toMatchObject({
      runtimeKind: "deterministic_tool",
      toolName: searchExactRegistryToolName,
      capabilityKey: "search.exact",
      reproducibility: expect.objectContaining({
        implementationHash: searchExactToolImplementationHash,
      }),
    });
    expect(result.metadata.outputHash).toMatch(/^sha256:/u);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { actorKind: "tool", displayName: `${searchExactRegistryToolName}@1.0.0` },
      provenance: [
        expect.objectContaining({
          provenanceKind: "deterministic_check",
          checkName: searchExactRegistryToolName,
          checkVersion: "1.0.0",
        }),
      ],
      payload: expect.objectContaining({
        registryKind: "deterministic_tool_invocation",
        toolName: searchExactRegistryToolName,
        capabilityKey: "search.exact",
        outputHash: result.metadata.outputHash,
      }),
    });
  });

  it("registers glossary semantic search and context lookup as cited deterministic tools", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const searchGlossary = vi.fn(async () => semanticGlossarySearchServiceResult());
    const getGlossaryContext = vi.fn(async () => glossaryContextServiceResult());

    const searchMetadata = tools.register(semanticGlossarySearchTool({ searchGlossary }));
    const contextMetadata = tools.register(glossaryContextTool({ getGlossaryContext }));

    expect(searchMetadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: semanticGlossarySearchRegistryToolName,
      toolVersion: "1.0.0",
      taskKind: "extract",
      capabilityKey: "search.glossary",
      inputSchemaId: "itotori.tool.semantic-glossary-search.input",
      outputSchemaId: "itotori.tool.semantic-glossary-search.output",
      reproducibility: {
        algorithmName: "search.glossary",
        implementationHash: semanticGlossarySearchToolImplementationHash,
      },
    });
    expect(contextMetadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: glossaryContextRegistryToolName,
      toolVersion: "2.0.0",
      capabilityKey: "glossary.context",
      reproducibility: {
        algorithmName: "glossary.context",
        implementationHash: glossaryContextToolImplementationHash,
      },
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    const searchJob = {
      jobKind: "deterministic_tool_job",
      toolName: semanticGlossarySearchRegistryToolName,
      toolVersion: "1.0.0",
      context: fixtureInvocationContext,
      input: {
        projectId: "project-terminology",
        localeBranchId: "locale-en-us",
        query: "chosen champion",
        sourceRevisionId: "bridge-terminology:bundle-revision",
        limit: 3,
      },
    } satisfies DeterministicToolJobInput<SemanticGlossarySearchToolInput>;

    const searchResult = await runtime.runDeterministicToolJob<
      SemanticGlossarySearchToolInput,
      SemanticGlossarySearchToolOutput
    >(searchJob, { verifyReproducible: true });

    expect(searchGlossary).toHaveBeenCalledWith(searchJob.input);
    expect(searchResult.output).toMatchObject({
      outputKind: "semantic_glossary_search",
      readiness: {
        embeddingMode: "recorded_fixture",
        liveProviderRequired: false,
        exactFallback: { triggered: false },
      },
      matches: [
        expect.objectContaining({
          term: expect.objectContaining({ termId: "term-semantic-hero" }),
          matchKinds: ["semantic_vector"],
          provenance: expect.objectContaining({
            provenanceKind: "semantic_glossary_search_result",
            fixtureId: "semantic-glossary-fixture-v1",
            citations: [
              expect.objectContaining({
                citation: "terminology.scene.001.line.001",
              }),
            ],
          }),
        }),
      ],
    });
    expect(searchResult.metadata).toMatchObject({
      runtimeKind: "deterministic_tool",
      toolName: semanticGlossarySearchRegistryToolName,
      verification: { rerunOutputHash: searchResult.metadata.outputHash },
    });

    const contextJob = {
      jobKind: "deterministic_tool_job",
      toolName: glossaryContextRegistryToolName,
      toolVersion: "2.0.0",
      context: fixtureInvocationContext,
      input: {
        localeBranchId: "locale-en-us",
        termId: "term-semantic-hero",
        sourceRevisionId: "bridge-terminology:bundle-revision",
      },
    } satisfies DeterministicToolJobInput<GlossaryContextToolInput>;

    const contextResult = await runtime.runDeterministicToolJob<
      GlossaryContextToolInput,
      GlossaryContextToolOutput
    >(contextJob);

    expect(getGlossaryContext).toHaveBeenCalledWith(contextJob.input);
    expect(contextResult.output).toMatchObject({
      outputKind: "glossary_context_lookup",
      found: true,
      termId: "term-semantic-hero",
      context: expect.objectContaining({
        term: expect.objectContaining({
          termId: "term-semantic-hero",
          createdAt: "2026-06-17T12:00:00.000Z",
        }),
      }),
      provenance: expect.objectContaining({
        provenanceKind: "glossary_context_lookup",
        citations: [
          expect.objectContaining({
            citation: "terminology.scene.001.line.001",
          }),
        ],
      }),
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        registryKind: "deterministic_tool_invocation",
        toolName: semanticGlossarySearchRegistryToolName,
        outputHash: searchResult.metadata.outputHash,
      }),
      expect.objectContaining({
        registryKind: "deterministic_tool_invocation",
        toolName: glossaryContextRegistryToolName,
        outputHash: contextResult.metadata.outputHash,
      }),
    ]);
  });

  it("keeps valid recorded semantic search output passing and rejects malformed nested objects at the tool boundary", async () => {
    // The recorded valid semantic and exact-fallback outputs continue to validate.
    expect(() =>
      assertRegistrySchemaValue(
        semanticGlossarySearchToolOutputSchema,
        semanticGlossarySearchToolOutput(semanticGlossarySearchServiceResult()),
        "search.glossary output",
      ),
    ).not.toThrow();
    expect(() =>
      assertRegistrySchemaValue(
        semanticGlossarySearchToolOutputSchema,
        semanticGlossarySearchToolOutput(semanticGlossarySearchExactFallbackServiceResult()),
        "search.glossary output",
      ),
    ).not.toThrow();

    const cases: Array<{
      label: string;
      base: () => SemanticGlossarySearchReadModel;
      mutate: (result: SemanticGlossarySearchReadModel) => void;
      message: RegExp;
    }> = [
      {
        label: "readiness",
        base: semanticGlossarySearchServiceResult,
        mutate: (result) => {
          delete (result.readiness as unknown as Record<string, unknown>).pgvector;
        },
        message: /readiness\.pgvector is required/,
      },
      {
        label: "readiness.exactFallback.reason",
        base: semanticGlossarySearchServiceResult,
        mutate: (result) => {
          (result.readiness.exactFallback as unknown as Record<string, unknown>).reason =
            "bogus_reason";
        },
        message: /readiness\.exactFallback\.reason must be one of/,
      },
      {
        label: "term",
        base: semanticGlossarySearchServiceResult,
        mutate: (result) => {
          delete (firstSemanticGlossaryMatch(result).term as Record<string, unknown>).termId;
        },
        message: /matches\[0\]\.term\.termId is required/,
      },
      {
        label: "provenance",
        base: semanticGlossarySearchServiceResult,
        mutate: (result) => {
          (
            firstSemanticGlossaryMatch(result).provenance as Record<string, unknown>
          ).provenanceKind = "bogus_kind";
        },
        message: /matches\[0\]\.provenance\.provenanceKind must be one of/,
      },
      {
        label: "provenance.citations",
        base: semanticGlossarySearchServiceResult,
        mutate: (result) => {
          const citations = (
            firstSemanticGlossaryMatch(result).provenance as Record<string, unknown>
          ).citations as Array<Record<string, unknown>>;
          delete citations[0]?.citation;
        },
        message: /matches\[0\]\.provenance\.citations\[0\]\.citation is required/,
      },
      {
        label: "diagnostics",
        base: semanticGlossarySearchExactFallbackServiceResult,
        mutate: (result) => {
          (result.diagnostics[0] as unknown as Record<string, unknown>).severity = "critical";
        },
        message: /diagnostics\[0\]\.severity must be one of/,
      },
    ];

    for (const testCase of cases) {
      const result = testCase.base();
      testCase.mutate(result);
      await expect(
        semanticGlossarySearchRuntimeFor(result).runDeterministicToolJob<
          SemanticGlossarySearchToolInput,
          SemanticGlossarySearchToolOutput
        >(semanticGlossarySearchToolJobFixture()),
      ).rejects.toThrow(testCase.message);
    }
  });

  it("keeps valid recorded glossary context output passing and rejects malformed nested objects at the tool boundary", async () => {
    const input = glossaryContextToolJobFixture().input;
    // Found and not-found (null context) recorded outputs both continue to validate.
    expect(() =>
      assertRegistrySchemaValue(
        glossaryContextToolOutputSchema,
        glossaryContextToolOutput(input, glossaryContextServiceResult()),
        "tool.glossary-context output",
      ),
    ).not.toThrow();
    expect(() =>
      assertRegistrySchemaValue(
        glossaryContextToolOutputSchema,
        glossaryContextToolOutput(input, null),
        "tool.glossary-context output",
      ),
    ).not.toThrow();

    // The `context` read model is passed through from the service, so malformed nested
    // context/term/termProvenance is caught at the runtime tool boundary.
    const contextCases: Array<{
      label: string;
      mutate: (context: GlossaryContextReadModel) => void;
      message: RegExp;
    }> = [
      {
        label: "context.term",
        mutate: (context) => {
          delete (context.term as unknown as Record<string, unknown>).termId;
        },
        message: /context\.term\.termId is required/,
      },
      {
        label: "context.term.status",
        mutate: (context) => {
          (context.term as unknown as Record<string, unknown>).status = "bogus_status";
        },
        message: /context\.term\.status must be one of/,
      },
      {
        label: "context.term.semanticIndex.status",
        mutate: (context) => {
          (context.term.semanticIndex as unknown as Record<string, unknown>).status =
            "bogus_status";
        },
        message: /context\.term\.semanticIndex\.status must be one of/,
      },
      {
        label: "context.termProvenance",
        mutate: (context) => {
          (context.termProvenance[0] as unknown as Record<string, unknown>).referenceKind =
            "bogus_kind";
        },
        message: /context\.termProvenance\[0\]\.referenceKind must be one of/,
      },
    ];

    for (const testCase of contextCases) {
      const context = glossaryContextServiceResult();
      testCase.mutate(context);
      await expect(
        glossaryContextRuntimeFor(context).runDeterministicToolJob<
          GlossaryContextToolInput,
          GlossaryContextToolOutput
        >(glossaryContextToolJobFixture()),
      ).rejects.toThrow(testCase.message);
    }

    // The tool constructs its own provenance and diagnostics, so assert the output schema
    // rejects those nested shapes directly.
    const provenanceOutput = glossaryContextToolOutput(input, glossaryContextServiceResult());
    (provenanceOutput.provenance as Record<string, unknown>).provenanceKind = "bogus_kind";
    expect(() =>
      assertRegistrySchemaValue(
        glossaryContextToolOutputSchema,
        provenanceOutput,
        "tool.glossary-context output",
      ),
    ).toThrow(/provenance\.provenanceKind must equal/);

    const provenanceCitationsOutput = glossaryContextToolOutput(
      input,
      glossaryContextServiceResult(),
    );
    delete (
      (provenanceCitationsOutput.provenance as Record<string, unknown>).citations as Array<
        Record<string, unknown>
      >
    )[0]?.citation;
    expect(() =>
      assertRegistrySchemaValue(
        glossaryContextToolOutputSchema,
        provenanceCitationsOutput,
        "tool.glossary-context output",
      ),
    ).toThrow(/provenance\.citations\[0\]\.citation is required/);

    const diagnosticsOutput = glossaryContextToolOutput(input, null);
    (diagnosticsOutput.diagnostics[0] as Record<string, unknown>).severity = "critical";
    expect(() =>
      assertRegistrySchemaValue(
        glossaryContextToolOutputSchema,
        diagnosticsOutput,
        "tool.glossary-context output",
      ),
    ).toThrow(/diagnostics\[0\]\.severity must be one of/);
  });

  it("registers context artifact retrieval as a typed cited deterministic tool", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const retrieveArtifacts = vi.fn(async () => contextArtifactRetrievalServiceResult());
    const metadata = tools.register(contextArtifactRetrievalTool({ retrieveArtifacts }));

    expect(metadata).toMatchObject({
      registryKind: "deterministic_tool",
      toolName: contextArtifactRetrievalRegistryToolName,
      toolVersion: "1.0.0",
      taskKind: "extract",
      capabilityKey: "tool.context-artifacts",
      inputSchemaId: "itotori.tool.context-artifacts.input",
      outputSchemaId: "itotori.tool.context-artifacts.output",
      reproducibility: {
        algorithmName: "tool.context-artifacts",
        algorithmVersion: "1.0.0",
        implementationHash: contextArtifactRetrievalToolImplementationHash,
      },
    });

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });
    const job = {
      jobKind: "deterministic_tool_job",
      toolName: contextArtifactRetrievalRegistryToolName,
      toolVersion: "1.0.0",
      context: fixtureInvocationContext,
      input: {
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        categories: ["character_note"],
        bridgeUnitIds: ["unit-mira"],
        query: "Mira",
        limit: 5,
      },
    } satisfies DeterministicToolJobInput<ContextArtifactRetrievalToolInput>;

    const result = await runtime.runDeterministicToolJob<
      ContextArtifactRetrievalToolInput,
      ContextArtifactRetrievalToolOutput
    >(job, { verifyReproducible: true });

    expect(retrieveArtifacts).toHaveBeenCalledWith(job.input);
    expect(result.output).toMatchObject({
      outputKind: "context_artifact_retrieval",
      status: "completed",
      toolName: "tool.context-artifacts",
      toolVersion: "1.0.0",
      normalizedQuery: "mira",
      categories: ["character_note"],
      matches: [
        expect.objectContaining({
          contextArtifactId: "context-artifact-mira",
          category: "character_note",
          status: "active",
          citations: [
            expect.objectContaining({
              bridgeUnitId: "unit-mira",
              citation: "scene.002.mira",
              createdAt: "2026-06-17T12:00:00.000Z",
            }),
          ],
          provenance: expect.objectContaining({
            schemaVersion: "itotori.context-artifact.v1",
            toolName: "tool.context-artifacts",
            toolVersion: "1.0.0",
            contextArtifactId: "context-artifact-mira",
            producedByAgent: "agent.character-notes",
          }),
          retrievalReasons: expect.arrayContaining(["source_unit", "exact_title"]),
        }),
      ],
      diagnostics: [],
    });
    expect(result.metadata).toMatchObject({
      runtimeKind: "deterministic_tool",
      toolName: contextArtifactRetrievalRegistryToolName,
      verification: { rerunOutputHash: result.metadata.outputHash },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      registryKind: "deterministic_tool_invocation",
      toolName: contextArtifactRetrievalRegistryToolName,
      outputHash: result.metadata.outputHash,
    });
  });

  it("rejects malformed context artifact citation and provenance tool output", async () => {
    const citationResult = contextArtifactRetrievalServiceResult();
    delete (firstContextArtifactCitation(citationResult) as unknown as Record<string, unknown>)
      .citation;
    await expect(
      contextArtifactRuntimeFor(citationResult).runDeterministicToolJob<
        ContextArtifactRetrievalToolInput,
        ContextArtifactRetrievalToolOutput
      >(contextArtifactToolJobFixture()),
    ).rejects.toThrow(/citation is required/);

    const provenanceResult = contextArtifactRetrievalServiceResult();
    delete (
      firstContextArtifactMatch(provenanceResult).provenance as unknown as Record<string, unknown>
    ).contextArtifactId;
    await expect(
      contextArtifactRuntimeFor(provenanceResult).runDeterministicToolJob<
        ContextArtifactRetrievalToolInput,
        ContextArtifactRetrievalToolOutput
      >(contextArtifactToolJobFixture()),
    ).rejects.toThrow(/provenance\.contextArtifactId is required/);
  });

  it("rejects malformed context artifact nullable scalar tool output", async () => {
    const cases: Array<{
      label: string;
      mutate: (output: ContextArtifactRetrievalToolOutput, value: unknown) => void;
      message: RegExp;
    }> = [
      {
        label: "sourceRevisionId",
        mutate: (output, value) => {
          (output as unknown as Record<string, unknown>).sourceRevisionId = value;
        },
        message: /sourceRevisionId must match one of schema types string, null/,
      },
      {
        label: "query",
        mutate: (output, value) => {
          (output as unknown as Record<string, unknown>).query = value;
        },
        message: /query must match one of schema types string, null/,
      },
      {
        label: "normalizedQuery",
        mutate: (output, value) => {
          (output as unknown as Record<string, unknown>).normalizedQuery = value;
        },
        message: /normalizedQuery must match one of schema types string, null/,
      },
      {
        label: "producedByAgent",
        mutate: (output, value) => {
          (
            firstContextArtifactMatch(output) as unknown as Record<string, unknown>
          ).producedByAgent = value;
        },
        message: /matches\[0\]\.producedByAgent must match one of schema types string, null/,
      },
      {
        label: "producedByTool",
        mutate: (output, value) => {
          (firstContextArtifactMatch(output) as unknown as Record<string, unknown>).producedByTool =
            value;
        },
        message: /matches\[0\]\.producedByTool must match one of schema types string, null/,
      },
      {
        label: "provenance.producedByAgent",
        mutate: (output, value) => {
          (
            firstContextArtifactMatch(output).provenance as unknown as Record<string, unknown>
          ).producedByAgent = value;
        },
        message: /provenance\.producedByAgent must match one of schema types string, null/,
      },
      {
        label: "provenance.producedByTool",
        mutate: (output, value) => {
          (
            firstContextArtifactMatch(output).provenance as unknown as Record<string, unknown>
          ).producedByTool = value;
        },
        message: /provenance\.producedByTool must match one of schema types string, null/,
      },
      {
        label: "invalidatedReason",
        mutate: (output, value) => {
          (
            firstContextArtifactMatch(output) as unknown as Record<string, unknown>
          ).invalidatedReason = value;
        },
        message: /matches\[0\]\.invalidatedReason must match one of schema types string, null/,
      },
      {
        label: "invalidatedAt",
        mutate: (output, value) => {
          (firstContextArtifactMatch(output) as unknown as Record<string, unknown>).invalidatedAt =
            value;
        },
        message: /matches\[0\]\.invalidatedAt must match one of schema types string, null/,
      },
      {
        label: "createdByUserId",
        mutate: (output, value) => {
          (
            firstContextArtifactMatch(output) as unknown as Record<string, unknown>
          ).createdByUserId = value;
        },
        message: /matches\[0\]\.createdByUserId must match one of schema types string, null/,
      },
    ];

    for (const testCase of cases) {
      for (const malformed of [{ bad: testCase.label }, [testCase.label], 123]) {
        const output = contextArtifactRetrievalToolOutput(contextArtifactRetrievalServiceResult());
        testCase.mutate(output, malformed);
        expect(() =>
          assertRegistrySchemaValue(
            contextArtifactRetrievalToolOutputSchema,
            output,
            "tool.context-artifacts output",
          ),
        ).toThrow(testCase.message);
      }
    }
  });

  it("validates duplicate protected span raw text as distinct deterministic tool occurrences", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(protectedSpanTool());
    const runtime = new AgentToolRuntime(agents, tools);

    const result = await runtime.runDeterministicToolJob<
      ProtectedSpanCheckInput,
      ProtectedSpanCheckOutput
    >({
      ...protectedSpanCheckJobFixture,
      input: {
        targetText: "Hello, {player}.",
        protectedSpans: ["{player}", "{player}"],
      },
    });

    expect(result.output).toEqual({
      outputKind: "protected_span_check",
      missingProtectedSpans: ["{player}"],
      findings: [
        {
          span: "{player}",
          rationale: "The target text does not contain the protected span.",
        },
      ],
    });
  });

  it("rejects non-reproducible deterministic tool output when verification is enabled", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    let runCount = 0;
    const baseTool = protectedSpanTool();
    tools.register({
      ...baseTool,
      toolVersion: "1.0.1",
      reproducibility: {
        ...baseTool.reproducibility,
        algorithmVersion: "1.0.1",
        implementationHash: deriveImplementationHash({
          toolName: baseTool.toolName,
          toolVersion: "1.0.1",
          algorithmName: baseTool.reproducibility.algorithmName,
          algorithmVersion: "1.0.1",
          inputSchema: baseTool.inputSchema,
          outputSchema: baseTool.outputSchema,
        }),
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
    await expect(
      runtime.runDeterministicToolJob(protectedSpanCheckJobFixture),
    ).resolves.toMatchObject({
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
    const baseTool = protectedSpanTool();
    tools.register({
      ...baseTool,
      toolVersion: "1.0.2",
      reproducibility: {
        ...baseTool.reproducibility,
        algorithmVersion: "1.0.2",
        implementationHash: deriveImplementationHash({
          toolName: baseTool.toolName,
          toolVersion: "1.0.2",
          algorithmName: baseTool.reproducibility.algorithmName,
          algorithmVersion: "1.0.2",
          inputSchema: baseTool.inputSchema,
          outputSchema: baseTool.outputSchema,
        }),
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
      leaseLost: 0,
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

describe("implementation hash derivation and verification (ITOTORI-054)", () => {
  const sampleArtifacts: ImplementationHashArtifacts = {
    toolName: "tool.sample",
    toolVersion: "1.0.0",
    algorithmName: "sample-algorithm",
    algorithmVersion: "1.0.0",
    inputSchema: protectedSpanCheckInputSchema,
    outputSchema: protectedSpanCheckOutputSchema,
  };

  it("derives a deterministic implementation hash from canonical artifacts", () => {
    const first = deriveImplementationHash(sampleArtifacts);
    const second = deriveImplementationHash(sampleArtifacts);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("produces different hashes when any versioned artifact changes", () => {
    const baseline = deriveImplementationHash(sampleArtifacts);
    const variants: ImplementationHashArtifacts[] = [
      { ...sampleArtifacts, toolName: "tool.different" },
      { ...sampleArtifacts, toolVersion: "2.0.0" },
      { ...sampleArtifacts, algorithmName: "different-algorithm" },
      { ...sampleArtifacts, algorithmVersion: "2.0.0" },
      {
        ...sampleArtifacts,
        inputSchema: { ...sampleArtifacts.inputSchema, schemaId: "different.input" },
      },
      {
        ...sampleArtifacts,
        outputSchema: { ...sampleArtifacts.outputSchema, schemaId: "different.output" },
      },
    ];
    for (const variant of variants) {
      expect(deriveImplementationHash(variant)).not.toBe(baseline);
    }
  });

  it("produces the same hash regardless of property insertion order", () => {
    const reordered: ImplementationHashArtifacts = {
      outputSchema: sampleArtifacts.outputSchema,
      inputSchema: sampleArtifacts.inputSchema,
      algorithmVersion: sampleArtifacts.algorithmVersion,
      algorithmName: sampleArtifacts.algorithmName,
      toolVersion: sampleArtifacts.toolVersion,
      toolName: sampleArtifacts.toolName,
    };
    expect(deriveImplementationHash(reordered)).toBe(deriveImplementationHash(sampleArtifacts));
  });

  it("verifies a derived implementation hash without throwing", () => {
    const declared = deriveImplementationHash(sampleArtifacts);
    expect(() => verifyImplementationHash(declared, sampleArtifacts, "test-tool")).not.toThrow();
  });

  it("rejects a mismatched implementation hash with a diagnostic naming the tool, declared hash, and derived hash", () => {
    const declared = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    expect(() => verifyImplementationHash(declared, sampleArtifacts, "tool.sample@1.0.0")).toThrow(
      /tool\.sample@1\.0\.0 implementationHash mismatch: declared sha256:0+ does not match derived sha256:[0-9a-f]+ .*algorithm=sample-algorithm@1\.0\.0/u,
    );
  });

  it("rejects a tool registration whose declared implementationHash does not match the derived artifacts", () => {
    const tools = new DeterministicToolRegistry();
    const base = protectedSpanTool();
    const mismatchedHash = "sha256:deadbeef".padEnd(
      71,
      "0",
    ) as unknown as import("../src/agents/index.js").StableJsonHash;
    expect(() =>
      tools.register({
        ...base,
        reproducibility: {
          ...base.reproducibility,
          implementationHash: mismatchedHash,
        },
      }),
    ).toThrow(
      /tool\.protected-span-check@1\.0\.0 implementationHash mismatch: declared sha256:deadbeef.* does not match derived sha256:[0-9a-f]+/u,
    );
  });

  it("derives matching implementation hashes for every built-in deterministic tool", () => {
    const tools = new DeterministicToolRegistry();
    const searchExact = searchExactTool({
      searchExact: async () => ({
        status: "completed",
        toolName: "search.exact",
        toolVersion: "1.0.0",
        projectId: "p",
        localeBranchId: "l",
        sourceRevisionId: "r",
        query: "q",
        normalizedQuery: "q",
        diagnostics: [],
        matches: [],
      }),
    });
    const contextArtifact = contextArtifactRetrievalTool({
      retrieveArtifacts: async () => ({
        status: "completed",
        toolName: "tool.context-artifacts",
        toolVersion: "1.0.0",
        projectId: "p",
        localeBranchId: "l",
        sourceRevisionId: "r",
        query: null,
        normalizedQuery: null,
        categories: [],
        diagnostics: [],
        matches: [],
      }),
    });
    const glossarySearch = semanticGlossarySearchTool({
      searchGlossary: async () =>
        ({
          readiness: {
            embeddingMode: "recorded_fixture",
            liveProviderRequired: false,
            pgvector: { available: true },
            exactFallback: { triggered: false, reason: null },
          },
          matches: [],
          diagnostics: [],
        }) as unknown as SemanticGlossarySearchReadModel,
    });
    const glossaryContext = glossaryContextTool({
      getGlossaryContext: async () => null,
    });

    for (const definition of [
      protectedSpanTool(),
      deterministicPreExportQaTool(),
      searchExact,
      contextArtifact,
      glossarySearch,
      glossaryContext,
    ]) {
      const derived = deriveImplementationHash(toolImplementationHashArtifacts(definition));
      expect(definition.reproducibility.implementationHash).toBe(derived);
      expect(() => tools.register(definition)).not.toThrow();
    }
  });

  it("records verified implementation hash provenance in registration metadata and invocation events", async () => {
    const events: TriageEventV02[] = [];
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    const metadata = tools.register(protectedSpanTool());
    expect(metadata.implementationHashProvenance).toBe("verified");

    const runtime = new AgentToolRuntime(agents, tools, {
      emit: (event) => {
        events.push(event);
      },
    });

    const result = await runtime.runDeterministicToolJob<
      ProtectedSpanCheckInput,
      ProtectedSpanCheckOutput
    >(protectedSpanCheckJobFixture);

    expect(result.metadata.implementationHashProvenance).toBe("verified");
    expect(result.event.payload).toMatchObject({
      implementationHashProvenance: "verified",
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

function exactSearchServiceResult(): SearchExactToolResult {
  const now = new Date("2026-06-17T12:00:00.000Z");
  return {
    status: "completed",
    toolName: "search.exact",
    toolVersion: "1.0.0",
    projectId: "project-search",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-search:bundle-revision",
    query: "Hero",
    normalizedQuery: "hero",
    diagnostics: [],
    matches: [
      {
        searchDocumentId: "exact-search-doc:fixture",
        projectId: "project-search",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-search:bundle-revision",
        sourceArtifactType: "source_unit",
        sourceArtifactId: "unit-hero",
        exactTerm: "Hero",
        normalizedExactTerm: "hero",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        refreshedAt: now,
        createdAt: now,
        updatedAt: now,
        provenance: {
          provenanceKind: "exact_search_document",
          toolName: "search.exact",
          toolVersion: "1.0.0",
          searchDocumentId: "exact-search-doc:fixture",
          sourceArtifactType: "source_unit",
          sourceArtifactId: "unit-hero",
          sourceRevisionId: "bridge-search:bundle-revision",
          sourceUnitKey: "scene.001.hero",
          occurrenceId: "occurrence-hero",
          sourceHash: "hash:hero",
        },
      },
    ],
  };
}

function contextArtifactRetrievalServiceResult(): ContextArtifactRetrievalResult {
  const now = new Date("2026-06-17T12:00:00.000Z");
  const citation = {
    contextArtifactId: "context-artifact-mira",
    bridgeUnitId: "unit-mira",
    sourceRevisionId: "bridge-context:unit:unit-mira",
    sourceHash: "hash:mira",
    citation: "scene.002.mira",
    metadata: {},
    createdAt: now,
  };
  return {
    status: "completed",
    toolName: "tool.context-artifacts",
    toolVersion: "1.0.0",
    projectId: "project-context",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-context:bundle-revision",
    query: "Mira",
    normalizedQuery: "mira",
    categories: ["character_note"],
    diagnostics: [],
    matches: [
      {
        contextArtifactId: "context-artifact-mira",
        projectId: "project-context",
        localeBranchId: "locale-en-us",
        sourceRevisionId: "bridge-context:bundle-revision",
        category: "character_note",
        status: "active",
        title: "Mira",
        normalizedTitle: "mira",
        body: "Mira speaks formally when she is anxious.",
        data: { speakerLabel: "Mira" },
        contentHash: "sha256:context-artifact-mira",
        producedByAgent: "agent.character-notes",
        producedByTool: null,
        producerVersion: "1.0.0",
        provenance: {
          schemaVersion: "itotori.context-artifact.v1",
          toolName: "tool.context-artifacts",
          toolVersion: "1.0.0",
          contextArtifactId: "context-artifact-mira",
          category: "character_note",
          sourceRevisionId: "bridge-context:bundle-revision",
          producedByAgent: "agent.character-notes",
          producedByTool: null,
          producerVersion: "1.0.0",
        },
        invalidatedReason: null,
        invalidatedAt: null,
        createdByUserId: "local-user",
        createdAt: now,
        updatedAt: now,
        sourceUnits: [citation],
        citations: [citation],
        retrievalScore: 51,
        retrievalReasons: ["source_unit", "exact_title"],
      },
    ],
  };
}

function firstContextArtifactMatch(
  output: ContextArtifactRetrievalResult | ContextArtifactRetrievalToolOutput,
) {
  const match = output.matches[0];
  if (match === undefined) {
    throw new Error("context artifact fixture must include at least one match");
  }
  return match;
}

function firstContextArtifactCitation(
  output: ContextArtifactRetrievalResult | ContextArtifactRetrievalToolOutput,
) {
  const citation = firstContextArtifactMatch(output).citations[0];
  if (citation === undefined) {
    throw new Error("context artifact fixture must include at least one citation");
  }
  return citation;
}

function contextArtifactToolJobFixture(): DeterministicToolJobInput<ContextArtifactRetrievalToolInput> {
  return {
    jobKind: "deterministic_tool_job",
    toolName: contextArtifactRetrievalRegistryToolName,
    toolVersion: "1.0.0",
    context: fixtureInvocationContext,
    input: {
      projectId: "project-context",
      localeBranchId: "locale-en-us",
      sourceRevisionId: "bridge-context:bundle-revision",
      categories: ["character_note"],
      bridgeUnitIds: ["unit-mira"],
      query: "Mira",
      limit: 5,
    },
  };
}

function contextArtifactRuntimeFor(result: ContextArtifactRetrievalResult): AgentToolRuntime {
  const agents = new AgentRegistry();
  const tools = new DeterministicToolRegistry();
  tools.register(contextArtifactRetrievalTool({ retrieveArtifacts: async () => result }));
  return new AgentToolRuntime(agents, tools);
}

function semanticGlossarySearchServiceResult(): SemanticGlossarySearchReadModel {
  return {
    outputKind: "semantic_glossary_search",
    status: "completed",
    toolName: "search.glossary",
    toolVersion: "1.0.0",
    projectId: "project-terminology",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-terminology:bundle-revision",
    query: "chosen champion",
    normalizedQuery: "chosen champion",
    readiness: {
      embeddingMode: "recorded_fixture",
      liveProviderRequired: false,
      fixtureId: "semantic-glossary-fixture-v1",
      embeddingProvider: "recorded-fixture",
      embeddingModel: "semantic-fixture-v1",
      embeddingDimension: 2,
      queryEmbeddingHash: "sha256:95e99e9e5db29912f9ac19148ec3bd97c9a58c43f2c35f31d912406b0e784e8b",
      pgvector: {
        required: false,
        available: false,
        reason: "public_ci_uses_recorded_json_vectors",
      },
      exactFallback: {
        triggered: false,
        reason: null,
        toolName: "search.exact",
        toolVersion: "1.0.0",
      },
    },
    matches: [
      {
        term: {
          termId: "term-semantic-hero",
          sourceTerm: "勇者",
          preferredTranslation: "Hero",
          termKind: "character_name",
          status: "active",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
        },
        score: 0.999949,
        matchKinds: ["semantic_vector"],
        exactMatchKinds: [],
        provenance: {
          provenanceKind: "semantic_glossary_search_result",
          toolName: "search.glossary",
          toolVersion: "1.0.0",
          fixtureId: "semantic-glossary-fixture-v1",
          queryEmbeddingHash:
            "sha256:95e99e9e5db29912f9ac19148ec3bd97c9a58c43f2c35f31d912406b0e784e8b",
          semanticIndexId: "semantic-index-hero",
          semanticIndexStatus: "ready",
          embeddingProvider: "itotori-recorded-fixture",
          embeddingModel: "semantic-fixture-v1",
          embeddingDimension: 2,
          contentHash: "sha256:semantic-hero",
          citations: [
            {
              sourceRefId: "source-ref-hero",
              sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
              bridgeUnitId: "bridge-unit-term",
              referenceKind: "source_unit",
              citation: "terminology.scene.001.line.001",
              context: "Opening narration names the hero.",
            },
          ],
        },
      },
    ],
    diagnostics: [],
  };
}

function glossaryContextServiceResult(): GlossaryContextReadModel {
  const now = new Date("2026-06-17T12:00:00.000Z");
  return {
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-terminology:bundle-revision",
    styleGuideVersionId: "style-guide-version-glossary-policy",
    glossaryReferenceId: "glossary-reference-hero",
    branchReference: null,
    term: {
      termId: "term-semantic-hero",
      projectId: "project-terminology",
      localeBranchId: "locale-en-us",
      sourceTerm: "勇者",
      normalizedSourceTerm: "勇者",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      preferredTranslation: "Hero",
      normalizedPreferredTranslation: "hero",
      termKind: "character_name",
      partOfSpeech: null,
      status: "active",
      caseSensitive: false,
      notes: null,
      metadata: {},
      createdByUserId: "local-user",
      createdAt: now,
      updatedAt: now,
      aliases: [],
      sourceReferences: [
        {
          sourceRefId: "source-ref-hero",
          termId: "term-semantic-hero",
          sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
          bridgeUnitId: "bridge-unit-term",
          sourceProvenanceId: null,
          referenceKind: "source_unit",
          citation: "terminology.scene.001.line.001",
          context: "Opening narration names the hero.",
          metadata: {},
          createdAt: now,
        },
      ],
      semanticIndex: {
        semanticIndexId: "semantic-index-hero",
        termId: "term-semantic-hero",
        searchDocument: "Hero protagonist chosen champion relic",
        searchTokens: ["hero", "protagonist", "chosen", "champion", "relic"],
        embeddingProvider: "itotori-recorded-fixture",
        embeddingModel: "semantic-fixture-v1",
        embeddingDimension: 2,
        embeddingVector: [0.99, 0.01],
        contentHash: "sha256:semantic-hero",
        status: "ready",
        metadata: {
          indexKind: "semantic_vector_index",
          semanticReady: true,
          vectorReady: true,
        },
        refreshedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    },
    termProvenance: [
      {
        sourceRefId: "source-ref-hero",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
        bridgeUnitId: "bridge-unit-term",
        sourceProvenanceId: null,
        referenceKind: "source_unit",
        citation: "terminology.scene.001.line.001",
        context: "Opening narration names the hero.",
        metadata: {},
      },
    ],
    protectedSpanReferences: [],
  };
}

function semanticGlossarySearchExactFallbackServiceResult(): SemanticGlossarySearchReadModel {
  return {
    outputKind: "semantic_glossary_search",
    status: "completed",
    toolName: "search.glossary",
    toolVersion: "1.0.0",
    projectId: "project-terminology",
    localeBranchId: "locale-en-us",
    sourceRevisionId: "bridge-terminology:bundle-revision",
    query: "chosen champion",
    normalizedQuery: "chosen champion",
    readiness: {
      embeddingMode: "recorded_fixture",
      liveProviderRequired: false,
      fixtureId: "unresolved-recorded-fixture",
      embeddingProvider: "recorded-fixture",
      embeddingModel: "recorded-fixture",
      embeddingDimension: 0,
      queryEmbeddingHash: null,
      pgvector: {
        required: false,
        available: false,
        reason: "public_ci_uses_recorded_json_vectors",
      },
      exactFallback: {
        triggered: true,
        reason: "no_semantic_results",
        toolName: "search.exact",
        toolVersion: "1.0.0",
      },
    },
    matches: [
      {
        term: {
          termId: "term-semantic-hero",
          sourceTerm: "勇者",
          preferredTranslation: "Hero",
          termKind: "character_name",
          status: "active",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
        },
        score: 1,
        matchKinds: ["exact_fallback"],
        exactMatchKinds: ["exact_source"],
        provenance: {
          provenanceKind: "semantic_glossary_exact_fallback_result",
          toolName: "search.glossary",
          toolVersion: "1.0.0",
          fallbackToolName: "search.exact",
          fallbackToolVersion: "1.0.0",
          termId: "term-semantic-hero",
          exactMatchKinds: ["exact_source"],
          citations: [
            {
              sourceRefId: "source-ref-hero",
              sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
              bridgeUnitId: "bridge-unit-term",
              referenceKind: "source_unit",
              citation: "terminology.scene.001.line.001",
              context: "Opening narration names the hero.",
            },
          ],
        },
      },
    ],
    diagnostics: [
      {
        code: "no_semantic_results",
        reasonCode: "no_semantic_results",
        severity: "info",
        message: "recorded semantic ranking produced no candidates; exact fallback was used",
        metadata: { fallbackReason: "no_semantic_results" },
      },
      {
        code: "exact_fallback_used",
        reasonCode: "exact_fallback_used",
        severity: "info",
        message: "semantic glossary search used deterministic exact fallback",
        metadata: {
          reason: "no_semantic_results",
          matchCount: 1,
          toolName: "search.exact",
          toolVersion: "1.0.0",
        },
      },
    ],
  };
}

function glossaryContextToolJobFixture(): DeterministicToolJobInput<GlossaryContextToolInput> {
  return {
    jobKind: "deterministic_tool_job",
    toolName: glossaryContextRegistryToolName,
    toolVersion: "2.0.0",
    context: fixtureInvocationContext,
    input: {
      localeBranchId: "locale-en-us",
      termId: "term-semantic-hero",
      sourceRevisionId: "bridge-terminology:bundle-revision",
    },
  };
}

function semanticGlossarySearchRuntimeFor(
  result: SemanticGlossarySearchReadModel,
): AgentToolRuntime {
  const agents = new AgentRegistry();
  const tools = new DeterministicToolRegistry();
  tools.register(semanticGlossarySearchTool({ searchGlossary: async () => result }));
  return new AgentToolRuntime(agents, tools);
}

function semanticGlossarySearchToolJobFixture(): DeterministicToolJobInput<SemanticGlossarySearchToolInput> {
  return {
    jobKind: "deterministic_tool_job",
    toolName: semanticGlossarySearchRegistryToolName,
    toolVersion: "1.0.0",
    context: fixtureInvocationContext,
    input: {
      projectId: "project-terminology",
      localeBranchId: "locale-en-us",
      query: "chosen champion",
    },
  };
}

function glossaryContextRuntimeFor(context: GlossaryContextReadModel | null): AgentToolRuntime {
  const agents = new AgentRegistry();
  const tools = new DeterministicToolRegistry();
  tools.register(glossaryContextTool({ getGlossaryContext: async () => context }));
  return new AgentToolRuntime(agents, tools);
}

function firstSemanticGlossaryMatch(
  result: SemanticGlossarySearchReadModel,
): Record<string, unknown> {
  const match = result.matches[0];
  if (match === undefined) {
    throw new Error("semantic glossary fixture must include at least one match");
  }
  return match as unknown as Record<string, unknown>;
}

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
