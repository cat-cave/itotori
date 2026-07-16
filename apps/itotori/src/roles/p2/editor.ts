// The P2 Line Editor — the minor-repair localizer role.
//
// It continues the author thread for MINOR style, format, and voice repairs plus
// wiki translation enhancements. Given the CURRENT DRAFT, the EXACT changed basis
// (a repair defect bundle), the localized bible, and the implicated units' source
// facts, it derives the implicated scope, drives ONE repair call through the SOLE
// ZDR dispatch boundary as deepseek-v4-flash, and validates the returned patch
// back against the scope and the source. It returns a repair patch for the
// implicated ids ONLY and a merged draft whose unaffected units are byte-
// identical. It NEVER re-plans the whole scene or re-runs QA: a non-repair bundle
// is refused during scope derivation, before any dispatch. A dispatch failure is
// a loud typed error, never a fabricated repair.

import {
  DraftBatchSchema,
  type CallResult,
  type DefectBundle,
  type Draft,
  type DraftBatch,
  type UnitFact,
} from "../../contracts/index.js";
import { specialistFor, type Specialist } from "../../roster/index.js";
import { buildEditCall, dispatchEditCall, type EditCall, type EditorRuntimeBase } from "./call.js";
import {
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  assertRepairPatchMatchesScope,
  assertSjisPreserved,
  mergePatch,
} from "./finalize.js";
import { deriveEditScope, type EditScope } from "./scope.js";

export interface EditLineInput {
  /** The current accepted translation the edit continues (the parent batch). */
  readonly currentDraft: DraftBatch;
  /** The exact changed basis: a repair defect bundle raised against that draft. */
  readonly defectBundle: DefectBundle;
  /** Source facts covering (at least) the implicated units. Trusted substrate. */
  readonly units: readonly UnitFact[];
  /** Localized-bible rendering ids the repaired lines cite (wiki-first basis). */
  readonly bibleRenderingIds: readonly string[];
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly runMode: "production" | "pilot" | "test-dev";
  readonly contextScope: "whole-game" | "external-augmented" | `narrowed:${string}`;
  readonly specialist?: Specialist;
}

export interface LineEdit {
  readonly repairMode: "author-continuation";
  /** The implicated units, in play order — exactly what the patch repairs. */
  readonly implicatedUnitIds: readonly string[];
  /** The repair patch (patches ONLY the implicated ids) — the terminal output. */
  readonly patchBatch: DraftBatch;
  /** The merged full draft; every unaffected unit is byte-identical. */
  readonly patchedDrafts: readonly Draft[];
  readonly result: CallResult;
}

export class EditError extends Error {
  constructor(
    readonly code: "dispatch-failure",
    detail: string,
  ) {
    super(`p2 edit ${code}: ${detail}`);
    this.name = "EditError";
  }
}

function requireBatch(result: CallResult): DraftBatch {
  if (result.status !== "success") {
    throw new EditError("dispatch-failure", `repair dispatch failed: ${result.failureKind}`);
  }
  return DraftBatchSchema.parse(result.value);
}

/** Run one minor line edit end-to-end through the sole ZDR boundary. */
export async function editLine(
  input: EditLineInput,
  runtime: EditorRuntimeBase,
): Promise<LineEdit> {
  const specialist = input.specialist ?? specialistFor("P2");
  // Deriving the scope REFUSES a non-repair bundle up front, so a whole-QA rerun
  // or blind retranslation never reaches a dispatch.
  const scope: EditScope = deriveEditScope(input.currentDraft, input.defectBundle, input.units);

  const call: EditCall = buildEditCall({
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
  const patchBatch = requireBatch(result);

  // VALIDATE the patch against the scope and the verified source BEFORE it is
  // merged: a mis-scoped, source-violating, or un-encodable patch fails loud.
  assertRepairPatchMatchesScope(scope, patchBatch);
  assertExactAgainstSource(scope, patchBatch.drafts);
  assertPlaceholdersPreserved(scope, patchBatch.drafts);
  assertSjisPreserved(patchBatch.drafts);

  const patchedDrafts = mergePatch(input.currentDraft, scope, patchBatch);

  return {
    repairMode: "author-continuation",
    implicatedUnitIds: scope.implicatedUnitIds,
    patchBatch,
    patchedDrafts,
    result,
  };
}
