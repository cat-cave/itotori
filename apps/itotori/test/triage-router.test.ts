// ITOTORI-022 — FindingTriageRouter unit tests.
//
// One positive test per routing rule, asserting the exact root-cause
// class + confidence. Plus:
//   - exhaustiveness tests proving every QaFindingCategory and every
//     DraftProtectedSpanViolationKind has a routing rule (no missing
//     branches);
//   - a summary test exercising mixed classes + critical count.

import { describe, expect, it } from "vitest";
import {
  QA_FINDING_CATEGORIES,
  type QaFinding,
  type QaFindingCategory,
  type QaFindingSeverity,
} from "@itotori/localization-bridge-schema";
import {
  DRAFT_PROTECTED_SPAN_VIOLATION_KINDS,
  type DraftProtectedSpanViolation,
  type DraftProtectedSpanViolationKind,
} from "../src/draft/index.js";
import {
  FindingTriageRouter,
  HUMAN_FINDING_ATTRIBUTIONS,
  ROOT_CAUSE_CLASSES,
  type HumanFinding,
  type HumanFindingAttribution,
  type RootCauseClass,
} from "../src/triage/index.js";

// ---------------------------------------------------------------------------
// Stable ids + helpers
// ---------------------------------------------------------------------------

const BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-000000aa0001";
const FINDING_ID_BASE = "019ed079-0000-7000-8000-000000ff00";

let findingIdCounter = 0;
function nextFindingId(): string {
  findingIdCounter += 1;
  return `${FINDING_ID_BASE}${findingIdCounter.toString(16).padStart(2, "0")}`;
}

function qaFinding(args: {
  category: QaFindingCategory;
  severity?: QaFindingSeverity;
  evidenceRefs?: string[];
  recommendation?: string;
}): QaFinding {
  return {
    findingId: nextFindingId(),
    bridgeUnitId: BRIDGE_UNIT_ID,
    severity: args.severity ?? "major",
    category: args.category,
    evidenceRefs: args.evidenceRefs ?? [],
    recommendation: args.recommendation ?? `recommendation for ${args.category}`,
    agentRationale: `rationale for ${args.category}`,
  };
}

function protectedSpanViolation(args: {
  kind: DraftProtectedSpanViolationKind;
  spanRefId?: string;
}): DraftProtectedSpanViolation {
  return {
    kind: args.kind,
    spanRefId: args.spanRefId ?? `span-${args.kind}`,
    spanKind: "source_unit",
    bridgeUnitId: BRIDGE_UNIT_ID,
    detail: `detail for ${args.kind}`,
    evidence: { observedRanges: [] },
  };
}

function humanFinding(args: {
  attribution: HumanFindingAttribution;
  severity?: HumanFinding["severity"];
  category?: string;
  summary?: string;
}): HumanFinding {
  return {
    findingId: nextFindingId(),
    bridgeUnitId: BRIDGE_UNIT_ID,
    attribution: args.attribution,
    severity: args.severity ?? "major",
    category: args.category ?? "free-form-category",
    summary: args.summary ?? `human summary for ${args.attribution}`,
    recordedAt: new Date("2026-06-24T00:00:00Z"),
  };
}

function makeRouter(): FindingTriageRouter {
  return new FindingTriageRouter();
}

// ---------------------------------------------------------------------------
// QA-finding routing rules
// ---------------------------------------------------------------------------

