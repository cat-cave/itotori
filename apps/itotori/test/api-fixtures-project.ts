import { readFileSync } from "node:fs";
import type { BenchmarkReportSummary, RuntimeDashboardStatus } from "@itotori/db";
import type { FindingRecordV02 } from "@itotori/localization-bridge-schema";
import type { RuntimeIngestResult } from "../src/services/project-operations-port.js";
import type { ProjectState } from "../src/services/project-types.js";
import type { ProjectOverviewReadModel } from "../src/project-overview-read-model.js";
import { costDrilldownFixture, dashboardStatusFixture } from "./api-fixtures-dashboard.js";
import { dashboardDecisionsFixture } from "./api-fixtures-catalog.js";
import { costReportFixture } from "./api-fixtures-settings.js";
import {
  benchmarkReportFixture,
  bridgeFixture,
  runtimeReportFixture,
} from "./api-fixtures-public-contracts.js";

export { benchmarkReportFixture, bridgeFixture, runtimeReportFixture };

const bridgeFixtureUnit = requiredFixtureValue(bridgeFixture.units[0], "bridge unit");
const bridgeUnitId = bridgeFixtureUnit.bridgeUnitId;
const bridgeSourceUnitKey = bridgeFixtureUnit.sourceUnitKey;

export const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_failed",
  runtimeRunId: "runtime-1",
  runtimeReportId: "runtime-1",
  runtimeStatus: "failed",
  fidelityTier: "layout_probe",
  evidenceTier: "E2",
  textEventCount: 1,
  frameCaptureCount: 0,
  screenshotArtifactCount: 1,
  recordingArtifactCount: 0,
  validationFindingCount: 1,
  traceEvents: [
    {
      runtimeEventId: "runtime-1:trace-1",
      eventKind: "text_seen",
      bridgeUnitId,
      sourceUnitKey: bridgeSourceUnitKey,
      draftId: `locale-1:${bridgeUnitId}`,
      runtimeTargetId: bridgeSourceUnitKey,
      evidenceTier: null,
      frame: 12,
      textPreview: "Hello, {player}.",
      artifactIds: ["runtime-1:trace-artifact-1"],
    },
  ],
  findings: [
    {
      findingId: "runtime-1:finding-1",
      findingKind: "text_mismatch",
      severity: "error",
      message: "Observed runtime text did not match the draft text.",
      evidenceTier: "E2",
      bridgeUnitId,
      sourceUnitKey: bridgeSourceUnitKey,
      artifactId: "runtime-1:trace-artifact-1",
    },
  ],
  artifacts: [
    {
      artifactId: "runtime-1:screenshot-1",
      artifactKind: "screenshot",
      uri: "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
      hash: "sha256:runtime-screenshot",
      hashProvenance: "content",
      mediaType: "image/png",
      byteSize: 2048,
      bridgeUnitId,
      sourceUnitKey: bridgeSourceUnitKey,
      diagnostic: null,
    },
    {
      artifactId: "runtime-1:trace-artifact-1",
      artifactKind: "trace_log",
      uri: "artifacts/utsushi/runtime/runtime-1/traces/trace-1.json",
      hash: "sha256:runtime-trace",
      hashProvenance: "content",
      mediaType: "application/json",
      byteSize: 512,
      bridgeUnitId,
      sourceUnitKey: bridgeSourceUnitKey,
      diagnostic: null,
    },
  ],
  approximations: [
    {
      approximationId: "runtime-1:approximation-1",
      approximationTier: "synthetic_fixture",
      scope: "capture",
      description: "Fixture capture approximates a host runtime frame.",
      evidenceTierCeiling: "E2",
      bridgeUnitIds: [bridgeUnitId],
    },
  ],
  unsupportedCapabilities: [
    {
      feature: "recording",
      status: "unsupported",
      fidelityTierCeiling: null,
      evidenceTierCeiling: null,
      limitations: ["Fixture adapter does not emit recordings."],
    },
  ],
  limitations: ["No reference-runtime pixel comparison is performed."],
};

export const projectFixture: ProjectState = {
  projectId: "project-1",
  localeBranchId: "locale-1",
  targetLocale: "fr-FR",
  drafts: { [bridgeUnitId]: "Bonjour, {player}." },
  bridge: bridgeFixture,
};

export const runtimeIngestResultFixture: RuntimeIngestResult = {
  status: "hello_world_passed",
  bridgeId: bridgeFixture.bridgeId,
  localeBranchId: "locale-1",
  patchExportId: "019ed001-0000-7000-8000-000000000901",
  patchResultId: "019ed001-0000-7000-8000-000000000950",
  runtimeReportId: runtimeReportFixture.runtimeReportId,
  dashboard: dashboardStatusFixture,
};

