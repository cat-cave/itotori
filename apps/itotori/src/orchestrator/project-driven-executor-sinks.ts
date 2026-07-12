// itotori-project-level-driven-executor — CONCRETE persistence sink adapters.
//
// The executor persists through three narrow ports (draft / provider-run /
// patch-export). These adapters bind those ports to REAL storage so a driven
// run persists to actual tables + the filesystem, not in-memory:
//
//   - written outcome    -> itotori_draft_jobs + itotori_draft_job_attempts
//                           (ItotoriDraftJobRepository): one job + attempt per
//                           run unit; every persisted outcome is written and
//                           therefore marks its attempt succeeded.
//   - provider-run       -> itotori_draft_attempt_provider_ledger
//                           (ItotoriDraftAttemptProviderLedgerRepository): one
//                           ledger row per unit carrying the REAL aggregated
//                           usage.cost. The ledger's FK requires the draft
//                           attempt to exist FIRST, so the executor persists the
//                           draft before the provider-run (a single adapter
//                           instance shares the per-unit attempt id).
//   - patch-export       -> on-disk artifacts (translated-bridge.json +
//                           patch-report.json) under a run directory.
//
// This mirrors how the reviewer-queue sink binds to ItotoriReviewerQueueRepository.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthorizationActor,
  ItotoriDraftAttemptProviderLedgerRepositoryPort,
  ItotoriDraftJobRepositoryPort,
} from "@itotori/db";
import type {
  DrivenWrittenOutcomeRecord,
  DrivenWrittenOutcomeSink,
  DrivenPatchExportRecord,
  DrivenPatchExportSink,
  DrivenProviderRunRecord,
  DrivenProviderRunSink,
} from "./project-driven-executor.js";

export type DrivenDbPersistenceOptions = {
  projectId: string;
  localeBranchId: string;
  actor: AuthorizationActor;
  /** The pinned (modelId, providerId) recorded on every draft job + ledger row. */
  pair: { modelId: string; providerId: string };
  now?: () => Date;
};

/**
 * Binds the draft + provider-run sinks to the REAL draft-job + provider-ledger
 * repositories. One instance persists a whole driven run: it keeps the per-unit
 * `draft_job_attempt_id` so the provider-run ledger row (recorded AFTER the
 * draft) can reference it (the ledger's on-delete-cascade FK requires the
 * attempt to exist first — the executor persists the draft before the run).
 */
export class DrivenDbPersistenceAdapter implements DrivenWrittenOutcomeSink, DrivenProviderRunSink {
  private readonly attemptByUnit = new Map<string, string>();

  constructor(
    private readonly draftJobs: ItotoriDraftJobRepositoryPort,
    private readonly ledger: ItotoriDraftAttemptProviderLedgerRepositoryPort,
    private readonly opts: DrivenDbPersistenceOptions,
  ) {}

  async persistWrittenOutcome(record: DrivenWrittenOutcomeRecord): Promise<void> {
    const now = this.opts.now?.() ?? new Date();
    const job = await this.draftJobs.createDraftJob(this.opts.actor, {
      projectId: this.opts.projectId,
      localeBranchId: this.opts.localeBranchId,
      sourceUnitIds: [record.bridgeUnitId],
      styleGuideVersion: "driven-executor",
      glossaryVersion: "driven-executor",
      policyVersions: {
        promptTemplateVersion: "driven-executor-v0",
        modelProviderFamily: "openrouter",
        modelId: this.opts.pair.modelId,
      },
    });
    const attempt = await this.draftJobs.recordAttempt(this.opts.actor, job.draftJobId, {
      attemptIndex: 1,
      startedAt: now,
    });
    this.attemptByUnit.set(record.bridgeUnitId, attempt.draftJobAttemptId);
    await this.draftJobs.markAttemptSucceeded(this.opts.actor, attempt.draftJobAttemptId, now);
  }

  async persistProviderRun(record: DrivenProviderRunRecord): Promise<void> {
    const attemptId = this.attemptByUnit.get(record.bridgeUnitId);
    if (attemptId === undefined) {
      throw new Error(
        `driven-db-sink: no draft attempt persisted for unit ${record.bridgeUnitId}; ` +
          "the executor must persist the draft (which creates the attempt) before the provider run",
      );
    }
    // PROJECT LAW: cost comes only from the real aggregated usage.cost. The
    // ledger CHECK requires cost_unit='usd' + cost_amount == usage.cost, so the
    // usage block mirrors the same billed total the executor summed.
    const costAmount = record.totalCostUsd.toFixed(8);
    await this.ledger.recordLedgerEntry(this.opts.actor, {
      draftJobAttemptId: attemptId,
      // The provider-proof id carries a UNIQUE index. A MULTI-PASS run
      // (pass-ledger) re-drafts the same unit across passes — each pass is a
      // distinct provider run on a fresh draft attempt — so key the synthetic
      // proof id by the per-attempt id (unique per draft attempt) rather than
      // by the bridge unit alone, or pass N+1's ledger row collides with pass N.
      providerProofId: `driven-executor:${record.bridgeUnitId}:${attemptId}`,
      providerId: record.pair.providerId,
      modelId: record.pair.modelId,
      modelProviderFamily: "openrouter",
      tokensIn: record.totalTokensIn,
      tokensOut: record.totalTokensOut,
      tokenCountSource: "provider_reported",
      costUnit: "usd",
      costAmount,
      usageResponseJson: { cost: Number(costAmount) },
    });
  }
}

/**
 * Writes the ONE patch export to disk under a run directory as
 * `translated-bridge.json` + `patch-report.json`. Real filesystem storage —
 * the translated bridge carries every in-scope unit's selected body once
 * coverage is complete, and the patch report is the deterministic summary.
 */
export class FsDrivenPatchExportSink implements DrivenPatchExportSink {
  private count = 0;
  constructor(private readonly runDir: string) {}

  async exportPatch(record: DrivenPatchExportRecord): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(
      join(this.runDir, "translated-bridge.json"),
      `${JSON.stringify(record.translatedBridge, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(this.runDir, "patch-report.json"),
      `${JSON.stringify(record.patchReport, null, 2)}\n`,
      "utf8",
    );
    this.count += 1;
  }

  get exportCount(): number {
    return this.count;
  }
}
