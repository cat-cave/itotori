import type {
  AuthorizationActor,
  ItotoriSceneSummaryRepositoryPort,
  SceneSummaryInvalidatedReason,
  SceneSummaryRecord,
} from "@itotori/db";

export type SceneSummaryDrift = {
  sceneSummaryId: string;
  sceneId: string;
  driftedBridgeUnitIds: string[];
};

export type StalenessScanInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  /** Optional explicit reason for invalidation; defaults to source_hash_drift. */
  reason?: SceneSummaryInvalidatedReason;
  /** When false, returns drift candidates without writing. */
  markStale?: boolean;
};

export type StalenessScanResult = {
  scannedSummaryCount: number;
  driftedSummaries: SceneSummaryDrift[];
  markedStaleCount: number;
};

/**
 * Scan all `Fresh` scene summaries for a (project, locale branch, source
 * revision) triple. Compare each summary's persisted citation hashes against
 * the current `itotori_source_units.source_hash`. Any mismatch -> stale.
 */
export async function markStaleSummariesForRevision(
  repository: ItotoriSceneSummaryRepositoryPort,
  actor: AuthorizationActor,
  input: StalenessScanInput,
): Promise<StalenessScanResult> {
  const reason: SceneSummaryInvalidatedReason = input.reason ?? "source_hash_drift";
  const markStale = input.markStale ?? true;

  const summaries = await repository.loadSummaries(actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    status: "Fresh",
  });
  if (summaries.length === 0) {
    return { scannedSummaryCount: 0, driftedSummaries: [], markedStaleCount: 0 };
  }

  const bridgeUnitIds = new Set<string>();
  for (const summary of summaries) {
    for (const citation of summary.citations) {
      bridgeUnitIds.add(citation.bridgeUnitId);
    }
  }
  const currentHashes = await repository.currentSourceHashesForBridgeUnits(actor, {
    bridgeUnitIds: [...bridgeUnitIds],
  });

  const drifted: SceneSummaryDrift[] = [];
  for (const summary of summaries) {
    const driftedUnitIds = collectDriftedUnits(summary, currentHashes);
    if (driftedUnitIds.length > 0) {
      drifted.push({
        sceneSummaryId: summary.sceneSummaryId,
        sceneId: summary.sceneId,
        driftedBridgeUnitIds: driftedUnitIds,
      });
    }
  }

  let markedStaleCount = 0;
  if (markStale) {
    for (const drift of drifted) {
      await repository.markStale(actor, {
        sceneSummaryId: drift.sceneSummaryId,
        reason,
      });
      markedStaleCount += 1;
    }
  }

  return {
    scannedSummaryCount: summaries.length,
    driftedSummaries: drifted,
    markedStaleCount,
  };
}

function collectDriftedUnits(
  summary: SceneSummaryRecord,
  currentHashes: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const citation of summary.citations) {
    const current = currentHashes.get(citation.bridgeUnitId);
    // Either the unit is missing (the bridge no longer carries it) or the
    // hash changed — both are drift events.
    if (current === undefined || current !== citation.citedSourceHash) {
      drifted.push(citation.bridgeUnitId);
    }
  }
  return drifted;
}
