// ITOTORI-048 — typed job-name registry.
//
// Single source of truth mapping every persisted durable-job name to its
// typed payload schema and exactly one intended handler. The queue layer
// historically carried `jobName: string` and `payload: Record<string,
// unknown>` on {@link JobQueueInput}, so a renamed job, a drifted payload,
// or an orphaned handler could only be caught at runtime (often in
// production). This module closes that hole three ways:
//
//   1. A closed `RegisteredJobName` union of the structural job names the
//      db package owns (the reviewer-triggered rerun stages) plus
//      template-literal family names (`agent.*` / `tool.*` / `search.*`)
//      for the registry-driven agent/tool jobs. Enqueueing through
//      {@link buildRegisteredJobInput} is type-gated on that union, so an
//      unregistered name is a compile-time error.
//   2. A `JOB_DEFINITIONS` table typed `satisfies Record<RegisteredJobName,
//      RegisteredJobDefinition>` so adding a name to the union without a
//      definition (or a payload validator) is a compile-time error.
//   3. A runtime {@link RegisteredJobHandlerRegistry} that refuses to bind
//      a handler for a name that is not registered and refuses a second
//      binding for a name that already has one — exactly one handler per
//      persisted job name.
//
// The reviewer-triggered rerun payload + name constants live here (moved
// from apps/itotori/src/reviewer/repair-rerun-scheduler.ts) because they
// are game-agnostic and because the registry must own the payload contract
// to keep name ↔ payload ↔ handler from drifting. The app re-exports them
// from @itotori/db so existing imports keep resolving.

