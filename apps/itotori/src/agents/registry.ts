import { createHash, randomBytes } from "node:crypto";
import { FINDING_KINDS, TRIAGE_SEVERITIES } from "@itotori/localization-bridge-schema";
import type {
  CausalLinkV02,
  FindingKindV02,
  ProvenanceRecordV02,
  TriageEventKindV02,
  TriageEventV02,
  TriageSeverityV02,
  TriageSubjectRefV02,
  TriageTaskKindV02,
  Uuid7,
} from "@itotori/localization-bridge-schema";
import type {
  JsonObject,
  JsonValue,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  PromptPresetReference,
  ProviderRunRecord,
} from "../providers/types.js";
import { assertProviderInvocationSupported } from "../providers/capability-guard.js";

export type StableJsonHash = `sha256:${string}`;
export type AgentName = `agent.${string}`;
export type DeterministicToolName = `tool.${string}` | `search.${string}`;

export type AgentTaskKind = Extract<TriageTaskKindV02, "draft_translation" | "llm_qa" | "repair">;
export type DeterministicToolTaskKind = Extract<
  TriageTaskKindV02,
  "deterministic_qa" | "extract" | "patch" | "runtime_verify"
>;

export type RegistrySchemaDescriptor = {
  schemaId: string;
  schemaVersion: string;
  description: string;
  jsonSchema: JsonObject;
};

export type AgentOutputFinding = JsonObject & {
  findingKind: FindingKindV02;
  severity: TriageSeverityV02;
  title: string;
  rationale: string;
  evidence: string[];
};

export type AgentOutputRecord = JsonObject & {
  outputKind: string;
};

export type AgentJudgmentOutput = AgentOutputRecord & {
  outputKind: "score" | "judgment";
  rationales: [string, ...string[]];
  findings: AgentOutputFinding[];
  score?: number;
  verdict?: string;
};

export type AgentDefinition<
  Input extends JsonObject = JsonObject,
  Output extends AgentOutputRecord = AgentOutputRecord,
> = {
  registryKind: "agent_definition";
  agentName: AgentName;
  agentVersion: string;
  description: string;
  taskKind: AgentTaskKind;
  provider: ModelProvider;
  prompt: PromptPresetReference;
  inputSchema: RegistrySchemaDescriptor;
  outputSchema: RegistrySchemaDescriptor;
  completionEventKind?: TriageEventKindV02;
  createRequest(input: Input, context: RegistryInvocationContext): ModelInvocationRequest;
  parseResult(
    result: ModelInvocationResult,
    input: Input,
    context: RegistryInvocationContext,
  ): Output;
};

export type DeterministicToolReproducibilitySpec = {
  algorithmName: string;
  algorithmVersion: string;
  implementationHash: StableJsonHash;
  inputHashAlgorithm: "sha256-stable-json-v1";
  outputHashAlgorithm: "sha256-stable-json-v1";
  sideEffectFree: true;
};

export type ImplementationHashProvenance = "verified" | "declared";

export type ImplementationHashArtifacts = {
  toolName: DeterministicToolName;
  toolVersion: string;
  algorithmName: string;
  algorithmVersion: string;
  inputSchema: RegistrySchemaDescriptor;
  outputSchema: RegistrySchemaDescriptor;
};

export type DeterministicToolDefinition<
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
> = {
  registryKind: "deterministic_tool_definition";
  toolName: DeterministicToolName;
  toolVersion: string;
  description: string;
  taskKind: DeterministicToolTaskKind;
  capabilityKey: string;
  inputSchema: RegistrySchemaDescriptor;
  outputSchema: RegistrySchemaDescriptor;
  reproducibility: DeterministicToolReproducibilitySpec;
  completionEventKind?: TriageEventKindV02;
  run(input: Input, context: RegistryInvocationContext): Output | Promise<Output>;
};

export type RegistryInvocationContext = {
  taskId: Uuid7;
  subjectRefs: TriageSubjectRefV02[];
  causalLinks?: CausalLinkV02[];
  occurredAt?: string;
};

