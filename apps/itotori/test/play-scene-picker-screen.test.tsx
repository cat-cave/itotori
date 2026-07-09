// @vitest-environment jsdom
// play-scene-picker-bitext (HI-FI STUDIO EPIC · Play) — behavior-first test
// for the Play scene picker screen.
//
// Mounts the REAL `App` shell at `/play` over msw-intercepted
// `/api/workspace/scenes` + `/api/workspace/comparison` (+ the shell-frame
// status reads) and asserts the OBSERVABLE behavior the viewer sees, per the
// acceptance:
//
//   1. the scene picker lists scenes by their TRANSLATED SUMMARY (a NavPills
//      pill per scene, labeled by `summaryText`);
//   2. selecting a scene reveals its cited units;
//   3. the BiText renders source ↔ draft from the mocked
//      `workspace.comparison` cells (source locale + draft locale identity
//      tokens included), consumed THROUGH the typed client (no ad-hoc fetch);
//   4. loading / empty / error are handled (never a blank panel).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered scene summaries + source ↔ draft BiText + states are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { RuntimeDashboardStatus } from "@itotori/db";
import type {
  WorkspaceComparisonReadModel,
  WorkspaceSceneBrowseReadModel,
} from "../src/workspace/index.js";
import { workspaceComparisonFixture, workspaceSceneBrowseFixture } from "../src/workspace/index.js";
import { App } from "../src/ui/App.js";
import {
  artifactStoreUrl,
  filmstripFramesForUnit,
  localizedTextboxText,
} from "../src/ui/screens/PlayScenePickerScreen.js";
import { apiJson, authCapabilitiesMswHandler } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const PROJECT_ID = "project-play";
const LOCALE_BRANCH_ID = "locale-branch-play";
const PLAY_ROUTE = {
  pathname: "/play",
  search: `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}`,
};
const PLAY_SCENE_PICKER_CSS = join(process.cwd(), "src/ui/screens/PlayScenePickerScreen.css");

// Two scenes with distinct translated summaries so the NavPills rendering +
// the scene-switch behavior are observable. Each scene cites one unit; the
// unit's `bridgeUnitId` is the key the screen passes to `workspace.comparison`.
function sceneBrowseFixture(): WorkspaceSceneBrowseReadModel {
  const base = workspaceSceneBrowseFixture({
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
  });
  const seedScene = base.scenes[0];
  if (seedScene === undefined) {
    throw new Error("scene fixture must seed at least one scene");
  }
  const sceneOne = {
    ...seedScene,
    sceneId: "scene.play.one",
    summaryText: "The heroine greets the protagonist at the school gate.",
    units: [
      {
        ...seedScene.units[0]!,
        bridgeUnitId: "bridge-unit-play-one",
        sourceUnitKey: "scene.play.one.line.001",
        speaker: "Heroine",
        sourceText: "おはよう。",
        cited: true,
      },
    ],
    citedUnitCount: 1,
  };
  const sceneTwo = {
    ...seedScene,
    sceneId: "scene.play.two",
    sceneSummaryId: "scene-summary-play-two",
    summaryText: "A confrontation unfolds on the rooftop at dusk.",
    units: [
      {
        ...seedScene.units[0]!,
        bridgeUnitId: "bridge-unit-play-two",
        sourceUnitKey: "scene.play.two.line.001",
        speaker: "Rival",
        sourceText: "ここで会うとはね。",
        cited: true,
      },
    ],
    citedUnitCount: 1,
  };
  return { ...base, scenes: [sceneOne, sceneTwo] };
}

// A comparison fixture carrying a SOURCE / DRAFT pair (the BiText pair) for
// whatever unit the screen queries.
function comparisonFixture(
  overrides: Partial<WorkspaceComparisonReadModel> = {},
): WorkspaceComparisonReadModel {
  return workspaceComparisonFixture({
    localeBranchId: LOCALE_BRANCH_ID,
    bridgeUnitId: "bridge-unit-play-one",
    sourceUnitKey: "scene.play.one.line.001",
    contextNote: "Greeting in the opening scene.",
    cells: [
      {
        side: "source",
        locale: "ja-JP",
        text: "おはよう。",
        label: "Source (ja-JP)",
      },
      {
        side: "draft",
        locale: "en-US",
        text: "Good morning.",
        label: "Draft (en-US)",
      },
    ],
    hasFinal: false,
    ...overrides,
  });
}

