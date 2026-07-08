import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Gallery } from "../src/gallery/Gallery.js";

// The gallery is both the visual reference AND a behaviour-test surface: if it
// mounts and every component group renders, the DS composes. This is the smoke
// test downstream screen nodes should mirror (mount the real screen, assert the
// key surfaces are present + one cross-component interaction works).
describe("component gallery", () => {
  it("renders a section for every component group", () => {
    render(<Gallery />);
    for (const id of ["core", "layout", "data", "localization", "navigation", "feedback"]) {
      expect(document.querySelector(`[data-section="${id}"]`)).toBeInTheDocument();
    }
  });

  it("renders the wordmark and headline metric", () => {
    render(<Gallery />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("component gallery");
    // LocalizationProgress proven headline: 18240 / 27407 ≈ 66.6%
    expect(screen.getByText("66.6%")).toBeInTheDocument();
  });

  it("opens the command palette from the gallery and jumps to a target", async () => {
    render(<Gallery />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open command palette/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "festival");
    await userEvent.click(screen.getByRole("button", { name: /the festival/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("scene-12")).toBeInTheDocument();
  });
});
