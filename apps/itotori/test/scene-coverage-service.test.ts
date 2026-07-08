// play-mark-validated — SceneCoverageService unit pins for the P2 audit fixes:
//   1. setSceneCoverage rejects sceneIds not on the branch route graph
//   2. loadRouteMapCoverage uses Fresh (status filter), not stale edges
//   3. orphan coverage rows do not become phantom RouteMap nodes

import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizationActor,
  RouteChoiceRecord,
  RouteMapRecord,
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
  routeMapId: string;
  routeKey: string;
  routeTitle?: string;
  status: "Fresh" | "Stale";
  generatedAt: Date;
}): RouteMapRecord {
  return {
    routeMapId: partial.routeMapId,
    projectId,
    localeBranchId,
    sourceRevisionId: "rev-1",
    routeKey: partial.routeKey,
    routeTitle: partial.routeTitle ?? partial.routeKey,
    mapLocale: "en-US",
    routeSummary: "summary",
    modelProviderFamily: "test",
    modelId: "test-model",
    modelContextWindowTokens: 1,
    modelMaxOutputTokens: null,
    promptTemplateVersion: "v1",
    promptHash: "hash",
    inputTokenEstimate: 0,
    completionTokens: 0,
    status: partial.status,
    invalidatedAt: partial.status === "Stale" ? fixedNow : null,
    invalidatedReason: partial.status === "Stale" ? "manual" : null,
    generatedAt: partial.generatedAt,
    createdAt: fixedNow,
    citations: [{ bridgeUnitId: "bu-1", citedSourceHash: "h1", citeOrdinal: 0 }],
  };
}

function routeChoice(partial: {
  routeChoiceId: string;
  choiceKey: string;
  fromRouteKey: string;
  toRouteKey: string;
  optionLabel?: string;
  status: "Fresh" | "Stale";
  generatedAt?: Date;
}): RouteChoiceRecord {
  return {
    routeChoiceId: partial.routeChoiceId,
    projectId,
    localeBranchId,
    sourceRevisionId: "rev-1",
    choiceKey: partial.choiceKey,
    kind: "route_branch",
    fromRouteKey: partial.fromRouteKey,
    promptSummary: "prompt",
    mapLocale: "en-US",
    options: [
      {
        optionId: `${partial.routeChoiceId}-opt-0`,
        optionIndex: 0,
        optionLabel: partial.optionLabel ?? "Go",
        targetRouteKey: partial.toRouteKey,
        targetUnitIds: [],
        targetUnitHashes: [],
      },
    ],
    modelProviderFamily: "test",
    modelId: "test-model",
    modelContextWindowTokens: 1,
    modelMaxOutputTokens: null,
    promptTemplateVersion: "v1",
    promptHash: "hash",
    status: partial.status,
    invalidatedAt: partial.status === "Stale" ? fixedNow : null,
    invalidatedReason: partial.status === "Stale" ? "manual" : null,
    generatedAt: partial.generatedAt ?? fixedNow,
    createdAt: fixedNow,
    citations: [{ bridgeUnitId: "bu-1", citedSourceHash: "h1", citeOrdinal: 0 }],
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
  maps?: RouteMapRecord[];
  choices?: RouteChoiceRecord[];
  coverage?: SceneCoverageRecord[];
}) {
  const maps = opts.maps ?? [];
  const choices = opts.choices ?? [];
  const coverage = opts.coverage ?? [];

  const loadRouteMapsByProject = vi.fn(async (_actor, query: { status?: string }) =>
    maps.filter((row) => query.status === undefined || row.status === query.status),
  );
  const loadRouteChoicesByProject = vi.fn(async (_actor, query: { status?: string }) =>
    choices.filter((row) => query.status === undefined || row.status === query.status),
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
    routeMaps: {
      loadRouteMapsByProject,
      loadRouteChoicesByProject,
    },
    now: () => fixedNow,
  });

  return {
    service,
    loadRouteMapsByProject,
    loadRouteChoicesByProject,
    loadCoverageForBranch,
    setCoverage,
  };
}

