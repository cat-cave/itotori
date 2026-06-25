import type {
  AuthorizationActor,
  CharacterBioRecord,
  CharacterRelationshipRecord,
  ItotoriCharacterRelationshipRepositoryPort,
  SaveCharacterBioInput,
  SaveCharacterRelationshipInput,
} from "@itotori/db";
import type { CharacterBio, CharacterRelationship } from "./shapes.js";

/**
 * ITOTORI-220 — sentinel providerId surfaced when reconstructing a model
 * profile from a legacy persistence record. The character-relationship
 * persistence tables do not yet carry a provider_id column (out of scope
 * for ITOTORI-220; the ledger is the load-bearing surface), so old
 * records cannot be roundtripped with their original providerId. New
 * invocations always pin a providerId explicitly on the way in.
 */
const RECONSTRUCTED_LEGACY_PROVIDER_ID = "unknown";

export function bioToSaveInput(bio: CharacterBio): SaveCharacterBioInput {
  if (bio.citedUnitIds.length === 0) {
    throw new Error(`character bio ${bio.id} cites no units`);
  }
  if (bio.citedUnitIds.length !== bio.citedUnitHashes.length) {
    throw new Error(
      `character bio ${bio.id} citation arrays mismatched: ${bio.citedUnitIds.length} vs ${bio.citedUnitHashes.length}`,
    );
  }
  return {
    characterBioId: bio.id,
    projectId: bio.projectId,
    localeBranchId: bio.localeBranchId,
    sourceRevisionId: bio.sourceRevisionId,
    characterId: bio.characterId,
    bioLocale: bio.bioLocale,
    bioText: bio.bioText,
    modelProviderFamily: bio.modelProfile.providerFamily,
    modelId: bio.modelProfile.modelId,
    modelContextWindowTokens: bio.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: bio.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: bio.promptTemplateVersion,
    promptHash: bio.promptHash,
    inputTokenEstimate: bio.inputTokenEstimate,
    completionTokens: bio.completionTokens,
    generatedAt: new Date(bio.generatedAt),
    citations: bio.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = bio.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(`character bio ${bio.id} citation ${bridgeUnitId} missing source hash`);
      }
      return {
        bridgeUnitId,
        citedSourceHash: sourceHash,
        citeOrdinal: index + 1,
      };
    }),
  };
}

export function relationshipToSaveInput(
  relationship: CharacterRelationship,
): SaveCharacterRelationshipInput {
  if (relationship.citedUnitIds.length === 0) {
    throw new Error(`character relationship ${relationship.id} cites no units`);
  }
  if (relationship.citedUnitIds.length !== relationship.citedUnitHashes.length) {
    throw new Error(
      `character relationship ${relationship.id} citation arrays mismatched: ${relationship.citedUnitIds.length} vs ${relationship.citedUnitHashes.length}`,
    );
  }
  return {
    characterRelationshipId: relationship.id,
    projectId: relationship.projectId,
    localeBranchId: relationship.localeBranchId,
    sourceRevisionId: relationship.sourceRevisionId,
    fromCharacterId: relationship.fromCharacterId,
    toCharacterId: relationship.toCharacterId,
    kind: relationship.kind,
    direction: relationship.direction,
    descriptor: relationship.descriptor,
    descriptorLocale: relationship.descriptorLocale,
    modelProviderFamily: relationship.modelProfile.providerFamily,
    modelId: relationship.modelProfile.modelId,
    modelContextWindowTokens: relationship.modelProfile.contextWindowTokens,
    modelMaxOutputTokens: relationship.modelProfile.maxOutputTokens ?? null,
    promptTemplateVersion: relationship.promptTemplateVersion,
    promptHash: relationship.promptHash,
    generatedAt: new Date(relationship.generatedAt),
    citations: relationship.citedUnitIds.map((bridgeUnitId, index) => {
      const sourceHash = relationship.citedUnitHashes[index];
      if (!sourceHash) {
        throw new Error(
          `character relationship ${relationship.id} citation ${bridgeUnitId} missing source hash`,
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

export function recordToBio(record: CharacterBioRecord): CharacterBio {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.characterBioId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    characterId: record.characterId,
    bioLocale: record.bioLocale,
    bioText: record.bioText,
    citedUnitIds: sortedCitations.map((citation) => citation.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((citation) => citation.citedSourceHash),
    modelProfile: {
      providerFamily: record.modelProviderFamily as CharacterBio["modelProfile"]["providerFamily"],
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

export function recordToRelationship(record: CharacterRelationshipRecord): CharacterRelationship {
  const sortedCitations = [...record.citations].sort((a, b) => a.citeOrdinal - b.citeOrdinal);
  return {
    id: record.characterRelationshipId,
    projectId: record.projectId,
    localeBranchId: record.localeBranchId,
    sourceRevisionId: record.sourceRevisionId,
    fromCharacterId: record.fromCharacterId,
    toCharacterId: record.toCharacterId,
    kind: record.kind,
    direction: record.direction,
    descriptor: record.descriptor,
    descriptorLocale: record.descriptorLocale,
    citedUnitIds: sortedCitations.map((citation) => citation.bridgeUnitId),
    citedUnitHashes: sortedCitations.map((citation) => citation.citedSourceHash),
    modelProfile: {
      providerFamily:
        record.modelProviderFamily as CharacterRelationship["modelProfile"]["providerFamily"],
      modelId: record.modelId,
      providerId: RECONSTRUCTED_LEGACY_PROVIDER_ID,
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

export async function persistCharacterBio(
  repository: ItotoriCharacterRelationshipRepositoryPort,
  actor: AuthorizationActor,
  bio: CharacterBio,
): Promise<CharacterBio> {
  const saved = await repository.saveBio(actor, bioToSaveInput(bio));
  return recordToBio(saved);
}

export async function persistCharacterRelationship(
  repository: ItotoriCharacterRelationshipRepositoryPort,
  actor: AuthorizationActor,
  relationship: CharacterRelationship,
): Promise<CharacterRelationship> {
  const saved = await repository.saveRelationship(actor, relationshipToSaveInput(relationship));
  return recordToRelationship(saved);
}
