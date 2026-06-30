// ITOTORI-021 — Scored-finding workflow.
//
// Drives the four focused QA agents in parallel, aggregates their
// findings into a typed report, and derives quality scores STRICTLY from
// finding severity — never from a model self-reported confidence field.
// The wire schema (StructuredQaFindingOutput) already forbids
// `confidence`, but the score derivation rule lives HERE so the spec is
// enforced in code, not just policy.
//
// Score formula (ITOTORI-021 spec):
//
//   severityWeight(critical) = 1.0
//   severityWeight(major)    = 0.5
//   severityWeight(minor)    = 0.2
//   severityWeight(info)     = 0.05
//
//   bridgeUnitScore = clamp01(1 - sum(severityWeight(f) for f in unitFindings))
//   perAgentScore   = mean(bridgeUnitScore[unit] for unit in unitsAgentRated)
//   overallScore    = mean(perAgentScore[agent] for agent in agents)
//
// Failure semantics: if ANY focused agent throws, the workflow
// rethrows — no silent omission of an agent's findings. Callers wanting
// resilience can build a wrapping retry layer outside this seam.

import type { AuthorizationActor } from "@itotori/db";
import type { QaFinding, QaFindingSeverity } from "@itotori/localization-bridge-schema";
import type {
  FocusedQaAgentName,
  FocusedQaInvocationResult,
  QaAgentSet,
} from "../agents/qa/agents/index.js";
import type { QaInvocationInput } from "../agents/qa/shapes.js";

// ---------------------------------------------------------------------------
// Score derivation
// ---------------------------------------------------------------------------

/**
 * Closed map of severity → weight. Exposed for tests so the calibration
 * fixtures can compute expected scores without duplicating the constants.
 * Changing these constants requires a calibration refresh.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<QaFindingSeverity, number>> = {
  critical: 1.0,
  major: 0.5,
  minor: 0.2,
  info: 0.05,
};

/**
 * Cap on the total severity weight a single bridge unit can absorb when
 * computing its score. The spec calls this `maxPossibleScore`; we name
 * it explicitly so the formula reads cleanly. Value = 1.0 means: one
 * critical finding alone drives the unit score to zero.
 */
export const PER_UNIT_MAX_SEVERITY_WEIGHT = 1.0;

export function severityWeight(severity: QaFindingSeverity): number {
  return SEVERITY_WEIGHTS[severity];
}

