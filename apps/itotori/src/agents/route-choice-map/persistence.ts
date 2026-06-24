import type {
  AuthorizationActor,
  ItotoriRouteChoiceMapRepositoryPort,
  RouteChoiceOptionRecord,
  RouteChoiceRecord,
  RouteMapRecord,
  SaveRouteChoiceInput,
  SaveRouteMapInput,
} from "@itotori/db";
import type { RouteChoice, RouteMap } from "./shapes.js";

export function routeMapToSaveInput(routeMap: RouteMap): SaveRouteMapInput {
  if (routeMap.citedUnitIds.length === 0) {
    throw new Error(`route map ${routeMap.id} cites no units`);
  }
  if (routeMap.citedUnitIds.length !== routeMap.citedUnitHashes.length) {
    throw new Error(
      `route map ${routeMap.id} citation arrays mismatched: ${routeMap.citedUnitIds.length} vs ${routeMap.citedUnitHashes.length}`,
    );
  }
  return {
    routeMapId: routeMap.id,
    projectId: routeMap.projectId,
    localeBranchId: routeMap.localeBranchId,
    sourceRevisionId: routeMap.sourceRevisionId,
    routeKey: routeMap.routeKey,
    routeTitle: routeMap.routeTitle,
    mapLocale: routeMap.mapLocale,
    routeSummary: routeMap.routeSummary,
    modelProviderFamily: routeMap.modelProfile.providerFamily,
    modelId: routeMap.modelProfile.modelId,
    modelContextWindowTokens: routeMap.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: routeMap.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: routeMap.promptTemplateVersion,
    promptHash: routeMap.promptHash,
    inputTokenEstimate: routeMap.inputTokenEstimate,
    completionTokens: routeMap.completionTokens,
    generatedAt: new Date(routeMap.generatedAt),
    citations: routeMap.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = routeMap.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(`route map ${routeMap.id} citation ${bridgeUnitId} missing source hash`);
      }
      return {
        bridgeUnitId,
        citedSourceHash: sourceHash,
        citeOrdinal: index + 1,
      };
    }),
  };
}

export function routeChoiceToSaveInput(choice: RouteChoice): SaveRouteChoiceInput {
  if (choice.citedUnitIds.length === 0) {
    throw new Error(`route choice ${choice.id} cites no units`);
  }
  if (choice.citedUnitIds.length !== choice.citedUnitHashes.length) {
    throw new Error(
      `route choice ${choice.id} citation arrays mismatched: ${choice.citedUnitIds.length} vs ${choice.citedUnitHashes.length}`,
    );
  }
  return {
    routeChoiceId: choice.id,
    projectId: choice.projectId,
    localeBranchId: choice.localeBranchId,
    sourceRevisionId: choice.sourceRevisionId,
    choiceKey: choice.choiceKey,
    kind: choice.kind,
    fromRouteKey: choice.fromRouteKey ?? null,
    promptSummary: choice.promptSummary,
    mapLocale: choice.mapLocale,
    options: choice.options.map((option) => ({
      optionId: option.optionId,
      optionIndex: option.optionIndex,
      optionLabel: option.optionLabel,
      targetRouteKey: option.targetRouteKey ?? null,
      targetUnitIds: option.targetUnitIds,
      targetUnitHashes: option.targetUnitHashes,
    })),
    modelProviderFamily: choice.modelProfile.providerFamily,
    modelId: choice.modelProfile.modelId,
    modelContextWindowTokens: choice.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: choice.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: choice.promptTemplateVersion,
    promptHash: choice.promptHash,
    generatedAt: new Date(choice.generatedAt),
    citations: choice.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = choice.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(`route choice ${choice.id} citation ${bridgeUnitId} missing source hash`);
      }
      return {
        bridgeUnitId,
        citedSourceHash: sourceHash,
        citeOrdinal: index + 1,
      };
    }),
  };
}

export function recordToRouteMap(record: RouteMapRecord): RouteMap {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.routeMapId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    routeKey: record.routeKey,
    routeTitle: record.routeTitle,
    mapLocale: record.mapLocale,
    routeSummary: record.routeSummary,
    citedUnitIds: sortedCitations.map((c) => c.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((c) => c.citedSourceHash),
    modelProfile: {
      providerFamily: record.modelProviderFamily as RouteMap["modelProfile"]["providerFamily"],
      modelId: record.modelId,
      contextWindowTokens: record.modelContextWindowTokens,
      maxOutputTokens: record.modelMaxOutputTokens ?? undefined,
    },
    promptTemplateVersion: record.promptTemplateVersion,
    promptHash: record.promptHash,
    inputTokenEstimate: record.inputTokenEstimate,
    completionTokens: record.completionTokens,
    generatedAt: record.generatedAt.toISOString(),
    status: record.status,
    ...(record.invalidatedAt ? { invalidatedAt: record.invalidatedAt.toISOString() } : {}),
    ...(record.invalidatedReason ? { invalidatedReason: record.invalidatedReason } : {}),
  };
}

export function recordToRouteChoice(record: RouteChoiceRecord): RouteChoice {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.routeChoiceId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    choiceKey: record.choiceKey,
    kind: record.kind,
    ...(record.fromRouteKey ? { fromRouteKey: record.fromRouteKey } : {}),
    promptSummary: record.promptSummary,
    mapLocale: record.mapLocale,
    citedUnitIds: sortedCitations.map((c) => c.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((c) => c.citedSourceHash),
    options: record.options.map(optionRecordToOption),
    modelProfile: {
      providerFamily: record.modelProviderFamily as RouteChoice["modelProfile"]["providerFamily"],
      modelId: record.modelId,
      contextWindowTokens: record.modelContextWindowTokens,
      maxOutputTokens: record.modelMaxOutputTokens ?? undefined,
    },
    promptTemplateVersion: record.promptTemplateVersion,
    promptHash: record.promptHash,
    generatedAt: record.generatedAt.toISOString(),
    status: record.status,
    ...(record.invalidatedAt ? { invalidatedAt: record.invalidatedAt.toISOString() } : {}),
    ...(record.invalidatedReason ? { invalidatedReason: record.invalidatedReason } : {}),
  };
}

function optionRecordToOption(option: RouteChoiceOptionRecord): RouteChoice["options"][number] {
  return {
    optionId: option.optionId,
    optionIndex: option.optionIndex,
    optionLabel: option.optionLabel,
    ...(option.targetRouteKey ? { targetRouteKey: option.targetRouteKey } : {}),
    targetUnitIds: option.targetUnitIds,
    targetUnitHashes: option.targetUnitHashes,
  };
}

export async function persistRouteMap(
  repository: ItotoriRouteChoiceMapRepositoryPort,
  actor: AuthorizationActor,
  routeMap: RouteMap,
): Promise<RouteMap> {
  const saved = await repository.saveRouteMap(actor, routeMapToSaveInput(routeMap));
  return recordToRouteMap(saved);
}

export async function persistRouteChoice(
  repository: ItotoriRouteChoiceMapRepositoryPort,
  actor: AuthorizationActor,
  choice: RouteChoice,
): Promise<RouteChoice> {
  const saved = await repository.saveRouteChoice(actor, routeChoiceToSaveInput(choice));
  return recordToRouteChoice(saved);
}
