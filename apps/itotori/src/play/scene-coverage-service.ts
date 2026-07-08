// play-mark-validated — compose per-scene coverage + route map graph into the
// Play RouteMap read-model. The repository owns persistence + permission gates;
// this service joins coverage rows with routeMaps / routeChoices so the UI can
// paint every node with coverage state and mark a scene validated.

import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  ItotoriSceneCoverageRepositoryPort,
  SceneCoverageRecord,
  SceneLocalizationCoverageState,
} from "@itotori/db";
import { sceneLocalizationCoverageStateValues } from "@itotori/db";

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
    const [coverageRows, routeMaps, routeChoices] = await Promise.all([
      this.deps.coverage.loadCoverageForBranch(input.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      }),
      this.deps.routeMaps.loadRouteMapsByProject(input.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      }),
      this.deps.routeMaps.loadRouteChoicesByProject(input.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      }),
    ]);

    const coverageByScene = new Map<string, SceneCoverageRecord>();
    for (const row of coverageRows) {
      coverageByScene.set(row.sceneId, row);
    }

    // Prefer Fresh route maps; fall back to any status so a stale map still
    // paints. When multiple versions exist for one routeKey, keep the latest
    // generatedAt (deterministic: sort by generatedAt desc then routeMapId).
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
        const edgeKey = `${from}\0${to}\0${choice.choiceKey}\0${option.optionId}`;
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

    const sceneIds = new Set<string>([
      ...coverageByScene.keys(),
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
    const record = await this.deps.coverage.setCoverage(input.actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sceneId: input.sceneId,
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
}
