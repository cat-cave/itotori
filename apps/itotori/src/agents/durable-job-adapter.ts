import { createHash } from "node:crypto";
import { jobTaskTypeValues } from "@itotori/db";
import type {
  AuthorizationActor,
  ItotoriProjectRepositoryPort,
  JobHandlerRegistry,
  JobQueueRecord,
  QueueJsonRecord,
} from "@itotori/db";
import type {
  CausalLinkV02,
  ProvenanceRecordV02,
  TriageEventV02,
  TriageSubjectRefV02,
  Uuid7,
} from "@itotori/localization-bridge-schema";
import type { JsonObject, JsonValue } from "../providers/types.js";
import type {
  AgentJobInput,
  AgentJobOutput,
  AgentName,
  AgentOutputRecord,
  DeterministicToolJobInput,
  DeterministicToolJobOutput,
  DeterministicToolName,
  RegistryInvocationContext,
} from "./registry.js";
import { AgentToolRuntime, stableStringify } from "./registry.js";

export type AgentToolDurableJobAdapterOptions = {
  verifyDeterministicTools?: boolean;
};

export type DurableAgentToolJobResult = QueueJsonRecord & {
  jobKind: "agent_job" | "deterministic_tool_job";
  output: JsonObject;
  metadata: QueueJsonRecord;
  event: TriageEventV02;
  persistedEvent: {
    projectId: string;
    localeBranchId: string | null;
    eventId: Uuid7;
  };
};

export class AgentToolDurableJobAdapter {
  constructor(
    private readonly runtime: AgentToolRuntime,
    private readonly projectRepository: ItotoriProjectRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly options: AgentToolDurableJobAdapterOptions = {},
  ) {}

  jobHandlers(): JobHandlerRegistry {
    return {
      byType: {
        [jobTaskTypeValues.agentTask]: (job) => this.handleJob(job),
        [jobTaskTypeValues.deterministicToolTask]: (job) => this.handleJob(job),
      },
    };
  }

  async handleJob(job: JobQueueRecord): Promise<DurableAgentToolJobResult> {
    if (job.jobType === jobTaskTypeValues.agentTask) {
      const result = durableRuntimeResult(
        job,
        await this.runtime.runAgentJob(durableAgentJobInput(job)),
      );
      await this.persistEvent(job, result.event);
      return durableJobResult(job, result);
    }

    if (job.jobType === jobTaskTypeValues.deterministicToolTask) {
      const runOptions =
        this.options.verifyDeterministicTools === undefined
          ? {}
          : { verifyReproducible: this.options.verifyDeterministicTools };
      const result = durableRuntimeResult(
        job,
        await this.runtime.runDeterministicToolJob(durableToolJobInput(job), runOptions),
      );
      await this.persistEvent(job, result.event);
      return durableJobResult(job, result);
    }

    throw new Error(`job ${job.jobId} has unsupported agent/tool job type ${job.jobType}`);
  }

  private async persistEvent(job: JobQueueRecord, event: TriageEventV02): Promise<void> {
    try {
      await this.projectRepository.appendEvent(this.actor, {
        projectId: job.projectId,
        ...(job.localeBranchId === null ? {} : { localeBranchId: job.localeBranchId }),
        event,
      });
    } catch (error) {
      if (isDuplicateEventInsert(error, event.eventId)) {
        return;
      }
      throw error;
    }
  }
}

type RuntimeJobOutput = AgentJobOutput<AgentOutputRecord> | DeterministicToolJobOutput<JsonObject>;

function durableRuntimeResult<Result extends RuntimeJobOutput>(
  job: JobQueueRecord,
  result: Result,
): Result {
  const identity = durableRuntimeIdentity(job, result);
  const eventId = deterministicDurableId(job, "itotori-durable-agent-tool-event-v1", identity);
  return {
    ...result,
    event: {
      ...result.event,
      eventId,
      provenance: durableProvenance(job, result, identity),
    },
    metadata: {
      ...result.metadata,
      emittedEventId: eventId,
    },
  } as Result;
}

type DurableRuntimeIdentity = {
  jobId: string;
  jobType: string;
  projectId: string;
  localeBranchId: string | null;
  eventKind: string;
  runtimeKind: "llm_agent" | "deterministic_tool";
  registryId: string;
};

function durableRuntimeIdentity(
  job: JobQueueRecord,
  result: RuntimeJobOutput,
): DurableRuntimeIdentity {
  const metadata = result.metadata;
  const registryId =
    metadata.runtimeKind === "llm_agent"
      ? `${metadata.agentName}@${metadata.agentVersion}`
      : `${metadata.toolName}@${metadata.toolVersion}`;
  return {
    jobId: job.jobId,
    jobType: job.jobType,
    projectId: job.projectId,
    localeBranchId: job.localeBranchId,
    eventKind: result.event.eventKind,
    runtimeKind: metadata.runtimeKind,
    registryId,
  };
}