export type AgentJobInput<Input extends JsonObject = JsonObject> = {
  jobKind: "agent_job";
  agentName: AgentName;
  agentVersion: string;
  input: Input;
  context: RegistryInvocationContext;
};

export type DeterministicToolJobInput<Input extends JsonObject = JsonObject> = {
  jobKind: "deterministic_tool_job";
  toolName: DeterministicToolName;
  toolVersion: string;
  input: Input;
  context: RegistryInvocationContext;
};

export type AgentRegistrationMetadata = {
  registryKind: "agent";
  agentName: AgentName;
  agentVersion: string;
  taskKind: AgentTaskKind;
  inputSchemaId: string;
  outputSchemaId: string;
  providerFamily: string;
  providerName: string;
  defaultModelId: string;
  promptPresetId: string;
  promptTemplateVersion: string;
  promptHash: string;
};

export type DeterministicToolRegistrationMetadata = {
  registryKind: "deterministic_tool";
  toolName: DeterministicToolName;
  toolVersion: string;
  taskKind: DeterministicToolTaskKind;
  capabilityKey: string;
  inputSchemaId: string;
  outputSchemaId: string;
  reproducibility: DeterministicToolReproducibilitySpec;
  implementationHashProvenance: ImplementationHashProvenance;
};

export type AgentInvocationMetadata = {
  runtimeKind: "llm_agent";
  agentName: AgentName;
  agentVersion: string;
  taskKind: AgentTaskKind;
  inputHash: StableJsonHash;
  outputHash: StableJsonHash;
  providerRun: ProviderRunRecord;
  emittedEventId: Uuid7;
};

export type DeterministicToolInvocationMetadata = {
  runtimeKind: "deterministic_tool";
  toolName: DeterministicToolName;
  toolVersion: string;
  taskKind: DeterministicToolTaskKind;
  capabilityKey: string;
  inputHash: StableJsonHash;
  outputHash: StableJsonHash;
  reproducibility: DeterministicToolReproducibilitySpec;
  implementationHashProvenance: ImplementationHashProvenance;
  emittedEventId: Uuid7;
  verification?: {
    rerunOutputHash: StableJsonHash;
  };
};

export type AgentJobOutput<Output extends AgentOutputRecord = AgentOutputRecord> = {
  jobKind: "agent_job";
  output: Output;
  metadata: AgentInvocationMetadata;
  event: TriageEventV02;
};

export type DeterministicToolJobOutput<Output extends JsonObject = JsonObject> = {
  jobKind: "deterministic_tool_job";
  output: Output;
  metadata: DeterministicToolInvocationMetadata;
  event: TriageEventV02;
};

export type AgentToolEventSink = {
  emit(event: TriageEventV02): Promise<void> | void;
};

export type DeterministicToolRunOptions = {
  verifyReproducible?: boolean;
};

const defaultAgentCompletionEventKind = "model_output_recorded" satisfies TriageEventKindV02;
const defaultToolCompletionEventKind = "qa_finding_reported" satisfies TriageEventKindV02;

export class AgentRegistry {
  private readonly definitions = new Map<string, unknown>();

  register<Input extends JsonObject, Output extends AgentOutputRecord>(
    definition: AgentDefinition<Input, Output>,
  ): AgentRegistrationMetadata {
    assertAgentDefinitionShape(definition);
    const key = registryKey(definition.agentName, definition.agentVersion);
    if (this.definitions.has(key)) {
      throw new Error(
        `agent ${definition.agentName}@${definition.agentVersion} is already registered`,
      );
    }
    this.definitions.set(key, definition);
    return agentRegistrationMetadata(definition);
  }

  get<Input extends JsonObject, Output extends AgentOutputRecord>(
    agentName: AgentName,
    agentVersion: string,
  ): AgentDefinition<Input, Output> {
    const value = this.definitions.get(registryKey(agentName, agentVersion));
    if (value === undefined) {
      throw new Error(`agent ${agentName}@${agentVersion} is not registered`);
    }
    return value as AgentDefinition<Input, Output>;
  }

