// play-mark-validated — compose per-scene coverage + route map graph into the
// Play RouteMap read-model. The repository owns persistence + permission gates;
// this service joins coverage rows with routeMaps / routeChoices so the UI can
// paint every node with coverage state and mark a scene validated.

import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  ItotoriSceneCoverageRepositoryPort,
  RouteChoiceRecord,
  RouteMapRecord,
  SceneCoverageRecord,
  SceneLocalizationCoverageState,
} from "@itotori/db";
import {
  routeChoiceStatusValues,
  routeMapStatusValues,
  sceneLocalizationCoverageStateValues,
} from "@itotori/db";

export const SCENE_COVERAGE_READ_SCHEMA_VERSION = "itotori.play.scene-coverage.v0" as const;
export const SCENE_COVERAGE_SET_SCHEMA_VERSION = "itotori.play.set-scene-coverage.v0" as const;

export type PlaySceneCoverageNode = {
  sceneId: string;
  label: string;
  coverageState: SceneLocalizationCoverageState;
  routeKey: string | null;
  routeMapId: string | null;
};

export type PlaySceneCoverageEdge = {
  fromSceneId: string;
  toSceneId: string;
  choiceKey: string;
  label: string;
};

export type PlaySceneCoverageCounts = {
  needsCheck: number;
  flagged: number;
  validated: number;
  total: number;
};

export type PlaySceneCoverageReadModel = {
  schemaVersion: typeof SCENE_COVERAGE_READ_SCHEMA_VERSION;
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  nodes: PlaySceneCoverageNode[];
  edges: PlaySceneCoverageEdge[];
  counts: PlaySceneCoverageCounts;
};

export type PlaySetSceneCoverageResult = {
  schemaVersion: typeof SCENE_COVERAGE_SET_SCHEMA_VERSION;
  projectId: string;
  localeBranchId: string;
  sceneId: string;
  coverageState: SceneLocalizationCoverageState;
  updatedAt: string;
  updatedByUserId: string;
};

export type SceneCoverageServiceErrorCode = "unknown_scene";

/**
 * Typed service error for play-mark-validated. `unknown_scene` is raised when
 * setSceneCoverage targets a sceneId that is not on the branch's active route
 * graph — fail-loud so phantom coverage never persists.
 */
export class SceneCoverageServiceError extends Error {
  readonly code: SceneCoverageServiceErrorCode;

  constructor(code: SceneCoverageServiceErrorCode, message: string) {
    super(message);
    this.name = "SceneCoverageServiceError";
    this.code = code;
  }
}

export type SceneCoverageServicePort = {
  loadRouteMapCoverage(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
  }): Promise<PlaySceneCoverageReadModel>;
  setSceneCoverage(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
    sceneId: string;
    coverageState: SceneLocalizationCoverageState;
    updatedByUserId: string;
  }): Promise<PlaySetSceneCoverageResult>;
};

export class SceneCoverageService implements SceneCoverageServicePort {
  constructor(
    private readonly deps: {
      coverage: ItotoriSceneCoverageRepositoryPort;
      routeMaps: Pick<
        ItotoriRouteChoiceMapRepositoryPort,
        "loadRouteMapsByProject" | "loadRouteChoicesByProject"
      >;
      now?: () => Date;
    },
  ) {}

