import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  assetLocalizationDecisionAssetKindValues,
  assetLocalizationDecisionPolicyValues,
  assetLocalizationDecisions,
  assets,
  localeBranches,
  type AssetLocalizationDecisionAssetKind,
  type AssetLocalizationDecisionAssetRef,
  type AssetLocalizationDecisionPolicy,
} from "../schema.js";

export const assetLocalizationDecisionAssetKindList: ReadonlyArray<AssetLocalizationDecisionAssetKind> =
  [
    assetLocalizationDecisionAssetKindValues.imageWithText,
    assetLocalizationDecisionAssetKindValues.songTitle,
    assetLocalizationDecisionAssetKindValues.uiArt,
    assetLocalizationDecisionAssetKindValues.font,
    assetLocalizationDecisionAssetKindValues.video,
    assetLocalizationDecisionAssetKindValues.romanization,
    assetLocalizationDecisionAssetKindValues.fullLocalization,
    assetLocalizationDecisionAssetKindValues.doNotTranslate,
  ];

export class AssetLocalizationDecisionRepositoryError extends Error {
  constructor(
    readonly code: "asset_decision_not_found",
    message: string,
  ) {
    super(message);
    this.name = "AssetLocalizationDecisionRepositoryError";
  }
}

/** Historic decision data retained for patch export and diagnostics only. */
export type AssetDecisionRecord = {
  decisionId: string;
  projectId: string;
  localeBranchId: string;
  assetRef: AssetLocalizationDecisionAssetRef;
  assetKind: AssetLocalizationDecisionAssetKind;
  decisionPolicy: AssetLocalizationDecisionPolicy;
  decisionRationale: string | null;
  decidedByUserId: string | null;
  decidedAt: Date;
  supersededAt: Date | null;
  supersededByDecisionId: string | null;
  createdAt: Date;
};

export type LoadActiveDecisionsOptions = {
  kindFilter?: AssetLocalizationDecisionAssetKind;
};

export type CandidateAssetRecord = {
  assetRef: AssetLocalizationDecisionAssetRef;
  assetKind: AssetLocalizationDecisionAssetKind;
  displayLabel?: string;
};

/**
 * Read-only projection over previously recorded asset decisions. New human
 * policy records cannot be created here: they are neither result revisions nor
 * canonical context corrections.
 */
