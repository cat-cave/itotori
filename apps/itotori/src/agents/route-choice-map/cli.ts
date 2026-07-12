import type { AuthorizationActor, ItotoriContextArtifactRepositoryPort } from "@itotori/db";
import { contextArtifactCategoryValues } from "@itotori/db";
import type { ModelProvider, ProviderFamily } from "../../providers/types.js";
import {
  resolveSemanticAgentProvider,
  type SemanticAgentLiveProviderOptions,
} from "../../providers/fake.js";
import { generateRouteChoiceMap, type GenerateRouteChoiceMapOptions } from "./agent.js";
import {
  artifactDataString,
  artifactIsActiveForTemplate,
  loadSemanticArtifacts,
  persistRouteChoiceInContext,
  persistRouteMapInContext,
} from "../semantic-context-store.js";
import { PROMPT_TEMPLATE_VERSION_V1 } from "./prompt-template.js";
import type {
  BridgeUnitForRouteMap,
  CuratedRouteRef,
  RouteChoice,
  RouteChoiceMapInput,
  RouteChoiceMapModelProfile,
  RouteMap,
} from "./shapes.js";

export type GenerateRouteMapsCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  sourceRevisionId: string;
  modelProfile: RouteChoiceMapModelProfile;
  routeKeyFilter?: string | undefined;
  includeStale?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type CheckRouteMapsCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  markStale?: boolean | undefined;
};

export type GenerateRouteMapsCliResult = {
  routes: RouteMap[];
  choices: RouteChoice[];
  generatedRouteCount: number;
  generatedChoiceCount: number;
  skippedFreshRouteCount: number;
};

export type RouteChoiceMapCliDependencies = {
  actor: AuthorizationActor;
  contextArtifactRepository: ItotoriContextArtifactRepositoryPort;
  provider: ModelProvider;
  loadInputContext: (
    actor: AuthorizationActor,
    args: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
    },
  ) => Promise<{
    units: BridgeUnitForRouteMap[];
    curatedRoutes: CuratedRouteRef[];
  }>;
  log?: (message: string) => void;
  now?: () => Date;
};

/**
 * Construct the provider for the route-choice-map CLI. The `fake` family is
 * reachable ONLY via the explicit `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1`
 * test/dev opt-in. The `openrouter` family is the LIVE path: a real, ZDR-gated
 * `OpenRouterModelProvider` (config-driven pair, cost from real `usage.cost`).
 * Any other non-fake family loud-refuses with a typed error — a real run
 * therefore never feeds fake-derived route/choice maps into real translation
 * context.
 */
export function resolveRouteChoiceMapProvider(
  family: ProviderFamily,
  live?: SemanticAgentLiveProviderOptions,
): ModelProvider {
  return resolveSemanticAgentProvider({
    agentName: "route-choice-map",
    family,
    fakeProviderName: "itotori-route-choice-map-fake",
    ...(live !== undefined ? { live } : {}),
  });
}

export async function runGenerateRouteMapsCli(
  input: GenerateRouteMapsCliInput,
  deps: RouteChoiceMapCliDependencies,
): Promise<GenerateRouteMapsCliResult> {
  const log = deps.log ?? noopLog;
  const context = await deps.loadInputContext(deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
  });

  // Skip routes that already have a Fresh map for this template version
  // unless --include-stale is set.
  let skippedFreshRouteCount = 0;
  const routesToInclude = new Set<string>();
  for (const ref of context.curatedRoutes) {
    if (ref.routeKey.trim().length > 0) {
      routesToInclude.add(ref.routeKey);
    }
  }
  for (const unit of context.units) {
    if (unit.routeKey && unit.routeKey.trim().length > 0) {
      routesToInclude.add(unit.routeKey);
    }
  }
  const routeKeyFilter = input.routeKeyFilter;
  if (routeKeyFilter !== undefined) {
    for (const key of routesToInclude) {
      if (key !== routeKeyFilter) {
        routesToInclude.delete(key);
      }
    }
  }

  if (!input.includeStale) {
    const existingArtifacts = await loadSemanticArtifacts(
      { actor: deps.actor, repository: deps.contextArtifactRepository },
      {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        categories: [contextArtifactCategoryValues.routeMap],
      },
    );
    const freshKeys = new Set(
      existingArtifacts.flatMap((artifact) => {
        const routeKey = artifactDataString(artifact, "routeKey");
        return routeKey !== undefined &&
          artifactIsActiveForTemplate(artifact, PROMPT_TEMPLATE_VERSION_V1)
          ? [routeKey]
          : [];
      }),
    );
    for (const routeKey of routesToInclude) {
      if (freshKeys.has(routeKey)) {
        routesToInclude.delete(routeKey);
        skippedFreshRouteCount += 1;
        log(`skip-fresh routeKey=${routeKey}`);
      }
    }
  }

  if (routesToInclude.size === 0) {
    return {
      routes: [],
      choices: [],
      generatedRouteCount: 0,
      generatedChoiceCount: 0,
      skippedFreshRouteCount,
    };
  }

  const agentInput: RouteChoiceMapInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    sourceLocale: input.sourceLocale,
    units: context.units,
    curatedRoutes: context.curatedRoutes,
    modelProfile: input.modelProfile,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const options: GenerateRouteChoiceMapOptions = { provider: deps.provider };
  const output = await generateRouteChoiceMap(agentInput, options);

  const finalRoutes: RouteMap[] = [];
  for (const route of output.routes) {
    if (!routesToInclude.has(route.routeKey)) {
      continue;
    }
    if (input.dryRun) {
      finalRoutes.push(route);
    } else {
      finalRoutes.push(
        await persistRouteMapInContext(
          { actor: deps.actor, repository: deps.contextArtifactRepository },
          route,
        ),
      );
    }
    log(
      `route routeKey=${route.routeKey} routeMapId=${route.id} cited=${route.citedUnitIds.length}`,
    );
  }
  const finalChoices: RouteChoice[] = [];
  for (const choice of output.choices) {
    if (choice.fromRouteKey && !routesToInclude.has(choice.fromRouteKey)) {
      continue;
    }
    if (input.dryRun) {
      finalChoices.push(choice);
    } else {
      finalChoices.push(
        await persistRouteChoiceInContext(
          { actor: deps.actor, repository: deps.contextArtifactRepository },
          choice,
        ),
      );
    }
    log(
      `choice choiceKey=${choice.choiceKey} kind=${choice.kind} cited=${choice.citedUnitIds.length} options=${choice.options.length}`,
    );
  }

  return {
    routes: finalRoutes,
    choices: finalChoices,
    generatedRouteCount: finalRoutes.length,
    generatedChoiceCount: finalChoices.length,
    skippedFreshRouteCount,
  };
}

