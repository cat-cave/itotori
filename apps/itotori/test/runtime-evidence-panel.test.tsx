// @vitest-environment jsdom
// rev-runtime-evidence-ui — behavior-first test for the reviewer detail
// RUNTIME EVIDENCE panel.
//
// Mounts the REAL `RuntimeEvidencePanel` over an msw-intercepted
// `/api/runtime/v0.2/status` (the `runtime.status` read-model) and asserts
// the OBSERVABLE behavior a reviewer sees: the panel reads the
// runtime-dashboard read-model THROUGH the typed client (no ad-hoc fetch)
// and renders
//   - the fidelity / evidence TIER + frame-capture + finding + artifact
//     aggregates;
//   - the TRACE row (event kind, tier, frame, source unit, text preview,
//     artifacts);
//   - the FINDINGS row (kind, severity, tier, source unit, message);
//   - the ARTIFACTS split into SENSITIVE (screenshot + recording → wrapped
//     in the shell-governed `RedactedFrame`, blurred by default) and NON-SENSITIVE
//     (trace log / frame capture / reference comparison → plain metadata),
//     with the redaction-toggle rule honored per
//     [[feedback_redaction_is_a_toggle]].
// Loading / empty / error surface independently instead of a blank panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered trace / findings / artifacts + tier + redaction surfaces are
// asserted, over msw.

import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { RuntimeDashboardStatus } from "@itotori/db";
import {
  RuntimeEvidencePanel,
  RuntimeEvidencePanelBody,
  isSensitiveRuntimeEvidenceArtifact,
  splitRuntimeEvidenceArtifacts,
} from "../src/ui/screens/RuntimeEvidencePanel.js";
import { RedactionGovernor, RedactionToggle } from "../src/ui/redaction-governor.js";
import type { ApiCallState } from "../src/api-client.js";
import { apiJson } from "./msw-handlers.js";

const REVIEW_ITEM_ID = "review-item-rev-runtime-evidence";
const STATUS_PATH = "*/api/runtime/v0.2/status";

