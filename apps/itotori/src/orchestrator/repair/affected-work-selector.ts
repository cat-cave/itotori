// ITOTORI-038 — Affected-work selector.
//
// Maps one `RepairTrigger` to the narrowest set of bridge units that
// MUST be rerun. The selector is deterministic + pure: given the same
// trigger + scene index it returns byte-equal output.
//
// Audit-focus guards:
//   - "Over-broad invalidation": the selector NEVER widens past the
//     trigger's named bridge unit unless a HumanDecision explicitly
//     declares a wider scope. A QA finding on bridge unit X produces
//     `affectedScope: 'bridge_units'` with `[X]` — never the whole
//     scene, never the whole project.
//   - "Pipeline-only reruns": the selector returns BOTH the affected
//     bridge units AND the targetStage. The orchestrator uses the
//     pair to rerun only that stage; downstream stages re-run as a
//     consequence of the stage's new output, not because the selector
//     widened to them.
//
// The selector exposes a small `SceneIndex` port so the orchestrator
// can hand in scene membership lazily — the selector never reads from
// the database directly.

import type { Uuid7 } from "@itotori/localization-bridge-schema";
import type { RepairAffectedScope, RepairPipelineStage, RepairTrigger } from "./types.js";

/**
 * Scene-membership lookup. Production wires this to a repository view
 * that returns every bridge unit in the scene that owns the given
 * unit. Tests pass an in-memory map. The selector calls it ONLY when
 * a HumanDecision asks for `kind: "scene"`.
 */
export interface RepairSceneIndex {
  /**
   * Return every bridge unit id that shares the scene with `seedUnitId`.
   * Implementations MUST include `seedUnitId` in the returned array.
   * Returning an empty array is treated as "no scene known" and the
   * selector reports an error.
   */
  bridgeUnitsInSceneOf(seedUnitId: Uuid7): ReadonlyArray<Uuid7>;
}

export class AffectedWorkSelectorError extends Error {
  constructor(
    public readonly code:
      | "empty_human_scope"
      | "scene_index_returned_empty"
      | "project_scope_requires_human_opt_in",
    message: string,
  ) {
    super(message);
    this.name = "AffectedWorkSelectorError";
  }
}

export type AffectedWorkSelection = {
  affectedScope: RepairAffectedScope;
  affectedBridgeUnitIds: ReadonlyArray<Uuid7>;
  pipelineStage: RepairPipelineStage;
};

/**
 * Pick the narrowest correct affected-work set for the trigger.
 * The function is total over the closed `RepairTrigger` union — the
 * `default` branch calls `assertNever`, so adding a new trigger
 * variant without extending the switch is a compile error.
 */
export function selectAffectedWork(
  trigger: RepairTrigger,
  sceneIndex?: RepairSceneIndex,
): AffectedWorkSelection {
  switch (trigger.trigger) {
    case "qa_finding":
      return {
        affectedScope: "bridge_units",
        affectedBridgeUnitIds: [trigger.bridgeUnitId],
        pipelineStage: trigger.targetStage,
      };
    case "protected_span_violation":
      return {
        affectedScope: "bridge_units",
        affectedBridgeUnitIds: [trigger.bridgeUnitId],
        pipelineStage: "translation",
      };
    case "human_decision":
      return selectFromHumanDecision(trigger.scope, trigger.targetStage, sceneIndex);
    default:
      return assertNever(trigger);
  }
}

function selectFromHumanDecision(
  scope:
    | { kind: "bridge_units"; bridgeUnitIds: ReadonlyArray<Uuid7> }
    | { kind: "scene"; sceneId: string; bridgeUnitIds: ReadonlyArray<Uuid7> }
    | { kind: "project" },
  targetStage: RepairPipelineStage,
  sceneIndex?: RepairSceneIndex,
): AffectedWorkSelection {
  switch (scope.kind) {
    case "bridge_units": {
      if (scope.bridgeUnitIds.length === 0) {
        throw new AffectedWorkSelectorError(
          "empty_human_scope",
          "human decision scope='bridge_units' must name at least one bridge unit",
        );
      }
      return {
        affectedScope: "bridge_units",
        affectedBridgeUnitIds: dedupe(scope.bridgeUnitIds),
        pipelineStage: targetStage,
      };
    }
    case "scene": {
      // A `scene` decision MUST carry at least one bridge unit so the
      // selector can deterministically expand via the scene index. We
      // refuse to silently fall back to the project scope.
      const seed = scope.bridgeUnitIds[0];
      if (scope.bridgeUnitIds.length === 0 || seed === undefined) {
        throw new AffectedWorkSelectorError(
          "empty_human_scope",
          `human decision scope='scene' (sceneId=${scope.sceneId}) must name at least one bridge unit`,
        );
      }
      const expanded =
        sceneIndex !== undefined ? sceneIndex.bridgeUnitsInSceneOf(seed) : scope.bridgeUnitIds;
      if (expanded.length === 0) {
        throw new AffectedWorkSelectorError(
          "scene_index_returned_empty",
          `scene index returned no bridge units for scene='${scope.sceneId}' seed='${seed}'`,
        );
      }
      return {
        affectedScope: "scene",
        affectedBridgeUnitIds: dedupe(expanded),
        pipelineStage: targetStage,
      };
    }
    case "project":
      // Project-wide reruns are reachable ONLY from a human decision
      // that explicitly opts in. The selector never produces
      // `scope: 'project'` from a QA finding or a protected-span
      // violation — that would be over-broad invalidation.
      return {
        affectedScope: "project",
        affectedBridgeUnitIds: [],
        pipelineStage: targetStage,
      };
    default:
      return assertNever(scope);
  }
}

function dedupe(ids: ReadonlyArray<Uuid7>): ReadonlyArray<Uuid7> {
  const seen = new Set<Uuid7>();
  const out: Uuid7[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function assertNever(value: never): never {
  throw new Error(`affected-work selector: unexpected union value ${String(value)}`);
}
