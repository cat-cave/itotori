import type { AuthorizationActor } from "../authorization.js";
import type { JobTaskType } from "../schema.js";
import type {
  ClaimJobsOptions,
  ClaimOutboxEventsOptions,
  ItotoriEventQueueRepositoryPort,
  JobQueueRecord,
  OutboxEventRecord,
  QueueFailureInput,
  QueueJsonRecord,
} from "../repositories/event-queue-repository.js";

export type OutboxPublishHandler = (event: OutboxEventRecord) => Promise<void>;

export type OutboxPublishResult = {
  claimed: number;
  published: number;
  failed: number;
};

export type JobHandler = (job: JobQueueRecord) => Promise<QueueJsonRecord | void>;

export type JobHandlerRegistry = {
  byName?: Record<string, JobHandler>;
  byType?: Partial<Record<JobTaskType, JobHandler>>;
};

export type JobWorkerResult = {
  claimed: number;
  succeeded: number;
  failed: number;
};

export type QueueServiceRunOptions = {
  retryAfterSeconds?: number;
};

export class ItotoriOutboxPublisherService {
  constructor(
    private readonly repository: ItotoriEventQueueRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly workerId: string,
    private readonly publish: OutboxPublishHandler,
  ) {}

  async publishAvailable(
    options: ClaimOutboxEventsOptions & QueueServiceRunOptions = {},
  ): Promise<OutboxPublishResult> {
    const events = await this.repository.claimOutboxEvents(this.actor, this.workerId, options);
    let published = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await this.publish(event);
        await this.repository.markOutboxEventPublished(
          this.actor,
          event.outboxEventId,
          this.workerId,
        );
        published += 1;
      } catch (error) {
        await this.repository.markOutboxEventFailed(
          this.actor,
          event.outboxEventId,
          this.workerId,
          failureInput(error, options.retryAfterSeconds),
        );
        failed += 1;
      }
    }

    return { claimed: events.length, published, failed };
  }
}

export class ItotoriJobWorkerService {
  constructor(
    private readonly repository: ItotoriEventQueueRepositoryPort,
    private readonly actor: AuthorizationActor,
    private readonly workerId: string,
    private readonly handlers: JobHandlerRegistry,
  ) {}

  async runAvailable(
    options: ClaimJobsOptions & QueueServiceRunOptions = {},
  ): Promise<JobWorkerResult> {
    const jobs = await this.repository.claimJobs(this.actor, this.workerId, options);
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const handler = this.handlerFor(job);
        const result = await handler(job);
        await this.repository.completeJob(this.actor, job.jobId, this.workerId, result ?? {});
        succeeded += 1;
      } catch (error) {
        await this.repository.failJob(
          this.actor,
          job.jobId,
          this.workerId,
          failureInput(error, options.retryAfterSeconds),
        );
        failed += 1;
      }
    }

    return { claimed: jobs.length, succeeded, failed };
  }

  private handlerFor(job: JobQueueRecord): JobHandler {
    const byNameHandler = this.handlers.byName?.[job.jobName];
    if (byNameHandler !== undefined) {
      return byNameHandler;
    }

    const byTypeHandler = this.handlers.byType?.[job.jobType];
    if (byTypeHandler !== undefined) {
      return byTypeHandler;
    }

    throw new Error(`no handler registered for job ${job.jobName}`);
  }
}

function failureInput(error: unknown, retryAfterSeconds: number | undefined): QueueFailureInput {
  if (retryAfterSeconds === undefined) {
    return { error };
  }
  return { error, retryAfterSeconds };
}
