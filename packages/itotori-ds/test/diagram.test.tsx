// @vitest-environment jsdom
// RouteMap diagram component — paints col/row/state/coverage/issues nodes
// and choice edges. Behaviour-first: rendered DOM + selection, not internals.

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RouteMap, type RouteMapNode } from "../src/components/diagram/RouteMap.js";

const nodes: RouteMapNode[] = [
  {
    id: "r1",
    label: "Root",
    col: 0,
    row: 0,
    state: "fresh",
    coverage: "fresh",
    issues: 0,
  },
  {
    id: "r2",
    label: "Branch",
    col: 1,
    row: 0,
    state: "stale",
    coverage: "stale",
    issues: 2,
  },
];

describe("diagram / RouteMap", () => {
  it("renders nodes with coverage badges and choice edges", () => {
    render(
      <RouteMap nodes={nodes} edges={[{ key: "e1", fromId: "r1", toId: "r2", label: "Choose" }]} />,
    );
    const map = document.querySelector('[data-component="route-map"]');
    expect(map?.getAttribute("data-node-count")).toBe("2");
    expect(map?.getAttribute("data-edge-count")).toBe("1");
    expect(document.querySelector('[data-route-id="r1"]')?.getAttribute("data-coverage")).toBe(
      "fresh",
    );
    expect(document.querySelector('[data-route-id="r2"]')?.getAttribute("data-issues")).toBe("2");
    expect(screen.getByText("2 issues")).toBeInTheDocument();
    expect(document.querySelector('[data-from="r1"][data-to="r2"]')?.textContent).toMatch(/Choose/);
  });

  it("invokes onSelect when a node is clicked", async () => {
    const onSelect = vi.fn();
    render(<RouteMap nodes={nodes} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("Branch"));
    expect(onSelect).toHaveBeenCalledWith("r2");
  });

  it("renders the empty label when there are no nodes", () => {
    render(<RouteMap nodes={[]} emptyLabel="Nothing mapped." />);
    expect(screen.getByText("Nothing mapped.")).toBeInTheDocument();
    expect(document.querySelector('[data-component="route-map"]')?.getAttribute("data-empty")).toBe(
      "true",
    );
  });
});
