// ITOTORI-040 — pure workspace renderer tests.

import { describe, expect, it } from "vitest";
import {
  renderWorkspaceAssetBrowseView,
  renderWorkspaceComparisonView,
  renderWorkspaceProjectBrowseView,
  renderWorkspaceSceneBrowseView,
  renderWorkspaceSearchView,
  workspaceAssetBrowseFixture,
  workspaceComparisonFixture,
  workspaceDeniedComparisonFixture,
  workspaceProjectBrowseFixture,
  workspaceSceneBrowseFixture,
  workspaceSearchFixture,
} from "../src/workspace/index.js";

describe("renderWorkspaceProjectBrowseView", () => {
  it("renders branch names + scene/asset browse links keyed by locale branch id", () => {
    const html = renderWorkspaceProjectBrowseView(workspaceProjectBrowseFixture());
    expect(html).toContain('data-view="project-browse"');
    expect(html).toContain("English (informal)");
    expect(html).toContain('data-locale-branch-id="locale-branch-itotori-040"');
    expect(html).toContain("/api/workspace/scenes?projectId=");
    expect(html).toContain("/api/workspace/assets?projectId=");
  });
});

describe("renderWorkspaceSceneBrowseView", () => {
  it("leads with the translated summary so a non-source-language reviewer can navigate", () => {
    const html = renderWorkspaceSceneBrowseView(workspaceSceneBrowseFixture());
    expect(html).toContain('class="scene-summary" lang="en-US"');
    expect(html).toContain("the heroine greets the protagonist");
    expect(html).toContain('data-bridge-unit-id="bridge-unit-itotori-040-1"');
  });

  it("marks a stale scene and shows the diagnostic banner", () => {
    const fixture = workspaceSceneBrowseFixture();
    const staleScene = { ...fixture.scenes[0]!, stale: true, status: "Stale" };
    const html = renderWorkspaceSceneBrowseView({
      ...fixture,
      scenes: [staleScene],
      diagnostics: [
        { code: "workspace_stale_scene_summary", message: "Scene scene.001 summary is Stale" },
      ],
    });
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('data-diagnostic-code="workspace_stale_scene_summary"');
  });
});

describe("renderWorkspaceAssetBrowseView", () => {
  it("renders the asset inventory with decision state", () => {
    const html = renderWorkspaceAssetBrowseView(workspaceAssetBrowseFixture());
    expect(html).toContain('data-view="asset-browse"');
    expect(html).toContain("cg/title.png");
    expect(html).toContain("localize");
  });
});

describe("renderWorkspaceComparisonView", () => {
  it("renders source / draft / final cells and runtime-evidence links", () => {
    const html = renderWorkspaceComparisonView(workspaceComparisonFixture());
    expect(html).toContain('data-side="source"');
    expect(html).toContain('data-side="draft"');
    expect(html).toContain('data-side="final"');
    expect(html).toContain('data-has-final="true"');
    expect(html).toContain("provider:openrouter:run-text-trace-1");
    expect(html).toContain('data-runtime-target-id="utsushi-runtime-target-fixture"');
  });

  it("renders the denial shell without any cells when permission is missing", () => {
    const html = renderWorkspaceComparisonView(
      workspaceDeniedComparisonFixture("reviewer-queue-itotori-040"),
    );
    expect(html).toContain('data-state="denied"');
    expect(html).not.toContain('data-side="source"');
  });
});

describe("renderWorkspaceSearchView", () => {
  it("renders each hit with its source artifact, locale branch, and bridge unit citations", () => {
    const html = renderWorkspaceSearchView(workspaceSearchFixture());
    expect(html).toContain('data-source-artifact-id="bridge-unit-itotori-040-1"');
    expect(html).toContain('data-bridge-unit-ref="bridge-unit-itotori-040-1"');
    expect(html).toContain("artifact:bridge-unit-itotori-040-1");
    expect(html).toContain("branch:locale-branch-itotori-040");
    expect(html).toContain("unit:bridge-unit-itotori-040-1");
  });
});
