import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  WikiBibleDashboardScreen,
  parseWikiBibleRoute,
} from "../src/ui/screens/WikiBibleDashboardScreen.js";
import { AddressableFocusScreen } from "../src/ui/screens/AddressableFocusScreen.js";
import { parsePlayFlagComposerRoute } from "../src/ui/screens/PlayFlagComposerScreen.js";
import { grantedStudioCapabilityView } from "../src/ui/caps-context.js";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import { App } from "../src/ui/App.js";
import { parseAddressableLocation } from "../src/ui/addressable-routing.js";
import { parseReturnTo } from "../src/ui/screens/AddressableFocusScreen.js";
import type {
  WikiHistoryEntry,
  WikiRenderingView,
  WikiSourceObjectView,
} from "../src/wiki/dashboard/read-model.js";
import {
  authIdentityFixture,
  costReportFixture,
  dashboardStatusFixture,
  portfolioProjectsFixture,
} from "./api-fixtures.js";

import {
  PROJECT_ID,
  LOCALE_BRANCH_ID,
  SNAPSHOT_ID,
  HASH,
  CANONICAL_STATEMENT,
  AKARI_STATEMENT,
  YUKI_STATEMENT,
  badges,
  sceneObject,
  alternateSceneObject,
  renderingFixture,
  historyFixture,
  wikiListBody,
  wikiShowBody,
  wikiWriteBody,
  sourceObjectFor,
  flagReceipt,
  capturedWrite,
  server,
  renderScreen,
} from "./wiki-bible-dashboard-screen.support.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  capturedWrite = null;
});

afterAll(() => server.close());

