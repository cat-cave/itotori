import { describe, expect, it } from "vitest";
import {
  assertRuntimeEvidenceReportV02,
  assertRuntimeReport,
  assertTriageBundleV02,
} from "../src/index.js";
import {
  triageV02Example,
  runtimeEvidenceV02Example,
  traceOnlyReferenceFidelityReport,
  passedReferenceComparison,
  observationHookEventExample,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("rejects triage records with missing task or finding event references", () => {
    const triage = triageV02Example();
    const tasks = triage.tasks as Array<Record<string, unknown>>;
    const firstTask = asTestRecord(tasks[0], "first v0.2 task");
    firstTask.createdByEventId = "019ed002-0000-7000-8000-00000000ffff";

    expect(() => assertTriageBundleV02(triage)).toThrow(/createdByEventId.*existing triage event/);

    const nextTriage = triageV02Example();
    const findings = nextTriage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.firstSeenEventId = "019ed002-0000-7000-8000-00000000ffff";

    expect(() => assertTriageBundleV02(nextTriage)).toThrow(
      /firstSeenEventId.*existing triage event/,
    );
  });

  it("rejects triage causal links whose targets are missing", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<Record<string, unknown>>;
    const firstEvent = asTestRecord(events[0], "first v0.2 triage event");
    firstEvent.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f1",
        linkKind: "blocks",
        targetKind: "task",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /causalLinks\[0\]\.targetId.*existing triage task/,
    );
  });

  it("rejects task and finding causal links with missing targets for their kind", () => {
    const triage = triageV02Example();
    const tasks = triage.tasks as Array<Record<string, unknown>>;
    const firstTask = asTestRecord(tasks[0], "first v0.2 task");
    firstTask.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f2",
        linkKind: "blocks",
        targetKind: "finding",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /tasks\[0\]\.causalLinks\[0\]\.targetId.*existing triage finding/,
    );

    const nextTriage = triageV02Example();
    const findings = nextTriage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f3",
        linkKind: "supersedes",
        targetKind: "task",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(nextTriage)).toThrow(
      /findings\[0\]\.causalLinks\[0\]\.targetId.*existing triage task/,
    );
  });

  it("rejects triage findings without evidence records", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.evidence = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(/evidence.*at least one evidence record/);
  });

  it("rejects triage evidence with empty provenance ids", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /evidence\[0\]\.provenanceIds must contain at least one provenance id/,
    );
  });

  it("rejects triage evidence with dangling provenance ids", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = ["019ed002-0000-7000-8000-00000000ffff"];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /provenanceIds\[0\] must reference provenance in TriageBundleV02/,
    );
  });

  it("rejects triage evidence linked to provenance from another finding", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = ["019ed002-0000-7000-8000-000000000402"];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /provenanceIds\[0\] must reference provenance on the same finding/,
    );
  });

  it("accepts v0.2 runtime evidence with trace, branch, capture, and recording refs", () => {
    const report = runtimeEvidenceV02Example();

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
    expect(() => assertRuntimeReport(report)).not.toThrow();
    expect(report.runtimeCapabilities).toMatchObject({
      capabilityClass: "instrumented_runtime",
      evidenceTierCeiling: "E3",
    });
    expect(report.controlledPlaybackSession).toMatchObject({
      requestedOperation: "smoke_validation",
      evidenceTier: "E3",
    });

    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    expect(artifactRef.uri).toBe("artifacts/utsushi/hello/frame-0001.png");
    expect(artifactRef.uri).not.toMatch(/^artifacts\/utsushi\/runtime\//);
    expect(firstCapture).not.toHaveProperty("bytes");
    expect(firstCapture).not.toHaveProperty("data");
  });

  it("does not require the managed storage prefix for shared v0.2 runtime artifact refs", () => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    artifactRef.uri = "artifacts/utsushi/schema-fixture/frame-0001.png";

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("accepts observation hook events with partial instrumentation hook capability", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("accepts observation hook events with supported instrumentation hook capability", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];
    const runtimeCapabilities = asTestRecord(
      report.runtimeCapabilities,
      "runtime capability contract",
    );
    const features = runtimeCapabilities.features as Array<Record<string, unknown>>;
    const hookFeature = asTestRecord(
      features.find((feature) => feature.feature === "instrumentation_hooks"),
      "instrumentation hooks feature",
    );
    hookFeature.status = "supported";

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("rejects observation hook events without runtime capabilities", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];
    delete report.runtimeCapabilities;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /runtimeCapabilities is required when observationHookEvents are present/,
    );
  });

  it("rejects observation hook events without advertised instrumentation hook support", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];
    const runtimeCapabilities = asTestRecord(
      report.runtimeCapabilities,
      "runtime capability contract",
    );
    const features = runtimeCapabilities.features as Array<Record<string, unknown>>;
    const hookFeature = asTestRecord(
      features.find((feature) => feature.feature === "instrumentation_hooks"),
      "instrumentation hooks feature",
    );
    hookFeature.status = "unsupported";
    delete hookFeature.evidenceTierCeiling;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /instrumentation_hooks capability/,
    );
  });

  it("rejects observation hook events with invalid observedAt timestamps", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.observedAt = "2026-02-30T00:00:00.000Z";
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/observedAt/);
  });

  it("rejects observation hook events with blank redaction rules", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.redaction = {
      status: "redacted",
      rules: [" "],
      redactedFields: ["payload.text"],
    };
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/redaction\.rules\[0\]/);
  });

  it("rejects observation hook events whose payload kind does not match eventKind", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.eventKind = "error";
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/eventKind must match/);
  });

  it("accepts base controlled playback contracts without jump, snapshot, screenshot, or recording support", () => {
    const report = runtimeEvidenceV02Example();
    report.fidelityTier = "layout_probe";
    report.evidenceTier = "E2";
    report.branchEvents = [];
    report.recordings = [];
    report.runtimeCapabilities = {
      contractVersion: "0.2.0",
      capabilityClass: "launch_capture",
      fidelityTierCeiling: "layout_probe",
      evidenceTierCeiling: "E2",
      features: [
        {
          feature: "static_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Static trace.",
          limitations: [],
        },
        {
          feature: "text_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Text trace.",
          limitations: [],
        },
        {
          feature: "frame_capture",
          status: "partial",
          evidenceTierCeiling: "E2",
          description: "Capture metadata.",
          limitations: ["No live screenshot API."],
        },
        {
          feature: "jump",
          status: "unsupported",
          description: "Jump is not required.",
          limitations: [],
        },
        {
          feature: "snapshot",
          status: "unsupported",
          description: "Snapshot is not required.",
          limitations: [],
        },
        {
          feature: "screenshot",
          status: "unsupported",
          description: "Screenshot API is not required.",
          limitations: [],
        },
        {
          feature: "recording",
          status: "unsupported",
          description: "Recording is not required.",
          limitations: [],
        },
      ],
      limitations: ["Fixture-scoped launch/capture contract."],
    };
    report.controlledPlaybackSession = {
      sessionId: "019ed003-0000-7000-8000-000000000012",
      adapterName: "utsushi-contract-example",
      adapterVersion: "0.2.0",
      capabilityClass: "launch_capture",
      requestedOperation: "capture",
      status: "passed",
      fidelityTier: "layout_probe",
      evidenceTier: "E2",
      featuresUsed: ["static_trace", "text_trace", "frame_capture"],
      limitations: ["No jump, snapshot, screenshot API, or recording API."],
    };

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("rejects controlled playback sessions whose status diverges from report status", () => {
    const report = runtimeEvidenceV02Example();
    report.status = "failed";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /controlledPlaybackSession\.status must match RuntimeEvidenceReportV02\.status/,
    );
  });

  it("rejects trace-requested controlled playback sessions with capture evidence", () => {
    const report = runtimeEvidenceV02Example();
    const session = asTestRecord(report.controlledPlaybackSession, "controlled playback session");
    session.requestedOperation = "trace";
    report.branchEvents = [];
    report.recordings = [];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /requestedOperation trace must not carry capture evidence/,
    );
  });

  it("rejects runtime capability contracts that overclaim their class ceiling", () => {
    const report = runtimeEvidenceV02Example();
    const capabilities = asTestRecord(report.runtimeCapabilities, "runtime capability contract");
    capabilities.capabilityClass = "launch_capture";
    capabilities.evidenceTierCeiling = "E3";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /runtimeCapabilities\.fidelityTierCeiling/,
    );
  });

  it("rejects runtime evidence that uses a feature advertised as unsupported", () => {
    const report = runtimeEvidenceV02Example();
    const capabilities = asTestRecord(report.runtimeCapabilities, "runtime capability contract");
    const features = capabilities.features as Array<Record<string, unknown>>;
    const branchFeature = features.find((feature) => feature.feature === "branch_discovery");
    if (branchFeature === undefined) {
      throw new Error("test fixture missing branch_discovery feature");
    }
    branchFeature.status = "unsupported";
    delete branchFeature.evidenceTierCeiling;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/branch_discovery capability/);
  });

  it("rejects v0.2 runtime evidence that overclaims fixture fidelity", () => {
    const report = runtimeEvidenceV02Example();
    report.fidelityTier = "layout_probe";
    report.evidenceTier = "E4";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/evidenceTier must not exceed E2/);
  });

  it("rejects E4 reference fidelity without reference comparison evidence", () => {
    const report = traceOnlyReferenceFidelityReport();

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/referenceComparisons/);
  });

  it("accepts E4 reference fidelity with passed reference comparison evidence", () => {
    const report = traceOnlyReferenceFidelityReport();
    report.referenceComparisons = [passedReferenceComparison()];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
    expect(() => assertRuntimeReport(report)).not.toThrow();
  });
});
