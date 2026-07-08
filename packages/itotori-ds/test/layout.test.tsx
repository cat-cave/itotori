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
});
