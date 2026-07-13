// Registered context-correction redraft worker.
//
// The correction service only persists the edit + schedules a durable job.
// This worker is the execution boundary: it claims the job, calls a real
// redrafter, and refuses to complete unless every affected unit reports the
// newly selected ContextEntryVersion in a freshly resolved ContextPacket.

import {
  ItotoriJobWorkerService,
  RegisteredJobHandlerRegistry,
  assertContextCorrectionRedraftPayload,
  contextCorrectionRedraftJobName,
  type AuthorizationActor,
  type ContextCorrectionRedraftPayload,
  type ItotoriEventQueueRepositoryPort,
  type JobWorkerResult,
} from "@itotori/db";

export type ContextCorrectionRedraftExecution = {
  /** Durable journal/run identity produced by the real redraft. */
  journalRunId: string;
};

export interface ContextCorrectionRedrafter {
  redraft(
    input: ContextCorrectionRedraftPayload & { jobId: string },
  ): Promise<ContextCorrectionRedraftExecution>;
}

/**
 * Durable proof read independently of the redrafter. The worker snapshots the
 * affected draft projection before execution, then this verifier reads the
 * persisted drafts and journal ContextPackets after execution. A redrafter
 * therefore cannot claim a changed draft or a refreshed packet by returning a
 * convenient map in its own result.
 */
export interface ContextCorrectionRerunVerifier {
  snapshotDrafts(
    payload: ContextCorrectionRedraftPayload,
  ): Promise<Readonly<Record<string, string | null>>>;
  verifyRedraft(input: {
    payload: ContextCorrectionRedraftPayload;
    journalRunId: string;
    draftsBefore: Readonly<Record<string, string | null>>;
  }): Promise<ContextCorrectionRedraftVerification>;
}

export type ContextCorrectionRedraftVerification = {
  /** Affected units with a durable written outcome in the redraft journal. */
  redraftedUnitIds: readonly string[];
  /** Actual persisted draft values that differ from the pre-redraft snapshot. */
  changedDraftCount: number;
};

export type ContextCorrectionRerunWorkerOptions = {
  queue: ItotoriEventQueueRepositoryPort;
  actor: AuthorizationActor;
  workerId: string;
  redrafter: ContextCorrectionRedrafter;
  verifier: ContextCorrectionRerunVerifier;
  /**
   * A real scoped full-project rerun can outlive the queue's generic 60s
   * lease. The worker claims one job at a time with this long lease so a
   * second correction cannot make a still-running redraft look abandoned.
   */
  leaseSeconds?: number;
};

const contextCorrectionWorkerLeaseSeconds = 3_600;
const contextCorrectionDrainMaxBatches = 100;

/**
 * The installed durable worker for the only structural context-correction
 * redraft job. `RegisteredJobHandlerRegistry` gives this exact name one and
 * only one handler; the lease-aware DB worker then claims and completes it.
 */
export class ContextCorrectionRerunWorker {
  private readonly handlers = new RegisteredJobHandlerRegistry();
  private readonly worker: ItotoriJobWorkerService;

  constructor(private readonly options: ContextCorrectionRerunWorkerOptions) {
    this.handlers.register(contextCorrectionRedraftJobName, async (job) => {
      assertContextCorrectionRedraftPayload(job.payload, job.jobName);
      const draftsBefore = await options.verifier.snapshotDrafts(job.payload);
      const execution = await options.redrafter.redraft({ ...job.payload, jobId: job.jobId });
      const verification = await options.verifier.verifyRedraft({
        payload: job.payload,
        journalRunId: execution.journalRunId,
        draftsBefore,
      });
      assertVerifiedRedraft(job.payload, verification);
      return {
        journalRunId: execution.journalRunId,
        redraftedUnitIds: [...verification.redraftedUnitIds],
        changedDraftCount: verification.changedDraftCount,
        contextEntryVersionId: job.payload.contextEntryVersionId,
      };
    });
    this.worker = new ItotoriJobWorkerService(options.queue, options.actor, options.workerId, {
      byName: this.handlers.toJobHandlerByNameMap(),
    });
  }

  /**
   * Claim and execute one context-correction job through the registered
   * handler. Reclaim expired leases before claiming: an interrupted process
   * must not leave a `running` correction stranded forever.
   */
  async runAvailable(): Promise<JobWorkerResult> {
    await this.options.queue.recoverExpiredJobLeases(this.options.actor);
    return await this.worker.runAvailable({
      queueName: "context-correction",
      // Each worker processes one expensive real redraft at a time. Claiming a
      // batch would let later jobs' leases expire while the first is running.
      limit: 1,
      leaseSeconds: this.options.leaseSeconds ?? contextCorrectionWorkerLeaseSeconds,
    });
  }

  /**
   * Drain immediately available work without monopolizing a production poll.
   * Failed work enters retry_waiting with a backoff, so the next claim returns
   * empty; the bounded loop also yields to the next poll under continuous
   * arrivals.
   */
  async runUntilIdle(maxBatches = contextCorrectionDrainMaxBatches): Promise<JobWorkerResult> {
    let claimed = 0;
    let succeeded = 0;
    let failed = 0;
    let leaseLost = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.runAvailable();
      claimed += result.claimed;
      succeeded += result.succeeded;
      failed += result.failed;
      leaseLost += result.leaseLost;
      if (result.claimed === 0) {
        break;
      }
    }
    return { claimed, succeeded, failed, leaseLost };
  }

  /** Startup/test inspection seam: proves the structural handler is installed. */
  hasRegisteredHandler(): boolean {
    return this.handlers.hasHandlerFor(contextCorrectionRedraftJobName);
  }
}

function assertVerifiedRedraft(
  payload: ContextCorrectionRedraftPayload,
  verification: ContextCorrectionRedraftVerification,
): void {
  const redrafted = new Set(verification.redraftedUnitIds);
  const missingUnits = payload.affectedUnitIds.filter((unitId) => !redrafted.has(unitId));
  if (missingUnits.length > 0) {
    throw new Error(
      `context-correction worker did not redraft affected unit(s): ${missingUnits.join(", ")}`,
    );
  }
  if (verification.changedDraftCount <= 0) {
    throw new Error(
      `context-correction worker redraft ${payload.correctionId} produced no changed draft`,
    );
  }
}
