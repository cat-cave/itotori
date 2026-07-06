import type { AuthorizationActor } from "../authorization.js";
import type { JobTaskType } from "../schema.js";
import {
  type ClaimJobsOptions,
  type ClaimOutboxEventsOptions,
  type ItotoriEventQueueRepositoryPort,
  JobLeaseRevalidationError,
  type JobQueueRecord,
  type OutboxEventRecord,
  OutboxLeaseRevalidationError,
  type QueueFailureInput,
  type QueueJsonRecord,
} from "../repositories/event-queue-repository.js";

export type OutboxPublishHandler = (event: OutboxEventRecord) => Promise<void>;

export type OutboxPublishResult = {
  claimed: number;
  published: number;
  failed: number;
  /**
   * Outbox events this publisher processed but could NOT record an outcome for
   * because its lease was no longer valid (expired, recovered, or taken over)
   * when it went to mark them published/failed. The mark was rejected as a no-op
   * and the event stays under the recovery path's authority, so it is counted
   * here rather than as published/failed. The outbox analog of
   * {@link JobWorkerResult.leaseLost}. See ITOTORI-046.
   */
  leaseLost: number;
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
  /**
   * Jobs this worker processed but could NOT record an outcome for because its
   * lease was no longer valid (expired, recovered, or taken over) when it went
   * to complete/fail them. The completion/failure was rejected as a no-op and
   * the job stays under the recovery path's authority, so it is counted here
   * rather than as succeeded/failed. See ITOTORI-046.
   */
  leaseLost: number;
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
    let leaseLost = 0;

    for (const event of events) {
      let publishError: unknown;
      let publishThrew = false;
      try {
        await this.publish(event);
      } catch (error) {
        publishThrew = true;
        publishError = error;
      }

      if (publishThrew) {
        // The publish handler threw: record a failure (drives retry/dead-letter).
        // If the lease is gone, the recovery path owns the transition, so the
        // rejected mark is a no-op and must not be counted as a failure/retry.
        if (
          await this.recordOutcome(() =>
            this.repository.markOutboxEventFailed(
              this.actor,
              event.outboxEventId,
              this.workerId,
              failureInput(publishError, options.retryAfterSeconds),
            ),
          )
        ) {
          failed += 1;
        } else {
          leaseLost += 1;
        }
        continue;
      }

      if (
        await this.recordOutcome(() =>
          this.repository.markOutboxEventPublished(this.actor, event.outboxEventId, this.workerId),
        )
      ) {
        published += 1;
      } else {
        leaseLost += 1;
      }
    }

    return { claimed: events.length, published, failed, leaseLost };
  }

  /**
   * Run a lease-guarded outbox mark (markOutboxEventPublished/Failed). Returns
   * true when the mark landed, false when it was rejected because this publisher's
   * lease was no longer valid — in which case the rejection is a no-op and the
   * recovery path retains authority over the event, keeping retry/dead-letter
   * transitions deterministic. Mirrors {@link ItotoriJobWorkerService} recordOutcome.
   */
  private async recordOutcome(write: () => Promise<OutboxEventRecord>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      if (error instanceof OutboxLeaseRevalidationError) {
        return false;
      }
      throw error;
    }
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
    let leaseLost = 0;

    for (const job of jobs) {
      let handlerResult: QueueJsonRecord | void;
      try {
        const handler = this.handlerFor(job);
        handlerResult = await handler(job);
      } catch (error) {
        // The handler threw: record a failure (drives retry/dead-letter). If the
        // lease is gone, the recovery path owns the transition, so the rejected
        // failJob is a no-op and must not be counted as a failure/retry.
        if (
          await this.recordOutcome(() =>
            this.repository.failJob(
              this.actor,
              job.jobId,
              this.workerId,
              failureInput(error, options.retryAfterSeconds),
            ),
          )
        ) {
          failed += 1;
        } else {
          leaseLost += 1;
        }
        continue;
      }

      if (
        await this.recordOutcome(() =>
          this.repository.completeJob(this.actor, job.jobId, this.workerId, handlerResult ?? {}),
        )
      ) {
        succeeded += 1;
      } else {
        leaseLost += 1;
      }
    }

    return { claimed: jobs.length, succeeded, failed, leaseLost };
  }

  /**
   * Run a lease-guarded write (completeJob/failJob). Returns true when the write
   * landed, false when it was rejected because this worker's lease was no longer
   * valid — in which case the rejection is a no-op and the recovery path retains
   * authority over the job, keeping retry/dead-letter transitions deterministic.
   */
  private async recordOutcome(write: () => Promise<JobQueueRecord>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (error) {
      if (error instanceof JobLeaseRevalidationError) {
        return false;
      }
      throw error;
    }
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