  list(): AgentRegistrationMetadata[] {
    return [...this.definitions.values()].map((value) =>
      agentRegistrationMetadata(value as AgentDefinition<JsonObject, AgentOutputRecord>),
    );
  }
}

export class DeterministicToolRegistry {
  private readonly definitions = new Map<string, unknown>();

  register<Input extends JsonObject, Output extends JsonObject>(
    definition: DeterministicToolDefinition<Input, Output>,
  ): DeterministicToolRegistrationMetadata {
    assertDeterministicToolDefinitionShape(definition);
    verifyImplementationHash(
      definition.reproducibility.implementationHash,
      toolImplementationHashArtifacts(definition),
      `${definition.toolName}@${definition.toolVersion}`,
    );
    const key = registryKey(definition.toolName, definition.toolVersion);
    if (this.definitions.has(key)) {
      throw new Error(
        `deterministic tool ${definition.toolName}@${definition.toolVersion} is already registered`,
      );
    }
    this.definitions.set(key, definition);
    return deterministicToolRegistrationMetadata(definition);
  }

  get<Input extends JsonObject, Output extends JsonObject>(
    toolName: DeterministicToolName,
    toolVersion: string,
  ): DeterministicToolDefinition<Input, Output> {
    const value = this.definitions.get(registryKey(toolName, toolVersion));
    if (value === undefined) {
      throw new Error(`deterministic tool ${toolName}@${toolVersion} is not registered`);
    }
    return value as DeterministicToolDefinition<Input, Output>;
  }

  list(): DeterministicToolRegistrationMetadata[] {
    return [...this.definitions.values()].map((value) =>
      deterministicToolRegistrationMetadata(
        value as DeterministicToolDefinition<JsonObject, JsonObject>,
      ),
    );
  }
}

export class AgentToolRuntime {
  constructor(
    private readonly agents: AgentRegistry,
    private readonly deterministicTools: DeterministicToolRegistry,
    private readonly events: AgentToolEventSink = { emit: () => undefined },
  ) {}

  async runAgentJob<Input extends JsonObject, Output extends AgentOutputRecord>(
    job: AgentJobInput<Input>,
  ): Promise<AgentJobOutput<Output>> {
    const definition = this.agents.get<Input, Output>(job.agentName, job.agentVersion);
    assertRegistrySchemaValue(definition.inputSchema, job.input, `${definition.agentName} input`);
    const request = definition.createRequest(job.input, job.context);
    assertAgentRequestMatchesDefinition(definition, request);
    const inputHash = hashJson(job.input);
    assertProviderInvocationSupported({
      descriptor: definition.provider.descriptor,
      request,
      requestedModelId: request.modelId ?? definition.provider.descriptor.defaultModelId,
    });
    const result = await definition.provider.invoke(request);
    const output = definition.parseResult(result, job.input, job.context);
    assertRegistrySchemaValue(definition.outputSchema, output, `${definition.agentName} output`);
    assertAgentOutputContract(output, `${definition.agentName} output`);
    const outputHash = hashJson(output);
    const event = agentInvocationEvent(definition, job, result.providerRun, inputHash, outputHash);
    await this.events.emit(event);
    return {
      jobKind: "agent_job",
      output,
      event,
      metadata: {
        runtimeKind: "llm_agent",
        agentName: definition.agentName,
        agentVersion: definition.agentVersion,
        taskKind: definition.taskKind,
        inputHash,
        outputHash,
        providerRun: result.providerRun,
        emittedEventId: event.eventId,
      },
    };
  }

