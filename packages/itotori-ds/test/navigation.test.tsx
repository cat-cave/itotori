import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/navigation/CommandPalette.js";
import { NavPills } from "../src/components/navigation/NavPills.js";
import { Pagination } from "../src/components/navigation/Pagination.js";
import type { CommandItem } from "../src/components/navigation/CommandPalette.js";

const items: CommandItem[] = [
  { id: "scene-07", label: "Scene 07 — rooftop", group: "scenes" },
  { id: "char-aoi", label: "Aoi", group: "characters", keywords: ["lead"] },
  { id: "act-launch", label: "Launch next pass", group: "actions" },
];

describe("navigation / NavPills", () => {
  it("marks the active pill and reports selection", async () => {
    const onSelect = vi.fn();
    render(
      <NavPills
        label="surfaces"
        activeId="overview"
        onSelect={onSelect}
        items={[
          { id: "overview", label: "Overview" },
          { id: "review", label: "Review", badge: 12 },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Review/ })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: /Review/ }));
    expect(onSelect).toHaveBeenCalledWith("review");
  });
});

describe("navigation / CommandPalette", () => {
  it("does not render when closed", () => {
    render(<CommandPalette open={false} onClose={() => {}} items={items} onSelect={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("filters items as the query is typed", async () => {
    render(<CommandPalette open onClose={() => {}} items={items} onSelect={() => {}} />);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.type(screen.getByRole("textbox"), "aoi");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Aoi");
  });

  it("selects the active item with the keyboard (arrow + enter)", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} items={items} onSelect={onSelect} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} items={items} onSelect={() => {}} />);
    await userEvent.type(screen.getByRole("textbox"), "{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("navigation / Pagination", () => {
  it("renders page-of-N status and reachable prev/next buttons on a middle page", () => {
    render(
      <Pagination
        label="Reviewer queue pagination"
        page={1}
        pageCount={3}
        totalItems={42}
        onPrevious={() => {}}
        onNext={() => {}}
      />,
    );
    expect(
      screen.getByRole("navigation", { name: "Reviewer queue pagination" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3 · 42 items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("disables Previous at the start and Next at the end", () => {
    const { rerender } = render(
      <Pagination
        label="Reviewer queue pagination"
        page={0}
        pageCount={3}
        totalItems={20}
        onPrevious={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(screen.getByText("Page 1 of 3 · 20 items")).toBeInTheDocument();

    rerender(
      <Pagination
        label="Reviewer queue pagination"
        page={2}
        pageCount={3}
        totalItems={20}
        onPrevious={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByText("Page 3 of 3 · 20 items")).toBeInTheDocument();
  });

  it("emits onPrevious / onNext when the buttons are activated", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <Pagination
        label="Reviewer queue pagination"
        page={1}
        pageCount={3}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("renders the bare page-of-N form when no total is supplied (OffsetPager alignment)", () => {
    render(
      <Pagination
        label="Cost drilldown pagination"
        page={0}
        pageCount={5}
        onPrevious={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    expect(screen.queryByText(/items/u)).not.toBeInTheDocument();
  });
});
