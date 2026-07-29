// Typed job-name registry.
//
// Single source of truth mapping every persisted durable-job name to its
// typed payload schema and exactly one intended handler. The queue layer
// historically carried jobName: string and payload: Record<string, unknown>
// on JobQueueInput, so a renamed job, a drifted payload, or an orphaned
// handler could only be caught at runtime. This module closes that hole three
// ways:
//
//   1. A closed RegisteredJobName union for the structural
//      context-correction redraft job, plus template-literal family names
//      (agent.* / tool.* / search.*) for registry-driven agent/tool jobs.
//      Enqueueing through buildRegisteredJobInput is type-gated on that
//      union, so an unregistered name is a compile-time error.
//   2. A JOB_DEFINITIONS table typed as Record<RegisteredJobName,
//      RegisteredJobDefinition>, so adding a structural name without a
//      definition (or a payload validator) is a compile-time error.
//   3. A runtime RegisteredJobHandlerRegistry that refuses to bind a handler
//      for an unregistered name and refuses a second binding for a name that
//      already has one — exactly one handler per persisted job name.
//
// The context-correction redraft contract lives in the db package because the
// durable queue must keep its name, payload, and handler binding from
// drifting. The app consumes these exports when it persists a canonical
// context version, invalidates affected artifacts, and queues a real redraft.

import type {
  JobQueueInput,
  JobQueueRecord,
  QueueJsonRecord,
} from "./repositories/event-queue-repository.js";
import type { JobTaskType } from "./schema.js";
import { jobTaskTypeValues } from "./schema.js";

// ---------------------------------------------------------------------------
// Context-correction redraft payload + structural job name.
// ---------------------------------------------------------------------------

/**
 * The only structural refinement job owned by this registry. Its registered
 * handler reloads the current ContextPacket before redrafting every affected
 * unit; it is not a staged fan-out chain.
 */
import {
  type AgentJobPayload,
  assertDiscriminator,
  assertJobPayloadRecord,
  assertContextCorrectionRedraftPayload,
  contextCorrectionRedraftJobName,
  type DeterministicToolJobPayload,
  JobPayloadValidationError,
  jobPayloadValidationReasons,
  requireJsonObject,
  requireNonEmptyString,
  type RegisteredJobName,
} from "./job-registry-01.js";

export function assertAgentJobPayload(
  payload: unknown,
  jobName: string,
): asserts payload is AgentJobPayload {
  assertJobPayloadRecord(payload, jobName);
  const record = payload as Record<string, unknown>;
  assertDiscriminator(record, "agent_job", jobName);
  const agentName = requireNonEmptyString(record["agentName"], "agentName", jobName);
  if (agentName !== jobName) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongNameBinding,
      `payload.agentName ${agentName} must match jobName ${jobName}`,
      "agentName",
    );
  }
  if (!agentName.startsWith("agent.")) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongNameBinding,
      'agentName must start with "agent."',
      "agentName",
    );
  }
  requireNonEmptyString(record["agentVersion"], "agentVersion", jobName);
  requireJsonObject(record["input"], "input", jobName);
}

/**
 * Asserts a DeterministicToolJobPayload whose toolName matches jobName
 * exactly. Covers both tool.* and search.* names.
 */
export function assertDeterministicToolJobPayload(
  payload: unknown,
  jobName: string,
): asserts payload is DeterministicToolJobPayload {
  assertJobPayloadRecord(payload, jobName);
  const record = payload as Record<string, unknown>;
  assertDiscriminator(record, "deterministic_tool_job", jobName);
  const toolName = requireNonEmptyString(record["toolName"], "toolName", jobName);
  if (toolName !== jobName) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongNameBinding,
      `payload.toolName ${toolName} must match jobName ${jobName}`,
      "toolName",
    );
  }
  if (!toolName.startsWith("tool.") && !toolName.startsWith("search.")) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongNameBinding,
      'toolName must start with "tool." or "search."',
      "toolName",
    );
  }
  requireNonEmptyString(record["toolVersion"], "toolVersion", jobName);
  requireJsonObject(record["input"], "input", jobName);
}

