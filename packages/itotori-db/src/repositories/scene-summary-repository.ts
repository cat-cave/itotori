import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  sceneSummaries,
  sceneSummaryCitedUnits,
  sceneSummaryStatusValues,
  sourceUnits,
  type SceneSummaryInvalidatedReason,
  type SceneSummaryStatus,
} from "../schema.js";

export type SceneSummaryCitationRecord = {
  bridgeUnitId: string;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type SceneSummaryRecord = {
  sceneSummaryId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sceneId: string;
  summaryLocale: string;
  summaryText: string;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  status: SceneSummaryStatus;
  invalidatedAt: Date | null;
  invalidatedReason: SceneSummaryInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: SceneSummaryCitationRecord[];
};

export type SaveSceneSummaryInput = {
  sceneSummaryId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sceneId: string;
  summaryLocale: string;
  summaryText: string;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  generatedAt: Date;
  citations: SceneSummaryCitationRecord[];
};

export type LoadSceneSummariesQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  sceneId?: string;
  status?: SceneSummaryStatus;
  promptTemplateVersion?: string;
};

export type LoadSceneSummaryByScene = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sceneId: string;
  promptTemplateVersion?: string;
};

export type MarkSceneSummaryStaleInput = {
  sceneSummaryId: string;
  reason: SceneSummaryInvalidatedReason;
  invalidatedAt?: Date;
};

export type LoadCurrentSourceHashesInput = {
  bridgeUnitIds: string[];
};

export type BridgeUnitTextRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker: string | null;
  occurrenceId: string;
};

export type LoadBridgeUnitsForSummaryInput = {
  bridgeUnitIds: string[];
};

export interface ItotoriSceneSummaryRepositoryPort {
  saveSummary(actor: AuthorizationActor, input: SaveSceneSummaryInput): Promise<SceneSummaryRecord>;
  loadSummaryByScene(
    actor: AuthorizationActor,
    query: LoadSceneSummaryByScene,
  ): Promise<SceneSummaryRecord | null>;
  loadSummaries(
    actor: AuthorizationActor,
    query: LoadSceneSummariesQuery,
  ): Promise<SceneSummaryRecord[]>;
  markStale(actor: AuthorizationActor, input: MarkSceneSummaryStaleInput): Promise<void>;
  currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>>;
  loadBridgeUnitsForSummary(
    actor: AuthorizationActor,
    input: LoadBridgeUnitsForSummaryInput,
  ): Promise<Map<string, BridgeUnitTextRecord>>;
}