function runtimeStatusFixture(
  overrides: Partial<RuntimeDashboardStatus> = {},
): RuntimeDashboardStatus {
  return {
    finalStatus: "runtime_passed",
    runtimeRunId: "runtime-play-1",
    runtimeReportId: "runtime-play-1",
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
        runtimeEventId: "runtime-play-1:trace-1",
        eventKind: "text_seen",
        bridgeUnitId: "bridge-unit-play-one",
        sourceUnitKey: "scene.play.one.line.001",
        draftId: "locale-branch-play:bridge-unit-play-one",
        runtimeTargetId: "scene.play.one.line.001",
        evidenceTier: "E2",
        frame: 8,
        textPreview: "Good morning.",
        artifactIds: ["runtime-play-1:screenshot-1"],
      },
    ],
    findings: [],
    artifacts: [
      {
        artifactId: "runtime-play-1:screenshot-1",
        artifactKind: "screenshot",
        uri: "artifacts/utsushi/runtime/runtime-play-1/screenshots/screenshot-1.png",
        hash: "sha256:play-screenshot",
        mediaType: "image/png",
        byteSize: 2048,
        bridgeUnitId: "bridge-unit-play-one",
        sourceUnitKey: "scene.play.one.line.001",
        diagnostic: null,
      },
      {
        artifactId: "runtime-play-1:frame-capture-1",
        artifactKind: "frame_capture",
        uri: "artifacts/utsushi/runtime/runtime-play-1/frames/frame-1.png",
        hash: "sha256:play-frame",
        mediaType: "image/png",
        byteSize: 1024,
        bridgeUnitId: "bridge-unit-play-two",
        sourceUnitKey: "scene.play.two.line.001",
        diagnostic: null,
      },
      {
        artifactId: "runtime-play-1:trace-log-1",
        artifactKind: "trace_log",
        uri: "artifacts/utsushi/runtime/runtime-play-1/traces/trace-1.json",
        hash: "sha256:play-trace",
        mediaType: "application/json",
        byteSize: 512,
        bridgeUnitId: "bridge-unit-play-one",
        sourceUnitKey: "scene.play.one.line.001",
        diagnostic: null,
      },
    ],
    approximations: [],
    unsupportedCapabilities: [],
    limitations: [],
    ...overrides,
  };
}

