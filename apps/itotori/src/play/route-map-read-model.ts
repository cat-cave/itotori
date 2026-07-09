// play-routemap-ui — compose the Play RouteMap read-model from the existing
// routeMaps / routeChoices tables. Nodes are routes (col/row/state/coverage/
// issues); edges are choice options. Coverage state is derived from the
// route-choice map status (Fresh → fresh, Stale → stale) — the durable
// needs_check/flagged/validated workflow lands with play-mark-validated.

import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  RouteChoiceRecord,
  RouteMapRecord,
  RouteMapStatus,
} from "@itotori/db";

export const PLAY_ROUTE_MAP_SCHEMA_VERSION = "itotori.play.route-map.v0" as const;

export type PlayRouteMapCoverageState = "fresh" | "stale";

export type PlayRouteMapNode = {
  /** Stable node id (= routeKey). */
  routeKey: string;
  routeMapId: string;
  label: string;
  summary: string;
  /** Column in the tree layout (0-based, left → right by depth). */
  col: number;
  /** Row in the tree layout (0-based within a column). */
  row: number;
  /** Product status badge string (lowercase closed vocabulary). */
  state: PlayRouteMapCoverageState;
  /** Coverage state painted on the RouteMap node. */
  coverage: PlayRouteMapCoverageState;
  /** Open issues (1 when stale, else 0). */
  issues: number;
};

export type PlayRouteMapEdge = {
  fromRouteKey: string;
  toRouteKey: string;
  choiceKey: string;
  choiceKind: string;
  label: string;
};

export type PlayRouteMapCounts = {
  fresh: number;
  stale: number;
  total: number;
  choiceCount: number;
};

export type PlayRouteMapReadModel = {
  schemaVersion: typeof PLAY_ROUTE_MAP_SCHEMA_VERSION;
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  nodes: PlayRouteMapNode[];
  edges: PlayRouteMapEdge[];
  counts: PlayRouteMapCounts;
};

export type RouteMapReadModelPort = {
  loadRouteMap(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
  }): Promise<PlayRouteMapReadModel>;
};

export class RouteMapReadModelService implements RouteMapReadModelPort {
  constructor(
    private readonly deps: {
      routeMaps: Pick<
        ItotoriRouteChoiceMapRepositoryPort,
        "loadRouteMapsByProject" | "loadRouteChoicesByProject"
      >;
      now?: () => Date;
    },
  ) {}

  async loadRouteMap(input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
  }): Promise<PlayRouteMapReadModel> {
    const [routeMaps, routeChoices] = await Promise.all([
      this.deps.routeMaps.loadRouteMapsByProject(input.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      }),
      this.deps.routeMaps.loadRouteChoicesByProject(input.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
      }),
    ]);
    const now = this.deps.now?.() ?? new Date();
    return composePlayRouteMapReadModel({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      routeMaps,
      routeChoices,
      generatedAt: now,
    });
  }
}

/**
 * Pure composer — pure so unit tests pin the tree layout + coverage
 * derivation without a DB. Prefer Fresh route maps; fall back to Stale so a
 * stale map still paints. When multiple versions exist for one routeKey,
 * keep the latest generatedAt (deterministic: sort by generatedAt desc then
 * routeMapId).
 */
export function composePlayRouteMapReadModel(input: {
  projectId: string;
  localeBranchId: string;
  routeMaps: readonly RouteMapRecord[];
  routeChoices: readonly RouteChoiceRecord[];
  generatedAt: Date;
}): PlayRouteMapReadModel {
  const routeByKey = selectLatestRoutesByKey(input.routeMaps);
  const choiceByKey = selectLatestChoicesByKey(input.routeChoices);
  const edges = buildEdges([...choiceByKey.values()], routeByKey);
  const layout = layoutRouteTree([...routeByKey.keys()], edges);

  const nodes: PlayRouteMapNode[] = [...routeByKey.values()]
    .map((route) => {
      const coverage = coverageFromStatus(route.status);
      const position = layout.get(route.routeKey) ?? { col: 0, row: 0 };
      return {
        routeKey: route.routeKey,
        routeMapId: route.routeMapId,
        label: route.routeTitle,
        summary: route.routeSummary,
        col: position.col,
        row: position.row,
        state: coverage,
        coverage,
        issues: coverage === "stale" ? 1 : 0,
      };
    })
    .sort((a, b) => {
      if (a.col !== b.col) return a.col - b.col;
      if (a.row !== b.row) return a.row - b.row;
      return a.routeKey.localeCompare(b.routeKey);
    });

  const counts: PlayRouteMapCounts = {
    fresh: nodes.filter((n) => n.coverage === "fresh").length,
    stale: nodes.filter((n) => n.coverage === "stale").length,
    total: nodes.length,
    choiceCount: edges.length,
  };

  return {
    schemaVersion: PLAY_ROUTE_MAP_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    nodes,
    edges,
    counts,
  };
}

function coverageFromStatus(status: RouteMapStatus): PlayRouteMapCoverageState {
  // RouteMapStatus is the DB enum (`fresh` / `stale` lowercase in schema; the
  // agent shapes use Fresh/Stale title case). Accept both.
  const normalized = String(status).toLowerCase();
  return normalized === "stale" ? "stale" : "fresh";
}

