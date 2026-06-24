import type { AssetDecisionRecord, AuthorizationActor } from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { AssetDecisionPolicyResolver } from "../src/asset-decisions/policy-resolver.js";
import {
  assetDecisionFixtureRef,
  fullLocalizeFixture,
  keepOriginalFixture,
  romanizeFixture,
  skipFixture,
  swapWithReplacementFixture,
  translateTextFixture,
} from "../src/asset-decisions/decision-fixtures.js";

const actor: AuthorizationActor = { userId: "user-test" };
const projectId = "project-asset-fixture";
const localeBranchId = "locale-asset-fixture";

function repositoryReturning(records: AssetDecisionRecord[]) {
  return {
    loadActiveDecisions: vi.fn(async () => records),
  };
}

describe("AssetDecisionPolicyResolver", () => {
  it("returns the unresolved shape with reason 'no_decision' when no decision is recorded", async () => {
    const repository = repositoryReturning([]);
    const resolver = new AssetDecisionPolicyResolver(repository);
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      assetDecisionFixtureRef("asset.json#missing"),
    );
    expect(resolution).toEqual({ policy: "unresolved", reason: "no_decision" });
    expect(repository.loadActiveDecisions).toHaveBeenCalledTimes(1);
  });

  it("resolves to keep_original when a keep-original decision is recorded", async () => {
    const decision = keepOriginalFixture();
    const repository = repositoryReturning([decision]);
    const resolver = new AssetDecisionPolicyResolver(repository);
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution).toEqual({
      policy: "keep_original",
      rationale: "fixture rationale",
      decidedAt: decision.decidedAt,
      decidedByUserId: "user-fixture",
    });
  });

  it("resolves to translate_text when a translate-text decision is recorded", async () => {
    const decision = translateTextFixture();
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution.policy).toBe("translate_text");
  });

  it("resolves to swap_with_replacement when a swap decision is recorded", async () => {
    const decision = swapWithReplacementFixture();
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution.policy).toBe("swap_with_replacement");
  });

  it("resolves to romanize when a romanize decision is recorded", async () => {
    const decision = romanizeFixture();
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution.policy).toBe("romanize");
  });

  it("resolves to full_localize when a full-localize decision is recorded", async () => {
    const decision = fullLocalizeFixture();
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution.policy).toBe("full_localize");
  });

  it("resolves to skip when a skip decision is recorded", async () => {
    const decision = skipFixture();
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution.policy).toBe("skip");
  });

  it("returns unresolved when active decisions exist for the locale but not for the requested ref", async () => {
    const otherDecision = keepOriginalFixture({
      assetRef: { kind: "bridgeAssetRef", ref: "asset.json#unrelated" },
    });
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([otherDecision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      assetDecisionFixtureRef("asset.json#requested"),
    );
    expect(resolution).toEqual({ policy: "unresolved", reason: "no_decision" });
  });

  it("omits the rationale field when the decision has no rationale", async () => {
    const decision = translateTextFixture({ decisionRationale: null });
    const resolver = new AssetDecisionPolicyResolver(repositoryReturning([decision]));
    const resolution = await resolver.resolvePolicy(
      actor,
      projectId,
      localeBranchId,
      decision.assetRef,
    );
    expect(resolution).toEqual({
      policy: "translate_text",
      decidedAt: decision.decidedAt,
      decidedByUserId: "user-fixture",
    });
  });
});
