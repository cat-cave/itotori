// @vitest-environment jsdom
// rev-comparison-pane — behavior-first test for the reviewer detail REVISION
// HISTORY comparison pane.
//
// Mounts the REAL `RevisionHistoryComparisonPane` over an
// msw-intercepted `/api/workspace/comparison` and asserts the OBSERVABLE
// behavior the reviewer sees: the pane reads the read-model through the
// typed client (no ad-hoc fetch) and renders source ↔ draft ↔ re-draft
// HISTORY using the ds `ComparisonPane` + `BiText` + locale-branch identity
// tokens, with locale identifiers (`ja-JP`, `en-US`) rendered as MONO CODE
// tags so the branching is owned by an identity rather than free-floating
// strings. Loading / empty / error / denied surface independently instead
// of a blank panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named;
// only the rendered source/draft/re-draft cells + locale identity tokens
// and the loading / empty / error states are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { WorkspaceComparisonReadModel } from "../src/workspace/index.js";
import {
  workspaceComparisonFixture,
  workspaceDeniedComparisonFixture,
} from "../src/workspace/index.js";
import { RevisionHistoryComparisonPane } from "../src/ui/screens/RevisionHistoryComparisonPane.js";
import { apiJson } from "./msw-handlers.js";

const REVIEW_ITEM_ID = "review-item-rev-compare";
const COMPARISON_PATH = "*/api/workspace/comparison";

// A workspace.comparison fixture carrying a SOURCE / DRAFT / RE-DRAFT
// (final) cell triplet so the pane renders the full three-step history.
function historyFixture(
  overrides: Partial<WorkspaceComparisonReadModel> = {},
): WorkspaceComparisonReadModel {
  return workspaceComparisonFixture({
    reviewItemId: REVIEW_ITEM_ID,
    localeBranchId: "locale-branch-rev-compare",
    sourceRevisionId: "source-revision-rev-compare",
    bridgeUnitId: "bridge-unit-rev-compare",
    sourceUnitKey: "scene.rev.line.001",
    contextNote: "Greeting in the revision comparison scene.",
    cells: [
      {
        side: "source",
        locale: "ja-JP",
        text: "放課後、屋上で待ってる。",
        label: "Source (ja-JP)",
      },
      {
        side: "draft",
        locale: "en-US",
        text: "I'll be waiting on the roof after school.",
        label: "Draft (en-US)",
      },
      {
        side: "final",
        locale: "en-US",
        text: "I'll be on the roof after school — wait for me.",
        label: "Final / approved (en-US)",
      },
    ],
    hasFinal: true,
    diagnostics: [],
    ...overrides,
  });
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

// Register a handler that returns the canonical history fixture for the
// canonical review item id; tests that need a different response call this
// fresh per test so the override pattern stays explicit.
function handleHistory(): void {
  server.use(
    http.get(COMPARISON_PATH, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("reviewItemId") === REVIEW_ITEM_ID) {
        return apiJson("workspace.comparison", historyFixture());
      }
      return new HttpResponse(null, { status: 404 });
    }),
  );
}

