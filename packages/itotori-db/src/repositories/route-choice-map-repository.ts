import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  routeChoiceKindValues,
  routeChoiceStatusValues,
  routeChoices,
  routeEvidence,
  routeEvidenceSubjectKindValues,
  routeInvalidatedReasonValues,
  routeMapStatusValues,
  routeMaps,
  sourceUnits,
  type RouteChoiceKind,
  type RouteChoiceStatus,
  type RouteEvidenceSubjectKind,
  type RouteInvalidatedReason,
  type RouteMapStatus,
} from "../schema.js";

export const routeChoiceKindList: ReadonlyArray<RouteChoiceKind> = [
  routeChoiceKindValues.routeBranch,
  routeChoiceKindValues.flagToggle,
  routeChoiceKindValues.sceneSelector,
  routeChoiceKindValues.cosmetic,
  routeChoiceKindValues.other,
];

export type RouteCitationRecord = {
  bridgeUnitId: string;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type RouteMapRecord = {
  routeMapId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  routeKey: string;
  routeTitle: string;
  mapLocale: string;
  routeSummary: string;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  status: RouteMapStatus;
  invalidatedAt: Date | null;
  invalidatedReason: RouteInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: RouteCitationRecord[];
};

export type RouteChoiceOptionRecord = {
  optionId: string;
  optionIndex: number;
  optionLabel: string;
  targetRouteKey: string | null;
  targetUnitIds: string[];
  targetUnitHashes: string[];
};

export type RouteChoiceRecord = {
  routeChoiceId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  choiceKey: string;
  kind: RouteChoiceKind;
  fromRouteKey: string | null;
  promptSummary: string;
  mapLocale: string;
  options: RouteChoiceOptionRecord[];
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  status: RouteChoiceStatus;
  invalidatedAt: Date | null;
  invalidatedReason: RouteInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: RouteCitationRecord[];
};

export type SaveRouteMapInput = Omit<
  RouteMapRecord,
  "status" | "invalidatedAt" | "invalidatedReason" | "createdAt"
>;

export type SaveRouteChoiceInput = Omit<
  RouteChoiceRecord,
  "status" | "invalidatedAt" | "invalidatedReason" | "createdAt"
>;

export type LoadRouteMapsQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  routeKey?: string;
  status?: RouteMapStatus;
  promptTemplateVersion?: string;
};

export type LoadRouteChoicesQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  choiceKey?: string;
  fromRouteKey?: string;
  status?: RouteChoiceStatus;
  promptTemplateVersion?: string;
};

export type MarkRouteMapStaleInput = {
  routeMapId: string;
  reason: RouteInvalidatedReason;
  invalidatedAt?: Date;
};

export type MarkRouteChoiceStaleInput = {
  routeChoiceId: string;
  reason: RouteInvalidatedReason;
  invalidatedAt?: Date;
};

export type LoadCurrentSourceHashesInput = {
  bridgeUnitIds: string[];
};

export interface ItotoriRouteChoiceMapRepositoryPort {
  saveRouteMap(actor: AuthorizationActor, input: SaveRouteMapInput): Promise<RouteMapRecord>;
  saveRouteChoice(
    actor: AuthorizationActor,
    input: SaveRouteChoiceInput,
  ): Promise<RouteChoiceRecord>;
  loadRouteMapsByProject(
    actor: AuthorizationActor,
    query: LoadRouteMapsQuery,
  ): Promise<RouteMapRecord[]>;
  loadRouteChoicesByProject(
    actor: AuthorizationActor,
    query: LoadRouteChoicesQuery,
  ): Promise<RouteChoiceRecord[]>;
  markRouteMapStale(actor: AuthorizationActor, input: MarkRouteMapStaleInput): Promise<void>;
  markRouteChoiceStale(actor: AuthorizationActor, input: MarkRouteChoiceStaleInput): Promise<void>;
  currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>>;
}

