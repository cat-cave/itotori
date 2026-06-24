import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  RouteChoiceRecord,
  RouteInvalidatedReason,
  RouteMapRecord,
} from "@itotori/db";

export type RouteMapDrift = {
  routeMapId: string;
  routeKey: string;
  driftedBridgeUnitIds: string[];
};

export type RouteChoiceDrift = {
  routeChoiceId: string;
  choiceKey: string;
  driftedBridgeUnitIds: string[];
};

export type DanglingRouteTarget = {
  routeChoiceId: string;
  choiceKey: string;
  targetRouteKey: string;
};

export type RouteChoiceStalenessScanInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  reason?: RouteInvalidatedReason;
  markStale?: boolean;
};

export type RouteChoiceStalenessScanResult = {
  scannedRouteCount: number;
  scannedChoiceCount: number;
  driftedRoutes: RouteMapDrift[];
  driftedChoices: RouteChoiceDrift[];
  danglingChoices: DanglingRouteTarget[];
  markedStaleRouteCount: number;
  markedStaleChoiceCount: number;
};

export async function markStaleRouteChoiceArtifactsForRevision(
  repository: ItotoriRouteChoiceMapRepositoryPort,
  actor: AuthorizationActor,
  input: RouteChoiceStalenessScanInput,
): Promise<RouteChoiceStalenessScanResult> {
  const reason: RouteInvalidatedReason = input.reason ?? "source_hash_drift";
  const markStale = input.markStale ?? true;

  const routes = await repository.loadRouteMapsByProject(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });
  const choices = await repository.loadRouteChoicesByProject(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });

  const bridgeUnitIds = new Set<string>();
  for (const route of routes) {
    for (const citation of route.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
  }
  for (const choice of choices) {
    for (const citation of choice.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
    for (const option of choice.options) {
      for (const id of option.targetUnitIds) {
        bridgeUnitIds.add(id);
      }
    }
  }
  const currentHashes =
    bridgeUnitIds.size === 0
      ? new Map<string, string>()
      : await repository.currentSourceHashesForBridgeUnits(actor, {
          bridgeUnitIds: [...bridgeUnitIds],
        });

  const driftedRoutes: RouteMapDrift[] = [];
  for (const route of routes) {
    const drifted = collectRouteDrift(route, currentHashes);
    if (drifted.length > 0) {
      driftedRoutes.push({
        routeMapId: route.routeMapId,
        routeKey: route.routeKey,
        driftedBridgeUnitIds: drifted,
      });
    }
  }

  const driftedChoices: RouteChoiceDrift[] = [];
  const danglingChoices: DanglingRouteTarget[] = [];
  const freshRouteKeys = new Set(routes.map((r) => r.routeKey));

  for (const choice of choices) {
    const drifted = collectChoiceDrift(choice, currentHashes);
    if (drifted.length > 0) {
      driftedChoices.push({
        routeChoiceId: choice.routeChoiceId,
        choiceKey: choice.choiceKey,
        driftedBridgeUnitIds: drifted,
      });
      continue;
    }
    if (choice.kind === "RouteBranch") {
      for (const option of choice.options) {
        if (option.targetRouteKey && !freshRouteKeys.has(option.targetRouteKey)) {
          danglingChoices.push({
            routeChoiceId: choice.routeChoiceId,
            choiceKey: choice.choiceKey,
            targetRouteKey: option.targetRouteKey,
          });
          break;
        }
      }
    }
  }

  let markedStaleRouteCount = 0;
  let markedStaleChoiceCount = 0;
  if (markStale) {
    for (const drift of driftedRoutes) {
      await repository.markRouteMapStale(actor, {
        routeMapId: drift.routeMapId,
        reason,
      });
      markedStaleRouteCount += 1;
    }
    for (const drift of driftedChoices) {
      await repository.markRouteChoiceStale(actor, {
        routeChoiceId: drift.routeChoiceId,
        reason,
      });
      markedStaleChoiceCount += 1;
    }
    for (const dangling of danglingChoices) {
      await repository.markRouteChoiceStale(actor, {
        routeChoiceId: dangling.routeChoiceId,
        reason: "unknown_route_target",
      });
      markedStaleChoiceCount += 1;
    }
  }

  return {
    scannedRouteCount: routes.length,
    scannedChoiceCount: choices.length,
    driftedRoutes,
    driftedChoices,
    danglingChoices,
    markedStaleRouteCount,
    markedStaleChoiceCount,
  };
}

function collectRouteDrift(route: RouteMapRecord, currentHashes: Map<string, string>): string[] {
  const drifted: string[] = [];
  for (const citation of route.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  return drifted;
}

function collectChoiceDrift(
  choice: RouteChoiceRecord,
  currentHashes: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const citation of choice.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  for (const option of choice.options) {
    for (let index = 0; index < option.targetUnitIds.length; index += 1) {
      const id = option.targetUnitIds[index];
      const persistedHash = option.targetUnitHashes[index];
      if (!id || !persistedHash) {
        continue;
      }
      const current = currentHashes.get(id);
      if (current === undefined || current !== persistedHash) {
        drifted.push(id);
      }
    }
  }
  return drifted;
}
