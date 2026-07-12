// SceneCoverageService reads route topology from central semantic context
// artifacts. These pins ensure the UI does not silently revive the retired
// route-map tables through a compatibility read path.

import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizationActor,
  ContextRouteChoice,
  ContextRouteMap,
  SceneCoverageRecord,
} from "@itotori/db";
import {
  SceneCoverageService,
  SceneCoverageServiceError,
} from "../src/play/scene-coverage-service.js";

const actor: AuthorizationActor = { userId: "local-user" };
const projectId = "project-1";
const localeBranchId = "locale-1";
const fixedNow = new Date("2026-07-08T12:00:00.000Z");

function routeMap(partial: {
  contextArtifactId: string;
  routeKey: string;
  routeTitle?: string;
  status: "Fresh" | "Stale";
  generatedAt: Date;
}): ContextRouteMap {
  return {
    contextArtifactId: partial.contextArtifactId,
    projectId,
    localeBranchId,
    sourceRevisionId: "rev-1",
    routeKey: partial.routeKey,
    routeTitle: partial.routeTitle ?? partial.routeKey,
    routeSummary: "summary",
    status: partial.status,
    generatedAt: partial.generatedAt,
    citations: [],
  };
}

function routeChoice(partial: {
  contextArtifactId: string;
  choiceKey: string;
  fromRouteKey: string;
  toRouteKey: string;
  optionLabel?: string;
  status: "Fresh" | "Stale";
  generatedAt?: Date;
}): ContextRouteChoice {
  return {
    contextArtifactId: partial.contextArtifactId,
    projectId,
    localeBranchId,
    sourceRevisionId: "rev-1",
    choiceKey: partial.choiceKey,
    kind: "RouteBranch",
    fromRouteKey: partial.fromRouteKey,
    promptSummary: "prompt",
    options: [
      {
        optionId: `${partial.contextArtifactId}-opt-0`,
        optionIndex: 0,
        optionLabel: partial.optionLabel ?? "Go",
        targetRouteKey: partial.toRouteKey,
        targetUnitIds: [],
        targetUnitHashes: [],
      },
    ],
    status: partial.status,
    generatedAt: partial.generatedAt ?? fixedNow,
    citations: [],
  };
}

function coverageRow(partial: {
  sceneId: string;
  coverageState: SceneCoverageRecord["coverageState"];
}): SceneCoverageRecord {
  return {
    coverageId: `cov-${partial.sceneId}`,
    projectId,
    localeBranchId,
    sceneId: partial.sceneId,
    coverageState: partial.coverageState,
    updatedByUserId: "local-user",
    updatedAt: fixedNow,
    createdAt: fixedNow,
  };
}

function makeService(opts: {
  maps?: ContextRouteMap[];
  choices?: ContextRouteChoice[];
  coverage?: SceneCoverageRecord[];
}) {
  const maps = opts.maps ?? [];
  const choices = opts.choices ?? [];
  const coverage = opts.coverage ?? [];
  const loadRouteMaps = vi.fn(async (_actor, query: { includeStale?: boolean }) =>
    maps.filter((row) => query.includeStale === true || row.status === "Fresh"),
  );
  const loadRouteChoices = vi.fn(async (_actor, query: { includeStale?: boolean }) =>
    choices.filter((row) => query.includeStale === true || row.status === "Fresh"),
  );
  const loadCoverageForBranch = vi.fn(async () => coverage);
  const setCoverage = vi.fn(
    async (
      _actor,
      input: {
        projectId: string;
        localeBranchId: string;
        sceneId: string;
        coverageState: SceneCoverageRecord["coverageState"];
        updatedByUserId: string;
      },
    ) => coverageRow({ sceneId: input.sceneId, coverageState: input.coverageState }),
  );

  const service = new SceneCoverageService({
    coverage: {
      setCoverage,
      loadCoverageForBranch,
      loadCoverageForScene: vi.fn(async () => null),
    },
    contextArtifacts: { loadRouteMaps, loadRouteChoices },
    now: () => fixedNow,
  });

  return { service, loadRouteMaps, loadRouteChoices, loadCoverageForBranch, setCoverage };
}

