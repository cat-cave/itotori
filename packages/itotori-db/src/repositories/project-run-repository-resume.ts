import { sql } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { projectRunCostAccounts, projectRunStatusValues, projectRuns } from "../schema.js";
import { rethrowProjectRunConstraint } from "./project-run-diagnostics.js";
import {
  ItotoriProjectRunRepositoryError,
  loadRun,
  loadRunByIdOrNull,
  normalizeCreate,
  rowsOf,
  type SqlExecutor,
} from "./project-run-repository-internal.js";
import type { CreateProjectRunInput, ProjectRunRecord } from "./project-run-repository-types.js";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

/**
 * Atomically creates a run or re-enters the exact non-terminal run that already
 * owns this run ID. `createRun` deliberately remains strict for callers that
 * need duplicate IDs to be rejected.
 */
export async function createOrResumeProjectRun(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: CreateProjectRunInput,
): Promise<ProjectRunRecord> {
  await requirePermission(db, actor, permissionValues.draftWrite);
  const normalized = normalizeCreate(input);
  try {
    return await db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const existing = await loadRunByIdOrNull(executor, normalized.runId);
      if (existing !== null) return resumeExisting(existing, normalized);
      const inserted = await rowsOf(
        executor,
        sql`
          insert into ${projectRuns} (
            run_id, project_id, locale_branch_id, context_snapshot_id, localization_snapshot_id, status
          ) values (
            ${normalized.runId}, ${normalized.projectId}, ${normalized.localeBranchId},
            ${normalized.contextSnapshotId}, ${normalized.localizationSnapshotId}, ${projectRunStatusValues.queued}
          ) on conflict (run_id) do nothing returning run_id
        `,
      );
      if (inserted[0] !== undefined) {
        await executor.execute(sql`
          insert into ${projectRunCostAccounts} (run_id, project_id, cap_micros_usd)
          values (${normalized.runId}, ${normalized.projectId}, ${normalized.capMicrosUsd})
        `);
        return await loadRun(executor, normalized.projectId, normalized.runId);
      }
      const raced = await loadRunByIdOrNull(executor, normalized.runId);
      if (raced === null) throw new Error("project run collision was not readable");
      return resumeExisting(raced, normalized);
    });
  } catch (error) {
    rethrowProjectRunConstraint(error, normalized);
  }
}

function resumeExisting(
  existing: ProjectRunRecord,
  input: CreateProjectRunInput,
): ProjectRunRecord {
  assertExactResumeIdentity(existing, input);
  if (terminalStatuses.has(existing.status)) {
    throw new ItotoriProjectRunRepositoryError(
      "run_resume_rejected",
      `project run '${input.runId}' is terminal and cannot be resumed`,
    );
  }
  return existing;
}

function assertExactResumeIdentity(existing: ProjectRunRecord, input: CreateProjectRunInput): void {
  const sameIdentity =
    existing.projectId === input.projectId &&
    existing.runId === input.runId &&
    existing.localeBranchId === input.localeBranchId &&
    existing.contextSnapshotId === input.contextSnapshotId &&
    existing.localizationSnapshotId === input.localizationSnapshotId &&
    existing.cost.capMicrosUsd === input.capMicrosUsd;
  if (!sameIdentity) {
    throw new ItotoriProjectRunRepositoryError(
      "run_resume_rejected",
      `project run '${input.runId}' cannot resume because its immutable identity does not match`,
    );
  }
}
