// @vitest-environment jsdom
// play-flag-composer — behavior-first test for AnnotationComposer → context correction.
//
// Mounts the REAL `PlayFlagComposerScreen` over msw-intercepted
// `play.flagAnnotation` (+ optional auth.capabilities) and asserts:
//
//   1. a canFlag user composes a severity-scaled annotation and POSTs
//      play.flagAnnotation; the success surface reports correction scheduling;
//   2. a denied canFlag actor sees a disabled + explained composer (no POST);
//   3. a write error surfaces as a visible alert (never silent success).
//
// [[feedback_behavior_first_code_agnostic_testing]] — no game is named; only
// the rendered composer, the API POST, and outcome surfaces are asserted.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiPlayFlagAnnotationResponse } from "../src/api-schema.js";
import {
  CapsProvider,
  deniedStudioCapabilityView,
  grantedStudioCapabilityView,
} from "../src/ui/caps-context.js";
import { PlayFlagComposerScreen } from "../src/ui/screens/PlayFlagComposerScreen.js";
import { ToastProvider } from "../src/ui/toast-host.js";
import { apiJson } from "./msw-handlers.js";

function typeInto(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

const FLAG_PATH = "*/api/projects/:projectId/locale-branches/:localeBranchId/flags";

function flagResponse(
  overrides: Partial<ApiPlayFlagAnnotationResponse> = {},
): ApiPlayFlagAnnotationResponse {
  return {
    schemaVersion: "itotori.play.flag-annotation.v0",
    projectId: "project-1",
    localeBranchId: "locale-1",
    feedbackReportId: "feedback-report-1",
    feedbackEvidenceId: "feedback-evidence-1",
    severity: "critical",
    category: "tone",
    note: "Line overflows the textbox.",
    triageLabel: "style_dispute_candidate",
    contextStatus: "contextualized",
    contextCorrectionEnqueued: true,
    duplicate: false,
    ...overrides,
  };
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function renderComposer(caps = grantedStudioCapabilityView("playtester")) {
  return render(
    <ToastProvider>
      <CapsProvider value={caps}>
        <PlayFlagComposerScreen
          route={{
            projectId: "project-1",
            localeBranchId: "locale-1",
            bridgeUnitId: "bridge-unit-1",
            sceneId: "scene-a",
            targetLocale: "en-US",
            sourceUnitKey: "unit.key.1",
          }}
        />
      </CapsProvider>
    </ToastProvider>,
  );
}

describe("play-flag-composer — PlayFlagComposerScreen", () => {
  it("canFlag user composes a severity-scaled annotation that POSTs flagAnnotation", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post(FLAG_PATH, async ({ request }) => {
        const body = await request.json();
        posts.push(body);
        return apiJson(
          "play.flagAnnotation",
          flagResponse({
            severity: (body as { severity: ApiPlayFlagAnnotationResponse["severity"] }).severity,
            category: (body as { category?: string }).category ?? "",
            note: (body as { note: string }).note,
          }),
        );
      }),
    );

    renderComposer();

    expect(document.querySelector('[data-screen="play-flag"]')?.getAttribute("data-can-flag")).toBe(
      "true",
    );
    const composer = document.querySelector('[data-component="annotation-composer"]');
    expect(composer).not.toBeNull();

    // Scale severity: pick critical chip.
    fireEvent.click(screen.getByRole("radio", { name: "critical" }));
    typeInto(screen.getByPlaceholderText(/What's wrong/i), "Line overflows the textbox.");
    typeInto(screen.getByPlaceholderText(/tone · layout/i), "tone");
    fireEvent.click(screen.getByRole("button", { name: /Send correction/i }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toMatchObject({
      note: "Line overflows the textbox.",
      severity: "critical",
      category: "tone",
      targetLocale: "en-US",
      bridgeUnitId: "bridge-unit-1",
      sceneId: "scene-a",
    });

    await waitFor(() => {
      expect(document.querySelector('[data-flag-outcome="ok"]')).not.toBeNull();
    });
    const status = document.querySelector('[data-flag-outcome="ok"]');
    expect(status?.getAttribute("data-context-correction-enqueued")).toBe("true");
    expect(status?.getAttribute("data-severity")).toBe("critical");
    expect(status?.textContent).toMatch(/Flag sent to correction · critical · tone/i);
  });

  it("denies composition when the actor lacks canFlag (no POST)", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post(FLAG_PATH, async ({ request }) => {
        posts.push(await request.json());
        return apiJson("play.flagAnnotation", flagResponse());
      }),
    );

    renderComposer(
      deniedStudioCapabilityView("anon", "user anon is missing permission feedback.import"),
    );

    expect(document.querySelector('[data-screen="play-flag"]')?.getAttribute("data-can-flag")).toBe(
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/feedback\.import/i);
    const submit = screen.getByRole("button", { name: /Send correction/i });
    expect(submit).toBeDisabled();
    // Attempting to type + click does not fire the network.
    typeInto(screen.getByPlaceholderText(/What's wrong/i), "should not post");
    fireEvent.click(submit);
    expect(posts).toHaveLength(0);
  });

  it("surfaces a write error as a visible alert (never silent success)", async () => {
    server.use(
      http.post(
        FLAG_PATH,
        () =>
          new Response(JSON.stringify({ code: "forbidden", error: "missing feedback.import" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    renderComposer();
    typeInto(screen.getByPlaceholderText(/What's wrong/i), "Broken line.");
    fireEvent.click(screen.getByRole("button", { name: /Send correction/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/forbidden|feedback\.import/i);
    expect(screen.queryByText(/Flag sent to correction/i)).not.toBeInTheDocument();
  });
});
