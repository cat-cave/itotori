// UTSUSHI-011 — Runtime-evidence QA tools + deterministic checks + triage.
//
// DB-less. Proves the crux:
//   1. A QA agent requests evidence through TOOLS (registry path), not raw files.
//   2. Every finding cites trace-only, screenshot-backed, or both evidence
//      through MANAGED ARTIFACT REFS.
//   3. DETERMINISTIC checks produce unambiguous findings (missing-text etc.)
//      with NO model call.
//   4. Findings route to the triage / reviewer path preserving those refs.

import { describe, expect, it } from "vitest";
import { reviewerQueueItemKindValues, type AuthorizationActor } from "@itotori/db";
import {
  AgentToolRuntime,
  DeterministicToolRegistry,
  AgentRegistry,
  RUNTIME_EVIDENCE_QA_TOOL_MANIFEST,
  RuntimeEvidenceArtifactUnresolvedError,
  buildRuntimeEvidenceQaPrompt,
  buildRuntimeEvidenceReviewerQueueItem,
  makeRuntimeEvidenceFixtureStore,
  makeRuntimeEvidenceTools,
  missingTextTool,
  missingTextToolName,
  runRuntimeEvidenceDeterministicChecks,
  runtimeEvidenceFindingsToHumanFindings,
  runtimeEvidenceFixtureExpectations,
  runtimeEvidenceFixtureReportRef,
  runtimeEvidenceQaPromptHash,
  RUNTIME_EVIDENCE_FIXTURE_IDS,
  type ManagedArtifactRef,
  type MissingTextToolInput,
  type RuntimeEvidenceFinding,
  type RuntimeEvidenceToolOutput,
} from "../src/agents/index.js";
import { fixtureInvocationContext } from "../src/agents/examples.js";
import { FindingTriageRouter } from "../src/triage/router.js";

const store = makeRuntimeEvidenceFixtureStore();
const reportRef = runtimeEvidenceFixtureReportRef();
const expectations = runtimeEvidenceFixtureExpectations();

function findingsOfKind(
  findings: ReadonlyArray<RuntimeEvidenceFinding>,
  kind: RuntimeEvidenceFinding["findingKind"],
): RuntimeEvidenceFinding[] {
  return findings.filter((f) => f.findingKind === kind);
}