export class ItotoriSceneSummaryRepository implements ItotoriSceneSummaryRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveSummary(
    actor: AuthorizationActor,
    input: SaveSceneSummaryInput,
  ): Promise<SceneSummaryRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(`scene summary ${input.sceneSummaryId} must cite at least one bridge unit`);
    }
    const seenOrdinals = new Set<number>();
    for (const citation of input.citations) {
      if (seenOrdinals.has(citation.citeOrdinal)) {
        throw new Error(
          `scene summary ${input.sceneSummaryId} has duplicate cite ordinal ${citation.citeOrdinal}`,
        );
      }
      seenOrdinals.add(citation.citeOrdinal);
    }

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ sceneSummaryId: sceneSummaries.sceneSummaryId })
        .from(sceneSummaries)
        .where(
          and(
            eq(sceneSummaries.projectId, input.projectId),
            eq(sceneSummaries.localeBranchId, input.localeBranchId),
            eq(sceneSummaries.sourceRevisionId, input.sourceRevisionId),
            eq(sceneSummaries.sceneId, input.sceneId),
            eq(sceneSummaries.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.sceneSummaryId);
        await tx
          .delete(sceneSummaryCitedUnits)
          .where(inArray(sceneSummaryCitedUnits.sceneSummaryId, ids));
        await tx.delete(sceneSummaries).where(inArray(sceneSummaries.sceneSummaryId, ids));
      }

      await tx.insert(sceneSummaries).values({
        sceneSummaryId: input.sceneSummaryId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        sceneId: input.sceneId,
        summaryLocale: input.summaryLocale,
        summaryText: input.summaryText,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        inputTokenEstimate: input.inputTokenEstimate,
        completionTokens: input.completionTokens,
        status: sceneSummaryStatusValues.fresh,
        invalidatedAt: null,
        invalidatedReason: null,
        generatedAt: input.generatedAt,
      });

      await tx.insert(sceneSummaryCitedUnits).values(
        input.citations.map((citation) => ({
          sceneSummaryId: input.sceneSummaryId,
          bridgeUnitId: citation.bridgeUnitId,
          citedSourceHash: citation.citedSourceHash,
          citeOrdinal: citation.citeOrdinal,
        })),
      );
    });

    const saved = await this.fetchById(input.sceneSummaryId);
    if (!saved) {
      throw new Error(`failed to load saved scene summary ${input.sceneSummaryId}`);
    }
    return saved;
  }

  async loadSummaryByScene(
    actor: AuthorizationActor,
    query: LoadSceneSummaryByScene,
  ): Promise<SceneSummaryRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [
      eq(sceneSummaries.projectId, query.projectId),
      eq(sceneSummaries.localeBranchId, query.localeBranchId),
      eq(sceneSummaries.sourceRevisionId, query.sourceRevisionId),
      eq(sceneSummaries.sceneId, query.sceneId),
    ];
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(sceneSummaries.promptTemplateVersion, query.promptTemplateVersion));
    }

    // Prefer a Fresh row, fall back to most recent Stale.
    const freshConditions = [
      ...conditions,
      eq(sceneSummaries.status, sceneSummaryStatusValues.fresh),
    ];
    const freshRows = await this.db
      .select()
      .from(sceneSummaries)
      .where(and(...freshConditions))
      .orderBy(desc(sceneSummaries.generatedAt))
      .limit(1);
    if (freshRows[0]) {
      return await this.hydrate(freshRows[0]);
    }
    const anyRows = await this.db
      .select()
      .from(sceneSummaries)
      .where(and(...conditions))
      .orderBy(desc(sceneSummaries.generatedAt))
      .limit(1);
    if (!anyRows[0]) {
      return null;
    }
    return await this.hydrate(anyRows[0]);
  }

  async loadSummaries(
    actor: AuthorizationActor,
    query: LoadSceneSummariesQuery,
  ): Promise<SceneSummaryRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(sceneSummaries.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(sceneSummaries.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(sceneSummaries.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.sceneId !== undefined) {
      conditions.push(eq(sceneSummaries.sceneId, query.sceneId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(sceneSummaries.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(sceneSummaries.promptTemplateVersion, query.promptTemplateVersion));
    }

    const rows = await this.db
      .select()
      .from(sceneSummaries)
      .where(and(...conditions))
      .orderBy(
        asc(sceneSummaries.projectId),
        asc(sceneSummaries.localeBranchId),
        asc(sceneSummaries.sourceRevisionId),
        asc(sceneSummaries.sceneId),
        desc(sceneSummaries.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.sceneSummaryId);
    const citationRows = await this.db
      .select()
      .from(sceneSummaryCitedUnits)
      .where(inArray(sceneSummaryCitedUnits.sceneSummaryId, ids))
      .orderBy(asc(sceneSummaryCitedUnits.sceneSummaryId), asc(sceneSummaryCitedUnits.citeOrdinal));
    const citationsBySummary = new Map<string, SceneSummaryCitationRecord[]>();
    for (const citation of citationRows) {
      const bucket = citationsBySummary.get(citation.sceneSummaryId) ?? [];
      bucket.push({
        bridgeUnitId: citation.bridgeUnitId,
        citedSourceHash: citation.citedSourceHash,
        citeOrdinal: citation.citeOrdinal,
      });
      citationsBySummary.set(citation.sceneSummaryId, bucket);
    }
    return rows.map((row) => rowToRecord(row, citationsBySummary.get(row.sceneSummaryId) ?? []));
  }

  async markStale(actor: AuthorizationActor, input: MarkSceneSummaryStaleInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(sceneSummaries)
      .set({
        status: sceneSummaryStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(sceneSummaries.sceneSummaryId, input.sceneSummaryId),
          eq(sceneSummaries.status, sceneSummaryStatusValues.fresh),
        ),
      );
  }

  async currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const result = new Map<string, string>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceHash: sourceUnits.sourceHash,
      })
      .from(sourceUnits)
      // ITOTORI-060: "current" source hashes exclude tombstoned (removed) units.
      .where(
        and(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds), isNull(sourceUnits.removedAt)),
      );
    for (const row of rows) {
      result.set(row.bridgeUnitId, row.sourceHash);
    }
    return result;
  }

  async loadBridgeUnitsForSummary(
    actor: AuthorizationActor,
    input: LoadBridgeUnitsForSummaryInput,
  ): Promise<Map<string, BridgeUnitTextRecord>> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const result = new Map<string, BridgeUnitTextRecord>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        sourceText: sourceUnits.sourceText,
        sourceHash: sourceUnits.sourceHash,
        speaker: sourceUnits.speaker,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(sourceUnits)
      // ITOTORI-060: summaries are built from the active set; tombstoned
      // (removed) units are excluded.
      .where(
        and(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds), isNull(sourceUnits.removedAt)),
      );
    for (const row of rows) {
      result.set(row.bridgeUnitId, {
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        sourceText: row.sourceText,
        sourceHash: row.sourceHash,
        speaker: extractSpeaker(row.speaker),
        occurrenceId: row.occurrenceId,
      });
    }
    return result;
  }

  private async fetchById(sceneSummaryId: string): Promise<SceneSummaryRecord | null> {
    // Internal helper used after a write inside the same caller's
    // authorization scope. Re-checking permission would force the gate
    // matrix to register an extra non-public surface, which is undesirable.
    const rows = await this.db
      .select()
      .from(sceneSummaries)
      .where(eq(sceneSummaries.sceneSummaryId, sceneSummaryId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return await this.hydrate(row);
  }

  private async hydrate(row: typeof sceneSummaries.$inferSelect): Promise<SceneSummaryRecord> {
    const citationRows = await this.db
      .select()
      .from(sceneSummaryCitedUnits)
      .where(eq(sceneSummaryCitedUnits.sceneSummaryId, row.sceneSummaryId))
      .orderBy(asc(sceneSummaryCitedUnits.citeOrdinal));
    return rowToRecord(
      row,
      citationRows.map((citation) => ({
        bridgeUnitId: citation.bridgeUnitId,
        citedSourceHash: citation.citedSourceHash,
        citeOrdinal: citation.citeOrdinal,
      })),
    );
  }
}

function extractSpeaker(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.displayName === "string") {
      return record.displayName;
    }
    if (typeof record.key === "string") {
      return record.key;
    }
    if (typeof record.canonicalName === "string") {
      return record.canonicalName;
    }
  }
  return null;
}

function rowToRecord(
  row: typeof sceneSummaries.$inferSelect,
  citations: SceneSummaryCitationRecord[],
): SceneSummaryRecord {
  return {
    sceneSummaryId: row.sceneSummaryId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    sceneId: row.sceneId,
    summaryLocale: row.summaryLocale,
    summaryText: row.summaryText,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    inputTokenEstimate: row.inputTokenEstimate,
    completionTokens: row.completionTokens,
    status: row.status as SceneSummaryStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as SceneSummaryInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

export { sceneSummaryInvalidatedReasonValues, sceneSummaryStatusValues } from "../schema.js";
export type { SceneSummaryInvalidatedReason, SceneSummaryStatus } from "../schema.js";
