// ITOTORI-021 — Fresh-judge regrade loop.
//
// When the scored-finding workflow's `overall` drops below
// `regradeThreshold`, this loop invokes a SECOND, independent QA pass
// against the SAME draft using a different prompt template version AND
// different model metadata (a "fresh judge"). The fresh judge's
// findings are reconciled against the original to assign confidence
// markers without self-confirmation bias.
//
// Hard rules:
//   - regrade runs AT MOST ONCE — never iterative;
//   - the fresh judge MUST have a different prompt template version AND
//     a different model id (refused otherwise);
//   - any failure of the fresh judge throws — never silently falls back
//     to the original report.
//
// Confidence assignment (per the spec):
//   - confirmed (both runs)   → confidence 'medium' (default)
//   - disputed (original only) → confidence 'low'
//   - new      (fresh only)   → confidence 'high' (original missed it)
//
// Confidence lives in a side table keyed by findingId; we never extend
// the wire `QaFinding` shape (its schema forbids additional properties).

import type { AuthorizationActor } from "@itotori/db";
import type { QaFinding } from "@itotori/localization-bridge-schema";
import type { FocusedQaAgentName, QaAgentSet } from "../agents/qa/agents/index.js";
import type { QaInvocationInput } from "../agents/qa/shapes.js";
import {
  aggregateScoredFindings,
  type ScoredFindingsReport,
  type ScoredQaPerAgentResult,
  type ScoredQaWorkflowInput,
  type ScoredQaWorkflowResult,
} from "./scored-finding-workflow.js";

export const REGRADE_DEFAULT_THRESHOLD = 0.7;

/**
 * Confidence tag attached to each finding AFTER regrade. Before regrade,
 * findings carry no confidence (the score is finding-derived; confidence
 * is only meaningful in the context of a two-judge comparison).
 */
export type FindingConfidence = "low" | "medium" | "high";

/**
 * Reason the finding earned its confidence tag.
 *   - 'confirmed-by-fresh-judge'   → present in both runs
 *   - 'disputed-by-fresh-judge'    → original only (fresh judge did not flag it)
 *   - 'discovered-by-fresh-judge'  → fresh only (original missed it)
 */
export type FindingConfidenceReason =
  | "confirmed-by-fresh-judge"
  | "disputed-by-fresh-judge"
  | "discovered-by-fresh-judge";

export type FindingConfidenceEntry = {
  findingId: string;
  confidence: FindingConfidence;
  reason: FindingConfidenceReason;
  source: "original" | "fresh-judge";
};

/**
 * The regraded report carries everything the original report carried
 * PLUS the per-finding confidence markers. The aggregate scores are
 * recomputed from the merged finding set (original + fresh-judge-new),
 * so a finding the original missed but the fresh judge caught drives
 * the unit score down too.
 */
export type RegradedFindingsReport = ScoredFindingsReport & {
  confidence: Map<string, FindingConfidenceEntry>;
  regradeApplied: true;
  regradedReport: {
    originalOverallScore: number;
    freshOverallScore: number;
    threshold: number;
    confirmedFindingCount: number;
    disputedFindingCount: number;
    newFindingCount: number;
  };
};

export type RegradeLoopResult =
  | { regradeApplied: false; report: ScoredFindingsReport }
  | { regradeApplied: true; report: RegradedFindingsReport };

// ---------------------------------------------------------------------------
// Independence guard
// ---------------------------------------------------------------------------

/**
 * Thrown when the caller hands the regrade loop a fresh-judge agent set
 * whose prompt template version OR model id is the same as the
 * original's. Self-grading is not a regrade.
 */
export class QaFreshJudgeIndependenceError extends Error {
  constructor(
    public readonly agentName: FocusedQaAgentName,
    public readonly conflictKind: "qaPromptVersion" | "modelId",
    public readonly observedOriginal: string,
    public readonly observedFresh: string,
  ) {
    super(
      `fresh-judge regrade refused: focused agent '${agentName}' shares ${conflictKind} '${observedOriginal}' with the original (fresh='${observedFresh}'); self-grading is not a regrade`,
    );
    this.name = "QaFreshJudgeIndependenceError";
  }
}

// ---------------------------------------------------------------------------
// Loop entry point
// ---------------------------------------------------------------------------

export type RegradeLoopOptions = {
  /**
   * Threshold below which the regrade triggers. Defaults to 0.7. A
   * value <= 0 means regrade always runs; >= 1.0 means regrade never
   * runs (but the loop is then a no-op and callers should just use the
   * base workflow).
   */
  regradeThreshold?: number;
  /**
   * The fresh judge agent set. Must have:
   *   - a DIFFERENT `qaPromptVersion` on every focused agent (the spec
   *     suggests `${original}.regrade.v1`); AND
   *   - a DIFFERENT model id from the original input's modelProfile.
   *
   * Independence is checked up-front before the first invocation.
   */
  freshJudge: QaAgentSet;
  /**
   * The model profile the fresh judge uses. Distinct from the original
   * `input.modelProfile`; the loop refuses if they share modelId.
   */
  freshJudgeModelProfile: QaInvocationInput["modelProfile"];
};