function durableProvenance(
  job: JobQueueRecord,
  result: RuntimeJobOutput,
  identity: DurableRuntimeIdentity,
): ProvenanceRecordV02[] {
  return result.event.provenance.map((provenance, index) => {
    const provenanceIdentity = {
      ...identity,
      provenanceKind: provenance.provenanceKind,
      provenanceIndex: index,
    };
    const provenanceId = deterministicDurableId(
      job,
      "itotori-durable-agent-tool-provenance-v1",
      provenanceIdentity,
    );

    if (provenance.provenanceKind === "model_output") {
      return {
        ...provenance,
        provenanceId,
        modelOutputId: deterministicDurableId(
          job,
          "itotori-durable-agent-tool-model-output-v1",
          provenanceIdentity,
        ),
      };
    }

    if (provenance.provenanceKind === "deterministic_check") {
      return {
        ...provenance,
        provenanceId,
        checkId: deterministicDurableId(
          job,
          "itotori-durable-agent-tool-deterministic-check-v1",
          provenanceIdentity,
        ),
      };
    }

    return {
      ...provenance,
      provenanceId,
    };
  });
}

function deterministicDurableId(job: JobQueueRecord, idKind: string, identity: JsonObject): Uuid7 {
  return deterministicUuid7(job.createdAt, {
    idKind,
    ...identity,
  });
}

function deterministicUuid7(date: Date, seed: JsonObject): Uuid7 {
  const timestamp = BigInt(Math.max(0, date.getTime()));
  const digest = createHash("sha256").update(stableStringify(seed)).digest();
  const bytes = Buffer.alloc(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  digest.copy(bytes, 6, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const eventPrimaryKeyConstraint = "itotori_events_pkey";
const eventTableName = "itotori_events";

function isDuplicateEventInsert(error: unknown, expectedEventId: Uuid7): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record["code"] === "23505") {
      return isExpectedEventPrimaryKeyDuplicate(record, expectedEventId);
    }
    current = record["cause"];
  }

  return false;
}

function isExpectedEventPrimaryKeyDuplicate(
  record: Record<string, unknown>,
  expectedEventId: Uuid7,
): boolean {
  const constraint = optionalErrorString(record, "constraint", "constraintName", "constraint_name");
  if (constraint !== undefined) {
    if (constraint !== eventPrimaryKeyConstraint) {
      return false;
    }
    return duplicateMessageMatchesExpectedEventId(record, expectedEventId);
  }

  const table = optionalErrorString(record, "table", "tableName", "table_name");
  if (table !== undefined && table !== eventTableName) {
    return false;
  }

  const message = duplicateMessage(record);
  return (
    message !== undefined &&
    message.includes(expectedEventId) &&
    (message.includes(eventPrimaryKeyConstraint) ||
      message.includes("event_id") ||
      message.includes(eventTableName))
  );
}

function duplicateMessageMatchesExpectedEventId(
  record: Record<string, unknown>,
  expectedEventId: Uuid7,
): boolean {
  const detail = optionalErrorString(record, "detail");
  if (detail !== undefined) {
    return detail.includes(expectedEventId);
  }
  const message = optionalErrorString(record, "message");
  return message === undefined || !message.includes("Key (") || message.includes(expectedEventId);
}

function duplicateMessage(record: Record<string, unknown>): string | undefined {
  const detail = optionalErrorString(record, "detail");
  const message = optionalErrorString(record, "message");
  if (detail === undefined) {
    return message;
  }
  return message === undefined ? detail : `${message}\n${detail}`;
}

function optionalErrorString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function durableAgentJobInput(job: JobQueueRecord): AgentJobInput {
  if (job.jobType !== jobTaskTypeValues.agentTask) {
    throw new Error(`job ${job.jobId} must have jobType ${jobTaskTypeValues.agentTask}`);
  }
  const payload = asRecord(job.payload, `${job.jobId}.payload`);
  assertLiteral(payload["jobKind"], "agent_job", `${job.jobId}.payload.jobKind`);
  const agentName = registryName(
    payload["agentName"] ?? job.jobName,
    "agent.",
    `${job.jobId}.payload.agentName`,
  ) as AgentName;
  if (job.jobName !== agentName) {
    throw new Error(`${job.jobId}.jobName must match payload agentName ${agentName}`);
  }
  const input = asJsonObject(payload["input"], `${job.jobId}.payload.input`);
  return {
    jobKind: "agent_job",
    agentName,
    agentVersion: requiredString(payload["agentVersion"], `${job.jobId}.payload.agentVersion`),
    input,
    context: durableInvocationContext(job, payload),
  };
}