export function deriveBridgeUnitScore(findings: ReadonlyArray<QaFinding>): number {
  if (findings.length === 0) {
    return 1.0;
  }
  const total = findings.reduce((sum, finding) => sum + severityWeight(finding.severity), 0);
  const raw = 1 - total / PER_UNIT_MAX_SEVERITY_WEIGHT;
  return clamp01(raw);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Input + result surface
// ---------------------------------------------------------------------------

/**
 * Input to the workflow. Identical shape to `QaInvocationInput` minus the
 * `qaPromptVersion` field — the workflow assigns the correct version per
 * focused agent from the descriptor on construction.
 */
export type ScoredQaWorkflowInput = Omit<QaInvocationInput, "qaPromptVersion">;

export type ScoredQaPerAgentResult = {
  agentName: FocusedQaAgentName;
  invocation: FocusedQaInvocationResult;
};

/**
 * Aggregated report. `byBridgeUnit` / `byAgent` are `Map`s rather than
 * objects so the iteration order is the insertion order the workflow
 * builds — useful for deterministic snapshot tests. `overall` is the
 * mean of per-agent scores; if zero agents rated zero units, overall is
 * 1.0 (vacuously perfect).
 */
export type ScoredFindingsReport = {
  findings: QaFinding[];
  scores: {
    byBridgeUnit: Map<string, number>;
    byAgent: Map<FocusedQaAgentName, number>;
    overall: number;
  };
  callCount: number;
  providerProofIds: string[];
};

export type ScoredQaWorkflowResult = {
  report: ScoredFindingsReport;
  perAgent: ScoredQaPerAgentResult[];
};

// ---------------------------------------------------------------------------
// Workflow class
// ---------------------------------------------------------------------------

export type ScoredFindingWorkflowOptions = {
  agents: QaAgentSet;
};

/**
 * Composes the four focused QA agents into one invocation. Always
 * invokes all four; never silently drops an agent. If any agent throws,
 * the workflow rethrows immediately (`Promise.all` semantics).
 */
export class ScoredFindingWorkflow {
  constructor(private readonly options: ScoredFindingWorkflowOptions) {}

  async invokeAllAgents(
    actor: AuthorizationActor,
    input: ScoredQaWorkflowInput,
  ): Promise<ScoredQaWorkflowResult> {
    const set = this.options.agents;
    const invocations = await Promise.all([
      set.styleAdherence.invoke(actor, withAgentPromptVersion(input, set.styleAdherence)),
      set.semanticDrift.invoke(actor, withAgentPromptVersion(input, set.semanticDrift)),
      set.toneRegister.invoke(actor, withAgentPromptVersion(input, set.toneRegister)),
      set.unresolvedTerminology.invoke(
        actor,
        withAgentPromptVersion(input, set.unresolvedTerminology),
      ),
    ]);
    const perAgent: ScoredQaPerAgentResult[] = invocations.map((invocation) => ({
      agentName: invocation.agentName,
      invocation,
    }));
    const report = aggregateScoredFindings(perAgent, input.units);
    return { report, perAgent };
  }
}

function withAgentPromptVersion(
  input: ScoredQaWorkflowInput,
  agent: { descriptor: { qaPromptVersion: string } },
): QaInvocationInput {
  return { ...input, qaPromptVersion: agent.descriptor.qaPromptVersion };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Thrown when a focused agent emits a finding on a bridge unit that is not
 * in the workflow's input `units`. `byBridgeUnit` is built strictly from
 * `input.units`, so a finding referencing an out-of-scope unit has no
 * derived unit score. We refuse to invent a score for it (a perfect 1.0
 * would silently DISCARD the finding's severity from the per-agent mean) —
 * an out-of-scope reference is a contract violation upstream
 * (`assertBridgeUnitsResolve`) and must fail loud, mirroring this module's
 * "never silently drop a finding" convention.
 */
export class ScoredFindingUnitOutOfScopeError extends Error {
  constructor(
    public readonly agentName: FocusedQaAgentName,
    public readonly bridgeUnitId: string,
  ) {
    super(
      `scored-finding aggregation refused: focused agent '${agentName}' emitted a finding on bridge unit '${bridgeUnitId}' which is not in the workflow input units; the finding references an out-of-scope unit`,
    );
    this.name = "ScoredFindingUnitOutOfScopeError";
  }
}

/**
 * Build the aggregate `ScoredFindingsReport` from per-agent invocation
 * results. Per-bridge-unit score = derived from ALL findings across ALL
 * agents that touched that unit. Per-agent score = mean of the unit
 * scores for units the agent emitted findings on. Overall = mean of
 * per-agent scores.
 *
 * Exported for the regrade loop, which re-uses the same aggregator after
 * merging confidence-tagged findings from the fresh judge.
 */
export function aggregateScoredFindings(
  perAgent: ReadonlyArray<ScoredQaPerAgentResult>,
  units: ReadonlyArray<{ bridgeUnitId: string }>,
): ScoredFindingsReport {
  const allFindings: QaFinding[] = [];
  const findingsByUnit = new Map<string, QaFinding[]>();
  const findingsByAgent = new Map<FocusedQaAgentName, QaFinding[]>();
  const providerProofIds: string[] = [];
  let callCount = 0;

  for (const entry of perAgent) {
    callCount += 1;
    providerProofIds.push(entry.invocation.providerRunId);
    findingsByAgent.set(entry.agentName, [...entry.invocation.findings]);
    for (const finding of entry.invocation.findings) {
      allFindings.push(finding);
      const existing = findingsByUnit.get(finding.bridgeUnitId);
      if (existing === undefined) {
        findingsByUnit.set(finding.bridgeUnitId, [finding]);
      } else {
        existing.push(finding);
      }
    }
  }

  // Per-unit scores: every unit in the input gets a score (1.0 if no
  // findings). Iterate units in declared order so the map iteration is
  // deterministic.
  const byBridgeUnit = new Map<string, number>();
  for (const unit of units) {
    const unitFindings = findingsByUnit.get(unit.bridgeUnitId) ?? [];
    byBridgeUnit.set(unit.bridgeUnitId, deriveBridgeUnitScore(unitFindings));
  }

  // Per-agent score: mean of unit scores for units the agent emitted at
  // least one finding on. Agents with zero findings score 1.0 (they had
  // nothing to flag).
  const byAgent = new Map<FocusedQaAgentName, number>();
  for (const entry of perAgent) {
    const ratedUnitIds = new Set(entry.invocation.findings.map((f) => f.bridgeUnitId));
    if (ratedUnitIds.size === 0) {
      byAgent.set(entry.agentName, 1.0);
      continue;
    }
    let sum = 0;
    for (const unitId of ratedUnitIds) {
      const unitScore = byBridgeUnit.get(unitId);
      if (unitScore === undefined) {
        // The finding references a unit outside input.units. Defaulting to
        // a perfect 1.0 here would silently discard its severity; refuse.
        throw new ScoredFindingUnitOutOfScopeError(entry.agentName, unitId);
      }
      sum += unitScore;
    }
    byAgent.set(entry.agentName, sum / ratedUnitIds.size);
  }

  // Overall = mean of per-agent scores. Empty agent set → vacuously 1.0.
  let overall: number;
  if (byAgent.size === 0) {
    overall = 1.0;
  } else {
    let agentSum = 0;
    for (const score of byAgent.values()) {
      agentSum += score;
    }
    overall = agentSum / byAgent.size;
  }

  return {
    findings: allFindings,
    scores: { byBridgeUnit, byAgent, overall },
    callCount,
    providerProofIds,
  };
}
