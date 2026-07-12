// itotori-project-level-driven-executor — concrete journal + patch adapters.
//
// The durable path has exactly two boundaries:
//
//   - unit journal -> itotori_localization_journal_* tables. Every physical
//                     provider call lands as a row; then the canonical outcome
//                     and its normalized provenance land atomically.
//   - patch export -> translated-bridge.json + patch-report.json.
//
// Draft-job and aggregate provider-ledger rows are deliberately absent from
// this adapter. They cannot represent a lossless execution journal.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthorizationActor, ItotoriLocalizationJournalRepositoryPort } from "@itotori/db";
import type {
  DrivenFailedUnitJournalRecord,
  DrivenUnitJournalRecord,
  DrivenUnitJournalSink,
  DrivenPatchExportRecord,
  DrivenPatchExportSink,
} from "./project-driven-executor.js";

export type DrivenJournalPersistenceOptions = {
  actor: AuthorizationActor;
};

/**
 * Binds the executor's journal sink to its real repository. The executor gives
 * us a stable run identity but deliberately knows nothing about database setup;
 * establish the run before dispatch, and defensively ensure it again for every
 * unit/failure write. The promise map keeps this safe if a future executor
 * chooses concurrent persistence.
 */
export class DrivenJournalPersistenceAdapter implements DrivenUnitJournalSink {
  private readonly createdRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly journal: ItotoriLocalizationJournalRepositoryPort,
    private readonly opts: DrivenJournalPersistenceOptions,
  ) {}

  async beginJournalRun(record: DrivenUnitJournalRecord["run"]): Promise<void> {
    await this.ensureRun(record);
  }

  async persistUnitJournal(record: DrivenUnitJournalRecord): Promise<void> {
    await this.ensureRun(record.run);
    await this.journal.persistUnit(this.opts.actor, {
      runId: record.run.runId,
      bridgeUnitId: record.writtenOutcome.bridgeUnitId,
      sourceUnitKey: record.writtenOutcome.sourceUnitKey,
      outcome: record.writtenOutcome.outcome,
      attempts: record.attempts,
      contextPacket: record.contextPacket,
      contextRefs: record.contextRefs,
      speakerLabels: record.speakerLabels,
      qaDetails: record.qaDetails,
    });
  }

  async persistFailedUnitAttempts(record: DrivenFailedUnitJournalRecord): Promise<void> {
    await this.ensureRun(record.run);
    await this.journal.persistAttempts(this.opts.actor, {
      runId: record.run.runId,
      bridgeUnitId: record.bridgeUnitId,
      attempts: record.attempts,
    });
  }

  private async ensureRun(run: DrivenUnitJournalRecord["run"]): Promise<void> {
    let creation = this.createdRuns.get(run.runId);
    if (creation === undefined) {
      creation = this.journal
        .createRun(this.opts.actor, {
          runId: run.runId,
          projectId: run.projectId,
          localeBranchId: run.localeBranchId,
          sourceRevisionId: run.sourceRevisionId,
          targetLocale: run.targetLocale,
        })
        .then(() => undefined);
      this.createdRuns.set(run.runId, creation);
    }
    await creation;
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
