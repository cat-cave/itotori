import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  assetLocalizationDecisionAssetKindValues,
  assetLocalizationDecisionPolicyValues,
  assetLocalizationDecisions,
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

export const assetLocalizationDecisionPolicyList: ReadonlyArray<AssetLocalizationDecisionPolicy> = [
  assetLocalizationDecisionPolicyValues.keepOriginal,
  assetLocalizationDecisionPolicyValues.translateText,
  assetLocalizationDecisionPolicyValues.swapWithReplacement,
  assetLocalizationDecisionPolicyValues.romanize,
  assetLocalizationDecisionPolicyValues.fullLocalize,
  assetLocalizationDecisionPolicyValues.skip,
];

export class AssetLocalizationDecisionRepositoryError extends Error {
  constructor(
    readonly code:
      | "asset_decision_not_found"
      | "asset_decision_invalid_input"
      | "asset_decision_bulk_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AssetLocalizationDecisionRepositoryError";
  }
}

export type RecordAssetDecisionInput = {
  projectId: string;
  localeBranchId: string;
  assetRef: AssetLocalizationDecisionAssetRef;
  assetKind: AssetLocalizationDecisionAssetKind;
  decisionPolicy: AssetLocalizationDecisionPolicy;
  decisionRationale?: string | null;
  decidedByUserId?: string | null;
  decidedAt?: Date;
};

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

export interface ItotoriAssetLocalizationDecisionRepositoryPort {
  recordDecision(
    actor: AuthorizationActor,
    input: RecordAssetDecisionInput,
  ): Promise<AssetDecisionRecord>;
  recordDecisionsBulk(
    actor: AuthorizationActor,
    inputs: RecordAssetDecisionInput[],
  ): Promise<AssetDecisionRecord[]>;
  loadActiveDecisions(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<AssetDecisionRecord[]>;
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

  async recordDecision(
    actor: AuthorizationActor,
    input: RecordAssetDecisionInput,
  ): Promise<AssetDecisionRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    assertRecordInput(input);

    const decisionId = `asset-decision-${randomUUID()}`;
    const decidedAt = input.decidedAt ?? new Date();

    await this.db.transaction(async (tx) => {
      // Supersede first so the partial-unique active index does not
      // see two active rows at once. The FK on superseded_by_decision_id
      // is declared DEFERRABLE INITIALLY DEFERRED in the migration so
      // the forward reference resolves on commit, after the insert
      // lands below.
      await supersedeActiveInTx(tx, input, decisionId, decidedAt);
      await tx.insert(assetLocalizationDecisions).values({
        decisionId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        assetRef: input.assetRef,
        assetKind: input.assetKind,
        decisionPolicy: input.decisionPolicy,
        decisionRationale: input.decisionRationale ?? null,
        decidedByUserId: input.decidedByUserId ?? actor.userId,
        decidedAt,
      });
    });

    const persisted = await this.fetchById(decisionId);
    if (persisted === null) {
      throw new AssetLocalizationDecisionRepositoryError(
        "asset_decision_not_found",
        `failed to load asset decision ${decisionId} after insert`,
      );
    }
    return persisted;
  }

  async recordDecisionsBulk(
    actor: AuthorizationActor,
    inputs: RecordAssetDecisionInput[],
  ): Promise<AssetDecisionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (inputs.length === 0) {
      throw new AssetLocalizationDecisionRepositoryError(
        "asset_decision_bulk_invalid",
        "recordDecisionsBulk requires at least one decision input",
      );
    }
    for (const input of inputs) {
      assertRecordInput(input);
    }

    const insertedIds: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const input of inputs) {
        const decisionId = `asset-decision-${randomUUID()}`;
        const decidedAt = input.decidedAt ?? new Date();
        // Same order rationale as recordDecision: supersede first so
        // the active-decision partial unique index stays clean, and
        // rely on the deferred FK for the forward reference.
        await supersedeActiveInTx(tx, input, decisionId, decidedAt);
        await tx.insert(assetLocalizationDecisions).values({
          decisionId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          assetRef: input.assetRef,
          assetKind: input.assetKind,
          decisionPolicy: input.decisionPolicy,
          decisionRationale: input.decisionRationale ?? null,
          decidedByUserId: input.decidedByUserId ?? actor.userId,
          decidedAt,
        });
        insertedIds.push(decisionId);
      }
    });

    const records: AssetDecisionRecord[] = [];
    for (const id of insertedIds) {
      const record = await this.fetchById(id);
      if (record === null) {
        throw new AssetLocalizationDecisionRepositoryError(
          "asset_decision_not_found",
          `failed to load asset decision ${id} after bulk insert`,
        );
      }
      records.push(record);
    }
    return records;
  }

  async loadActiveDecisions(
    actor: AuthorizationActor,
    projectId: string,
    localeBranchId: string,
    opts?: LoadActiveDecisionsOptions,
  ): Promise<AssetDecisionRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

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

  private async fetchById(decisionId: string): Promise<AssetDecisionRecord | null> {
    const rows = await this.db
      .select()
      .from(assetLocalizationDecisions)
      .where(eq(assetLocalizationDecisions.decisionId, decisionId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return rowToRecord(row);
  }
}

async function supersedeActiveInTx(
  tx: Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0],
  input: RecordAssetDecisionInput,
  newDecisionId: string,
  decidedAt: Date,
): Promise<void> {
  await tx
    .update(assetLocalizationDecisions)
    .set({
      supersededAt: decidedAt,
      supersededByDecisionId: newDecisionId,
    })
    .where(
      and(
        eq(assetLocalizationDecisions.projectId, input.projectId),
        eq(assetLocalizationDecisions.localeBranchId, input.localeBranchId),
        sql`${assetLocalizationDecisions.assetRef}->>'ref' = ${input.assetRef.ref}`,
        isNull(assetLocalizationDecisions.supersededAt),
      ),
    );
}

function assertRecordInput(input: RecordAssetDecisionInput): void {
  if (input.projectId.length === 0) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      "projectId must be non-empty",
    );
  }
  if (input.localeBranchId.length === 0) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      "localeBranchId must be non-empty",
    );
  }
  if (
    input.assetRef === null ||
    typeof input.assetRef !== "object" ||
    typeof input.assetRef.ref !== "string" ||
    input.assetRef.ref.length === 0
  ) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      "assetRef.ref must be a non-empty string",
    );
  }
  if (typeof input.assetRef.kind !== "string" || input.assetRef.kind.length === 0) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      "assetRef.kind must be a non-empty string",
    );
  }
  if (!assetLocalizationDecisionAssetKindList.includes(input.assetKind)) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      `assetKind must be one of ${assetLocalizationDecisionAssetKindList.join(", ")}`,
    );
  }
  if (!assetLocalizationDecisionPolicyList.includes(input.decisionPolicy)) {
    throw new AssetLocalizationDecisionRepositoryError(
      "asset_decision_invalid_input",
      `decisionPolicy must be one of ${assetLocalizationDecisionPolicyList.join(", ")}`,
    );
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

export { assetLocalizationDecisionAssetKindValues, assetLocalizationDecisionPolicyValues };
