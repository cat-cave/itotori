// Q1's grounded context + persistable review artifact proof.
//
// This suite deliberately uses the real specialist-read-surface
// implementations over the committed bridge fixture.  The only recorded
// seam is the model transport; source facts, neighbor windows, glossary
// facts, and accepted-target history are all read from the
// snapshot-pinned local surface.

import type { LlmRevisionRef } from "@itotori/db";
import { describe, expect, it } from "vitest";

import type {
  CallResult,
  CallSpec,
  Defect,
  DraftBatch,
  EncryptedPayloadRef,
} from "../src/contracts/index.js";
import {
  q1UserPrompt,
  readQ1ReviewInput,
  runQ1Review,
  type Q1DispatchRefs,
} from "../src/roles/q1/index.js";
import type { ReadModel } from "../src/read-tools/index.js";
import { makeAccepted, sha } from "./support/gate-fixtures.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const LOC_SNAPSHOT = `sha256:${"c".repeat(64)}` as const;
const PARENT = `sha256:${"d".repeat(64)}` as const;
const MEMO = `sha256:${"e".repeat(64)}` as const;
const LOCALE_BRANCH = "locale:q1";

const revision: LlmRevisionRef = {
  revisionId: "revision:q1-glossary",
  contentHash: `sha256:${"f".repeat(64)}`,
};

function q1Model(): {
  readonly model: ReadModel;
  readonly unit: ReturnType<typeof buildClaimFixture>["snapshot"]["orderedUnits"][number];
} {
  const fixture = buildClaimFixture();
  const unit = fixture.snapshot.orderedUnits[0]!;
  const accepted = makeAccepted(unit, "An earlier accepted target.", {
    outputId: "output:q1:neighbor",
  });
  return {
    unit,
    model: {
      ...fixture.model,
      localization: {
        localizationSnapshotId: LOC_SNAPSHOT,
        targetLocale: "en-US",
        localeBranchId: LOCALE_BRANCH,
        glossaryRevision: revision,
        glossaryEntries: [
          {
            kind: "glossary-entry",
            termId: "term:station",
            sourceForm: "駅",
            aliases: [],
            forms: [{ language: "en-US", form: "Station", status: "preferred" }],
            scope: { kind: "global" },
            occurrenceUnitIds: [unit.factId],
            conflictsWithTermIds: [],
            revision,
          },
        ],
        acceptedOutputs: [{ ...accepted, localizationSnapshotId: LOC_SNAPSHOT }],
      },
    },
  };
}

function candidateBatch(
  unitId: string,
  sourceHash: `sha256:${string}`,
  target: string,
): DraftBatch {
  return {
    schemaVersion: "itotori.draft-batch.v1",
    localizationSnapshotId: LOC_SNAPSHOT,
    batchId: "batch:q1-reviewed",
    scope: { kind: "whole-scene", sceneId: "1", expectedUnitIds: [unitId] },
    drafts: [
      {
        unitId,
        sourceHash,
        // Deliberately carries a placeholder and a Shift-JIS-representable
        // character. Q1's artifact must preserve this target byte surface.
        targetSkeleton: target,
        evidenceIds: [unitId],
        basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:term:station"] },
        uncertainty: ["none"],
      },
    ],
  };
}

function passResult(unitId: string, contextSnapshotId: `sha256:${string}`): CallResult {
  return {
    schemaVersion: "itotori.call-result.v2",
    memoKey: MEMO,
    requested: { model: "deepseek/deepseek-v4-flash" },
    memoHit: true,
    status: "success",
    value: {
      schemaVersion: "itotori.review-verdict.v1",
      reviewId: "review:q1:recorded",
      localizationSnapshotId: LOC_SNAPSHOT,
      roleId: "Q1",
      rubric: "meaning",
      unitId,
      basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:term:station"] },
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      evidenceIds: [unitId],
      repairConstraint: null,
    },
    responseEventId: contextSnapshotId,
    served: { status: "confirmed", model: "deepseek/deepseek-v4-flash", provider: "recorded" },
    generationId: "generation:q1:recorded",
    verification: "verified",
    usage: { promptTokens: 10, completionTokens: 10, reasoningTokens: 0, cachedTokens: 10 },
    billing: { status: "confirmed", costUsd: "0.000" },
    events: [{ kind: "run-started", iteration: 0 }],
  } as unknown as CallResult;
}

function refs(contextSnapshotId: `sha256:${string}`): Q1DispatchRefs {
  return {
    parentEventId: PARENT,
    contextSnapshotId,
    localizationSnapshotId: LOC_SNAPSHOT,
    runMode: "test-dev",
    sealPayload: (plaintext): EncryptedPayloadRef => ({
      storageRef: `recorded:q1:${plaintext.length}`,
      contentHash: sha(plaintext),
      encryption: "operator-managed",
    }),
  };
}

