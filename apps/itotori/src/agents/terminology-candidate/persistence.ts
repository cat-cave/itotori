import type {
  AuthorizationActor,
  ItotoriTerminologyCandidateRepositoryPort,
  SaveTerminologyCandidateInput,
  TerminologyCandidateRecord,
} from "@itotori/db";
import type { TerminologyCandidate } from "./shapes.js";

/**
 * ITOTORI-220 — sentinel providerId surfaced when reconstructing a model
 * profile from a legacy terminology-candidate persistence record. The
 * terminology-candidate table does not yet carry a provider_id column
 * (out of scope for ITOTORI-220); new invocations always pin a
 * providerId explicitly on the way in.
 */
const RECONSTRUCTED_LEGACY_PROVIDER_ID = "unknown";

export function candidateToSaveInput(
  candidate: TerminologyCandidate,
): SaveTerminologyCandidateInput {
  if (candidate.citedUnitIds.length === 0) {
    throw new Error(`terminology candidate ${candidate.id} cites no units`);
  }
  if (candidate.citedUnitIds.length !== candidate.citedUnitHashes.length) {
    throw new Error(
      `terminology candidate ${candidate.id} citation arrays mismatched: ${candidate.citedUnitIds.length} vs ${candidate.citedUnitHashes.length}`,
    );
  }
  return {
    terminologyCandidateId: candidate.id,
    projectId: candidate.projectId,
    localeBranchId: candidate.localeBranchId,
    sourceRevisionId: candidate.sourceRevisionId,
    kind: candidate.kind,
    surfaceForm: candidate.surfaceForm,
    surfaceLocale: candidate.surfaceLocale,
    rationale: candidate.rationale,
    readingHint: candidate.readingHint ?? null,
    modelProviderFamily: candidate.modelProfile.providerFamily,
    modelId: candidate.modelProfile.modelId,
    modelContextWindowTokens: candidate.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: candidate.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: candidate.promptTemplateVersion,
    promptHash: candidate.promptHash,
    inputTokenEstimate: candidate.inputTokenEstimate,
    completionTokens: candidate.completionTokens,
    generatedAt: new Date(candidate.generatedAt),
    citations: candidate.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = candidate.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(
          `terminology candidate ${candidate.id} citation ${bridgeUnitId} missing source hash`,
        );
      }
      return {
        bridgeUnitId,
        citedSourceHash: sourceHash,
        citeOrdinal: index + 1,
      };
    }),
  };
}

export function recordToCandidate(record: TerminologyCandidateRecord): TerminologyCandidate {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.terminologyCandidateId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    kind: record.kind,
    surfaceForm: record.surfaceForm,
    surfaceLocale: record.surfaceLocale,
    rationale: record.rationale,
    ...(record.readingHint ? { readingHint: record.readingHint } : {}),
    citedUnitIds: sortedCitations.map((c) => c.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((c) => c.citedSourceHash),
    ...(record.conflictingTerminologyTermId
      ? { conflictingTerminologyTermId: record.conflictingTerminologyTermId }
      : {}),
    modelProfile: {
      providerFamily:
        record.modelProviderFamily as TerminologyCandidate["modelProfile"]["providerFamily"],
      modelId: record.modelId,
      providerId: RECONSTRUCTED_LEGACY_PROVIDER_ID,
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

export async function persistTerminologyCandidate(
  repository: ItotoriTerminologyCandidateRepositoryPort,
  actor: AuthorizationActor,
  candidate: TerminologyCandidate,
): Promise<TerminologyCandidate> {
  const saved = await repository.saveCandidate(actor, candidateToSaveInput(candidate));
  return recordToCandidate(saved);
}
