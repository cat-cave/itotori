// ITOTORI-038 — Repair-and-rerun orchestration skeleton: shared types.
//
// This module owns the closed enums + record shapes the repair service,
// affected-work selector, and rerun event flow share. Keeping them in
// one file makes the typed surface a single import for downstream
// callers and lets the router exhaustiveness-check every variant.
//
// Hard rules (mirrored from ITOTORI-038's audit-focus list):
//   - "Pipeline-only reruns": a `RepairJob` declares EXACTLY which
//     pipeline stage to rerun (`pipelineStage`) and EXACTLY which
//     bridge units it touches (`affectedBridgeUnitIds`). The orchestrator
//     never reruns whole projects unless `affectedScope === 'project'`,
//     and that scope can only be produced by a human decision that
//     explicitly opts into it.
//   - "Lost repair provenance": every `RepairJob` records its trigger
//     (QA finding, protected-span violation, human decision) and the
//     `(modelId, providerId)` pair planned for the rerun. The service's
//     `repairHistory()` accessor returns the append-only log so the
//     audit can re-derive every job's lineage.
//   - "Over-broad invalidation": the affected-work selector narrows to
//     a specific set of bridge unit ids when the trigger names one;
//     scope widens only when a HumanDecision explicitly requests it.
//
// No `as any`, no `@ts-ignore`. Every union resolution is exhaustive
// at the type level — adding a new trigger / scope / stage enum value
// without extending the matching switch is a compile-time error.

import type { Uuid7 } from "@itotori/localization-bridge-schema";

/**
 * Closed enum of pipeline stages a repair job can target. Mirrors the
 * stage-name slice of `AgenticLoopStageName` the repair loop is allowed
 * to rerun. Stages NOT in this list (e.g. `routing`, `final_draft`) are
 * derivative outputs the orchestrator recomputes downstream.
 */
export const REPAIR_PIPELINE_STAGES = [
  "context",
  "pre_translation",
  "translation",
  "qa_findings",
] as const;
export type RepairPipelineStage = (typeof REPAIR_PIPELINE_STAGES)[number];

/**
 * Closed enum of repair-job triggers. Each value names the SOURCE of
 * the rerun signal so the audit trail can re-derive why a job exists.
 *   - `qa_finding`            — an LLM QA agent emitted a P0/P1 finding
 *                               whose root cause is `translator_mistake`
 *                               or `stale_context`.
 *   - `protected_span_violation`
 *                             — the second-layer deterministic check
 *                               flagged a span violation routed to a
 *                               repairable cause.
 *   - `human_decision`        — a reviewer / playtest report explicitly
 *                               requested a rerun.
 */
export const REPAIR_JOB_TRIGGERS = [
  "qa_finding",
  "protected_span_violation",
  "human_decision",
] as const;
export type RepairJobTrigger = (typeof REPAIR_JOB_TRIGGERS)[number];

/**
 * Closed enum of severities that drive job priority. The service refuses
 * to enqueue jobs whose normalized severity is below `p2`; the orchestrator
 * surfaces those for human triage instead of consuming repair budget.
 */
export const REPAIR_JOB_SEVERITIES = ["p0", "p1", "p2"] as const;
export type RepairJobSeverity = (typeof REPAIR_JOB_SEVERITIES)[number];

/**
 * Closed enum of the scope a repair job invalidates. The affected-work
 * selector returns one of these; the orchestrator uses it to pick
 * between unit-level / scene-level / project-level reruns.
 *   - `bridge_units` — a specific set of `Uuid7` bridge units.
 *   - `scene`        — every unit in a scene-summary's coverage set.
 *   - `project`      — every unit in the project. Only reachable from a
 *                      human decision that explicitly opts in (otherwise
 *                      the selector narrows below).
 */
export const REPAIR_AFFECTED_SCOPES = ["bridge_units", "scene", "project"] as const;
export type RepairAffectedScope = (typeof REPAIR_AFFECTED_SCOPES)[number];

/**
 * Discriminated affected-work descriptor shared by the affected-work
 * selector's output AND every `RepairJob`. The discriminant is
 * `affectedScope`.
 *
 * The `project` variant deliberately carries NO `affectedBridgeUnitIds`
 * field: a project-wide rerun has no finite, pre-enumerated unit list to
 * hand downstream — the consumer MUST expand "every unit in the project"
 * itself. By omitting the field (rather than shipping `[]`) the type makes
 * "project scope" structurally distinct from "no work": a naive consumer
 * that reads `.affectedBridgeUnitIds` without first branching on
 * `affectedScope` is a COMPILE ERROR, so an empty array can never be
 * mistaken for "nothing affected". This closes ITOTORI-038 finding
 * d5743e7b.
 */
export type RepairAffectedWork =
  | { affectedScope: "bridge_units"; affectedBridgeUnitIds: ReadonlyArray<Uuid7> }
  | { affectedScope: "scene"; affectedBridgeUnitIds: ReadonlyArray<Uuid7> }
  | { affectedScope: "project" };

