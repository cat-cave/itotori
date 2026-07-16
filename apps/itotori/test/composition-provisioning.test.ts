import { describe, expect, it } from "vitest";

import {
  addressRequestedRun,
  provisionProjectBranch,
  RequestedRunNotFoundError,
  type AddressableRun,
  type ProvisionedBranch,
  type ProvisionedProject,
  type ProvisioningStore,
} from "../src/composition/index.js";

// Clause 3: fresh project/branch provisioning + exact requested-run addressing
// work WITHOUT a global DB reset. This in-memory store models the substrate; the
// port exposes NO reset — provisioning is idempotent and in place, and a specific
// requested run is addressable by id.

class InMemoryProvisioningStore implements ProvisioningStore {
  readonly projects = new Set<string>();
  readonly branches = new Set<string>();
  readonly runs = new Map<string, AddressableRun>();

  async hasProject(projectId: string): Promise<boolean> {
    return this.projects.has(projectId);
  }
  async ensureProject(projectId: string): Promise<ProvisionedProject> {
    const created = !this.projects.has(projectId);
    this.projects.add(projectId);
    return { projectId, created };
  }
  async ensureLocaleBranch(input: {
    projectId: string;
    localeBranchId: string;
    targetLocale: string;
  }): Promise<ProvisionedBranch> {
    const key = `${input.projectId}/${input.localeBranchId}`;
    const created = !this.branches.has(key);
    this.branches.add(key);
    return { ...input, created };
  }
  async findRun(runId: string): Promise<AddressableRun | null> {
    return this.runs.get(runId) ?? null;
  }
}

describe("composition provisioning — fresh project/branch in place, no global reset", () => {
  it("provisions a fresh project + branch (created) and is idempotent on re-provision", async () => {
    const store = new InMemoryProvisioningStore();
    const first = await provisionProjectBranch(store, {
      projectId: "proj-A",
      localeBranchId: "en-US",
      targetLocale: "en-US",
    });
    expect(first.project.created).toBe(true);
    expect(first.branch.created).toBe(true);

    // Re-provision the SAME project/branch: reused in place, never dropped.
    const again = await provisionProjectBranch(store, {
      projectId: "proj-A",
      localeBranchId: "en-US",
      targetLocale: "en-US",
    });
    expect(again.project.created).toBe(false);
    expect(again.branch.created).toBe(false);
  });

  it("provisions a second project without touching the first (no global reset)", async () => {
    const store = new InMemoryProvisioningStore();
    await provisionProjectBranch(store, {
      projectId: "proj-A",
      localeBranchId: "en-US",
      targetLocale: "en-US",
    });
    const second = await provisionProjectBranch(store, {
      projectId: "proj-B",
      localeBranchId: "ja-JP",
      targetLocale: "ja-JP",
    });
    expect(second.project.created).toBe(true);
    // The first project survived the second's provisioning.
    expect(await store.hasProject("proj-A")).toBe(true);
    expect(await store.hasProject("proj-B")).toBe(true);
    // The port exposes no reset — provisioning is strictly additive/in-place.
    expect("reset" in store).toBe(false);
  });

  it("addresses exactly the requested run by id, and refuses a missing run in-band", async () => {
    const store = new InMemoryProvisioningStore();
    store.runs.set("run-42", {
      runId: "run-42",
      projectId: "proj-A",
      localeBranchId: "en-US",
    });
    const addressed = await addressRequestedRun(store, "run-42");
    expect(addressed.runId).toBe("run-42");
    expect(addressed.projectId).toBe("proj-A");

    await expect(addressRequestedRun(store, "run-nope")).rejects.toBeInstanceOf(
      RequestedRunNotFoundError,
    );
  });
});
