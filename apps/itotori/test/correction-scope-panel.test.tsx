// @vitest-environment jsdom
// rev-correction-loop-ui — behavior-first test for the reviewer detail
// CORRECTION SCOPE panel.
//
// Mounts the REAL `CorrectionScopePanel` over an msw-intercepted
// `/api/workspace/corrections` (the correction-feedback-loop preview
// read-model) + `/api/projects/overview` (the repair / pass-ledger
// read-model) and asserts the OBSERVABLE behavior the reviewer sees: the
// panel reads the correction-feedback-loop read-model through the typed
// client (no ad-hoc fetch) and renders the correction's SCOPE (which unit /
// scene it affects) and which PASS (N+1) folds it in — derived from the
// pass ledger — using the ds `ComparisonPane` + `StatReadout` + `Badge`
// tokens. Loading / empty / error surface independently instead of a blank
// panel.
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered scope + folding pass + loading / empty / error states are
// asserted, over msw.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { WorkspaceCorrectionPreviewReadModel } from "../src/workspace/index.js";
import {
  CorrectionScopePanel,
  deriveCorrectionFoldingPass,
} from "../src/ui/screens/CorrectionScopePanel.js";
import { apiJson } from "./msw-handlers.js";
import { projectOverviewFixture } from "./api-fixtures.js";

const REVIEW_ITEM_ID = "review-item-rev-corr";
const LOCALE_BRANCH_ID = "locale-branch-rev-corr";
const CORRECTIONS_PATH = "*/api/workspace/corrections";
const OVERVIEW_PATH = "*/api/projects/overview";

