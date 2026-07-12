// ITOTORI-048 — typed job-name registry.
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
export const contextCorrectionRedraftJobName = "context-correction.redraft" as const;

export type ContextCorrectionRedraftJobName = typeof contextCorrectionRedraftJobName;

export const contextCorrectionRedraftPayloadSchemaVersion =
  "itotori.context-correction-redraft.v1" as const;

/**
 * A non-empty immutable array. Context corrections without an affected unit
 * are not enqueue-able: there is no redraft work to perform.
 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/**
 * Durable reference to one canonical context correction and the exact version
 * that caused it. The worker treats the version identifiers as provenance,
 * then reloads the fresh ContextPacket rather than trusting a serialized
 * packet in the job payload.
 */
export type ContextCorrectionRedraftPayload = {
  schemaVersion: typeof contextCorrectionRedraftPayloadSchemaVersion;
  correctionId: string;
  contextArtifactId: string;
  contextEntryVersionId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  affectedUnitIds: NonEmptyReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// Dynamic job-name families (registry-driven agent/tool jobs).
// ---------------------------------------------------------------------------

/**
 * The agent.<name> family: durable jobs dispatched to a registered LLM agent.
 * The db layer validates contract-level fields; the app runtime validates
 * agent-specific input/output against its registered schema.
 */
export type AgentJobPayload = {
  jobKind: "agent_job";
  agentName: `agent.${string}`;
  agentVersion: string;
  input: QueueJsonRecord;
};

/**
 * The tool.<name> / search.<name> family: durable jobs dispatched to a
 * registered deterministic tool. The db layer validates contract-level
 * fields; the app runtime validates the tool-specific contract.
 */
export type DeterministicToolJobPayload = {
  jobKind: "deterministic_tool_job";
  toolName: DeterministicToolName;
  toolVersion: string;
  input: QueueJsonRecord;
};

export type AgentJobName = `agent.${string}`;
export type ToolJobName = `tool.${string}`;
export type SearchJobName = `search.${string}`;
export type DeterministicToolName = ToolJobName | SearchJobName;

// ---------------------------------------------------------------------------
// The closed registered-name union + compile-time payload map.
// ---------------------------------------------------------------------------

/**
 * Every structural job name the registry owns. Extending this union without
 * extending JOB_DEFINITIONS is a compile-time error. Extending it with a
 * definition automatically makes the name enqueue-able via
 * buildRegisteredJobInput.
 */
export type RegisteredJobName = ContextCorrectionRedraftJobName;

/**
 * Template-literal family names: dynamically many (one per registered
 * agent/tool), but each must match a fixed prefix that binds it to a
 * JobTaskType and a payload validator.
 */
export type RegisteredJobFamilyName = AgentJobName | DeterministicToolName;

/**
 * The full set of names the registry accepts: every structural name plus
 * every family-pattern name. buildRegisteredJobInput and
 * RegisteredJobHandlerRegistry.register are type-gated on this union, so an
 * unregistered name is a compile-time error.
 */
export type AnyRegisteredJobName = RegisteredJobName | RegisteredJobFamilyName;

/**
 * Compile-time mapping from a registered job name to its typed payload.
 * Resolves to never for a name that is not in AnyRegisteredJobName, so
 * buildRegisteredJobInput rejects a wrong-typed payload and an unknown name.
 */
export type JobPayloadFor<N extends string> = N extends ContextCorrectionRedraftJobName
  ? ContextCorrectionRedraftPayload
  : N extends AgentJobName
    ? AgentJobPayload
    : N extends DeterministicToolName
      ? DeterministicToolJobPayload
      : never;

// ---------------------------------------------------------------------------
// Runtime validators (the test-time enforcement layer).
// ---------------------------------------------------------------------------

/**
 * Why a registered-job payload failed validation. Kept as a closed
 * discriminant so a caller can branch on wrong discriminator, missing field,
 * or wrong name binding.
 */
export const jobPayloadValidationReasons = {
  notRecord: "not_record",
  wrongDiscriminator: "wrong_discriminator",
  missingField: "missing_field",
  wrongNameBinding: "wrong_name_binding",
} as const;

export type JobPayloadValidationReason =
  (typeof jobPayloadValidationReasons)[keyof typeof jobPayloadValidationReasons];

export class JobPayloadValidationError extends Error {
  readonly jobName: string;
  readonly reason: JobPayloadValidationReason;
  readonly field: string | null;

  constructor(
    jobName: string,
    reason: JobPayloadValidationReason,
    message: string,
    field: string | null = null,
  ) {
    super(
      `job ${jobName} payload rejected (${reason}${field === null ? "" : `: ${field}`}): ${message}`,
    );
    this.name = "JobPayloadValidationError";
    this.jobName = jobName;
    this.reason = reason;
    this.field = field;
  }
}

/**
 * Asserts a context-correction redraft payload has the canonical version
 * provenance and at least one non-blank affected unit. The job name is bound
 * exactly so this payload cannot be used under another structural name.
 */
export function assertContextCorrectionRedraftPayload(
  payload: unknown,
  jobName: string,
): asserts payload is ContextCorrectionRedraftPayload {
  assertJobPayloadRecord(payload, jobName);
  const record = payload as Record<string, unknown>;

  if (jobName !== contextCorrectionRedraftJobName) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongNameBinding,
      `context-correction payload must use jobName ${contextCorrectionRedraftJobName}`,
      "jobName",
    );
  }
  if (record["schemaVersion"] !== contextCorrectionRedraftPayloadSchemaVersion) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongDiscriminator,
      `schemaVersion must be ${contextCorrectionRedraftPayloadSchemaVersion}`,
      "schemaVersion",
    );
  }

  requireNonEmptyString(record["correctionId"], "correctionId", jobName);
  requireNonEmptyString(record["contextArtifactId"], "contextArtifactId", jobName);
  requireNonEmptyString(record["contextEntryVersionId"], "contextEntryVersionId", jobName);
  requireNonEmptyString(record["projectId"], "projectId", jobName);
  requireNonEmptyString(record["localeBranchId"], "localeBranchId", jobName);
  requireNonEmptyString(record["sourceRevisionId"], "sourceRevisionId", jobName);
  requireNonEmptyStringArray(record["affectedUnitIds"], "affectedUnitIds", jobName);
}

