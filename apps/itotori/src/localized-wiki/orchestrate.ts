// The per-target bible orchestrator — the deterministic executor.
//
// Given the source Wiki objects, a target language, a posture, a localizer
// runner, a decision reviewer, and a rendering ledger, it:
//   1. BUILDS the tier-ordered plan (decisions first, descriptive second).
//   2. Runs the L-Term / L-Name DECISIONS FIRST under bounded concurrency, ACCEPTS
//      each rendering, GATES it through the Q3/Q2 reviewer, and — only on a clean
//      pass — records it and INSTALLS its canonical target form.
//   3. SEALS the decisions: it computes the installed canonical forms and only
//      THEN enters the descriptive phase (no descriptive rendering, and no
//      production line, precedes the installed bible).
//   4. Renders the DESCRIPTIVE tier (style, voice, arcs, cultural notes) under
//      bounded concurrency and records each accepted rendering.
//   5. RECOVERS by missing-rendering query: a step whose rendering already exists
//      is skipped.
// It re-proves no translation content; it accepts, gates, orders, and persists.
// Production and pilot always build the full bible — there is no bypass here.

import { mapWithConcurrency } from "../source-wiki/concurrency.js";
import { buildLocalizedWikiPlan } from "./plan.js";
import { acceptRendering } from "./rendering.js";
import { reviewDecision, type DecisionReview } from "./review-gate.js";
import { installCanonicalForms, type ValidatedDecision } from "./install.js";
import { assertDecisionTierFirst } from "./ordering.js";
import { localizerProfileRoles } from "./posture.js";
import type {
  BibleStep,
  BibleTier,
  BibleRenderingLedger,
  DecisionReviewer,
  LocalizationPosture,
  LocalizedWikiPlan,
  LocalizerRunner,
  RenderingKey,
  RenderingStamp,
} from "./types.js";
import type { GlossaryApprovedForm } from "../gates/index.js";
import type { LocalizedRendering, RoleId, RunModeValue, WikiObject } from "../contracts/index.js";

/** Observability hooks — the ordering and recovery proofs read these; the control
 * flow does not depend on them. */
export interface LocalizedWikiObserver {
  onRenderingRecorded?(tier: BibleTier, key: RenderingKey): void;
  onStepSkipped?(step: BibleStep): void;
  onDecisionInstalled?(form: GlossaryApprovedForm): void;
  onDecisionRejected?(step: BibleStep, review: DecisionReview): void;
  /** Fires exactly once, AFTER the decisions are installed and BEFORE any
   * descriptive rendering runs — the seam the "decisions-first" proof reads. */
  onDescriptivePhaseStart?(installedForms: readonly GlossaryApprovedForm[]): void;
}

export interface OrchestrateLocalizedWikiDeps {
  readonly sourceObjects: readonly WikiObject[];
  readonly targetLanguage: string;
  readonly posture: LocalizationPosture;
  readonly runMode: RunModeValue;
  readonly localizationSnapshotId: string;
  readonly concurrency: number;
  readonly runner: LocalizerRunner;
  readonly reviewer: DecisionReviewer;
  readonly ledger: BibleRenderingLedger;
  readonly observer?: LocalizedWikiObserver;
}

/** One decision's disposition after the reviewer gate. */
export interface DecisionOutcome {
  readonly targetKey: RenderingKey;
  readonly decisionClass: "L-Name" | "L-Term";
  readonly validated: boolean;
  readonly skipped: boolean;
}

/** The run report: the localizer posture, the installed canonical forms (the
 * gate values), the per-decision dispositions, and the rendered/skipped key
 * sets (the recovery evidence). */
export interface LocalizedWikiRunReport {
  readonly targetLanguage: string;
  readonly posture: LocalizationPosture;
  readonly localizerRoles: readonly RoleId[];
  readonly installedForms: readonly GlossaryApprovedForm[];
  readonly decisions: readonly DecisionOutcome[];
  readonly descriptiveCount: number;
  readonly renderedKeys: readonly RenderingKey[];
  readonly skippedKeys: readonly RenderingKey[];
}

/** A rendering step must yield exactly its one assigned target rendering. */
function acceptOne(
  produced: readonly LocalizedRendering[],
  step: BibleStep,
  stamp: RenderingStamp,
): LocalizedRendering {
  if (produced.length !== 1) {
    throw new Error(
      `bible step ${step.stepId} must produce exactly one rendering, produced ${produced.length}`,
    );
  }
  const rendering = produced[0]!;
  acceptRendering(rendering, step.target, stamp);
  return rendering;
}

interface Mutable {
  readonly existing: Set<RenderingKey>;
  readonly rendered: RenderingKey[];
  readonly skipped: RenderingKey[];
}

interface DecisionStepResult {
  readonly outcome: DecisionOutcome;
  readonly validatedDecision: ValidatedDecision | null;
}

/** Run one decision step: skip if its rendering exists; else render, accept, gate
 * through Q3/Q2, and (only on a clean pass) record + surface for install. */
