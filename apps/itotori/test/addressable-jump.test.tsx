// @vitest-environment jsdom
// xs-deep-jumps — unit test for the cross-surface AddressableJump primitive.
//
// Pins the OBSERVABLE behavior of the one link primitive the
// finding -> line -> wiki -> frame chain shares:
//   - a non-empty id renders an <a> whose href is the stable addressable URL
//     for the kind (via hrefForAddressable), stamped with data-jump-kind /
//     data-jump-id;
//   - the scope (projectId / localeBranchId) forwards as query;
//   - a null / empty / whitespace id degrades to a plain <span> with the
//     fallback label — NEVER an <a> with an invented destination.
//   - addressableJumpHref is the pure half (null on empty id).
//
// [[feedback_behavior_first_code_agnostic_testing]] — only the rendered
// href + data attrs per kind/id are asserted; no game is named.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AddressableJump, addressableJumpHref } from "../src/ui/addressable-jump.js";
import { hrefForAddressable } from "../src/ui/addressable-routing.js";

afterEach(cleanup);

describe("addressableJumpHref — pure href resolver", () => {
  it("returns stable URLs for unit / scene / character / runtime frame jumps", () => {
    const cases = [
      ["unit", "bridge-unit-1", "/play/units/bridge-unit-1"],
      ["scene", "scene-1", "/play/scenes/scene-1"],
      ["character", "char-9", "/wiki/characters/char-9"],
      // Runtime frame evidence lands on the run focus route; the addressable
      // scheme has no separate frame kind.
      ["run", "runtime-1", "/runs/runtime-1"],
      ["finding", "runtime-1:finding-1", "/findings/runtime-1%3Afinding-1"],
    ] as const;

    for (const [kind, id, href] of cases) {
      expect(addressableJumpHref(kind, id)).toBe(href);
      expect(addressableJumpHref(kind, id)).toBe(hrefForAddressable({ kind, id }));
    }
  });

  it("forwards the scope (projectId / localeBranchId) as query", () => {
    expect(
      addressableJumpHref("unit", "bridge-unit-1", {
        projectId: "project-1",
        localeBranchId: "branch-1",
        unitId: null,
      }),
    ).toBe("/play/units/bridge-unit-1?projectId=project-1&localeBranchId=branch-1");
  });

  it("forwards nested unit focus for scene jumps", () => {
    expect(
      addressableJumpHref("scene", "scene-1", {
        projectId: "project-1",
        localeBranchId: "branch-1",
        unitId: "bridge-unit-1",
      }),
    ).toBe("/play/scenes/scene-1?projectId=project-1&localeBranchId=branch-1&unit=bridge-unit-1");
  });

  it("returns null for null / empty / whitespace ids (no invented destination)", () => {
    expect(addressableJumpHref("unit", null)).toBeNull();
    expect(addressableJumpHref("unit", "")).toBeNull();
    expect(addressableJumpHref("unit", "   ")).toBeNull();
  });
});

describe("AddressableJump — rendered link behavior", () => {
  it("renders an <a> with the stable href + data-jump-kind / data-jump-id for a non-empty id", () => {
    const { container } = render(
      <AddressableJump kind="unit" id="bridge-unit-1">
        <code>scene.001.line.001</code>
      </AddressableJump>,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/play/units/bridge-unit-1");
    expect(link).toHaveAttribute("data-jump-kind", "unit");
    expect(link).toHaveAttribute("data-jump-id", "bridge-unit-1");
    // The label renders verbatim inside the link.
    expect(link).toHaveTextContent("scene.001.line.001");
  });

  it("renders the id as the default label when no children are passed", () => {
    const { container } = render(<AddressableJump kind="finding" id="finding-7" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/findings/finding-7");
    expect(link).toHaveTextContent("finding-7");
  });

  it("renders scene / character / runtime frame links with data-jump attrs", () => {
    const { container, rerender } = render(
      <AddressableJump kind="scene" id="scene-1" unitId="bridge-unit-1">
        scene one
      </AddressableJump>,
    );
    let link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "/play/scenes/scene-1?unit=bridge-unit-1");
    expect(link).toHaveAttribute("data-jump-kind", "scene");
    expect(link).toHaveAttribute("data-jump-id", "scene-1");

    rerender(<AddressableJump kind="character" id="char-9" />);
    link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "/wiki/characters/char-9");
    expect(link).toHaveAttribute("data-jump-kind", "character");

    rerender(<AddressableJump kind="run" id="runtime-1" />);
    link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "/runs/runtime-1");
    expect(link).toHaveAttribute("data-jump-kind", "run");
  });

  it("degrades to a plain <span> (fallback label) when the id is null / empty", () => {
    const { container, rerender } = render(<AddressableJump kind="unit" id={null} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span")).toHaveTextContent("—");

    rerender(<AddressableJump kind="unit" id="" fallback="no unit" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span")).toHaveTextContent("no unit");
  });

  it("encodes opaque ids (colons) so the deep-link survives the URL", () => {
    const { container } = render(<AddressableJump kind="finding" id="runtime-1:finding-1" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/findings/runtime-1%3Afinding-1");
    expect(link).toHaveAttribute("data-jump-id", "runtime-1:finding-1");
  });
});
