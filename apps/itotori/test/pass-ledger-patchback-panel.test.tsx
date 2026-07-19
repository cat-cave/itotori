// @vitest-environment jsdom
//
// Behavior test: the PassLedgerPanel patchback control invokes
// `projects.patchback` and surfaces the download link on success.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchbackAction } from "../src/ui/screens/PassLedgerPanel.js";

const requestMock = vi.fn();

vi.mock("../src/ui/client.js", () => ({
  apiClient: {
    request: (...args: unknown[]) => requestMock(...args),
  },
}));

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("PassLedgerPanel PatchbackAction", () => {
  it("denies the control when canSteer is false", () => {
    render(<PatchbackAction canSteer={false} steerDenial="draft.write required" />);
    const button = screen.getByRole("button", { name: /Build patched game/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("draft.write required");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("invokes projects.patchback and surfaces the download link", async () => {
    requestMock.mockResolvedValue({
      state: "ready",
      data: {
        schemaVersion: "itotori.projects.patchback.v1",
        patchBuildId: "build-abc",
        scope: "dialogue+choices",
        command:
          "kaifuu-cli patch --engine reallive --source /g --target /t --bundle /b --scope dialogue+choices --force",
        downloadUrl: "/api/projects/patchback/build-abc/archive",
        artifactHashes: { seenTxt: "sha256:deadbeef" },
      },
    });

    render(<PatchbackAction canSteer />);
    fireEvent.change(screen.getByPlaceholderText("/path/to/game"), {
      target: { value: "/games/sweetie" },
    });
    fireEvent.change(screen.getByPlaceholderText("/path/to/translated-bridge.json"), {
      target: { value: "/tmp/translated.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build patched game/i }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("projects.patchback", {
        body: {
          gameRoot: "/games/sweetie",
          translatedBundlePath: "/tmp/translated.json",
          scope: "dialogue+choices",
          force: true,
        },
      });
    });

    const download = await screen.findByRole("link", { name: /Download patched game/i });
    expect(download).toHaveAttribute("href", "/api/projects/patchback/build-abc/archive");
    expect(download).toHaveAttribute("data-action", "download-patched-build");
    expect(screen.getByRole("status")).toHaveAttribute("data-patchback", "ready");
    expect(screen.getByText("build-abc")).toBeTruthy();
  });

  it("surfaces an API error without inventing a download", async () => {
    requestMock.mockResolvedValue({
      state: "error",
      error: { code: "forbidden", message: "draft.write required", status: 403 },
    });

    render(<PatchbackAction canSteer />);
    fireEvent.change(screen.getByPlaceholderText("/path/to/game"), {
      target: { value: "/g" },
    });
    fireEvent.change(screen.getByPlaceholderText("/path/to/translated-bridge.json"), {
      target: { value: "/b" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Build patched game/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveAttribute("data-patchback", "error");
    });
    expect(screen.queryByRole("link", { name: /Download patched game/i })).toBeNull();
  });
});
