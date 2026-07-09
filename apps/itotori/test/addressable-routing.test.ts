// @vitest-environment node
// fnd-addressable-routing — behavior-first tests for the stable URL scheme.
//
// Pins: every addressable kind has a stable href; parse round-trips; compact
// refs (incl. bridge-unit: alias) resolve; SPA path classifier covers deep
// links the HTTP server must serve. No game is named.

import { describe, expect, it } from "vitest";
import {
  ADDRESSABLE_KINDS,
  addressableFocusToken,
  addressablePathname,
  formatAddressableRef,
  hrefForAddressable,
  hrefForAddressableRef,
  isAddressableSpaPath,
  parseAddressableLocation,
  parseAddressableRef,
  type AddressableKind,
} from "../src/ui/addressable-routing.js";

const SAMPLE_IDS: Readonly<Record<AddressableKind, string>> = {
  unit: "bridge-unit:scene-a-line-001",
  scene: "scene.opening.gate",
  route: "route.true-end",
  character: "char.heroine",
  term: "term.honorific-san",
  run: "runtime-run-42",
  finding: "finding.layout-overflow-7",
};

describe("addressable-id routing scheme", () => {
  it("gives every addressable kind a stable URL that round-trips through parse", () => {
    for (const kind of ADDRESSABLE_KINDS) {
      const id = SAMPLE_IDS[kind];
      const href = hrefForAddressable({
        kind,
        id,
        projectId: "project-1",
        localeBranchId: "locale-1",
      });
      expect(href.startsWith("/")).toBe(true);
      expect(href).toContain(encodeURIComponent(id));

      const q = href.indexOf("?");
      const pathname = q === -1 ? href : href.slice(0, q);
      const search = q === -1 ? "" : href.slice(q);
      const parsed = parseAddressableLocation(pathname, search);
      expect(parsed, `kind ${kind} must parse`).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.id).toBe(id);
      expect(parsed?.projectId).toBe("project-1");
      expect(parsed?.localeBranchId).toBe("locale-1");
      expect(parsed?.focus.kind === kind || parsed?.focus.kind === "unit").toBe(true);
      expect(addressableFocusToken(parsed!.focus).length).toBeGreaterThan(0);
    }
  });

  it("focuses a nested unit on a scene deep-link via ?unit=", () => {
    const href = hrefForAddressable({
      kind: "scene",
      id: "scene.rooftop",
      unitId: "bridge-unit:rooftop-line",
      projectId: "p1",
      localeBranchId: "lb1",
    });
    expect(href).toContain("/play/scenes/");
    expect(href).toContain("unit=");

    const q = href.indexOf("?");
    const parsed = parseAddressableLocation(href.slice(0, q), href.slice(q));
    expect(parsed).toMatchObject({
      kind: "scene",
      id: "scene.rooftop",
      unitId: "bridge-unit:rooftop-line",
      focus: { kind: "unit", id: "bridge-unit:rooftop-line" },
      surface: "play",
    });
  });

  it("parses compact refs including the bridge-unit alias", () => {
    expect(parseAddressableRef("unit:u-1")).toEqual({ kind: "unit", id: "u-1" });
    expect(parseAddressableRef("scene:s-1")).toEqual({ kind: "scene", id: "s-1" });
    expect(parseAddressableRef("character:c-1")).toEqual({ kind: "character", id: "c-1" });
    expect(parseAddressableRef("term:t-1")).toEqual({ kind: "term", id: "t-1" });
    expect(parseAddressableRef("route:r-1")).toEqual({ kind: "route", id: "r-1" });
    expect(parseAddressableRef("run:run-1")).toEqual({ kind: "run", id: "run-1" });
    expect(parseAddressableRef("finding:f-1")).toEqual({ kind: "finding", id: "f-1" });

    // Mockup vocabulary: the whole "bridge-unit:…" token is the unit id.
    expect(parseAddressableRef("bridge-unit:scene-line")).toEqual({
      kind: "unit",
      id: "bridge-unit:scene-line",
    });

    expect(parseAddressableRef("")).toBeNull();
    expect(parseAddressableRef("not-a-ref")).toBeNull();
    expect(parseAddressableRef("unknown:x")).toBeNull();
  });

  it("builds hrefs from compact refs for cmdk jumps", () => {
    expect(hrefForAddressableRef("character:heroine")).toBe("/wiki/characters/heroine");
    expect(hrefForAddressableRef("run:run-9")).toBe("/runs/run-9");
    expect(hrefForAddressableRef("finding:f-2")).toBe("/findings/f-2");
    expect(hrefForAddressableRef("unit:u-1", { projectId: "p", localeBranchId: "lb" })).toBe(
      "/play/units/u-1?projectId=p&localeBranchId=lb",
    );
    expect(hrefForAddressableRef("nope")).toBeNull();
  });

  it("formats compact refs that parse back", () => {
    for (const kind of ADDRESSABLE_KINDS) {
      const id = SAMPLE_IDS[kind];
      const ref = formatAddressableRef({ kind, id });
      expect(parseAddressableRef(ref)).toEqual({ kind, id });
    }
  });

  it("classifies SPA paths the server must fall back to index.html for", () => {
    expect(isAddressableSpaPath("/play")).toBe(true);
    expect(isAddressableSpaPath("/play/units/u-1")).toBe(true);
    expect(isAddressableSpaPath("/play/scenes/s-1")).toBe(true);
    expect(isAddressableSpaPath("/wiki/characters/c-1")).toBe(true);
    expect(isAddressableSpaPath("/wiki/terms/t-1")).toBe(true);
    expect(isAddressableSpaPath("/runs/run-1")).toBe(true);
    expect(isAddressableSpaPath("/findings/f-1")).toBe(true);
    expect(isAddressableSpaPath("/benchmark")).toBe(true);
    // Not addressable entity paths (still may be SPA via other matchers).
    expect(isAddressableSpaPath("/reviewer-queue")).toBe(false);
    expect(isAddressableSpaPath("/workspace")).toBe(false);
  });

  it("does not treat surface roots without an entity id as entity deep-links", () => {
    expect(parseAddressableLocation("/play", "")).toBeNull();
    expect(parseAddressableLocation("/wiki", "")).toBeNull();
    expect(parseAddressableLocation("/runs", "")).toBeNull();
    expect(parseAddressableLocation("/findings", "")).toBeNull();
    expect(parseAddressableLocation("/play/units/", "")).toBeNull();
  });

  it("keeps pathname pure for opaque ids with reserved characters", () => {
    const id = "bridge-unit:a/b?c#d";
    const path = addressablePathname({ kind: "unit", id });
    expect(path).toBe(`/play/units/${encodeURIComponent(id)}`);
    const parsed = parseAddressableLocation(path, "");
    expect(parsed?.id).toBe(id);
  });
});
