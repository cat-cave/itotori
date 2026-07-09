// play-routemap-ui — pure unit tests for the route/choice tree composer.
// Pins coverage derivation (Fresh → fresh, Stale → stale), choice edges,
// col/row layout, and issues count without a DB.

import { describe, expect, it } from "vitest";
import type { RouteChoiceRecord, RouteMapRecord } from "@itotori/db";
import { composePlayRouteMapReadModel } from "../src/play/route-map-read-model.js";

function route(
  overrides: Partial<RouteMapRecord> & Pick<RouteMapRecord, "routeKey">,
): RouteMapRecord {
  return {
    routeMapId: overrides.routeMapId ?? `rm-${overrides.routeKey}`,
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: "rev-1",
    routeKey: overrides.routeKey,
    routeTitle: overrides.routeTitle ?? overrides.routeKey,
    mapLocale: "ja-JP",
    routeSummary: overrides.routeSummary ?? `Summary for ${overrides.routeKey}`,
    modelProviderFamily: "fake",
    modelId: "fake-model",
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: null,
    promptTemplateVersion: "v1",
    promptHash: "hash",
    inputTokenEstimate: 100,
    completionTokens: 50,
    status: overrides.status ?? "Fresh",
    invalidatedAt: null,
    invalidatedReason: null,
    generatedAt: overrides.generatedAt ?? new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    citations: [],
    ...overrides,
  };
}

function choice(
  overrides: Partial<RouteChoiceRecord> &
    Pick<RouteChoiceRecord, "choiceKey" | "fromRouteKey"> & {
      options: RouteChoiceRecord["options"];
    },
): RouteChoiceRecord {
  return {
    routeChoiceId: overrides.routeChoiceId ?? `rc-${overrides.choiceKey}`,
    projectId: "project-1",
    localeBranchId: "locale-1",
    sourceRevisionId: "rev-1",
    choiceKey: overrides.choiceKey,
    kind: overrides.kind ?? "RouteBranch",
    fromRouteKey: overrides.fromRouteKey,
    promptSummary: "Choose a path",
    mapLocale: "ja-JP",
    options: overrides.options,
    modelProviderFamily: "fake",
    modelId: "fake-model",
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: null,
    promptTemplateVersion: "v1",
    promptHash: "hash",
    status: overrides.status ?? "Fresh",
    invalidatedAt: null,
    invalidatedReason: null,
    generatedAt: overrides.generatedAt ?? new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    citations: [],
  };
}

describe("composePlayRouteMapReadModel", () => {
  it("derives coverage from route status and lays out col/row by tree depth", () => {
    const model = composePlayRouteMapReadModel({
      projectId: "project-1",
      localeBranchId: "locale-1",
      generatedAt: new Date("2026-07-08T12:00:00.000Z"),
      routeMaps: [
        route({ routeKey: "a", routeTitle: "Root", status: "Fresh" }),
        route({ routeKey: "b", routeTitle: "Child", status: "Stale" }),
      ],
      routeChoices: [
        choice({
          choiceKey: "c1",
          fromRouteKey: "a",
          options: [
            {
              optionId: "opt-1",
              optionIndex: 0,
              optionLabel: "Go to B",
              targetRouteKey: "b",
              targetUnitIds: [],
              targetUnitHashes: [],
            },
          ],
        }),
      ],
    });

    expect(model.schemaVersion).toBe("itotori.play.route-map.v0");
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toEqual([
      {
        fromRouteKey: "a",
        toRouteKey: "b",
        choiceKey: "c1",
        choiceKind: "RouteBranch",
        label: "Go to B",
      },
    ]);

    const root = model.nodes.find((n) => n.routeKey === "a");
    const child = model.nodes.find((n) => n.routeKey === "b");
    expect(root).toMatchObject({
      col: 0,
      row: 0,
      coverage: "fresh",
      state: "fresh",
      issues: 0,
      label: "Root",
    });
    expect(child).toMatchObject({
      col: 1,
      row: 0,
      coverage: "stale",
      state: "stale",
      issues: 1,
      label: "Child",
    });
    expect(model.counts).toEqual({ fresh: 1, stale: 1, total: 2, choiceCount: 1 });
  });

  it("prefers Fresh over Stale when multiple versions share a routeKey", () => {
    const model = composePlayRouteMapReadModel({
      projectId: "project-1",
      localeBranchId: "locale-1",
      generatedAt: new Date("2026-07-08T12:00:00.000Z"),
      routeMaps: [
        route({
          routeKey: "a",
          routeMapId: "rm-stale",
          status: "Stale",
          generatedAt: new Date("2026-07-08T02:00:00.000Z"),
        }),
        route({
          routeKey: "a",
          routeMapId: "rm-fresh",
          status: "Fresh",
          generatedAt: new Date("2026-07-08T01:00:00.000Z"),
        }),
      ],
      routeChoices: [],
    });

    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]?.routeMapId).toBe("rm-fresh");
    expect(model.nodes[0]?.coverage).toBe("fresh");
  });

  it("collapses superseded route choices before expanding options", () => {
    const model = composePlayRouteMapReadModel({
      projectId: "project-1",
      localeBranchId: "locale-1",
      generatedAt: new Date("2026-07-08T12:00:00.000Z"),
      routeMaps: [
        route({ routeKey: "a" }),
        route({ routeKey: "b" }),
        route({ routeKey: "obsolete" }),
      ],
      routeChoices: [
        choice({
          choiceKey: "c1",
          routeChoiceId: "rc-stale",
          fromRouteKey: "a",
          status: "Stale",
          generatedAt: new Date("2026-07-08T02:00:00.000Z"),
          options: [
            {
              optionId: "old-option-id",
              optionIndex: 0,
              optionLabel: "Old branch",
              targetRouteKey: "obsolete",
              targetUnitIds: [],
              targetUnitHashes: [],
            },
          ],
        }),
        choice({
          choiceKey: "c1",
          routeChoiceId: "rc-fresh",
          fromRouteKey: "a",
          status: "Fresh",
          generatedAt: new Date("2026-07-08T01:00:00.000Z"),
          options: [
            {
              optionId: "new-option-id",
              optionIndex: 0,
              optionLabel: "Current branch",
              targetRouteKey: "b",
              targetUnitIds: [],
              targetUnitHashes: [],
            },
          ],
        }),
      ],
    });

    expect(model.edges).toEqual([
      {
        fromRouteKey: "a",
        toRouteKey: "b",
        choiceKey: "c1",
        choiceKind: "RouteBranch",
        label: "Current branch",
      },
    ]);
    expect(model.counts.choiceCount).toBe(1);
  });

  it("drops choice edges that reference unknown routes", () => {
    const model = composePlayRouteMapReadModel({
      projectId: "project-1",
      localeBranchId: "locale-1",
      generatedAt: new Date("2026-07-08T12:00:00.000Z"),
      routeMaps: [route({ routeKey: "a" })],
      routeChoices: [
        choice({
          choiceKey: "orphan",
          fromRouteKey: "a",
          options: [
            {
              optionId: "opt-x",
              optionIndex: 0,
              optionLabel: "Ghost",
              targetRouteKey: "missing",
              targetUnitIds: [],
              targetUnitHashes: [],
            },
          ],
        }),
      ],
    });

    expect(model.edges).toEqual([]);
    expect(model.counts.choiceCount).toBe(0);
  });
});
