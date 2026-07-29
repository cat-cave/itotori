// Runtime enqueue and handler registry operations.

import type {
  JobQueueInput,
  JobQueueRecord,
  QueueJsonRecord,
} from "./repositories/event-queue-repository.js";

import {
  type AnyRegisteredJobName,
  contextCorrectionRedraftJobName,
  type JobPayloadFor,
  type RegisteredJobName,
} from "./job-registry-payload.js";
import {
  DuplicateJobHandlerError,
  type RegisteredJobDefinition,
  resolveRegisteredJobDefinition,
  UnregisteredJobHandlerError,
  UnregisteredJobNameError,
} from "./job-registry-definitions.js";

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
