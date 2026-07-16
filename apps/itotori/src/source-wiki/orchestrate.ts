// The whole-game source-Wiki orchestrator — the deterministic executor.
//
// Given a fact snapshot, a run stamp, a role runner, and an artifact ledger, it:
//   1. SELECTS the analyst roster (default A1-A10) and builds the plan.
//   2. Walks the dependency-ordered phases IN ORDER (a phase never starts until
//      the prior phase's artifacts exist) — this is how A4/A9/A5 wait on A3/A7/A8.
//   3. Within a phase, FANS the independent work items out under the bounded
//      concurrency limit; the SERIAL steps inside an item (the A3 fold) run one
//      after another, threading the prior accepted objects forward.
//   4. RECOVERS by missing-artifact query: a step whose target artifacts already
//      exist is SKIPPED — the runner is never invoked, a completed phase is never
//      rerun, and only the gaps are filled.
//
// It re-proves no narrative content: it accepts each produced object only against
// the four whole-game invariants (source-language, cited, on-target/route-scoped,
// stamped) and records it. The agent output is best-effort; the control flow is
// strict.

import { mapWithConcurrency } from "./concurrency.js";
import { buildSourceWikiPlan } from "./plan.js";
import { acceptObject } from "./accept.js";
import { WHOLE_GAME_CONTEXT_SCOPE } from "./types.js";
import type {
  AnalystRunner,
  ArtifactKey,
  ArtifactLedger,
  Phase,
  SourceWikiPlan,
  WorkItem,
  WorkStep,
} from "./types.js";
import type { RoleId, RunModeValue, WikiObject } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

/** Observability hooks — the concurrency and recovery proofs read these; the
 * control flow does not depend on them. */
export interface SourceWikiObserver {
  onItemStart?(item: WorkItem): void;
  onItemEnd?(item: WorkItem): void;
  onStepProduced?(step: WorkStep, keys: readonly ArtifactKey[]): void;
  onStepSkipped?(step: WorkStep): void;
}

export interface OrchestrateSourceWikiDeps {
  readonly snapshot: FactSnapshot;
  readonly sourceLanguage: string;
  readonly runMode: RunModeValue;
  readonly roles?: readonly RoleId[];
  readonly concurrency: number;
  readonly runner: AnalystRunner;
  readonly ledger: ArtifactLedger;
  readonly observer?: SourceWikiObserver;
}

/** One phase's tally after execution. */
export interface PhaseReport {
  readonly level: number;
  readonly roles: readonly RoleId[];
  readonly itemCount: number;
  readonly producedStepCount: number;
  readonly skippedStepCount: number;
}

/** The run report: the selected roster, the whole-game stamp, per-phase tallies,
 * and the produced/skipped key sets (the recovery evidence). */
export interface SourceWikiRunReport {
  readonly roles: readonly RoleId[];
  readonly contextScope: typeof WHOLE_GAME_CONTEXT_SCOPE;
  readonly phases: readonly PhaseReport[];
  readonly producedKeys: readonly ArtifactKey[];
  readonly skippedKeys: readonly ArtifactKey[];
}

interface Mutable {
  readonly existing: Set<ArtifactKey>;
  readonly produced: ArtifactKey[];
  readonly skipped: ArtifactKey[];
}

/** Run one serial step: skip it if all its targets already exist, else invoke the
 * runner, accept every produced object, record them, and thread them forward. */
async function runStep(
  deps: OrchestrateSourceWikiDeps,
  step: WorkStep,
  priorObjects: readonly WikiObject[],
  state: Mutable,
): Promise<{ accepted: readonly WikiObject[]; skipped: boolean }> {
  const missing = step.targets.filter((target) => !state.existing.has(target.key));
  if (missing.length === 0) {
    for (const target of step.targets) state.skipped.push(target.key);
    deps.observer?.onStepSkipped?.(step);
    return { accepted: priorObjects, skipped: true };
  }

  const produced = await deps.runner({
    role: step.role,
    step,
    sourceLanguage: deps.sourceLanguage,
    runMode: deps.runMode,
    contextScope: WHOLE_GAME_CONTEXT_SCOPE,
    priorObjects,
  });

  const stamp = { sourceLanguage: deps.sourceLanguage, runMode: deps.runMode };
  const acceptedKeys = new Set<ArtifactKey>();
  for (const object of produced) {
    acceptedKeys.add(acceptObject(object, step.targets, stamp));
  }
  const unmet = step.targets.filter((target) => !acceptedKeys.has(target.key));
  if (unmet.length > 0) {
    throw new Error(
      `role ${step.role} step ${step.stepId} did not produce its assigned targets: ${unmet
        .map((target) => target.key)
        .join(", ")}`,
    );
  }
  await deps.ledger.record(produced);
  const keys = [...acceptedKeys];
  for (const key of keys) {
    state.existing.add(key);
    state.produced.push(key);
  }
  deps.observer?.onStepProduced?.(step, keys);
  return { accepted: produced, skipped: false };
}

/** Run one independent work item: its steps in STRICT serial order, threading the
 * prior step's accepted objects into the next (the progressive fold). */
async function runItem(
  deps: OrchestrateSourceWikiDeps,
  item: WorkItem,
  state: Mutable,
): Promise<{ produced: number; skipped: number }> {
  deps.observer?.onItemStart?.(item);
  let prior: readonly WikiObject[] = [];
  let produced = 0;
  let skipped = 0;
  for (const step of item.steps) {
    const outcome = await runStep(deps, step, prior, state);
    prior = outcome.accepted;
    if (outcome.skipped) skipped += 1;
    else produced += 1;
  }
  deps.observer?.onItemEnd?.(item);
  return { produced, skipped };
}

async function runPhase(
  deps: OrchestrateSourceWikiDeps,
  phase: Phase,
  state: Mutable,
): Promise<PhaseReport> {
  const outcomes = await mapWithConcurrency(phase.items, deps.concurrency, (item) =>
    runItem(deps, item, state),
  );
  return {
    level: phase.level,
    roles: phase.roles,
    itemCount: phase.items.length,
    producedStepCount: outcomes.reduce((sum, o) => sum + o.produced, 0),
    skippedStepCount: outcomes.reduce((sum, o) => sum + o.skipped, 0),
  };
}

/**
 * Build the plan and execute it against the ledger. Phases run sequentially
 * (dependency order); items within a phase fan out under the bounded limit; steps
 * within an item are serial. Returns the run report.
 */
export async function orchestrateSourceWiki(
  deps: OrchestrateSourceWikiDeps,
): Promise<SourceWikiRunReport> {
  const plan: SourceWikiPlan = buildSourceWikiPlan(deps.snapshot, deps.roles);
  const state: Mutable = {
    existing: new Set(await deps.ledger.existingKeys()),
    produced: [],
    skipped: [],
  };
  const phases: PhaseReport[] = [];
  for (const phase of plan.phases) {
    // Sequential across phases: the later phase sees the earlier phase's writes.
    phases.push(await runPhase(deps, phase, state));
  }
  return {
    roles: plan.roles,
    contextScope: plan.contextScope,
    phases,
    producedKeys: state.produced,
    skippedKeys: state.skipped,
  };
}

/** Convenience: build the plan without executing it (selection + ordering +
 * enumeration only). */
export function planSourceWiki(snapshot: FactSnapshot, roles?: readonly RoleId[]): SourceWikiPlan {
  return buildSourceWikiPlan(snapshot, roles);
}