import type {
  JobQueueInput,
  JobQueueRecord,
  QueueJsonRecord,
} from "./repositories/event-queue-repository.js";
import type { JobTaskType } from "./schema.js";
import {
  jobTaskTypeValues,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Reviewer-triggered rerun payload + name constants (moved from the app).
// ---------------------------------------------------------------------------

export const reviewerTriggeredRerunPayloadSchemaVersion =
  "itotori.reviewer_triggered_rerun.v1" as const;

export const reviewerTriggeredRerunStageValues = {
  draftRepair: "draft-repair",
  qaReplay: "qa-replay",
  exportRegeneration: "export-regeneration",
  runtimeValidation: "runtime-validation",
} as const;

export type ReviewerTriggeredRerunStage =
  (typeof reviewerTriggeredRerunStageValues)[keyof typeof reviewerTriggeredRerunStageValues];

/**
 * Closed union of the structural reviewer-triggered rerun job names. Each
 * name is `rerun.<stage>` and is the SINGLE source of truth for both the
 * persisted `job_name` column and the {@link ReviewerTriggeredRerunPayload}
 * `stage` discriminator. Adding a stage without adding a name here (and a
 * {@link JOB_DEFINITIONS} entry) is a compile-time error.
 */
export const reviewerTriggeredRerunJobNameValues = {
  draftRepair: "rerun.draft-repair",
  qaReplay: "rerun.qa-replay",
  exportRegeneration: "rerun.export-regeneration",
  runtimeValidation: "rerun.runtime-validation",
} as const;

export type ReviewerTriggeredRerunJobName =
  (typeof reviewerTriggeredRerunJobNameValues)[keyof typeof reviewerTriggeredRerunJobNameValues];

export const reviewerTriggeredRerunReasonCodeValues = {
  reviewerRequestRepair: "reviewer_request_repair",
  reviewerGlossaryUpdate: "reviewer_glossary_update",
  reviewerStyleUpdate: "reviewer_style_update",
  reviewerRuntimeFeedbackImport: "reviewer_runtime_feedback_import",
  glossaryInvalidated: "glossary_invalidated",
  policyInvalidated: "policy_invalidated",
  runtimeFeedbackRerun: "runtime_feedback_rerun",
  reviewerCorrectionWriteback: "reviewer_correction_writeback",
  translationMemoryInvalidated: "translation_memory_invalidated",
} as const;

export type ReviewerTriggeredRerunReasonCode =
  (typeof reviewerTriggeredRerunReasonCodeValues)[keyof typeof reviewerTriggeredRerunReasonCodeValues];

export type ReviewerTriggeredRerunPolicyVersions = {
  styleGuideVersionId: string | null;
  glossaryVersionId: string | null;
  pairPolicyVersionId: string | null;
  qaPolicyVersionId: string | null;
  exportPolicyVersionId: string | null;
  runtimeValidationPolicyVersionId: string | null;
};

export type ReviewerTriggeredRerunPayload = {
  schemaVersion: typeof reviewerTriggeredRerunPayloadSchemaVersion;
  stage: ReviewerTriggeredRerunStage;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  affectedUnitIds: readonly string[];
  artifactIds: readonly string[];
  policyVersions: ReviewerTriggeredRerunPolicyVersions;
  reasonCodes: readonly ReviewerTriggeredRerunReasonCode[];
  reviewItemId: string;
  transitionId: string;
  reviewerAction: (typeof reviewerQueueActionValues)[keyof typeof reviewerQueueActionValues];
  itemKind: (typeof reviewerQueueItemKindValues)[keyof typeof reviewerQueueItemKindValues];
  sourceItemRef: string;
  repairHint?: string;
  termId?: string;
  approvedTranslation?: string;
  ruleLabel?: string;
  runtimeEvidenceTier?: string;
  observationEventIds?: string[];
  artifactHashes?: string[];
};

// ---------------------------------------------------------------------------
// Dynamic job-name families (registry-driven agent/tool jobs).
// ---------------------------------------------------------------------------

/**
 * The `agent.<name>` family: durable jobs dispatched to a registered LLM
 * agent. The db layer validates the contract-level fields (`jobKind`,
 * `agentName` prefix + match to `jobName`, `agentVersion`, `input`); the
 * app's `AgentToolRuntime` validates the agent-specific input/output
 * against the registered schema. This is the minimal payload shape the
 * queue layer can assert without coupling to the app-layer agent registry.
 */
export type AgentJobPayload = {
  jobKind: "agent_job";
  agentName: `agent.${string}`;
  agentVersion: string;
  input: QueueJsonRecord;
};

/**
 * The `tool.<name>` / `search.<name>` family: durable jobs dispatched to a
 * registered deterministic tool. The db layer validates the contract-level
 * fields (`jobKind`, `toolName` prefix + match to `jobName`,
 * `toolVersion`, `input`); the app's `AgentToolRuntime` validates the
 * tool-specific input/output against the registered schema + reproducibility
 * spec.
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
 * Every structural job name the registry owns. Extending this union
 * without extending {@link JOB_DEFINITIONS} is a compile-time error (the
 * `satisfies Record<RegisteredJobName, RegisteredJobDefinition>` check
 * fails). Extending it WITH a definition automatically makes the name
 * enqueue-able via {@link buildRegisteredJobInput}.
 */
export type RegisteredJobName = ReviewerTriggeredRerunJobName;

/**
 * Template-literal family names: dynamically many (one per registered
 * agent/tool), but each must match a fixed prefix that binds it to a
 * {@link JobTaskType} and a payload validator.
 */
export type RegisteredJobFamilyName = AgentJobName | DeterministicToolName;

/**
 * The full set of names the registry accepts: every structural name plus
 * every family-pattern name. {@link buildRegisteredJobInput} and
 * {@link RegisteredJobHandlerRegistry.register} are type-gated on this
 * union, so an unregistered name is a compile-time error.
 */
export type AnyRegisteredJobName = RegisteredJobName | RegisteredJobFamilyName;

/**
 * Compile-time mapping from a registered job name to its typed payload.
 * Resolves to `never` for a name that is not in {@link AnyRegisteredJobName},
 * so {@link buildRegisteredJobInput}`<N>(name, payload)` rejects a
 * wrong-typed payload at compile time and rejects an unknown name entirely
 * (the `never` payload makes any argument a type error).
 */
export type JobPayloadFor<N extends string> = N extends RegisteredJobName
  ? ReviewerTriggeredRerunPayload
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
 * discriminant so a caller can branch on the kind of mismatch
 * (wrong discriminator vs missing field vs wrong name binding).
 */
export const jobPayloadValidationReasons = {
  notRecord: "not_record",
  wrongDiscriminator: "wrong_discriminator",
  missingField: "missing_field",
  wrongNameBinding: "wrong_name_binding",
  wrongStage: "wrong_stage",
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
 * Asserts `payload` is a {@link ReviewerTriggeredRerunPayload} AND that its
 * `stage` matches the `rerun.<stage>` suffix of `jobName`. The stage↔name
 * binding is the single most important invariant for the rerun chain (the
 * scheduler fans one context out into four stage-ordered jobs), so a
 * payload whose `stage` disagrees with its `jobName` is rejected as a
 * `wrong_stage` mismatch rather than enqueued and discovered later.
 */
export function assertReviewerTriggeredRerunPayload(
  payload: unknown,
  jobName: string,
): asserts payload is ReviewerTriggeredRerunPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.notRecord,
      "payload must be a JSON object",
    );
  }
  const record = payload as Record<string, unknown>;
  const reject = (
    field: string,
    message: string,
    reason: JobPayloadValidationReason = jobPayloadValidationReasons.missingField,
  ): void => {
    throw new JobPayloadValidationError(jobName, reason, message, field);
  };

  if (record["schemaVersion"] !== reviewerTriggeredRerunPayloadSchemaVersion) {
    reject(
      "schemaVersion",
      `expected ${reviewerTriggeredRerunPayloadSchemaVersion}`,
      jobPayloadValidationReasons.wrongDiscriminator,
    );
  }
  const stage = record["stage"];
  if (!isReviewerTriggeredRerunStage(stage)) {
    reject(
      "stage",
      "not a valid reviewer-triggered rerun stage",
      jobPayloadValidationReasons.wrongStage,
    );
  }
  const expectedJobName = `rerun.${stage}`;
  if (jobName !== expectedJobName) {
    reject(
      "stage",
      `stage ${stage} implies jobName ${expectedJobName} but got ${jobName}`,
      jobPayloadValidationReasons.wrongStage,
    );
  }

  requireNonEmptyString(record["projectId"], "projectId", jobName);
  requireNonEmptyString(record["localeBranchId"], "localeBranchId", jobName);
  requireNonEmptyString(record["sourceRevisionId"], "sourceRevisionId", jobName);
  requireNonEmptyString(record["reviewItemId"], "reviewItemId", jobName);
  requireNonEmptyString(record["transitionId"], "transitionId", jobName);
  requireNonEmptyString(record["sourceItemRef"], "sourceItemRef", jobName);

  if (!isReviewerQueueAction(record["reviewerAction"])) {
    reject(
      "reviewerAction",
      "not a valid reviewer queue action",
      jobPayloadValidationReasons.wrongDiscriminator,
    );
  }
  if (!isReviewerQueueItemKind(record["itemKind"])) {
    reject(
      "itemKind",
      "not a valid reviewer queue item kind",
      jobPayloadValidationReasons.wrongDiscriminator,
    );
  }

  requireStringArray(record["affectedUnitIds"], "affectedUnitIds", jobName);
  requireStringArray(record["artifactIds"], "artifactIds", jobName);
  requireStringArray(record["reasonCodes"], "reasonCodes", jobName);
  assertReviewerTriggeredRerunReasonCodes(record["reasonCodes"], jobName);

  const policyVersions = record["policyVersions"];
  if (
    typeof policyVersions !== "object" ||
    policyVersions === null ||
    Array.isArray(policyVersions)
  ) {
    reject("policyVersions", "must be a JSON object");
  } else {
    const policyRecord = policyVersions as Record<string, unknown>;
    assertPolicyVersionField(policyRecord, "styleGuideVersionId", jobName);
    assertPolicyVersionField(policyRecord, "glossaryVersionId", jobName);
    assertPolicyVersionField(policyRecord, "pairPolicyVersionId", jobName);
    assertPolicyVersionField(policyRecord, "qaPolicyVersionId", jobName);
    assertPolicyVersionField(policyRecord, "exportPolicyVersionId", jobName);
    assertPolicyVersionField(policyRecord, "runtimeValidationPolicyVersionId", jobName);
  }

  assertOptionalString(record["repairHint"], "repairHint", jobName);
  assertOptionalString(record["termId"], "termId", jobName);
  assertOptionalString(record["approvedTranslation"], "approvedTranslation", jobName);
  assertOptionalString(record["ruleLabel"], "ruleLabel", jobName);
  assertOptionalString(record["runtimeEvidenceTier"], "runtimeEvidenceTier", jobName);
  assertOptionalStringArray(record["observationEventIds"], "observationEventIds", jobName);
  assertOptionalStringArray(record["artifactHashes"], "artifactHashes", jobName);
}