  async runDeterministicToolJob<Input extends JsonObject, Output extends JsonObject>(
    job: DeterministicToolJobInput<Input>,
    options: DeterministicToolRunOptions = {},
  ): Promise<DeterministicToolJobOutput<Output>> {
    const definition = this.deterministicTools.get<Input, Output>(job.toolName, job.toolVersion);
    assertRegistrySchemaValue(definition.inputSchema, job.input, `${definition.toolName} input`);
    const inputHash = hashJson(job.input);
    const output = await definition.run(job.input, job.context);
    assertRegistrySchemaValue(definition.outputSchema, output, `${definition.toolName} output`);
    assertNoConfidenceFields(output, `${definition.toolName} output`);
    const outputHash = hashJson(output);
    let verification: DeterministicToolInvocationMetadata["verification"];
    if (options.verifyReproducible === true) {
      const rerunOutput = await definition.run(job.input, job.context);
      assertRegistrySchemaValue(
        definition.outputSchema,
        rerunOutput,
        `${definition.toolName} verification output`,
      );
      assertNoConfidenceFields(rerunOutput, `${definition.toolName} verification output`);
      const rerunOutputHash = hashJson(rerunOutput);
      if (rerunOutputHash !== outputHash) {
        throw new Error(
          `${definition.toolName} reproducibility verification failed: output hash ${outputHash} did not match rerun output hash ${rerunOutputHash}`,
        );
      }
      verification = { rerunOutputHash };
    }
    const event = deterministicToolInvocationEvent(definition, job, inputHash, outputHash);
    await this.events.emit(event);
    const metadata: DeterministicToolInvocationMetadata = {
      runtimeKind: "deterministic_tool",
      toolName: definition.toolName,
      toolVersion: definition.toolVersion,
      taskKind: definition.taskKind,
      capabilityKey: definition.capabilityKey,
      inputHash,
      outputHash,
      reproducibility: definition.reproducibility,
      implementationHashProvenance: "verified",
      emittedEventId: event.eventId,
      ...(verification === undefined ? {} : { verification }),
    };
    return {
      jobKind: "deterministic_tool_job",
      output,
      event,
      metadata,
    };
  }
}

export function assertRegistrySchemaValue(
  descriptor: RegistrySchemaDescriptor,
  value: unknown,
  label = descriptor.schemaId,
): asserts value is JsonValue {
  assertJsonValue(value, label);
  assertJsonSchemaNode(descriptor.jsonSchema, value, label);
}

export function hashJson(value: JsonValue): StableJsonHash {
  const digest = createHash("sha256").update(stableStringify(value)).digest("hex");
  return `sha256:${digest}`;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function deriveImplementationHash(artifacts: ImplementationHashArtifacts): StableJsonHash {
  const canonical: JsonObject = {
    algorithmName: artifacts.algorithmName,
    algorithmVersion: artifacts.algorithmVersion,
    inputSchema: artifacts.inputSchema,
    outputSchema: artifacts.outputSchema,
    toolName: artifacts.toolName,
    toolVersion: artifacts.toolVersion,
  };
  return hashJson(canonical);
}

export function verifyImplementationHash(
  declared: StableJsonHash,
  artifacts: ImplementationHashArtifacts,
  label: string,
): void {
  const derived = deriveImplementationHash(artifacts);
  if (declared !== derived) {
    throw new Error(
      `${label} implementationHash mismatch: declared ${declared} does not match derived ${derived} ` +
        `from canonical artifacts (tool=${artifacts.toolName}@${artifacts.toolVersion}, ` +
        `algorithm=${artifacts.algorithmName}@${artifacts.algorithmVersion})`,
    );
  }
}

export function toolImplementationHashArtifacts<
  Input extends JsonObject,
  Output extends JsonObject,
>(definition: DeterministicToolDefinition<Input, Output>): ImplementationHashArtifacts {
  return {
    toolName: definition.toolName,
    toolVersion: definition.toolVersion,
    algorithmName: definition.reproducibility.algorithmName,
    algorithmVersion: definition.reproducibility.algorithmVersion,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  };
}

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const normalized: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) {
        normalized[key] = normalizeJsonValue(child);
      }
    }
    return normalized;
  }
  return value;
}