describe("Wiki bible dashboard", () => {
  it("renders source claims, readiness, media, history, and limited-context/test badges from the WikiObject API", async () => {
    renderScreen();
    expect(await screen.findByText(CANONICAL_STATEMENT, { selector: "p" })).toBeInTheDocument();

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-screen", "wiki-bible");
    expect(main).toHaveAttribute("data-snapshot-id", SNAPSHOT_ID);

    // Coverage / readiness band.
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();

    // Media rendered (default-redacted).
    expect(await screen.findByText("media-shot-1")).toBeInTheDocument();

    // History from the object-detail read.
    await waitFor(() => expect(screen.getByText("Version history")).toBeInTheDocument());

    // Limited-context + test-mode badges from the object header.
    const objectRegion = screen.getByRole("region", { name: "Selected wiki object" });
    expect(within(objectRegion).getByText("limited context")).toBeInTheDocument();
    expect(within(objectRegion).getByText("pilot")).toBeInTheDocument();
  });

  it("switches to the localized bible and shows the localized rendering", async () => {
    renderScreen();
    expect(await screen.findByText(CANONICAL_STATEMENT, { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Localized bible/u }));
    expect(await screen.findByText("The temple bell rings at first light.")).toBeInTheDocument();
  });

  it("follows citation deep-links into focused, scrolled ScenePlayer units and scenes", async () => {
    const source = renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    const citations = [
      ["open unit unit-42 in play", "unit", "unit-42", "/play/units/unit-42"],
      ["open scene scene-2031 in play", "scene", "scene-2031", "/play/scenes/scene-2031"],
    ] as const;
    const destinations = citations.map(([name, kind, id, pathname]) => {
      const jump = screen.getByRole("link", { name });
      const href = jump.getAttribute("href");
      expect(href).not.toBeNull();
      const url = new URL(href!, "http://itotori.test");
      expect(url.pathname).toBe(pathname);
      expect(url.searchParams.get("projectId")).toBe(PROJECT_ID);
      expect(url.searchParams.get("localeBranchId")).toBe(LOCALE_BRANCH_ID);
      const returned = parseReturnTo(url.search);
      expect(returned).toBe(
        `/bible?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&snapshotId=${encodeURIComponent(SNAPSHOT_ID)}&objectId=obj-scene-1`,
      );
      return { href, kind, id };
    });
    source.unmount();

    const previousScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      for (const destination of destinations) {
        const url = new URL(destination.href!, "http://itotori.test");
        const location = parseAddressableLocation(url.pathname, url.search);
        expect(location).not.toBeNull();

        const player = render(<AddressableFocusScreen location={location!} />);
        const target = screen.getByRole("region", {
          name: `Focused player ${destination.kind} ${destination.id}`,
        });
        const scenePlayer = within(target).getByRole("region", { name: "Scene player" });
        expect(within(scenePlayer).getByText(destination.id)).toBeInTheDocument();
        expect(scenePlayer).toHaveClass("itotori-scene-player--highlighted");
        expect(scenePlayer).toHaveAttribute("aria-current", "true");
        expect(target).toHaveFocus();
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
        player.unmount();
      }
    } finally {
      if (previousScrollIntoView === undefined) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScrollIntoView);
      }
    }
  });

  it("ENFORCES the route toggle: an out-of-route claim is not rendered under the wrong route", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    // Canonical-only: neither route-specific claim is in the DOM.
    expect(screen.getByRole("button", { name: /Canonical only/u })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText(AKARI_STATEMENT)).not.toBeInTheDocument();
    expect(screen.queryByText(YUKI_STATEMENT)).not.toBeInTheDocument();

    // Activate the Akari route: the canonical + Akari claims are visible; the
    // Yuki claim (a DIFFERENT route) is NOT rendered — enforced, not dimmed.
    fireEvent.click(screen.getByRole("button", { name: /route-akari/u }));
    expect(await screen.findByText(AKARI_STATEMENT)).toBeInTheDocument();
    expect(screen.getByText(CANONICAL_STATEMENT, { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(YUKI_STATEMENT)).not.toBeInTheDocument();

    const claimList = screen.getByRole("list", { name: "Claims" });
    expect(claimList).toHaveAttribute("data-visible-claim-ids", "claim-canonical,claim-akari");

    // The write controls consume the same route-filtered claim projection. A
    // Yuki-only claim is absent from every edit/feedback target, not merely
    // hidden in the read panel.
    const editForm = screen.getByRole("form", { name: "Correct a claim" });
    const feedbackForm = screen.getByRole("form", { name: "Flag or leave feedback" });
    expect(within(editForm).getByLabelText("Claim")).not.toHaveTextContent("claim-yuki");
    expect(within(feedbackForm).getByLabelText("Target claim (optional)")).not.toHaveTextContent(
      "claim-yuki",
    );
    expect(within(editForm).getByRole("button", { name: "Save claim correction" })).toBeDisabled();
  });

  it("returns to the separately addressed object after feedback", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    fireEvent.click(screen.getByRole("tab", { name: /scene-elsewhere/u }));
    await screen.findByText("The archive door stays locked until sunset.", { selector: "p" });

    const form = screen.getByRole("form", { name: "Flag or leave feedback" });
    fireEvent.change(within(form).getByLabelText("Feedback"), {
      target: { value: "The bell actually rings at dusk on this route." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record feedback" }));

    await waitFor(() => {
      expect((capturedWrite as { input?: { kind?: string } })?.input?.kind).toBe("feedback");
    });
    // The assertion is part of the write contract.
    expect(capturedWrite).toMatchObject({
      assertion: {
        category: "scene-summary",
        contextSnapshotId: SNAPSHOT_ID,
        routeScope: { kind: "global" },
      },
    });
    const receipt = await screen.findByTestId("wiki-bible-receipt");
    expect(receipt).toHaveAttribute("data-addressed-object-id", "obj-scene-2");
    // The surface re-selected the addressed object (loop closed).
    expect(screen.getByRole("region", { name: "Selected wiki object" })).toHaveAttribute(
      "data-object-id",
      "obj-scene-2",
    );
  });

  it("returns to the separately addressed object after a strict claim edit", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    fireEvent.click(screen.getByRole("tab", { name: /scene-elsewhere/u }));
    await screen.findByText("The archive door stays locked until sunset.", { selector: "p" });

    const form = screen.getByRole("form", { name: "Correct a claim" });
    fireEvent.change(within(form).getByLabelText("Statement"), {
      target: { value: "The archive door unlocks at dusk." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save claim correction" }));

    await waitFor(() => {
      const input = (capturedWrite as { input?: { kind?: string; operations?: unknown[] } })?.input;
      expect(input?.kind).toBe("edit");
      expect(input?.operations?.[0]).toMatchObject({
        kind: "replace-text",
        fieldPath: ["claims", "0", "statement"],
        before: "The archive door stays locked until sunset.",
        after: "The archive door unlocks at dusk.",
      });
    });
    expect(await screen.findByTestId("wiki-bible-receipt")).toHaveAttribute(
      "data-addressed-object-id",
      "obj-scene-2",
    );
  });

  it("returns to the citation's addressed object after a durable play flag", async () => {
    const returnTo = `/bible?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&snapshotId=${encodeURIComponent(SNAPSHOT_ID)}&objectId=obj-scene-1`;
    const route = parsePlayFlagComposerRoute(
      "/play/flag",
      `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&unitId=unit-42&returnTo=${encodeURIComponent(returnTo)}`,
    );
    expect(route).toMatchObject({ bridgeUnitId: "unit-42", returnTo });
    const navigate = vi.fn();
    render(
      <App
        location={{
          pathname: "/play/flag",
          search: `?${new URLSearchParams({
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            unitId: "unit-42",
            returnTo,
          }).toString()}`,
        }}
        caps={grantedStudioCapabilityView()}
        navigate={navigate}
      />,
    );

    const composer = document.querySelector("[data-component='annotation-composer']");
    if (composer === null) {
      throw new Error("expected the play flag composer");
    }
    fireEvent.change(within(composer).getByRole("textbox", { name: "Note" }), {
      target: { value: flagReceipt.note },
    });
    fireEvent.submit(composer);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(returnTo));
  });

  it("prompts for a snapshot when the scope is incomplete", () => {
    const route = parseWikiBibleRoute("/bible", `?projectId=${PROJECT_ID}`);
    render(
      <RedactionGovernor revealSensitive={false}>
        <WikiBibleDashboardScreen route={route!} />
      </RedactionGovernor>,
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-state", "empty");
    expect(screen.getByText("Select a snapshot")).toBeInTheDocument();
  });
});
