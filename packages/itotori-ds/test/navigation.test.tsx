import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/navigation/CommandPalette.js";
import { NavPills } from "../src/components/navigation/NavPills.js";
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