/**
 * Asserts `payload` is an {@link AgentJobPayload} whose `agentName` matches
 * `jobName` exactly (the durable-job adapter enforces this contract at
 * dispatch time; asserting it at enqueue time catches a mismatch before
 * the job is persisted).
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
      `agentName must start with "agent."`,
      "agentName",
    );
  }
  requireNonEmptyString(record["agentVersion"], "agentVersion", jobName);
  requireJsonObject(record["input"], "input", jobName);
}

/**
 * Asserts `payload` is a {@link DeterministicToolJobPayload} whose
 * `toolName` matches `jobName` exactly. Covers both `tool.*` and
 * `search.*` names.
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
      `toolName must start with "tool." or "search."`,
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
 * A registered job name's binding: the {@link JobTaskType} that must be
 * stamped on the `itotori_jobs.job_type` column and the runtime payload
 * validator that enforces the typed payload contract.
 */
export type RegisteredJobDefinition = {
  readonly jobType: JobTaskType;
  readonly validatePayload: (payload: unknown, jobName: string) => void;
};

/**
 * The single source mapping each structural {@link RegisteredJobName} to
 * its `jobType` + payload validator. Typed
 * `satisfies Record<RegisteredJobName, RegisteredJobDefinition>` so:
 *
 *   - adding a name to {@link reviewerTriggeredRerunJobNameValues} (and
 *     thus to {@link RegisteredJobName}) without an entry here is a
 *     compile-time error;
 *   - each entry's `jobType` is a known {@link JobTaskType}.
 *
 * Extra entries (a key not in the union) are caught by the
 * `job-registry.test.ts` key-parity assertion rather than by `satisfies`
 * (which permits surplus keys), giving the test-time half of the gate.
 */
