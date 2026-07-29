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
  FACT_SCHEMA_VERSION,
  type DefectBundle,
  type Draft,
  type DraftBatch,
  type UnitFact,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { realliveSjisPolicy } from "../src/gates/index.js";
import {
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  assertRepairPatchMatchesScope,
  assertTargetEncodable,
  buildEditCall,
  deriveEditScope,
  dispatchEditCall,
  editLine,
  mergePatch,
  EditError,
  FinalizeError,
  type EditorRuntimeBase,
} from "../src/roles/p2/index.js";
import { specialistFor } from "../src/roster/index.js";

import {
  DRAFT_PROFILE,
  CTX,
  LOC,
  SCHEMA,
  REV_A,
  REV_B,
  BIBLE,
  PARENT,
  BUNDLE,
  MemoryMemoStore,
  sse,
  draftBatchResponse,
  Captured,
  recordedRuntime,
  pad,
  Placeholder,
  unmask,
  unitFact,
  currentDraftOf,
  reviewerDefect,
  repairBundleFor,
  patchDraftFor,
  repairPatchBatch,
  BASE,
} from "./p2-line-editor.support.js";

describe("P2 line editor — author-thread continuation over draft + defects + bible", () => {
  it("patches ONLY the implicated ids, continues the thread, and dispatches once via ZDR", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const implicated = ["unit:6010:1", "unit:6010:3"];
    const bundle = repairBundleFor(implicated);
    const patch = repairPatchBatch(units, implicated);
    const captured: Captured[] = [];
    const edit = await editLine(
      { ...BASE, currentDraft: current, defectBundle: bundle, units },
      recordedRuntime([draftBatchResponse(patch)], captured),
    );

    // AUTHOR-CONTINUATION repair for exactly the implicated units, in play order.
    expect(edit.repairMode).toBe("author-continuation");
    expect(edit.implicatedUnitIds).toEqual(implicated);
    expect(edit.patchBatch.scope).toMatchObject({
      kind: "repair-patch",
      repairMode: "author-continuation",
      parentDraftBatchId: PARENT,
      defectBundleId: BUNDLE,
      failedUnitIds: implicated,
    });
    // PATCHES ONLY IMPLICATED: the patch names no unimplicated unit.
    expect(edit.patchBatch.drafts.map((d) => d.unitId)).toEqual(implicated);

    // NEVER a whole-QA rerun / blind retranslation: exactly ONE dispatch, and the
    // seed carries only the implicated units — not the whole scene.
    expect(captured).toHaveLength(1);
    const wire = JSON.stringify(captured[0]);
    expect(wire).not.toContain("unit:6010:0");
    expect(wire).not.toContain("unit:6010:2");
    // The author thread carries the CURRENT authored line of the implicated units.
    expect(wire).toContain("EN>s1");
    expect(wire).toContain("EN>s3");
    // The changed basis is present: the defect's repair constraint + the bible.
    expect(wire).toContain("soften the register by one notch");
    expect(wire).toContain("rendering:1");

    // Dispatched through the sole ZDR boundary: exact model, no provider pin.
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
    expect(edit.result.status).toBe("success");
  });

  it("leaves every UNAFFECTED unit byte-identical after the merge (same bytes, same object)", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const implicated = ["unit:6010:1"];
    const bundle = repairBundleFor(implicated);
    const patch = repairPatchBatch(units, implicated);
    const captured: Captured[] = [];
    const edit = await editLine(
      { ...BASE, currentDraft: current, defectBundle: bundle, units },
      recordedRuntime([draftBatchResponse(patch)], captured),
    );

    expect(edit.patchedDrafts).toHaveLength(units.length);
    // The implicated unit took the patched line.
    const patched = edit.patchedDrafts.find((d) => d.unitId === "unit:6010:1")!;
    expect(patched.targetSkeleton).toBe("EN-EDIT>s1--------");
    // Every unaffected unit is BYTE-IDENTICAL — the same object reference the
    // current draft carried, so not a single byte changed.
    for (const id of ["unit:6010:0", "unit:6010:2", "unit:6010:3"]) {
      const before = current.drafts.find((d) => d.unitId === id)!;
      const after = edit.patchedDrafts.find((d) => d.unitId === id)!;
      expect(after).toBe(before);
      expect(after.targetSkeleton).toBe(before.targetSkeleton);
    }
  });

  it("rejects a patch that carries an UNIMPLICATED unit — an unaffected unit may not be touched", () => {
    const units = [0, 1, 2].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);
    // A well-formed patch batch that ALSO carries an unimplicated unit's line.
    const forged = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      drafts: [patchDraftFor(units, "unit:6010:1"), patchDraftFor(units, "unit:6010:0")],
    } as DraftBatch;
    expect(() => mergePatch(current, scope, forged, realliveSjisPolicy)).toThrow(
      /unaffected-mutated/u,
    );
  });
});

describe("P2 line editor — output preserves placeholders, spans, and Shift-JIS", () => {
  const placeholders = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
  const units = [
    unitFact(0),
    unitFact(1, { skeleton: "hp {{ph:0}} left", placeholders }),
    unitFact(2),
  ];
  const current = currentDraftOf(units);
  const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);

  it("accepts a patch that preserves the protected placeholder and rejects a dropped one", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} remaining" },
    });
    expect(() => assertPlaceholdersPreserved(scope, good.drafts)).not.toThrow();

    const dropped = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp remaining" },
    });
    expect(() => assertPlaceholdersPreserved(scope, dropped.drafts)).toThrow(FinalizeError);
  });

  it("rejects a repaired target that introduces an un-encodable (non-Shift-JIS) codepoint", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} left!" },
    });
    expect(() => assertTargetEncodable(good.drafts, realliveSjisPolicy)).not.toThrow();

    const emoji = repairPatchBatch(units, ["unit:6010:1"], {
      targets: { "unit:6010:1": "hp {{ph:0}} left \u{1F600}" },
    });
    expect(() => assertTargetEncodable(emoji.drafts, realliveSjisPolicy)).toThrow(/encoding/u);
  });
});

