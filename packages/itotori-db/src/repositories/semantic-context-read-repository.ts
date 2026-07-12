// Read projections over the central context-artifact store.
//
// This is intentionally read-only. Semantic agents write through
// ItotoriContextArtifactRepository; UI and CLI consumers decode their typed
// metadata here rather than reviving per-agent persistence tables.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  contextArtifactCategoryValues,
  contextArtifacts,
  contextArtifactSourceUnits,
  contextArtifactStatusValues,
} from "../schema.js";

export type SemanticContextCitation = {
  bridgeUnitId: string;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type ContextSceneSummary = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sceneId: string;
  summaryLocale: string;
  summaryText: string;
  promptTemplateVersion: string | null;
  status: "Fresh" | "Stale";
  invalidatedAt: Date | null;
  generatedAt: Date;
  citations: SemanticContextCitation[];
};

export type ContextRouteMap = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  routeKey: string;
  routeTitle: string;
  routeSummary: string;
  status: "Fresh" | "Stale";
  generatedAt: Date;
  citations: SemanticContextCitation[];
};

export type ContextRouteChoiceOption = {
  optionId: string;
  optionIndex: number;
  optionLabel: string;
  targetRouteKey: string | null;
  targetUnitIds: string[];
  targetUnitHashes: string[];
};

export type ContextRouteChoice = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  choiceKey: string;
  kind: string;
  fromRouteKey: string | null;
  promptSummary: string;
  options: ContextRouteChoiceOption[];
  status: "Fresh" | "Stale";
  generatedAt: Date;
  citations: SemanticContextCitation[];
};

export type LoadCentralSemanticContextQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  includeStale?: boolean;
};

export class ItotoriSemanticContextReadRepository {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSceneSummaries(
    actor: AuthorizationActor,
    query: LoadCentralSemanticContextQuery,
  ): Promise<ContextSceneSummary[]> {
    const rows = await this.loadArtifacts(actor, query, contextArtifactCategoryValues.sceneSummary);
    const summaries = rows.filter((row) => stringValue(row.data.sceneId) !== undefined);
    const citations = await this.loadCitations(summaries.map((row) => row.contextArtifactId));
    return summaries.map((row) => ({
      contextArtifactId: row.contextArtifactId,
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      sourceRevisionId: row.sourceRevisionId,
      sceneId: stringValue(row.data.sceneId) ?? row.title,
      summaryLocale: stringValue(row.data.summaryLocale) ?? "",
      summaryText: row.body,
      promptTemplateVersion: stringValue(row.data.promptTemplateVersion) ?? null,
      status: normalizedStatus(row.status),
      invalidatedAt: row.invalidatedAt,
      generatedAt: generatedAt(row.data.generatedAt, row.updatedAt),
      citations: citations.get(row.contextArtifactId) ?? [],
    }));
  }

  async loadRouteMaps(
    actor: AuthorizationActor,
    query: LoadCentralSemanticContextQuery,
  ): Promise<ContextRouteMap[]> {
    const rows = await this.loadArtifacts(actor, query, contextArtifactCategoryValues.routeMap);
    const maps = rows.filter((row) => stringValue(row.data.routeKey) !== undefined);
    const citations = await this.loadCitations(maps.map((row) => row.contextArtifactId));
    return maps.map((row) => ({
      contextArtifactId: row.contextArtifactId,
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      sourceRevisionId: row.sourceRevisionId,
      routeKey: stringValue(row.data.routeKey) ?? row.title,
      routeTitle: stringValue(row.data.routeTitle) ?? row.title,
      routeSummary: row.body,
      status: normalizedStatus(row.status),
      generatedAt: generatedAt(row.data.generatedAt, row.updatedAt),
      citations: citations.get(row.contextArtifactId) ?? [],
    }));
  }

  async loadRouteChoices(
    actor: AuthorizationActor,
    query: LoadCentralSemanticContextQuery,
  ): Promise<ContextRouteChoice[]> {
    const rows = await this.loadArtifacts(actor, query, contextArtifactCategoryValues.routeMap);
    const choices = rows.filter((row) => stringValue(row.data.choiceKey) !== undefined);
    const citations = await this.loadCitations(choices.map((row) => row.contextArtifactId));
    return choices.map((row) => ({
      contextArtifactId: row.contextArtifactId,
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      sourceRevisionId: row.sourceRevisionId,
      choiceKey: stringValue(row.data.choiceKey) ?? row.title,
      kind: stringValue(row.data.kind) ?? "Other",
      fromRouteKey: stringValue(row.data.fromRouteKey) ?? null,
      promptSummary: row.body,
      options: optionRecords(row.data.options),
      status: normalizedStatus(row.status),
      generatedAt: generatedAt(row.data.generatedAt, row.updatedAt),
      citations: citations.get(row.contextArtifactId) ?? [],
    }));
  }

  private async loadArtifacts(
    actor: AuthorizationActor,
    query: LoadCentralSemanticContextQuery,
    category: string,
  ) {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const conditions = [
      eq(contextArtifacts.projectId, query.projectId),
      eq(contextArtifacts.category, category),
    ];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(contextArtifacts.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(contextArtifacts.sourceRevisionId, query.sourceRevisionId));
    }
    if (!query.includeStale) {
      conditions.push(eq(contextArtifacts.status, contextArtifactStatusValues.active));
    }
    return await this.db
      .select()
      .from(contextArtifacts)
      .where(and(...conditions))
      .orderBy(asc(contextArtifacts.contextArtifactId));
  }

  private async loadCitations(
    contextArtifactIds: string[],
  ): Promise<Map<string, SemanticContextCitation[]>> {
    const byArtifact = new Map<string, SemanticContextCitation[]>();
    if (contextArtifactIds.length === 0) {
      return byArtifact;
    }
    const rows = await this.db
      .select({
        contextArtifactId: contextArtifactSourceUnits.contextArtifactId,
        bridgeUnitId: contextArtifactSourceUnits.bridgeUnitId,
        sourceHash: contextArtifactSourceUnits.sourceHash,
      })
      .from(contextArtifactSourceUnits)
      .where(inArray(contextArtifactSourceUnits.contextArtifactId, contextArtifactIds))
      .orderBy(
        asc(contextArtifactSourceUnits.contextArtifactId),
        asc(contextArtifactSourceUnits.bridgeUnitId),
      );
    for (const row of rows) {
      const values = byArtifact.get(row.contextArtifactId) ?? [];
      values.push({
        bridgeUnitId: row.bridgeUnitId,
        citedSourceHash: row.sourceHash,
        citeOrdinal: values.length + 1,
      });
      byArtifact.set(row.contextArtifactId, values);
    }
    return byArtifact;
  }
}

function normalizedStatus(value: string): "Fresh" | "Stale" {
  return value === contextArtifactStatusValues.active ? "Fresh" : "Stale";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function generatedAt(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function optionRecords(value: unknown): ContextRouteChoiceOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const results: ContextRouteChoiceOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const optionIndex = typeof record.optionIndex === "number" ? record.optionIndex : undefined;
    const optionLabel = stringValue(record.optionLabel);
    if (optionIndex === undefined || optionLabel === undefined) {
      continue;
    }
    results.push({
      optionId: stringValue(record.optionId) ?? `option:${optionIndex}`,
      optionIndex,
      optionLabel,
      targetRouteKey: stringValue(record.targetRouteKey) ?? null,
      targetUnitIds: stringArray(record.targetUnitIds),
      targetUnitHashes: stringArray(record.targetUnitHashes),
    });
  }
  return results;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
