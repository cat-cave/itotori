// @vitest-environment jsdom
// rev-detail-ui — behavior-first test for the reviewer DETAIL screen's
// enriched DRAFT-HISTORY + POLICY-RULES + GLOSSARY panels.
//
// Mounts the REAL `ReviewerDetailScreen` over an msw-intercepted
// `/api/reviewer/queue/:id/detail` (the `reviewer.detail` read-model) AND
// `/api/workspace/comparison` (the sibling revision-history pane), and asserts
// the OBSERVABLE behavior a reviewer sees: the three enriched panels read the
// SAME read-model THROUGH the typed client (no ad-hoc fetch) and render
//   - the DRAFT-HISTORY progression (draft text → approved patch) with the
//     attempt counter + status badge, using the ds `BiText` + `ComparisonPane`;
//   - the POLICY-RULES identity + status + branch policy provenance;
//   - the GLOSSARY terms + branch glossary provenance, client-paginated with
//     the ds `Pagination` primitive when the term list overflows one page.
// Loading / empty / error surface independently instead of a blank panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered draft/patch/policy/glossary text + the loading / empty / error
// states are asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  branchReferenceFixture,
  draftFixture,
  glossaryFixture,
  policyFixture,
  readyContextFixture,
} from "../src/reviewer/index.js";
import type { ReviewerDetailContext } from "../src/reviewer/index.js";
import { workspaceComparisonFixture } from "../src/workspace/index.js";
import { ReviewerDetailScreen } from "../src/ui/screens/ReviewerDetailScreen.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";

const REVIEW_ITEM_ID = "reviewer-queue-itotori-082";
const DETAIL_PATH = "*/api/reviewer/queue/:reviewItemId/detail";
const COMPARISON_PATH = "*/api/workspace/comparison";

const DRAFT_TEXT = "I'll be waiting on the roof after school.";
const PATCH_TEXT = "I'll be on the roof after school — wait for me.";

