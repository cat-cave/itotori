import type {
  AuthorizationActor,
  CharacterBioRecord,
  CharacterRelationshipInvalidatedReason,
  CharacterRelationshipRecord,
  ItotoriCharacterRelationshipRepositoryPort,
} from "@itotori/db";

export type CharacterBioDrift = {
  characterBioId: string;
  characterId: string;
  driftedBridgeUnitIds: string[];
};

export type CharacterRelationshipDrift = {
  characterRelationshipId: string;
  fromCharacterId: string;
  toCharacterId: string;
  driftedBridgeUnitIds: string[];
};

export type CharacterStalenessScanInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  reason?: CharacterRelationshipInvalidatedReason;
  markStale?: boolean;
};

export type CharacterStalenessScanResult = {
  scannedBioCount: number;
  scannedRelationshipCount: number;
  driftedBios: CharacterBioDrift[];
  driftedRelationships: CharacterRelationshipDrift[];
  markedStaleBioCount: number;
  markedStaleRelationshipCount: number;
};

/**
 * Scan all `Fresh` character bios + relationships for a (project,
 * localeBranch, sourceRevision) triple. Compare each record's persisted
 * citation hashes against the current `itotori_source_units.source_hash`.
 * Any mismatch -> stale.
 *
 * The scan is exposed both as the project-workflow re-plan hook and as
 * the CLI `check-character-relationships` entry point.
 */
export async function markStaleCharacterArtifactsForRevision(
  repository: ItotoriCharacterRelationshipRepositoryPort,
  actor: AuthorizationActor,
  input: CharacterStalenessScanInput,
): Promise<CharacterStalenessScanResult> {
  const reason: CharacterRelationshipInvalidatedReason = input.reason ?? "source_hash_drift";
  const markStale = input.markStale ?? true;

  const bios = await repository.loadBios(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });
  const relationships = await repository.loadRelationshipsByProject(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });

  const bridgeUnitIds = new Set<string>();
  for (const bio of bios) {
    for (const citation of bio.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
  }
  for (const rel of relationships) {
    for (const citation of rel.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
  }
  const currentHashes =
    bridgeUnitIds.size === 0
      ? new Map<string, string>()
      : await repository.currentSourceHashesForBridgeUnits(actor, {
          bridgeUnitIds: [...bridgeUnitIds],
        });

  const driftedBios: CharacterBioDrift[] = [];
  for (const bio of bios) {
    const drifted = collectBioDriftedUnits(bio, currentHashes);
    if (drifted.length > 0) {
      driftedBios.push({
        characterBioId: bio.characterBioId,
        characterId: bio.characterId,
        driftedBridgeUnitIds: drifted,
      });
    }
  }

  const driftedRelationships: CharacterRelationshipDrift[] = [];
  for (const rel of relationships) {
    const drifted = collectRelationshipDriftedUnits(rel, currentHashes);
    if (drifted.length > 0) {
      driftedRelationships.push({
        characterRelationshipId: rel.characterRelationshipId,
        fromCharacterId: rel.fromCharacterId,
        toCharacterId: rel.toCharacterId,
        driftedBridgeUnitIds: drifted,
      });
    }
  }

  let markedStaleBioCount = 0;
  let markedStaleRelationshipCount = 0;
  if (markStale) {
    for (const drift of driftedBios) {
      await repository.markBioStale(actor, {
        characterBioId: drift.characterBioId,
        reason,
      });
      markedStaleBioCount += 1;
    }
    for (const drift of driftedRelationships) {
      await repository.markRelationshipStale(actor, {
        characterRelationshipId: drift.characterRelationshipId,
        reason,
      });
      markedStaleRelationshipCount += 1;
    }
  }

  return {
    scannedBioCount: bios.length,
    scannedRelationshipCount: relationships.length,
    driftedBios,
    driftedRelationships,
    markedStaleBioCount,
    markedStaleRelationshipCount,
  };
}

function collectBioDriftedUnits(
  bio: CharacterBioRecord,
  currentHashes: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const citation of bio.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  return drifted;
}

function collectRelationshipDriftedUnits(
  rel: CharacterRelationshipRecord,
  currentHashes: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const citation of rel.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  return drifted;
}