// ---------------------------------------------------------------------------
// The static definition table (compile-time gate: union ↔ table parity).
// ---------------------------------------------------------------------------

/**
 * A registered job name's binding: the JobTaskType stamped on
 * itotori_jobs.job_type and the runtime payload validator that enforces the
 * typed payload contract.
 */
export type RegisteredJobDefinition = {
  readonly jobType: JobTaskType;
  readonly validatePayload: (payload: unknown, jobName: string) => void;
};

/**
 * The single mapping from structural names to their job type and payload
 * validator. The context-correction redraft is a rerun task because the
 * worker reloads context and redrafts existing affected units.
 */
export const JOB_DEFINITIONS = {
  [contextCorrectionRedraftJobName]: {
    jobType: jobTaskTypeValues.rerun,
    validatePayload: assertContextCorrectionRedraftPayload,
  },
} as const satisfies Record<RegisteredJobName, RegisteredJobDefinition>;

/**
 * Fixed job-name family prefixes. A persisted name matching neither a
 * structural RegisteredJobName nor a family prefix is rejected by
 * resolveRegisteredJobDefinition.
 */
export const JOB_NAME_FAMILIES = [
  {
    namePrefix: "agent.",
    jobType: jobTaskTypeValues.agentTask,
    validatePayload: assertAgentJobPayload,
  },
  {
    namePrefix: "tool.",
    jobType: jobTaskTypeValues.deterministicToolTask,
    validatePayload: assertDeterministicToolJobPayload,
  },
  {
    namePrefix: "search.",
    jobType: jobTaskTypeValues.deterministicToolTask,
    validatePayload: assertDeterministicToolJobPayload,
  },
] as const satisfies ReadonlyArray<RegisteredJobFamilyDefinition>;

export type RegisteredJobFamilyDefinition = {
  readonly namePrefix: string;
  readonly jobType: JobTaskType;
  readonly validatePayload: (payload: unknown, jobName: string) => void;
};

// ---------------------------------------------------------------------------
// Errors raised when a name is not registered or a handler is missing.
// ---------------------------------------------------------------------------

export class UnregisteredJobNameError extends Error {
  readonly jobName: string;

  constructor(jobName: string) {
    super(
      "job name " +
        jobName +
        " is not registered: add it to JOB_DEFINITIONS (structural) or a JOB_NAME_FAMILIES prefix",
    );
    this.name = "UnregisteredJobNameError";
    this.jobName = jobName;
  }
}

export class DuplicateJobHandlerError extends Error {
  readonly jobName: string;

  constructor(jobName: string) {
    super(
      `a handler is already registered for job ${jobName} (exactly one handler per persisted job name)`,
    );
    this.name = "DuplicateJobHandlerError";
    this.jobName = jobName;
  }
}

export class UnregisteredJobHandlerError extends Error {
  readonly jobName: string;
  readonly jobId: string;

  constructor(jobName: string, jobId: string) {
    super(`no handler registered for job ${jobName} (jobId ${jobId})`);
    this.name = "UnregisteredJobHandlerError";
    this.jobName = jobName;
    this.jobId = jobId;
  }
}

// ---------------------------------------------------------------------------
// Name resolution + typed enqueue builder.
// ---------------------------------------------------------------------------

/**
 * Resolves a persisted job name to its registered definition (structural
 * name first, then family prefix). Returns undefined for an unknown name so
 * callers can branch; requireRegisteredJobDefinition throws when a name is
 * mandatory.
 */
export function resolveRegisteredJobDefinition(
  jobName: string,
): RegisteredJobDefinition | undefined {
  const structural = JOB_DEFINITIONS[jobName as RegisteredJobName];
  if (structural !== undefined) {
    return structural;
  }
  for (const family of JOB_NAME_FAMILIES) {
    if (jobName.startsWith(family.namePrefix)) {
      return { jobType: family.jobType, validatePayload: family.validatePayload };
    }
  }
  return undefined;
}

/**
 * Type guard: is jobName one the registry accepts (structural name or
 * family-prefix member)? Use this to gate raw enqueue paths receiving a
 * string so an unregistered name is rejected before persistence.
 */
