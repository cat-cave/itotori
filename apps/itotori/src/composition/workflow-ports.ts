// The live workflow ports — the REAL adapters that wrap the named pipeline
// entrypoints into the deterministic driver's port shapes.
//
// Each adapter is the boundary to one already-built piece. The driver sequences
// and gates; these ports produce the content by calling the exact named
// entrypoint:
//
//   - readiness  → localized-wiki ground truth `resolveUnitBibleGroundTruth`
//                  (a `MissingBibleEntryError` maps to `ready:false`).
//   - draft      → roles/p1 `localizeScene` (whole-scene OR chunked).
//   - gates      → gates `evaluateDeterministicGates` (zero model calls).
//   - review     → roles/q1..q5 review lanes (per selected lane).
//   - repair     → roles/p2 `editLine` + roles/p3 `repairSemanticDefects`.
//   - adjudicate → roles/q6 `runQ6Adjudication` (bounded to one).
//   - patchback  → patchback `buildNativePatchback` + the downstream Build-LQA.
//   - store      → the CAS / memo / attempt-lineage durability substrate.
//
// The heavy decode/runtime/store data each entrypoint needs is injected through
// `WorkflowPortDeps` (see ./deps.ts) — the driver's light work-item shapes do
// not carry it. This module imports ONLY new-pipeline entrypoints; its transitive
// import closure never reaches the legacy service graph.

import {
  MissingBibleEntryError,
  resolveUnitBibleGroundTruth,
} from "../localized-wiki/ground-truth/index.js";
import { localizeScene } from "../roles/p1/index.js";
import { editLine } from "../roles/p2/index.js";
import { repairSemanticDefects } from "../roles/p3/index.js";
import { runQ6Adjudication } from "../roles/q6/index.js";
import { evaluateDeterministicGates } from "../gates/index.js";
import { buildNativePatchback } from "../patchback/index.js";
import type { WorkflowPortDeps } from "./deps.js";
import type {
  AdjudicatePort,
  BibleReadinessPort,
  CorrectionOutcome,
  DraftPort,
  GateEvaluationPort,
  GateReport,
  PatchbackPort,
  RepairPort,
  ReviewPort,
  UnitReadiness,
  WorkflowPorts,
} from "../workflow/index.js";
import type { DraftedScene, DraftedUnit } from "../workflow/index.js";

/** Readiness: resolve the unit's installed-bible ground truth. A missing required
 * entry throws `MissingBibleEntryError`, which the port maps to `ready:false`
 * naming exactly the missing entry. */
function createReadinessPort(deps: WorkflowPortDeps): BibleReadinessPort {
  return {
    async resolve(unitId: string): Promise<UnitReadiness> {
      try {
        const binding = resolveUnitBibleGroundTruth(
          deps.readiness.orderedFact(unitId),
          deps.readiness.snapshot,
          deps.readiness.bible,
          deps.readiness.requirementOptions ?? {},
        );
        return { ready: true, bibleRenderingIds: binding.bibleRenderingIds };
      } catch (error: unknown) {
        if (error instanceof MissingBibleEntryError) {
          const subject = error.required.subject
            ? `${error.required.subject.kind}:${error.required.subject.id}`
            : "*";
          return {
            ready: false,
            missing: [`${error.required.category}:${error.required.sourceKind}:${subject}`],
          };
        }
        throw error;
      }
    },
  };
}

/** Draft: localize the whole scene through P1, then project the finalized drafts
 * onto the driver's `DraftedScene` under the chosen realization mode. */
function createDraftPort(deps: WorkflowPortDeps): DraftPort {
  return {
    async draftScene(input): Promise<DraftedScene> {
      const localizeInput = deps.draft.buildInput(input);
      const localized = await localizeScene(localizeInput, deps.draft.runtime);
      const bibleByUnit = input.bibleRenderingIdsByUnit;
      const units: DraftedUnit[] = localized.finalizedDrafts.map((draft) => ({
        unitId: draft.unitId,
        draft,
        bibleRenderingIds: bibleByUnit.get(draft.unitId) ?? draft.basis.bibleRenderingIds ?? [],
      }));
      return {
        sceneId: input.scene.sceneId,
        mode: input.mode,
        batches: localized.batches,
        units,
      };
    },
  };
}

