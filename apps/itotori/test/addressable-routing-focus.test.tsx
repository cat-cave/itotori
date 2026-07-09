// @vitest-environment jsdom
// fnd-addressable-routing — deep-link resolve + focus behavior.
//
// Mounts the real `App` shell against msw `/api/*` and asserts that a stable
// addressable URL RESOLVES to the right surface and FOCUSES the entity
// (`data-addressable-focus` / selected scene+unit). No game is named.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  WorkspaceComparisonReadModel,
  WorkspaceSceneBrowseReadModel,
} from "../src/workspace/index.js";
import { workspaceComparisonFixture, workspaceSceneBrowseFixture } from "../src/workspace/index.js";
import { App } from "../src/ui/App.js";
import { hrefForAddressable } from "../src/ui/addressable-routing.js";
import { apiJson } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const PROJECT_ID = "project-addr";
const LOCALE_BRANCH_ID = "locale-branch-addr";

function sceneBrowseFixture(): WorkspaceSceneBrowseReadModel {
  const base = workspaceSceneBrowseFixture({
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
  });
  const seed = base.scenes[0];
  if (seed === undefined) {
    throw new Error("scene fixture must seed at least one scene");
  }
  const sceneOne = {
    ...seed,
    sceneId: "scene.addr.one",
    summaryText: "Opening exchange at the gate.",
    units: [
      {
        ...seed.units[0]!,
        bridgeUnitId: "bridge-unit-addr-one",
        sourceUnitKey: "scene.addr.one.line.001",
        speaker: "A",
        sourceText: "こんにちは。",
        cited: true,
      },
    ],
    citedUnitCount: 1,
  };
  const sceneTwo = {
    ...seed,
    sceneId: "scene.addr.two",
    sceneSummaryId: "scene-summary-addr-two",
    summaryText: "Later rooftop confrontation.",
    units: [
      {
        ...seed.units[0]!,
        bridgeUnitId: "bridge-unit-addr-two",
        sourceUnitKey: "scene.addr.two.line.001",
        speaker: "B",
        sourceText: "待っていた。",
        cited: true,
      },
    ],
    citedUnitCount: 1,
  };
  return { ...base, scenes: [sceneOne, sceneTwo] };
}

function comparisonFixture(): WorkspaceComparisonReadModel {
  return workspaceComparisonFixture({
    localeBranchId: LOCALE_BRANCH_ID,
    bridgeUnitId: "bridge-unit-addr-two",
    sourceUnitKey: "scene.addr.two.line.001",
    cells: [
      { side: "source", locale: "ja-JP", text: "待っていた。", label: "Source" },
      { side: "draft", locale: "en-US", text: "I was waiting.", label: "Draft" },
    ],
    hasFinal: false,
  });
}

const server = setupServer(
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
  http.get("*/api/workspace/scenes", () => apiJson("workspace.scenes", sceneBrowseFixture())),
  http.get("*/api/workspace/comparison", () =>
    apiJson("workspace.comparison", comparisonFixture()),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function splitHref(href: string): { pathname: string; search: string } {
  const q = href.indexOf("?");
  if (q === -1) {
    return { pathname: href, search: "" };
  }
  return { pathname: href.slice(0, q), search: href.slice(q) };
}

describe("addressable deep-links resolve + focus", () => {
  it("focuses a unit deep-link on the Play scene picker", async () => {
    const href = hrefForAddressable({
      kind: "unit",
      id: "bridge-unit-addr-two",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const { pathname, search } = splitHref(href);
    render(<App location={{ pathname, search }} />);

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-screen", "play-scene-picker");
    expect(main).toHaveAttribute("data-addressable-focus", "unit:bridge-unit-addr-two");
    expect(main).toHaveAttribute("data-addressable-focused", "true");

    const body = await screen.findByLabelText("Play scene picker");
    expect(body).toHaveAttribute("data-selected-scene-id", "scene.addr.two");
    expect(body).toHaveAttribute("data-selected-unit-id", "bridge-unit-addr-two");
    expect(body).toHaveAttribute("data-addressable-focus", "unit:bridge-unit-addr-two");

    // BiText settles for the focused unit.
    expect(await screen.findByText("I was waiting.")).toBeInTheDocument();
  });

  it("focuses a scene deep-link on the Play scene picker", async () => {
    const href = hrefForAddressable({
      kind: "scene",
      id: "scene.addr.two",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const { pathname, search } = splitHref(href);
    render(<App location={{ pathname, search }} />);

    const body = await screen.findByLabelText("Play scene picker");
    expect(body).toHaveAttribute("data-selected-scene-id", "scene.addr.two");
    expect(body).toHaveAttribute("data-addressable-focus", "scene:scene.addr.two");

    const nav = screen.getByRole("navigation", { name: "Scenes by translated summary" });
    expect(within(nav).getByRole("tab", { name: /rooftop confrontation/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("resolves wiki character / term deep-links to a focused addressable shell", () => {
    for (const [kind, id, pathPrefix] of [
      ["character", "char.heroine", "/wiki/characters/"] as const,
      ["term", "term.san", "/wiki/terms/"] as const,
    ]) {
      const href = hrefForAddressable({ kind, id });
      expect(href.startsWith(pathPrefix)).toBe(true);
      const { pathname, search } = splitHref(href);
      const { unmount } = render(<App location={{ pathname, search }} />);
      const main = screen.getByRole("main");
      expect(main).toHaveAttribute("data-screen", "addressable-focus");
      expect(main).toHaveAttribute("data-addressable-kind", kind);
      expect(main).toHaveAttribute("data-addressable-id", id);
      expect(main).toHaveAttribute("data-addressable-focus", `${kind}:${id}`);
      expect(main).toHaveAttribute("data-addressable-focused", "true");
      expect(main).toHaveAttribute("data-addressable-surface", "wiki");
      const focusStatus = main.querySelector('[data-addressable-focus-status="focused"]');
      expect(focusStatus).not.toBeNull();
      expect(focusStatus).toHaveTextContent(new RegExp(`Focused ${kind}`, "i"));
      unmount();
    }
  });

  it("resolves run + finding deep-links to a focused runtime shell", () => {
    for (const [kind, id] of [
      ["run", "runtime-run-9"] as const,
      ["finding", "finding-layout-1"] as const,
    ]) {
      const href = hrefForAddressable({ kind, id });
      const { pathname, search } = splitHref(href);
      const { unmount } = render(<App location={{ pathname, search }} />);
      const main = screen.getByRole("main");
      expect(main).toHaveAttribute("data-screen", "addressable-focus");
      expect(main).toHaveAttribute("data-addressable-kind", kind);
      expect(main).toHaveAttribute("data-addressable-id", id);
      expect(main).toHaveAttribute("data-addressable-focus", `${kind}:${id}`);
      expect(main).toHaveAttribute("data-addressable-surface", "runtime");
      unmount();
    }
  });

  it("resolves a narrative route deep-link on Play with focus stamped", async () => {
    const href = hrefForAddressable({
      kind: "route",
      id: "route.true-end",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const { pathname, search } = splitHref(href);
    render(<App location={{ pathname, search }} />);

    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-screen", "play-scene-picker");
    expect(main).toHaveAttribute("data-addressable-focus", "route:route.true-end");
    expect(main).toHaveAttribute("data-focus-route-id", "route.true-end");
  });
});
