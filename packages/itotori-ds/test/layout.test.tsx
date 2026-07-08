import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "../src/components/layout/Panel.js";

describe("layout / Panel", () => {
  it("renders its title in a heading and its children in the body", () => {
    render(
      <Panel title="Localization progress" eyebrow="overview">
        <p>body content</p>
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "Localization progress" })).toBeInTheDocument();
    expect(screen.getByText("overview")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders the lamps slot", () => {
    render(<Panel title="Cost" lamps={<span>running</span>} />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("applies the hover-lift affordance when hoverable", () => {
    const { container } = render(<Panel title="Link" hoverable />);
    expect(container.querySelector(".itotori-panel")).toHaveClass("itotori-lift");
  });

  it("forwards data-* attributes to its root DOM element", () => {
    // The pane container passes `data-pane-id` / `data-pane-state` /
    // `data-review-item-id` to <Panel> so the structured markers are
    // observable on the DOM (selectors / a11y tree / debugging). Without
    // the passthrough these attributes would silently disappear.
    const { container } = render(
      <Panel
        title="Revision history"
        data-pane-id="rev-history-comparison"
        data-pane-state="loading"
        data-review-item-id="review-item-123"
        data-testid="panel-root"
      />,
    );
    const root = container.querySelector(".itotori-panel");
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("data-pane-id", "rev-history-comparison");
    expect(root).toHaveAttribute("data-pane-state", "loading");
    expect(root).toHaveAttribute("data-review-item-id", "review-item-123");
    expect(root).toHaveAttribute("data-testid", "panel-root");
  });
});
