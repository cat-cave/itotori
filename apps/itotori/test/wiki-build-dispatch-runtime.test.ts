import type { LlmCallMemoStore } from "@itotori/db";
import { describe, expect, it } from "vitest";

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type RoleId,
} from "../src/contracts/index.js";
import { createAnalystDispatchRuntime, type WikiBuildDeps } from "../src/composition/index.js";
import { resolveAttemptDeadlineMs } from "../src/llm/physical-attempt-policy.js";
import { resolveRoleModelProfile } from "../src/llm/role-model-profiles.js";
import { specialistFor } from "../src/roster/index.js";
import { ANALYST_ROLE_IDS } from "../src/source-wiki/index.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;

const memoStore: LlmCallMemoStore = {
  async singleflight() {
    throw new Error("the runtime-profile proof never opens a physical attempt");
  },
};

const wikiDispatchDeps: Pick<
  WikiBuildDeps,
  "dispatch" | "memoStore" | "contentAccess" | "dispatchSnapshots"
> = {
  dispatch: {
    // Deliberately the P1/localize profile: the wiki builder must replace this
    // identity with the dispatched analyst role's certified profile.
    profile: {
      name: "draft",
      version: "localize-profile:v1",
      deadlines: { normalMs: 1, deepMs: 1 },
      maxAttemptExposureUsd: "0.01",
    },
    admission: { scope: "wiki-profile-proof", confirmedCostCapUsd: "1" },
  },
  memoStore,
  contentAccess: { async requireContentRead() {} },
  dispatchSnapshots: {
    decodeRevisionHash: HASH_A,
    glossaryRevisionHash: HASH_B,
    styleRevisionHash: HASH_A,
    acceptedOutputHeadHash: null,
  },
};

function analystCallSpec(role: RoleId): CallSpec {
  const profile = resolveRoleModelProfile(role);
  const specialist = specialistFor(role);
  return {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: role,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
    parentEventId: HASH_A,
    contextSnapshotId: HASH_A,
    localizationSnapshotId: null,
    messages: [],
    tools: [],
    output: {
      name: "wiki-object",
      schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
      schemaHash: HASH_B,
    },
    promptVersion: "wiki-profile-proof:v1",
    reasoning: specialist.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: specialist.limits,
    sampleId: null,
    runMode: "test-dev",
    contextScope: "whole-game",
  };
}

describe("wiki-build analyst dispatch runtimes", () => {
  it("accepts every analyst CallSpec at the physical dispatch profile assertion", () => {
    for (const role of ANALYST_ROLE_IDS) {
      const runtime = createAnalystDispatchRuntime({
        deps: wikiDispatchDeps,
        payloads: new Map(),
        role,
      });
      const profile = resolveRoleModelProfile(role);

      expect(runtime.memo.profile).toEqual({
        name: profile.modelProfile,
        version: profile.version,
        deadlines: { normalMs: 30_000, deepMs: 300_000 },
        maxAttemptExposureUsd: "0.01",
      });
      // `resolveAttemptDeadlineMs` invokes dispatch's profile assertion before
      // a physical request is opened; this is the precise failure point that
      // previously rejected A1–A10 after the runner reused P1's runtime.
      expect(() =>
        resolveAttemptDeadlineMs(analystCallSpec(role), runtime.memo.profile),
      ).not.toThrow();
    }
  });
});