/**
 * Asserts an AgentJobPayload whose agentName matches jobName exactly. The
 * durable-job adapter enforces the same contract at dispatch time; asserting
 * it at enqueue time catches a mismatch before persistence.
 */
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
export function isRegisteredJobName(jobName: string): boolean {
  return resolveRegisteredJobDefinition(jobName) !== undefined;
}

/**
 * Throws UnregisteredJobNameError for an unknown name; otherwise returns its
 * definition. The mandated path for enqueue-side resolution.
 */
export function requireRegisteredJobDefinition(jobName: string): RegisteredJobDefinition {
  const definition = resolveRegisteredJobDefinition(jobName);
  if (definition === undefined) {
    throw new UnregisteredJobNameError(jobName);
  }
  return definition;
}

/**
 * Structural RegisteredJobName literals in declaration order. Family names
 * are intentionally excluded because they are unbounded template literals.
 */
export const REGISTERED_JOB_NAMES = [
  contextCorrectionRedraftJobName,
] as const satisfies readonly RegisteredJobName[];

/**
 * Typed enqueue builder: name must extend AnyRegisteredJobName and payload
 * must extend JobPayloadFor<N>. Runtime validation runs before the job is
 * persisted and the registry, not the caller, stamps jobType.
 */
export function buildRegisteredJobInput<N extends AnyRegisteredJobName>(
  name: N,
  payload: JobPayloadFor<N>,
  base: RegisteredJobInputBase,
): JobQueueInput {
  const definition = requireRegisteredJobDefinition(name);
  definition.validatePayload(payload, name);
  return {
    ...base,
    jobName: name,
    jobType: definition.jobType,
    payload: payload as unknown as QueueJsonRecord,
  };
}

/**
 * Queueing context for buildRegisteredJobInput: everything on JobQueueInput
 * except jobName, jobType, and payload, which the registry owns.
 */
export type RegisteredJobInputBase = Omit<JobQueueInput, "jobName" | "jobType" | "payload">;

// ---------------------------------------------------------------------------
// Typed handler registry: exactly one handler per registered job name.
// ---------------------------------------------------------------------------

/**
 * A handler for a registered job. It receives the full JobQueueRecord; a
 * handler can use its matching assert*Payload function before accessing its
 * payload.
 */
export type RegisteredJobHandler = (job: JobQueueRecord) => Promise<QueueJsonRecord | void>;

/**
 * Typed handler registry: binds exactly one RegisteredJobHandler per
 * registered job name and dispatches by jobName. The registry is name-scoped;
 * type-based fallback for agent/tool jobs remains on the existing byType map.
 */
export class RegisteredJobHandlerRegistry {
  private readonly handlers = new Map<string, RegisteredJobHandler>();

  /**
   * Binds handler to name. Rejects an unregistered name and a second binding
   * for the same name.
   */
  register<N extends AnyRegisteredJobName>(name: N, handler: RegisteredJobHandler): void {
    requireRegisteredJobDefinition(name);
    if (this.handlers.has(name)) {
      throw new DuplicateJobHandlerError(name);
    }
    this.handlers.set(name, handler);
  }