// A correction-feedback-loop preview fixture carrying ONE unit — the
// correction under review — with source / draft / corrected (final) text so
// the panel renders the correction's scope (bridge unit + scene/unit key).
function previewFixture(
  overrides: Partial<WorkspaceCorrectionPreviewReadModel> = {},
): WorkspaceCorrectionPreviewReadModel {
  return {
    schemaVersion: "workspace.correction_preview.v0.1",
    generatedAt: "2026-07-08T00:00:00.000Z",
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    localeBranchId: LOCALE_BRANCH_ID,
    units: [
      {
        reviewItemId: REVIEW_ITEM_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: "source-revision-rev-corr",
        bridgeUnitId: "bridge-unit-rev-corr",
        sourceUnitKey: "scene.001.line.001",
        sourceLocale: "ja-JP",
        sourceText: "こんにちは、世界。",
        targetLocale: "en-US",
        draftText: "Hello, world.",
        finalText: "Hello, world! [reviewer-corrected]",
        styleGuidePolicyVersionId: "style-guide-version-rev-corr",
        styleGuidePolicyStatus: "approved",
        glossary: [],
        runtimeEvidenceLinks: [],
        screenshotArtifactHashes: [],
        diagnostics: [],
      },
    ],
    diagnostics: [],
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

// Register the success handlers for both read-models the panel consumes.
// Tests that need a different response register their own handler fresh.
function handleScope(): void {
  server.use(
    http.get(CORRECTIONS_PATH, ({ request }) => {
      const url = new URL(request.url);
      if (
        url.searchParams.get("localeBranchId") === LOCALE_BRANCH_ID &&
        url.searchParams.get("reviewItemIds") === REVIEW_ITEM_ID
      ) {
        return apiJson("workspace.correctionPreview", previewFixture());
      }
      return new HttpResponse(null, { status: 404 });
    }),
    http.get(OVERVIEW_PATH, () => apiJson("projects.overview", projectOverviewFixture)),
  );
}

describe("CorrectionScopePanel — correction scope + folding pass (N+1)", () => {
  it("renders the correction's scope and the next pass that folds it in", async () => {
    handleScope();
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );

    // Panel mounts + the read-model settles to ready.
    expect(await screen.findByRole("heading", { name: "Correction scope" })).toBeInTheDocument();

    // The folding pass is derived from the pass ledger: the fixture's latest
    // pass is pass 1, so the correction folds into pass 2 (N+1). It renders
    // both as the headline badge and in the landing copy.
    const passMatches = await screen.findAllByText("pass 2");
    expect(passMatches.length).toBeGreaterThanOrEqual(1);

    // The SCOPE renders verbatim from the mocked preview — the bridge unit +
    // scene/unit key the correction affects.
    expect(screen.getByText("bridge-unit-rev-corr")).toBeInTheDocument();
    expect(screen.getByText("scene.001.line.001")).toBeInTheDocument();

    // The correction itself (draft → corrected) renders verbatim.
    expect(screen.getByText("Hello, world.")).toBeInTheDocument();
    expect(screen.getByText("Hello, world! [reviewer-corrected]")).toBeInTheDocument();
  });

  it("derives the folding pass purely from the pass-ledger rows", () => {
    // Behavior-first: the folding-pass derivation is a pure function of the
    // pass-ledger rows — latest pass N folds into N+1; an empty ledger folds
    // into pass 1.
    expect(deriveCorrectionFoldingPass([{ passNumber: 1 }])).toEqual({
      latestPassNumber: 1,
      foldingPass: 2,
    });
    expect(
      deriveCorrectionFoldingPass([{ passNumber: 1 }, { passNumber: 4 }, { passNumber: 2 }]),
    ).toEqual({ latestPassNumber: 4, foldingPass: 5 });
    expect(deriveCorrectionFoldingPass([])).toEqual({ latestPassNumber: null, foldingPass: 1 });
  });

  it("surfaces the loading surface before the read-model settles", () => {
    handleScope();
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );
    // The typed resource starts in `loading`; the panel paints the loading
    // surface synchronously on first render, before the fetch resolves.
    expect(screen.getByText("Loading correction scope…")).toBeInTheDocument();
  });

  it("stamps the root <Panel> with data-pane-id / data-pane-state / data-review-item-id", async () => {
    handleScope();
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );
    // Wait for the read-model to settle (the folding pass mounts once the
    // fetch resolves and the panel paints the ready branch).
    await screen.findAllByText("pass 2");
    const panel = document.querySelector(".itotori-panel");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("data-pane-id", "correction-scope");
    expect(panel).toHaveAttribute("data-pane-state", "ready");
    expect(panel).toHaveAttribute("data-review-item-id", REVIEW_ITEM_ID);
  });

  it("renders the empty state when the preview carries no units", async () => {
    server.use(
      http.get(CORRECTIONS_PATH, () =>
        apiJson("workspace.correctionPreview", previewFixture({ units: [] })),
      ),
      http.get(OVERVIEW_PATH, () => apiJson("projects.overview", projectOverviewFixture)),
    );
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );
    // The api-client treats `units: []` as the structured `empty` state; the
    // panel surfaces a no-data message rather than a blank panel.
    expect(
      await screen.findByText(
        "No correction-feedback-loop preview was returned for this reviewer item.",
      ),
    ).toBeInTheDocument();
  });

  it("renders an error state when the preview fetch 404s", async () => {
    server.use(http.get(CORRECTIONS_PATH, () => new HttpResponse(null, { status: 404 })));
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );
    // No handler recognises this branch; the typed resource settles to
    // `error`, NOT to a blank panel — the read model's failure is surfaced.
    expect(await screen.findByText(/This view could not load/i)).toBeInTheDocument();
  });

  it("surfaces a typed error state when the preview responds 503", async () => {
    server.use(
      http.get(CORRECTIONS_PATH, ({ request }) => {
        const url = new URL(request.url);
        if (
          url.searchParams.get("localeBranchId") === LOCALE_BRANCH_ID &&
          url.searchParams.get("reviewItemIds") === REVIEW_ITEM_ID
        ) {
          return HttpResponse.json(
            { code: "internal_error", error: "correction preview context unavailable" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 404 });
      }),
    );
    render(
      <CorrectionScopePanel reviewItemId={REVIEW_ITEM_ID} localeBranchId={LOCALE_BRANCH_ID} />,
    );
    expect(await screen.findByText("correction preview context unavailable")).toBeInTheDocument();
  });
});