export interface ItotoriAssetLocalizationDecisionRepositoryPort {
  loadActiveDecisions(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<AssetDecisionRecord[]>;
  loadCandidateAssets(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<CandidateAssetRecord[]>;
  loadDecisionHistory(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    assetRef: AssetLocalizationDecisionAssetRef,
  ): Promise<AssetDecisionRecord[]>;
  loadDecisionsByPolicy(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    policy: AssetLocalizationDecisionPolicy,
  ): Promise<AssetDecisionRecord[]>;
}

export class ItotoriAssetLocalizationDecisionRepository implements ItotoriAssetLocalizationDecisionRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadActiveDecisions(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<AssetDecisionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    await this.requireLocaleBranch(projectId, localeBranchId);

    const conditions = [
      eq(assetLocalizationDecisions.projectId, projectId),
      eq(assetLocalizationDecisions.localeBranchId, localeBranchId),
      isNull(assetLocalizationDecisions.supersededAt),
    ];
    if (opts?.kindFilter !== undefined) {
      conditions.push(eq(assetLocalizationDecisions.assetKind, opts.kindFilter));
    }
    const rows = await this.db
      .select()
      .from(assetLocalizationDecisions)
      .where(and(...conditions))
      .orderBy(desc(assetLocalizationDecisions.decidedAt));
    return rows.map(rowToRecord);
  }

  async loadCandidateAssets(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<CandidateAssetRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const branch = await this.requireLocaleBranch(projectId, localeBranchId);
    const active = await this.loadActiveDecisions(actor, projectId, localeBranchId);
    const activeRefs = new Set(active.map((decision) => decision.assetRef.ref));
    const assetRows = await this.db
      .select({
        assetId: assets.assetId,
        assetKey: assets.assetKey,
        assetKind: assets.assetKind,
        path: assets.path,
      })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.sourceBundleId, branch.sourceBundleId)))
      .orderBy(asc(assets.assetKey));

    const candidates: CandidateAssetRecord[] = [];
    for (const row of assetRows) {
      const assetKind = bridgeAssetKindToDecisionAssetKind(row.assetKind);
      if (assetKind === null || (opts?.kindFilter !== undefined && assetKind !== opts.kindFilter)) {
        continue;
      }
      if (activeRefs.has(row.assetId)) {
        continue;
      }
      candidates.push({
        assetRef: { kind: "bridgeAssetRef", ref: row.assetId, assetKey: row.assetKey },
        assetKind,
        displayLabel: row.path ?? row.assetKey,
      });
    }
    return candidates;
  }

  async loadDecisionHistory(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    assetRef: AssetLocalizationDecisionAssetRef,
  ): Promise<AssetDecisionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(assetLocalizationDecisions)
      .where(
        and(
          eq(assetLocalizationDecisions.projectId, projectId),
          eq(assetLocalizationDecisions.localeBranchId, localeBranchId),
          sql`${assetLocalizationDecisions.assetRef}->>'ref' = ${assetRef.ref}`,
        ),
      )
      .orderBy(desc(assetLocalizationDecisions.decidedAt));
    return rows.map(rowToRecord);
  }

  async loadDecisionsByPolicy(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    policy: AssetLocalizationDecisionPolicy,
  ): Promise<AssetDecisionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(assetLocalizationDecisions)
      .where(
        and(
          eq(assetLocalizationDecisions.projectId, projectId),
          eq(assetLocalizationDecisions.localeBranchId, localeBranchId),
          eq(assetLocalizationDecisions.decisionPolicy, policy),
          isNull(assetLocalizationDecisions.supersededAt),
        ),
      )
      .orderBy(desc(assetLocalizationDecisions.decidedAt));
    return rows.map(rowToRecord);
  }

  private async requireLocaleBranch(
    projectId: string,
    localeBranchId: string,
  ): Promise<{ sourceBundleId: string }> {
    const rows = await this.db
      .select({ sourceBundleId: localeBranches.sourceBundleId })
      .from(localeBranches)
      .where(
        and(
          eq(localeBranches.projectId, projectId),
          eq(localeBranches.localeBranchId, localeBranchId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new AssetLocalizationDecisionRepositoryError(
        "asset_decision_not_found",
        `locale branch ${localeBranchId} was not found for project ${projectId}`,
      );
    }
    return row;
  }
}

function rowToRecord(row: typeof assetLocalizationDecisions.$inferSelect): AssetDecisionRecord {
  return {
    decisionId: row.decisionId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    assetRef: row.assetRef,
    assetKind: row.assetKind,
    decisionPolicy: row.decisionPolicy,
    decisionRationale: row.decisionRationale,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    supersededAt: row.supersededAt,
    supersededByDecisionId: row.supersededByDecisionId,
    createdAt: row.createdAt,
  };
}

function bridgeAssetKindToDecisionAssetKind(
  assetKind: string,
): AssetLocalizationDecisionAssetKind | null {
  switch (assetKind) {
    case "image":
      return assetLocalizationDecisionAssetKindValues.imageWithText;
    case "ui_texture":
      return assetLocalizationDecisionAssetKindValues.uiArt;
    case "font":
      return assetLocalizationDecisionAssetKindValues.font;
    case "video":
      return assetLocalizationDecisionAssetKindValues.video;
    case "text":
    case "metadata":
      return assetLocalizationDecisionAssetKindValues.doNotTranslate;
    default:
      return null;
  }
}

export { assetLocalizationDecisionAssetKindValues, assetLocalizationDecisionPolicyValues };