function assertAgentDefinitionShape(value: unknown): asserts value is AgentDefinition {
  const definition = asRecord(value, "agent definition");
  const registryKind = definition["registryKind"];
  if (registryKind === "deterministic_tool_definition") {
    throw new Error("deterministic tool definitions cannot be registered as agents");
  }
  if (registryKind !== "agent_definition") {
    throw new Error("agent definitions must declare registryKind agent_definition");
  }
  const agentName = definition["agentName"];
  if (typeof agentName !== "string" || !agentName.startsWith("agent.")) {
    throw new Error("agent definitions must use an agent.* name");
  }
  if ("toolName" in definition) {
    throw new Error("agent definitions must not include toolName");
  }
}

function assertDeterministicToolDefinitionShape(
  value: unknown,
): asserts value is DeterministicToolDefinition {
  const definition = asRecord(value, "deterministic tool definition");
  const registryKind = definition["registryKind"];
  if (registryKind === "agent_definition") {
    throw new Error("agent definitions cannot be registered as deterministic tools");
  }
  if (registryKind !== "deterministic_tool_definition") {
    throw new Error(
      "deterministic tool definitions must declare registryKind deterministic_tool_definition",
    );
  }
  const toolName = definition["toolName"];
  if (
    typeof toolName !== "string" ||
    (!toolName.startsWith("tool.") && !toolName.startsWith("search."))
  ) {
    throw new Error("deterministic tool definitions must use a tool.* or search.* name");
  }
  if ("agentName" in definition) {
    throw new Error("deterministic tool definitions must not include agentName");
  }
  const reproducibility = asRecord(
    definition["reproducibility"],
    "deterministic tool reproducibility",
  );
  if (reproducibility["sideEffectFree"] !== true) {
    throw new Error("deterministic tool reproducibility must declare sideEffectFree true");
  }
}

function assertAgentOutputContract(output: AgentOutputRecord, label: string): void {
  assertNoConfidenceFields(output, label);
  if (!isJudgingOutput(output)) {
    return;
  }
  const rationales = output["rationales"];
  if (!Array.isArray(rationales) || rationales.length === 0) {
    throw new Error(`${label} score or judgment output must include rationales`);
  }
  for (const [index, rationale] of rationales.entries()) {
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      throw new Error(`${label}.rationales[${index}] must be a non-empty string`);
    }
  }
  if (!Array.isArray(output["findings"])) {
    throw new Error(`${label} score or judgment output must include findings`);
  }
  for (const [index, finding] of output["findings"].entries()) {
    assertAgentOutputFinding(finding, `${label}.findings[${index}]`);
  }
}

function assertAgentOutputFinding(
  value: unknown,
  label: string,
): asserts value is AgentOutputFinding {
  const finding = asRecord(value, label);
  assertEnumValue(finding["findingKind"], FINDING_KINDS, `${label}.findingKind`);
  assertEnumValue(finding["severity"], TRIAGE_SEVERITIES, `${label}.severity`);
  assertNonEmptyString(finding["title"], `${label}.title`);
  assertNonEmptyString(finding["rationale"], `${label}.rationale`);
  const evidence = finding["evidence"];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`${label}.evidence must contain at least one evidence string`);
  }
  for (const [index, record] of evidence.entries()) {
    assertNonEmptyString(record, `${label}.evidence[${index}]`);
  }
}

function assertAgentRequestMatchesDefinition<
  Input extends JsonObject,
  Output extends AgentOutputRecord,
>(definition: AgentDefinition<Input, Output>, request: ModelInvocationRequest): void {
  if (request.taskKind !== definition.taskKind) {
    throw new Error(
      `${definition.agentName} request taskKind ${request.taskKind} does not match registered taskKind ${definition.taskKind}`,
    );
  }
  if (
    request.prompt.presetId !== definition.prompt.presetId ||
    request.prompt.templateVersion !== definition.prompt.templateVersion ||
    request.prompt.promptHash !== definition.prompt.promptHash
  ) {
    throw new Error(
      `${definition.agentName} request prompt does not match registered prompt identity`,
    );
  }
}

