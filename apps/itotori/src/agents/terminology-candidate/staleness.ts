import type {
  AuthorizationActor,
  ItotoriTerminologyCandidateRepositoryPort,
  TerminologyCandidateInvalidatedReason,
  TerminologyCandidateRecord,
} from "@itotori/db";

export type TerminologyCandidateDrift = {
  terminologyCandidateId: string;
  surfaceForm: string;
  driftedBridgeUnitIds: string[];
};

export type TerminologyCandidateConflict = {
  terminologyCandidateId: string;
  surfaceForm: string;
  terminologyTermId: string;
};

export type TerminologyCandidateStalenessScanInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  reason?: TerminologyCandidateInvalidatedReason;
  markStale?: boolean;
};

export type TerminologyCandidateStalenessScanResult = {
  scannedCandidateCount: number;
  driftedCandidates: TerminologyCandidateDrift[];
  conflictingCandidates: TerminologyCandidateConflict[];
  markedStaleCandidateCount: number;
  markedRejectedCandidateCount: number;
};

export async function markStaleTerminologyCandidatesForRevision(
  repository: ItotoriTerminologyCandidateRepositoryPort,
  actor: AuthorizationActor,
  input: TerminologyCandidateStalenessScanInput,
): Promise<TerminologyCandidateStalenessScanResult> {
  const reason: TerminologyCandidateInvalidatedReason = input.reason ?? "source_hash_drift";
  const markStale = input.markStale ?? true;

  const candidates = await repository.loadCandidatesByProject(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });

  const bridgeUnitIds = new Set<string>();
  for (const candidate of candidates) {
    for (const citation of candidate.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
  }
  const currentHashes =
    bridgeUnitIds.size === 0
      ? new Map<string, string>()
      : await repository.currentSourceHashesForBridgeUnits(actor, {
          bridgeUnitIds: [...bridgeUnitIds],
        });

  const driftedCandidates: TerminologyCandidateDrift[] = [];
  const conflictingCandidates: TerminologyCandidateConflict[] = [];

  for (const candidate of candidates) {
    const drifted = collectDrift(candidate, currentHashes);
    if (drifted.length > 0) {
      driftedCandidates.push({
        terminologyCandidateId: candidate.terminologyCandidateId,
        surfaceForm: candidate.surfaceForm,
        driftedBridgeUnitIds: drifted,
      });
      continue;
    }
    // Post-persist conflict re-scan: a curator may have inserted a
    // glossary term between persist time and the staleness scan.
    const conflictId = await repository.existsTerminologyTermBySurfaceForm(actor, {
      projectId: candidate.projectId,
      surfaceForm: candidate.surfaceForm,
    });
    if (conflictId !== null) {
      conflictingCandidates.push({
        terminologyCandidateId: candidate.terminologyCandidateId,
        surfaceForm: candidate.surfaceForm,
        terminologyTermId: conflictId,
      });
    }
  }

  let markedStaleCandidateCount = 0;
  let markedRejectedCandidateCount = 0;
  if (markStale) {
    for (const drift of driftedCandidates) {
      await repository.markCandidateStale(actor, {
        terminologyCandidateId: drift.terminologyCandidateId,
        reason,
      });
      markedStaleCandidateCount += 1;
    }
    for (const conflict of conflictingCandidates) {
      await repository.markCandidateRejected(actor, {
        terminologyCandidateId: conflict.terminologyCandidateId,
        reason: "glossary_conflict_post_persist",
      });
      markedRejectedCandidateCount += 1;
    }
  }

  return {
    scannedCandidateCount: candidates.length,
    driftedCandidates,
    conflictingCandidates,
    markedStaleCandidateCount,
    markedRejectedCandidateCount,
  };
}

function collectDrift(
  candidate: TerminologyCandidateRecord,
  currentHashes: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const citation of candidate.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  return drifted;
}