async function runDecisionStep(
  deps: OrchestrateLocalizedWikiDeps,
  step: BibleStep,
  stamp: RenderingStamp,
  state: Mutable,
): Promise<DecisionStepResult> {
  const decisionClass = step.decisionClass!;
  if (state.existing.has(step.target.key)) {
    state.skipped.push(step.target.key);
    deps.observer?.onStepSkipped?.(step);
    return {
      outcome: { targetKey: step.target.key, decisionClass, validated: false, skipped: true },
      validatedDecision: null,
    };
  }
  const produced = await deps.runner({
    tier: "decision",
    decisionClass,
    sourceObject: step.sourceObject,
    target: step.target,
    stamp,
  });
  const rendering = acceptOne(produced, step, stamp);
  const review = await reviewDecision(
    { decisionClass, sourceObject: step.sourceObject, rendering, stamp },
    deps.reviewer,
  );
  if (!review.validated) {
    deps.observer?.onDecisionRejected?.(step, review);
    return {
      outcome: { targetKey: step.target.key, decisionClass, validated: false, skipped: false },
      validatedDecision: null,
    };
  }
  await deps.ledger.record([rendering]);
  state.existing.add(step.target.key);
  state.rendered.push(step.target.key);
  deps.observer?.onRenderingRecorded?.("decision", step.target.key);
  return {
    outcome: { targetKey: step.target.key, decisionClass, validated: true, skipped: false },
    validatedDecision: { sourceObject: step.sourceObject, rendering },
  };
}

/** Run one descriptive step: skip if its rendering exists; else render, accept,
 * record. No reviewer gate — descriptive content is best-effort. */
async function runDescriptiveStep(
  deps: OrchestrateLocalizedWikiDeps,
  step: BibleStep,
  stamp: RenderingStamp,
  state: Mutable,
): Promise<boolean> {
  if (state.existing.has(step.target.key)) {
    state.skipped.push(step.target.key);
    deps.observer?.onStepSkipped?.(step);
    return false;
  }
  const produced = await deps.runner({
    tier: "descriptive",
    decisionClass: null,
    sourceObject: step.sourceObject,
    target: step.target,
    stamp,
  });
  const rendering = acceptOne(produced, step, stamp);
  await deps.ledger.record([rendering]);
  state.existing.add(step.target.key);
  state.rendered.push(step.target.key);
  deps.observer?.onRenderingRecorded?.("descriptive", step.target.key);
  return true;
}

/**
 * Build the plan and execute it against the ledger. The DECISION phase runs and
 * installs FIRST; the DESCRIPTIVE phase never starts until the canonical forms
 * are installed. Returns the run report. Production and pilot always build the
 * full bible — there is no early return, no skip, no collapse.
 */
export async function orchestrateLocalizedWiki(
  deps: OrchestrateLocalizedWikiDeps,
): Promise<LocalizedWikiRunReport> {
  const plan: LocalizedWikiPlan = buildLocalizedWikiPlan(
    deps.sourceObjects,
    deps.targetLanguage,
    deps.posture,
  );
  // The decisions-first invariant is a hard precondition of execution.
  assertDecisionTierFirst(plan.phases);
  const decisionPhase = plan.phases.find((phase) => phase.tier === "decision")!;
  const descriptivePhase = plan.phases.find((phase) => phase.tier === "descriptive")!;

  const stamp: RenderingStamp = {
    targetLanguage: deps.targetLanguage,
    localizationSnapshotId: deps.localizationSnapshotId,
    runMode: deps.runMode,
  };
  const state: Mutable = {
    existing: new Set(await deps.ledger.existingKeys()),
    rendered: [],
    skipped: [],
  };

  // Phase 0 — the L-Term / L-Name decisions, FIRST.
  const decisionResults = await mapWithConcurrency(decisionPhase.steps, deps.concurrency, (step) =>
    runDecisionStep(deps, step, stamp, state),
  );
  const validatedDecisions = decisionResults
    .map((result) => result.validatedDecision)
    .filter((decision): decision is ValidatedDecision => decision !== null);
  const installedForms = installCanonicalForms(validatedDecisions);
  for (const form of installedForms) deps.observer?.onDecisionInstalled?.(form);

  // Seal: the descriptive phase (and every downstream production line) sees the
  // installed bible — it cannot start before this point.
  deps.observer?.onDescriptivePhaseStart?.(installedForms);

  // Phase 1 — the descriptive renderings.
  const descriptiveProduced = await mapWithConcurrency(
    descriptivePhase.steps,
    deps.concurrency,
    (step) => runDescriptiveStep(deps, step, stamp, state),
  );

  return {
    targetLanguage: deps.targetLanguage,
    posture: deps.posture,
    localizerRoles: localizerProfileRoles().map((specialist) => specialist.roleId),
    installedForms,
    decisions: decisionResults.map((result) => result.outcome),
    descriptiveCount: descriptiveProduced.filter(Boolean).length,
    renderedKeys: state.rendered,
    skippedKeys: state.skipped,
  };
}

/** Convenience: build the plan without executing it (partition + ordering only). */
export function planLocalizedWiki(
  sourceObjects: readonly WikiObject[],
  targetLanguage: string,
  posture: LocalizationPosture,
): LocalizedWikiPlan {
  return buildLocalizedWikiPlan(sourceObjects, targetLanguage, posture);
}