function assertNoConfidenceFields(value: JsonValue, label: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoConfidenceFields(item, `${label}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("confidence")) {
      throw new Error(`${label}.${key} is not allowed; use rationales or findings instead`);
    }
    assertNoConfidenceFields(child, `${label}.${key}`);
  }
}

function isJudgingOutput(output: AgentOutputRecord): boolean {
  return (
    output.outputKind === "score" ||
    output.outputKind === "judgment" ||
    typeof output["score"] === "number" ||
    typeof output["verdict"] === "string"
  );
}

function agentInvocationEvent<Input extends JsonObject, Output extends AgentOutputRecord>(
  definition: AgentDefinition<Input, Output>,
  job: AgentJobInput<Input>,
  providerRun: ProviderRunRecord,
  inputHash: StableJsonHash,
  outputHash: StableJsonHash,
): TriageEventV02 {
  const provenance: ProvenanceRecordV02 = {
    provenanceId: createUuid7(),
    provenanceKind: "model_output",
    modelOutputId: createUuid7(),
    taskId: job.context.taskId,
    provider: `${providerRun.provider.providerFamily}/${providerRun.provider.providerName}`,
    model: providerRun.provider.actualModelId,
    outputHash,
    promptHash: providerRun.prompt.promptHash,
  };
  return {
    eventId: createUuid7(),
    eventKind: definition.completionEventKind ?? defaultAgentCompletionEventKind,
    occurredAt: job.context.occurredAt ?? providerRun.completedAt,
    actor: {
      actorKind: "agent",
      displayName: `${definition.agentName}@${definition.agentVersion}`,
    },
    taskId: job.context.taskId,
    subjectRefs: job.context.subjectRefs,
    provenance: [provenance],
    causalLinks: job.context.causalLinks ?? [],
    payload: {
      registryKind: "agent_invocation",
      runtimeKind: "llm_agent",
      agentName: definition.agentName,
      agentVersion: definition.agentVersion,
      taskKind: definition.taskKind,
      inputHash,
      outputHash,
      providerRunId: providerRun.runId,
      providerFamily: providerRun.provider.providerFamily,
      providerName: providerRun.provider.providerName,
      requestedModelId: providerRun.provider.requestedModelId,
      actualModelId: providerRun.provider.actualModelId,
      promptPresetId: providerRun.prompt.presetId,
      promptTemplateVersion: providerRun.prompt.templateVersion,
      promptHash: providerRun.prompt.promptHash,
    },
  };
}

function deterministicToolInvocationEvent<Input extends JsonObject, Output extends JsonObject>(
  definition: DeterministicToolDefinition<Input, Output>,
  job: DeterministicToolJobInput<Input>,
  inputHash: StableJsonHash,
  outputHash: StableJsonHash,
): TriageEventV02 {
  const provenance: ProvenanceRecordV02 = {
    provenanceId: createUuid7(),
    provenanceKind: "deterministic_check",
    checkId: createUuid7(),
    checkName: definition.toolName,
    checkVersion: definition.toolVersion,
  };
  return {
    eventId: createUuid7(),
    eventKind: definition.completionEventKind ?? defaultToolCompletionEventKind,
    occurredAt: job.context.occurredAt ?? new Date().toISOString(),
    actor: {
      actorKind: "tool",
      displayName: `${definition.toolName}@${definition.toolVersion}`,
    },
    taskId: job.context.taskId,
    subjectRefs: job.context.subjectRefs,
    provenance: [provenance],
    causalLinks: job.context.causalLinks ?? [],
    payload: {
      registryKind: "deterministic_tool_invocation",
      runtimeKind: "deterministic_tool",
      toolName: definition.toolName,
      toolVersion: definition.toolVersion,
      taskKind: definition.taskKind,
      capabilityKey: definition.capabilityKey,
      inputHash,
      outputHash,
      reproducibility: definition.reproducibility,
      implementationHashProvenance: "verified",
    },
  };
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${label} must be finite JSON number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${label}[${index}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new Error(`${label}.${key} must be JSON-serializable`);
      }
      assertJsonValue(child, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} must be JSON-serializable`);
}

