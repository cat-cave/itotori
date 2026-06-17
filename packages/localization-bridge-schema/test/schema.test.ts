import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertPatchExport,
  assertRuntimeVerificationReport,
  assertTriageBundleV02,
} from "../src/index.js";

function bridgeV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/bridge-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function triageV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/triage-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

function asTestRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeDefined();
  return value as Record<string, unknown>;
}

describe("localization bridge schema guards", () => {
  it("accepts minimal valid bridge bundles", () => {
    expect(() =>
      assertBridgeBundle({
        schemaVersion: "0.1.0",
        bridgeId: "019ed000-0000-7000-8000-000000000001",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        extractorName: "kaifuu-fixture",
        extractorVersion: "0.0.0",
        units: [],
      }),
    ).not.toThrow();
  });

  it("accepts the v0.2 bridge surface example", () => {
    const bridge = bridgeV02Example();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    const units = bridge.units as Array<{ speaker?: { knowledgeState?: string } }>;
    const speakerStates = units.map((unit) => unit.speaker?.knowledgeState).filter(Boolean);
    expect(speakerStates).toContain("parser_unknown");
    expect(speakerStates).toContain("reader_unknown");
  });

  it("rejects v0.2 bridge ids that are not UUID7", () => {
    const bridge = bridgeV02Example();
    bridge.bridgeId = "not-a-uuid";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/UUID7/);
  });

  it("rejects raw or unknown v0.2 category values", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.surfaceKind = "dialogue_line";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/surfaceKind/);
  });

  it("rejects v0.1-style raw speaker strings in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = "Mira";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/speaker must be an object/);
  });

  it("rejects conflated unknown speaker state in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = { knowledgeState: "unknown" };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/knowledgeState/);
  });

  it("rejects v0.2 protected spans whose byte ranges do not match source text", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<{ spans: Array<Record<string, unknown>> }>;
    const firstSpan = units[0]?.spans[0];
    expect(firstSpan).toBeDefined();
    firstSpan.startByte = 0;

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/byte range/);
  });

  it("rejects dangling v0.2 source asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const sourceAssetRef = asTestRecord(firstUnit.sourceAssetRef, "first v0.2 source asset ref");
    sourceAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/sourceAssetRef\.assetId/);
  });

  it("rejects dangling v0.2 patch asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const patchRef = asTestRecord(firstUnit.patchRef, "first v0.2 patch ref");
    patchRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/patchRef\.assetId/);
  });

  it("rejects dangling v0.2 song audio asset references", () => {
    const bridge = bridgeV02Example();
    const songUnit = bridgeV02Units(bridge).find((unit) => {
      const context = asTestRecord(unit.context, "v0.2 unit context");
      return context.song !== undefined;
    });
    expect(songUnit).toBeDefined();
    const context = asTestRecord(songUnit?.context, "v0.2 song unit context");
    const song = asTestRecord(context.song, "v0.2 song context");
    const audioAssetRef = asTestRecord(song.audioAssetRef, "v0.2 song audio asset ref");
    audioAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/song\.audioAssetRef\.assetId/);
  });

  it("rejects unknown v0.2 policy scopes", () => {
    const bridge = bridgeV02Example();
    const policyRecords = bridge.policyRecords as Array<Record<string, unknown>>;
    const firstPolicyRecord = asTestRecord(policyRecords[0], "first v0.2 policy record");
    firstPolicyRecord.scope = "global";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/policyRecords\[0\]\.scope/);
  });

  it("accepts the v0.2 triage event and finding taxonomy example", () => {
    const triage = triageV02Example();

    expect(() => assertTriageBundleV02(triage)).not.toThrow();

    const findings = triage.findings as Array<{
      severity: string;
      qualityCategory?: string;
      provenance: Array<{ provenanceKind: string }>;
    }>;
    const provenanceKinds = new Set(
      findings.flatMap((finding) =>
        finding.provenance.map((provenance) => provenance.provenanceKind),
      ),
    );
    expect(provenanceKinds).toEqual(
      new Set(["source_annotation", "style_guide", "model_output", "patching_cause"]),
    );
    expect(findings.map((finding) => finding.severity)).toContain("P0");
    expect(findings.map((finding) => finding.qualityCategory)).toContain("style");
    expect(findings.some((finding) => finding.severity === finding.qualityCategory)).toBe(false);
  });

  it("rejects triage findings that use confidence instead of evidence", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.confidence = 0.9;

    expect(() => assertTriageBundleV02(triage)).toThrow(/confidence/i);
  });

  it("rejects triage findings without provenance", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.provenance = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(/provenance.*at least one/);
  });

  it("rejects mutable status buckets in append-only triage events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<Record<string, unknown>>;
    const firstEvent = asTestRecord(events[0], "first v0.2 triage event");
    firstEvent.payload = { status: "closed" };

    expect(() => assertTriageBundleV02(triage)).toThrow(/append-only events/);
  });

  it("rejects triage events that causally link to future events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<{ causalLinks: Array<Record<string, unknown>> }>;
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    firstEvent.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007ff",
        linkKind: "caused_by",
        targetKind: "event",
        targetId: "019ed002-0000-7000-8000-000000000102",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(/prior event/);
  });

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

  it("rejects invalid patch exports", () => {
    expect(() => assertPatchExport({ schemaVersion: "0.1.0" })).toThrow();
  });

  it("accepts runtime reports", () => {
    expect(() =>
      assertRuntimeVerificationReport({
        schemaVersion: "0.1.0",
        runtimeReportId: "019ed000-0000-7000-8000-000000000002",
        adapterName: "utsushi-fixture",
        fidelityTier: "layout_probe",
        status: "passed",
        textEvents: [],
        frameCaptures: [],
        approximations: [],
      }),
    ).not.toThrow();
  });
});