export const findingRecordFixture = readFixture<{ finding: FindingRecordV02 }>(
  "../../../packages/localization-bridge-schema/test/examples/finding-v0.2.json",
).finding;

// policy — the dashboard benchmark read model derived from the REAL
// recorded benchmark report fixture (same QA calibration the workflow
// persists), so the MSW handler stays in lockstep with the real schema.
export const benchmarkReportSummaryFixture: BenchmarkReportSummary = {
  benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
  projectId: "project-1",
  localeBranchId: benchmarkReportFixture.localeBranchId ?? null,
  benchmarkName: benchmarkReportFixture.benchmarkName,
  status: benchmarkReportFixture.status,
  createdAt: benchmarkReportFixture.createdAt,
  sourceLocale: benchmarkReportFixture.sourceLocale,
  targetLocale: benchmarkReportFixture.targetLocale,
  systemCount: benchmarkReportFixture.systemsCompared.length,
  findingCount: benchmarkReportFixture.findingRecords.length,
  penaltyTotal: benchmarkReportFixture.penaltySummary.penaltyTotal,
  qaAgents: [],
};

export const benchmarkReportsFixture: BenchmarkReportSummary[] = [benchmarkReportSummaryFixture];

export const projectOverviewFixture: ProjectOverviewReadModel = {
  schemaVersion: "projects.overview.v0.1",
  generatedAt: "2026-07-07T00:00:00.000Z",
  projectId: dashboardStatusFixture.projectId,
  progress: dashboardStatusFixture,
  decisions: dashboardDecisionsFixture,
  cost: costReportFixture,
  telemetry: {
    projectId: dashboardStatusFixture.projectId,
    bucket: "day",
    rows: [
      {
        bucketStart: "2026-06-16T00:00:00.000Z",
        runCount: 1,
        billedMicrosUsd: 900,
        costPerRunMicrosUsd: 900,
      },
      {
        bucketStart: "2026-06-17T00:00:00.000Z",
        runCount: 2,
        billedMicrosUsd: 1280,
        costPerRunMicrosUsd: 640,
      },
    ],
    throughputSeries: [1, 2],
    costPerRunSeries: [900, 640],
  },
  costDrilldown: costDrilldownFixture,
  journal: {
    filter: {
      projectId: dashboardStatusFixture.projectId,
      localeBranchId: dashboardStatusFixture.selectedLocaleBranchId,
    },
    pagination: {
      total: 1,
      limit: 10,
      offset: 0,
      page: 1,
      pageCount: 1,
      hasMore: false,
      nextOffset: null,
    },
    rows: [
      {
        journalRunId: "localization-journal-fixture-1",
        projectId: dashboardStatusFixture.projectId,
        localeBranchId: dashboardStatusFixture.selectedLocaleBranchId ?? "locale-branch-1",
        status: "completed",
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:01:30.000Z",
        wallClockMs: 90_000,
        attemptedUnitCount: 2,
        finalizedUnitCount: 2,
        patchedUnitCount: 1,
        physicalCallCount: 3,
        deadlineFailureCount: 0,
        spentMicrosUsd: 240,
        reservedMicrosUsd: 0,
        servedPairs: [{ model: "fixture-model", provider: "fixture-provider" }],
        patchVersionId: "patch-version-fixture-1",
        patchStatus: "playable",
      },
    ],
  },
  benchmarkHeadline: {
    reportCount: benchmarkReportsFixture.length,
    latestReport: benchmarkReportsFixture[0] ?? null,
  },
  canSteer: true,
};

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

function requiredFixtureValue<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`fixture is missing ${label}`);
  return value;
}

// policy — project MUTATION route fixtures.
//
// Each project mutation route the dashboard / SPA mutation layer POSTs to has
// a SUCCESS request + response pair. The response shapes are the EXACT types
// `assertItotoriApiResponse` checks against the real api-schema contract, so
// the MSW handlers in `msw-handlers.ts` and the contract-drift tests in
// `msw-mutation-handlers.test.ts` catch a shape change (a renamed field, a
// narrowed enum, a new required field) instead of silently diverging.
//
// `apiMutationBadRequestResponseFixture` and
// `apiMutationForbiddenResponseFixture` are the shared typed error responses
// every mutation route may emit (a `bad_request` validation failure and a
// `forbidden` permission / scoping denial — policy). They are checked
// against `assertItotoriApiErrorResponse`.
