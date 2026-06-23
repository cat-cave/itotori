import type {
  AuthorizationActor,
  ItotoriSceneSummaryRepositoryPort,
  SaveSceneSummaryInput,
  SceneSummaryRecord,
} from "@itotori/db";
import type { SceneSummary } from "./shapes.js";

export function summaryToSaveInput(summary: SceneSummary): SaveSceneSummaryInput {
  if (summary.citedUnitIds.length === 0) {
    throw new Error(`scene summary ${summary.id} cites no units`);
  }
  if (summary.citedUnitIds.length !== summary.citedUnitHashes.length) {
    throw new Error(
      `scene summary ${summary.id} citation arrays mismatched: ${summary.citedUnitIds.length} vs ${summary.citedUnitHashes.length}`,
    );
  }
  return {
    sceneSummaryId: summary.id,
    projectId: summary.projectId,
    localeBranchId: summary.localeBranchId,
    sourceRevisionId: summary.sourceRevisionId,
    sceneId: summary.sceneId,
    summaryLocale: summary.summaryLocale,
    summaryText: summary.summaryText,
    modelProviderFamily: summary.modelProfile.providerFamily,
    modelId: summary.modelProfile.modelId,
    modelContextWindowTokens: summary.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: summary.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: summary.promptTemplateVersion,
    promptHash: summary.promptHash,
    inputTokenEstimate: summary.inputTokenEstimate,
    completionTokens: summary.completionTokens,
    generatedAt: new Date(summary.generatedAt),
    citations: summary.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = summary.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(`scene summary ${summary.id} citation ${bridgeUnitId} missing source hash`);
      }
      return {
        bridgeUnitId,
        citedSourceHash: sourceHash,
        citeOrdinal: index + 1,
      };
    }),
  };
}

export function recordToSummary(record: SceneSummaryRecord): SceneSummary {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.sceneSummaryId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    sceneId: record.sceneId,
    summaryLocale: record.summaryLocale,
    summaryText: record.summaryText,
    citedUnitIds: sortedCitations.map((citation) => citation.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((citation) => citation.citedSourceHash),
    modelProfile: {
      providerFamily: record.modelProviderFamily as SceneSummary["modelProfile"]["providerFamily"],
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

export async function persistSceneSummary(
  repository: ItotoriSceneSummaryRepositoryPort,
  actor: AuthorizationActor,
  summary: SceneSummary,
): Promise<SceneSummary> {
  const saved = await repository.saveSummary(actor, summaryToSaveInput(summary));
  return recordToSummary(saved);
}
