// ITOTORI-022 — Finding triage + root-cause router.
//
// Takes the combined output of:
//   - the QA agent set (typed `QaFinding[]` from ITOTORI-021),
//   - the second-layer protected-span validator (typed
//     `DraftProtectedSpanViolation[]` from ITOTORI-076), and
//   - human-reported findings (typed `HumanFinding[]` from this module),
//
// and classifies each one into exactly one `RootCause`. The orchestrator
// (ITOTORI-222) consumes the routing result to decide between
// retranslation, glossary edits, Kaifuu issues, style-guide updates,
// runtime escalation, or human triage.
//
// Hard invariants:
//   - Every routing rule is deterministic. No random tie-breakers, no
//     model invocations.
//   - Every switch covers every enum value at the type level. The
//     `default` branch calls `assertNever`, so adding a new
//     `QaFindingCategory`, `DraftProtectedSpanViolationKind`, or
//     `HumanFindingAttribution` without extending the matching switch is
//     a compile error.
//   - `unknown` is a *typed* class. There is no `null`-or-undefined
//     return path; every finding ends up with a `RootCause`.
//   - `as any` and `@ts-ignore` are forbidden. The router resolves all
//     unions with proper exhaustiveness checks.

import type { QaFinding, QaFindingCategory } from "@itotori/localization-bridge-schema";
import type {
  DraftProtectedSpanViolation,
  DraftProtectedSpanViolationKind,
} from "../draft/protected-span-validator.js";
import type { HumanFinding, HumanFindingAttribution } from "./human-finding.js";
import {
  ROOT_CAUSE_CLASSES,
  type RootCause,
  type RootCauseClass,
  type RootCauseConfidence,
} from "./root-cause.js";
import {
  buildSuggestedAction,
  defaultAffectedComponent,
  type SuggestedActionContext,
} from "./suggested-action.js";

/**
 * Project / draft scope for the routing pass. The router does not read
 * from the database — callers pass the ids and shallow projections it
 * needs to surface in the rationale (e.g. project name in a future
 * dashboard view). All fields are optional; an empty context is valid
 * for unit tests.
 */
export type TriageContext = {
  projectId?: string;
  draftJobId?: string;
};

export type FindingTriageInput = {
  findings: ReadonlyArray<QaFinding>;
  protectedSpanViolations: ReadonlyArray<DraftProtectedSpanViolation>;
  humanFindings?: ReadonlyArray<HumanFinding>;
  context: TriageContext;
};

export type FindingTriageRouting = {
  findingId: string;
  rootCause: RootCause;
};

export type FindingTriageSummary = {
  byClass: Record<RootCauseClass, number>;
  /**
   * Findings that came in with a `critical` severity (QA `critical` /
   * human `critical`). The orchestrator uses this to gate automatic merge:
   * any critical-count > 0 must be recorded through a canonical context
   * correction or result revision before a later iteration can proceed.
   */
  criticalCount: number;
};

export type FindingTriageResult = {
  routings: FindingTriageRouting[];
  summary: FindingTriageSummary;
};

/**
 * Deterministic, type-exhaustive router. Stateless; constructed once
 * per process. The `route` method is pure.
 */
export class FindingTriageRouter {
  route(input: FindingTriageInput): FindingTriageResult {
    const routings: FindingTriageRouting[] = [];
    const byClass = emptyClassCounts();
    let criticalCount = 0;

    for (const finding of input.findings) {
      const rootCause = this.routeQaFinding(finding);
      routings.push({ findingId: finding.findingId, rootCause });
      byClass[rootCause.class] += 1;
      if (finding.severity === "critical") {
        criticalCount += 1;
      }
    }

    for (const violation of input.protectedSpanViolations) {
      const rootCause = this.routeProtectedSpanViolation(violation);
      routings.push({
        // Protected-span violations key on `spanRefId` + `bridgeUnitId`
        // (the validator does not mint a finding id). We synthesize a
        // stable composite id so the triage record can be joined back to
        // the originating violation deterministically.
        findingId: protectedSpanViolationId(violation),
        rootCause,
      });
      byClass[rootCause.class] += 1;
      // Acceptance-time violations are systematically severe — the
      // acceptance gate refuses to publish a draft with any violation.
      // We count them as critical for the orchestrator's gate.
      criticalCount += 1;
    }

    const humanFindings = input.humanFindings ?? [];
    for (const finding of humanFindings) {
      const rootCause = this.routeHumanFinding(finding);
      routings.push({ findingId: finding.findingId, rootCause });
      byClass[rootCause.class] += 1;
      if (finding.severity === "critical") {
        criticalCount += 1;
      }
    }

    return {
      routings,
      summary: { byClass, criticalCount },
    };
  }