// A detail context carrying an APPROVED PATCH (so the draft→patch delta
// renders) and a NINE-entry glossary (so the ds Pagination surfaces at the
// 8-per-page window).
function historyContext(overrides: Partial<ReviewerDetailContext> = {}): ReviewerDetailContext {
  return readyContextFixture({
    draft: draftFixture({
      draftText: DRAFT_TEXT,
      approvedPatchText: PATCH_TEXT,
      draftStatus: "accepted",
      attemptCount: 2,
      targetLocale: "en-US",
    }),
    policy: policyFixture({
      policyLabel: "Demo corpus — informal honorifics",
      styleGuidePolicyStatus: "approved",
    }),
    branchReference: branchReferenceFixture({
      branchPolicyRef: "style-guide-version-itotori-082",
      glossaryRef: "sha256:branch-glossary-content-hash-itotori-082",
      versionSequence: 3,
      updateReason: "glossary_snapshot_refreshed",
    }),
    glossary: Array.from({ length: 9 }, (_unused, index) =>
      glossaryFixture({
        termId: `term-${index}`,
        sourceTerm: `用語${index}`,
        preferredTranslation: `term ${index}`,
        glossaryEntryStatus: index === 0 ? "approved" : "proposed",
      }),
    ),
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

// The screen's `RevisionHistoryComparisonPane` fires `workspace.comparison`
// too; a benign fixture keeps the sibling pane green so the test only asserts
// the panels this node owns.
function handleComparison(): void {
  server.use(
    http.get(COMPARISON_PATH, () =>
      apiJson("workspace.comparison", workspaceComparisonFixture({ reviewItemId: REVIEW_ITEM_ID })),
    ),
  );
}

function handleDetail(context: ReviewerDetailContext = historyContext()): void {
  server.use(http.get(DETAIL_PATH, () => apiJson("reviewer.detail", context)));
  handleComparison();
}

function renderWithToasts(ui: ReactNode): void {
  render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ReviewerDetailScreen — draft history + policy + glossary", () => {
  it("renders the draft-history progression (draft text → approved patch) with attempt + status", async () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(await screen.findByRole("heading", { name: "Draft history" })).toBeInTheDocument();
    const draftPanel = document.querySelector('[data-panel-id="draft-history"]');
    expect(draftPanel).not.toBeNull();
    const scoped = within(draftPanel as HTMLElement);

    // The draft version renders (BiText + the ComparisonPane source side) and
    // the approved-patch delta renders (ComparisonPane draft side) — both
    // verbatim from the mocked read-model, scoped to this panel.
    expect(scoped.getAllByText(DRAFT_TEXT).length).toBeGreaterThanOrEqual(1);
    expect(scoped.getByText(PATCH_TEXT)).toBeInTheDocument();

    // The attempt counter + status badge make the loop iteration observable.
    expect(scoped.getByText(/attempt 2/i)).toBeInTheDocument();
    // Both discrete progression stages are present.
    expect((draftPanel as HTMLElement).querySelector('[data-draft-stage="draft"]')).not.toBeNull();
    expect((draftPanel as HTMLElement).querySelector('[data-draft-stage="patch"]')).not.toBeNull();
  });

  it("renders the policy-rules identity + branch policy provenance", async () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(await screen.findByRole("heading", { name: "Style-guide policy" })).toBeInTheDocument();
    const policyPanel = document.querySelector('[data-panel-id="policy-rules"]');
    expect(policyPanel).not.toBeNull();
    const scoped = within(policyPanel as HTMLElement);
    // The policy label + version identity + the EXACT branch policy ref the
    // draft was produced under all render from the read-model. The policy
    // version id AND the branch policy ref are the same version identity, so
    // it renders twice (policy identity + branch provenance).
    expect(scoped.getByText("Demo corpus — informal honorifics")).toBeInTheDocument();
    expect(scoped.getAllByText("style-guide-version-itotori-082").length).toBeGreaterThanOrEqual(2);
    expect(scoped.getByText("glossary_snapshot_refreshed")).toBeInTheDocument();
  });

  it("renders the glossary terms + provenance, paginated via the ds Pagination primitive", async () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(await screen.findByRole("heading", { name: "Glossary" })).toBeInTheDocument();
    const glossaryPanel = document.querySelector('[data-panel-id="glossary"]');
    expect(glossaryPanel).not.toBeNull();
    const scoped = within(glossaryPanel as HTMLElement);

    // Branch glossary provenance renders.
    expect(scoped.getByText("sha256:branch-glossary-content-hash-itotori-082")).toBeInTheDocument();

    // First page (8 of 9): term 0 present, the overflow term 8 not yet.
    expect(scoped.getByText("用語0")).toBeInTheDocument();
    expect(scoped.queryByText("用語8")).toBeNull();

    // The pager exists (9 entries > 8/page); advancing it reveals the 9th term.
    fireEvent.click(scoped.getByRole("button", { name: "Next page" }));
    expect(await scoped.findByText("用語8")).toBeInTheDocument();
  });

  it("surfaces the loading surface before the read-model settles", () => {
    handleDetail();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);
    expect(screen.getByText(/Loading reviewer detail/i)).toBeInTheDocument();
  });

  it("renders the missing-context copy when the draft / policy / glossary are absent", async () => {
    handleDetail(
      historyContext({
        draft: null,
        policy: null,
        glossary: [],
        branchReference: null,
      }),
    );
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);

    expect(await screen.findByRole("heading", { name: "Draft history" })).toBeInTheDocument();
    // Each enriched panel emits a visible missing-context line, never a blank.
    expect(
      within(document.querySelector('[data-panel-id="draft-history"]') as HTMLElement).getByText(
        /No draft history/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(document.querySelector('[data-panel-id="policy-rules"]') as HTMLElement).getByText(
        /No policy/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(document.querySelector('[data-panel-id="glossary"]') as HTMLElement).getByText(
        /No glossary entries/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders an error state (not a blank panel) when the detail fetch 404s", async () => {
    server.use(http.get(DETAIL_PATH, () => new HttpResponse(null, { status: 404 })));
    handleComparison();
    renderWithToasts(<ReviewerDetailScreen reviewItemId={REVIEW_ITEM_ID} />);
    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("data-state", "error");
  });
});
