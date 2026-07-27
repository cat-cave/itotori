import type { CreateProjectRunInput } from "./project-run-repository.js";
import { ItotoriProjectRunRepositoryError } from "./project-run-repository-internal.js";

type PgConstraint = {
  readonly code: string;
  readonly constraint: string | null;
  readonly table: string | null;
  readonly detail: string | null;
  readonly message: string | null;
};

/** Convert driver wrappers into an operator-safe constraint diagnostic. */
export function rethrowProjectRunConstraint(error: unknown, input: CreateProjectRunInput): never {
  const pg = postgresConstraint(error);
  if (pg === null) throw error;
  const identity = `project '${input.projectId}', run '${input.runId}'`;
  if (pg.code === "23505" && pg.constraint === "itotori_project_runs_pkey") {
    throw new ItotoriProjectRunRepositoryError(
      "run_id_collision",
      `project run-id collision: ${constraintDescription(pg)} rejected ${identity}. This run ID already exists; choose a new run ID, or resume the existing run.`,
    );
  }
  if (pg.code === "23505" && pg.constraint === "itotori_project_runs_one_active_branch_idx") {
    throw new ItotoriProjectRunRepositoryError(
      "active_branch_collision",
      `project run collision: ${constraintDescription(pg)} rejected ${identity} on locale branch '${input.localeBranchId}'. Another active run blocks a retry; finish or cancel it, or use a different branch.`,
    );
  }
  if (isSnapshotBindingRejection(pg)) {
    throw new ItotoriProjectRunRepositoryError(
      "constraint_violation",
      `project run snapshot-binding rejection: trigger 'itotori_validate_project_run_snapshot_binding' rejected ${identity} on locale branch '${input.localeBranchId}'. The localization snapshot is bound to a different locale branch; verify the run's locale branch matches its localization snapshot before retrying.`,
    );
  }
  const kind = pg.code === "23503" ? "foreign-key" : pg.code === "23505" ? "unique" : "check";
  throw new ItotoriProjectRunRepositoryError(
    "constraint_violation",
    `project run ${kind}-constraint violation: ${constraintDescription(pg)} rejected ${identity}. Verify the referenced project, branch, and snapshots before retrying.`,
  );
}

function isSnapshotBindingRejection(pg: PgConstraint): boolean {
  return (
    pg.code === "23514" &&
    pg.constraint === null &&
    pg.table === null &&
    pg.detail === null &&
    pg.message === "project run localization snapshot must match its locale branch"
  );
}

function constraintDescription(pg: PgConstraint): string {
  if (pg.constraint !== null) return `constraint '${pg.constraint}'`;
  if (pg.table !== null)
    return `PostgreSQL did not provide a constraint name for table '${pg.table}'`;
  return "PostgreSQL did not provide a constraint name";
}

function postgresConstraint(error: unknown): PgConstraint | null {
  let current = error;
  while (typeof current === "object" && current !== null) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      detail?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      ["23503", "23505", "23514"].includes(candidate.code)
    ) {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === "string" && /^[a-z0-9_]+$/u.test(candidate.constraint)
            ? candidate.constraint
            : null,
        table: typeof candidate.table === "string" ? candidate.table : null,
        detail: typeof candidate.detail === "string" ? candidate.detail : null,
        message: typeof candidate.message === "string" ? candidate.message : null,
      };
    }
    current = candidate.cause;
  }
  return null;
}