describe("RevisionHistoryComparisonPane — source ↔ draft ↔ re-draft", () => {
  it("renders source, draft, and re-draft from a mocked workspace.comparison", async () => {
    handleHistory();
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);

    // Panel mounts + the read-model settles to ready.
    expect(await screen.findByRole("heading", { name: "Revision history" })).toBeInTheDocument();

    // The pane renders the three-step history on a single ordered list,
    // with a per-step `data-step` marker so the SOURCE / DRAFT /
    // RE-DRAFT cells are observable in isolation.
    const steps = await screen.findAllByRole("listitem");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const sourceStep = steps.find((step) => step.getAttribute("data-step") === "source-to-draft");
    const reDraftStep = steps.find((step) => step.getAttribute("data-step") === "draft-to-redraft");
    expect(sourceStep).toBeDefined();
    expect(reDraftStep).toBeDefined();

    // SOURCE cell renders verbatim from the mocked read-model, scoped to
    // the source↔draft ComparisonPane step.
    expect(
      within(sourceStep as HTMLElement).getByText("放課後、屋上で待ってる。"),
    ).toBeInTheDocument();

    // DRAFT cell renders verbatim from the mocked read-model, scoped to
    // the source↔draft ComparisonPane step.
    expect(
      within(sourceStep as HTMLElement).getByText("I'll be waiting on the roof after school."),
    ).toBeInTheDocument();

    // RE-DRAFT (= final) cell renders verbatim from the mocked read-model,
    // scoped to the draft↔re-draft ComparisonPane step.
    expect(
      within(reDraftStep as HTMLElement).getByText(
        "I'll be on the roof after school — wait for me.",
      ),
    ).toBeInTheDocument();
  });

  it("uses both the ds ComparisonPane and the BiText + locale identity tokens", async () => {
    handleHistory();
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);
    // The pane renders at least two stacked ComparisonPane surfaces — the
    // source↔draft step AND the draft↔re-draft (final) step — both as real
    // ds `itotori-compare` elements (className-based, no literal styles).
    await screen.findByRole("heading", { name: "Revision history" });
    const compareMatches = document.querySelectorAll(".itotori-compare");
    expect(compareMatches.length).toBeGreaterThanOrEqual(2);

    // BiText surfaces the locale-branch identity tokens (sourceLocale +
    // targetLocale) as MONO CODE tags — the locale-branch identity contract.
    const bitext = document.querySelector(".itotori-bitext");
    expect(bitext).not.toBeNull();
    const localeTokens = bitext?.querySelectorAll(".itotori-bitext__locale") ?? [];
    expect(localeTokens.length).toBeGreaterThanOrEqual(2);
    const tokensText = Array.from(localeTokens).map((node) => node.textContent ?? "");
    expect(tokensText).toContain("ja-JP");
    expect(tokensText).toContain("en-US");
  });

  it("surfaces the loading surface before the read-model settles", () => {
    handleHistory();
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);
    // The typed resource starts in `loading`; the pane paints the loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading revision history…")).toBeInTheDocument();
  });

  it("renders the empty state when the comparison has no cells", async () => {
    server.use(
      http.get(COMPARISON_PATH, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("reviewItemId") === REVIEW_ITEM_ID) {
          return apiJson(
            "workspace.comparison",
            historyFixture({
              cells: [],
              hasFinal: false,
              contextNote: null,
            }),
          );
        }
        return new HttpResponse(null, { status: 404 });
      }),
    );
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);
    // The api-client treats `cells: []` as the structured `empty`
    // state; the pane surfaces a no-data message rather than a
    // blank panel (per the studio's four-state UX invariant).
    expect(
      await screen.findByText("No workspace comparison data was returned for this reviewer item."),
    ).toBeInTheDocument();
  });

  it("renders an error state when the read-model fetch 404s", async () => {
    server.use(http.get(COMPARISON_PATH, () => new HttpResponse(null, { status: 404 })));
    render(<RevisionHistoryComparisonPane reviewItemId="review-item-missing" />);
    // No handler recognises this id; the typed resource settles to
    // `error`, NOT to a blank panel — the read model's emptiness is
    // surfaced, not fabricated.
    expect(await screen.findByText(/This view could not load/i)).toBeInTheDocument();
  });

  it("renders the denied surface when the read-model carries a denied permission with populated cells", async () => {
    server.use(
      http.get(COMPARISON_PATH, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("reviewItemId") === REVIEW_ITEM_ID) {
          // A response that BOTH denies the queue.read permission
          // AND carries a populated cells array (so the api-client
          // does not collapse it into the structured `empty` state)
          // — the only path the read-model reaches the ready branch
          // with canReadQueue = false.
          const denied = workspaceDeniedComparisonFixture(REVIEW_ITEM_ID);
          return apiJson("workspace.comparison", {
            ...denied,
            // Replay a non-empty comparison so the api-client does not
            // collapse this into the structured `empty` state — the
            // pane only sees the denied branch when the data is
            // actually delivered.
            cells: historyFixture().cells,
            permission: denied.permission,
            reviewItemId: REVIEW_ITEM_ID,
          });
        }
        return new HttpResponse(null, { status: 404 });
      }),
    );
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);
    expect(
      await screen.findByText(/user unauthorized-user is missing permission queue.read/u),
    ).toBeInTheDocument();
  });

  it("surfaces a typed error state when the route responds 503", async () => {
    server.use(
      http.get(COMPARISON_PATH, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("reviewItemId") === REVIEW_ITEM_ID) {
          return HttpResponse.json(
            { code: "internal_error", error: "reviewer item has no comparison context" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 404 });
      }),
    );
    render(<RevisionHistoryComparisonPane reviewItemId={REVIEW_ITEM_ID} />);
    expect(await screen.findByText("reviewer item has no comparison context")).toBeInTheDocument();
  });
});