  async loadRouteMapCoverage(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
  }): Promise<PlaySceneCoverageReadModel> {
    const coverageRows = await this.deps.coverage.loadCoverageForBranch(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    });
    const { routeMaps, routeChoices } = await this.loadActiveRouteGraph(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    });

    const coverageByScene = new Map<string, SceneCoverageRecord>();
    for (const row of coverageRows) {
      coverageByScene.set(row.sceneId, row);
    }

    // Active graph only (Fresh preferred, Stale fallback). Within that set,
    // when multiple versions share a routeKey keep the latest generatedAt
    // (deterministic: generatedAt desc then routeMapId).
    const routeByKey = selectLatestRoutesByKey(routeMaps);

    const edges = buildEdgesFromChoices(routeChoices);

    // Nodes come ONLY from the active route graph (maps + edge endpoints) —
    // coverage rows for scenes outside the graph are not surfaced (no phantom
    // nodes / count skew from orphan coverage).
    const sceneIds = new Set<string>([
      ...routeByKey.keys(),
      ...edges.flatMap((edge) => [edge.fromSceneId, edge.toSceneId]),
    ]);

    const nodes: PlaySceneCoverageNode[] = [...sceneIds]
      .sort((a, b) => a.localeCompare(b))
      .map((sceneId) => {
        const route = routeByKey.get(sceneId);
        const coverage = coverageByScene.get(sceneId);
        return {
          sceneId,
          label: route?.routeTitle ?? sceneId,
          coverageState: coverage?.coverageState ?? sceneLocalizationCoverageStateValues.needsCheck,
          routeKey: route?.routeKey ?? null,
          routeMapId: route?.routeMapId ?? null,
        };
      });

    const counts: PlaySceneCoverageCounts = {
      needsCheck: 0,
      flagged: 0,
      validated: 0,
      total: nodes.length,
    };
    for (const node of nodes) {
      switch (node.coverageState) {
        case sceneLocalizationCoverageStateValues.validated:
          counts.validated += 1;
          break;
        case sceneLocalizationCoverageStateValues.flagged:
          counts.flagged += 1;
          break;
        default:
          counts.needsCheck += 1;
          break;
      }
    }

    const now = this.deps.now?.() ?? new Date();
    return {
      schemaVersion: SCENE_COVERAGE_READ_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      nodes,
      edges,
      counts,
    };
  }

  async setSceneCoverage(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
    sceneId: string;
    coverageState: SceneLocalizationCoverageState;
    updatedByUserId: string;
  }): Promise<PlaySetSceneCoverageResult> {
    const sceneId = input.sceneId.trim();
    const knownScenes = await this.loadActiveSceneIds(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
    });
    if (!knownScenes.has(sceneId)) {
      throw new SceneCoverageServiceError(
        "unknown_scene",
        `sceneId '${sceneId}' is not on the active route map for branch ${input.localeBranchId}`,
      );
    }

    const record = await this.deps.coverage.setCoverage(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sceneId,
      coverageState: input.coverageState,
      updatedByUserId: input.updatedByUserId,
    });
    return {
      schemaVersion: SCENE_COVERAGE_SET_SCHEMA_VERSION,
      projectId: record.projectId,
      localeBranchId: record.localeBranchId,
      sceneId: record.sceneId,
      coverageState: record.coverageState,
      updatedAt: record.updatedAt.toISOString(),
      updatedByUserId: record.updatedByUserId,
    };
  }

  /**
   * Scene ids that belong to the branch's active route graph (route map keys +
   * choice edge endpoints). Used to reject setSceneCoverage writes for scenes
   * that would become phantom RouteMap nodes.
   */
  private async loadActiveSceneIds(
    actor: AuthorizationActor,
    query: { projectId: string; localeBranchId: string },
  ): Promise<Set<string>> {
    const { routeMaps, routeChoices } = await this.loadActiveRouteGraph(actor, query);
    const sceneIds = new Set<string>();
    for (const route of routeMaps) {
      sceneIds.add(route.routeKey);
    }
    for (const edge of buildEdgesFromChoices(routeChoices)) {
      sceneIds.add(edge.fromSceneId);
      sceneIds.add(edge.toSceneId);
    }
    return sceneIds;
  }

  /**
   * Prefer Fresh (active) route maps + choices. Fall back to Stale only when
   * the branch has no Fresh rows, so a still-valid invalidated map can paint
   * without mixing stale edges into a Fresh graph.
   */
  private async loadActiveRouteGraph(
    actor: AuthorizationActor,
    query: { projectId: string; localeBranchId: string },
  ): Promise<{ routeMaps: RouteMapRecord[]; routeChoices: RouteChoiceRecord[] }> {
    const [freshMaps, freshChoices] = await Promise.all([
      this.deps.routeMaps.loadRouteMapsByProject(actor, {
        projectId: query.projectId,
        localeBranchId: query.localeBranchId,
        status: routeMapStatusValues.fresh,
      }),
      this.deps.routeMaps.loadRouteChoicesByProject(actor, {
        projectId: query.projectId,
        localeBranchId: query.localeBranchId,
        status: routeChoiceStatusValues.fresh,
      }),
    ]);
    if (freshMaps.length > 0 || freshChoices.length > 0) {
      return { routeMaps: freshMaps, routeChoices: freshChoices };
    }

    const [staleMaps, staleChoices] = await Promise.all([
      this.deps.routeMaps.loadRouteMapsByProject(actor, {
        projectId: query.projectId,
        localeBranchId: query.localeBranchId,
        status: routeMapStatusValues.stale,
      }),
      this.deps.routeMaps.loadRouteChoicesByProject(actor, {
        projectId: query.projectId,
        localeBranchId: query.localeBranchId,
        status: routeChoiceStatusValues.stale,
      }),
    ]);
    return { routeMaps: staleMaps, routeChoices: staleChoices };
  }
}

function selectLatestRoutesByKey(
  routeMaps: RouteMapRecord[],
): Map<string, { routeMapId: string; routeKey: string; routeTitle: string; generatedAt: Date }> {
  const routeByKey = new Map<
    string,
    { routeMapId: string; routeKey: string; routeTitle: string; generatedAt: Date }
  >();
  const sortedMaps = [...routeMaps].sort((a, b) => {
    const byTime = b.generatedAt.getTime() - a.generatedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.routeMapId.localeCompare(b.routeMapId);
  });
  for (const route of sortedMaps) {
    if (!routeByKey.has(route.routeKey)) {
      routeByKey.set(route.routeKey, {
        routeMapId: route.routeMapId,
        routeKey: route.routeKey,
        routeTitle: route.routeTitle,
        generatedAt: route.generatedAt,
      });
    }
  }
  return routeByKey;
}

function buildEdgesFromChoices(routeChoices: RouteChoiceRecord[]): PlaySceneCoverageEdge[] {
  const edges: PlaySceneCoverageEdge[] = [];
  const seenEdge = new Set<string>();
  for (const choice of routeChoices) {
    const from = choice.fromRouteKey;
    if (from === null || from.length === 0) {
      continue;
    }
    for (const option of choice.options) {
      const to = option.targetRouteKey;
      if (to === null || to.length === 0) {
        continue;
      }
      // Dedupe by graph identity (from/to/choiceKey). Option ids can differ
      // across re-generations of the same edge; collapse to one edge so stale
      // duplicates cannot fan out the RouteMap.
      const edgeKey = `${from}\0${to}\0${choice.choiceKey}`;
      if (seenEdge.has(edgeKey)) {
        continue;
      }
      seenEdge.add(edgeKey);
      edges.push({
        fromSceneId: from,
        toSceneId: to,
        choiceKey: choice.choiceKey,
        label: option.optionLabel,
      });
    }
  }
  edges.sort((a, b) => {
    const byFrom = a.fromSceneId.localeCompare(b.fromSceneId);
    if (byFrom !== 0) return byFrom;
    const byTo = a.toSceneId.localeCompare(b.toSceneId);
    if (byTo !== 0) return byTo;
    return a.choiceKey.localeCompare(b.choiceKey);
  });
  return edges;
}