describe("runtime-evidence tools read managed artifact refs", () => {
  const tools = makeRuntimeEvidenceTools(store);

  it("missing-text tool flags a unit with no observed runtime text (trace-only)", () => {
    const out = tools.missingText.run(
      { runtimeReportRef: reportRef, expectedUnits: expectations.units },
      fixtureInvocationContext,
    ) as RuntimeEvidenceToolOutput;
    const missing = findingsOfKind(out.findings, "missing_text");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.bridgeUnitId).toBe(RUNTIME_EVIDENCE_FIXTURE_IDS.unitB);
    expect(missing[0]!.evidenceBacking).toBe("trace");
    // Cites the managed runtime-report ref, not a raw file.
    expect(missing[0]!.citations[0]!.artifactRef.artifactId).toBe(reportRef.artifactId);
    expect(missing[0]!.citations[0]!.artifactRef.artifactKind).toBe("runtime_report");
  });

  it("mismatch tool flags observed != expected, citing BOTH trace and screenshot", () => {
    const out = tools.mismatch.run(
      { runtimeReportRef: reportRef, expectedUnits: expectations.units },
      fixtureInvocationContext,
    ) as RuntimeEvidenceToolOutput;
    const mismatch = findingsOfKind(out.findings, "mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.bridgeUnitId).toBe(RUNTIME_EVIDENCE_FIXTURE_IDS.unitA);
    expect(mismatch[0]!.expected).toBe("Hello, hero.");
    expect(mismatch[0]!.observed).toBe("Hello, warrior.");
    expect(mismatch[0]!.evidenceBacking).toBe("both");
    const kinds = mismatch[0]!.citations.map((c) => c.citationKind).sort();
    expect(kinds).toEqual(["screenshot", "trace"]);
  });

  it("wrong-branch tool flags a route the map forbids", () => {
    const out = tools.wrongBranch.run(
      { runtimeReportRef: reportRef, expectedBranches: expectations.branches },
      fixtureInvocationContext,
    ) as RuntimeEvidenceToolOutput;
    const wrong = findingsOfKind(out.findings, "wrong_branch");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.observed).toBe("prologue.leave");
    expect(wrong[0]!.expected).toContain("prologue.stay");
    // The branch event id is carried as the observation event id on the citation.
    expect(wrong[0]!.citations[0]!.observationEventId).toBeTruthy();
  });

  it("layout tool flags a rendered element / OCR region overflow (screenshot-backed)", () => {
    const out = tools.layout.run(
      { runtimeReportRef: reportRef },
      fixtureInvocationContext,
    ) as RuntimeEvidenceToolOutput;
    const layout = findingsOfKind(out.findings, "layout");
    // capture-D region overflow + OCR-D region overflow.
    expect(layout.length).toBe(2);
    for (const finding of layout) {
      expect(finding.evidenceBacking).toBe("screenshot");
      expect(finding.citations.some((c) => c.citationKind === "screenshot")).toBe(true);
    }
    // The OCR overflow finding additionally cites the OCR managed artifact.
    const ocrBacked = layout.find((f) => f.citations.some((c) => c.citationKind === "ocr"));
    expect(ocrBacked).toBeDefined();
    expect(ocrBacked!.citations.find((c) => c.citationKind === "ocr")!.artifactRef.artifactId).toBe(
      RUNTIME_EVIDENCE_FIXTURE_IDS.ocrDArtifact,
    );
  });

  it("ocr-hints tool returns screenshot-backed OCR text-region hints", () => {
    const out = tools.ocrHints.run(
      { runtimeReportRef: reportRef },
      fixtureInvocationContext,
    ) as RuntimeEvidenceToolOutput;
    const hints = findingsOfKind(out.findings, "ocr_hint");
    expect(hints.length).toBe(2);
    for (const hint of hints) {
      expect(hint.severity).toBe("info");
      expect(hint.evidenceBacking).toBe("screenshot");
      expect(hint.observed).toBeTruthy();
    }
  });

  it("refuses a managed ref the store cannot resolve (no silent empty)", () => {
    const badRef: ManagedArtifactRef = {
      artifactId: "019ed0b0-0000-7000-8000-0000000000ff",
      artifactKind: "runtime_report",
      uri: "artifacts/missing.json",
      hash: null,
    };
    expect(() =>
      tools.missingText.run(
        { runtimeReportRef: badRef, expectedUnits: expectations.units },
        fixtureInvocationContext,
      ),
    ).toThrow(RuntimeEvidenceArtifactUnresolvedError);
  });
});

describe("deterministic checks run without the LLM", () => {
  it("produces one finding of every kind, no model call", () => {
    const result = runRuntimeEvidenceDeterministicChecks({
      store,
      runtimeReportRef: reportRef,
      expectations,
    });
    expect(result.byKind.missing_text).toBe(1);
    expect(result.byKind.mismatch).toBe(1);
    expect(result.byKind.wrong_branch).toBe(1);
    expect(result.byKind.layout).toBe(2);
    expect(result.byKind.ocr_hint).toBe(2);
    expect(result.hasBlockingFinding).toBe(true);
    expect(result.evidenceTier).toBe("E3");
    // Every finding was produced by the deterministic detector, not an agent.
    for (const finding of result.findings) {
      expect(finding.detectorKind).toBe("deterministic_check");
    }
  });

  it("does NOT over-fire on the clean control unit (C observed via the hook stream)", () => {
    const result = runRuntimeEvidenceDeterministicChecks({
      store,
      runtimeReportRef: reportRef,
      expectations,
    });
    const touchingC = result.findings.filter(
      (f) => f.bridgeUnitId === RUNTIME_EVIDENCE_FIXTURE_IDS.unitC,
    );
    expect(touchingC).toHaveLength(0);
  });

  it("is deterministic — re-running yields identical findings", () => {
    const first = runRuntimeEvidenceDeterministicChecks({
      store,
      runtimeReportRef: reportRef,
      expectations,
    });
    const second = runRuntimeEvidenceDeterministicChecks({
      store,
      runtimeReportRef: reportRef,
      expectations,
    });
    expect(JSON.stringify(second.findings)).toBe(JSON.stringify(first.findings));
  });
});

