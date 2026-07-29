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

import type { QueueJsonRecord } from "./repositories/event-queue-repository.js";

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

export function assertJobPayloadRecord(
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

export function assertDiscriminator(
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

export function requireNonEmptyString(value: unknown, field: string, jobName: string): string {
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

export function requireNonEmptyStringArray(
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

export function requireJsonObject(value: unknown, field: string, jobName: string): QueueJsonRecord {
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