export const JOB_DEFINITIONS = {
  [reviewerTriggeredRerunJobNameValues.draftRepair]: {
    jobType: jobTaskTypeValues.rerun,
    validatePayload: assertReviewerTriggeredRerunPayload,
  },
  [reviewerTriggeredRerunJobNameValues.qaReplay]: {
    jobType: jobTaskTypeValues.rerun,
    validatePayload: assertReviewerTriggeredRerunPayload,
  },
  [reviewerTriggeredRerunJobNameValues.exportRegeneration]: {
    jobType: jobTaskTypeValues.rerun,
    validatePayload: assertReviewerTriggeredRerunPayload,
  },
  [reviewerTriggeredRerunJobNameValues.runtimeValidation]: {
    jobType: jobTaskTypeValues.rerun,
    validatePayload: assertReviewerTriggeredRerunPayload,
  },
} as const satisfies Record<RegisteredJobName, RegisteredJobDefinition>;

/**
 * The fixed job-name family prefixes: each prefix binds a
 * template-literal family of names to a {@link JobTaskType} + payload
 * validator. A persisted job name that matches neither a structural
 * {@link RegisteredJobName} nor a family prefix is rejected by
 * {@link resolveRegisteredJobName}.
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
      `job name ${jobName} is not registered: add it to JOB_DEFINITIONS (structural) or a JOB_NAME_FAMILIES prefix`,
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
 * name first, then family prefix). Returns `undefined` for an unknown name
 * so callers can branch; throws via {@link requireRegisteredJobDefinition}
 * when a name is mandatory.
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
 * Type guard: is `jobName` one the registry accepts (structural name or
 * family-prefix member)? Use this to gate raw enqueue paths that receive a
 * `string` so an unregistered name is rejected before it is persisted.
 */
