import { describe, expect, it } from "vitest";

import {
  PURE_MTL_WORKFLOW_MEMO_PREFIX,
  resolveWorkflowPolicy,
  workflowMemoKeyFor,
} from "../src/workflow/index.js";
import { PRODUCTION, TEST_DEV_NARROWED, TEST_WORKFLOW_MEMO_IDENTITY } from "./workflow.support.js";

function draftKey(
  identity = TEST_WORKFLOW_MEMO_IDENTITY,
  policy = resolveWorkflowPolicy(PRODUCTION),
) {
  return workflowMemoKeyFor({
    identity,
    policy,
    step: "draft",
    role: "P1",
    parts: ["scene.memo", "whole-scene", ["unit.memo"]],
  });
}

describe("workflow durable memo identity", () => {
  it("partitions logical steps by project, model route, and resolved policy", () => {
    const baseline = draftKey();
    const anotherProject = draftKey({
      ...TEST_WORKFLOW_MEMO_IDENTITY,
      projectId: "workflow-test-project-other",
    });
    const anotherModel = draftKey({
      ...TEST_WORKFLOW_MEMO_IDENTITY,
      roleRoutes: {
        ...TEST_WORKFLOW_MEMO_IDENTITY.roleRoutes,
        P1: {
          ...TEST_WORKFLOW_MEMO_IDENTITY.roleRoutes.P1,
          requestedModel: "fixture-model:P1:alternate",
          modelProfileVersion: "fixture-profile:P1:alternate",
        },
      },
    });
    const anotherProviderPolicy = draftKey({
      ...TEST_WORKFLOW_MEMO_IDENTITY,
      roleRoutes: {
        ...TEST_WORKFLOW_MEMO_IDENTITY.roleRoutes,
        P1: {
          ...TEST_WORKFLOW_MEMO_IDENTITY.roleRoutes.P1,
          providerPolicy: {
            ...TEST_WORKFLOW_MEMO_IDENTITY.roleRoutes.P1.providerPolicy,
            dataCollection: "allow",
          },
        },
      },
    });
    const anotherPolicy = draftKey(
      TEST_WORKFLOW_MEMO_IDENTITY,
      resolveWorkflowPolicy({ ...PRODUCTION, outputScope: "all" }),
    );

    expect(anotherProject).not.toBe(baseline);
    expect(anotherModel).not.toBe(baseline);
    expect(anotherProviderPolicy).not.toBe(baseline);
    expect(anotherPolicy).not.toBe(baseline);
  });

  it("partitions patchback and Q5 by their render plan without perturbing P1", () => {
    const renderPlan = {
      sourceRoot: "/fixture/source-a",
      buildRoot: "/fixture/build-a",
      patchScope: "dialogue-only",
      runId: TEST_WORKFLOW_MEMO_IDENTITY.runId,
      backgroundAsset: "background-a",
    };
    const first = { ...TEST_WORKFLOW_MEMO_IDENTITY, renderPlan };
    const second = {
      ...TEST_WORKFLOW_MEMO_IDENTITY,
      renderPlan: { ...renderPlan, backgroundAsset: "background-b" },
    };
    const policy = resolveWorkflowPolicy(PRODUCTION);
    const keyFor = (identity: typeof first) =>
      workflowMemoKeyFor({
        identity,
        policy,
        step: "build-lqa",
        role: "Q5",
        parts: ["patch.shared", "unit.memo"],
      });

    expect(keyFor(second)).not.toBe(keyFor(first));
    expect(draftKey(second, policy)).toBe(draftKey(first, policy));
  });

  it("keeps a restart cache hit across a lease-owner change and preserves the control prefix", () => {
    const firstLease = { ...TEST_WORKFLOW_MEMO_IDENTITY, leaseOwnerId: "lease-owner-first" };
    const resumedLease = { ...TEST_WORKFLOW_MEMO_IDENTITY, leaseOwnerId: "lease-owner-resumed" };
    const pureMtl = resolveWorkflowPolicy({
      ...TEST_DEV_NARROWED,
      ablation: { kind: "pure-mtl" },
    });

    expect(draftKey(firstLease)).toBe(draftKey(resumedLease));
    expect(draftKey(TEST_WORKFLOW_MEMO_IDENTITY, pureMtl)).toMatch(
      new RegExp(`^${PURE_MTL_WORKFLOW_MEMO_PREFIX}`),
    );
  });
});
