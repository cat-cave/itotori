import {
  translationBatchContextRefInclusionReasonValues,
  translationBatchContextRefKindValues,
  type ItotoriTranslationBatchRepositoryPort,
  type SaveTranslationBatchInput,
  type SaveTranslationBatchesInput,
  type TranslationBatchContextRefRecord,
  type TranslationBatchRecord,
} from "@itotori/db";
import type { AuthorizationActor } from "@itotori/db";
import type { Batch, BatchContext } from "./shapes.js";

/**
 * Persist a planner output for a (projectId, localeBranchId, sourceRevisionId)
 * triple. Existing batches for the triple are cleared inside the repository
 * transaction so a re-plan is idempotent.
 */
export async function persistBatches(
  repository: ItotoriTranslationBatchRepositoryPort,
  actor: AuthorizationActor,
  batches: Batch[],
  identity: {
    projectId: string;
    localeBranchId: string;
    sourceRevisionId: string;
  },
): Promise<TranslationBatchRecord[]> {
  const input: SaveTranslationBatchesInput = {
    projectId: identity.projectId,
    localeBranchId: identity.localeBranchId,
    sourceRevisionId: identity.sourceRevisionId,
    batches: batches.map(batchToSaveInput),
  };
  return repository.saveBatches(actor, input);
}

function batchToSaveInput(batch: Batch): SaveTranslationBatchInput {
  return {
    batchId: batch.id,
    batchOrdinal: batch.batchOrdinal,
    tokenEstimate: batch.tokenEstimate,
    tokenBudgetCap: batch.tokenBudgetCap,
    sceneId: batch.sceneId ?? null,
    sceneSplitIndex: batch.sceneSplitIndex ?? null,
    routeId: batch.routeId ?? null,
    modelProviderFamily: batch.modelProfile.providerFamily,
    modelId: batch.modelProfile.modelId,
    // ITOTORI-220 — thread the pinned provider half of the (modelId,
    // providerId) pair so it is persisted, not dropped, on every batch.
    providerId: batch.modelProfile.providerId,
    modelContextWindowTokens: batch.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: batch.modelProfile.maxOutputTokens ?? null,
    modelTargetFillRatio: batch.modelProfile.targetFillRatio,
    modelPromptOverheadTokens: batch.modelProfile.promptOverheadTokens,
    tokenEstimatorId: batch.modelProfile.tokenEstimatorId,
    nearCapWarning: batch.nearCapWarning,
    generatedAt: new Date(batch.generatedAt),
    units: batch.units.map((unit, index) => ({
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      unitOrdinal: index + 1,
    })),
    contextRefs: contextRefsFromContext(batch.context),
  };
}

function contextRefsFromContext(context: BatchContext): TranslationBatchContextRefRecord[] {
  const refs: TranslationBatchContextRefRecord[] = [];

  for (const term of context.glossaryTerms) {
    refs.push({
      refKind: translationBatchContextRefKindValues.glossaryTerm,
      refId: term.termId,
      refSecondaryId: "",
      inclusionReason: translationBatchContextRefInclusionReasonValues.hit,
      hitBridgeUnitIds: [...term.hitBridgeUnitIds],
      details: {
        termKey: term.termKey,
        preferredSourceForm: term.preferredSourceForm,
        preferredTargetForm: term.preferredTargetForm ?? null,
      },
    });
  }

  for (const rule of context.styleGuideRules) {
    refs.push({
      refKind: translationBatchContextRefKindValues.styleRule,
      refId: rule.ruleId,
      refSecondaryId: rule.styleGuideVersionId,
      inclusionReason:
        rule.inclusionReason === "always_on"
          ? translationBatchContextRefInclusionReasonValues.alwaysOn
          : rule.inclusionReason === "category_match"
            ? translationBatchContextRefInclusionReasonValues.categoryMatch
            : translationBatchContextRefInclusionReasonValues.explicitPin,
      hitBridgeUnitIds: null,
      details: {
        rulePath: rule.rulePath ?? null,
      },
    });
  }

  for (const character of context.characterRelationships) {
    refs.push({
      refKind: translationBatchContextRefKindValues.character,
      refId: character.termId,
      refSecondaryId: "",
      inclusionReason: translationBatchContextRefInclusionReasonValues.hit,
      hitBridgeUnitIds: [...character.appearsInBridgeUnitIds],
      details: {
        canonicalName: character.canonicalName,
        relationshipNotes: character.relationshipNotes ?? null,
      },
    });
  }

  if (context.sceneSummary) {
    refs.push({
      refKind: translationBatchContextRefKindValues.sceneSummary,
      refId: context.sceneSummary.contextArtifactId,
      refSecondaryId: context.sceneSummary.sceneId,
      inclusionReason: translationBatchContextRefInclusionReasonValues.hit,
      hitBridgeUnitIds: null,
      details: {
        contentHash: context.sceneSummary.contentHash,
      },
    });
  }

  for (const example of context.priorTranslationExamples) {
    refs.push({
      refKind: translationBatchContextRefKindValues.priorExample,
      refId: example.bridgeUnitId,
      refSecondaryId: example.translationMemorySegmentId ?? "",
      inclusionReason:
        example.similarityReason === "same_speaker"
          ? translationBatchContextRefInclusionReasonValues.sameSpeaker
          : example.similarityReason === "same_scene"
            ? translationBatchContextRefInclusionReasonValues.sameScene
            : translationBatchContextRefInclusionReasonValues.sameSurfaceKind,
      hitBridgeUnitIds: null,
      details: {},
    });
  }

  if (context.citationManifest.sourceUnitKeyPrefix !== undefined) {
    refs.push({
      refKind: translationBatchContextRefKindValues.sourceUnitKeyPrefix,
      refId: context.citationManifest.sourceUnitKeyPrefix,
      refSecondaryId: "",
      inclusionReason: translationBatchContextRefInclusionReasonValues.fallbackGrouping,
      hitBridgeUnitIds: null,
      details: {},
    });
  }

  return refs;
}