export class ItotoriRouteChoiceMapRepository implements ItotoriRouteChoiceMapRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveRouteMap(actor: AuthorizationActor, input: SaveRouteMapInput): Promise<RouteMapRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(`route map ${input.routeMapId} must cite at least one bridge unit`);
    }
    assertOrdinalsUnique(input.citations, `route map ${input.routeMapId}`);

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ routeMapId: routeMaps.routeMapId })
        .from(routeMaps)
        .where(
          and(
            eq(routeMaps.projectId, input.projectId),
            eq(routeMaps.localeBranchId, input.localeBranchId),
            eq(routeMaps.sourceRevisionId, input.sourceRevisionId),
            eq(routeMaps.routeKey, input.routeKey),
            eq(routeMaps.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.routeMapId);
        await tx.delete(routeEvidence).where(inArray(routeEvidence.routeMapId, ids));
        await tx.delete(routeMaps).where(inArray(routeMaps.routeMapId, ids));
      }

      await tx.insert(routeMaps).values({
        routeMapId: input.routeMapId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        routeKey: input.routeKey,
        routeTitle: input.routeTitle,
        mapLocale: input.mapLocale,
        routeSummary: input.routeSummary,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        inputTokenEstimate: input.inputTokenEstimate,
        completionTokens: input.completionTokens,
        status: routeMapStatusValues.fresh,
        invalidatedAt: null,
        invalidatedReason: null,
        generatedAt: input.generatedAt,
      });

      await tx.insert(routeEvidence).values(
        input.citations.map((citation, index) => ({
          routeEvidenceId: `${input.routeMapId}:route:${index + 1}`,
          subjectKind: routeEvidenceSubjectKindValues.route,
          routeMapId: input.routeMapId,
          routeChoiceId: null,
          choiceOptionId: null,
          bridgeUnitId: citation.bridgeUnitId,
          citedSourceHash: citation.citedSourceHash,
          citeOrdinal: citation.citeOrdinal,
        })),
      );
    });

    const saved = await this.fetchRouteMapById(input.routeMapId);
    if (!saved) {
      throw new Error(`failed to load saved route map ${input.routeMapId}`);
    }
    return saved;
  }

  async saveRouteChoice(
    actor: AuthorizationActor,
    input: SaveRouteChoiceInput,
  ): Promise<RouteChoiceRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(`route choice ${input.routeChoiceId} must cite at least one bridge unit`);
    }
    assertOrdinalsUnique(input.citations, `route choice ${input.routeChoiceId}`);

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ routeChoiceId: routeChoices.routeChoiceId })
        .from(routeChoices)
        .where(
          and(
            eq(routeChoices.projectId, input.projectId),
            eq(routeChoices.localeBranchId, input.localeBranchId),
            eq(routeChoices.sourceRevisionId, input.sourceRevisionId),
            eq(routeChoices.choiceKey, input.choiceKey),
            eq(routeChoices.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.routeChoiceId);
        await tx.delete(routeEvidence).where(inArray(routeEvidence.routeChoiceId, ids));
        await tx.delete(routeChoices).where(inArray(routeChoices.routeChoiceId, ids));
      }

      await tx.insert(routeChoices).values({
        routeChoiceId: input.routeChoiceId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        choiceKey: input.choiceKey,
        kind: input.kind,
        fromRouteKey: input.fromRouteKey,
        promptSummary: input.promptSummary,
        mapLocale: input.mapLocale,
        options: input.options,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        status: routeChoiceStatusValues.fresh,
        invalidatedAt: null,
        invalidatedReason: null,
        generatedAt: input.generatedAt,
      });

      type EvidenceRow = {
        routeEvidenceId: string;
        subjectKind: RouteEvidenceSubjectKind;
        routeMapId: string | null;
        routeChoiceId: string | null;
        choiceOptionId: string | null;
        bridgeUnitId: string;
        citedSourceHash: string;
        citeOrdinal: number;
      };
      const choiceEvidenceRows: EvidenceRow[] = input.citations.map((citation, index) => ({
        routeEvidenceId: `${input.routeChoiceId}:choice:${index + 1}`,
        subjectKind: routeEvidenceSubjectKindValues.choice,
        routeMapId: null,
        routeChoiceId: input.routeChoiceId,
        choiceOptionId: null,
        bridgeUnitId: citation.bridgeUnitId,
        citedSourceHash: citation.citedSourceHash,
        citeOrdinal: citation.citeOrdinal,
      }));
      const optionEvidenceRows: EvidenceRow[] = [];
      for (const option of input.options) {
        for (let index = 0; index < option.targetUnitIds.length; index += 1) {
          const bridgeUnitId = option.targetUnitIds[index];
          const citedSourceHash = option.targetUnitHashes[index];
          if (!bridgeUnitId || !citedSourceHash) {
            throw new Error(
              `route choice ${input.routeChoiceId} option ${option.optionId} target citation arrays mismatched`,
            );
          }
          optionEvidenceRows.push({
            routeEvidenceId: `${input.routeChoiceId}:option:${option.optionId}:${index + 1}`,
            subjectKind: routeEvidenceSubjectKindValues.choiceOption,
            routeMapId: null,
            routeChoiceId: input.routeChoiceId,
            choiceOptionId: option.optionId,
            bridgeUnitId,
            citedSourceHash,
            citeOrdinal: index + 1,
          });
        }
      }
      const allEvidenceRows: EvidenceRow[] = [...choiceEvidenceRows, ...optionEvidenceRows];
      if (allEvidenceRows.length > 0) {
        await tx.insert(routeEvidence).values(allEvidenceRows);
      }
    });

    const saved = await this.fetchRouteChoiceById(input.routeChoiceId);
    if (!saved) {
      throw new Error(`failed to load saved route choice ${input.routeChoiceId}`);
    }
    return saved;
  }

  async loadRouteMapsByProject(
    actor: AuthorizationActor,
    query: LoadRouteMapsQuery,
  ): Promise<RouteMapRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(routeMaps.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(routeMaps.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(routeMaps.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.routeKey !== undefined) {
      conditions.push(eq(routeMaps.routeKey, query.routeKey));
    }
    if (query.status !== undefined) {
      conditions.push(eq(routeMaps.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(routeMaps.promptTemplateVersion, query.promptTemplateVersion));
    }

    const rows = await this.db
      .select()
      .from(routeMaps)
      .where(and(...conditions))
      .orderBy(
        asc(routeMaps.projectId),
        asc(routeMaps.localeBranchId),
        asc(routeMaps.sourceRevisionId),
        asc(routeMaps.routeKey),
        desc(routeMaps.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.routeMapId);
    const evidenceRows = await this.db
      .select()
      .from(routeEvidence)
      .where(inArray(routeEvidence.routeMapId, ids))
      .orderBy(asc(routeEvidence.routeMapId), asc(routeEvidence.citeOrdinal));
    const evidenceByMap = new Map<string, RouteCitationRecord[]>();
    for (const evidence of evidenceRows) {
      if (!evidence.routeMapId) continue;
      const bucket = evidenceByMap.get(evidence.routeMapId) ?? [];
      bucket.push({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      });
      evidenceByMap.set(evidence.routeMapId, bucket);
    }
    return rows.map((row) => routeMapRowToRecord(row, evidenceByMap.get(row.routeMapId) ?? []));
  }

  async loadRouteChoicesByProject(
    actor: AuthorizationActor,
    query: LoadRouteChoicesQuery,
  ): Promise<RouteChoiceRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(routeChoices.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(routeChoices.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(routeChoices.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.choiceKey !== undefined) {
      conditions.push(eq(routeChoices.choiceKey, query.choiceKey));
    }
    if (query.fromRouteKey !== undefined) {
      conditions.push(eq(routeChoices.fromRouteKey, query.fromRouteKey));
    }
    if (query.status !== undefined) {
      conditions.push(eq(routeChoices.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(routeChoices.promptTemplateVersion, query.promptTemplateVersion));
    }

    const rows = await this.db
      .select()
      .from(routeChoices)
      .where(and(...conditions))
      .orderBy(
        asc(routeChoices.projectId),
        asc(routeChoices.localeBranchId),
        asc(routeChoices.sourceRevisionId),
        asc(routeChoices.choiceKey),
        desc(routeChoices.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.routeChoiceId);
    const evidenceRows = await this.db
      .select()
      .from(routeEvidence)
      .where(inArray(routeEvidence.routeChoiceId, ids))
      .orderBy(asc(routeEvidence.routeChoiceId), asc(routeEvidence.citeOrdinal));
    const evidenceByChoice = new Map<string, RouteCitationRecord[]>();
    for (const evidence of evidenceRows) {
      if (!evidence.routeChoiceId) continue;
      if (evidence.subjectKind !== routeEvidenceSubjectKindValues.choice) {
        // Skip option-level rows; they're materialised in the JSON blob.
        continue;
      }
      const bucket = evidenceByChoice.get(evidence.routeChoiceId) ?? [];
      bucket.push({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      });
      evidenceByChoice.set(evidence.routeChoiceId, bucket);
    }
    return rows.map((row) =>
      routeChoiceRowToRecord(row, evidenceByChoice.get(row.routeChoiceId) ?? []),
    );
  }

  async markRouteMapStale(actor: AuthorizationActor, input: MarkRouteMapStaleInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(routeMaps)
      .set({
        status: routeMapStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(routeMaps.routeMapId, input.routeMapId),
          eq(routeMaps.status, routeMapStatusValues.fresh),
        ),
      );
  }

  async markRouteChoiceStale(
    actor: AuthorizationActor,
    input: MarkRouteChoiceStaleInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(routeChoices)
      .set({
        status: routeChoiceStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(routeChoices.routeChoiceId, input.routeChoiceId),
          eq(routeChoices.status, routeChoiceStatusValues.fresh),
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
      .where(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds));
    for (const row of rows) {
      result.set(row.bridgeUnitId, row.sourceHash);
    }
    return result;
  }

  private async fetchRouteMapById(routeMapId: string): Promise<RouteMapRecord | null> {
    const rows = await this.db
      .select()
      .from(routeMaps)
      .where(eq(routeMaps.routeMapId, routeMapId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return await this.hydrateRouteMap(row);
  }

  private async fetchRouteChoiceById(routeChoiceId: string): Promise<RouteChoiceRecord | null> {
    const rows = await this.db
      .select()
      .from(routeChoices)
      .where(eq(routeChoices.routeChoiceId, routeChoiceId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return await this.hydrateRouteChoice(row);
  }

  private async hydrateRouteMap(row: typeof routeMaps.$inferSelect): Promise<RouteMapRecord> {
    const evidenceRows = await this.db
      .select()
      .from(routeEvidence)
      .where(eq(routeEvidence.routeMapId, row.routeMapId))
      .orderBy(asc(routeEvidence.citeOrdinal));
    return routeMapRowToRecord(
      row,
      evidenceRows.map((evidence) => ({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      })),
    );
  }

  private async hydrateRouteChoice(
    row: typeof routeChoices.$inferSelect,
  ): Promise<RouteChoiceRecord> {
    const evidenceRows = await this.db
      .select()
      .from(routeEvidence)
      .where(
        and(
          eq(routeEvidence.routeChoiceId, row.routeChoiceId),
          eq(routeEvidence.subjectKind, routeEvidenceSubjectKindValues.choice),
        ),
      )
      .orderBy(asc(routeEvidence.citeOrdinal));
    return routeChoiceRowToRecord(
      row,
      evidenceRows.map((evidence) => ({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      })),
    );
  }
}

function assertOrdinalsUnique(citations: RouteCitationRecord[], label: string): void {
  const seen = new Set<number>();
  for (const citation of citations) {
    if (seen.has(citation.citeOrdinal)) {
      throw new Error(`${label} has duplicate cite ordinal ${citation.citeOrdinal}`);
    }
    seen.add(citation.citeOrdinal);
  }
}

function routeMapRowToRecord(
  row: typeof routeMaps.$inferSelect,
  citations: RouteCitationRecord[],
): RouteMapRecord {
  return {
    routeMapId: row.routeMapId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    routeKey: row.routeKey,
    routeTitle: row.routeTitle,
    mapLocale: row.mapLocale,
    routeSummary: row.routeSummary,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    inputTokenEstimate: row.inputTokenEstimate,
    completionTokens: row.completionTokens,
    status: row.status as RouteMapStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as RouteInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

function routeChoiceRowToRecord(
  row: typeof routeChoices.$inferSelect,
  citations: RouteCitationRecord[],
): RouteChoiceRecord {
  return {
    routeChoiceId: row.routeChoiceId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    choiceKey: row.choiceKey,
    kind: row.kind,
    fromRouteKey: row.fromRouteKey,
    promptSummary: row.promptSummary,
    mapLocale: row.mapLocale,
    options: parseOptionsBlob(row.options),
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    status: row.status as RouteChoiceStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as RouteInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

function parseOptionsBlob(value: unknown): RouteChoiceOptionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: RouteChoiceOptionRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const optionId = typeof row.optionId === "string" ? row.optionId : null;
    const optionIndex = typeof row.optionIndex === "number" ? row.optionIndex : null;
    const optionLabel = typeof row.optionLabel === "string" ? row.optionLabel : null;
    if (optionId === null || optionIndex === null || optionLabel === null) {
      continue;
    }
    const targetRouteKey =
      typeof row.targetRouteKey === "string" && row.targetRouteKey.length > 0
        ? row.targetRouteKey
        : null;
    const targetUnitIds = Array.isArray(row.targetUnitIds)
      ? row.targetUnitIds.filter((id): id is string => typeof id === "string")
      : [];
    const targetUnitHashes = Array.isArray(row.targetUnitHashes)
      ? row.targetUnitHashes.filter((hash): hash is string => typeof hash === "string")
      : [];
    records.push({
      optionId,
      optionIndex,
      optionLabel,
      targetRouteKey,
      targetUnitIds,
      targetUnitHashes,
    });
  }
  return records;
}

export {
  routeChoiceKindValues,
  routeChoiceStatusValues,
  routeEvidenceSubjectKindValues,
  routeInvalidatedReasonValues,
  routeMapStatusValues,
};