  /** Returns the handler bound to job.jobName, or throws if none is bound. */
  handlerFor(job: JobQueueRecord): RegisteredJobHandler {
    const handler = this.handlers.get(job.jobName);
    if (handler === undefined) {
      throw new UnregisteredJobHandlerError(job.jobName, job.jobId);
    }
    return handler;
  }

  /** True when a handler is bound for jobName. */
  hasHandlerFor(jobName: string): boolean {
    return this.handlers.has(jobName);
  }

  /** The names with a bound handler, in insertion order. */
  boundJobNames(): readonly string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Projects this registry into the loose byName shape consumed by
   * ItotoriJobWorkerService, so it can be merged with the byType fallback.
   */
  toJobHandlerByNameMap(): Record<string, RegisteredJobHandler> {
    return Object.fromEntries(this.handlers);
  }
}

// ---------------------------------------------------------------------------
// Validator helpers (private to this module).
// ---------------------------------------------------------------------------

function assertJobPayloadRecord(
  payload: unknown,
  jobName: string,
): asserts payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.notRecord,
      "payload must be a JSON object",
    );
  }
}

function assertDiscriminator(
  record: Record<string, unknown>,
  expected: "agent_job" | "deterministic_tool_job",
  jobName: string,
): void {
  if (record["jobKind"] !== expected) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.wrongDiscriminator,
      `payload.jobKind must be ${expected}`,
      "jobKind",
    );
  }
}

function requireNonEmptyString(value: unknown, field: string, jobName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `${field} must be a non-empty string`,
      field,
    );
  }
  return value;
}

function requireNonEmptyStringArray(
  value: unknown,
  field: string,
  jobName: string,
): NonEmptyReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `${field} must be a non-empty array of non-empty strings`,
      field,
    );
  }
  return value as unknown as NonEmptyReadonlyArray<string>;
}

function requireJsonObject(value: unknown, field: string, jobName: string): QueueJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `${field} must be a JSON object`,
      field,
    );
  }
  return value as QueueJsonRecord;
}

// ---------------------------------------------------------------------------
// Compile-time self-checks (tsc-enforced on every build).
//
// These exported constants assert the registry's type-level contract:
// unregistered names are excluded; the structural context-correction job and
// each dynamic family are included; JobPayloadFor maps to the correct payload;
// and a wrong-shaped payload is rejected.
// ---------------------------------------------------------------------------

/** Asserts bogus.thing is rejected by the registered-name union. */
export const COMPILE_TIME_UNREGISTERED_NAME_REJECTED: "bogus.thing" extends AnyRegisteredJobName
  ? never
  : true = true;

/** Asserts the context-correction redraft name is a registered structural name. */
export const COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_NAME_REGISTERED: typeof contextCorrectionRedraftJobName extends AnyRegisteredJobName
  ? true
  : never = true;

/** Asserts the agent/tool/search family patterns are registered names. */
export const COMPILE_TIME_FAMILY_NAMES_REGISTERED:
  | `agent.${string}`
  | `tool.${string}`
  | `search.${string}` extends AnyRegisteredJobName
  ? true
  : never = true;

/** Asserts JobPayloadFor for the structural name is ContextCorrectionRedraftPayload. */
export const COMPILE_TIME_CONTEXT_CORRECTION_REDRAFT_PAYLOAD_TYPE: [
  JobPayloadFor<typeof contextCorrectionRedraftJobName>,
] extends [ContextCorrectionRedraftPayload]
  ? [ContextCorrectionRedraftPayload] extends [
      JobPayloadFor<typeof contextCorrectionRedraftJobName>,
    ]
    ? true
    : never
  : never = true;

/** Asserts JobPayloadFor for an agent name is AgentJobPayload. */
export const COMPILE_TIME_AGENT_PAYLOAD_TYPE: [
  JobPayloadFor<"agent.translation-quality-judge">,
] extends [AgentJobPayload]
  ? [AgentJobPayload] extends [JobPayloadFor<"agent.translation-quality-judge">]
    ? true
    : never
  : never = true;

/** Asserts a wrong-shaped object is not assignable to the structural payload. */
export const COMPILE_TIME_WRONG_CONTEXT_CORRECTION_PAYLOAD_REJECTED: {
  wrong: string;
} extends JobPayloadFor<typeof contextCorrectionRedraftJobName>
  ? never
  : true = true;

/** Asserts the structural payload is not assignable to the agent payload. */
export const COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED: ContextCorrectionRedraftPayload extends JobPayloadFor<"agent.translation-quality-judge">
  ? never
  : true = true;
