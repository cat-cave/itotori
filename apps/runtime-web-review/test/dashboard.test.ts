// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { assertItotoriApiResponse } from "../../itotori/src/api-schema.js";
import { renderRuntimeDashboard, renderRuntimeEvidenceRoute } from "../src/dashboard.js";

type RuntimeDashboardStatus = Parameters<typeof assertRuntimeStatus>[0];

let currentFixture = runtimeFixture("passed-e2-capture");

const server = setupServer(
  http.get("http://localhost/api/runtime/v0.2/status", () => apiRuntimeStatus(currentFixture)),
  http.get("http://itotori.test/api/runtime/v0.2/status", () => apiRuntimeStatus(currentFixture)),
  http.get("http://itotori.test/api/hello/status", () => apiRuntimeStatus(currentFixture)),
);

beforeAll(() => server.listen());
afterEach(() => {
  currentFixture = runtimeFixture("passed-e2-capture");
  window.history.pushState({}, "", "/");
  document.body.innerHTML = "";
  server.resetHandlers();
});
afterAll(() => server.close());

describe("Utsushi runtime dashboard", () => {
  it("renders the runtime evidence route from the v0.2 status loader", async () => {
    currentFixture = runtimeFixture("passed-e2-capture");
    window.history.pushState({}, "", "/runtime/evidence/run-passed-e2-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    expect(root.querySelector('[data-route="runtime-evidence"]')).not.toBeNull();
    expect(root.textContent).toContain("run-passed-e2-capture");
    expect(root.textContent).toContain("report-passed-e2-capture");
    expect(root.textContent).toContain("E2");
    expect(root.querySelector("img, video")).toBeNull();
  });

  it("loads the runtime run id requested by the evidence route", async () => {
    server.use(
      http.get("http://itotori.test/api/runtime/v0.2/status", ({ request }) => {
        const runtimeRunId = new URL(request.url).searchParams.get("runtimeRunId");
        return apiRuntimeStatus(
          runtimeRunId === "run-failed-text-mismatch"
            ? runtimeFixture("failed-text-mismatch")
            : runtimeFixture("passed-e2-capture"),
        );
      }),
    );
    window.history.pushState({}, "", "/runtime/evidence/run-failed-text-mismatch");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeEvidenceRoute(
      root,
      "run-failed-text-mismatch",
      "http://itotori.test/api/runtime/v0.2/status",
    );

    expect(root.textContent).toContain("run-failed-text-mismatch");
    expect(root.textContent).toContain("hello_world_failed");
    expect(root.textContent).not.toContain("run-passed-e2-capture");
    expect(root.textContent).not.toContain("Loaded latest run differs from route run id.");
  });

  it("renders trace rows linking runtime events to bridge units, source keys, drafts, and artifacts", async () => {
    currentFixture = runtimeFixture("passed-e2-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    const trace = root.querySelector('[aria-label="Runtime trace"]');
    expect(trace?.textContent).toContain("Event id");
    expect(trace?.textContent).toContain("Event kind");
    expect(trace?.textContent).toContain("Bridge unit id");
    expect(trace?.textContent).toContain("Source unit key");
    expect(trace?.textContent).toContain("Runtime target id");
    expect(trace?.textContent).toContain("Evidence tier");
    expect(trace?.textContent).toContain("Frame");
    expect(trace?.textContent).toContain("Text preview");
    expect(trace?.textContent).toContain("Artifact links");
    expect(trace?.textContent).toContain("trace-passed-e2-capture");
    expect(trace?.textContent).toContain("bridge-unit-1");
    expect(trace?.textContent).toContain("hello.scene.001.line.001");
    expect(trace?.textContent).toContain("locale-1:bridge-unit-1");
  });

  it("opens only managed artifact-store URLs and shows hashes and MIME types", async () => {
    currentFixture = runtimeFixture("passed-e2-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href^="/artifact-store/"]')];
    expect(links).toHaveLength(3);
    expect(
      links.every((link) => link.href.includes("/artifact-store/artifacts/utsushi/runtime/")),
    ).toBe(true);
    expect(root.textContent).toContain("sha256:screen-passed-e2-capture");
    expect(root.textContent).toContain("image/png");
    expect(root.textContent).toContain("application/json");
    expect(root.innerHTML).not.toContain("/tmp/");
    expect(root.innerHTML).not.toContain("file:");
  });

  it("blocks managed artifact links that are missing content hashes", async () => {
    currentFixture = runtimeFixture("missing-managed-hash");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    expect(root.textContent).toContain("managed artifact link missing content hash");
    expect(root.textContent).toContain("sha256:trace-missing-managed-hash");
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href^="/artifact-store/"]')];
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.href.includes("/traces/trace.json"))).toBe(true);
  });

  it.each([
    ["passed E2 capture", runtimeFixture("passed-e2-capture"), "passed"],
    ["failed text mismatch", runtimeFixture("failed-text-mismatch"), "text_mismatch"],
    ["unsupported runtime feature", runtimeFixture("unsupported-runtime-feature"), "recording"],
    ["missing capture", runtimeFixture("missing-capture"), "missing_capture"],
    ["stale artifact hash", runtimeFixture("stale-artifact-hash"), "stale artifact hash"],
  ])("renders fixture state: %s", async (_name, fixture, expectedText) => {
    currentFixture = fixture;
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    expect(root.textContent).toContain(expectedText);
    expect(root.querySelector("img, video")).toBeNull();
  });

  it("renders broken and redacted artifact links as diagnostics instead of anchors", async () => {
    currentFixture = runtimeFixture("missing-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    expect(root.textContent).toContain("artifact record has no managed artifact-store URI");
    expect(root.textContent).toContain("redacted fields: uri");
    expect(root.querySelectorAll<HTMLAnchorElement>("a")).toHaveLength(0);
  });

  it("derives the frame-capture and screenshot metrics from real artifacts, never the phantom scalar counters", async () => {
    // The scalar summary counters historically double-counted a single
    // capture (frameCaptureCount === screenshotArtifactCount === total
    // captures), so the dashboard must reflect the ACTUAL persisted
    // artifacts instead. This fixture's scalar counters claim 99 captures
    // while the real artifact list holds 2 `frame_capture` + 1 `screenshot`.
    const base = runtimeFixture("passed-e2-capture");
    currentFixture = {
      ...base,
      frameCaptureCount: 99,
      screenshotArtifactCount: 99,
      artifacts: [...base.artifacts, frameArtifact("frame-a"), frameArtifact("frame-b")],
    };
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    const frames = root.querySelector('[data-metric="frame-captures"]');
    const screenshots = root.querySelector('[data-metric="screenshots"]');
    expect(frames?.textContent).toBe("2");
    expect(screenshots?.textContent).toBe("1");
    // The phantom scalar (99) must never be displayed as a live capture metric.
    expect(frames?.textContent).not.toBe("99");
    expect(screenshots?.textContent).not.toBe("99");
  });

  it("shows a real zero capture metric rather than a fabricated non-zero scalar", async () => {
    // passed-e2-capture reports scalar frameCaptureCount = 1, but ZERO
    // `frame_capture` artifacts exist (the single capture is a screenshot).
    // The dashboard must render the real 0, never the always-derivable
    // phantom 1, so an always-zero producer is never shown as a live
    // non-zero measurement.
    currentFixture = runtimeFixture("passed-e2-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/runtime/v0.2/status");

    expect(root.querySelector('[data-metric="frame-captures"]')?.textContent).toBe("0");
    expect(root.querySelector('[data-metric="screenshots"]')?.textContent).toBe("1");
  });

  it("keeps explicit hello status endpoint compatibility through the same schema", async () => {
    currentFixture = runtimeFixture("passed-e2-capture");
    const root = document.createElement("div");
    document.body.append(root);

    await renderRuntimeDashboard(root, "http://itotori.test/api/hello/status");

    expect(root.textContent).toContain("run-passed-e2-capture");
    expect(root.textContent).toContain("layout_probe");
    expect(root.textContent).toContain("1");
  });
});

function apiRuntimeStatus(body: RuntimeDashboardStatus): HttpResponse {
  assertItotoriApiResponse("runtime.status", body);
  return HttpResponse.json(body);
}

function assertRuntimeStatus(value: {
  finalStatus: string;
  runtimeRunId: string | null;
  runtimeReportId: string | null;
  runtimeStatus: string | null;
  fidelityTier: string | null;
  evidenceTier: string | null;
  textEventCount: number;
  frameCaptureCount: number;
  screenshotArtifactCount: number;
  recordingArtifactCount: number;
  validationFindingCount: number;
  traceEvents: {
    runtimeEventId: string;
    eventKind: string;
    bridgeUnitId: string | null;
    sourceUnitKey: string | null;
    draftId: string | null;
    runtimeTargetId: string | null;
    evidenceTier: string | null;
    frame: number | null;
    textPreview: string | null;
    artifactIds: string[];
  }[];
  findings: {
    findingId: string;
    findingKind: string;
    severity: string;
    message: string;
    evidenceTier: string;
    bridgeUnitId: string | null;
    sourceUnitKey: string | null;
    artifactId: string | null;
  }[];
  artifacts: {
    artifactId: string;
    artifactKind: string;
    uri: string | null;
    hash: string | null;
    mediaType: string | null;
    byteSize: number | null;
    bridgeUnitId: string | null;
    sourceUnitKey: string | null;
    diagnostic: string | null;
  }[];
  approximations: {
    approximationId: string;
    approximationTier: string;
    scope: string;
    description: string;
    evidenceTierCeiling: string;
    bridgeUnitIds: string[];
  }[];
  unsupportedCapabilities: {
    feature: string;
    status: string;
    fidelityTierCeiling: string | null;
    evidenceTierCeiling: string | null;
    limitations: string[];
  }[];
  limitations: string[];
}): void {
  void value;
}

function frameArtifact(id: string): RuntimeDashboardStatus["artifacts"][number] {
  return {
    artifactId: `frame:${id}`,
    artifactKind: "frame_capture",
    uri: `artifacts/utsushi/runtime/run-passed-e2-capture/frames/${id}.png`,
    hash: `sha256:${id}`,
    mediaType: "image/png",
    byteSize: 4096,
    bridgeUnitId: "bridge-unit-1",
    sourceUnitKey: "hello.scene.001.line.001",
    diagnostic: null,
  };
}

function runtimeFixture(
  state:
    | "passed-e2-capture"
    | "failed-text-mismatch"
    | "unsupported-runtime-feature"
    | "missing-capture"
    | "missing-managed-hash"
    | "stale-artifact-hash",
): RuntimeDashboardStatus {
  const runId = `run-${state}`;
  const reportId = `report-${state}`;
  const traceArtifactId = `${runId}:trace-artifact`;
  const screenshotArtifactId = `${runId}:screenshot`;
  const base: RuntimeDashboardStatus = {
    finalStatus: "hello_world_passed",
    runtimeRunId: runId,
    runtimeReportId: reportId,
    runtimeStatus: "passed",
    fidelityTier: "layout_probe",
    evidenceTier: "E2",
    textEventCount: 1,
    frameCaptureCount: 1,
    screenshotArtifactCount: 1,
    recordingArtifactCount: 0,
    validationFindingCount: 0,
    traceEvents: [
      {
        runtimeEventId: `trace-${state}`,
        eventKind: "text_seen",
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        draftId: "locale-1:bridge-unit-1",
        runtimeTargetId: "hello.scene.001.line.001",
        evidenceTier: "E2",
        frame: 12,
        textPreview: "Hello, reviewer.",
        artifactIds: [traceArtifactId],
      },
    ],
    findings: [],
    artifacts: [
      {
        artifactId: traceArtifactId,
        artifactKind: "trace_log",
        uri: `artifacts/utsushi/runtime/${runId}/traces/trace.json`,
        hash: `sha256:trace-${state}`,
        mediaType: "application/json",
        byteSize: 512,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        diagnostic: null,
      },
      {
        artifactId: screenshotArtifactId,
        artifactKind: "screenshot",
        uri: `artifacts/utsushi/runtime/${runId}/screenshots/frame.png`,
        hash: `sha256:screen-${state}`,
        mediaType: "image/png",
        byteSize: 4096,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "hello.scene.001.line.001",
        diagnostic: null,
      },
    ],
    approximations: [
      {
        approximationId: `${runId}:approximation`,
        approximationTier: "synthetic_fixture",
        scope: "capture",
        description: "Fixture capture approximates a host runtime frame.",
        evidenceTierCeiling: "E2",
        bridgeUnitIds: ["bridge-unit-1"],
      },
    ],
    unsupportedCapabilities: [],
    limitations: [],
  };

  if (state === "failed-text-mismatch") {
    return {
      ...base,
      finalStatus: "hello_world_failed",
      runtimeStatus: "failed",
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-text-mismatch`,
          findingKind: "text_mismatch",
          severity: "error",
          message: "Observed text was Hello, reviewer. but the draft expected Bonjour.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: traceArtifactId,
        },
      ],
    };
  }

  if (state === "unsupported-runtime-feature") {
    return {
      ...base,
      unsupportedCapabilities: [
        {
          feature: "recording",
          status: "unsupported",
          fidelityTierCeiling: null,
          evidenceTierCeiling: null,
          limitations: ["Fixture runtime cannot produce a replay recording."],
        },
      ],
      limitations: ["Recording capability is not available for this adapter."],
    };
  }

  if (state === "missing-capture") {
    return {
      ...base,
      finalStatus: "hello_world_failed",
      runtimeStatus: "failed",
      frameCaptureCount: 0,
      screenshotArtifactCount: 0,
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-missing-capture`,
          findingKind: "missing_capture",
          severity: "error",
          message: "Expected screenshot capture is missing.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: screenshotArtifactId,
        },
      ],
      artifacts: [
        {
          ...base.artifacts[0]!,
          uri: null,
          diagnostic: "redacted fields: uri",
        },
        {
          ...base.artifacts[1]!,
          uri: null,
          diagnostic: "artifact record has no managed artifact-store URI",
        },
      ],
    };
  }

  if (state === "missing-managed-hash") {
    return {
      ...base,
      artifacts: base.artifacts.map((artifact) =>
        artifact.artifactId === screenshotArtifactId
          ? {
              ...artifact,
              hash: null,
            }
          : artifact,
      ),
    };
  }

  if (state === "stale-artifact-hash") {
    return {
      ...base,
      validationFindingCount: 1,
      findings: [
        {
          findingId: `${runId}:finding-stale-hash`,
          findingKind: "stale_artifact_hash",
          severity: "warning",
          message: "Managed artifact content hash no longer matches the runtime report.",
          evidenceTier: "E2",
          bridgeUnitId: "bridge-unit-1",
          sourceUnitKey: "hello.scene.001.line.001",
          artifactId: screenshotArtifactId,
        },
      ],
      artifacts: base.artifacts.map((artifact) =>
        artifact.artifactId === screenshotArtifactId
          ? {
              ...artifact,
              hash: "sha256:old-screen",
              diagnostic: "stale artifact hash: expected sha256:new-screen",
            }
          : artifact,
      ),
    };
  }

  return base;
}
