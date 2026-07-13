// ITOTORI-038 — Affected-work selector.
//
// Maps one `RepairTrigger` to the narrowest set of bridge units that
// MUST be rerun. The selector is deterministic + pure: given the same
// trigger + scene index it returns byte-equal output.
//
// Audit-focus guards:
//   - "Over-broad invalidation": the selector NEVER widens past the
//     trigger's named bridge unit. A QA finding on bridge unit X produces
//     `affectedScope: 'bridge_units'` with `[X]` — never a scene or project.
//   - "Pipeline-only reruns": the selector returns BOTH the affected
//     bridge units AND the targetStage. The orchestrator uses the
//     pair to rerun only that stage; downstream stages re-run as a
//     consequence of the stage's new output, not because the selector
//     widened to them.
//
import type { RepairAffectedWork, RepairPipelineStage, RepairTrigger } from "./types.js";

/**
 * The selector's result. It is the discriminated `RepairAffectedWork`
 * descriptor plus the pipeline stage to rerun. Because `RepairAffectedWork`
 * is a discriminated union, the `project` variant has NO
 * `affectedBridgeUnitIds` field — a consumer is forced to branch on
 * `affectedScope` before it can read a unit list, so an empty array can
 * never be mistaken for "no work affected".
 */
export type AffectedWorkSelection = RepairAffectedWork & {
  pipelineStage: RepairPipelineStage;
};

/**
 * Pick the narrowest correct affected-work set for the trigger.
 * The function is total over the closed `RepairTrigger` union — the
 * `default` branch calls `assertNever`, so adding a new trigger
 * variant without extending the switch is a compile error.
 */
export function selectAffectedWork(trigger: RepairTrigger): AffectedWorkSelection {
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
    default:
      return assertNever(trigger);
  }
}

function assertNever(value: never): never {
  throw new Error(`affected-work selector: unexpected union value ${String(value)}`);
}