export async function runCheckRouteMapsCli(
  input: CheckRouteMapsCliInput,
  deps: RouteChoiceMapCliDependencies,
): Promise<CentralRouteCheckResult> {
  const log = deps.log ?? noopLog;
  const artifacts = await loadSemanticArtifacts(
    { actor: deps.actor, repository: deps.contextArtifactRepository },
    {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      categories: [contextArtifactCategoryValues.routeMap],
    },
  );
  const invalidated =
    input.markStale === true
      ? await deps.contextArtifactRepository.invalidateAffectedArtifacts(deps.actor, {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          reason: "standalone_cli_check",
        })
      : undefined;
  const invalidatedSet = new Set(invalidated?.invalidatedArtifactIds ?? []);
  const routeArtifacts = artifacts.filter((artifact) => typeof artifact.data.routeKey === "string");
  const choiceArtifacts = artifacts.filter(
    (artifact) => typeof artifact.data.choiceKey === "string",
  );
  const result: CentralRouteCheckResult = {
    scannedRouteCount: routeArtifacts.length,
    scannedChoiceCount: choiceArtifacts.length,
    driftedRoutes: routeArtifacts
      .filter((artifact) => invalidatedSet.has(artifact.contextArtifactId))
      .map((artifact) => ({
        routeKey: String(artifact.data.routeKey),
        routeMapId: artifact.contextArtifactId,
        driftedBridgeUnitIds: artifact.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId),
      })),
    driftedChoices: choiceArtifacts
      .filter((artifact) => invalidatedSet.has(artifact.contextArtifactId))
      .map((artifact) => ({
        choiceKey: String(artifact.data.choiceKey),
        routeChoiceId: artifact.contextArtifactId,
        driftedBridgeUnitIds: artifact.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId),
      })),
    danglingChoices: [],
    markedStaleRouteCount: routeArtifacts.filter((artifact) =>
      invalidatedSet.has(artifact.contextArtifactId),
    ).length,
    markedStaleChoiceCount: choiceArtifacts.filter((artifact) =>
      invalidatedSet.has(artifact.contextArtifactId),
    ).length,
  };
  log(
    `scanned routes=${result.scannedRouteCount} choices=${result.scannedChoiceCount} ` +
      `drifted routes=${result.driftedRoutes.length} choices=${result.driftedChoices.length} ` +
      `dangling choices=${result.danglingChoices.length} ` +
      `marked-stale routes=${result.markedStaleRouteCount} choices=${result.markedStaleChoiceCount}`,
  );
  for (const drift of result.driftedRoutes) {
    log(
      `drift route routeKey=${drift.routeKey} routeMapId=${drift.routeMapId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  for (const drift of result.driftedChoices) {
    log(
      `drift choice choiceKey=${drift.choiceKey} routeChoiceId=${drift.routeChoiceId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  for (const dangling of result.danglingChoices) {
    log(
      `dangling choice choiceKey=${dangling.choiceKey} routeChoiceId=${dangling.routeChoiceId} targetRouteKey=${dangling.targetRouteKey}`,
    );
  }
  return result;
}

export type CentralRouteCheckResult = {
  scannedRouteCount: number;
  scannedChoiceCount: number;
  driftedRoutes: Array<{
    routeKey: string;
    routeMapId: string;
    driftedBridgeUnitIds: string[];
  }>;
  driftedChoices: Array<{
    choiceKey: string;
    routeChoiceId: string;
    driftedBridgeUnitIds: string[];
  }>;
  danglingChoices: Array<{
    choiceKey: string;
    routeChoiceId: string;
    targetRouteKey: string;
  }>;
  markedStaleRouteCount: number;
  markedStaleChoiceCount: number;
};

function noopLog(_message: string): void {
  // intentionally empty
}
