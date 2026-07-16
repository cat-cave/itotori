// Fresh project/branch provisioning + exact requested-run addressing.
//
// The new pipeline provisions a project and locale branch IN PLACE — a fresh run
// never requires a global database reset. A specific requested run is addressable
// by its id, so an operator can resume or inspect exactly the run they asked for
// without touching any other project's state.
//
// This module composes a minimal structural provisioning port. Production binds
// it to the real project repository; a proof binds an in-memory double. The port
// is deliberately narrow — it never reaches the legacy service graph, so the
// composition root's import closure stays clean.

/** A provisioned project identity. */
export interface ProvisionedProject {
  readonly projectId: string;
  readonly created: boolean;
}

/** A provisioned locale branch identity, bound to its project. */
export interface ProvisionedBranch {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly targetLocale: string;
  readonly created: boolean;
}

/** An addressable run identity, bound to a project + branch. */
export interface AddressableRun {
  readonly runId: string;
  readonly projectId: string;
  readonly localeBranchId: string;
}

/** The narrow provisioning substrate the entrypoint composes. Every operation is
 * scoped to a single project/branch/run — none touches global state. */
export interface ProvisioningStore {
  /** Whether a project already exists — provisioning is idempotent, never a reset. */
  hasProject(projectId: string): Promise<boolean>;
  /** Provision the project in place (no-op returning `created:false` if present). */
  ensureProject(projectId: string): Promise<ProvisionedProject>;
  /** Provision a locale branch under an existing project, in place. */
  ensureLocaleBranch(input: {
    readonly projectId: string;
    readonly localeBranchId: string;
    readonly targetLocale: string;
  }): Promise<ProvisionedBranch>;
  /** Address exactly one run by id, or null if it does not exist. Never a reset. */
  findRun(runId: string): Promise<AddressableRun | null>;
}

/** A requested provisioning of a fresh project + locale branch. */
export interface ProvisionRequest {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly targetLocale: string;
}

/** The result of provisioning a fresh project/branch in place. */
export interface ProvisionResult {
  readonly project: ProvisionedProject;
  readonly branch: ProvisionedBranch;
}

/** A requested run that does not exist — surfaced in-band, never a global reset. */
export class RequestedRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`requested run '${runId}' does not exist`);
    this.name = "RequestedRunNotFoundError";
  }
}

/**
 * Provision a fresh project + locale branch IN PLACE. Idempotent: an existing
 * project/branch is reused (never dropped), a fresh one is created — no other
 * project's state is touched and no global reset is performed.
 */
export async function provisionProjectBranch(
  store: ProvisioningStore,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const project = await store.ensureProject(request.projectId);
  const branch = await store.ensureLocaleBranch({
    projectId: request.projectId,
    localeBranchId: request.localeBranchId,
    targetLocale: request.targetLocale,
  });
  return { project, branch };
}

/**
 * Address exactly the requested run by id. Returns the run if it exists; throws
 * a typed `RequestedRunNotFoundError` otherwise. It never resets or enumerates
 * global state — it resolves the ONE run the caller asked for.
 */
export async function addressRequestedRun(
  store: ProvisioningStore,
  runId: string,
): Promise<AddressableRun> {
  const run = await store.findRun(runId);
  if (run === null) {
    throw new RequestedRunNotFoundError(runId);
  }
  return run;
}
