// @vitest-environment jsdom
//
// Behavior for the Studio "Produce patched build" control. It drives the real
// `ProducePatchedBuildAction` component against a mocked `/api/patchback/produce`
// boundary and pins three states a reviewer actually sees:
//   - success: the produced tar downloads and a status names the file;
//   - not-configured (501): an honest "not available yet" note, distinct from a
//     real error alert (no crash) — the partial-completion state;
//   - permission-denied: the button is disabled with a clear reason.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ProducePatchedBuildAction } from "../src/ui/screens/PassLedgerPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubObjectUrl(): void {
  // jsdom does not implement these; the download helper calls them.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:x"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
}

function tarResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["REALLIVEDATA-tar-bytes"], { type: "application/x-tar" }),
    headers: {
      get: (key: string) =>
        key.toLowerCase() === "content-disposition"
          ? 'attachment; filename="produced-build.tar"'
          : null,
    },
  } as unknown as Response;
}

function notConfiguredResponse(): Response {
  return {
    ok: false,
    status: 501,
    json: async () => ({ code: "internal_error", error: "patchback produce is not configured" }),
  } as unknown as Response;
}

describe("ProducePatchedBuildAction", () => {
  it("downloads the produced build and names the file on success", async () => {
    stubObjectUrl();
    const fetchMock = vi.fn(async () => tarResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProducePatchedBuildAction canSteer projectId="project-1" localeBranchId="locale-branch-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Produce patched build" }));

    expect(await screen.findByText(/Downloaded produced-build\.tar/u)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/patchback/produce",
      expect.objectContaining({ method: "POST" }),
    );
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    // A success is not surfaced as an error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an honest 'not available yet' note (not an error) when the produce path returns 501", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => notConfiguredResponse()),
    );

    render(
      <ProducePatchedBuildAction canSteer projectId="project-1" localeBranchId="locale-branch-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Produce patched build" }));

    const note = await screen.findByText(/isn't available yet for this run/u);
    expect(note).toBeInTheDocument();
    // It is a status note, NOT an error alert the user should report/retry.
    expect(note).toHaveAttribute("data-produce-build", "unavailable");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the control with a reason when the user lacks steer permission", () => {
    render(
      <ProducePatchedBuildAction
        canSteer={false}
        projectId="project-1"
        localeBranchId="locale-branch-1"
        steerDenial="draft.write permission required"
      />,
    );
    const button = screen.getByRole("button", { name: "Produce patched build" });
    expect(button).toBeDisabled();
    expect(screen.getByText("draft.write permission required")).toBeInTheDocument();
  });
});
