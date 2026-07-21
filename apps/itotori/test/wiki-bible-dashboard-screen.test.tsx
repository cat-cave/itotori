// @vitest-environment jsdom
//
// Behavior proof for the Wiki bible dashboard product surface. The real screen
// reads the WikiObject API over REAL HTTP (typed client + loopback msw
// transport), adapts the wire envelopes into the product-surface read-models,
// and renders source + localized-bible claims, canonical vs route-specific
// claims under an ENFORCED route toggle, default-redacted media, immutable
// history, coverage/readiness, and the limited-context / test badges. Every real
// citation is a deep-link into the Utsushi player at the exact scene/unit with
// a rendered focus/highlight effect; a correction returns the tester to the
// object addressed.

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
  const sceneCitation = {
    claimId: "claim-canonical",
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
    badges: badges({
      // Limited-context + test badges are part of the product surface.
      contextScope: "route-slice",
      runMode: "pilot",
    }),
    claims: [
      {
        claimId: "claim-canonical",
        statement: CANONICAL_STATEMENT,
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [canonicalCitation, sceneCitation],
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
    citations: [canonicalCitation, sceneCitation],
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

function alternateSceneObject(): WikiSourceObjectView {
  return {
    ...sceneObject(),
    objectId: "obj-scene-2",
    subject: { kind: "scene", id: "scene-elsewhere" },
    claims: [
      {
        claimId: "claim-other-canonical",
        statement: "The archive door stays locked until sunset.",
        scope: { kind: "global" },
        kind: "beat",
        confidence: "high",
        supersedesClaimId: null,
        citations: [],
      },
    ],
    citations: [],
    media: [],
  };
}

function renderingFixture(sourceObjectId = "obj-scene-1"): WikiRenderingView {
  return {
    kind: "rendering",
    renderingId: `rendering-${sourceObjectId}-en`,
    sourceObjectId,
    category: "scene-summary",
    version: 1,
    targetLanguage: "en",
    routeScope: { kind: "global" },
    badges: badges(),
    claimRenderings: [
      {
        claimId: sourceObjectId === "obj-scene-1" ? "claim-canonical" : "claim-other-canonical",
        text:
          sourceObjectId === "obj-scene-1"
            ? "The temple bell rings at first light."
            : "The archive door remains shut until sunset.",
      },
    ],
  };
}

function historyFixture(): WikiHistoryEntry[] {
  return [
    {
      version: 1,
      supersedesVersion: null,
      contentHash: HASH,
      editedBy: null,
      provisional: false,
      createdAt: "2026-07-15T00:00:00.000Z",
    },
  ];
}

/** Wiki list wire envelope. */
function wikiListBody() {
  return {
    schemaVersion: "itotori.wiki.objects.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    snapshotId: SNAPSHOT_ID,
    sourceObjects: [sceneObject(), alternateSceneObject()],
    renderings: [renderingFixture(), renderingFixture("obj-scene-2")],
  };
}

/** Wiki show wire envelope. */
function wikiShowBody(object: WikiSourceObjectView) {
  return {
    schemaVersion: "itotori.wiki.object.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    view: object,
    history: historyFixture(),
    dependencyImpact: {
      dependents: [
        {
          downstreamObjectId: "rendering-scene-1-en",
          downstreamWikiKind: "localized-rendering",
          downstreamVersion: 1,
          claimId: "claim-canonical",
          fieldPath: [] as string[],
          renderingId: "rendering-scene-1-en",
          protectedHuman: false,
        },
      ],
    },
  };
}

/** Wiki edit / feedback wire envelope. */
function wikiWriteBody(inputId: string, object: WikiSourceObjectView) {
  return {
    schemaVersion: "itotori.wiki.write.v1" as const,
    generatedAt: "2026-07-16T00:00:00.000Z",
    receipt: {
      durable: true as const,
      inputId,
      head: { objectId: object.objectId, version: 2, contentHash: HASH },
      view: object,
      badges: badges({ editedBy: "human" }),
      dependencyImpact: {
        upstreamObjectId: object.objectId,
        priorVersion: 1,
        nextVersion: 2,
        consumers: [
          {
            downstreamWikiVersionId: "v-rendering-1",
            downstreamWikiKind: "localized-rendering" as const,
            downstreamObjectId: "rendering-scene-1-en",
            downstreamVersion: 1,
            workKind: "enhancement" as const,
            protectedHuman: false,
            matchedClaimIds: ["claim-canonical"],
            matchedFieldPaths: [] as string[][],
          },
        ],
        enhancementWork: ["v-rendering-1"],
        reviewerWork: [] as string[],
        impactSetHash: HASH,
      },
    },
    history: [
      ...historyFixture(),
      {
        version: 2,
        supersedesVersion: 1,
        contentHash: HASH,
        editedBy: "human",
        provisional: false,
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    dependencyImpact: {
      upstreamObjectId: object.objectId,
      priorVersion: 1,
      nextVersion: 2,
      consumers: [
        {
          downstreamWikiVersionId: "v-rendering-1",
          downstreamWikiKind: "localized-rendering" as const,
          downstreamObjectId: "rendering-scene-1-en",
          downstreamVersion: 1,
          workKind: "enhancement" as const,
          protectedHuman: false,
          matchedClaimIds: ["claim-canonical"],
          matchedFieldPaths: [] as string[][],
        },
      ],
      enhancementWork: ["v-rendering-1"],
      reviewerWork: [] as string[],
      impactSetHash: HASH,
    },
  };
}

function sourceObjectFor(objectId: string): WikiSourceObjectView | null {
  if (objectId === "obj-scene-1") {
    return sceneObject();
  }
  if (objectId === "obj-scene-2") {
    return alternateSceneObject();
  }
  return null;
}

const flagReceipt = {
  schemaVersion: "itotori.play.flag-annotation.v0" as const,
  projectId: PROJECT_ID,
  localeBranchId: LOCALE_BRANCH_ID,
  feedbackReportId: "feedback-1",
  feedbackEvidenceId: "feedback-evidence-1",
  severity: "warning" as const,
  category: "context",
  note: "The cited line does not match this route.",
  triageLabel: "context",
  contextStatus: "scheduled",
  contextCorrectionId: "correction-1",
  duplicate: false,
};

let capturedWrite: unknown = null;

const server = setupServer(
  http.get("*/api/auth/identity", () => HttpResponse.json(authIdentityFixture)),
  http.get("*/api/projects/status", () => HttpResponse.json(dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => HttpResponse.json(costReportFixture)),
  http.get("*/api/projects", () => HttpResponse.json(portfolioProjectsFixture)),
  http.get("*/api/wiki", () => HttpResponse.json(wikiListBody())),
  http.get("*/api/wiki/source-object/:objectId", ({ params }) => {
    const object = sourceObjectFor(String(params.objectId));
    return object === null
      ? new HttpResponse(null, { status: 404 })
      : HttpResponse.json(wikiShowBody(object));
  }),
  http.post("*/api/wiki/source-object/:objectId/:operation", async ({ params, request }) => {
    capturedWrite = await request.json();
    const object = sourceObjectFor(String(params.objectId));
    if (object === null) {
      return new HttpResponse(null, { status: 404 });
    }
    const inputId = params.operation === "edit" ? "edit-abc" : "feedback-abc";
    return HttpResponse.json(wikiWriteBody(inputId, object));
  }),
  http.post(`*/api/projects/${PROJECT_ID}/locale-branches/${LOCALE_BRANCH_ID}/flags`, () =>
    HttpResponse.json(flagReceipt),
  ),
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