export function durableToolJobInput(job: JobQueueRecord): DeterministicToolJobInput {
  if (job.jobType !== jobTaskTypeValues.deterministicToolTask) {
    throw new Error(
      `job ${job.jobId} must have jobType ${jobTaskTypeValues.deterministicToolTask}`,
    );
  }
  const payload = asRecord(job.payload, `${job.jobId}.payload`);
  assertLiteral(payload["jobKind"], "deterministic_tool_job", `${job.jobId}.payload.jobKind`);
  const toolName = registryName(
    payload["toolName"] ?? job.jobName,
    "tool.",
    `${job.jobId}.payload.toolName`,
  ) as DeterministicToolName;
  if (job.jobName !== toolName) {
    throw new Error(`${job.jobId}.jobName must match payload toolName ${toolName}`);
  }
  const input = asJsonObject(payload["input"], `${job.jobId}.payload.input`);
  return {
    jobKind: "deterministic_tool_job",
    toolName,
    toolVersion: requiredString(payload["toolVersion"], `${job.jobId}.payload.toolVersion`),
    input,
    context: durableInvocationContext(job, payload),
  };
}

function durableJobResult(
  job: JobQueueRecord,
  result: AgentJobOutput<AgentOutputRecord> | DeterministicToolJobOutput<JsonObject>,
): DurableAgentToolJobResult {
  return {
    jobKind: result.jobKind,
    output: result.output,
    metadata: result.metadata as unknown as QueueJsonRecord,
    event: result.event,
    persistedEvent: {
      projectId: job.projectId,
      localeBranchId: job.localeBranchId,
      eventId: result.event.eventId,
    },
  };
}

function durableInvocationContext(
  job: JobQueueRecord,
  payload: Record<string, unknown>,
): RegistryInvocationContext {
  const context = optionalRecord(payload["context"], `${job.jobId}.payload.context`);
  const contextRecord = context ?? {};
  const taskId = requiredString(
    contextRecord["taskId"] ?? payload["taskId"],
    `${job.jobId}.payload.context.taskId`,
  ) as Uuid7;
  const subjectRefs = subjectRefsFromValue(
    contextRecord["subjectRefs"] ?? job.subjectRefs,
    `${job.jobId}.payload.context.subjectRefs`,
  );
  const causalLinks =
    contextRecord["causalLinks"] === undefined
      ? undefined
      : causalLinksFromValue(
          contextRecord["causalLinks"],
          `${job.jobId}.payload.context.causalLinks`,
        );
  const occurredAt = optionalString(
    contextRecord["occurredAt"] ?? payload["occurredAt"],
    `${job.jobId}.payload.context.occurredAt`,
  );
  return {
    taskId,
    subjectRefs,
    ...(causalLinks === undefined ? {} : { causalLinks }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function subjectRefsFromValue(value: unknown, label: string): TriageSubjectRefV02[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    const ref = asRecord(item, `${label}[${index}]`);
    const subject: TriageSubjectRefV02 = {
      subjectKind: requiredString(
        ref["subjectKind"],
        `${label}[${index}].subjectKind`,
      ) as TriageSubjectRefV02["subjectKind"],
      subjectId: requiredString(ref["subjectId"], `${label}[${index}].subjectId`) as Uuid7,
      ...(ref["label"] === undefined
        ? {}
        : { label: requiredString(ref["label"], `${label}[${index}].label`) }),
    };
    return subject;
  });
}

function causalLinksFromValue(value: unknown, label: string): CausalLinkV02[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => {
    const link = asRecord(item, `${label}[${index}]`);
    return {
      causalLinkId: requiredString(
        link["causalLinkId"],
        `${label}[${index}].causalLinkId`,
      ) as Uuid7,
      linkKind: requiredString(
        link["linkKind"],
        `${label}[${index}].linkKind`,
      ) as CausalLinkV02["linkKind"],
      targetKind: requiredString(
        link["targetKind"],
        `${label}[${index}].targetKind`,
      ) as CausalLinkV02["targetKind"],
      targetId: requiredString(link["targetId"], `${label}[${index}].targetId`) as Uuid7,
      ...(link["rationale"] === undefined
        ? {}
        : { rationale: requiredString(link["rationale"], `${label}[${index}].rationale`) }),
    };
  });
}

function registryName(value: unknown, prefix: "agent." | "tool.", label: string): string {
  const name = requiredString(value, label);
  if (!name.startsWith(prefix)) {
    throw new Error(`${label} must start with ${prefix}`);
  }
  return name;
}

function assertLiteral(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, label);
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asJsonObject(value: unknown, label: string): JsonObject {
  const record = asRecord(value, label);
  for (const [key, child] of Object.entries(record)) {
    assertJsonValue(child, `${label}.${key}`);
  }
  return record as JsonObject;
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
