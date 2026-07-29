import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  DEFECT_BUNDLE_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  type DefectBundle,
  type DraftBatch,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { realliveSjisPolicy } from "../src/gates/index.js";
import { specialistFor, toolsForRole } from "../src/roster/index.js";
import {
  assertBlindedGroundedFork,
  assertRepairPatchBatch,
  buildRepairCall,
  normalizeRepairRequest,
  repairSemanticDefects,
  REPAIR_MODE,
  RepairError,
  RepairFinalizeError,
  type RepairCandidateUnit,
  type RepairRequest,
  type RepairRuntimeBase,
} from "../src/roles/p3/index.js";

import {
  DRAFT_PROFILE,
  CTX,
  LOC,
  SCHEMA,
  REV_A,
  REV_B,
  BIBLE,
  PARENT_BATCH,
  BUNDLE_ID,
  MemoryMemoStore,
  sse,
  draftBatchResponse,
  Captured,
  recordedRuntime,
  candidate,
  meaningDefect,
  defectBundle,
  patchDraft,
  repairPatchBatch,
  request,
  OPTIONS,
} from "./p3-semantic-repair.support.js";

describe("P3 semantic repair — fresh blinded grounded fork", () => {
  it("dispatches a fresh grounded fork through the sole ZDR boundary and patches the failed units", async () => {
    const cands = [candidate(0), candidate(1)];
    const captured: Captured[] = [];
    const outcome = await repairSemanticDefects(
      request(cands),
      OPTIONS,
      recordedRuntime(
        [
          draftBatchResponse(
            repairPatchBatch(
              cands,
              cands.map((c) => c.unitId),
            ),
          ),
        ],
        captured,
      ),
    );

    expect(outcome.kind).toBe("repaired");
    if (outcome.kind !== "repaired") throw new Error("expected repaired");
    expect(outcome.resolution).toBe("repair");
    expect(outcome.provisional).toBe(true);
    expect(outcome.patches.map((p) => p.unitId)).toEqual(cands.map((c) => c.unitId));
    expect(outcome.repairedDefectIds).toEqual(["defect:0", "defect:1"]);

    // dispatched through the sole ZDR boundary: no provider pin, exact model.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
  });

  it("builds a call with no author-thread turn, no author identity, and real grounding", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    const call = buildRepairCall({
      specialist: specialistFor("P3"),
      normalized,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });

    // FRESH FORK: exactly a system turn and a user turn — no assistant author thread.
    const roles = call.spec.messages.map((m) => (m.kind === "text" ? m.role : m.kind));
    expect(roles).toEqual(["system", "user"]);
    expect(roles).not.toContain("assistant");
    expect(call.spec.purpose).toBe("repair");

    // GROUNDED + BLINDED: the seed carries source + bible, and NO author identity.
    const userRef =
      call.spec.messages[1]?.kind === "text"
        ? call.spec.messages[1].contentEncrypted.storageRef
        : "";
    const seedText = call.payloads.get(userRef)!;
    expect(seedText).toContain(cands[0]!.sourceSkeleton);
    expect(seedText).toContain(BIBLE[0]);
    expect(seedText).toContain("Pinned meaning evidence");
    expect(seedText).toContain("Use neutral register");
    for (const key of [
      "authoredBy",
      "producedBy",
      "producingRole",
      "authorRole",
      "authorModel",
      "priorAuthor",
    ]) {
      expect(seedText).not.toContain(key);
    }
    expect(seedText).not.toContain("P1");

    // The blinded/grounded guard accepts it.
    expect(() => assertBlindedGroundedFork(call)).not.toThrow();
  });

  it("rejects a fork that leaks author identity or drops grounding", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    const call = buildRepairCall({
      specialist: specialistFor("P3"),
      normalized,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    // Tamper: inject an author-identity attribution into the seed payload.
    const userRef =
      call.spec.messages[1]?.kind === "text"
        ? call.spec.messages[1].contentEncrypted.storageRef
        : "";
    const leaked = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"authoredBy":"P1","preDraftContext":{"sourceFacts":[{"sourceSkeleton":"s0"}],"wikiFacts":[{}],"bible":[{}]},"units":[{"sourceSkeleton":"s0"}]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(leaked)).toThrow(RepairFinalizeError);

    // Tamper: drop the grounding (no bible / no source).
    const ungrounded = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"preDraftContext":{"sourceFacts":[],"wikiFacts":[],"bible":[]},"units":[]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(ungrounded)).toThrow(/not-grounded/u);

    const rationaleLeak = {
      ...call,
      payloads: new Map(call.payloads).set(
        userRef,
        `{"priorRepairRationale":"try a synonym","preDraftContext":{"sourceFacts":[{"sourceSkeleton":"s0"}],"wikiFacts":[{}],"bible":[{}]},"units":[{"sourceSkeleton":"s0"}]}`,
      ),
    };
    expect(() => assertBlindedGroundedFork(rationaleLeak)).toThrow(/prior repair rationale/u);
  });
});

