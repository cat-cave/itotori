import type { LocaleBranchIdentity } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectMutationScopeError,
  requireOwnedBranchScope,
  resolveProjectMutationScope,
  type ProjectBranchOwnershipLookup,
} from "../src/services/project-mutation-scope.js";

/**
 * ITOTORI-050 — the scoping policy is exercised entirely against a synthetic,
 * in-memory ownership oracle (no DB): the same `listLocaleBranchIdentities`
 * contract the repository fulfils via `where project_id = <projectId>`. The
 * DB-backed lookup is covered separately by the repository integration tests.
 */
function ownershipLookup(ownedByProject: Record<string, string[]>): ProjectBranchOwnershipLookup {
  return {
    listLocaleBranchIdentities: vi.fn(
      async (projectId: string): Promise<LocaleBranchIdentity[]> =>
        (ownedByProject[projectId] ?? []).map((localeBranchId) => ({
          localeBranchId,
          projectId,
          sourceBundleId: `${projectId}:bundle`,
          sourceBundleRevisionId: `${projectId}:bundle:rev`,
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          branchName: localeBranchId,
          status: "active",
        })),
    ),
  };
}

describe("resolveProjectMutationScope (ITOTORI-050)", () => {
  it("rejects an unknown / out-of-scope project (no server-side branches)", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    await expect(
      resolveProjectMutationScope(lookup, {
        projectId: "project-foreign",
        clientLocaleBranchId: "locale-1",
      }),
    ).rejects.toMatchObject({
      name: "ProjectMutationScopeError",
      reason: "unknown_project",
    });
  });

  it("rejects a client-supplied branch id that is not owned by the project", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    await expect(
      resolveProjectMutationScope(lookup, {
        projectId: "project-1",
        clientLocaleBranchId: "locale-forged",
      }),
    ).rejects.toMatchObject({
      name: "ProjectMutationScopeError",
      reason: "foreign_branch",
    });
  });

  it("does not treat a branch owned by ANOTHER project as in-scope", async () => {
    // The forged branch id is a real branch — but of project-2, not project-1.
    const lookup = ownershipLookup({
      "project-1": ["locale-1"],
      "project-2": ["locale-2"],
    });

    await expect(
      resolveProjectMutationScope(lookup, {
        projectId: "project-1",
        clientLocaleBranchId: "locale-2",
      }),
    ).rejects.toMatchObject({ reason: "foreign_branch" });
  });

  it("returns the authoritative server-side branch for an in-scope id", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1", "locale-2"] });

    const scope = await resolveProjectMutationScope(lookup, {
      projectId: "project-1",
      clientLocaleBranchId: "locale-2",
    });

    expect(scope.projectId).toBe("project-1");
    expect(scope.localeBranchId).toBe("locale-2");
    expect(scope.branch).toMatchObject({ localeBranchId: "locale-2", projectId: "project-1" });
  });

  it("verifies the project but returns a null branch when no branch id is supplied", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    const scope = await resolveProjectMutationScope(lookup, { projectId: "project-1" });

    expect(scope.projectId).toBe("project-1");
    expect(scope.localeBranchId).toBeNull();
    expect(scope.branch).toBeNull();
    expect(scope.branches).toHaveLength(1);
  });

  it("still rejects an unknown project even when no branch id is supplied", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    await expect(
      resolveProjectMutationScope(lookup, { projectId: "project-foreign" }),
    ).rejects.toMatchObject({ reason: "unknown_project" });
  });
});

describe("requireOwnedBranchScope (ITOTORI-050)", () => {
  it("returns a non-null branch scope for an in-scope id", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    const scope = await requireOwnedBranchScope(lookup, {
      projectId: "project-1",
      localeBranchId: "locale-1",
    });

    expect(scope).toEqual({
      projectId: "project-1",
      localeBranchId: "locale-1",
      branch: expect.objectContaining({ localeBranchId: "locale-1", projectId: "project-1" }),
    });
  });

  it("throws ProjectMutationScopeError for a foreign branch id", async () => {
    const lookup = ownershipLookup({ "project-1": ["locale-1"] });

    await expect(
      requireOwnedBranchScope(lookup, { projectId: "project-1", localeBranchId: "locale-forged" }),
    ).rejects.toBeInstanceOf(ProjectMutationScopeError);
  });
});
