import { describe, expect, it } from "vitest";
import {
  AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION,
  AgenticLoopBundleValidationError,
  asNonBlankTargetText,
  assertAgenticLoopBundle,
  parseAgenticLoopBundle,
} from "../src/agentic-loop-bundle.js";

function validWrittenOutcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "outcome-001",
    status: "written",
    unitId: "unit-001",
    targetLocale: "en-US",
    selectedCandidateId: "candidate-primary-001",
    candidates: [
      {
        id: "candidate-primary-001",
        outcomeId: "outcome-001",
        body: "Hello, traveler.",
        producedBy: { modelId: "model-primary", providerId: "provider-primary" },
        attemptId: "attempt-primary-001",
        kind: "primary",
      },
    ],
    findings: [
      {
        id: "finding-001",
        outcomeId: "outcome-001",
        candidateId: "candidate-primary-001",
        severity: "critical",
        category: "accuracy",
        note: "The target wording needs play-test attention.",
        contested: false,
        confidence: 0.75,
      },
    ],
    qualityFlags: ["qa_unresolved"],
    provenance: { source: "agentic-loop-test" },
    writtenAt: "2026-07-11T12:00:00Z",
    ...overrides,
  };
}

function validBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION,
    bridgeUnitId: "unit-001",
    projectId: "project-001",
    localeBranchId: "branch-001",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    stages: [],
    writtenOutcome: validWrittenOutcome(),
    ...overrides,
  };
}

function clonedBundle(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validBundle())) as Record<string, unknown>;
}

function writtenOutcomeOf(bundle: Record<string, unknown>): Record<string, unknown> {
  return bundle.writtenOutcome as Record<string, unknown>;
}

function candidatesOf(outcome: Record<string, unknown>): Array<Record<string, unknown>> {
  return outcome.candidates as Array<Record<string, unknown>>;
}

function findingsOf(outcome: Record<string, unknown>): Array<Record<string, unknown>> {
  return outcome.findings as Array<Record<string, unknown>>;
}

describe("AgenticLoopBundle written outcome", () => {
  it("accepts one selected non-blank candidate even when QA has a critical annotation", () => {
    const bundle = validBundle();

    expect(() => assertAgenticLoopBundle(bundle)).not.toThrow();
    const parsed = parseAgenticLoopBundle(JSON.stringify(bundle));
    expect(parsed.writtenOutcome.status).toBe("written");
    expect(parsed.writtenOutcome.selectedCandidateId).toBe("candidate-primary-001");
    expect(parsed.writtenOutcome.candidates[0]?.body).toBe("Hello, traveler.");
    expect(parsed.writtenOutcome.findings[0]?.severity).toBe("critical");
  });

  it("brands only trimmed, non-blank, non-source-replay target text", () => {
    expect(asNonBlankTargetText("Hello, traveler.")).toBe("Hello, traveler.");

    for (const invalid of ["", "   ", " Hello", "Hello ", "[en-US]こんにちは"]) {
      expect(() => asNonBlankTargetText(invalid)).toThrow(AgenticLoopBundleValidationError);
    }
  });

  it("rejects the legacy deferred/final-draft surface", () => {
    const bundle = validBundle({
      finalDraft: { bridgeUnitId: "unit-001", deferredReason: "legacy defer" },
    });

    expect(() => assertAgenticLoopBundle(bundle)).toThrow(/finalDraft/);
  });

  it("requires the singleton written status, a candidate, and provenance", () => {
    const nonWritten = clonedBundle();
    writtenOutcomeOf(nonWritten).status = "deferred";
    expect(() => assertAgenticLoopBundle(nonWritten)).toThrow(/status/);

    const noCandidates = clonedBundle();
    writtenOutcomeOf(noCandidates).candidates = [];
    expect(() => assertAgenticLoopBundle(noCandidates)).toThrow(/minItems/);

    const noProvenance = clonedBundle();
    delete writtenOutcomeOf(noProvenance).provenance;
    expect(() => assertAgenticLoopBundle(noProvenance)).toThrow(/provenance/);
  });

  it("requires a selected candidate that is bound to this outcome", () => {
    const unresolvedSelection = clonedBundle();
    writtenOutcomeOf(unresolvedSelection).selectedCandidateId = "candidate-missing";
    expect(() => assertAgenticLoopBundle(unresolvedSelection)).toThrow(/selectedCandidateId/);

    const wrongOutcome = clonedBundle();
    candidatesOf(writtenOutcomeOf(wrongOutcome))[0]!.outcomeId = "other-outcome";
    expect(() => assertAgenticLoopBundle(wrongOutcome)).toThrow(/outcomeBinding/);
  });

  it("rejects blank, padded, and locale-tagged candidate bodies", () => {
    for (const body of ["", "  ", " Hello", "Hello ", "[en-US]こんにちは"]) {
      const bundle = clonedBundle();
      candidatesOf(writtenOutcomeOf(bundle))[0]!.body = body;
      expect(() => assertAgenticLoopBundle(bundle)).toThrow(AgenticLoopBundleValidationError);
    }
  });

  it("requires every QA annotation to bind to this outcome and an extant candidate", () => {
    const unknownCandidate = clonedBundle();
    findingsOf(writtenOutcomeOf(unknownCandidate))[0]!.candidateId = "candidate-missing";
    expect(() => assertAgenticLoopBundle(unknownCandidate)).toThrow(/candidateId/);

    const wrongOutcome = clonedBundle();
    findingsOf(writtenOutcomeOf(wrongOutcome))[0]!.outcomeId = "other-outcome";
    expect(() => assertAgenticLoopBundle(wrongOutcome)).toThrow(/outcomeBinding/);
  });

  it("binds the written outcome to the requested unit and target locale", () => {
    const wrongUnit = clonedBundle();
    writtenOutcomeOf(wrongUnit).unitId = "other-unit";
    expect(() => assertAgenticLoopBundle(wrongUnit)).toThrow(/unitBinding/);

    const wrongLocale = clonedBundle();
    writtenOutcomeOf(wrongLocale).targetLocale = "fr-FR";
    expect(() => assertAgenticLoopBundle(wrongLocale)).toThrow(/localeBinding/);
  });
});
