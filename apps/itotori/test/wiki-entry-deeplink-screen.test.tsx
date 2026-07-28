// @vitest-environment jsdom
//
// Behavior: wiki entry shows entry-level deep-links; following one lands on
// AddressableFocusScreen at the addressed scene/unit with ScenePlayer highlight.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { WikiEntryDeepLinkPanel } from "../src/ui/screens/wiki-bible/entry-deeplink-panel.js";
import { AddressableFocusScreen } from "../src/ui/screens/AddressableFocusScreen.js";
import { parseAddressableLocation } from "../src/ui/addressable-routing.js";
import type { WikiSourceObjectView } from "../src/wiki/dashboard/read-model.js";

const PROJECT_ID = "project-1";
const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";
const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;
const HASH = `sha256:${"b".repeat(64)}`;

function sceneObject(): WikiSourceObjectView {
  const unitCitation = {
    claimId: "claim-1",
    evidenceId: "ev-unit-42",
    evidenceHash: HASH,
    snapshotId: SNAPSHOT_ID,
    subject: { kind: "unit" as const, id: "unit-42" },
    role: "establishes" as const,
    playOrderIndex: 3,
    quotedSpan: null,
  };
  const sceneCitation = {
    claimId: "claim-1",
    evidenceId: "ev-scene-2031",
    evidenceHash: HASH,
    snapshotId: SNAPSHOT_ID,
    subject: { kind: "scene" as const, id: "scene-2031" },
    role: "establishes" as const,
    playOrderIndex: 3,
    quotedSpan: null,
  };
  return {
    kind: "source",
    objectId: "obj-scene-1",
    wikiKind: "source-object",
    category: "scene-summary",
    version: 1,
    lang: "ja",
    subject: { kind: "scene", id: "scene-2031" },
    routeScope: { kind: "global" },
    badges: {
      provisional: false,
      contextScope: "whole-game",
      runMode: "production",
      editedBy: null,
    },
    claims: [
      {
        claimId: "claim-1",
        statement: "The shrine bell tolls at dawn.",
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [unitCitation, sceneCitation],
      },
    ],
    citations: [unitCitation, sceneCitation],
    media: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("wiki entry deep-link panel → player landing", () => {
  it("renders only the branch-verified producer scene and lands on its addressed unit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("addressable-units")
                ? {
                    schemaVersion: "itotori.play.addressable-unit.v0",
                    projectId: PROJECT_ID,
                    localeBranchId: LOCALE_BRANCH_ID,
                    unit: {
                      bridgeUnitId: "unit-42",
                      state: "resolved",
                      sceneId: "scene-2031",
                      sourceUnitKey: "opaque-producer-unit-key",
                    },
                  }
                : {
                    schemaVersion: "itotori.play.unit-feedback.v0",
                    projectId: PROJECT_ID,
                    localeBranchId: LOCALE_BRANCH_ID,
                    bridgeUnitId: "unit-42",
                    notes: [],
                  },
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const object = sceneObject();
    render(
      <WikiEntryDeepLinkPanel
        object={object}
        scope={{
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          snapshotId: SNAPSHOT_ID,
        }}
      />,
    );

    const panel = await screen.findByTestId("wiki-entry-deeplink-panel");
    expect(panel).toHaveAttribute("data-entry-primary-kind", "scene");
    expect(panel).toHaveAttribute("data-entry-primary-id", "scene-2031");

    const sceneJump = screen.getByRole("link", { name: /Jump to scene scene-2031/u });
    const href = sceneJump.getAttribute("href");
    expect(href).not.toBeNull();
    const url = new URL(href!, "http://itotori.test");
    expect(url.pathname).toBe("/play/scenes/scene-2031");

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
      const location = parseAddressableLocation(url.pathname, url.search);
      expect(location).not.toBeNull();
      render(<AddressableFocusScreen location={location!} />);
      const target = screen.getByRole("region", {
        name: "Focused player unit unit-42",
      });
      const scenePlayer = within(target).getByRole("region", { name: "Scene player" });
      expect(within(scenePlayer).getByText("unit-42")).toBeInTheDocument();
      expect(scenePlayer).toHaveClass("itotori-scene-player--highlighted");
      expect(target).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    } finally {
      if (previousScrollIntoView === undefined) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScrollIntoView);
      }
    }
  });

  it("renders no panel when the entry has no resolvable player target", () => {
    const object = sceneObject();
    object.subject = { kind: "glossary-term", id: "term-x" };
    object.citations = [];
    object.claims = [
      {
        claimId: "claim-term",
        statement: "A term ruling.",
        scope: { kind: "global" },
        kind: "term",
        confidence: "high",
        supersedesClaimId: null,
        citations: [],
      },
    ];
    const { container } = render(
      <WikiEntryDeepLinkPanel
        object={object}
        scope={{
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          snapshotId: SNAPSHOT_ID,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
