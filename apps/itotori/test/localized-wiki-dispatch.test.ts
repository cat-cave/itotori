// Certified localizer-profile dispatch proofs.
//
// These use an injected CallSpec -> CallResult responder: no provider is touched,
// while the observable specs prove that the bible writer and its two decision
// reviewers remain on the single certified model route.

import { describe, expect, it } from "vitest";

import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
} from "../src/contracts/index.js";
import {
  createDispatchDecisionReviewer,
  createDispatchLocalizerRunner,
  planLocalizedWiki,
  reviewDecision,
  type LocalizedWikiDispatchRefs,
  type RenderingStamp,
} from "../src/localized-wiki/index.js";
import { sha } from "./support/gate-fixtures.js";
import {
  LOC_SNAP,
  RUN_MODE,
  TARGET_LANG,
  makeRendering,
  sourceWiki,
} from "./support/localized-wiki-fixtures.js";

const CONTEXT_SNAPSHOT = sha("localized-wiki-dispatch-context");

function refs(): LocalizedWikiDispatchRefs {
  let ordinal = 0;
  return {
    contextSnapshotId: CONTEXT_SNAPSHOT,
    sealPayload(plaintext): EncryptedPayloadRef {
      ordinal += 1;
      return {
        storageRef: `payload:${ordinal}`,
        contentHash: sha(plaintext),
        encryption: "operator-managed",
      };
    },
  };
}

function success(value: unknown): CallResult {
  return {
    schemaVersion: "itotori.call-result.v2",
    memoKey: sha("localized-wiki-memo"),
    requested: { model: "deepseek/deepseek-v4-flash" },
    memoHit: true,
    status: "success",
    value,
    responseEventId: sha("localized-wiki-response"),
    served: { status: "confirmed", model: "deepseek/deepseek-v4-flash", provider: "provider:test" },
    generationId: "generation:localized-wiki",
    verification: "verified",
    usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.001" },
    events: [{ kind: "run-started", iteration: 0 }],
  } as CallResult;
}

function stamp(): RenderingStamp {
  return { targetLanguage: TARGET_LANG, localizationSnapshotId: LOC_SNAP, runMode: RUN_MODE };
}

describe("localized Wiki certified dispatch", () => {
  it("routes a rendering through the P1 localizer profile with a localized-rendering terminal", async () => {
    const step = planLocalizedWiki(sourceWiki(), TARGET_LANG, "production").phases[0]!.steps[0]!;
    const seen: CallSpec[] = [];
    const runner = createDispatchLocalizerRunner({
      refs: refs(),
      dispatch: async (spec) => {
        seen.push(spec);
        return success(makeRendering(step, stamp()));
      },
    });

    const produced = await runner({
      tier: step.tier,
      decisionClass: step.decisionClass,
      sourceObject: step.sourceObject,
      target: step.target,
      stamp: stamp(),
    });

    expect(produced).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      purpose: "draft",
      roleId: "P1",
      requestedModel: "deepseek/deepseek-v4-flash",
      output: { name: "localized-rendering" },
      contextScope: "whole-game",
    });
    expect(seen[0]!.providerPolicy).toMatchObject({ zdr: true, dataCollection: "deny" });
  });

  it("runs the name decision through Q3 then Q2 on certified reviewer profiles", async () => {
    const step = planLocalizedWiki(sourceWiki(), TARGET_LANG, "production").phases[0]!.steps.find(
      (candidate) => candidate.decisionClass === "L-Name",
    )!;
    const rendering = makeRendering(step, stamp());
    const seenRoles: string[] = [];
    const reviewer = createDispatchDecisionReviewer({
      refs: refs(),
      dispatch: async (spec) => {
        seenRoles.push(spec.roleId);
        const role = spec.roleId === "Q2" ? "Q2" : "Q3";
        return success({
          schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
          reviewId: `review:${role}`,
          localizationSnapshotId: LOC_SNAP,
          roleId: role,
          rubric: role === "Q2" ? "voice" : "terminology",
          unitId: rendering.renderingId,
          basis: { kind: "wiki-first", bibleRenderingIds: [rendering.renderingId] },
          verdict: "PASS",
          severity: "none",
          span: null,
          category: null,
          evidenceIds: ["source:decision"],
          repairConstraint: null,
        });
      },
    });

    const decision = await reviewDecision(
      { decisionClass: "L-Name", sourceObject: step.sourceObject, rendering, stamp: stamp() },
      reviewer,
    );

    expect(decision.validated).toBe(true);
    expect(seenRoles).toEqual(["Q3", "Q2"]);
  });
});