  // -------------------------------------------------------------------------
  // QA-finding routing. Every `QaFindingCategory` MUST appear in this
  // switch — the `default` is `assertNever`.
  // -------------------------------------------------------------------------

  private routeQaFinding(finding: QaFinding): RootCause {
    const category: QaFindingCategory = finding.category;
    const offendingTerm = extractOffendingTermFromQaFinding(finding);
    const actionContext: SuggestedActionContext =
      offendingTerm === undefined
        ? { findingSummary: finding.recommendation }
        : { findingSummary: finding.recommendation, offendingTerm };

    switch (category) {
      case "mistranslation": {
        return buildRootCause({
          rootCauseClass: "translator_mistake",
          confidence: "high",
          rationale: `QA finding category 'mistranslation' on bridge unit ${finding.bridgeUnitId}: ${finding.recommendation}`,
          actionContext,
        });
      }
      case "glossary-conflict": {
        return buildRootCause({
          rootCauseClass: "glossary_conflict",
          confidence: "high",
          rationale: `QA finding category 'glossary-conflict' on bridge unit ${finding.bridgeUnitId}: ${finding.recommendation}`,
          actionContext,
        });
      }
      case "terminology-drift": {
        return buildRootCause({
          rootCauseClass: "glossary_conflict",
          // Terminology drift is *adjacent* to a glossary conflict but
          // may also be a stylistic preference; downrank to medium so
          // the dashboard surfaces it for contextual verification before
          // editing the glossary outright.
          confidence: "medium",
          rationale: `QA finding category 'terminology-drift' on bridge unit ${finding.bridgeUnitId}: ${finding.recommendation}`,
          actionContext,
        });
      }
      case "protected-span-violation": {
        return buildRootCause({
          rootCauseClass: "kaifuu_patching",
          confidence: "high",
          rationale: `QA finding category 'protected-span-violation' on bridge unit ${finding.bridgeUnitId}: the bridge unit's protected span was damaged — file a Kaifuu issue.`,
          actionContext,
        });
      }
      case "context-mismatch": {
        return buildRootCause({
          rootCauseClass: "stale_context",
          confidence: "high",
          rationale: `QA finding category 'context-mismatch' on bridge unit ${finding.bridgeUnitId}: ${finding.recommendation}`,
          actionContext,
        });
      }
      case "tone": {
        // Tone findings split: minor tone drifts are style-guide work;
        // major / critical tone errors are translator mistakes (the
        // model picked an inappropriate register). The rule below pins
        // the `minor → style_guide_issue` mapping; everything else falls
        // to `translator_mistake` at high confidence.
        if (finding.severity === "minor") {
          return buildRootCause({
            rootCauseClass: "style_guide_issue",
            confidence: "medium",
            rationale: `QA finding category 'tone' (minor) on bridge unit ${finding.bridgeUnitId}: candidate style-guide refinement — ${finding.recommendation}`,
            actionContext,
          });
        }
        return buildRootCause({
          rootCauseClass: "translator_mistake",
          confidence: "high",
          rationale: `QA finding category 'tone' (severity=${finding.severity}) on bridge unit ${finding.bridgeUnitId}: ${finding.recommendation}`,
          actionContext,
        });
      }
      case "redaction": {
        return buildRootCause({
          rootCauseClass: "source_annotation_issue",
          confidence: "high",
          rationale: `QA finding category 'redaction' on bridge unit ${finding.bridgeUnitId}: source contains content the agent should not have processed — ${finding.recommendation}`,
          actionContext,
        });
      }
      case "other": {
        return buildRootCause({
          rootCauseClass: "unknown",
          confidence: "low",
          rationale: `QA finding category 'other' on bridge unit ${finding.bridgeUnitId}: no routing rule matched — ${finding.recommendation}`,
          actionContext,
        });
      }
      default: {
        return assertNever(category);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Protected-span-violation routing. Every
  // `DraftProtectedSpanViolationKind` MUST appear in this switch.
  // -------------------------------------------------------------------------

  private routeProtectedSpanViolation(violation: DraftProtectedSpanViolation): RootCause {
    const kind: DraftProtectedSpanViolationKind = violation.kind;
    const actionContext: SuggestedActionContext = {
      findingSummary: violation.detail,
      offendingTerm: violation.spanRefId,
      bridgeUnitId: violation.bridgeUnitId,
    };

    switch (kind) {
      case "span_deleted":
      case "span_moved":
      case "span_duplicated": {
        return buildRootCause({
          rootCauseClass: "translator_mistake",
          confidence: "high",
          rationale: `Protected-span violation '${kind}' on span ${violation.spanRefId} (bridge unit ${violation.bridgeUnitId}): ${violation.detail}`,
          actionContext,
        });
      }
      case "malformed_markup": {
        return buildRootCause({
          rootCauseClass: "kaifuu_patching",
          confidence: "high",
          rationale: `Protected-span violation 'malformed_markup' on span ${violation.spanRefId} (bridge unit ${violation.bridgeUnitId}): source markup itself is malformed — file a Kaifuu issue.`,
          actionContext,
        });
      }
      case "capitalization_drift":
      case "glossary_mistranslation": {
        return buildRootCause({
          rootCauseClass: "glossary_conflict",
          confidence: "high",
          rationale: `Protected-span violation '${kind}' on span ${violation.spanRefId} (bridge unit ${violation.bridgeUnitId}): ${violation.detail}`,
          actionContext,
        });
      }
      case "variable_substituted": {
        return buildRootCause({
          rootCauseClass: "source_annotation_issue",
          confidence: "high",
          rationale: `Protected-span violation 'variable_substituted' on span ${violation.spanRefId} (bridge unit ${violation.bridgeUnitId}): variable annotation needs review — ${violation.detail}`,
          actionContext,
        });
      }
      default: {
        // Exhaustiveness guard: adding a new
        // `DraftProtectedSpanViolationKind` (ITOTORI-076) without
        // extending this switch fails the typecheck here.
        return assertNever(kind);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Human-finding routing. Every `HumanFindingAttribution` MUST appear
  // in this switch.
  // -------------------------------------------------------------------------

  private routeHumanFinding(finding: HumanFinding): RootCause {
    const attribution: HumanFindingAttribution = finding.attribution;
    const actionContext: SuggestedActionContext = {
      findingSummary: finding.summary,
    };

    switch (attribution) {
      case "runtime": {
        return buildRootCause({
          rootCauseClass: "runtime_evidence",
          confidence: "high",
          rationale: `Human finding with attribution='runtime' (category=${finding.category}): ${finding.summary}`,
          actionContext,
        });
      }
      case "translator":
      case "playtest": {
        // Translator and playtest attributions do not yet have a dedicated
        // root-cause rule. Today we emit `unknown` with `low` confidence and
        // an explicit rationale naming the attribution so the dashboard groups
        // them without claiming spurious routing accuracy.
        return buildRootCause({
          rootCauseClass: "unknown",
          confidence: "low",
          rationale: `Human finding with attribution='${attribution}' (category=${finding.category}): no routing rule matched — ${finding.summary}`,
          actionContext,
        });
      }
      default: {
        return assertNever(attribution);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type BuildRootCauseArgs = {
  rootCauseClass: RootCauseClass;
  confidence: RootCauseConfidence;
  rationale: string;
  actionContext: SuggestedActionContext;
};

function buildRootCause(args: BuildRootCauseArgs): RootCause {
  return {
    class: args.rootCauseClass,
    confidence: args.confidence,
    rationale: args.rationale,
    suggestedAction: buildSuggestedAction(args.rootCauseClass, args.actionContext),
    affectedComponent: defaultAffectedComponent(args.rootCauseClass),
  };
}

function emptyClassCounts(): Record<RootCauseClass, number> {
  // Construct an object with every `RootCauseClass` initialized to zero.
  // We use the closed list `ROOT_CAUSE_CLASSES` and assert the shape via
  // a typed reduce — no `as any`.
  const seed: Partial<Record<RootCauseClass, number>> = {};
  for (const cls of ROOT_CAUSE_CLASSES) {
    seed[cls] = 0;
  }
  // The reduce above covers every key in the closed enum, so the cast is
  // safe at runtime. We avoid `as any` and `as unknown as` by using a
  // Partial-then-narrow pattern: a final pass asserts that every key is
  // defined.
  for (const cls of ROOT_CAUSE_CLASSES) {
    if (seed[cls] === undefined) {
      throw new Error(`emptyClassCounts: failed to seed class '${cls}'`);
    }
  }
  return seed as Record<RootCauseClass, number>;
}

function protectedSpanViolationId(violation: DraftProtectedSpanViolation): string {
  // Stable composite id: `protected-span:<bridgeUnitId>:<spanRefId>:<kind>`
  // — deterministic so the orchestrator can join the routing back to
  // the originating violation without ambiguity.
  return `protected-span:${violation.bridgeUnitId}:${violation.spanRefId}:${violation.kind}`;
}

function extractOffendingTermFromQaFinding(finding: QaFinding): string | undefined {
  // Heuristic: when the finding cites an evidence ref of the form
  // `glossary://<term>` (the QA prompt template emits these), pull the
  // term out for the suggested-action URL. The router does NOT scan
  // recommendation prose — the term must be declared on `evidenceRefs`.
  for (const ref of finding.evidenceRefs) {
    if (ref.startsWith("glossary://")) {
      const term = ref.slice("glossary://".length);
      if (term.length > 0) {
        return term;
      }
    }
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`exhaustiveness check failed: unexpected triage routing value ${String(value)}`);
}
