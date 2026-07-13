// Generic wiki read projection over the versioned central context brain.
//
// This deliberately reads the node-6 `contextArtifacts` / `contextEntryVersions`
// tables directly instead of reviving an agent-specific wiki store. The current
// head supplies browse/list data while the append-only versions preserve the
// provenance, citations, and affected-unit impact that a play tester needs to
// inspect before submitting a node-8 correction.

import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  contextArtifactCategoryValues,
  contextArtifactStatusValues,
  contextArtifacts,
  contextArtifactSourceUnits,
  contextEntryVersions,
  type ContextArtifactCategory,
  type ContextArtifactStatus,
  type ContextEntryVersionCitation,
} from "../schema.js";

export const WIKI_CONTEXT_ENTRIES_SCHEMA_VERSION = "wiki.context.entries.v0.1" as const;
export const WIKI_CONTEXT_ENTRY_SCHEMA_VERSION = "wiki.context.entry.v0.1" as const;
export const WIKI_CONTEXT_ENTRY_HISTORY_SCHEMA_VERSION = "wiki.context.entry-history.v0.1" as const;

/** Human-facing kinds projected from the central context-artifact categories. */
export const wikiContextEntryKindValues = {
  scene: "scene",
  character: "character",
  route: "route",
  term: "term",
  speaker: "speaker",
  glossary: "glossary",
  style: "style",
  note: "note",
} as const;

export type WikiContextEntryKind =
  (typeof wikiContextEntryKindValues)[keyof typeof wikiContextEntryKindValues];

export type WikiContextCitation = {
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceHash: string;
  citation: string;
  metadata: Record<string, unknown>;
};

/** Producer metadata plus the unmodified canonical provenance payload. */
export type WikiContextProvenance = {
  producedByAgent: string | null;
  producedByTool: string | null;
  producerVersion: string;
  createdByUserId: string | null;
  /** Common run-origin fields are promoted for convenient browse rendering. */
  origin: string | null;
  runId: string | null;
  providerRunId: string | null;
  provenance: Record<string, unknown>;
};

/** Impact of this head/version on downstream packets and redrafts. */
export type WikiContextImpact = {
  affectedUnitIds: string[];
  invalidatedReason: string | null;
  invalidatedAt: Date | null;
};

/** The current mutable head of one canonical ContextEntry. */
export type WikiContextEntry = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: ContextArtifactCategory;
  kind: WikiContextEntryKind;
  status: ContextArtifactStatus;
  title: string;
  body: string;
  data: Record<string, unknown>;
  contentHash: string;
  headVersionId: string | null;
  versionCount: number;
  provenance: WikiContextProvenance;
  citations: WikiContextCitation[];
  impact: WikiContextImpact;
  createdAt: Date;
  updatedAt: Date;
};

/** An immutable historical ContextEntryVersion, including its citation snapshot. */
export type WikiContextEntryVersion = {
  contextEntryVersionId: string;
  contextArtifactId: string;
  parentVersionId: string | null;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: ContextArtifactCategory;
  kind: WikiContextEntryKind;
  status: ContextArtifactStatus;
  title: string;
  body: string;
  data: Record<string, unknown>;
  contentHash: string;
  provenance: WikiContextProvenance;
  citations: WikiContextCitation[];
  impact: WikiContextImpact;
  createdAt: Date;
  isHead: boolean;
};

export type WikiContextEntryDetail = WikiContextEntry & {
  /** Oldest-to-newest immutable lineage, including the selected head. */
  history: WikiContextEntryVersion[];
};

export type WikiContextEntriesFilter = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId?: string;
  kind?: WikiContextEntryKind;
  /** Defaults to true so the wiki exposes stale enrichment rather than hiding it. */
  includeStale?: boolean;
  limit?: number;
  offset?: number;
};

export type WikiContextEntryLookup = {
  projectId: string;
  localeBranchId: string;
  contextArtifactId: string;
};

export type WikiContextPagination = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type WikiContextEntriesReadModel = {
  schemaVersion: typeof WIKI_CONTEXT_ENTRIES_SCHEMA_VERSION;
  generatedAt: Date;
  filter: {
    projectId: string;
    localeBranchId: string;
    sourceRevisionId: string | null;
    kind: WikiContextEntryKind | null;
    includeStale: boolean;
  };
  pagination: WikiContextPagination;
  entries: WikiContextEntry[];
};

export type WikiContextEntryReadModel = {
  schemaVersion: typeof WIKI_CONTEXT_ENTRY_SCHEMA_VERSION;
  generatedAt: Date;
  entry: WikiContextEntryDetail;
};