describe("P2 line editor — exactness + scope-binding guards", () => {
  const units = [0, 1, 2].map((index) => unitFact(index));
  const current = currentDraftOf(units);
  const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);

  it("rejects a wrong source hash, a wrong cardinality, and a reordering", () => {
    const good = repairPatchBatch(units, ["unit:6010:1"]).drafts;
    expect(() => assertExactAgainstSource(scope, good)).not.toThrow();

    const wrongHash = [{ ...good[0]!, sourceHash: `sha256:${"0".repeat(64)}` }];
    expect(() => assertExactAgainstSource(scope, wrongHash)).toThrow(/source-hash/u);

    const twoScope = deriveEditScope(
      current,
      repairBundleFor(["unit:6010:1", "unit:6010:2"]),
      units,
    );
    expect(() => assertExactAgainstSource(twoScope, good)).toThrow(/unit-cardinality/u);

    const reordered = deriveEditScope(
      currentDraftOf(units),
      repairBundleFor(["unit:6010:1", "unit:6010:2"]),
      units,
    );
    const swapped = [patchDraftFor(units, "unit:6010:2"), patchDraftFor(units, "unit:6010:1")];
    expect(() => assertExactAgainstSource(reordered, swapped)).toThrow(/unit-order/u);
  });

  it("rejects a fresh-grounded-fork patch, a wrong parent, and a wrong bundle", () => {
    const forkMode = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      scope: {
        kind: "repair-patch" as const,
        parentDraftBatchId: PARENT,
        defectBundleId: BUNDLE,
        repairMode: "fresh-grounded-fork" as const,
        failedUnitIds: ["unit:6010:1"],
      },
    } as DraftBatch;
    expect(() => assertRepairPatchMatchesScope(scope, forkMode)).toThrow(/repair-mode-mismatch/u);

    const wrongParent = {
      ...repairPatchBatch(units, ["unit:6010:1"]),
      scope: {
        kind: "repair-patch" as const,
        parentDraftBatchId: "draft:other",
        defectBundleId: BUNDLE,
        repairMode: "author-continuation" as const,
        failedUnitIds: ["unit:6010:1"],
      },
    } as DraftBatch;
    expect(() => assertRepairPatchMatchesScope(scope, wrongParent)).toThrow(
      /parent-batch-mismatch/u,
    );
  });
});

describe("P2 line editor — never blind-retranslates / whole-QA reruns", () => {
  it("refuses a non-repair (adjudication) bundle BEFORE any dispatch", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"], "adjudication");
    const captured: Captured[] = [];
    await expect(
      editLine(
        { ...BASE, currentDraft: current, defectBundle: bundle, units },
        recordedRuntime([], captured),
      ),
    ).rejects.toThrow(/not-a-repair-bundle/u);
    // Nothing was dispatched — a non-repair bundle never reaches the model.
    expect(captured).toHaveLength(0);
  });

  it("refuses a defect that names a unit absent from the current draft", () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:9"]);
    expect(() => deriveEditScope(current, bundle, units)).toThrow(/unknown-implicated-unit/u);
  });

  it("refuses an implicated unit that lacks a source fact", () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"]);
    expect(() => deriveEditScope(current, bundle, [units[0]!])).toThrow(/missing-source-fact/u);
  });
});

describe("P2 line editor — certified route binding", () => {
  it("rejects a test-dev wrong-model call at the public dispatch boundary", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const scope = deriveEditScope(current, repairBundleFor(["unit:6010:1"]), units);
    const call = buildEditCall({
      specialist: specialistFor("P2"),
      scope,
      bibleRenderingIds: BIBLE,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    const forged = { ...call, spec: { ...call.spec, requestedModel: "openai/gpt-4.1" } };
    const captured: Captured[] = [];
    await expect(
      dispatchEditCall(
        forged,
        recordedRuntime([draftBatchResponse(repairPatchBatch(units, ["unit:6010:1"]))], captured),
      ),
    ).rejects.toThrow(/certified deepseek-v4-flash/u);
    expect(captured).toHaveLength(0);
  });

  it("surfaces a dispatch failure as a typed EditError, never a fabricated patch", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    const bundle = repairBundleFor(["unit:6010:1"]);
    const refusal = sse([
      {
        id: "generation:p2",
        created: 1,
        model: "deepseek/deepseek-v4-flash",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
    ]);
    await expect(
      editLine(
        { ...BASE, currentDraft: current, defectBundle: bundle, units },
        recordedRuntime([refusal], []),
      ),
    ).rejects.toBeInstanceOf(EditError);
  });
});

describe("P2 line editor — scope resolves the exact implicated set", () => {
  it("orders the implicated units by current-draft play order and refuses a bundle for another draft", () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const current = currentDraftOf(units);
    // Defects supplied out of play order still resolve in play order.
    const bundle = repairBundleFor(["unit:6010:3", "unit:6010:1"]);
    const scope = deriveEditScope(current, bundle, units);
    expect(scope.implicatedUnitIds).toEqual(["unit:6010:1", "unit:6010:3"]);

    const wrongBatch = { ...bundle, draftBatchId: "draft:elsewhere" } as DefectBundle;
    expect(() => deriveEditScope(current, wrongBatch, units)).toThrow(/bundle-batch-mismatch/u);
  });
});