/**
 * Run the fresh-judge regrade loop on top of an initial workflow result.
 * If the workflow's overall score is at or above `regradeThreshold`, the
 * loop is a no-op and returns the original report unchanged. Otherwise
 * the fresh judge is invoked once and the merged report is returned.
 */
export async function runFreshJudgeRegrade(args: {
  actor: AuthorizationActor;
  input: ScoredQaWorkflowInput;
  originalResult: ScoredQaWorkflowResult;
  options: RegradeLoopOptions;
}): Promise<RegradeLoopResult> {
  const threshold = args.options.regradeThreshold ?? REGRADE_DEFAULT_THRESHOLD;
  const originalReport = args.originalResult.report;
  if (originalReport.scores.overall >= threshold) {
    return { regradeApplied: false, report: originalReport };
  }

  assertFreshJudgeIndependent({
    original: args.originalResult,
    fresh: args.options.freshJudge,
    originalModelProfile: args.input.modelProfile,
    freshModelProfile: args.options.freshJudgeModelProfile,
  });

  const freshInput: ScoredQaWorkflowInput = {
    ...args.input,
    modelProfile: args.options.freshJudgeModelProfile,
  };
  const freshPerAgent = await invokeFreshAgents({
    actor: args.actor,
    input: freshInput,
    freshJudge: args.options.freshJudge,
  });

  const merged = reconcileFindings({
    original: args.originalResult.perAgent,
    fresh: freshPerAgent,
  });
  const mergedReport = aggregateScoredFindings(merged.mergedPerAgent, args.input.units);
  const freshReport = aggregateScoredFindings(freshPerAgent, args.input.units);

  const regraded: RegradedFindingsReport = {
    ...mergedReport,
    confidence: merged.confidence,
    regradeApplied: true,
    regradedReport: {
      originalOverallScore: originalReport.scores.overall,
      freshOverallScore: freshReport.scores.overall,
      threshold,
      confirmedFindingCount: merged.counts.confirmed,
      disputedFindingCount: merged.counts.disputed,
      newFindingCount: merged.counts.discovered,
    },
  };
  return { regradeApplied: true, report: regraded };
}

// ---------------------------------------------------------------------------
// Independence assertion
// ---------------------------------------------------------------------------

function assertFreshJudgeIndependent(args: {
  original: ScoredQaWorkflowResult;
  fresh: QaAgentSet;
  originalModelProfile: QaInvocationInput["modelProfile"];
  freshModelProfile: QaInvocationInput["modelProfile"];
}): void {
  // Model id MUST differ. The loop refuses to invoke the fresh judge on
  // the same model that produced the original findings — even with a
  // different prompt that would still risk self-confirmation bias.
  if (args.originalModelProfile.modelId === args.freshModelProfile.modelId) {
    throw new QaFreshJudgeIndependenceError(
      "style-adherence",
      "modelId",
      args.originalModelProfile.modelId,
      args.freshModelProfile.modelId,
    );
  }
  // Each focused agent's qaPromptVersion MUST differ between original
  // and fresh. We check the agent set's descriptor versions against the
  // versions the original invocations actually used (carried by their
  // injected promptVersion in the descriptor).
  const originalAgents = byName(args.original.perAgent);
  const freshAgents: ReadonlyArray<{
    name: FocusedQaAgentName;
    descriptor: { qaPromptVersion: string };
  }> = [
    args.fresh.styleAdherence,
    args.fresh.semanticDrift,
    args.fresh.toneRegister,
    args.fresh.unresolvedTerminology,
  ].map((agent) => ({ name: agent.descriptor.name, descriptor: agent.descriptor }));
  for (const freshAgent of freshAgents) {
    const original = originalAgents.get(freshAgent.name);
    if (original === undefined) {
      continue;
    }
    const originalVersion = original.invocation.modelMetadata.providerRun.prompt.templateVersion;
    if (originalVersion === freshAgent.descriptor.qaPromptVersion) {
      throw new QaFreshJudgeIndependenceError(
        freshAgent.name,
        "qaPromptVersion",
        originalVersion,
        freshAgent.descriptor.qaPromptVersion,
      );
    }
  }
}

