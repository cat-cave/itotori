import type { AuthorizationActor } from "../authorization.js";
import {
  translationMemoryServiceVersion,
  type ItotoriTranslationMemoryRepositoryPort,
  type PrefillTranslationMemoryDraftsInput,
  type TranslationMemoryDiagnostic,
  type TranslationMemoryPrefillResult,
  type TranslationMemoryPrefillReuse,
  type TranslationMemoryPrefillSkip,
} from "./translation-memory-repository-types.js";

export class ItotoriTranslationMemoryService {
  constructor(private readonly repository: ItotoriTranslationMemoryRepositoryPort) {}

  async prefillDrafts(
    actor: AuthorizationActor,
    input: PrefillTranslationMemoryDraftsInput,
  ): Promise<TranslationMemoryPrefillResult> {
    const applyDrafts = input.applyDrafts ?? true;
    const targets = await this.repository.listPrefillTargets({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      ...(input.bridgeUnitIds === undefined ? {} : { bridgeUnitIds: input.bridgeUnitIds }),
      ...(input.includeExistingTargets === undefined
        ? {}
        : { includeExistingTargets: input.includeExistingTargets }),
    });
    if (
      input.bridgeUnitIds !== undefined &&
      input.bridgeUnitIds.length > 0 &&
      targets.length === 0
    ) {
      return invalidPrefill(
        diagnostic(
          "translation_memory.locale_branch_or_units.missing",
          "error",
          "no current locale branch source units matched the prefill request",
          "missing_current_branch_units",
          "$.bridgeUnitIds",
          {
            projectId: input.projectId,
            localeBranchId: input.localeBranchId,
            bridgeUnitIds: [...input.bridgeUnitIds],
          },
        ),
      );
    }

    const reuses: TranslationMemoryPrefillReuse[] = [];
    const skipped: TranslationMemoryPrefillSkip[] = [];
    const diagnostics: TranslationMemoryDiagnostic[] = [];

    for (const target of targets) {
      if (target.currentTargetText !== null && input.includeExistingTargets === true) {
        skipped.push({ target, reasonCode: "existing_target_text" });
        continue;
      }
      if (target.targetLocale !== input.requestedTargetLocale) {
        skipped.push({ target, reasonCode: "target_locale_mismatch" });
        continue;
      }

      const matchSet = await this.repository.findReusableSegments({
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        requestedTargetLocale: input.requestedTargetLocale,
        targetBridgeUnitId: target.bridgeUnitId,
        ...(input.includeFuzzy === undefined ? {} : { includeFuzzy: input.includeFuzzy }),
        ...(input.minFuzzyScore === undefined ? {} : { minFuzzyScore: input.minFuzzyScore }),
        ...(input.candidateLimit === undefined ? {} : { candidateLimit: input.candidateLimit }),
        ...(input.scoredCandidateLimit === undefined
          ? {}
          : { scoredCandidateLimit: input.scoredCandidateLimit }),
      });
      const match = matchSet?.matches[0];
      if (match === undefined) {
        skipped.push({ target, reasonCode: "no_reusable_segment" });
        continue;
      }

      const event = await this.repository.recordReuse(actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        requestedTargetLocale: input.requestedTargetLocale,
        targetBridgeUnitId: target.bridgeUnitId,
        memorySegmentId: match.memorySegmentId,
        matchKind: match.matchKind,
        matchScore: match.matchScore,
        applyDraft: applyDrafts,
        provenance: {
          schemaVersion: translationMemoryServiceVersion,
          requestId: input.requestId ?? null,
          selectedMemorySegmentId: match.memorySegmentId,
          selectedSourceBridgeUnitId: match.sourceBridgeUnitId,
          selectedSourceUnitKey: match.sourceUnitKey,
          selectedSourceOccurrenceId: match.sourceOccurrenceId,
          targetSourceUnitKey: target.sourceUnitKey,
        },
      });
      reuses.push({ target, match, event });
    }

    if (skipped.length > 0) {
      diagnostics.push(
        diagnostic(
          "translation_memory.prefill.skipped_units",
          "info",
          "some current source units had no applicable translation memory prefill",
          "skipped_units",
          undefined,
          {
            skippedCount: skipped.length,
            reasons: skipped.map((entry) => entry.reasonCode),
          },
        ),
      );
    }

    return {
      status: "completed",
      diagnostics,
      appliedCount: applyDrafts ? reuses.length : 0,
      suggestedCount: applyDrafts ? 0 : reuses.length,
      skippedCount: skipped.length,
      reuses,
      skipped,
    };
  }
}

function diagnostic(
  code: string,
  severity: TranslationMemoryDiagnostic["severity"],
  message: string,
  reasonCode: string,
  field?: string,
  metadata?: Record<string, unknown>,
): TranslationMemoryDiagnostic {
  return {
    code,
    severity,
    message,
    reasonCode,
    ...(field === undefined ? {} : { field }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function invalidPrefill(
  diagnosticEntry: TranslationMemoryDiagnostic,
): TranslationMemoryPrefillResult {
  return {
    status: "invalid",
    diagnostics: [diagnosticEntry],
    appliedCount: 0,
    suggestedCount: 0,
    skippedCount: 0,
    reuses: [],
    skipped: [],
  };
}
