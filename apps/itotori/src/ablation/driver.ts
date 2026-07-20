// The pure-MTL control runner — a named configuration of the shared workflow.
//
// This module deliberately owns no draft/gate/patch/finalize control flow. It
// resolves the pinned run policy, then drives the shared workflow driver with
// that policy. The shared driver derives the direct branch from its null-Wiki
// basis: empty bible map, direct P1, deterministic gates, no model QA, and the
// same independent CAS finalize plus native patchback as a qualifying run.

import {
  runLocalizationWorkflowForPolicy,
  type FinalizedUnit,
  type WorkflowPorts,
} from "../workflow/index.js";
import { lineageClassOf, resolveAblationPolicy } from "./policy.js";
import type {
  AblationRunReport,
  AblationRunRequest,
  AblationScene,
  AblationSceneOutcome,
} from "./types.js";

function projectScene(outcome: {
  readonly sceneId: string;
  readonly mode: string | null;
  readonly draftedUnitIds: readonly string[];
  readonly skippedUnitIds: readonly string[];
  readonly deterministicDefects: AblationSceneOutcome["gateDefects"];
  readonly finalized: readonly FinalizedUnit[];
}): AblationSceneOutcome {
  return {
    sceneId: outcome.sceneId,
    drafted: outcome.mode !== null,
    draftedUnitIds: outcome.draftedUnitIds,
    skippedUnitIds: outcome.skippedUnitIds,
    gateDefects: outcome.deterministicDefects,
    finalized: outcome.finalized,
  };
}

/**
 * Run the sanctioned pure-MTL control arm. `resolveAblationPolicy` pins the
 * explicit selector and refuses any result that is not test-dev, null-Wiki, and
 * artifact-only; `runLocalizationWorkflowForPolicy` then executes the exact
 * same driver/ports as the qualifying path. The report remains tagged as the
 * isolated ablation lineage for its scorecard sink.
 */
export async function runPureMtlAblation(
  request: AblationRunRequest,
  scenes: readonly AblationScene[],
  ports: WorkflowPorts,
): Promise<AblationRunReport> {
  const policy = resolveAblationPolicy(request);
  const report = await runLocalizationWorkflowForPolicy(policy, scenes, ports);
  return {
    policy,
    lineageClass: lineageClassOf(policy),
    bibleBasis: policy.bibleBasis,
    runMode: policy.runMode,
    scenes: report.scenes.map(projectScene),
    finalized: report.finalized,
    patchId: report.patchId,
    attemptLineage: report.attemptLineage,
  };
}