/** Gates: run the deterministic gates over the drafted scene. */
function createGatePort(deps: WorkflowPortDeps): GateEvaluationPort {
  return {
    async evaluate(scene: DraftedScene): Promise<GateReport> {
      const report = evaluateDeterministicGates(deps.gates.buildInput(scene));
      return { defects: report.defects, evaluatedGates: report.evaluatedGates };
    },
  };
}

/** Review: run the ONE selected lane over its selected units. */
function createReviewPort(deps: WorkflowPortDeps): ReviewPort {
  return {
    async review(input) {
      return await deps.review.reviewLane(input);
    },
  };
}

/** Repair: P2 minor line edit (author continuation) + P3 bounded semantic repair
 * (a fresh grounded fork, one attempt per defect — a second routes out). */
function createRepairPort(deps: WorkflowPortDeps): RepairPort {
  return {
    async lineEdit(input): Promise<CorrectionOutcome> {
      const edit = await editLine(deps.repair.buildEditInput(input), deps.repair.editRuntime);
      return { route: "repair", changedUnitIds: edit.implicatedUnitIds };
    },
    async semanticRepair(input): Promise<CorrectionOutcome> {
      const outcome = await repairSemanticDefects(
        deps.repair.buildRepairRequest(input),
        deps.repair.buildRepairOptions(input),
        deps.repair.repairRuntime,
      );
      if (outcome.kind === "repaired") {
        return { route: "repair", changedUnitIds: outcome.patches.map((patch) => patch.unitId) };
      }
      // A bounded second opinion is spent — hand the contest to adjudication.
      return { route: "adjudication", contestedUnitIds: input.unitIds };
    },
  };
}

/** Adjudicate: one bounded, order-debiased Q6 adjudication for a contested unit.
 * The dual-order verdict folds to a single binding disposition. */
function createAdjudicatePort(deps: WorkflowPortDeps): AdjudicatePort {
  return {
    async adjudicate(input) {
      const outcome = await runQ6Adjudication(
        deps.adjudicate.buildInput(input),
        deps.adjudicate.buildRefs(input),
        { dispatch: deps.adjudicate.dispatch },
      );
      if (outcome.outcome === "adjudicated") {
        return { disposition: outcome.canFinalize ? "finalize" : "repair" };
      }
      // Ineligible or no-verdict → the contest escalates, never silently finalizes.
      return { disposition: "escalate" };
    },
  };
}

/** Patchback: build the native patch from the finalized units, then run the
 * downstream on-screen Build-LQA strictly after the patch is exported. */
function createPatchbackPort(deps: WorkflowPortDeps): PatchbackPort {
  return {
    async exportPatch(input) {
      const build = buildNativePatchback(
        deps.patchback.buildInput(input.finalized),
        deps.patchback.translatedBundlePath(input.finalized),
      );
      return { patchId: build.patchExport.patchExportId };
    },
    async buildLqaReview(input) {
      return await deps.patchback.buildLqa(input);
    },
  };
}

/** Assemble the full set of live workflow ports from the injected substrate. The
 * returned object is exactly what `runLocalizationWorkflow` composes. */
export function createWorkflowPorts(deps: WorkflowPortDeps): WorkflowPorts {
  return {
    readiness: createReadinessPort(deps),
    draft: createDraftPort(deps),
    gates: createGatePort(deps),
    review: createReviewPort(deps),
    repair: createRepairPort(deps),
    adjudicate: createAdjudicatePort(deps),
    patchback: createPatchbackPort(deps),
    store: deps.store,
  };
}
