// ITOTORI-078 — Pure-TS fixture factories for QA findings.
//
// Stand-alone factory functions used by tests + downstream consumers to
// assemble realistic finding shapes. Carries NO database dependency: the
// `qa_findings` table is owned by a follow-up node (ITOTORI-074 lands
// `draft_jobs` in parallel), so these fixtures only commit to the wire
// shape from `@itotori/localization-bridge-schema`.

import {
  QA_FINDING_CATEGORIES,
  QA_FINDING_SEVERITIES,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  type QaFinding,
  type QaFindingCategory,
  type QaFindingSeverity,
  type QaFindingSpan,
  type StructuredQaFindingOutput,
} from "@itotori/localization-bridge-schema";

const FIXTURE_DRAFT_JOB_ID = "019ed079-0000-7000-8000-000000000d00";
const FIXTURE_BRIDGE_UNIT_BASE = "019ed079-0000-7000-8000-000000000a";

export type QaFindingFactoryOverrides = {
  findingId?: string;
  bridgeUnitId?: string;
  severity?: QaFindingSeverity;
  category?: QaFindingCategory;
  sourceSpan?: QaFindingSpan;
  draftSpan?: QaFindingSpan;
  evidenceRefs?: string[];
  recommendation?: string;
  agentRationale?: string;
};

/**
 * Builds a single finding with sensible defaults plus overrides. The
 * defaults vary by severity / category so tests can compose realistic
 * multi-finding fixtures without duplicating every field.
 */
export function makeQaFindingFixture(overrides: QaFindingFactoryOverrides = {}): QaFinding {
  const severity = overrides.severity ?? "minor";
  const category = overrides.category ?? "tone";
  const findingId =
    overrides.findingId ??
    `019ed079-0000-7000-8000-${severityCategoryShortHash(severity, category)}`;
  const bridgeUnitId = overrides.bridgeUnitId ?? `${FIXTURE_BRIDGE_UNIT_BASE}01`;
  const finding: QaFinding = {
    findingId,
    bridgeUnitId,
    severity,
    category,
    evidenceRefs: overrides.evidenceRefs ?? [`style-guide:${category}`],
    recommendation: overrides.recommendation ?? defaultRecommendationFor(category),
    agentRationale:
      overrides.agentRationale ?? `Default ${severity}/${category} rationale for ${bridgeUnitId}.`,
  };
  if (overrides.sourceSpan !== undefined) {
    finding.sourceSpan = overrides.sourceSpan;
  }
  if (overrides.draftSpan !== undefined) {
    finding.draftSpan = overrides.draftSpan;
  }
  return finding;
}

/**
 * Returns one finding per (severity × category) combination — useful for
 * exhaustive shape-coverage tests downstream.
 */
export function makeAllSeverityCategoryFindings(): QaFinding[] {
  const out: QaFinding[] = [];
  let counter = 1;
  for (const severity of QA_FINDING_SEVERITIES) {
    for (const category of QA_FINDING_CATEGORIES) {
      const findingIdSuffix = counter.toString(16).padStart(12, "0");
      out.push(
        makeQaFindingFixture({
          findingId: `019ed079-0000-7000-8000-${findingIdSuffix}`,
          bridgeUnitId: `${FIXTURE_BRIDGE_UNIT_BASE}${(counter % 16).toString(16).padStart(2, "0")}`,
          severity,
          category,
        }),
      );
      counter += 1;
    }
  }
  return out;
}

/**
 * Builds a complete `StructuredQaFindingOutput` from an array of
 * findings — what a recorded bundle would contain.
 */
export function makeStructuredQaFindingOutputFixture(
  findings: QaFinding[],
): StructuredQaFindingOutput {
  return {
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings,
  };
}

/**
 * Returns a canonical fixture covering each severity at one representative
 * category, with both source and draft spans populated. Cheap import for
 * the common test path.
 */
export function representativeQaFindingsFixture(): QaFinding[] {
  return [
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000001",
      bridgeUnitId: `${FIXTURE_BRIDGE_UNIT_BASE}01`,
      severity: "critical",
      category: "protected-span-violation",
      sourceSpan: { start: 6, end: 14 },
      draftSpan: { start: 5, end: 13 },
      evidenceRefs: ["style-guide:protectedSpans"],
      recommendation: "Restore the dropped placeholder before exporting the patch.",
      agentRationale: "Source carries {player}; draft drops the placeholder entirely.",
    }),
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000002",
      bridgeUnitId: `${FIXTURE_BRIDGE_UNIT_BASE}02`,
      severity: "major",
      category: "glossary-conflict",
      evidenceRefs: ["glossary:term-yusha"],
      recommendation: "Use 'hero' for 勇者 per glossary.",
      agentRationale:
        "Draft renders 勇者 as 'warrior' contradicting the glossary preferredTargetForm.",
    }),
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000003",
      bridgeUnitId: `${FIXTURE_BRIDGE_UNIT_BASE}03`,
      severity: "minor",
      category: "tone",
      sourceSpan: { start: 0, end: 6 },
      evidenceRefs: ["style-guide:tone-formal"],
      recommendation: "Match the formal register established by neighbouring units.",
      agentRationale: "Draft adopts a casual register while neighbours stay formal.",
    }),
    makeQaFindingFixture({
      findingId: "019ed079-0000-7000-8000-100000000004",
      bridgeUnitId: `${FIXTURE_BRIDGE_UNIT_BASE}04`,
      severity: "info",
      category: "context-mismatch",
      evidenceRefs: ["scene-summary:scene-001"],
      recommendation: "Confirm the scene context matches the chosen referent.",
      agentRationale:
        "Ambiguous pronoun in the source; draft picks one referent without supporting evidence.",
    }),
  ];
}

function defaultRecommendationFor(category: QaFindingCategory): string {
  switch (category) {
    case "mistranslation":
      return "Re-translate the unit to match the source meaning.";
    case "tone":
      return "Adjust the tone to match the active style guide entry.";
    case "glossary-conflict":
      return "Use the glossary's preferred target form.";
    case "protected-span-violation":
      return "Preserve every protected span verbatim.";
    case "terminology-drift":
      return "Reuse the established term from earlier in the corpus.";
    case "redaction":
      return "Apply the configured redaction rule.";
    case "context-mismatch":
      return "Reconcile the draft with the surrounding scene context.";
    case "other":
      return "Address the issue described in agentRationale.";
  }
}

function severityCategoryShortHash(
  severity: QaFindingSeverity,
  category: QaFindingCategory,
): string {
  // Deterministic non-cryptographic id suffix for fixture findings. We
  // want stable ids without hashing dependencies, so we synthesise a
  // 12-hex suffix from severity / category indices.
  const sevIdx = QA_FINDING_SEVERITIES.indexOf(severity);
  const catIdx = QA_FINDING_CATEGORIES.indexOf(category);
  const packed = sevIdx * 100 + catIdx;
  return packed.toString(16).padStart(12, "0");
}

/** Stable fixture id callers may reference as the draft job FK target. */
export const QA_FIXTURE_DRAFT_JOB_ID = FIXTURE_DRAFT_JOB_ID;