function assertJsonSchemaNode(schema: JsonObject, value: JsonValue, label: string): void {
  if (
    "const" in schema &&
    stableStringify(value) !== stableStringify(schema["const"] as JsonValue)
  ) {
    throw new Error(`${label} must equal ${stableStringify(schema["const"] as JsonValue)}`);
  }

  const enumValues = schema["enum"];
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues)) {
      throw new Error(`${label} schema enum must be an array`);
    }
    const normalizedValue = stableStringify(value);
    if (!enumValues.some((item) => stableStringify(item) === normalizedValue)) {
      throw new Error(
        `${label} must be one of ${enumValues.map((item) => stableStringify(item)).join(", ")}`,
      );
    }
  }

  const schemaType = schema["type"];
  if (schemaType !== undefined) {
    if (Array.isArray(schemaType)) {
      if (schemaType.length === 0 || !schemaType.every((item) => typeof item === "string")) {
        throw new Error(`${label} schema type array must contain strings`);
      }
      if (!schemaType.some((item) => jsonSchemaTypeMatches(item, value))) {
        throw new Error(`${label} must match one of schema types ${schemaType.join(", ")}`);
      }
    } else if (typeof schemaType === "string") {
      assertJsonSchemaType(schemaType, value, label);
    } else {
      throw new Error(`${label} schema type must be a string or string array`);
    }
  }

  // A null value that satisfies a nullable union type (e.g. `["object", "null"]`) needs no
  // further object/array/string/number shape checks — those would incorrectly reject null.
  if (value === null && Array.isArray(schemaType) && schemaType.includes("null")) {
    return;
  }

  if (
    schemaType === "object" ||
    schema["properties"] !== undefined ||
    schema["required"] !== undefined
  ) {
    assertJsonObjectSchema(schema, value, label);
  }
  if (schemaType === "array" || schema["items"] !== undefined) {
    assertJsonArraySchema(schema, value, label);
  }
  if (schemaType === "string") {
    assertJsonStringSchema(schema, value, label);
  }
  if (schemaType === "number" || schemaType === "integer") {
    assertJsonNumberSchema(schema, value, label);
  }
}

function jsonSchemaTypeMatches(type: string, value: JsonValue): boolean {
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "number") {
    return typeof value === "number";
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (type === "null") {
    return value === null;
  }
  throw new Error(`schema type ${type} is not supported`);
}

