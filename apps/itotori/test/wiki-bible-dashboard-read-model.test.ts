// The pure read-model of the Wiki bible dashboard: route-scope visibility is the
// enforcement key of the whole surface, so it is proven directly here. An
// out-of-route claim is HIDDEN when its route is not active; readiness and route
// facets are deterministic functions of the resolved views.

import { describe, expect, it } from "vitest";
import {
  buildRouteFacets,
  computeReadiness,
  isClaimVisibleUnderRoute,
  partitionViews,
  routeScopeRouteIds,
  visibleClaims,
  type WikiClaimView,
  type WikiRenderingView,
  type WikiSourceObjectView,
} from "../src/wiki/dashboard/read-model.js";

function claim(id: string, scope: WikiClaimView["scope"]): WikiClaimView {
  return {
    claimId: id,
    statement: `statement ${id}`,
    scope,
    kind: "beat",
    confidence: "high",
    supersedesClaimId: null,
    citations: [],
  };
}

function sourceView(
  objectId: string,
  claims: WikiClaimView[],
  badges: Partial<WikiSourceObjectView["badges"]> = {},
): WikiSourceObjectView {
  return {
    kind: "source",
    objectId,
    wikiKind: "source-object",
    category: "scene-summary",
    version: 1,
    lang: "ja",
    subject: { kind: "scene", id: objectId },
    routeScope: { kind: "global" },
    badges: {
      provisional: false,
      contextScope: "whole-game",
      runMode: "production",
      editedBy: null,
      ...badges,
    },
    claims,
    citations: [],
    media: [],
  };
}

function rendering(sourceObjectId: string, provisional = false): WikiRenderingView {
  return {
    kind: "rendering",
    renderingId: `${sourceObjectId}-en`,
    sourceObjectId,
    category: "scene-summary",
    version: 1,
    targetLanguage: "en",
    routeScope: { kind: "global" },
    badges: { provisional, contextScope: null, runMode: "production", editedBy: null },
    claimRenderings: [],
  };
}

describe("route-scope visibility enforcement", () => {
  it("shows global claims under every toggle and hides a route claim off its route", () => {
    const global = { kind: "global" } as const;
    const akari = { kind: "route", routeId: "route-akari" } as const;
    const yuki = { kind: "route", routeId: "route-yuki" } as const;

    expect(isClaimVisibleUnderRoute(global, null)).toBe(true);
    expect(isClaimVisibleUnderRoute(global, "route-akari")).toBe(true);
    // Canonical-only view: a route claim is hidden.
    expect(isClaimVisibleUnderRoute(akari, null)).toBe(false);
    // A route claim is visible ONLY under its own route.
    expect(isClaimVisibleUnderRoute(akari, "route-akari")).toBe(true);
    expect(isClaimVisibleUnderRoute(akari, "route-yuki")).toBe(false);
    expect(isClaimVisibleUnderRoute(yuki, "route-akari")).toBe(false);
  });

  it("supports route-set membership", () => {
    const set = { kind: "route-set", routeIds: ["route-a", "route-b"] } as const;
    expect(routeScopeRouteIds(set)).toEqual(["route-a", "route-b"]);
    expect(isClaimVisibleUnderRoute(set, "route-b")).toBe(true);
    expect(isClaimVisibleUnderRoute(set, "route-c")).toBe(false);
  });

  it("visibleClaims never returns an out-of-route claim under the wrong toggle", () => {
    const claims = [
      claim("c-global", { kind: "global" }),
      claim("c-akari", { kind: "route", routeId: "route-akari" }),
      claim("c-yuki", { kind: "route", routeId: "route-yuki" }),
    ];
    expect(visibleClaims(claims, null).map((c) => c.claimId)).toEqual(["c-global"]);
    expect(visibleClaims(claims, "route-akari").map((c) => c.claimId)).toEqual([
      "c-global",
      "c-akari",
    ]);
    expect(visibleClaims(claims, "route-akari").some((c) => c.claimId === "c-yuki")).toBe(false);
  });
});

describe("route facets + readiness", () => {
  it("counts distinct routes referenced by claims, sorted by route id", () => {
    const objects = [
      sourceView("obj-1", [
        claim("c1", { kind: "global" }),
        claim("c2", { kind: "route", routeId: "route-yuki" }),
        claim("c3", { kind: "route-set", routeIds: ["route-akari", "route-yuki"] }),
      ]),
    ];
    expect(buildRouteFacets(objects)).toEqual([
      { routeId: "route-akari", claimCount: 1 },
      { routeId: "route-yuki", claimCount: 2 },
    ]);
  });

  it("computes localization coverage, provisional, limited-context, and test-mode counts", () => {
    const objects = [
      sourceView("obj-1", [claim("c1", { kind: "global" })]),
      sourceView("obj-2", [claim("c2", { kind: "global" })], {
        provisional: true,
        contextScope: "narrowed:prologue",
        runMode: "test-dev",
      }),
    ];
    const renderings = [rendering("obj-1")];
    const readiness = computeReadiness(objects, renderings);
    expect(readiness).toMatchObject({
      sourceObjectCount: 2,
      renderingCount: 1,
      provisionalSourceCount: 1,
      localizedSourceCount: 1,
      localizationCoveragePercent: 50,
      limitedContextCount: 1,
      testModeCount: 1,
    });
  });

  it("partitions a mixed view list into source objects and renderings", () => {
    const { sourceObjects, renderings } = partitionViews([
      sourceView("obj-1", []),
      rendering("obj-1"),
    ]);
    expect(sourceObjects.map((view) => view.objectId)).toEqual(["obj-1"]);
    expect(renderings.map((view) => view.kind)).toEqual(["rendering"]);
  });
});
