// @vitest-environment jsdom
//
// Behavior proof for the Wiki bible dashboard product surface. The real screen
// reads the wiki object read/write API over REAL HTTP (the dashboard data client
// + a loopback msw transport), renders the source + localized-bible claims,
// canonical vs route-specific claims under an ENFORCED route toggle, default-
// redacted media, immutable history, coverage/readiness, and the limited-context
// / test badges. Every real citation is a deep-link into the Utsushi player at
// the exact scene/unit; a correction returns the tester to the object addressed.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  WikiBibleDashboardScreen,
  parseWikiBibleRoute,
} from "../src/ui/screens/WikiBibleDashboardScreen.js";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import { hrefForAddressable, parseAddressableLocation } from "../src/ui/addressable-routing.js";
import {
  WIKI_DASHBOARD_OBJECT_SCHEMA,
  WIKI_DASHBOARD_OVERVIEW_SCHEMA,
  WIKI_DASHBOARD_WRITE_SCHEMA,
  type WikiDashboardObject,
  type WikiDashboardOverview,
  type WikiDashboardWriteReceipt,
  type WikiSourceObjectView,
  type WikiRenderingView,
} from "../src/wiki/dashboard/read-model.js";

const PROJECT_ID = "project-1";
const LOCALE_BRANCH_ID = "019ed065-0000-7000-8000-000000000110";
const SNAPSHOT_ID = `sha256:${"a".repeat(64)}`;
const HASH = `sha256:${"b".repeat(64)}`;

const CANONICAL_STATEMENT = "The shrine bell tolls at dawn.";
const AKARI_STATEMENT = "Akari confesses her feelings at the shrine.";
const YUKI_STATEMENT = "Yuki never once visits the shrine.";

function badges(
  overrides: Partial<WikiSourceObjectView["badges"]> = {},
): WikiSourceObjectView["badges"] {
  return {
    provisional: false,
    contextScope: "whole-game",
    runMode: "production",
    editedBy: null,
    ...overrides,
  };
}

function sceneObject(): WikiSourceObjectView {
  const canonicalCitation = {
    claimId: "claim-canonical",
    evidenceId: "ev-unit-42",
    evidenceHash: HASH,
    snapshotId: SNAPSHOT_ID,
    subject: { kind: "unit" as const, id: "unit-42" },
    role: "establishes" as const,
    playOrderIndex: 3,
    quotedSpan: "the bell",
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
    badges: badges(),
    claims: [
      {
        claimId: "claim-canonical",
        statement: CANONICAL_STATEMENT,
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [canonicalCitation],
      },
      {
        claimId: "claim-akari",
        statement: AKARI_STATEMENT,
        scope: { kind: "route", routeId: "route-akari" },
        kind: "arc",
        confidence: "medium",
        supersedesClaimId: null,
        citations: [
          {
            claimId: "claim-akari",
            evidenceId: "ev-scene-akari",
            evidenceHash: HASH,
            snapshotId: SNAPSHOT_ID,
            subject: { kind: "scene", id: "scene-akari-9" },
            role: "reveal",
            playOrderIndex: 12,
            quotedSpan: null,
          },
        ],
      },
      {
        claimId: "claim-yuki",
        statement: YUKI_STATEMENT,
        scope: { kind: "route", routeId: "route-yuki" },
        kind: "arc",
        confidence: "low",
        supersedesClaimId: null,
        citations: [],
      },
    ],
    citations: [canonicalCitation],
    media: [
      {
        kind: "screenshot",
        mediaId: "media-shot-1",
        sceneId: "scene-2031",
        availability: {
          status: "available",
          artifactUri: "artifacts/utsushi/runtime/test-run/screenshots/shot-1.png",
          contentHash: HASH,
          mediaType: "image/png",
          dimensions: { width: 1280, height: 720 },
          access: { redaction: "default-redacted", permission: "project-member" },
        },
      },
    ],
  };
}

function renderingFixture(): WikiRenderingView {
  return {
    kind: "rendering",
    renderingId: "rendering-scene-1-en",
    sourceObjectId: "obj-scene-1",
    category: "scene-summary",
    version: 1,
    targetLanguage: "en",
    routeScope: { kind: "global" },
    badges: badges(),
    claimRenderings: [
      { claimId: "claim-canonical", text: "The temple bell rings at first light." },
    ],
  };
}

function overviewFixture(): WikiDashboardOverview {
  const source = sceneObject();
  return {
    schemaVersion: WIKI_DASHBOARD_OVERVIEW_SCHEMA,
    generatedAt: "2026-07-16T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID,
    sourceObjects: [source],
    renderings: [renderingFixture()],
    routes: [
      { routeId: "route-akari", claimCount: 1 },
      { routeId: "route-yuki", claimCount: 1 },
    ],
    readiness: {
      sourceObjectCount: 1,
      renderingCount: 1,
      provisionalSourceCount: 0,
      provisionalRenderingCount: 0,
      localizedSourceCount: 1,
      localizationCoveragePercent: 100,
      limitedContextCount: 0,
      testModeCount: 0,
    },
  };
}

