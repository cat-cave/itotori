// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VirtualList } from "../src/ui/virtual-list.js";

describe("VirtualList", () => {
  it("includes row gaps in spacer height and scroll pitch", () => {
    const rows = Array.from({ length: 12 }, (_, index) => `row-${index}`);
    render(
      <VirtualList
        ariaLabel="Measured rows"
        items={rows}
        getItemKey={(row) => row}
        itemHeight={40}
        rowGap={12}
        overscan={0}
        viewportHeight={100}
        renderItem={(row) => <span>{row}</span>}
      />,
    );

    const list = screen.getByLabelText("Measured rows");
    expect(list).toHaveAttribute("data-row-gap", "12");
    expect(list).toHaveAttribute("data-row-pitch", "52");
    expect(list).toHaveAttribute("data-rendered-items", "2");
    expect(list.querySelector(".itotori-virtual-list__spacer")).toHaveStyle({
      height: "612px",
    });

    fireEvent.scroll(list, { target: { scrollTop: 104 } });

    expect(list.querySelector(".itotori-virtual-list__window")).toHaveStyle({
      transform: "translateY(104px)",
    });
    expect(within(list).getByText("row-2")).toBeInTheDocument();
    expect(within(list).queryByText("row-0")).not.toBeInTheDocument();
  });
});
