import type {
  AssetDecisionRecord,
  AssetLocalizationDecisionAssetRef,
  AssetLocalizationDecisionPolicy,
  AuthorizationActor,
  ItotoriAssetLocalizationDecisionRepositoryPort,
} from "@itotori/db";

/**
 * Resolution returned when the asset has at least one active decision
 * recorded for the locale branch.
 */
export type ResolvedAssetPolicy = {
  policy: AssetLocalizationDecisionPolicy;
  rationale?: string;
  decidedAt: Date;
  decidedByUserId: string;
};

/**
 * Resolution returned when no active decision is on file for the asset.
 * The patch-export pipeline (ITOTORI-025) MUST treat this as a hard
 * stop — there is no silent default to `keep_original`.
 */
export type UnresolvedAssetPolicy = {
  policy: "unresolved";
  reason: "no_decision";
};

export type AssetPolicyResolution = ResolvedAssetPolicy | UnresolvedAssetPolicy;

export class AssetDecisionPolicyResolver {
  constructor(
    private readonly repository: Pick<
      ItotoriAssetLocalizationDecisionRepositoryPort,
      "loadActiveDecisions"
    >,
  ) {}

  async resolvePolicy(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    assetRef: AssetLocalizationDecisionAssetRef,
  ): Promise<AssetPolicyResolution> {
    const active = await this.repository.loadActiveDecisions(actor, projectId, localeBranchId);
    const match = active.find(matchesAssetRef(assetRef));
    if (match === undefined) {
      return { policy: "unresolved", reason: "no_decision" };
    }
    return toResolved(match);
  }
}

function matchesAssetRef(
  target: AssetLocalizationDecisionAssetRef,
): (record: AssetDecisionRecord) => boolean {
  return (record) => record.assetRef.ref === target.ref;
}

function toResolved(record: AssetDecisionRecord): ResolvedAssetPolicy {
  if (record.decidedByUserId === null) {
    throw new Error(
      `asset decision ${record.decisionId} is missing decidedByUserId; cannot resolve policy`,
    );
  }
  const resolved: ResolvedAssetPolicy = {
    policy: record.decisionPolicy,
    decidedAt: record.decidedAt,
    decidedByUserId: record.decidedByUserId,
  };
  if (record.decisionRationale !== null) {
    resolved.rationale = record.decisionRationale;
  }
  return resolved;
}
