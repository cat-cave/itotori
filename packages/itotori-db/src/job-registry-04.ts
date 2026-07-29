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
  type AnyRegisteredJobName,
  contextCorrectionRedraftJobName,
  type ContextCorrectionRedraftPayload,
  type JobPayloadFor,
} from "./job-registry-01.js";

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