function assertJsonSchemaType(type: string, value: JsonValue, label: string): void {
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${label} must be an array`);
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${label} must be a string`);
    }
    return;
  }
  if (type === "number") {
    if (typeof value !== "number") {
      throw new Error(`${label} must be a number`);
    }
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${label} must be a boolean`);
    }
    return;
  }
  if (type === "null") {
    if (value !== null) {
      throw new Error(`${label} must be null`);
    }
    return;
  }
  throw new Error(`${label} schema type ${type} is not supported`);
}

function assertJsonObjectSchema(schema: JsonObject, value: JsonValue, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const properties = schema["properties"];
  const propertySchemas =
    properties === undefined ? {} : asSchemaMap(properties, `${label} schema properties`);

  const required = schema["required"];
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      throw new Error(`${label} schema required must be an array`);
    }
    for (const item of required) {
      if (typeof item !== "string") {
        throw new Error(`${label} schema required entries must be strings`);
      }
      if (!(item in value)) {
        throw new Error(`${label}.${item} is required`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(propertySchemas)) {
    const child = value[key];
    if (child !== undefined) {
      assertJsonSchemaNode(propertySchema, child, `${label}.${key}`);
    }
  }

  if (schema["additionalProperties"] === false) {
    for (const key of Object.keys(value)) {
      if (!(key in propertySchemas)) {
        throw new Error(`${label}.${key} is not allowed by ${schema["description"] ?? "schema"}`);
      }
    }
  }
}

function assertJsonArraySchema(schema: JsonObject, value: JsonValue, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const minItems = schema["minItems"];
  if (minItems !== undefined) {
    if (typeof minItems !== "number") {
      throw new Error(`${label} schema minItems must be a number`);
    }
    if (value.length < minItems) {
      throw new Error(`${label} must contain at least ${minItems} item(s)`);
    }
  }
  const maxItems = schema["maxItems"];
  if (maxItems !== undefined) {
    if (typeof maxItems !== "number") {
      throw new Error(`${label} schema maxItems must be a number`);
    }
    if (value.length > maxItems) {
      throw new Error(`${label} must contain at most ${maxItems} item(s)`);
    }
  }
  const items = schema["items"];
  if (items !== undefined) {
    const itemSchema = asSchema(items, `${label} schema items`);
    for (const [index, item] of value.entries()) {
      assertJsonSchemaNode(itemSchema, item, `${label}[${index}]`);
    }
  }
}

function assertJsonStringSchema(schema: JsonObject, value: JsonValue, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const minLength = schema["minLength"];
  if (minLength !== undefined) {
    if (typeof minLength !== "number") {
      throw new Error(`${label} schema minLength must be a number`);
    }
    if (value.length < minLength) {
      throw new Error(`${label} must contain at least ${minLength} character(s)`);
    }
  }
  const maxLength = schema["maxLength"];
  if (maxLength !== undefined) {
    if (typeof maxLength !== "number") {
      throw new Error(`${label} schema maxLength must be a number`);
    }
    if (value.length > maxLength) {
      throw new Error(`${label} must contain at most ${maxLength} character(s)`);
    }
  }
}

function assertJsonNumberSchema(schema: JsonObject, value: JsonValue, label: string): void {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number`);
  }
  const minimum = schema["minimum"];
  if (minimum !== undefined) {
    if (typeof minimum !== "number") {
      throw new Error(`${label} schema minimum must be a number`);
    }
    if (value < minimum) {
      throw new Error(`${label} must be greater than or equal to ${minimum}`);
    }
  }
  const maximum = schema["maximum"];
  if (maximum !== undefined) {
    if (typeof maximum !== "number") {
      throw new Error(`${label} schema maximum must be a number`);
    }
    if (value > maximum) {
      throw new Error(`${label} must be less than or equal to ${maximum}`);
    }
  }
}

function asSchema(value: JsonValue, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object schema`);
  }
  return value;
}

function asSchemaMap(value: JsonValue, label: string): Record<string, JsonObject> {
  const record = asSchema(value, label);
  const schemas: Record<string, JsonObject> = {};
  for (const [key, schema] of Object.entries(record)) {
    schemas[key] = asSchema(schema, `${label}.${key}`);
  }
  return schemas;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertEnumValue<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): asserts value is Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function agentRegistrationMetadata<Input extends JsonObject, Output extends AgentOutputRecord>(
  definition: AgentDefinition<Input, Output>,
): AgentRegistrationMetadata {
  return {
    registryKind: "agent",
    agentName: definition.agentName,
    agentVersion: definition.agentVersion,
    taskKind: definition.taskKind,
    inputSchemaId: definition.inputSchema.schemaId,
    outputSchemaId: definition.outputSchema.schemaId,
    providerFamily: definition.provider.descriptor.family,
    providerName: definition.provider.descriptor.providerName,
    defaultModelId: definition.provider.descriptor.defaultModelId,
    promptPresetId: definition.prompt.presetId,
    promptTemplateVersion: definition.prompt.templateVersion,
    promptHash: definition.prompt.promptHash,
  };
}

function deterministicToolRegistrationMetadata<Input extends JsonObject, Output extends JsonObject>(
  definition: DeterministicToolDefinition<Input, Output>,
): DeterministicToolRegistrationMetadata {
  return {
    registryKind: "deterministic_tool",
    toolName: definition.toolName,
    toolVersion: definition.toolVersion,
    taskKind: definition.taskKind,
    capabilityKey: definition.capabilityKey,
    inputSchemaId: definition.inputSchema.schemaId,
    outputSchemaId: definition.outputSchema.schemaId,
    reproducibility: definition.reproducibility,
    implementationHashProvenance: "verified",
  };
}

function registryKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function createUuid7(date = new Date()): Uuid7 {
  const timestamp = BigInt(date.getTime());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
