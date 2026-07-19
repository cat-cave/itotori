// @vitest-environment jsdom
//
// Behavior for the Studio "Produce patched build" control. It drives the real
// `ProducePatchedBuildAction` component against a mocked `/api/patchback/produce`
// boundary and pins three states a reviewer actually sees:
//   - success: the produced tar downloads and a status names the file;
//   - a failed produce is surfaced as an error alert;
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

function failedProduceResponse(): Response {
  return {
    ok: false,
    status: 500,
    json: async () => ({ code: "internal_error", error: "patchback produce failed" }),
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

  it("shows an error when produce fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failedProduceResponse()),
    );

    render(
      <ProducePatchedBuildAction canSteer projectId="project-1" localeBranchId="locale-branch-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Produce patched build" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/patchback produce failed/u);
    expect(alert).toHaveAttribute("data-produce-build", "error");
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