/**
 * The pinned `(modelId, providerId)` pair the rerun will use. Mirrors
 * the orchestrator's pair invariant from ITOTORI-222: every LLM
 * invocation declares both fields. The repair service refuses to
 * enqueue a job whose pair is missing or empty.
 */
export type RepairProviderPair = {
  modelId: string;
  providerId: string;
};

/**
 * Input shape for the QA-finding trigger. The trigger names the
 * finding's id + severity + the bridge unit it points at; the affected-
 * work selector decides whether to widen scope.
 */
export type RepairTriggerQaFinding = {
  trigger: "qa_finding";
  findingId: Uuid7;
  bridgeUnitId: Uuid7;
  severity: RepairJobSeverity;
  /**
   * Repair targets the translation stage by default; the trigger may
   * override (e.g. a `context-mismatch` finding targets `context`).
   */
  targetStage: RepairPipelineStage;
  rationale: string;
};

/**
 * Input shape for the protected-span-violation trigger. Always targets
 * the translation stage — the second-layer check fires AFTER translation
 * and before QA.
 */
export type RepairTriggerProtectedSpanViolation = {
  trigger: "protected_span_violation";
  violationId: string;
  bridgeUnitId: Uuid7;
  severity: RepairJobSeverity;
  rationale: string;
};

/**
 * Input shape for the human-decision trigger. The reviewer / playtester
 * names the bridge units (or `scope: "project"` to opt into a full
 * rerun). The selector NEVER widens past what the human declared.
 */
export type RepairTriggerHumanDecision = {
  trigger: "human_decision";
  decisionId: string;
  decisionRecordedAt: Date;
  /**
   * Either a specific set of bridge units OR an explicit
   * `scope: "project"` request. Empty arrays are rejected so a typo'd
   * decision can't silently widen to the whole project.
   */
  scope:
    | { kind: "bridge_units"; bridgeUnitIds: ReadonlyArray<Uuid7> }
    | { kind: "scene"; sceneId: string; bridgeUnitIds: ReadonlyArray<Uuid7> }
    | { kind: "project" };
  severity: RepairJobSeverity;
  targetStage: RepairPipelineStage;
  rationale: string;
};

export type RepairTrigger =
  | RepairTriggerQaFinding
  | RepairTriggerProtectedSpanViolation
  | RepairTriggerHumanDecision;

/**
 * One queued repair job. Emitted by `RepairJobService.enqueue` AND
 * recorded on the service's append-only history. The job is the unit
 * of work an executor (the agentic-loop's repair stage) consumes.
 *
 * `parentJobId` chains successive attempts: when a rerun produces a
 * fresh finding that requires another rerun, the new job's
 * `parentJobId` points at the predecessor so the dashboard can render
 * the repair tree without re-walking the trigger log.
 */
export type RepairJob = {
  jobId: string;
  trigger: RepairTrigger;
  pipelineStage: RepairPipelineStage;
  /**
   * Pinned (modelId, providerId) pair the rerun MUST use. The pair is
   * supplied by the caller (typically derived from the active
   * pair-policy's repair leaf) and recorded verbatim so the audit can
   * prove no defaulting happened.
   */
  pair: RepairProviderPair;
  enqueuedAt: Date;
  severity: RepairJobSeverity;
  parentJobId?: string;
  /**
   * The trigger's severity narrows priority; lower numeric values are
   * dequeued first. The service derives this from `severity` so callers
   * don't have to.
   */
  priority: number;
  rationale: string;
  // The affected-work descriptor is a discriminated union (see
  // `RepairAffectedWork`): `affectedScope: 'project'` carries NO
  // `affectedBridgeUnitIds`, so an executor cannot read an empty array
  // and silently skip a project-wide rerun.
} & RepairAffectedWork;

/**
 * Append-only event a `RepairJobService` emits per state transition.
 * Captured verbatim by the service's history accessor so the audit
 * trail is self-contained.
 */
export type RepairEvent =
  | { kind: "job_enqueued"; jobId: string; at: Date; job: RepairJob }
  | { kind: "job_started"; jobId: string; at: Date }
  | { kind: "job_completed"; jobId: string; at: Date; outcome: RepairJobOutcome }
  | { kind: "job_dropped"; jobId: string; at: Date; reason: string };

/**
 * Closed enum of terminal outcomes. The service only records the
 * outcome; it does not execute the rerun. Mirrors the orchestrator's
 * routing-summary outcomes so the dashboard can join on a single key.
 */
export const REPAIR_JOB_OUTCOMES = [
  "succeeded",
  "deferred_to_human",
  "cap_exhausted",
  "no_change",
] as const;
export type RepairJobOutcome = (typeof REPAIR_JOB_OUTCOMES)[number];
