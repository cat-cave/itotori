// The composition-root seams — the injected substrate the live workflow ports
// adapt into the deterministic driver's port shapes.
//
// The workflow DRIVER (see ../workflow/) sequences/gates/routes/finalizes over a
// small set of ports. Those ports are BOUNDARIES to already-built pieces: the
// localized-bible ground truth, the P/Q roles, the deterministic gates, native
// patchback, and the content-addressed durability substrate. This module holds
// the DATA the port adapters need but the driver's light work-item shapes do not
// carry — the decode-derived facts, the installed bible, the run snapshot ids,
// and the ZDR dispatch runtimes. Production builds these from the decode + DB +
// LLM layer; an offline proof drives the driver with fake PORTS directly, so it
// never constructs this substrate.
//
// Nothing here reaches the legacy service graph: the imported input types come
// only from the roles, the localized-wiki ground truth, the gates, and native
// patchback — all new-pipeline modules with a clean import closure.

import type { InstalledBible, RequirementOptions } from "../localized-wiki/ground-truth/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../prepass/index.js";
import type { LocalizeSceneInput, LocalizerRuntimeBase } from "../roles/p1/index.js";
import type { EditLineInput, EditorRuntimeBase } from "../roles/p2/index.js";
import type { RepairOptions, RepairRequest, RepairRuntimeBase } from "../roles/p3/index.js";
import type { Q6Dispatch, Q6DispatchRefs, Q6ReviewInput } from "../roles/q6/index.js";
import type { DeterministicGateInput } from "../gates/index.js";
import type { NativePatchbackInput } from "../patchback/index.js";
import type { Defect } from "../contracts/index.js";
import type {
  DraftMode,
  DraftedScene,
  FinalizedUnit,
  LaneVerdict,
  ReviewLane,
  WorkflowArtifactStore,
  WorkflowScene,
} from "../workflow/index.js";

/** The readiness seam: resolve the exact decode fact + fact snapshot + installed
 * bible a unit's ground-truth resolution needs. `resolveUnitBibleGroundTruth`
 * throws a `MissingBibleEntryError` for a missing required entry — the readiness
 * port catches it and reports `ready:false`. */
export interface ReadinessDeps {
  orderedFact(unitId: string): OrderedUnitFact;
  readonly snapshot: FactSnapshot;
  readonly bible: InstalledBible;
  readonly requirementOptions?: RequirementOptions;
}

/** The draft seam: assemble the P1 `localizeScene` input for a scene under the
 * chosen realization mode, and the runtime that carries the sole ZDR boundary. */
export interface DraftDeps {
  buildInput(input: {
    readonly scene: WorkflowScene;
    readonly mode: DraftMode;
    readonly bibleRenderingIdsByUnit: ReadonlyMap<string, readonly string[]>;
  }): LocalizeSceneInput;
  readonly runtime: LocalizerRuntimeBase;
}

/** The gate seam: assemble the deterministic-gate input from a drafted scene plus
 * the decode/glossary/box facts the gates evaluate against. Zero model calls. */
export interface GateDeps {
  buildInput(scene: DraftedScene): DeterministicGateInput;
}

/** The review seam: run ONE selected review lane over its selected units and
 * return the lane verdicts. Production binds this to the per-lane `runQ1..Q5`
 * review entrypoints (each with its distinct input/refs/deps); the composition
 * module treats the lane as an opaque selected-and-executed unit. */
export interface ReviewDeps {
  reviewLane(input: {
    readonly lane: ReviewLane;
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
  }): Promise<readonly LaneVerdict[]>;
}

/** The correction seam: assemble the P2 line-edit and P3 semantic-repair inputs
 * from the drafted scene + implicated units + defects, plus their ZDR runtimes.
 * The `scene` carries the CURRENT DRAFT the P2 editor continues and the failing
 * candidate the P3 fork re-grounds — the assembler cannot build those inputs from
 * the defects alone, so the driver threads the run-scoped `DraftedScene`. */
export interface RepairDeps {
  buildEditInput(input: {
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
    readonly defects: readonly Defect[];
  }): EditLineInput;
  readonly editRuntime: EditorRuntimeBase;
  buildRepairRequest(input: {
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
    readonly defects: readonly Defect[];
  }): RepairRequest;
  buildRepairOptions(input: {
    readonly unitIds: readonly string[];
    readonly defects: readonly Defect[];
    readonly repairedDefectLedger: ReadonlySet<string>;
  }): RepairOptions;
  readonly repairRuntime: RepairRuntimeBase;
}

/** The adjudication seam: assemble the Q6 review input + dispatch refs for one
 * contested unit, plus the certified-judge dispatch. The two blinded A/B
 * positions + trigger the adjudicator weighs live in the `contested` lane
 * verdicts (not the defects), so the driver threads them explicitly. */
export interface AdjudicateDeps {
  buildInput(input: {
    readonly unitId: string;
    readonly defects: readonly Defect[];
    readonly contested: readonly LaneVerdict[];
  }): Q6ReviewInput;
  buildRefs(input: { readonly unitId: string }): Q6DispatchRefs;
  readonly dispatch: Q6Dispatch;
}

/** The patchback seam: assemble the native patchback input for the finalized
 * units, choose the translated-bundle path, and run the downstream on-screen
 * Build-LQA review over the patched result. `buildLqa` observes the PATCHED
 * bytes through the render/OCR channel — production binds it to the Q5 pass. */
export interface PatchbackDeps {
  buildInput(finalized: readonly FinalizedUnit[]): NativePatchbackInput;
  translatedBundlePath(finalized: readonly FinalizedUnit[]): string;
  buildLqa(input: {
    readonly patchId: string;
    readonly unitIds: readonly string[];
  }): Promise<readonly LaneVerdict[]>;
}

/** The full substrate the live workflow ports adapt into the driver's ports. */
export interface WorkflowPortDeps {
  readonly readiness: ReadinessDeps;
  readonly draft: DraftDeps;
  readonly gates: GateDeps;
  readonly review: ReviewDeps;
  readonly repair: RepairDeps;
  readonly adjudicate: AdjudicateDeps;
  readonly patchback: PatchbackDeps;
  readonly store: WorkflowArtifactStore;
}