// A representative runtime-status fixture carrying trace / findings /
// artifacts with the sensitive (screenshot + recording) and non-sensitive
// (trace log + frame capture + reference comparison) splits the panel
// renders.
function statusFixture(overrides: Partial<RuntimeDashboardStatus> = {}): RuntimeDashboardStatus {
  return {
    finalStatus: "runtime_failed",
    runtimeRunId: "runtime-1",
    runtimeReportId: "runtime-1",
    runtimeStatus: "failed",
    fidelityTier: "layout_probe",
    evidenceTier: "E2",
    textEventCount: 2,
    frameCaptureCount: 4,
    screenshotArtifactCount: 2,
    recordingArtifactCount: 1,
    validationFindingCount: 2,
    traceEvents: [
      {
        runtimeEventId: "runtime-1:trace-1",
        eventKind: "text_seen",
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        draftId: "locale-1:bridge-unit-1",
        runtimeTargetId: "scene.001.line.001",
        evidenceTier: "E2",
        frame: 12,
        textPreview: "Hello, {player}.",
        artifactIds: ["runtime-1:trace-artifact-1"],
      },
      {
        runtimeEventId: "runtime-1:trace-2",
        eventKind: "branch_resolved",
        bridgeUnitId: null,
        sourceUnitKey: null,
        draftId: null,
        runtimeTargetId: null,
        evidenceTier: "E1",
        frame: 24,
        textPreview: null,
        artifactIds: [],
      },
    ],
    findings: [
      {
        findingId: "runtime-1:finding-1",
        findingKind: "text_mismatch",
        severity: "error",
        message: "Observed runtime text did not match the draft text.",
        evidenceTier: "E2",
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        artifactId: "runtime-1:trace-artifact-1",
      },
      {
        findingId: "runtime-1:finding-2",
        findingKind: "layout",
        severity: "warning",
        message: "Rendered text overflows the frame.",
        evidenceTier: "E2",
        bridgeUnitId: "bridge-unit-2",
        sourceUnitKey: "scene.001.line.002",
        artifactId: "runtime-1:screenshot-1",
      },
    ],
    artifacts: [
      {
        artifactId: "runtime-1:screenshot-1",
        artifactKind: "screenshot",
        uri: "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-1.png",
        hash: "sha256:runtime-screenshot",
        mediaType: "image/png",
        byteSize: 2048,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        diagnostic: null,
      },
      {
        artifactId: "runtime-1:screenshot-2",
        artifactKind: "screenshot",
        uri: "artifacts/utsushi/runtime/runtime-1/screenshots/screenshot-2.png",
        hash: "sha256:runtime-screenshot-2",
        mediaType: "image/png",
        byteSize: 1536,
        bridgeUnitId: "bridge-unit-2",
        sourceUnitKey: "scene.001.line.002",
        diagnostic: null,
      },
      {
        artifactId: "runtime-1:recording-1",
        artifactKind: "recording",
        uri: "artifacts/utsushi/runtime/runtime-1/recordings/recording-1.webm",
        hash: "sha256:runtime-recording",
        mediaType: "video/webm",
        byteSize: 65536,
        bridgeUnitId: null,
        sourceUnitKey: null,
        diagnostic: null,
      },
      {
        artifactId: "runtime-1:trace-artifact-1",
        artifactKind: "trace_log",
        uri: "artifacts/utsushi/runtime/runtime-1/traces/trace-1.json",
        hash: "sha256:runtime-trace",
        mediaType: "application/json",
        byteSize: 512,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        diagnostic: null,
      },
      {
        artifactId: "runtime-1:frame-capture-1",
        artifactKind: "frame_capture",
        uri: "artifacts/utsushi/runtime/runtime-1/frames/frame-1.png",
        hash: "sha256:runtime-frame",
        mediaType: "image/png",
        byteSize: 256,
        bridgeUnitId: "bridge-unit-1",
        sourceUnitKey: "scene.001.line.001",
        diagnostic: null,
      },
      {
        artifactId: "runtime-1:reference-1",
        artifactKind: "reference_comparison",
        uri: "artifacts/utsushi/runtime/runtime-1/reference/reference-1.json",
        hash: "sha256:runtime-reference",
        mediaType: "application/json",
        byteSize: 128,
        bridgeUnitId: "bridge-unit-2",
        sourceUnitKey: "scene.001.line.002",
        diagnostic: null,
      },
    ],
    approximations: [],
    unsupportedCapabilities: [],
    limitations: [],
    ...overrides,
  };
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

// Register the success handler for the runtime-status read-model. Tests that
// need a different response register their own handler fresh.
function handleStatus(): void {
  server.use(http.get(STATUS_PATH, () => apiJson("runtime.status", statusFixture())));
}

function renderWithRedactionGovernor(
  ui: ReactNode,
  options: { revealSensitive?: boolean; defaultShareRedaction?: boolean } = {},
): void {
  render(
    <RedactionGovernor
      revealSensitive={options.revealSensitive ?? false}
      defaultShareRedaction={options.defaultShareRedaction ?? false}
    >
      <RedactionToggle />
      {ui}
    </RedactionGovernor>,
  );
}

function renderRuntimeEvidencePanel(
  options: { revealSensitive?: boolean; defaultShareRedaction?: boolean } = {},
): void {
  renderWithRedactionGovernor(<RuntimeEvidencePanel reviewItemId={REVIEW_ITEM_ID} />, options);
}

describe("RuntimeEvidencePanel — runtime.status + frame-capture read-model", () => {
  it("renders the fidelity / evidence TIER + the trace, findings, and artifacts sections", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();

    // Panel mounts + the read-model settles to ready.
    expect(await screen.findByRole("heading", { name: "Runtime evidence" })).toBeInTheDocument();
    const panel = document.querySelector('[data-pane-id="runtime-evidence"]');
    expect(panel).not.toBeNull();
    const scoped = within(panel as HTMLElement);

    // Fidelity tier renders as a Badge from the read-model.
    expect(scoped.getAllByText("layout_probe").length).toBeGreaterThanOrEqual(1);
    // Evidence tier "E2" appears at minimum in the headline readout.
    expect(scoped.getAllByText("E2").length).toBeGreaterThanOrEqual(1);

    // Frame-capture + finding + artifact aggregates paint from the read-model.
    // The fixture carries 4 frame captures, 2 findings, 6 artifacts
    // (3 sensitive + 3 non-sensitive).
    const frameCapturesStat = scoped.getByText("Frame captures").parentElement;
    expect(frameCapturesStat).toHaveTextContent("4");

    // Trace / findings / artifacts section headings all render.
    expect(scoped.getByRole("heading", { name: "Trace" })).toBeInTheDocument();
    expect(scoped.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(scoped.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
  });

  it("renders the trace events table verbatim from the read-model", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    const scoped = within(panel.closest(".itotori-panel") as HTMLElement);
    const traceSection = (panel.closest(".itotori-panel") as HTMLElement).querySelector(
      '[data-runtime-evidence-section="trace"]',
    ) as HTMLElement;
    const scopedTrace = within(traceSection);

    // Both trace events render — by eventKind + by source-unit key.
    expect(scopedTrace.getAllByText("text_seen").length).toBeGreaterThanOrEqual(1);
    expect(scopedTrace.getAllByText("branch_resolved").length).toBeGreaterThanOrEqual(1);
    expect(scopedTrace.getByText("scene.001.line.001")).toBeInTheDocument();

    // The text preview paints for the first event; the redacted-sentinel
    // marker paints when the server sent null (the unprivileged runtime
    // status redacts text previews, per assertRedactedRuntimeDashboardStatus).
    expect(scopedTrace.getByText("Hello, {player}.")).toBeInTheDocument();
    expect(scopedTrace.getByText("[redacted]")).toBeInTheDocument();
    // Sanity check: scoped to the whole panel, the trace events still appear
    // and the section heading is present.
    expect(scoped.getByRole("heading", { name: "Trace" })).toBeInTheDocument();
  });

  it("renders the findings table verbatim from the read-model", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    const findingsSection = (panel.closest(".itotori-panel") as HTMLElement).querySelector(
      '[data-runtime-evidence-section="findings"]',
    ) as HTMLElement;
    const scopedFindings = within(findingsSection);

    // Both findings render with kind + source-unit key.
    expect(scopedFindings.getAllByText("text_mismatch").length).toBeGreaterThanOrEqual(1);
    expect(scopedFindings.getAllByText("layout").length).toBeGreaterThanOrEqual(1);
    expect(scopedFindings.getByText("scene.001.line.002")).toBeInTheDocument();
    // The message field renders verbatim from the read-model — the unprivileged
    // runtime status would redact to "[redacted]"; the panel is a faithful
    // consumer of whatever the read-model returns.
    expect(
      scopedFindings.getByText("Observed runtime text did not match the draft text."),
    ).toBeInTheDocument();
  });

  it("wraps sensitive artifacts (screenshot + recording) in the governed RedactedFrame, blurred by default", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    const panelEl = panel.closest(".itotori-panel") as HTMLElement;
    const sensitiveSection = panelEl.querySelector(
      '[data-runtime-evidence-section="artifacts-sensitive"]',
    ) as HTMLElement;
    expect(sensitiveSection).not.toBeNull();

    // The sensitive subsection heading paints, scoped to its own section.
    const scopedSensitive = within(sensitiveSection);
    expect(scopedSensitive.getByRole("heading", { name: /Sensitive/i })).toBeInTheDocument();
    expect(scopedSensitive.getByText("redacted by default")).toBeInTheDocument();

    // Every sensitive artifact (screenshot + recording) is wrapped in a
    // governed RedactedFrame that renders the redacted scrim when canReveal=false.
    // The sensitive artifact cards stamp data-redacted="true" on their
    // RedactedFrame because the private reveal toggle defaults off.
    const redactedFramesByAttr = panelEl.querySelectorAll(
      '.itotori-redaction-frame[data-redacted="true"]',
    );
    expect(redactedFramesByAttr.length).toBeGreaterThanOrEqual(3); // 2 screenshots + 1 recording

    // The per-artifact data-runtime-evidence-redacted meta cell stamps "yes"
    // for every sensitive artifact under the default-on toggle.
    const redactedMetaCells = panelEl.querySelectorAll('[data-runtime-evidence-redacted="true"]');
    expect(redactedMetaCells.length).toBe(3);
  });

  it("renders non-sensitive artifacts (trace_log, frame_capture, reference_comparison) as plain metadata — no redaction", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    const panelEl = panel.closest(".itotori-panel") as HTMLElement;
    const nonSensitiveSection = panelEl.querySelector(
      '[data-runtime-evidence-section="artifacts-non-sensitive"]',
    ) as HTMLElement;
    expect(nonSensitiveSection).not.toBeNull();
    const scopedNonSensitive = within(nonSensitiveSection);

    // The non-sensitive subsection heading paints.
    expect(scopedNonSensitive.getByRole("heading", { name: /Non-sensitive/i })).toBeInTheDocument();

    // Every non-sensitive artifact kind renders as a plain table row.
    expect(scopedNonSensitive.getByText("trace_log")).toBeInTheDocument();
    expect(scopedNonSensitive.getByText("frame_capture")).toBeInTheDocument();
    expect(scopedNonSensitive.getByText("reference_comparison")).toBeInTheDocument();
    // Sensitive artifact kinds do NOT appear in the non-sensitive table.
    expect(scopedNonSensitive.queryByText("screenshot")).not.toBeInTheDocument();
    expect(scopedNonSensitive.queryByText("recording")).not.toBeInTheDocument();
  });

  it("reveals sensitive artifacts only when the cap-gated governor toggle is on", async () => {
    handleStatus();
    renderRuntimeEvidencePanel({ revealSensitive: true });
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    fireEvent.click(screen.getByRole("checkbox", { name: /reveal sensitive/i }));
    const panelEl = panel.closest(".itotori-panel") as HTMLElement;

    // Every sensitive frame's RedactedFrame flips to data-redacted="false"
    // because the viewer has the cap-gated authority and opted into private reveal.
    const unredactedFrames = panelEl.querySelectorAll(
      '.itotori-redaction-frame[data-redacted="false"]',
    );
    expect(unredactedFrames.length).toBeGreaterThanOrEqual(3);

    // The per-artifact redacted meta cell flips to "no".
    const unredactedMetaCells = panelEl.querySelectorAll(
      '[data-runtime-evidence-redacted="false"]',
    );
    expect(unredactedMetaCells.length).toBe(3);
  });

  it("keeps runtime evidence redacted in shared mode even with revealSensitive", async () => {
    handleStatus();
    renderRuntimeEvidencePanel({ revealSensitive: true, defaultShareRedaction: true });
    const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
    const panelEl = panel.closest(".itotori-panel") as HTMLElement;

    expect(screen.getByRole("checkbox", { name: /reveal sensitive/i })).toBeDisabled();
    expect(
      panelEl.querySelectorAll(
        '.itotori-redaction-frame[data-redacted="true"][data-share-redaction="true"]',
      ).length,
    ).toBeGreaterThanOrEqual(3);
    expect(panelEl.querySelectorAll('[data-runtime-evidence-redacted="true"]')).toHaveLength(3);
  });

  it("splits the runtime-status artifacts by sensitivity purely from the artifactKind", () => {
    // Behavior-first: the split is a pure function of the artifact rows —
    // screenshot + recording are sensitive; trace_log, frame_capture,
    // reference_comparison are not.
    expect(isSensitiveRuntimeEvidenceArtifact({ artifactKind: "screenshot" } as never)).toBe(true);
    expect(isSensitiveRuntimeEvidenceArtifact({ artifactKind: "recording" } as never)).toBe(true);
    expect(isSensitiveRuntimeEvidenceArtifact({ artifactKind: "trace_log" } as never)).toBe(false);
    expect(isSensitiveRuntimeEvidenceArtifact({ artifactKind: "frame_capture" } as never)).toBe(
      false,
    );
    expect(
      isSensitiveRuntimeEvidenceArtifact({ artifactKind: "reference_comparison" } as never),
    ).toBe(false);

    const { sensitive, nonSensitive } = splitRuntimeEvidenceArtifacts(statusFixture().artifacts);
    expect(sensitive.map((a) => a.artifactKind)).toEqual(["screenshot", "screenshot", "recording"]);
    expect(nonSensitive.map((a) => a.artifactKind)).toEqual([
      "trace_log",
      "frame_capture",
      "reference_comparison",
    ]);
  });

  it("surfaces the loading surface before the read-model settles", () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    // The typed resource starts in `loading`; the panel paints the loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading runtime evidence…")).toBeInTheDocument();
  });

  it("stamps the root <Panel> with data-pane-id / data-pane-state / data-review-item-id", async () => {
    handleStatus();
    renderRuntimeEvidencePanel();
    await screen.findByRole("heading", { name: "Runtime evidence" });
    const panel = document.querySelector('[data-pane-id="runtime-evidence"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-pane-state", "ready");
    expect(panel).toHaveAttribute("data-review-item-id", REVIEW_ITEM_ID);
  });

  it("renders per-section empty fallbacks when the ready read-model carries no trace, findings, or artifacts", async () => {
    // The `runtime.status` route has no `collectionKey` so the typed
    // client never resolves it to `empty` (always `ready` once fetched);
    // the panel still paints the per-section "no rows" copy for each
    // empty list so a successful-but-empty read is honest.
    server.use(
      http.get(STATUS_PATH, () =>
        apiJson(
          "runtime.status",
          statusFixture({
            traceEvents: [],
            findings: [],
            artifacts: [],
            textEventCount: 0,
            frameCaptureCount: 0,
            screenshotArtifactCount: 0,
            recordingArtifactCount: 0,
            validationFindingCount: 0,
          }),
        ),
      ),
    );
    renderRuntimeEvidencePanel();
    expect(await screen.findByText("No trace events recorded.")).toBeInTheDocument();
    expect(screen.getByText("No findings recorded.")).toBeInTheDocument();
    expect(screen.getByText("No artifacts recorded.")).toBeInTheDocument();
  });

  it("renders the empty state when the typed resource settles to empty (no msw round-trip)", () => {
    // The body is exported separately so a test can mount it over an
    // explicit empty state, without standing up the full msw fetch.
    const emptyStatus: ApiCallState<RuntimeDashboardStatus> = { state: "empty" };
    renderWithRedactionGovernor(
      <RuntimeEvidencePanelBody status={emptyStatus} reviewItemId={REVIEW_ITEM_ID} />,
    );
    expect(
      screen.getByText(/The runtime dashboard returned no trace, findings, or artifacts/i),
    ).toBeInTheDocument();
  });

  it("renders an error state (not a blank panel) when the runtime status fetch 404s", async () => {
    server.use(http.get(STATUS_PATH, () => new HttpResponse(null, { status: 404 })));
    renderRuntimeEvidencePanel();
    expect(await screen.findByText(/This view could not load/i)).toBeInTheDocument();
  });

  it("renders an error state when the runtime status responds 503 with a typed error body", async () => {
    server.use(
      http.get(STATUS_PATH, () =>
        HttpResponse.json(
          { code: "internal_error", error: "runtime dashboard unavailable" },
          { status: 503 },
        ),
      ),
    );
    renderRuntimeEvidencePanel();
    expect(await screen.findByText("runtime dashboard unavailable")).toBeInTheDocument();
  });

  it("renders the ready body over an injected ready state (no msw round-trip)", () => {
    // The body is exported separately so a test can mount it over a
    // pre-resolved ready state, without standing up the full msw fetch.
    const readyStatus: ApiCallState<RuntimeDashboardStatus> = {
      state: "ready",
      data: statusFixture(),
    };
    renderWithRedactionGovernor(
      <RuntimeEvidencePanelBody status={readyStatus} reviewItemId={REVIEW_ITEM_ID} />,
    );
    expect(screen.getByRole("heading", { name: "Runtime evidence" })).toBeInTheDocument();
    expect(screen.getAllByText("layout_probe").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("E2").length).toBeGreaterThanOrEqual(1);
  });

  // xs-deep-jumps — the runtime RUN + every finding / trace / artifact source
  // unit is addressable: the panel renders cross-surface jump links (frame ->
  // run, finding -> /findings/:id, finding/trace/artifact -> player LINE) via
  // the EXISTING routing scheme so a reviewer can follow the chain off this
  // surface. The links carry the bridgeUnitId / findingId / runtimeRunId
  // verbatim from the read-model — no invented destinations.
  describe("cross-surface addressable jumps (xs-deep-jumps)", () => {
    it("renders the runtime RUN as a deep-link to /runs/:runtimeRunId (frame -> run)", async () => {
      handleStatus();
      renderRuntimeEvidencePanel();
      await screen.findByRole("heading", { name: "Runtime evidence" });
      const runJump = document.querySelector(".itotori-runtime-evidence__run-jump");
      expect(runJump).not.toBeNull();
      expect(runJump).toHaveAttribute("href", "/runs/runtime-1");
      expect(runJump).toHaveAttribute("data-jump-kind", "run");
      expect(runJump).toHaveAttribute("data-jump-id", "runtime-1");
    });

    it("renders each finding as a deep-link to /findings/:findingId + its source unit as the player LINE", async () => {
      handleStatus();
      renderRuntimeEvidencePanel();
      const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
      const findingsSection = (panel.closest(".itotori-panel") as HTMLElement).querySelector(
        '[data-runtime-evidence-section="findings"]',
      ) as HTMLElement;

      // finding -> /findings/:findingId (both findings carry bridgeUnitId).
      const findingJumps = findingsSection.querySelectorAll(
        ".itotori-runtime-evidence__finding-jump",
      );
      expect(findingJumps).toHaveLength(2);
      expect(findingJumps[0]).toHaveAttribute("href", "/findings/runtime-1%3Afinding-1");
      expect(findingJumps[0]).toHaveAttribute("data-jump-kind", "finding");
      expect(findingJumps[1]).toHaveAttribute("href", "/findings/runtime-1%3Afinding-2");

      // finding -> player LINE (bridgeUnitId is the addressable unit id).
      const lineJumps = findingsSection.querySelectorAll(".itotori-runtime-evidence__line-jump");
      expect(lineJumps).toHaveLength(2);
      expect(lineJumps[0]).toHaveAttribute("href", "/play/units/bridge-unit-1");
      expect(lineJumps[0]).toHaveAttribute("data-jump-kind", "unit");
      // The source-unit key remains the visible label.
      expect(lineJumps[0]).toHaveTextContent("scene.001.line.001");
    });

    it("renders each trace event + non-sensitive artifact source unit as the player LINE", async () => {
      handleStatus();
      renderRuntimeEvidencePanel();
      const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
      const panelEl = panel.closest(".itotori-panel") as HTMLElement;

      // The first trace event (bridge-unit-1) jumps to the player line; the
      // second event has a null bridge/source so it degrades to plain text.
      const traceSection = panelEl.querySelector(
        '[data-runtime-evidence-section="trace"]',
      ) as HTMLElement;
      const traceLineJumps = traceSection.querySelectorAll(".itotori-runtime-evidence__line-jump");
      expect(traceLineJumps).toHaveLength(1);
      expect(traceLineJumps[0]).toHaveAttribute("href", "/play/units/bridge-unit-1");

      // Non-sensitive artifacts (trace_log + frame_capture + reference_comparison)
      // each jump to their bridge unit when present.
      const nonSensitiveSection = panelEl.querySelector(
        '[data-runtime-evidence-section="artifacts-non-sensitive"]',
      ) as HTMLElement;
      const artifactLineJumps = nonSensitiveSection.querySelectorAll(
        ".itotori-runtime-evidence__line-jump",
      );
      expect(artifactLineJumps.length).toBeGreaterThanOrEqual(1);
      expect(artifactLineJumps[0]).toHaveAttribute("data-jump-kind", "unit");
    });

    it("degrades a null bridge/source unit to plain text (no invented jump)", async () => {
      server.use(
        http.get(STATUS_PATH, () =>
          apiJson(
            "runtime.status",
            statusFixture({
              traceEvents: [
                {
                  runtimeEventId: "runtime-1:trace-null",
                  eventKind: "branch_resolved",
                  bridgeUnitId: null,
                  sourceUnitKey: null,
                  draftId: null,
                  runtimeTargetId: null,
                  evidenceTier: "E1",
                  frame: 24,
                  textPreview: null,
                  artifactIds: [],
                },
              ],
              findings: [],
              artifacts: [],
            }),
          ),
        ),
      );
      renderRuntimeEvidencePanel();
      await screen.findByRole("heading", { name: "Runtime evidence" });
      // No jump links render when no row carries a bridge/source unit.
      expect(document.querySelectorAll(".itotori-runtime-evidence__line-jump")).toHaveLength(0);
      expect(document.querySelectorAll(".itotori-runtime-evidence__finding-jump")).toHaveLength(0);
    });

    it("renders sourceUnitKey-only runtime rows as plain text instead of unit jumps", async () => {
      server.use(
        http.get(STATUS_PATH, () =>
          apiJson(
            "runtime.status",
            statusFixture({
              traceEvents: [
                {
                  runtimeEventId: "runtime-1:trace-display-only",
                  eventKind: "text_seen",
                  bridgeUnitId: null,
                  sourceUnitKey: "display.only.source.key",
                  draftId: null,
                  runtimeTargetId: "display.only.source.key",
                  evidenceTier: "E1",
                  frame: 24,
                  textPreview: null,
                  artifactIds: [],
                },
              ],
              findings: [
                {
                  findingId: "runtime-1:finding-display-only",
                  findingKind: "text_mismatch",
                  severity: "error",
                  message: "The source label is display-only.",
                  evidenceTier: "E1",
                  bridgeUnitId: null,
                  sourceUnitKey: "display.only.source.key",
                  artifactId: null,
                },
              ],
              artifacts: [
                {
                  artifactId: "runtime-1:trace-display-only-artifact",
                  artifactKind: "trace_log",
                  uri: "artifacts/utsushi/runtime/runtime-1/traces/display-only.json",
                  hash: "sha256:display-only",
                  mediaType: "application/json",
                  byteSize: 64,
                  bridgeUnitId: null,
                  sourceUnitKey: "display.only.source.key",
                  diagnostic: null,
                },
              ],
            }),
          ),
        ),
      );
      renderRuntimeEvidencePanel();
      const panel = await screen.findByRole("heading", { name: "Runtime evidence" });
      const panelEl = panel.closest(".itotori-panel") as HTMLElement;

      expect(within(panelEl).getAllByText("display.only.source.key")).toHaveLength(3);
      expect(panelEl.querySelectorAll(".itotori-runtime-evidence__line-jump")).toHaveLength(0);
      expect(panelEl.querySelectorAll('[href="/play/units/display.only.source.key"]')).toHaveLength(
        0,
      );
      expect(panelEl.querySelectorAll('[data-jump-resolved="false"]')).toHaveLength(3);
    });
  });
});
