import { and, asc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  translationBatches,
  translationBatchUnits,
  translationBatchContextRefs,
  type TranslationBatchContextRefKind,
  type TranslationBatchContextRefInclusionReason,
} from "../schema.js";

export type TranslationBatchUnitRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceHash: string;
  unitOrdinal: number;
};

export type TranslationBatchContextRefRecord = {
  refKind: TranslationBatchContextRefKind;
  refId: string;
  refSecondaryId: string;
  inclusionReason: TranslationBatchContextRefInclusionReason;
  hitBridgeUnitIds: string[] | null;
  details: Record<string, unknown>;
};

export type TranslationBatchRecord = {
  batchId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  batchOrdinal: number;
  tokenEstimate: number;
  tokenBudgetCap: number;
  sceneId: string | null;
  sceneSplitIndex: number | null;
  routeId: string | null;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  modelTargetFillRatio: number;
  modelPromptOverheadTokens: number;
  tokenEstimatorId: string;
  nearCapWarning: boolean;
  generatedAt: Date;
  createdAt: Date;
  units: TranslationBatchUnitRecord[];
  contextRefs: TranslationBatchContextRefRecord[];
};

export type SaveTranslationBatchesInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  batches: SaveTranslationBatchInput[];
};

export type SaveTranslationBatchInput = {
  batchId: string;
  batchOrdinal: number;
  tokenEstimate: number;
  tokenBudgetCap: number;
  sceneId: string | null;
  sceneSplitIndex: number | null;
  routeId: string | null;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  modelTargetFillRatio: number;
  modelPromptOverheadTokens: number;
  tokenEstimatorId: string;
  nearCapWarning: boolean;
  generatedAt: Date;
  units: TranslationBatchUnitRecord[];
  contextRefs: TranslationBatchContextRefRecord[];
};

export type LoadTranslationBatchesQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  sceneId?: string;
};

export interface ItotoriTranslationBatchRepositoryPort {
  saveBatches(
    actor: AuthorizationActor,
    input: SaveTranslationBatchesInput,
  ): Promise<TranslationBatchRecord[]>;
  loadBatches(
    actor: AuthorizationActor,
    query: LoadTranslationBatchesQuery,
  ): Promise<TranslationBatchRecord[]>;
  loadBatchById(actor: AuthorizationActor, batchId: string): Promise<TranslationBatchRecord | null>;
}