describe("P3 semantic repair — minimal patch, failed ids only", () => {
  it("accepts a patch for exactly the failed units and preserves placeholders", () => {
    const cands = [candidate(0), candidate(1)];
    const normalized = normalizeRepairRequest(request(cands));
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );
    expect(() => assertRepairPatchBatch(normalized, batch, realliveSjisPolicy)).not.toThrow();
  });

  it("rejects a patch that touches a PASSING id (not in the failed set)", () => {
    const cands = [candidate(0)];
    const normalized = normalizeRepairRequest(request(cands));
    // A schema-valid patch that inflates the scope with a passing unit + its draft.
    const passing = candidate(9);
    const inflated = repairPatchBatch([cands[0]!, passing], [cands[0]!.unitId, passing.unitId]);
    expect(() => assertRepairPatchBatch(normalized, inflated, realliveSjisPolicy)).toThrow(
      RepairFinalizeError,
    );
    expect(() => assertRepairPatchBatch(normalized, inflated, realliveSjisPolicy)).toThrow(
      /failed-ids-mismatch/u,
    );
  });

  it("rejects a candidate supplied for a passing unit at normalization", () => {
    const cands = [candidate(0)];
    const passing = candidate(9);
    // A candidate whose unit has no defect is a passing unit smuggled in.
    const req: RepairRequest = { ...request(cands), candidates: [cands[0]!, passing] };
    expect(() => normalizeRepairRequest(req)).toThrow(RepairError);
    expect(() => normalizeRepairRequest(req)).toThrow(/candidate-passing-unit/u);
  });

  it("rejects a patch that drops a protected placeholder", () => {
    const ph = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
    const cands = [candidate(0, ph)];
    const normalized = normalizeRepairRequest(request(cands));
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );
    // Overwrite the patch target so the protected placeholder is gone.
    const dropped = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "no placeholder here" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, dropped, realliveSjisPolicy)).toThrow(
      /protected-span/u,
    );

    // A patch that keeps the placeholder is accepted.
    const kept = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "hp {{ph:0}} left" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, kept, realliveSjisPolicy)).not.toThrow();
  });

  it("requires resolving finding evidence and preserves Shift-JIS and choice-label encoding", () => {
    const choice = {
      ...candidate(0),
      surfaceKind: "choice_label",
      choiceContext: {
        choiceId: "choice:6010",
        optionIndex: 0,
        branchTargetSceneId: "scene:6011",
      },
    } as const;
    const normalized = normalizeRepairRequest(request([choice]));
    const batch = repairPatchBatch([choice], [choice.unitId]);
    expect(() => assertRepairPatchBatch(normalized, batch, realliveSjisPolicy)).not.toThrow();

    const ungroundedPatch = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, evidenceIds: ["fact:unrelated"] }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, ungroundedPatch, realliveSjisPolicy)).toThrow(
      /resolving-evidence/u,
    );

    const nonSjis = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "🙂" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, nonSjis, realliveSjisPolicy)).toThrow(
      /encoding/u,
    );

    const splitChoice = {
      ...batch,
      drafts: [{ ...batch.drafts[0]!, targetSkeleton: "First\nSecond" }],
    } as DraftBatch;
    expect(() => assertRepairPatchBatch(normalized, splitChoice, realliveSjisPolicy)).toThrow(
      /choice-encoding/u,
    );
  });

  it("uses P3's immutable localizer profile and its live semantic validator", () => {
    const p3 = specialistFor("P3");
    expect(p3.shape).toBe("localizer");
    expect(p3.version).toBe("itotori.role.P3.v2");
    expect(p3.tools).toEqual(toolsForRole("P3"));
    expect(p3.limits.maxSteps).toBe(1);
    expect(p3.validate(undefined)).not.toEqual([]);
  });
});

describe("P3 semantic repair — bounded to one repair", () => {
  it("repairs once, then routes a second attempt on the same defect to adjudication without dispatch", async () => {
    const cands = [candidate(0)];
    const req = request(cands);
    const batch = repairPatchBatch(
      cands,
      cands.map((c) => c.unitId),
    );

    // First attempt: a real repair, one dispatch.
    const firstCaptured: Captured[] = [];
    const first = await repairSemanticDefects(
      req,
      OPTIONS,
      recordedRuntime([draftBatchResponse(batch)], firstCaptured),
    );
    expect(first.kind).toBe("repaired");
    if (first.kind !== "repaired") throw new Error("expected repaired");
    expect(firstCaptured).toHaveLength(1);
    expect(first.repairedDefectIds).toEqual(["defect:0"]);

    // Fold the repaired defects into the ledger and re-enter with the SAME bundle.
    const ledger = new Set(first.repairedDefectIds);
    const secondCaptured: Captured[] = [];
    const second = await repairSemanticDefects(
      req,
      { ...OPTIONS, repairedDefectLedger: ledger },
      // No response queued — a dispatch here would throw "unexpected extra request".
      recordedRuntime([], secondCaptured),
    );

    // BOUNDED: the second attempt does NOT repair again — it routes to Q6/human
    // and dispatches nothing.
    expect(second.kind).toBe("routed");
    if (second.kind !== "routed") throw new Error("expected routed");
    expect(second.route).toBe("adjudication");
    expect(second.resolution).toBe("adjudication");
    expect(second.defectIds).toEqual(["defect:0"]);
    expect(second.humanReviewArtifact).toMatchObject({
      kind: "semantic-repair-exhausted",
      defectBundleId: BUNDLE_ID,
      repairPassLimit: 1,
    });
    expect(secondCaptured).toHaveLength(0);
  });
});