const server = setupServer(
  authCapabilitiesMswHandler,
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/workspace/scenes", () => apiJson("workspace.scenes", sceneBrowseFixture())),
  http.get("*/api/workspace/comparison", () =>
    apiJson("workspace.comparison", comparisonFixture()),
  ),
  http.get("*/api/runtime/v0.2/status", () => apiJson("runtime.status", runtimeStatusFixture())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("SPA shell — Play scene picker", () => {
  it("lists scenes by their translated summary", async () => {
    render(<App location={PLAY_ROUTE} />);

    expect(await screen.findByRole("heading", { name: "Scene picker" })).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "play-scene-picker");
    expect(main).toHaveAttribute("data-state", "ready");
    expect(main).toHaveAttribute("data-locale-branch-id", LOCALE_BRANCH_ID);

    // SCENES: a NavPills pill per scene, labeled by the translated summary.
    const nav = screen.getByRole("navigation", { name: "Scenes by translated summary" });
    expect(within(nav).getByRole("tab", { name: /greets the protagonist/i })).toBeInTheDocument();
    expect(within(nav).getByRole("tab", { name: /confrontation unfolds/i })).toBeInTheDocument();
  });

  it("renders the source ↔ draft BiText from the mocked workspace.comparison", async () => {
    render(<App location={PLAY_ROUTE} />);

    // The first scene's first cited unit is auto-selected, so the comparison
    // fires + the BiText paints source ↔ draft from the mocked cells. The
    // pair container is stamped with the unit's bridge id.
    await screen.findByText("Good morning.");

    // The BiText renders the SOURCE cell text verbatim.
    expect(screen.getByText("おはよう。")).toBeInTheDocument();
    // The BiText renders the DRAFT cell text verbatim.
    expect(screen.getAllByText("Good morning.").length).toBeGreaterThanOrEqual(1);

    // Locale-branch identity tokens render as MONO CODE (sourceLocale +
    // targetLocale), so the branching is owned by an identity.
    const bitext = screen.getByText("おはよう。").closest(".itotori-bitext");
    expect(bitext).not.toBeNull();
    const tokens = bitext?.querySelectorAll(".itotori-bitext__locale") ?? [];
    const tokenText = Array.from(tokens).map((node) => node.textContent ?? "");
    expect(tokenText).toContain("ja-JP");
    expect(tokenText).toContain("en-US");

    // The comparison pane settles to ready + is scoped to the auto-selected unit.
    const pane = screen.getByRole("heading", { name: "Source ↔ draft" }).closest("section");
    expect(pane).toHaveAttribute("data-pane-state", "ready");
    const pair = document.querySelector('[data-comparison-for="bridge-unit-play-one"]');
    expect(pair).not.toBeNull();
  });

  it("renders the alpha captured-frame filmstrip with a localized textbox overlay", async () => {
    render(<App location={PLAY_ROUTE} />);

    expect(
      await screen.findByRole("heading", { name: "Captured-frame filmstrip" }),
    ).toBeInTheDocument();
    const filmstrip = document.querySelector('[data-pane-id="play-filmstrip-alpha"]');
    expect(filmstrip).not.toBeNull();
    expect(filmstrip).toHaveAttribute("data-pane-state", "ready");
    expect(filmstrip).toHaveAttribute("data-filmstrip-unit-id", "bridge-unit-play-one");

    const frame = filmstrip?.querySelector(
      '[data-filmstrip-artifact-id="runtime-play-1:screenshot-1"]',
    );
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute("data-filmstrip-artifact-kind", "screenshot");
    expect(frame).toHaveAttribute(
      "data-filmstrip-artifact-uri",
      "artifacts/utsushi/runtime/runtime-play-1/screenshots/screenshot-1.png",
    );

    const image = frame?.querySelector("img");
    expect(image).toHaveAttribute(
      "src",
      "/artifact-store/artifacts%2Futsushi%2Fruntime%2Fruntime-play-1%2Fscreenshots%2Fscreenshot-1.png",
    );
    expect(within(filmstrip as HTMLElement).getByText("Heroine")).toBeInTheDocument();
    expect(within(filmstrip as HTMLElement).getByText("Good morning.")).toBeInTheDocument();

    // The frame is governed by the shell redaction context. The test actor
    // holds canReveal, but the private reveal toggle defaults off.
    expect(
      filmstrip?.querySelector('.itotori-redaction-frame[data-redacted="true"]'),
    ).not.toBeNull();
  });

  it("ships CSS for horizontal filmstrip frames with textbox composited over the frame", () => {
    const css = readFileSync(PLAY_SCENE_PICKER_CSS, "utf8");

    expect(css).toMatch(/\.play-filmstrip__frames\s*\{[\s\S]*display:\s*flex/u);
    expect(css).toMatch(/\.play-filmstrip__frames\s*\{[\s\S]*overflow-x:\s*auto/u);
    expect(css).toMatch(/\.play-filmstrip__frame\s*\{[\s\S]*position:\s*relative/u);
    expect(css).toMatch(/\.play-filmstrip__textbox\s*\{[\s\S]*position:\s*absolute/u);
    expect(css).toMatch(/\.play-filmstrip__textbox\s*\{[\s\S]*bottom:/u);
  });

  it("keeps the filmstrip redacted when runtime artifact URIs are redacted by the API", async () => {
    server.use(
      http.get("*/api/runtime/v0.2/status", () =>
        apiJson(
          "runtime.status",
          runtimeStatusFixture({
            artifacts: runtimeStatusFixture().artifacts.map((artifact) => ({
              ...artifact,
              uri: null,
              hash: null,
            })),
          }),
        ),
      ),
    );
    render(<App location={PLAY_ROUTE} />);

    const filmstripHeading = await screen.findByRole("heading", {
      name: "Captured-frame filmstrip",
    });
    const filmstrip = filmstripHeading.closest(".itotori-panel") as HTMLElement;
    const frame = filmstrip.querySelector(
      '[data-filmstrip-artifact-id="runtime-play-1:screenshot-1"]',
    );
    expect(frame).not.toBeNull();
    expect(frame).not.toHaveAttribute("data-filmstrip-artifact-uri");
    expect(frame?.querySelector("img")).toBeNull();
    expect(within(filmstrip).getByText("screenshot")).toBeInTheDocument();
    expect(
      filmstrip.querySelector('.itotori-redaction-frame[data-redacted="true"]'),
    ).not.toBeNull();
  });

  it("derives filmstrip frames and artifact-store URLs from the runtime read-model", () => {
    const scenes = sceneBrowseFixture();
    const unit = scenes.scenes[0]!.units[0]!;
    const status = runtimeStatusFixture();

    expect(localizedTextboxText(comparisonFixture())).toBe("Good morning.");
    expect(artifactStoreUrl("artifacts/utsushi/runtime/run/screenshots/frame.png")).toBe(
      "/artifact-store/artifacts%2Futsushi%2Fruntime%2Frun%2Fscreenshots%2Fframe.png",
    );
    expect(filmstripFramesForUnit(status, unit).map((frame) => frame.artifact.artifactId)).toEqual([
      "runtime-play-1:screenshot-1",
    ]);
  });

  it("switches the BiText when a different scene is selected", async () => {
    render(<App location={PLAY_ROUTE} />);

    // Default scene is scene one; switch to scene two via its summary pill.
    fireEvent.click(await screen.findByRole("tab", { name: /confrontation unfolds/i }));

    // Scene two's unit list renders its cited unit key.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("scene.play.two.line.001")).toBeInTheDocument();
    // Scene one's unit key is no longer shown.
    expect(within(table).queryByText("scene.play.one.line.001")).not.toBeInTheDocument();

    // The BiText pane re-queries for scene two's unit (the auto-selected
    // first cited unit of the newly selected scene). The pair container is
    // re-stamped with scene two's bridge id once the comparison settles.
    expect((await screen.findAllByText("Good morning.")).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-comparison-for="bridge-unit-play-two"]')).not.toBeNull();
    expect(document.querySelector('[data-comparison-for="bridge-unit-play-one"]')).toBeNull();
  });

  it("shows loading placeholders while the reads are in flight", () => {
    server.use(http.get("*/api/workspace/scenes", () => new Promise(() => {})));
    render(<App location={PLAY_ROUTE} />);
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "loading");
    expect(screen.getByText("Loading scenes…")).toBeInTheDocument();
  });

  it("surfaces the empty state when no scenes are returned", async () => {
    server.use(
      http.get("*/api/workspace/scenes", () =>
        apiJson(
          "workspace.scenes",
          workspaceSceneBrowseFixture({
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            scenes: [],
          }),
        ),
      ),
    );
    render(<App location={PLAY_ROUTE} />);
    expect(
      await screen.findByText("No scenes were returned for this locale branch."),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "empty");
  });

  it("surfaces a typed error state instead of a blank panel", async () => {
    server.use(
      http.get("*/api/workspace/scenes", () =>
        HttpResponse.json(
          { code: "forbidden", error: "not permitted to read scenes" },
          { status: 403 },
        ),
      ),
    );
    render(<App location={PLAY_ROUTE} />);
    expect(await screen.findByText("not permitted to read scenes")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "error");
  });

  it("degrades the BiText pane to an error without blanking the scene list", async () => {
    render(<App location={PLAY_ROUTE} />);

    // The scene list + summaries still render from the successful scenes read.
    expect(await screen.findByRole("tab", { name: /greets the protagonist/i })).toBeInTheDocument();

    // Swap the comparison handler to a typed error AFTER the scene list mounts.
    server.use(
      http.get("*/api/workspace/comparison", () =>
        HttpResponse.json(
          { code: "internal_error", error: "comparison context unavailable" },
          { status: 503 },
        ),
      ),
    );
    // Re-trigger the comparison query by switching scenes (fresh depsKey →
    // fresh fetch → fresh error settlement).
    fireEvent.click(screen.getByRole("tab", { name: /confrontation unfolds/i }));

    expect(await screen.findByText("comparison context unavailable")).toBeInTheDocument();
    const pane = document.querySelector(".play-scene-picker__bitext");
    expect(pane).not.toBeNull();
    expect(pane).toHaveAttribute("data-pane-state", "error");
    // The scene picker itself is still ready (only the comparison pane degraded).
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "ready");
  });
});