describe("agents request evidence through the registry (not raw files)", () => {
  it("runs the missing-text tool through AgentToolRuntime and emits an event", async () => {
    const agents = new AgentRegistry();
    const tools = new DeterministicToolRegistry();
    tools.register(missingTextTool(store));
    const runtime = new AgentToolRuntime(agents, tools);

    const job = {
      jobKind: "deterministic_tool_job" as const,
      toolName: missingTextToolName,
      toolVersion: "1.0.0",
      input: {
        runtimeReportRef: reportRef,
        expectedUnits: expectations.units,
      } as MissingTextToolInput,
      context: fixtureInvocationContext,
    };
    const result = await runtime.runDeterministicToolJob<
      MissingTextToolInput,
      RuntimeEvidenceToolOutput
    >(job, { verifyReproducible: true });

    expect(result.output.outputKind).toBe("runtime_evidence_missing_text");
    expect(findingsOfKind(result.output.findings, "missing_text")).toHaveLength(1);
    expect(result.metadata.verification?.rerunOutputHash).toBe(result.metadata.outputHash);
    expect(result.event.actor.actorKind).toBe("tool");
  });
});

describe("triage integration preserves managed-ref provenance", () => {
  const actor: AuthorizationActor = { userId: "local-user" };
  const result = runRuntimeEvidenceDeterministicChecks({
    store,
    runtimeReportRef: reportRef,
    expectations,
  });

  it("routes every runtime finding to the runtime_evidence root cause", () => {
    const humanFindings = runtimeEvidenceFindingsToHumanFindings(result.findings);
    const routed = new FindingTriageRouter().route({
      findings: [],
      protectedSpanViolations: [],
      humanFindings,
      context: {},
    });
    expect(routed.routings).toHaveLength(result.findings.length);
    for (const routing of routed.routings) {
      expect(routing.rootCause.class).toBe("runtime_evidence");
    }
    expect(routed.summary.byClass.runtime_evidence).toBe(result.findings.length);
  });

  it("builds a runtimeEvidence reviewer-queue item carrying the cited refs", () => {
    const item = buildRuntimeEvidenceReviewerQueueItem({
      actor,
      projectId: "019ed0b0-0000-7000-8000-000000000f01",
      localeBranchId: "019ed0b0-0000-7000-8000-000000000f02",
      sourceRevisionId: "019ed0b0-0000-7000-8000-000000000f03",
      runtimeReportId: result.runtimeReportId,
      evidenceTier: result.evidenceTier,
      findings: result.findings,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(item.itemKind).toBe(reviewerQueueItemKindValues.runtimeEvidence);
    // Runtime-evidence invariant: evidenceTier + observation refs + artifact hashes.
    expect(item.evidenceTier).toBe("E3");
    expect(item.observationEventIds?.length).toBeGreaterThan(0);
    expect(item.artifactHashes?.length).toBeGreaterThan(0);
    // The managed runtime-report hash + a screenshot hash are both cited.
    expect(item.artifactHashes).toContain(reportRef.hash);
    expect(item.affectedArtifactIds).toContain(reportRef.artifactId);
    expect(item.affectedArtifactIds).toContain(RUNTIME_EVIDENCE_FIXTURE_IDS.captureAArtifact);
  });
});

describe("agent prompt is defined and hash-stable", () => {
  it("lists the five tools and pins a stable prompt hash", () => {
    expect(RUNTIME_EVIDENCE_QA_TOOL_MANIFEST).toHaveLength(5);
    const result = runRuntimeEvidenceDeterministicChecks({
      store,
      runtimeReportRef: reportRef,
      expectations,
    });
    const promptInput = {
      runtimeReportRef: reportRef,
      runtimeReportId: result.runtimeReportId,
      evidenceTier: result.evidenceTier,
      sourceLocale: "ja-JP" as const,
      targetLocale: "en-US" as const,
      deterministicFindings: result.findings,
    };
    const a = buildRuntimeEvidenceQaPrompt(promptInput);
    const b = buildRuntimeEvidenceQaPrompt(promptInput);
    expect(runtimeEvidenceQaPromptHash(a)).toBe(runtimeEvidenceQaPromptHash(b));
    expect(a.userText).toContain(missingTextToolName);
    expect(a.systemText).toContain("ONLY through the provided tools");
  });
});