export type WikiContextEntryHistoryReadModel = {
  schemaVersion: typeof WIKI_CONTEXT_ENTRY_HISTORY_SCHEMA_VERSION;
  generatedAt: Date;
  contextArtifactId: string;
  headVersionId: string | null;
  versions: WikiContextEntryVersion[];
};

export interface ItotoriWikiContextRepositoryPort {
  listEntries(
    actor: AuthorizationActor,
    filter: WikiContextEntriesFilter,
  ): Promise<WikiContextEntriesReadModel>;
  showEntry(
    actor: AuthorizationActor,
    input: WikiContextEntryLookup,
  ): Promise<WikiContextEntryReadModel | null>;
  listEntryHistory(
    actor: AuthorizationActor,
    input: WikiContextEntryLookup,
  ): Promise<WikiContextEntryHistoryReadModel | null>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read-only, catalog.read-gated browse/detail/history projection of node-6
 * context. Mutations remain exclusively with ContextCorrectionService/node 8.
 */
export class ItotoriWikiContextRepository implements ItotoriWikiContextRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async listEntries(
    actor: AuthorizationActor,
    filter: WikiContextEntriesFilter,
  ): Promise<WikiContextEntriesReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const { limit, offset } = normalizePagination(filter);
    const includeStale = filter.includeStale ?? true;
    const conditions = listConditions(filter, includeStale);
    const countRows = await this.db
      .select({ total: count() })
      .from(contextArtifacts)
      .where(and(...conditions));
    const total = countRows[0]?.total ?? 0;
    const artifacts = await this.db
      .select()
      .from(contextArtifacts)
      .where(and(...conditions))
      .orderBy(
        asc(contextArtifacts.category),
        asc(contextArtifacts.normalizedTitle),
        asc(contextArtifacts.contextArtifactId),
      )
      .limit(limit)
      .offset(offset);
    const citationsByArtifact = await this.loadCurrentCitations(
      artifacts.map((artifact) => artifact.contextArtifactId),
    );
    const versionsByArtifact = await this.loadVersions(
      artifacts.map((artifact) => artifact.contextArtifactId),
    );
    const nextOffset = offset + limit < total ? offset + limit : null;

    return {
      schemaVersion: WIKI_CONTEXT_ENTRIES_SCHEMA_VERSION,
      generatedAt: new Date(),
      filter: {
        projectId: filter.projectId,
        localeBranchId: filter.localeBranchId,
        sourceRevisionId: filter.sourceRevisionId ?? null,
        kind: filter.kind ?? null,
        includeStale,
      },
      pagination: {
        total,
        limit,
        offset,
        hasMore: nextOffset !== null,
        nextOffset,
      },
      entries: artifacts.map((artifact) =>
        entryFromArtifact(
          artifact,
          citationsByArtifact.get(artifact.contextArtifactId) ?? [],
          versionsByArtifact.get(artifact.contextArtifactId) ?? [],
        ),
      ),
    };
  }

  async showEntry(
    actor: AuthorizationActor,
    input: WikiContextEntryLookup,
  ): Promise<WikiContextEntryReadModel | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const detail = await this.loadEntryDetail(input);
    if (detail === null) {
      return null;
    }
    return {
      schemaVersion: WIKI_CONTEXT_ENTRY_SCHEMA_VERSION,
      generatedAt: new Date(),
      entry: detail,
    };
  }

  async listEntryHistory(
    actor: AuthorizationActor,
    input: WikiContextEntryLookup,
  ): Promise<WikiContextEntryHistoryReadModel | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const detail = await this.loadEntryDetail(input);
    if (detail === null) {
      return null;
    }
    return {
      schemaVersion: WIKI_CONTEXT_ENTRY_HISTORY_SCHEMA_VERSION,
      generatedAt: new Date(),
      contextArtifactId: detail.contextArtifactId,
      headVersionId: detail.headVersionId,
      versions: detail.history,
    };
  }

  private async loadEntryDetail(
    input: WikiContextEntryLookup,
  ): Promise<WikiContextEntryDetail | null> {
    const [artifact] = await this.db
      .select()
      .from(contextArtifacts)
      .where(
        and(
          eq(contextArtifacts.contextArtifactId, input.contextArtifactId),
          eq(contextArtifacts.projectId, input.projectId),
          eq(contextArtifacts.localeBranchId, input.localeBranchId),
        ),
      )
      .limit(1);
    if (artifact === undefined) {
      return null;
    }
    const citationsByArtifact = await this.loadCurrentCitations([artifact.contextArtifactId]);
    const versionsByArtifact = await this.loadVersions([artifact.contextArtifactId]);
    const versions = versionsByArtifact.get(artifact.contextArtifactId) ?? [];
    return {
      ...entryFromArtifact(
        artifact,
        citationsByArtifact.get(artifact.contextArtifactId) ?? [],
        versions,
      ),
      history: versions.map((version) => versionFromRow(version, artifact.headVersionId)),
    };
  }

  private async loadCurrentCitations(
    contextArtifactIds: string[],
  ): Promise<Map<string, WikiContextCitation[]>> {
    const result = new Map<string, WikiContextCitation[]>();
    const ids = uniqueStrings(contextArtifactIds);
    if (ids.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        contextArtifactId: contextArtifactSourceUnits.contextArtifactId,
        bridgeUnitId: contextArtifactSourceUnits.bridgeUnitId,
        sourceRevisionId: contextArtifactSourceUnits.sourceRevisionId,
        sourceHash: contextArtifactSourceUnits.sourceHash,
        citation: contextArtifactSourceUnits.citation,
        metadata: contextArtifactSourceUnits.metadata,
      })
      .from(contextArtifactSourceUnits)
      .where(inArray(contextArtifactSourceUnits.contextArtifactId, ids))
      .orderBy(
        asc(contextArtifactSourceUnits.contextArtifactId),
        asc(contextArtifactSourceUnits.bridgeUnitId),
      );
    for (const row of rows) {
      const citations = result.get(row.contextArtifactId) ?? [];
      citations.push(citationFromRecord(row));
      result.set(row.contextArtifactId, citations);
    }
    return result;
  }

  private async loadVersions(
    contextArtifactIds: string[],
  ): Promise<Map<string, ContextEntryVersionRow[]>> {
    const result = new Map<string, ContextEntryVersionRow[]>();
    const ids = uniqueStrings(contextArtifactIds);
    if (ids.length === 0) {
      return result;
    }
    const rows = await this.db
      .select()
      .from(contextEntryVersions)
      .where(inArray(contextEntryVersions.contextArtifactId, ids))
      .orderBy(
        asc(contextEntryVersions.contextArtifactId),
        asc(contextEntryVersions.createdAt),
        asc(contextEntryVersions.contextEntryVersionId),
      );
    for (const row of rows) {
      const versions = result.get(row.contextArtifactId) ?? [];
      versions.push(row);
      result.set(row.contextArtifactId, versions);
    }
    return result;
  }
}