export class ItotoriTranslationBatchRepository implements ItotoriTranslationBatchRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveBatches(
    actor: AuthorizationActor,
    input: SaveTranslationBatchesInput,
  ): Promise<TranslationBatchRecord[]> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    await this.db.transaction(async (tx) => {
      const priorBatchIds = await tx
        .select({ batchId: translationBatches.batchId })
        .from(translationBatches)
        .where(
          and(
            eq(translationBatches.projectId, input.projectId),
            eq(translationBatches.localeBranchId, input.localeBranchId),
            eq(translationBatches.sourceRevisionId, input.sourceRevisionId),
          ),
        );

      if (priorBatchIds.length > 0) {
        const ids = priorBatchIds.map((row) => row.batchId);
        await tx
          .delete(translationBatchContextRefs)
          .where(inArray(translationBatchContextRefs.batchId, ids));
        await tx.delete(translationBatchUnits).where(inArray(translationBatchUnits.batchId, ids));
        await tx.delete(translationBatches).where(inArray(translationBatches.batchId, ids));
      }

      if (input.batches.length === 0) {
        return;
      }

      await tx.insert(translationBatches).values(
        input.batches.map((batch) => ({
          batchId: batch.batchId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          batchOrdinal: batch.batchOrdinal,
          tokenEstimate: batch.tokenEstimate,
          tokenBudgetCap: batch.tokenBudgetCap,
          sceneId: batch.sceneId,
          sceneSplitIndex: batch.sceneSplitIndex,
          routeId: batch.routeId,
          modelProviderFamily: batch.modelProviderFamily,
          modelId: batch.modelId,
          modelContextWindowTokens: batch.modelContextWindowTokens,
          modelMaxOutputTokens: batch.modelMaxOutputTokens,
          modelTargetFillRatio: batch.modelTargetFillRatio.toFixed(3),
          modelPromptOverheadTokens: batch.modelPromptOverheadTokens,
          tokenEstimatorId: batch.tokenEstimatorId,
          nearCapWarning: batch.nearCapWarning,
          generatedAt: batch.generatedAt,
        })),
      );

      const unitRows = input.batches.flatMap((batch) =>
        batch.units.map((unit) => ({
          batchId: batch.batchId,
          bridgeUnitId: unit.bridgeUnitId,
          sourceUnitKey: unit.sourceUnitKey,
          sourceHash: unit.sourceHash,
          unitOrdinal: unit.unitOrdinal,
        })),
      );
      if (unitRows.length > 0) {
        await tx.insert(translationBatchUnits).values(unitRows);
      }

      const refRows = input.batches.flatMap((batch) =>
        batch.contextRefs.map((ref) => ({
          batchId: batch.batchId,
          refKind: ref.refKind,
          refId: ref.refId,
          refSecondaryId: ref.refSecondaryId,
          inclusionReason: ref.inclusionReason,
          hitBridgeUnitIds: ref.hitBridgeUnitIds,
          details: ref.details,
        })),
      );
      if (refRows.length > 0) {
        await tx.insert(translationBatchContextRefs).values(refRows);
      }
    });

    return this.loadBatches(actor, {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
    });
  }

  async loadBatches(
    actor: AuthorizationActor,
    query: LoadTranslationBatchesQuery,
  ): Promise<TranslationBatchRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(translationBatches.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(translationBatches.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(translationBatches.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.sceneId !== undefined) {
      conditions.push(eq(translationBatches.sceneId, query.sceneId));
    }

    const batchRows = await this.db
      .select()
      .from(translationBatches)
      .where(and(...conditions))
      .orderBy(
        asc(translationBatches.projectId),
        asc(translationBatches.localeBranchId),
        asc(translationBatches.sourceRevisionId),
        asc(translationBatches.batchOrdinal),
      );

    if (batchRows.length === 0) {
      return [];
    }

    const batchIds = batchRows.map((row) => row.batchId);
    const unitRows = await this.db
      .select()
      .from(translationBatchUnits)
      .where(inArray(translationBatchUnits.batchId, batchIds))
      .orderBy(asc(translationBatchUnits.batchId), asc(translationBatchUnits.unitOrdinal));
    const refRows = await this.db
      .select()
      .from(translationBatchContextRefs)
      .where(inArray(translationBatchContextRefs.batchId, batchIds))
      .orderBy(
        asc(translationBatchContextRefs.batchId),
        asc(translationBatchContextRefs.refKind),
        asc(translationBatchContextRefs.refId),
        asc(translationBatchContextRefs.refSecondaryId),
      );

    const unitsByBatch = new Map<string, TranslationBatchUnitRecord[]>();
    for (const row of unitRows) {
      const bucket = unitsByBatch.get(row.batchId) ?? [];
      bucket.push({
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        sourceHash: row.sourceHash,
        unitOrdinal: row.unitOrdinal,
      });
      unitsByBatch.set(row.batchId, bucket);
    }
    const refsByBatch = new Map<string, TranslationBatchContextRefRecord[]>();
    for (const row of refRows) {
      const bucket = refsByBatch.get(row.batchId) ?? [];
      bucket.push({
        refKind: row.refKind as TranslationBatchContextRefKind,
        refId: row.refId,
        refSecondaryId: row.refSecondaryId,
        inclusionReason: row.inclusionReason as TranslationBatchContextRefInclusionReason,
        hitBridgeUnitIds: row.hitBridgeUnitIds ?? null,
        details: row.details,
      });
      refsByBatch.set(row.batchId, bucket);
    }

    return batchRows.map((row) => batchFromRow(row, unitsByBatch, refsByBatch));
  }

  async loadBatchById(
    actor: AuthorizationActor,
    batchId: string,
  ): Promise<TranslationBatchRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const rows = await this.db
      .select()
      .from(translationBatches)
      .where(eq(translationBatches.batchId, batchId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const unitRows = await this.db
      .select()
      .from(translationBatchUnits)
      .where(eq(translationBatchUnits.batchId, batchId))
      .orderBy(asc(translationBatchUnits.unitOrdinal));
    const refRows = await this.db
      .select()
      .from(translationBatchContextRefs)
      .where(eq(translationBatchContextRefs.batchId, batchId))
      .orderBy(
        asc(translationBatchContextRefs.refKind),
        asc(translationBatchContextRefs.refId),
        asc(translationBatchContextRefs.refSecondaryId),
      );

    const unitsByBatch = new Map<string, TranslationBatchUnitRecord[]>();
    unitsByBatch.set(
      batchId,
      unitRows.map((unit) => ({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        sourceHash: unit.sourceHash,
        unitOrdinal: unit.unitOrdinal,
      })),
    );
    const refsByBatch = new Map<string, TranslationBatchContextRefRecord[]>();
    refsByBatch.set(
      batchId,
      refRows.map((ref) => ({
        refKind: ref.refKind as TranslationBatchContextRefKind,
        refId: ref.refId,
        refSecondaryId: ref.refSecondaryId,
        inclusionReason: ref.inclusionReason as TranslationBatchContextRefInclusionReason,
        hitBridgeUnitIds: ref.hitBridgeUnitIds ?? null,
        details: ref.details,
      })),
    );

    return batchFromRow(row, unitsByBatch, refsByBatch);
  }
}

function batchFromRow(
  row: typeof translationBatches.$inferSelect,
  unitsByBatch: Map<string, TranslationBatchUnitRecord[]>,
  refsByBatch: Map<string, TranslationBatchContextRefRecord[]>,
): TranslationBatchRecord {
  return {
    batchId: row.batchId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    batchOrdinal: row.batchOrdinal,
    tokenEstimate: row.tokenEstimate,
    tokenBudgetCap: row.tokenBudgetCap,
    sceneId: row.sceneId,
    sceneSplitIndex: row.sceneSplitIndex,
    routeId: row.routeId,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    modelTargetFillRatio: Number.parseFloat(row.modelTargetFillRatio),
    modelPromptOverheadTokens: row.modelPromptOverheadTokens,
    tokenEstimatorId: row.tokenEstimatorId,
    nearCapWarning: row.nearCapWarning,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    units: unitsByBatch.get(row.batchId) ?? [],
    contextRefs: refsByBatch.get(row.batchId) ?? [],
  };
}
