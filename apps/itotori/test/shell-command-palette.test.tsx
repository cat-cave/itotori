// @vitest-environment jsdom
// shell-cmdk-palette (HI-FI STUDIO EPIC · Shell) — behavior-first test for the
// ⌘K command palette host.
//
// Asserts the OBSERVABLE behavior a viewer sees, per the acceptance:
//   1. the palette trigger is discoverable in the shell toolbar;
//   2. ⌘K / Ctrl+K (or the trigger) opens the palette;
//   3. the index renders (shell surfaces today) and filters as you type;
//   4. Arrow + Enter selects an entry and NAVIGATES to its href through the
//      same `navigate` the shell nav uses;
//   5. Esc closes the palette;
//   6. the `entries` seam carries custom entries (the shape the future
//      unified index `shell-cmdk-index-api` + `fnd-addressable-routing` will
//      feed), so entity / action jumps route to their own hrefs.
//
// The palette DIALOG itself (filter / arrow / enter / esc semantics) is
// covered by the ds navigation test; this suite covers the SHELL host:
// open state, the index seam, and routing a selection to a URL. No game is
// named; only the rendered palette states + the navigate call are asserted.
//
// Uses `fireEvent` (the app test convention — @testing-library/user-event is
// not an app dependency; the ds navigation test exercises the ds internals).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http } from "msw";
import { setupServer } from "msw/node";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RedactionGovernor } from "../src/ui/redaction-governor.js";
import {
  ShellCommandPalette,
  shellNavCommandEntries,
  mergeCommandEntries,
  type PaletteEntry,
} from "../src/ui/command-palette.js";
import { ShellFrame, SHELL_NAV_ITEMS } from "../src/ui/shell-frame.js";
import { apiJson } from "./msw-handlers.js";
import { costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";

const server = setupServer(
  http.get("*/api/projects/status", () => apiJson("projects.status", dashboardStatusFixture)),
  http.get("*/api/projects/cost", () => apiJson("projects.cost", costReportFixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

/** Type into the palette input (fireEvent change). */
function typeInto(input: HTMLElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
}

describe("shell-cmdk-palette — index seam (pure builders)", () => {
  it("shellNavCommandEntries mirrors the shell nav surfaces as jump actions", () => {
    const entries = shellNavCommandEntries();
    expect(entries).toHaveLength(SHELL_NAV_ITEMS.length);
    for (let i = 0; i < SHELL_NAV_ITEMS.length; i += 1) {
      const nav = SHELL_NAV_ITEMS[i]!;
      const entry = entries[i]!;
      expect(entry.id).toBe(`surface:${nav.id}`);
      expect(entry.label).toBe(nav.label);
      expect(entry.href).toBe(nav.href);
      expect(entry.group).toBe("surfaces");
      expect(entry.keywords).toContain(nav.id);
    }
  });

  it("mergeCommandEntries concatenates sources in caller-controlled order", () => {
    const surfaces = shellNavCommandEntries();
    const entities: PaletteEntry[] = [
      { id: "scene:07", label: "Scene 07 — rooftop", group: "scenes", href: "/play?scene=07" },
      { id: "char:aoi", label: "Aoi", group: "characters", href: "/wiki/char/aoi" },
    ];
    const merged = mergeCommandEntries(surfaces, entities);
    expect(merged).toHaveLength(surfaces.length + entities.length);
    // Surfaces keep precedence (first), entities follow — stable order.
    expect(merged[surfaces.length]!.id).toBe("scene:07");
    expect(merged[merged.length - 1]!.id).toBe("char:aoi");
  });
});

describe("shell-cmdk-palette — host behavior", () => {
  it("renders a discoverable trigger that is not expanded when closed", () => {
    render(<ShellCommandPalette navigate={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Open command palette" });
    expect(trigger).toHaveAttribute("data-command-trigger", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+k Meta+k");
    // The palette dialog is not in the document until opened.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the palette from the trigger and exposes the surface index", () => {
    render(<ShellCommandPalette navigate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeInTheDocument();
    // The trigger now reports expanded.
    expect(screen.getByRole("button", { name: "Open command palette" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Every shell surface is offered as a jump target (one option per nav
    // item; the option text includes the "surfaces" group heading + label).
    const options = within(dialog).getAllByRole("option");
    expect(options).toHaveLength(SHELL_NAV_ITEMS.length);
    for (const item of SHELL_NAV_ITEMS) {
      expect(within(dialog).getByText(item.label)).toBeInTheDocument();
    }
    expect(within(dialog).getAllByText("surfaces").length).toBe(SHELL_NAV_ITEMS.length);
  });

  it("opens on ⌘K (meta+k) and on Ctrl+K", () => {
    render(<ShellCommandPalette navigate={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    // Close and try the Ctrl form.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("filters the index as the query is typed", () => {
    render(<ShellCommandPalette navigate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    typeInto(screen.getByRole("textbox"), "benchmark");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Benchmark");
  });

  it("navigates to the selected entry href via the shell navigate handler", () => {
    const navigate = vi.fn();
    render(<ShellCommandPalette navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    // Narrow to one surface, arrow to confirm focus, enter to choose it.
    const input = screen.getByRole("textbox");
    typeInto(input, "review");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/reviewer-queue");
  });

  it("closes on Escape without navigating", () => {
    const navigate = vi.fn();
    render(<ShellCommandPalette navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes custom entries (the future unified-index seam) to their own hrefs", () => {
    // Simulate the shape `shell-cmdk-index-api` + `fnd-addressable-routing`
    // will feed once they land: entity / action entries with stable hrefs.
    const entries: PaletteEntry[] = [
      {
        id: "scene:07",
        label: "Scene 07 — rooftop",
        group: "scenes",
        href: "/play?scene=07",
        keywords: ["rooftop"],
      },
      {
        id: "char:aoi",
        label: "Aoi",
        group: "characters",
        href: "/wiki/char/aoi",
      },
      {
        id: "act:launch",
        label: "Launch next pass",
        group: "actions",
        href: "/actions/launch-pass",
      },
    ];
    const navigate = vi.fn();
    render(<ShellCommandPalette navigate={navigate} entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const input = screen.getByRole("textbox");
    typeInto(input, "aoi");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/wiki/char/aoi");
  });
});

describe("shell-cmdk-palette — shell-frame wiring", () => {
  // Mounts the REAL ShellFrame (the unit App renders) so the palette is
  // exercised in its real mount context: the trigger lives in the toolbar
  // and shares the frame's `navigate`.
  it("mounts the palette trigger in the shell toolbar and routes through the frame navigate", () => {
    const navigate = vi.fn();
    render(
      <RedactionGovernor>
        <ShellFrame location={{ pathname: "/", search: "" }} navigate={navigate}>
          <div data-screen-stub />
        </ShellFrame>
      </RedactionGovernor>,
    );
    // The status bar still renders (the palette host does not disturb it).
    expect(screen.getByRole("status", { name: "Shell status bar" })).toBeInTheDocument();
    // The trigger exists in the frame toolbar.
    const trigger = screen.getByRole("button", { name: "Open command palette" });
    expect(trigger.closest('[data-shell-toolbar="true"]')).not.toBeNull();
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox");
    typeInto(input, "play");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/play");
  });
});