describe("SceneCoverageService (play-mark-validated P2 pins)", () => {
  it("setSceneCoverage rejects a sceneId that is not on the active route map", async () => {
    const { service, setCoverage, loadRouteMapsByProject } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-open",
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
    // Status filter: Fresh first (fail-loud when the scene is absent from it).
    expect(loadRouteMapsByProject).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: "Fresh" }),
    );
  });

  it("setSceneCoverage accepts a sceneId present on the active route map", async () => {
    const { service, setCoverage } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-open",
          routeKey: "scene-open",
          routeTitle: "Opening",
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
    expect(result).toMatchObject({
      schemaVersion: "itotori.play.set-scene-coverage.v0",
      sceneId: "scene-open",
      coverageState: "validated",
    });
    expect(setCoverage).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ sceneId: "scene-open", coverageState: "validated" }),
    );
  });

  it("loadRouteMapCoverage prefers Fresh maps/choices and omits stale edges", async () => {
    const { service, loadRouteMapsByProject, loadRouteChoicesByProject } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-fresh-a",
          routeKey: "scene-a",
          routeTitle: "Fresh A",
          status: "Fresh",
          generatedAt: new Date("2026-07-08T10:00:00.000Z"),
        }),
        routeMap({
          routeMapId: "rm-stale-b",
          routeKey: "scene-stale",
          routeTitle: "Stale only",
          status: "Stale",
          generatedAt: new Date("2026-07-08T11:00:00.000Z"),
        }),
      ],
      choices: [
        routeChoice({
          routeChoiceId: "rc-fresh",
          choiceKey: "choice-fresh",
          fromRouteKey: "scene-a",
          toRouteKey: "scene-b",
          optionLabel: "Fresh edge",
          status: "Fresh",
        }),
        routeChoice({
          routeChoiceId: "rc-stale",
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

    expect(loadRouteMapsByProject).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: "Fresh" }),
    );
    expect(loadRouteChoicesByProject).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: "Fresh" }),
    );
    // Stale fallback must NOT run when Fresh rows exist.
    expect(loadRouteMapsByProject).not.toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: "Stale" }),
    );

    expect(model.nodes.map((n) => n.sceneId).sort()).toEqual(["scene-a", "scene-b"]);
    expect(model.nodes.find((n) => n.sceneId === "scene-a")).toMatchObject({
      label: "Fresh A",
      coverageState: "validated",
      routeMapId: "rm-fresh-a",
    });
    expect(model.edges).toEqual([
      {
        fromSceneId: "scene-a",
        toSceneId: "scene-b",
        choiceKey: "choice-fresh",
        label: "Fresh edge",
      },
    ]);
    expect(model.counts).toEqual({
      needsCheck: 1,
      flagged: 0,
      validated: 1,
      total: 2,
    });
  });

  it("loadRouteMapCoverage does not surface orphan coverage as phantom nodes", async () => {
    const { service } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-open",
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
    expect(model.nodes.map((n) => n.sceneId)).toEqual(["scene-open"]);
    expect(model.counts.validated).toBe(0);
    expect(model.counts.total).toBe(1);
  });

  it("loadRouteMapCoverage falls back to Stale only when no Fresh graph exists", async () => {
    const { service, loadRouteMapsByProject } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-stale",
          routeKey: "scene-stale",
          status: "Stale",
          generatedAt: fixedNow,
        }),
      ],
      choices: [
        routeChoice({
          routeChoiceId: "rc-stale",
          choiceKey: "choice-stale",
          fromRouteKey: "scene-stale",
          toRouteKey: "scene-end",
          status: "Stale",
        }),
      ],
    });

    const model = await service.loadRouteMapCoverage({ actor, projectId, localeBranchId });
    expect(loadRouteMapsByProject).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: "Stale" }),
    );
    expect(model.nodes.map((n) => n.sceneId).sort()).toEqual(["scene-end", "scene-stale"]);
    expect(model.edges).toHaveLength(1);
  });

  it("dedupes duplicate route-choice edges by from/to/choiceKey", async () => {
    const { service } = makeService({
      maps: [
        routeMap({
          routeMapId: "rm-a",
          routeKey: "scene-a",
          status: "Fresh",
          generatedAt: fixedNow,
        }),
      ],
      choices: [
        routeChoice({
          routeChoiceId: "rc-1",
          choiceKey: "choice-x",
          fromRouteKey: "scene-a",
          toRouteKey: "scene-b",
          optionLabel: "First",
          status: "Fresh",
        }),
        routeChoice({
          routeChoiceId: "rc-2",
          choiceKey: "choice-x",
          fromRouteKey: "scene-a",
          toRouteKey: "scene-b",
          optionLabel: "Duplicate",
          status: "Fresh",
        }),
      ],
    });

    const model = await service.loadRouteMapCoverage({ actor, projectId, localeBranchId });
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]?.label).toBe("First");
  });
});
