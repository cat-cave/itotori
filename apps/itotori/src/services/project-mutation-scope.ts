import type { LocaleBranchIdentity } from "@itotori/db";

/**
 * ITOTORI-050 — Project mutation scoping policy (IDOR / broken object-level
 * authorization hardening).
 *
 * THE POLICY. A project mutation route MUST NOT trust a client-supplied
 * `ProjectState` or a client-supplied locale-branch id to decide WHICH
 * project/branch it writes to. Client input names the TARGET; it never
 * carries authority. Before any write, the route resolves the authoritative
 * project + branch scope from a SERVER-SIDE ownership lookup keyed on the
 * project id, and:
 *
 *   1. rejects a project that has no server-side locale branches (an
 *      unknown / out-of-scope project id — nothing the principal owns), and
 *   2. rejects a client-supplied locale-branch id that is not one of the
 *      project's server-side branches (a foreign / forged branch id), and
 *   3. returns the SERVER-SIDE branch identity so the write is keyed on the
 *      authoritative value, never on the client's copy.
 *
 * A forged `ProjectState` therefore cannot smuggle a foreign branch id past
 * the write: the branch must appear in the project's server-side ownership
 * set or the mutation is refused with {@link ProjectMutationScopeError}
 * (mapped to HTTP 403 at the API boundary) BEFORE the repository is touched.
 */

/**
 * The server-side ownership oracle. `listLocaleBranchIdentities(projectId)`
 * returns exactly the locale branches the DB records as belonging to
 * `projectId` (its SQL is `where project_id = <projectId>`), i.e. the
 * authoritative, non-client-controllable scope for that project.
 */
export type ProjectBranchOwnershipLookup = {
  listLocaleBranchIdentities(projectId: string): Promise<LocaleBranchIdentity[]>;
};

export type ProjectMutationScopeRejectionReason = "unknown_project" | "foreign_branch";

/**
 * Raised when a project mutation names a project/branch scope the server-side
 * ownership lookup does not vouch for. Distinct from a permission denial: the
 * principal may hold the mutation permission yet still be refused because the
 * TARGET object is outside the scope the server can attribute to that project.
 * Mapped to HTTP 403 (`forbidden`) at the API boundary.
 */
export class ProjectMutationScopeError extends Error {
  constructor(
    readonly reason: ProjectMutationScopeRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMutationScopeError";
  }
}

/**
 * The authoritative, server-derived scope for a project mutation. `branch` /
 * `localeBranchId` are non-null iff the caller supplied a branch id that was
 * verified against the server-side ownership set; a caller that supplied no
 * branch id gets a project-verified scope with a null branch.
 */
export type ProjectMutationScope = {
  projectId: string;
  branches: LocaleBranchIdentity[];
  localeBranchId: string | null;
  branch: LocaleBranchIdentity | null;
};

export type ResolveProjectMutationScopeInput = {
  projectId: string;
  /**
   * The locale-branch id the CLIENT supplied (from a `ProjectState`, request
   * body, or benchmark report). Optional — when omitted the mutation is
   * project-scoped and only the project's existence in the ownership set is
   * verified. When present it MUST be one of the project's server-side
   * branches or the mutation is refused.
   */
  clientLocaleBranchId?: string;
};

/**
 * Resolve the authoritative project + branch scope for a mutation from the
 * server-side ownership lookup. See {@link ProjectMutationScopeError} for the
 * rejection semantics and the module docblock for the full policy.
 */
export async function resolveProjectMutationScope(
  lookup: ProjectBranchOwnershipLookup,
  input: ResolveProjectMutationScopeInput,
): Promise<ProjectMutationScope> {
  const branches = await lookup.listLocaleBranchIdentities(input.projectId);
  if (branches.length === 0) {
    throw new ProjectMutationScopeError(
      "unknown_project",
      `project ${input.projectId} has no server-side locale branches; refusing to mutate an unknown or out-of-scope project (client-supplied project state cannot authorize a mutation the server cannot attribute to an owned project)`,
    );
  }

  if (input.clientLocaleBranchId === undefined) {
    return { projectId: input.projectId, branches, localeBranchId: null, branch: null };
  }

  const branch = branches.find(
    (candidate) =>
      candidate.localeBranchId === input.clientLocaleBranchId &&
      candidate.projectId === input.projectId,
  );
  if (branch === undefined) {
    throw new ProjectMutationScopeError(
      "foreign_branch",
      `locale branch ${input.clientLocaleBranchId} is not a server-side branch of project ${input.projectId}; refusing a client-supplied branch id outside the project's ownership scope`,
    );
  }

  return {
    projectId: input.projectId,
    branches,
    localeBranchId: branch.localeBranchId,
    branch,
  };
}

/**
 * The authoritative scope for a mutation that ALWAYS names a branch (a route
 * carrying a full `ProjectState` or a self-identifying benchmark report). Like
 * {@link resolveProjectMutationScope} but the branch is required, so the
 * returned `localeBranchId` / `branch` are non-null: a foreign / forged branch
 * id (or an unknown project) is refused with {@link ProjectMutationScopeError}.
 */
export type OwnedBranchScope = {
  projectId: string;
  localeBranchId: string;
  branch: LocaleBranchIdentity;
};

export async function requireOwnedBranchScope(
  lookup: ProjectBranchOwnershipLookup,
  input: { projectId: string; localeBranchId: string },
): Promise<OwnedBranchScope> {
  const scope = await resolveProjectMutationScope(lookup, {
    projectId: input.projectId,
    clientLocaleBranchId: input.localeBranchId,
  });
  // resolveProjectMutationScope always returns a non-null branch when a
  // clientLocaleBranchId is supplied (else it throws); assert to narrow.
  if (scope.branch === null) {
    throw new ProjectMutationScopeError(
      "foreign_branch",
      `locale branch ${input.localeBranchId} is not a server-side branch of project ${input.projectId}`,
    );
  }
  return {
    projectId: scope.projectId,
    localeBranchId: scope.branch.localeBranchId,
    branch: scope.branch,
  };
}