export function isRegisteredJobName(jobName: string): boolean {
  return resolveRegisteredJobDefinition(jobName) !== undefined;
}

/**
 * Throws {@link UnregisteredJobNameError} for an unknown name; otherwise
 * returns its definition. The mandated path for enqueue-side resolution.
 */
export function requireRegisteredJobDefinition(jobName: string): RegisteredJobDefinition {
  const definition = resolveRegisteredJobDefinition(jobName);
  if (definition === undefined) {
    throw new UnregisteredJobNameError(jobName);
  }
  return definition;
}

/**
 * The structural {@link RegisteredJobName} literals in declaration order,
 * for the key-parity test and any consumer that needs to enumerate the
 * closed set. Family names are intentionally excluded (they are
 * unbounded template literals).
 */
export const REGISTERED_JOB_NAMES: readonly RegisteredJobName[] = Object.values(
  reviewerTriggeredRerunJobNameValues,
);

/**
 * Typed enqueue builder: the sanctioned way to construct a
 * {@link JobQueueInput} for a registered job name. Compile-time: `name`
 * must extend {@link AnyRegisteredJobName} and `payload` must extend
 * {@link JobPayloadFor}`<N>`, so an unregistered name or a wrong-typed
 * payload is a type error. Runtime: the registered payload validator runs
 * and the `jobType` is stamped from the registry (the caller cannot lie
 * about it). `base` supplies the queueing context (project, idempotency,
 * dependencies, etc.) and may NOT set `jobName` / `jobType` / `payload`
 * (those are owned by the registry).
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
 * The queueing context for {@link buildRegisteredJobInput}: everything on
 * {@link JobQueueInput} EXCEPT `jobName` / `jobType` / `payload`, which the
 * registry owns. `idempotency` and `projectId` remain required (a job
 * without them is not persistable).
 */
export type RegisteredJobInputBase = Omit<JobQueueInput, "jobName" | "jobType" | "payload">;

// ---------------------------------------------------------------------------
// Typed handler registry: exactly one handler per registered job name.
// ---------------------------------------------------------------------------

/**
 * A handler for a registered job. Receives the full {@link JobQueueRecord};
 * the payload has already been validated at enqueue time, so a handler can
 * narrow it via the matching `assert*Payload` if it needs typed access.
 */
export type RegisteredJobHandler = (job: JobQueueRecord) => Promise<QueueJsonRecord | void>;

/**
 * Typed handler registry: binds exactly one {@link RegisteredJobHandler}
 * per registered job name and dispatches by `jobName`. This is the
 * type-safe replacement for the loose
 * `JobHandlerRegistry['byName']: Record<string, JobHandler>` map:
 *
 *   - {@link register} refuses a name that is not registered
 *     ({@link UnregisteredJobNameError}) — "a handler cannot be added
 *     without registering it";
 *   - {@link register} refuses a second binding for a name that already
 *     has one ({@link DuplicateJobHandlerError}) — "exactly one intended
 *     handler";
 *   - {@link handlerFor} throws {@link UnregisteredJobHandlerError} for a
 *     claimed job whose name has no handler — closing the "orphaned job"
 *     hole at dispatch time.
 *
 * The registry is name-scoped only; type-based fallback (used by the
 * agent/tool adapter for `agent.*` / `tool.*` jobs) stays on the existing
 * {@link JobHandlerRegistry} `byType` map. Use {@link toJobHandlerRegistry}
 * to merge the two for `ItotoriJobWorkerService`.
 */