function selectLatestRoutesByKey(
  routeMaps: readonly RouteMapRecord[],
): Map<string, RouteMapRecord> {
  const sorted = [...routeMaps].sort((a, b) => {
    // Prefer Fresh over Stale when both exist for the same key.
    const aFresh = String(a.status).toLowerCase() === "fresh" ? 0 : 1;
    const bFresh = String(b.status).toLowerCase() === "fresh" ? 0 : 1;
    if (aFresh !== bFresh) return aFresh - bFresh;
    const byTime = b.generatedAt.getTime() - a.generatedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.routeMapId.localeCompare(b.routeMapId);
  });
  const byKey = new Map<string, RouteMapRecord>();
  for (const route of sorted) {
    if (!byKey.has(route.routeKey)) {
      byKey.set(route.routeKey, route);
    }
  }
  return byKey;
}

function selectLatestChoicesByKey(
  routeChoices: readonly RouteChoiceRecord[],
): Map<string, RouteChoiceRecord> {
  const sorted = [...routeChoices].sort((a, b) => {
    // Prefer Fresh over Stale when both exist for the same key.
    const aFresh = String(a.status).toLowerCase() === "fresh" ? 0 : 1;
    const bFresh = String(b.status).toLowerCase() === "fresh" ? 0 : 1;
    if (aFresh !== bFresh) return aFresh - bFresh;
    const byTime = b.generatedAt.getTime() - a.generatedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.routeChoiceId.localeCompare(b.routeChoiceId);
  });
  const byKey = new Map<string, RouteChoiceRecord>();
  for (const choice of sorted) {
    if (!byKey.has(choice.choiceKey)) {
      byKey.set(choice.choiceKey, choice);
    }
  }
  return byKey;
}

function buildEdges(
  routeChoices: readonly RouteChoiceRecord[],
  routeByKey: Map<string, RouteMapRecord>,
): PlayRouteMapEdge[] {
  const edges: PlayRouteMapEdge[] = [];
  const seen = new Set<string>();
  // Prefer Fresh choices first, then latest generatedAt.
  const sorted = [...routeChoices].sort((a, b) => {
    const aFresh = String(a.status).toLowerCase() === "fresh" ? 0 : 1;
    const bFresh = String(b.status).toLowerCase() === "fresh" ? 0 : 1;
    if (aFresh !== bFresh) return aFresh - bFresh;
    const byTime = b.generatedAt.getTime() - a.generatedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.routeChoiceId.localeCompare(b.routeChoiceId);
  });

  for (const choice of sorted) {
    const from = choice.fromRouteKey;
    if (from === null || from.length === 0) {
      continue;
    }
    // Drop edges that reference unknown routes (orphans / phantoms).
    if (!routeByKey.has(from)) {
      continue;
    }
    for (const option of choice.options) {
      const to = option.targetRouteKey;
      if (to === null || to.length === 0) {
        continue;
      }
      if (!routeByKey.has(to)) {
        continue;
      }
      const edgeKey = `${from}\0${to}\0${choice.choiceKey}\0${option.optionId}`;
      if (seen.has(edgeKey)) {
        continue;
      }
      seen.add(edgeKey);
      edges.push({
        fromRouteKey: from,
        toRouteKey: to,
        choiceKey: choice.choiceKey,
        choiceKind: choice.kind,
        label: option.optionLabel,
      });
    }
  }

  edges.sort((a, b) => {
    const byFrom = a.fromRouteKey.localeCompare(b.fromRouteKey);
    if (byFrom !== 0) return byFrom;
    const byTo = a.toRouteKey.localeCompare(b.toRouteKey);
    if (byTo !== 0) return byTo;
    return a.choiceKey.localeCompare(b.choiceKey);
  });
  return edges;
}

/**
 * BFS layering from roots (nodes with no incoming edges). Cycles / unreachable
 * nodes land in column 0 after the roots so every node still paints.
 */
function layoutRouteTree(
  routeKeys: readonly string[],
  edges: readonly PlayRouteMapEdge[],
): Map<string, { col: number; row: number }> {
  const keys = [...routeKeys].sort((a, b) => a.localeCompare(b));
  const keySet = new Set(keys);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const key of keys) {
    incoming.set(key, 0);
    outgoing.set(key, []);
  }
  for (const edge of edges) {
    if (!keySet.has(edge.fromRouteKey) || !keySet.has(edge.toRouteKey)) {
      continue;
    }
    if (edge.fromRouteKey === edge.toRouteKey) {
      continue;
    }
    incoming.set(edge.toRouteKey, (incoming.get(edge.toRouteKey) ?? 0) + 1);
    outgoing.get(edge.fromRouteKey)?.push(edge.toRouteKey);
  }
  for (const targets of outgoing.values()) {
    targets.sort((a, b) => a.localeCompare(b));
  }

  const roots = keys.filter((key) => (incoming.get(key) ?? 0) === 0);
  const layout = new Map<string, { col: number; row: number }>();
  const rowsAtCol = new Map<number, number>();
  const queue: Array<{ key: string; col: number }> = roots.map((key) => ({ key, col: 0 }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.key)) {
      continue;
    }
    visited.add(current.key);
    const row = rowsAtCol.get(current.col) ?? 0;
    rowsAtCol.set(current.col, row + 1);
    layout.set(current.key, { col: current.col, row });
    for (const target of outgoing.get(current.key) ?? []) {
      if (!visited.has(target)) {
        queue.push({ key: target, col: current.col + 1 });
      }
    }
  }

  // Unreachable / cycle-only nodes: park in column 0 after the roots.
  for (const key of keys) {
    if (!layout.has(key)) {
      const row = rowsAtCol.get(0) ?? 0;
      rowsAtCol.set(0, row + 1);
      layout.set(key, { col: 0, row });
    }
  }
  return layout;
}
