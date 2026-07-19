// P2 Line Editor, end to end: one author-thread continuation and a minimal
// provisional patch. It does not own review scheduling; it returns the exact
// affected deterministic/reviewer lanes for the workflow to rerun.

import {
  DraftBatchSchema,
  type CallResult,
  type Draft,
  type DraftBatch,
  type UnitFact,
} from "../../contracts/index.js";
import { specialistFor, type Specialist } from "../../roster/index.js";
import { buildEditCall, dispatchEditCall, type EditorRuntimeBase } from "./call.js";
import { mergePatch } from "./finalize.js";
import { AUTHOR_CONTINUATION_MODE, deriveEditScope } from "./scope.js";
import type { CallSpec, DefectBundle } from "../../contracts/index.js";

export interface EditLineInput {
  readonly currentDraft: DraftBatch;
  readonly defectBundle: DefectBundle;
  readonly units: readonly UnitFact[];
  readonly bibleRenderingIds: readonly string[];
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  readonly specialist?: Specialist;
}

export interface LineEditOutcome {
  readonly repairMode: typeof AUTHOR_CONTINUATION_MODE;
  /** No accepted finalization happens in P2; its patches remain traceable candidates. */
  readonly provisional: true;
  readonly implicatedUnitIds: readonly string[];
  readonly patchBatch: DraftBatch;
  /** Parent drafts outside the implication scope retain their original references. */
  readonly patchedDrafts: readonly Draft[];
  readonly result: CallResult;
  /** The workflow, not P2, reruns these exact lanes. There is no whole-QA path. */
  readonly rerun: {
    readonly unitIds: readonly string[];
    readonly gates: readonly string[];
    readonly reviewLanes: readonly string[];
  };
}

export class EditError extends Error {
  constructor(detail: string) {
    super(`p2 edit dispatch-failure: ${detail}`);
    this.name = "EditError";
  }
}

function requirePatchBatch(result: CallResult): DraftBatch {
  if (result.status !== "success") {
    throw new EditError(`line edit dispatch failed: ${result.failureKind}`);
  }
  try {
    return DraftBatchSchema.parse(result.value);
  } catch (error) {
    throw new EditError(`line edit returned an invalid patch batch: ${String(error)}`);
  }
}

function exactRerun(scope: ReturnType<typeof deriveEditScope>): LineEditOutcome["rerun"] {
  const gates = new Set<string>();
  const reviewLanes = new Set<string>();
  for (const defects of scope.defectsByUnit.values()) {
    for (const defect of defects) {
      defect.implicatedGates.forEach((gate) => gates.add(gate));
      defect.implicatedReviewLanes.forEach((lane) => reviewLanes.add(lane));
    }
  }
  return {
    unitIds: scope.implicatedUnitIds,
    gates: [...gates],
    reviewLanes: [...reviewLanes],
  };
}

/**
 * Continue the existing author thread once for its exact minor findings. P2
 * dispatches no reviewer and cannot produce a whole-scene batch: its builder
 * only receives `deriveEditScope`'s implicated projection.
 */
export async function editLine(
  input: EditLineInput,
  runtime: EditorRuntimeBase,
): Promise<LineEditOutcome> {
  const scope = deriveEditScope(input.currentDraft, input.defectBundle, input.units);
  const specialist = input.specialist ?? specialistFor("P2");
  const call = buildEditCall({
    specialist,
    scope,
    bibleRenderingIds: input.bibleRenderingIds,
    contextSnapshotId: input.contextSnapshotId,
    localizationSnapshotId: input.localizationSnapshotId,
    runMode: input.runMode,
    contextScope: input.contextScope,
    schemaHash: input.schemaHash,
  });
  const result = await dispatchEditCall(call, runtime);
  const patchBatch = requirePatchBatch(result);
  const patchedDrafts = mergePatch(input.currentDraft, scope, patchBatch);
  return {
    repairMode: AUTHOR_CONTINUATION_MODE,
    provisional: true,
    implicatedUnitIds: scope.implicatedUnitIds,
    patchBatch,
    patchedDrafts,
    result,
    rerun: exactRerun(scope),
  };
}
