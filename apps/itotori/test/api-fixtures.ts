import { readFileSync } from "node:fs";
import type { ProjectDashboardStatus, RuntimeDashboardStatus } from "@itotori/db";
import type {
  BenchmarkReportV02,
  BridgeBundle,
  FindingRecordV02,
  RuntimeVerificationReport,
  TriageEventV02,
} from "@itotori/localization-bridge-schema";
import type { ProjectState, RuntimeIngestResult } from "../src/services/project-workflow.js";

export const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceBundleRevisionId: "revision-1",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 3,
  latestEventKind: "patch_result_recorded",
  latestEventAt: "2026-06-17T00:00:00.000Z",
  localeBranches: [
    {
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      status: "active",
      unitCount: 1,
      translatedUnitCount: 1,
      openFindingCount: 0,
      artifactCount: 3,
    },
  ],
};

export const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_passed",
  runtimeReportId: "runtime-1",
  runtimeStatus: "passed",
  fidelityTier: "layout_probe",
  evidenceTier: null,
  textEventCount: 1,
  frameCaptureCount: 1,
  screenshotArtifactCount: 1,
  recordingArtifactCount: 0,
  validationFindingCount: 0,
};

export const bridgeFixture: BridgeBundle = {
  schemaVersion: "0.1.0",
  bridgeId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceLocale: "ja-JP",
  extractorName: "kaifuu-fixture",
  extractorVersion: "0.0.0",
  units: [
    {
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "hello.scene.001.line.001",
      occurrenceId: "occurrence-1",
      sourceHash: "source-hash-1",
      sourceLocale: "ja-JP",
      sourceText: "こんにちは、{player}。",
      textSurface: "dialogue",
      protectedSpans: [
        { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
      ],
      patchRef: {
        assetId: "source.json",
        writeMode: "replace",
        sourceUnitKey: "hello.scene.001.line.001",
      },
    },
  ],
};

export const projectFixture: ProjectState = {
  projectId: "project-1",
  localeBranchId: "locale-1",
  targetLocale: "en-US",
  drafts: { "bridge-unit-1": "Hello, {player}." },
  bridge: bridgeFixture,
};

export const runtimeReportFixture: RuntimeVerificationReport = {
  schemaVersion: "0.1.0",
  runtimeReportId: "runtime-1",
  adapterName: "utsushi-fixture",
  fidelityTier: "layout_probe",
  status: "passed",
  textEvents: [
    {
      runtimeTextEventId: "runtime-text-1",
      bridgeUnitId: "bridge-unit-1",
      text: "Hello, {player}.",
      frame: 1,
    },
  ],
  frameCaptures: [
    {
      frameCaptureId: "frame-1",
      bridgeUnitId: "bridge-unit-1",
      width: 320,
      height: 180,
      nonZeroPixels: 57600,
      artifactPath: "fixture://frame/1",
    },
  ],
  approximations: ["fixture"],
};

export const runtimeIngestResultFixture: RuntimeIngestResult = {
  status: "hello_world_passed",
  bridgeId: "bridge-1",
  localeBranchId: "locale-1",
  patchExportId: undefined,
  patchResultId: "patch-result-1",
  runtimeReportId: "runtime-1",
  dashboard: dashboardStatusFixture,
};

export const decisionEventFixture: TriageEventV02 = {
  eventId: "019ed004-0000-7000-8000-000000000201",
  eventKind: "triage_decision_recorded",
  occurredAt: "2026-06-17T00:00:00.000Z",
  actor: { actorKind: "human", displayName: "Fixture reviewer" },
  subjectRefs: [],
  provenance: [
    {
      provenanceId: "019ed004-0000-7000-8000-000000000202",
      provenanceKind: "human_review",
      noteHash: "sha256:decision-fixture-note",
    },
  ],
  causalLinks: [],
  payload: { optionId: "accept_fixture_decision" },
};

export const findingRecordFixture = readFixture<{ finding: FindingRecordV02 }>(
  "../../../packages/localization-bridge-schema/test/examples/finding-v0.2.json",
).finding;

export const benchmarkReportFixture = readFixture<BenchmarkReportV02>(
  "../../../packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
);

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}