type ContextArtifactRow = typeof contextArtifacts.$inferSelect;
type ContextEntryVersionRow = typeof contextEntryVersions.$inferSelect;

function entryFromArtifact(
  artifact: ContextArtifactRow,
  citations: WikiContextCitation[],
  versions: ContextEntryVersionRow[],
): WikiContextEntry {
  const head = versions.find((version) => version.contextEntryVersionId === artifact.headVersionId);
  return {
    contextArtifactId: artifact.contextArtifactId,
    projectId: artifact.projectId,
    localeBranchId: artifact.localeBranchId,
    sourceRevisionId: artifact.sourceRevisionId,
    category: asContextArtifactCategory(artifact.category),
    kind: kindForCategory(artifact.category),
    status: artifact.status as ContextArtifactStatus,
    title: artifact.title,
    body: artifact.body,
    data: artifact.data,
    contentHash: artifact.contentHash,
    headVersionId: artifact.headVersionId,
    versionCount: versions.length,
    // The mutable artifact keeps its original `createdByUserId`; the canonical
    // head's immutable version is the authoritative author/provenance of the
    // content currently being shown. Without this, a later play-tester edit
    // would display the original generator's user id beside the edited head.
    provenance: provenanceFromRecord(head ?? artifact),
    citations,
    impact: {
      affectedUnitIds: head?.affectedUnitIds ?? [],
      invalidatedReason: artifact.invalidatedReason,
      invalidatedAt: artifact.invalidatedAt,
    },
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function versionFromRow(
  version: ContextEntryVersionRow,
  headVersionId: string | null,
): WikiContextEntryVersion {
  return {
    contextEntryVersionId: version.contextEntryVersionId,
    contextArtifactId: version.contextArtifactId,
    parentVersionId: version.parentVersionId,
    projectId: version.projectId,
    localeBranchId: version.localeBranchId,
    sourceRevisionId: version.sourceRevisionId,
    category: asContextArtifactCategory(version.category),
    kind: kindForCategory(version.category),
    status: version.status as ContextArtifactStatus,
    title: version.title,
    body: version.body,
    data: version.data,
    contentHash: version.contentHash,
    provenance: provenanceFromRecord(version),
    citations: version.citations.map(citationFromRecord),
    impact: {
      affectedUnitIds: [...version.affectedUnitIds],
      invalidatedReason: version.invalidatedReason,
      invalidatedAt: version.invalidatedAt,
    },
    createdAt: version.createdAt,
    isHead: version.contextEntryVersionId === headVersionId,
  };
}

function citationFromRecord(
  citation: Pick<
    ContextEntryVersionCitation,
    "bridgeUnitId" | "sourceRevisionId" | "sourceHash" | "citation" | "metadata"
  >,
): WikiContextCitation {
  return {
    bridgeUnitId: citation.bridgeUnitId,
    sourceRevisionId: citation.sourceRevisionId,
    sourceHash: citation.sourceHash,
    citation: citation.citation,
    metadata: citation.metadata,
  };
}

function provenanceFromRecord(
  record: Pick<
    ContextArtifactRow,
    | "producedByAgent"
    | "producedByTool"
    | "producerVersion"
    | "createdByUserId"
    | "data"
    | "provenance"
  >,
): WikiContextProvenance {
  return {
    producedByAgent: record.producedByAgent,
    producedByTool: record.producedByTool,
    producerVersion: record.producerVersion,
    createdByUserId: record.createdByUserId,
    origin: nullableString(record.provenance.origin) ?? nullableString(record.provenance.kind),
    runId: nullableString(record.provenance.runId) ?? nullableString(record.data.runId),
    providerRunId:
      nullableString(record.provenance.providerRunId) ?? nullableString(record.data.providerRunId),
    provenance: record.provenance,
  };
}

function listConditions(filter: WikiContextEntriesFilter, includeStale: boolean) {
  const conditions = [
    eq(contextArtifacts.projectId, filter.projectId),
    eq(contextArtifacts.localeBranchId, filter.localeBranchId),
  ];
  if (filter.sourceRevisionId !== undefined) {
    conditions.push(eq(contextArtifacts.sourceRevisionId, filter.sourceRevisionId));
  }
  if (filter.kind !== undefined) {
    conditions.push(eq(contextArtifacts.category, categoryForKind(filter.kind)));
  }
  if (!includeStale) {
    conditions.push(eq(contextArtifacts.status, contextArtifactStatusValues.active));
  }
  return conditions;
}

function normalizePagination(filter: WikiContextEntriesFilter): { limit: number; offset: number } {
  const limit = filter.limit ?? DEFAULT_LIMIT;
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("wiki context entries limit must be a positive integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("wiki context entries offset must be a non-negative integer");
  }
  return { limit: Math.min(limit, MAX_LIMIT), offset };
}

function categoryForKind(kind: WikiContextEntryKind): ContextArtifactCategory {
  switch (kind) {
    case wikiContextEntryKindValues.scene:
      return contextArtifactCategoryValues.sceneSummary;
    case wikiContextEntryKindValues.character:
      return contextArtifactCategoryValues.characterNote;
    case wikiContextEntryKindValues.route:
      return contextArtifactCategoryValues.routeMap;
    case wikiContextEntryKindValues.term:
      return contextArtifactCategoryValues.terminologyCandidate;
    case wikiContextEntryKindValues.speaker:
      return contextArtifactCategoryValues.speakerLabel;
    case wikiContextEntryKindValues.glossary:
      return contextArtifactCategoryValues.glossary;
    case wikiContextEntryKindValues.style:
      return contextArtifactCategoryValues.style;
    case wikiContextEntryKindValues.note:
      return contextArtifactCategoryValues.contextNote;
  }
}

function kindForCategory(category: string): WikiContextEntryKind {
  switch (category) {
    case contextArtifactCategoryValues.sceneSummary:
      return wikiContextEntryKindValues.scene;
    case contextArtifactCategoryValues.characterNote:
      return wikiContextEntryKindValues.character;
    case contextArtifactCategoryValues.routeMap:
      return wikiContextEntryKindValues.route;
    case contextArtifactCategoryValues.terminologyCandidate:
      return wikiContextEntryKindValues.term;
    case contextArtifactCategoryValues.speakerLabel:
      return wikiContextEntryKindValues.speaker;
    case contextArtifactCategoryValues.glossary:
      return wikiContextEntryKindValues.glossary;
    case contextArtifactCategoryValues.style:
      return wikiContextEntryKindValues.style;
    case contextArtifactCategoryValues.contextNote:
      return wikiContextEntryKindValues.note;
    default:
      throw new Error(`unsupported wiki context category ${category}`);
  }
}

function asContextArtifactCategory(category: string): ContextArtifactCategory {
  kindForCategory(category);
  return category as ContextArtifactCategory;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