function objectDetailFixture(): WikiDashboardObject {
  return {
    schemaVersion: WIKI_DASHBOARD_OBJECT_SCHEMA,
    generatedAt: "2026-07-16T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID,
    object: sceneObject(),
    history: [
      {
        version: 1,
        supersedesVersion: null,
        contentHash: HASH,
        editedBy: null,
        provisional: false,
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    dependents: [
      {
        downstreamObjectId: "rendering-scene-1-en",
        downstreamWikiKind: "localized-rendering",
        downstreamVersion: 1,
        claimId: "claim-canonical",
        fieldPath: [],
        renderingId: "rendering-scene-1-en",
        protectedHuman: false,
      },
    ],
  };
}

function writeReceiptFixture(): WikiDashboardWriteReceipt {
  return {
    schemaVersion: WIKI_DASHBOARD_WRITE_SCHEMA,
    generatedAt: "2026-07-16T00:00:00.000Z",
    inputId: "feedback-abc",
    addressedObjectId: "obj-scene-1",
    addressedWikiKind: "source-object",
    head: { objectId: "obj-scene-1", version: 2, contentHash: HASH },
    object: sceneObject(),
    badges: badges({ editedBy: "human" }),
    invalidatedObjectIds: ["rendering-scene-1-en"],
  };
}

const overviewPath = `*/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/wiki-objects`;
const objectPath = `${overviewPath}/obj-scene-1`;

let capturedWrite: unknown = null;

const server = setupServer(
  http.get(objectPath, () => HttpResponse.json(objectDetailFixture())),
  http.post(objectPath, async ({ request }) => {
    capturedWrite = await request.json();
    return HttpResponse.json(writeReceiptFixture());
  }),
  http.get(overviewPath, () => HttpResponse.json(overviewFixture())),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  capturedWrite = null;
});
afterAll(() => server.close());

function renderScreen(
  search = `?projectId=${PROJECT_ID}&localeBranchId=${LOCALE_BRANCH_ID}&snapshotId=${encodeURIComponent(SNAPSHOT_ID)}`,
) {
  const route = parseWikiBibleRoute("/bible", search);
  if (route === null) {
    throw new Error("route did not parse");
  }
  return render(
    <RedactionGovernor revealSensitive={false}>
      <WikiBibleDashboardScreen route={route} />
    </RedactionGovernor>,
  );
}

describe("Wiki bible dashboard", () => {
  it("renders source claims, readiness, media, history, and badges from the wiki object API", async () => {
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

    // Confirmed (non-provisional) badge on the object header.
    const objectRegion = screen.getByRole("region", { name: "Selected wiki object" });
    expect(within(objectRegion).getAllByText("confirmed").length).toBeGreaterThan(0);
  });

  it("switches to the localized bible and shows the localized rendering", async () => {
    renderScreen();
    expect(await screen.findByText(CANONICAL_STATEMENT, { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Localized bible/u }));
    expect(await screen.findByText("The temple bell rings at first light.")).toBeInTheDocument();
  });

  it("resolves a real citation to the EXACT Utsushi player scene/unit address and highlight", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    const expectedHref = hrefForAddressable({
      kind: "unit",
      id: "unit-42",
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
    });
    const jump = await screen.findByText(/open unit unit-42 in play/u);
    expect(jump).toHaveAttribute("href", expectedHref);
    expect(jump).toHaveAttribute("data-citation-player-jump", expectedHref);

    // The address resolves to the player surface, focused on the exact entity.
    const resolved = parseAddressableLocation(
      expectedHref.split("?")[0] ?? "",
      expectedHref.includes("?") ? `?${expectedHref.split("?")[1] ?? ""}` : "",
    );
    expect(resolved?.surface).toBe("play");
    expect(resolved?.focus).toEqual({ kind: "unit", id: "unit-42" });
    expect(jump).toHaveAttribute("data-citation-focus", "unit:unit-42");
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
  });

  it("closes the loop: feedback returns the tester to the addressed object", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    const form = screen.getByRole("form", { name: "Flag or leave feedback" });
    fireEvent.change(within(form).getByLabelText("Feedback"), {
      target: { value: "The bell actually rings at dusk on this route." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record feedback" }));

    await waitFor(() => {
      expect((capturedWrite as { input?: { kind?: string } })?.input?.kind).toBe("feedback");
    });
    const receipt = await screen.findByTestId("wiki-bible-receipt");
    expect(receipt).toHaveAttribute("data-addressed-object-id", "obj-scene-1");
    // The surface re-selected the addressed object (loop closed).
    expect(screen.getByRole("region", { name: "Selected wiki object" })).toHaveAttribute(
      "data-object-id",
      "obj-scene-1",
    );
  });

  it("submits a claim correction as a strict edit HumanInput addressing the object", async () => {
    renderScreen();
    await screen.findByText(CANONICAL_STATEMENT, { selector: "p" });

    const form = screen.getByRole("form", { name: "Correct a claim" });
    fireEvent.change(within(form).getByLabelText("Statement"), {
      target: { value: "The shrine bell tolls at dusk." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save claim correction" }));

    await waitFor(() => {
      const input = (capturedWrite as { input?: { kind?: string; operations?: unknown[] } })?.input;
      expect(input?.kind).toBe("edit");
      expect(input?.operations?.[0]).toMatchObject({
        kind: "replace-text",
        fieldPath: ["claims", "0", "statement"],
        before: CANONICAL_STATEMENT,
        after: "The shrine bell tolls at dusk.",
      });
    });
    expect(await screen.findByTestId("wiki-bible-receipt")).toHaveAttribute(
      "data-addressed-object-id",
      "obj-scene-1",
    );
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