describe("Q1 uses snapshot-pinned local reads and emits a provisional review artifact", () => {
  it("PROOF: Q1 sees authoritative source, localized bible text, source + target windows, and glossary facts", () => {
    const { model, unit } = q1Model();
    const input = readQ1ReviewInput(model, {
      routeVisibility: { kind: "global" },
      localeBranchId: LOCALE_BRANCH,
      unitId: unit.factId,
      candidateTarget: "Station {{name}} 表",
      localizedBible: [
        { renderingId: "rendering:term:station", text: "Render 駅 as Station in this scope." },
      ],
      sourceForms: ["駅"],
      runMode: "test-dev",
      contextScope: "whole-game",
    });

    // The source fact and citation coordinates came from decode_get_units,
    // not the caller's candidate record; the context has also consumed every
    // other read surface Q1 is granted for this line.
    expect(input.sourceFacts[0]?.factId).toBe(unit.factId);
    expect(input.sourceFacts[0]?.evidence.snapshotId).toBe(model.snapshotId);
    expect(input.sourceFacts.some((fact) => fact.factId === "glossary:term:station")).toBe(true);
    expect(input.neighbors.some((window) => window.surface === "source")).toBe(true);
    expect(input.neighbors).toContainEqual({
      surface: "accepted-target",
      unitId: unit.factId,
      text: "An earlier accepted target.",
    });

    const prompt = q1UserPrompt(input);
    expect(prompt).toContain("Render 駅 as Station in this scope.");
    expect(prompt).toContain("AUTHORITATIVE SOURCE FACTS:");
  });

  it("PROOF: recorded Q1 output becomes a cited, provisional translation WikiObject without altering the candidate", async () => {
    const { model, unit } = q1Model();
    const target = "Station {{name}} 表";
    const input = readQ1ReviewInput(model, {
      routeVisibility: { kind: "global" },
      localeBranchId: LOCALE_BRANCH,
      unitId: unit.factId,
      candidateTarget: target,
      localizedBible: [
        { renderingId: "rendering:term:station", text: "Render 駅 as Station in this scope." },
      ],
      sourceForms: ["駅"],
      runMode: "test-dev",
      contextScope: "whole-game",
    });
    const batch = candidateBatch(unit.factId, unit.sourceHash, target);
    const outcome = await runQ1Review(input, refs(model.snapshotId), {
      dispatch: async (_spec: CallSpec) => passResult(unit.factId, model.snapshotId),
      resolveEvidence: (evidenceId) => ({ resolved: evidenceId === unit.factId, visible: true }),
      artifactContext: {
        candidateBatch: batch,
        dependencies: [
          {
            upstreamObjectId: "localized:term:station",
            upstreamVersion: 1,
            claimId: null,
            fieldPath: ["body"],
            renderingId: "rendering:term:station",
            scope: { kind: "global" },
            fromPlayOrder: 0,
            throughPlayOrder: null,
          },
        ],
        validationModel: model,
        runMode: "test-dev",
        contextScope: "whole-game",
      },
    });

    expect(outcome.outcome).toBe("reviewed");
    if (outcome.outcome !== "reviewed") throw new Error("recorded Q1 should review");
    expect(outcome.canFinalize).toBe(true);
    expect(outcome.artifact).not.toBeNull();
    const artifact = outcome.artifact!;
    expect(artifact.kind).toBe("translation");
    expect(artifact.provisional).toBe(true);
    expect(artifact.provenance).toMatchObject({
      authorRoleId: "Q1",
      authorMemoKey: MEMO,
      contextSnapshotId: model.snapshotId,
      localizationSnapshotId: LOC_SNAPSHOT,
      runMode: "test-dev",
    });
    expect(artifact.claims[0]?.citations[0]?.evidenceId).toBe(unit.factId);
    expect(artifact.body.draftBatch.drafts[0]?.targetSkeleton).toBe(target);
  });

  it("PROOF: a deterministic gate fact dominates a recorded Q1 PASS", async () => {
    const { model, unit } = q1Model();
    const input = readQ1ReviewInput(model, {
      routeVisibility: { kind: "global" },
      localeBranchId: LOCALE_BRANCH,
      unitId: unit.factId,
      candidateTarget: "Station {{name}} 表",
      localizedBible: [
        { renderingId: "rendering:term:station", text: "Render 駅 as Station in this scope." },
      ],
      runMode: "test-dev",
      contextScope: "whole-game",
    });
    const deterministic: Defect = {
      origin: "deterministic",
      defectId: "defect:q1:glossary",
      unitId: unit.factId,
      severity: "major",
      span: null,
      evidenceIds: [unit.factId],
      basisFactIds: [unit.factId],
      repairConstraint: "Use the deterministic canonical form.",
      implicatedGates: ["glossary-exact"],
      implicatedReviewLanes: ["Q1"],
      category: "glossary-exact",
      gate: "glossary-exact",
    };
    const outcome = await runQ1Review(input, refs(model.snapshotId), {
      dispatch: async (_spec: CallSpec) => passResult(unit.factId, model.snapshotId),
      resolveEvidence: () => ({ resolved: true, visible: true }),
      deterministicDefects: [deterministic],
    });

    expect(outcome.outcome).toBe("reviewed");
    if (outcome.outcome !== "reviewed") throw new Error("recorded Q1 should review");
    expect(outcome.interpretation.verdict.verdict).toBe("PASS");
    expect(outcome.canFinalize).toBe(false);
    expect(outcome.dominatingFactIds).toEqual(["defect:q1:glossary"]);
  });
});