function byName(
  perAgent: ReadonlyArray<ScoredQaPerAgentResult>,
): Map<FocusedQaAgentName, ScoredQaPerAgentResult> {
  const map = new Map<FocusedQaAgentName, ScoredQaPerAgentResult>();
  for (const entry of perAgent) {
    map.set(entry.agentName, entry);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Fresh agent invocation
// ---------------------------------------------------------------------------

async function invokeFreshAgents(args: {
  actor: AuthorizationActor;
  input: ScoredQaWorkflowInput;
  freshJudge: QaAgentSet;
}): Promise<ScoredQaPerAgentResult[]> {
  const set = args.freshJudge;
  const invocations = await Promise.all([
    set.styleAdherence.invoke(args.actor, withVersion(args.input, set.styleAdherence)),
    set.semanticDrift.invoke(args.actor, withVersion(args.input, set.semanticDrift)),
    set.toneRegister.invoke(args.actor, withVersion(args.input, set.toneRegister)),
    set.unresolvedTerminology.invoke(
      args.actor,
      withVersion(args.input, set.unresolvedTerminology),
    ),
  ]);
  return invocations.map((invocation) => ({
    agentName: invocation.agentName,
    invocation,
  }));
}

function withVersion(
  input: ScoredQaWorkflowInput,
  agent: { descriptor: { qaPromptVersion: string } },
): QaInvocationInput {
  return { ...input, qaPromptVersion: agent.descriptor.qaPromptVersion };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

type ReconcileResult = {
  mergedPerAgent: ScoredQaPerAgentResult[];
  confidence: Map<string, FindingConfidenceEntry>;
  counts: { confirmed: number; disputed: number; discovered: number };
};

/**
 * Compute the finding-shape key for the confirmed/disputed/new
 * classification. Two findings are considered the SAME if they share
 * (bridgeUnitId, category, severity) — the spec's match criterion. We
 * intentionally do NOT require the findingId, recommendation, or
 * rationale to match — those are agent-authored prose that will differ
 * across runs even when the underlying issue is identical.
 */
function findingShapeKey(finding: QaFinding): string {
  return `${finding.bridgeUnitId}|${finding.category}|${finding.severity}`;
}

function reconcileFindings(args: {
  original: ReadonlyArray<ScoredQaPerAgentResult>;
  fresh: ReadonlyArray<ScoredQaPerAgentResult>;
}): ReconcileResult {
  const originalByAgent = byName(args.original);
  const freshByAgent = byName(args.fresh);

  const confidence = new Map<string, FindingConfidenceEntry>();
  let confirmed = 0;
  let disputed = 0;
  let discovered = 0;

  const mergedPerAgent: ScoredQaPerAgentResult[] = [];

  // We merge agent-by-agent so per-agent scores reflect a single agent's
  // lane in both runs. Iterate the union of agent names from both sides
  // (in stable order: original-side first).
  const agentNames = new Set<FocusedQaAgentName>();
  for (const entry of args.original) agentNames.add(entry.agentName);
  for (const entry of args.fresh) agentNames.add(entry.agentName);

  for (const agentName of agentNames) {
    const originalEntry = originalByAgent.get(agentName);
    const freshEntry = freshByAgent.get(agentName);
    const originalFindings = originalEntry?.invocation.findings ?? [];
    const freshFindings = freshEntry?.invocation.findings ?? [];

    const originalKeys = new Map<string, QaFinding>();
    for (const finding of originalFindings) {
      originalKeys.set(findingShapeKey(finding), finding);
    }
    const freshKeys = new Map<string, QaFinding>();
    for (const finding of freshFindings) {
      freshKeys.set(findingShapeKey(finding), finding);
    }

    const mergedFindings: QaFinding[] = [];

    // Walk the original findings. Each one is either confirmed (also in
    // fresh) or disputed (only in original).
    for (const finding of originalFindings) {
      const key = findingShapeKey(finding);
      if (freshKeys.has(key)) {
        confidence.set(finding.findingId, {
          findingId: finding.findingId,
          confidence: "medium",
          reason: "confirmed-by-fresh-judge",
          source: "original",
        });
        confirmed += 1;
      } else {
        confidence.set(finding.findingId, {
          findingId: finding.findingId,
          confidence: "low",
          reason: "disputed-by-fresh-judge",
          source: "original",
        });
        disputed += 1;
      }
      mergedFindings.push(finding);
    }

    // Walk fresh findings; any whose shape key isn't in the original is
    // a discovery the original missed. We keep the fresh finding (with
    // its own findingId) and mark it high-confidence.
    for (const finding of freshFindings) {
      const key = findingShapeKey(finding);
      if (originalKeys.has(key)) {
        // Already counted on the original side; do not double-count.
        continue;
      }
      confidence.set(finding.findingId, {
        findingId: finding.findingId,
        confidence: "high",
        reason: "discovered-by-fresh-judge",
        source: "fresh-judge",
      });
      discovered += 1;
      mergedFindings.push(finding);
    }

    // Build a synthetic merged invocation result whose findings field
    // carries the union. We reuse the original invocation metadata when
    // available (provider proof of the original run); when only the
    // fresh judge ran, we reuse the fresh invocation metadata. Either
    // way the metadata names a real provider run.
    const baseInvocation = originalEntry?.invocation ?? freshEntry?.invocation;
    if (baseInvocation === undefined) {
      // Cannot happen — the agentNames set was built from non-empty
      // entries — but the type system doesn't know that.
      throw new Error(
        `regrade reconcile: no invocation metadata available for agent '${agentName}'`,
      );
    }
    mergedPerAgent.push({
      agentName,
      invocation: { ...baseInvocation, findings: mergedFindings },
    });
  }

  return {
    mergedPerAgent,
    confidence,
    counts: { confirmed, disputed, discovered },
  };
}