export class RegisteredJobHandlerRegistry {
  private readonly handlers = new Map<string, RegisteredJobHandler>();

  /**
   * Binds `handler` to `name`. Throws {@link UnregisteredJobNameError} if
   * `name` is not a registered job name (structural or family), and
   * {@link DuplicateJobHandlerError} if `name` already has a handler.
   */
  register<N extends AnyRegisteredJobName>(name: N, handler: RegisteredJobHandler): void {
    requireRegisteredJobDefinition(name);
    if (this.handlers.has(name)) {
      throw new DuplicateJobHandlerError(name);
    }
    this.handlers.set(name, handler);
  }

  /** Returns the handler bound to `job.jobName`, or throws if none is bound. */
  handlerFor(job: JobQueueRecord): RegisteredJobHandler {
    const handler = this.handlers.get(job.jobName);
    if (handler === undefined) {
      throw new UnregisteredJobHandlerError(job.jobName, job.jobId);
    }
    return handler;
  }

  /** True when a handler is bound for `jobName`. */
  hasHandlerFor(jobName: string): boolean {
    return this.handlers.has(jobName);
  }

  /** The set of names with a bound handler, in insertion order. */
  boundJobNames(): readonly string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Projects this registry into the loose
   * `JobHandlerRegistry['byName']` shape consumed by
   * {@link ItotoriJobWorkerService}, so the typed registry can be merged
   * with the existing `byType` fallback without rewriting the worker.
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

function requireStringArray(value: unknown, field: string, jobName: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `${field} must be an array of strings`,
      field,
    );
  }
  return value as readonly string[];
}

function assertOptionalString(value: unknown, field: string, jobName: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `${field} must be a non-empty string when present`,
      field,
    );
  }
}

function assertOptionalStringArray(value: unknown, field: string, jobName: string): void {
  if (value === undefined) {
    return;
  }
  requireStringArray(value, field, jobName);
}

function assertPolicyVersionField(
  policyRecord: Record<string, unknown>,
  field: string,
  jobName: string,
): void {
  const value = policyRecord[field];
  if (value === null) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      `policyVersions.${field} must be a non-empty string or null`,
      `policyVersions.${field}`,
    );
  }
}

function assertReviewerTriggeredRerunReasonCodes(
  value: unknown,
  jobName: string,
): asserts value is readonly ReviewerTriggeredRerunReasonCode[] {
  if (!Array.isArray(value)) {
    throw new JobPayloadValidationError(
      jobName,
      jobPayloadValidationReasons.missingField,
      "reasonCodes must be an array",
      "reasonCodes",
    );
  }
  const valid = new Set<string>(Object.values(reviewerTriggeredRerunReasonCodeValues));
  for (const entry of value) {
    if (typeof entry !== "string" || !valid.has(entry)) {
      throw new JobPayloadValidationError(
        jobName,
        jobPayloadValidationReasons.wrongDiscriminator,
        `reasonCodes entry ${String(entry)} is not a valid reviewer-triggered rerun reason code`,
        "reasonCodes",
      );
    }
  }
}

function isReviewerTriggeredRerunStage(value: unknown): value is ReviewerTriggeredRerunStage {
  return (
    typeof value === "string" &&
    Object.values(reviewerTriggeredRerunStageValues).includes(value as ReviewerTriggeredRerunStage)
  );
}

function isReviewerQueueAction(
  value: unknown,
): value is (typeof reviewerQueueActionValues)[keyof typeof reviewerQueueActionValues] {
  return (
    typeof value === "string" &&
    Object.values(reviewerQueueActionValues).includes(
      value as (typeof reviewerQueueActionValues)[keyof typeof reviewerQueueActionValues],
    )
  );
}