describe("SceneCoverageService central route context", () => {
  it("rejects a scene not present in the active central route graph", async () => {
    const { service, setCoverage, loadRouteMaps } = makeService({
      maps: [
        routeMap({
          contextArtifactId: "route-open",
          routeKey: "scene-open",
          status: "Fresh",
          generatedAt: fixedNow,
        }),
      ],
    });

    await expect(
      service.setSceneCoverage({
        actor,
        projectId,
        localeBranchId,
        sceneId: "scene-phantom",
        coverageState: "validated",
        updatedByUserId: "local-user",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(SceneCoverageServiceError);
      expect((error as SceneCoverageServiceError).code).toBe("unknown_scene");
      return true;
    });
    expect(setCoverage).not.toHaveBeenCalled();
    expect(loadRouteMaps).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ includeStale: false }),
    );
  });

  it("accepts a scene present in active central route context", async () => {
    const { service, setCoverage } = makeService({
      maps: [
        routeMap({
          contextArtifactId: "route-open",
          routeKey: "scene-open",
          status: "Fresh",
          generatedAt: fixedNow,
        }),
      ],
    });

    const result = await service.setSceneCoverage({
      actor,
      projectId,
      localeBranchId,
      sceneId: "scene-open",
      coverageState: "validated",
      updatedByUserId: "local-user",
    });

    expect(result).toMatchObject({ sceneId: "scene-open", coverageState: "validated" });
    expect(setCoverage).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ sceneId: "scene-open", coverageState: "validated" }),
    );
  });

  it("uses active artifacts and omits stale route edges while active context exists", async () => {
    const { service, loadRouteMaps, loadRouteChoices } = makeService({
      maps: [
        routeMap({
          contextArtifactId: "route-a",
          routeKey: "scene-a",
          routeTitle: "Fresh A",
          status: "Fresh",
          generatedAt: fixedNow,
        }),
        routeMap({
          contextArtifactId: "route-stale",
          routeKey: "scene-stale",
          status: "Stale",
          generatedAt: fixedNow,
        }),
      ],
      choices: [
        routeChoice({
          contextArtifactId: "choice-fresh",
          choiceKey: "choice-fresh",
          fromRouteKey: "scene-a",
          toRouteKey: "scene-b",
          optionLabel: "Fresh edge",
          status: "Fresh",
        }),
        routeChoice({
          contextArtifactId: "choice-stale",
          choiceKey: "choice-stale",
          fromRouteKey: "scene-a",
          toRouteKey: "scene-stale",
          optionLabel: "Stale edge",
          status: "Stale",
        }),
      ],
      coverage: [coverageRow({ sceneId: "scene-a", coverageState: "validated" })],
    });

    const model = await service.loadRouteMapCoverage({ actor, projectId, localeBranchId });

    expect(loadRouteMaps).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ includeStale: false }),
    );
    expect(loadRouteChoices).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ includeStale: false }),
    );
    expect(loadRouteMaps).not.toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ includeStale: true }),
    );
    expect(model.nodes.map((node) => node.sceneId).sort()).toEqual(["scene-a", "scene-b"]);
    expect(model.nodes.find((node) => node.sceneId === "scene-a")).toMatchObject({
      label: "Fresh A",
      coverageState: "validated",
      routeMapId: "route-a",
    });
    expect(model.edges).toEqual([
      {
        fromSceneId: "scene-a",
        toSceneId: "scene-b",
        choiceKey: "choice-fresh",
        label: "Fresh edge",
      },
    ]);
  });

  it("does not surface orphan coverage as a phantom central-route node", async () => {
    const { service } = makeService({
      maps: [
        routeMap({
          contextArtifactId: "route-open",
          routeKey: "scene-open",
          status: "Fresh",
          generatedAt: fixedNow,
        }),
      ],
      coverage: [
        coverageRow({ sceneId: "scene-open", coverageState: "needs_check" }),
        coverageRow({ sceneId: "scene-orphan", coverageState: "validated" }),
      ],
    });

    const model = await service.loadRouteMapCoverage({ actor, projectId, localeBranchId });
    expect(model.nodes.map((node) => node.sceneId)).toEqual(["scene-open"]);
    expect(model.counts).toMatchObject({ validated: 0, total: 1 });
  });

  it("falls back to stale central artifacts only when no active graph exists", async () => {
    const { service, loadRouteMaps } = makeService({
      maps: [
        routeMap({
          contextArtifactId: "route-stale",
          routeKey: "scene-stale",
          status: "Stale",
          generatedAt: fixedNow,
        }),
      ],
      choices: [
        routeChoice({
          contextArtifactId: "choice-stale",
          choiceKey: "choice-stale",
          fromRouteKey: "scene-stale",
          toRouteKey: "scene-end",
          status: "Stale",
        }),
      ],
    });

    const model = await service.loadRouteMapCoverage({ actor, projectId, localeBranchId });
    expect(loadRouteMaps).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ includeStale: true }),
    );
    expect(model.nodes.map((node) => node.sceneId).sort()).toEqual(["scene-end", "scene-stale"]);
    expect(model.edges).toHaveLength(1);
  });
});
