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
  /** Units whose new draft was durably written by this execution. */
  redraftedUnitIds: readonly string[];
  /** Number of drafts that changed relative to the delivered base. */
  changedDraftCount: number;
  /**
   * Per-unit ContextPacket version map read after the redraft persisted. The
   * handler verifies the correction's new entry version here rather than
   * accepting a serialized/stale packet from the queue payload.
   */
  resolvedContextVersionsByUnit: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

export interface ContextCorrectionRedrafter {
  redraft(
    input: ContextCorrectionRedraftPayload & { jobId: string },
  ): Promise<ContextCorrectionRedraftExecution>;
}

export type ContextCorrectionRerunWorkerOptions = {
  queue: ItotoriEventQueueRepositoryPort;
  actor: AuthorizationActor;
  workerId: string;
  redrafter: ContextCorrectionRedrafter;
};

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
      const execution = await options.redrafter.redraft({ ...job.payload, jobId: job.jobId });
      assertFreshContextPackets(job.payload, execution);
      return {
        journalRunId: execution.journalRunId,
        redraftedUnitIds: [...execution.redraftedUnitIds],
        changedDraftCount: execution.changedDraftCount,
        contextEntryVersionId: job.payload.contextEntryVersionId,
      };
    });
    this.worker = new ItotoriJobWorkerService(options.queue, options.actor, options.workerId, {
      byName: this.handlers.toJobHandlerByNameMap(),
    });
  }

  /** Claim and execute available context-correction jobs through the registered handler. */
  async runAvailable(): Promise<JobWorkerResult> {
    return await this.worker.runAvailable({ queueName: "context-correction" });
  }

  /** Startup/test inspection seam: proves the structural handler is installed. */
  hasRegisteredHandler(): boolean {
    return this.handlers.hasHandlerFor(contextCorrectionRedraftJobName);
  }
}

function assertFreshContextPackets(
  payload: ContextCorrectionRedraftPayload,
  execution: ContextCorrectionRedraftExecution,
): void {
  const redrafted = new Set(execution.redraftedUnitIds);
  const missingUnits = payload.affectedUnitIds.filter((unitId) => !redrafted.has(unitId));
  if (missingUnits.length > 0) {
    throw new Error(
      `context-correction worker did not redraft affected unit(s): ${missingUnits.join(", ")}`,
    );
  }
  for (const unitId of payload.affectedUnitIds) {
    const versions = execution.resolvedContextVersionsByUnit[unitId];
    if (versions?.[payload.contextArtifactId] !== payload.contextEntryVersionId) {
      throw new Error(
        `context-correction worker did not reload ${payload.contextArtifactId}@${payload.contextEntryVersionId} for unit ${unitId}`,
      );
    }
  }
}