function isReviewerQueueItemKind(
  value: unknown,
): value is (typeof reviewerQueueItemKindValues)[keyof typeof reviewerQueueItemKindValues] {
  return (
    typeof value === "string" &&
    Object.values(reviewerQueueItemKindValues).includes(
      value as (typeof reviewerQueueItemKindValues)[keyof typeof reviewerQueueItemKindValues],
    )
  );
}

// ---------------------------------------------------------------------------
// Compile-time self-checks (tsc-enforced on every build).
//
// These exported constants are the compile-time half of the acceptance
// ("caught (compile-time and/or a test)"). Each asserts exactly one
// property of the registry's type-level contract via a conditional type
// that resolves to `never` (making the `= true` initializer a type error)
// when the property does NOT hold. They are runtime `true` (no side
// effects, never throw); tsc enforces them because this file is in
// `src/**/*.ts`. `job-registry.test.ts` pins their existence.
//
//   - an unregistered name does NOT satisfy AnyRegisteredJobName;
//   - every structural rerun name + the agent/tool/search family patterns
//     DO satisfy AnyRegisteredJobName;
//   - JobPayloadFor<N> is exactly the expected payload type per family;
//   - a wrong-shaped payload is NOT assignable to JobPayloadFor<N>.
// ---------------------------------------------------------------------------

/** Asserts `"bogus.thing"` is rejected by the registered-name union. */
export const COMPILE_TIME_UNREGISTERED_NAME_REJECTED: "bogus.thing" extends AnyRegisteredJobName
  ? never
  : true = true;

/** Asserts every structural rerun name is in the registered-name union. */
export const COMPILE_TIME_RERUN_NAMES_REGISTERED:
  | typeof reviewerTriggeredRerunJobNameValues.draftRepair
  | typeof reviewerTriggeredRerunJobNameValues.qaReplay
  | typeof reviewerTriggeredRerunJobNameValues.exportRegeneration
  | typeof reviewerTriggeredRerunJobNameValues.runtimeValidation extends AnyRegisteredJobName
  ? true
  : never = true;

/** Asserts the agent/tool/search family patterns are registered names. */
export const COMPILE_TIME_FAMILY_NAMES_REGISTERED:
  | `agent.${string}`
  | `tool.${string}`
  | `search.${string}` extends AnyRegisteredJobName
  ? true
  : never = true;

/** Asserts JobPayloadFor<rerun name> is exactly ReviewerTriggeredRerunPayload. */
export const COMPILE_TIME_RERUN_PAYLOAD_TYPE: [
  JobPayloadFor<typeof reviewerTriggeredRerunJobNameValues.draftRepair>,
] extends [ReviewerTriggeredRerunPayload]
  ? [ReviewerTriggeredRerunPayload] extends [
      JobPayloadFor<typeof reviewerTriggeredRerunJobNameValues.draftRepair>,
    ]
    ? true
    : never
  : never = true;

/** Asserts JobPayloadFor<agent name> is exactly AgentJobPayload. */
export const COMPILE_TIME_AGENT_PAYLOAD_TYPE: [
  JobPayloadFor<"agent.translation-quality-judge">,
] extends [AgentJobPayload]
  ? [AgentJobPayload] extends [JobPayloadFor<"agent.translation-quality-judge">]
    ? true
    : never
  : never = true;

/** Asserts a wrong-shaped object is NOT assignable to the rerun payload type. */
export const COMPILE_TIME_WRONG_RERUN_PAYLOAD_REJECTED: { wrong: string } extends JobPayloadFor<
  typeof reviewerTriggeredRerunJobNameValues.draftRepair
>
  ? never
  : true = true;

/** Asserts a rerun payload is NOT assignable to the agent payload type (cross-family mismatch). */
export const COMPILE_TIME_CROSS_FAMILY_MISMATCH_REJECTED: ReviewerTriggeredRerunPayload extends JobPayloadFor<"agent.translation-quality-judge">
  ? never
  : true = true;