describe("FindingTriageRouter — QA findings", () => {
  it("routes QA 'mistranslation' → translator_mistake (high)", () => {
    const finding = qaFinding({ category: "mistranslation" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    expect(result.routings).toHaveLength(1);
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("translator_mistake");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("TranslationAgent");
    expect(routing.rootCause.rationale).toContain("mistranslation");
    expect(routing.rootCause.suggestedAction).toContain("retranslation");
  });

  it("routes QA 'glossary-conflict' → glossary_conflict (high)", () => {
    const finding = qaFinding({
      category: "glossary-conflict",
      evidenceRefs: ["glossary://hero"],
    });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("glossary_conflict");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("GlossaryService");
    expect(routing.rootCause.suggestedAction).toContain("glossary editor");
    expect(routing.rootCause.suggestedAction).toContain("hero");
  });

  it("routes QA 'terminology-drift' → glossary_conflict (medium)", () => {
    const finding = qaFinding({ category: "terminology-drift" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("glossary_conflict");
    expect(routing.rootCause.confidence).toBe("medium");
  });

  it("routes QA 'protected-span-violation' → kaifuu_patching (high)", () => {
    const finding = qaFinding({ category: "protected-span-violation" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("kaifuu_patching");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("kaifuu-reallive::bridge");
    expect(routing.rootCause.suggestedAction).toContain("Kaifuu");
  });

  it("routes QA 'context-mismatch' → stale_context (high)", () => {
    const finding = qaFinding({ category: "context-mismatch" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("stale_context");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("ContextRefreshService");
  });

  it("routes QA 'tone' + severity='minor' → style_guide_issue (medium)", () => {
    const finding = qaFinding({ category: "tone", severity: "minor" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("style_guide_issue");
    expect(routing.rootCause.confidence).toBe("medium");
    expect(routing.rootCause.affectedComponent).toBe("StyleGuideBuilder");
  });

  it("routes QA 'tone' + severity='major' → translator_mistake (high)", () => {
    const finding = qaFinding({ category: "tone", severity: "major" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("translator_mistake");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes QA 'redaction' → source_annotation_issue (high)", () => {
    const finding = qaFinding({ category: "redaction" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("source_annotation_issue");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("SourceAnnotationCatalog");
  });

  it("routes QA 'other' → unknown (low) with explicit rationale", () => {
    const finding = qaFinding({ category: "other" });
    const result = makeRouter().route({
      findings: [finding],
      protectedSpanViolations: [],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("unknown");
    expect(routing.rootCause.confidence).toBe("low");
    expect(routing.rootCause.rationale).toContain("no routing rule matched");
    expect(routing.rootCause.suggestedAction).toContain("Escalate");
  });
});

// ---------------------------------------------------------------------------
// Protected-span-violation routing rules
// ---------------------------------------------------------------------------

describe("FindingTriageRouter — protected-span violations", () => {
  it("routes 'span_deleted' → translator_mistake (high)", () => {
    const violation = protectedSpanViolation({ kind: "span_deleted" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.findingId).toBe(
      `protected-span:${BRIDGE_UNIT_ID}:span-span_deleted:span_deleted`,
    );
    expect(routing.rootCause.class).toBe("translator_mistake");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes 'span_moved' → translator_mistake (high)", () => {
    const violation = protectedSpanViolation({ kind: "span_moved" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("translator_mistake");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes 'span_duplicated' → translator_mistake (high)", () => {
    const violation = protectedSpanViolation({ kind: "span_duplicated" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("translator_mistake");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes 'malformed_markup' → kaifuu_patching (high)", () => {
    const violation = protectedSpanViolation({ kind: "malformed_markup" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("kaifuu_patching");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("kaifuu-reallive::bridge");
  });

  it("routes 'capitalization_drift' → glossary_conflict (high)", () => {
    const violation = protectedSpanViolation({ kind: "capitalization_drift" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("glossary_conflict");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes 'glossary_mistranslation' → glossary_conflict (high)", () => {
    const violation = protectedSpanViolation({ kind: "glossary_mistranslation" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("glossary_conflict");
    expect(routing.rootCause.confidence).toBe("high");
  });

  it("routes 'variable_substituted' → source_annotation_issue (high)", () => {
    const violation = protectedSpanViolation({ kind: "variable_substituted" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [violation],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("source_annotation_issue");
    expect(routing.rootCause.confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Human-finding routing rules
// ---------------------------------------------------------------------------

describe("FindingTriageRouter — human findings", () => {
  it("routes attribution='runtime' → runtime_evidence (high)", () => {
    const finding = humanFinding({ attribution: "runtime" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [],
      humanFindings: [finding],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("runtime_evidence");
    expect(routing.rootCause.confidence).toBe("high");
    expect(routing.rootCause.affectedComponent).toBe("RuntimeFeedbackIntake");
  });

  it("routes attribution='translator' → unknown (low)", () => {
    const finding = humanFinding({ attribution: "translator" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [],
      humanFindings: [finding],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("unknown");
    expect(routing.rootCause.confidence).toBe("low");
    expect(routing.rootCause.rationale).toContain("translator");
  });

  it("routes attribution='reviewer' → unknown (low)", () => {
    const finding = humanFinding({ attribution: "reviewer" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [],
      humanFindings: [finding],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("unknown");
    expect(routing.rootCause.confidence).toBe("low");
  });

  it("routes attribution='playtest' → unknown (low)", () => {
    const finding = humanFinding({ attribution: "playtest" });
    const result = makeRouter().route({
      findings: [],
      protectedSpanViolations: [],
      humanFindings: [finding],
      context: {},
    });
    const routing = result.routings[0];
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(routing.rootCause.class).toBe("unknown");
    expect(routing.rootCause.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness — every QaFindingCategory and every
// DraftProtectedSpanViolationKind must have a routing rule.
// ---------------------------------------------------------------------------

describe("FindingTriageRouter — exhaustiveness", () => {
  it("routes every QaFindingCategory to a typed RootCauseClass (no unknown leakage except 'other')", () => {
    const router = makeRouter();
    const observed: Record<string, RootCauseClass> = {};
    for (const category of QA_FINDING_CATEGORIES) {
      const finding = qaFinding({ category });
      const result = router.route({
        findings: [finding],
        protectedSpanViolations: [],
        context: {},
      });
      const routing = result.routings[0];
      expect(routing).toBeDefined();
      if (routing === undefined) continue;
      observed[category] = routing.rootCause.class;
      // Each routed class must be a member of the closed enum.
      expect(ROOT_CAUSE_CLASSES).toContain(routing.rootCause.class);
    }
    // The only category that legitimately routes to `unknown` is 'other'.
    for (const [category, cls] of Object.entries(observed)) {
      if (cls === "unknown") {
        expect(category).toBe("other");
      }
    }
    // Every category got a routing entry — no silent omissions.
    expect(Object.keys(observed).sort()).toEqual([...QA_FINDING_CATEGORIES].sort());
  });

  it("routes every DraftProtectedSpanViolationKind to a typed RootCauseClass (no unknown leakage)", () => {
    const router = makeRouter();
    const observed: Record<string, RootCauseClass> = {};
    for (const kind of DRAFT_PROTECTED_SPAN_VIOLATION_KINDS) {
      const violation = protectedSpanViolation({ kind });
      const result = router.route({
        findings: [],
        protectedSpanViolations: [violation],
        context: {},
      });
      const routing = result.routings[0];
      expect(routing).toBeDefined();
      if (routing === undefined) continue;
      observed[kind] = routing.rootCause.class;
      expect(ROOT_CAUSE_CLASSES).toContain(routing.rootCause.class);
      // Protected-span violations are ALWAYS deterministically routable —
      // none of them should land on `unknown`.
      expect(routing.rootCause.class).not.toBe("unknown");
    }
    expect(Object.keys(observed).sort()).toEqual([...DRAFT_PROTECTED_SPAN_VIOLATION_KINDS].sort());
  });

  it("routes every HumanFindingAttribution and counts coverage", () => {
    const router = makeRouter();
    const observed: Record<string, RootCauseClass> = {};
    for (const attribution of HUMAN_FINDING_ATTRIBUTIONS) {
      const finding = humanFinding({ attribution });
      const result = router.route({
        findings: [],
        protectedSpanViolations: [],
        humanFindings: [finding],
        context: {},
      });
      const routing = result.routings[0];
      expect(routing).toBeDefined();
      if (routing === undefined) continue;
      observed[attribution] = routing.rootCause.class;
      expect(ROOT_CAUSE_CLASSES).toContain(routing.rootCause.class);
    }
    expect(Object.keys(observed).sort()).toEqual([...HUMAN_FINDING_ATTRIBUTIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

describe("FindingTriageRouter — summary aggregation", () => {
  it("produces a correct byClass count and criticalCount across mixed findings", () => {
    const router = makeRouter();
    const findings: QaFinding[] = [
      qaFinding({ category: "mistranslation", severity: "critical" }),
      qaFinding({ category: "glossary-conflict", severity: "major" }),
      qaFinding({ category: "tone", severity: "minor" }),
      qaFinding({ category: "context-mismatch", severity: "critical" }),
      qaFinding({ category: "other", severity: "info" }),
    ];
    const result = router.route({
      findings,
      protectedSpanViolations: [],
      context: {},
    });

    expect(result.routings).toHaveLength(5);
    expect(result.summary.byClass.translator_mistake).toBe(1);
    expect(result.summary.byClass.glossary_conflict).toBe(1);
    expect(result.summary.byClass.style_guide_issue).toBe(1);
    expect(result.summary.byClass.stale_context).toBe(1);
    expect(result.summary.byClass.unknown).toBe(1);
    // Classes that didn't appear are present with a zero count.
    expect(result.summary.byClass.kaifuu_patching).toBe(0);
    expect(result.summary.byClass.runtime_evidence).toBe(0);
    expect(result.summary.byClass.source_annotation_issue).toBe(0);
    // Two critical QA findings.
    expect(result.summary.criticalCount).toBe(2);
  });

  it("counts protected-span violations as critical regardless of upstream severity", () => {
    const router = makeRouter();
    const result = router.route({
      findings: [],
      protectedSpanViolations: [
        protectedSpanViolation({ kind: "span_deleted" }),
        protectedSpanViolation({ kind: "malformed_markup" }),
      ],
      context: {},
    });
    expect(result.summary.criticalCount).toBe(2);
    expect(result.summary.byClass.translator_mistake).toBe(1);
    expect(result.summary.byClass.kaifuu_patching).toBe(1);
  });

  it("seeds every RootCauseClass key in byClass (no missing keys on empty input)", () => {
    const router = makeRouter();
    const result = router.route({
      findings: [],
      protectedSpanViolations: [],
      context: {},
    });
    for (const cls of ROOT_CAUSE_CLASSES) {
      expect(result.summary.byClass[cls]).toBe(0);
    }
    expect(result.summary.criticalCount).toBe(0);
    expect(result.routings).toEqual([]);
  });
});
