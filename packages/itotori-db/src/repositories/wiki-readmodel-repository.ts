import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  contextArtifactCategoryValues,
  contextArtifactStatusValues,
  contextArtifacts,
  contextArtifactSourceUnits,
  contextEntryVersions,
  localeBranches,
  projects,
  sourceUnits,
  terminologyAliases,
  terminologySourceReferences,
  terminologyTermStatusValues,
  terminologyTerms,
  wikiBrandContextMemberships,
  wikiBrandContexts,
} from "../schema.js";
import type {
  ContextArtifactCategory,
  ContextArtifactStatus,
  ContextEntryVersionCitation,
  TerminologyAliasKind,
  TerminologySourceReferenceKind,
  TerminologyTermKind,
  TerminologyTermStatus,
  WikiBrandContextRole,
} from "../schema.js";

export const WIKI_ENTRIES_SCHEMA_VERSION = "wiki.entries.v0.1" as const;

export const wikiEntryKindValues = {
  character: "character",
  term: "term",
} as const;

export type WikiEntryKind = (typeof wikiEntryKindValues)[keyof typeof wikiEntryKindValues];

/**
 * The wiki is a durable read projection over central context entries. These
 * values deliberately remain stable even though the retired character-agent
 * tables no longer own their own enum types.
 */
export type CharacterBioStatus = "Fresh" | "Stale";

export type CharacterRelationshipStatus = "Fresh" | "Stale";

export type CharacterRelationshipKind =
  | "FamilyRelation"
  | "Romantic"
  | "Friendship"
  | "Mentor"
  | "Rivalry"
  | "Allegiance"
  | "Antagonism"
  | "Other";

export type CharacterRelationshipDirection = "Symmetric" | "FromAToB";

export type WikiEntriesFilter = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId?: string;
  kind?: WikiEntryKind;
  limit?: number;
  offset?: number;
};

export type WikiEntriesPagination = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type WikiCrossReference = {
  refKind: "character" | "term" | "scene" | "source_unit";
  refId: string;
  label: string;
  relation: string;
};

export type WikiCitation = {
  bridgeUnitId: string;
  sourceUnitKey: string | null;
  occurrenceId: string | null;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type WikiEntryScope = {
  inheritance: "local" | "brand_context";
  requestedProjectId: string;
  requestedLocaleBranchId: string;
  sourceProjectId: string;
  sourceLocaleBranchId: string;
  brandContextId: string | null;
  brandContextKey: string | null;
  brandContextName: string | null;
  brandContextRole: WikiBrandContextRole | null;
};

export type WikiCharacterRevision = {
  /** Stable central ContextEntry id, retained under the legacy field name. */
  characterBioId: string;
  /** Immutable snapshot id for this historical revision. */
  contextEntryVersionId: string | null;
  sourceRevisionId: string;
  status: CharacterBioStatus;
  generatedAt: Date;
};

export type WikiCharacterRelationship = {
  characterRelationshipId: string;
  toCharacterId: string;
  kind: CharacterRelationshipKind;
  direction: CharacterRelationshipDirection;
  descriptor: string;
  descriptorLocale: string;
  status: CharacterRelationshipStatus;
  generatedAt: Date;
  citations: WikiCitation[];
};

export type WikiCharacterEntry = {
  entryId: string;
  kind: typeof wikiEntryKindValues.character;
  projectId: string;
  localeBranchId: string;
  scope: WikiEntryScope;
  sourceRevisionId: string;
  title: string;
  characterId: string;
  bio: {
    /** Stable central ContextEntry id, retained under the legacy field name. */
    characterBioId: string;
    /** The immutable version selected for this rendered bio. */
    contextEntryVersionId: string | null;
    locale: string;
    text: string;
    status: CharacterBioStatus;
    stale: boolean;
    generatedAt: Date;
  };
  appearances: WikiCitation[];
  related: WikiCrossReference[];
  relationships: WikiCharacterRelationship[];
  revisions: WikiCharacterRevision[];
};

export type WikiTermAlias = {
  aliasId: string;
  aliasText: string;
  aliasKind: TerminologyAliasKind;
  locale: string | null;
};

export type WikiTermReference = {
  sourceRefId: string;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context: string | null;
};

export type WikiTermEntry = {
  entryId: string;
  kind: typeof wikiEntryKindValues.term;
  projectId: string;
  localeBranchId: string;
  scope: WikiEntryScope;
  title: string;
  termId: string;
  sourceTerm: string;
  preferredTranslation: string;
  sourceLocale: string;
  targetLocale: string;
  termKind: TerminologyTermKind;
  partOfSpeech: string | null;
  status: TerminologyTermStatus;
  notes: string | null;
  aliases: WikiTermAlias[];
  references: WikiTermReference[];
  related: WikiCrossReference[];
};

export type WikiEntry = WikiCharacterEntry | WikiTermEntry;

export type WikiBrandContextInheritedSource = WikiEntryScope & {
  inheritedCharacterArcs: boolean;
  inheritedGlossary: boolean;
  inheritedContext: boolean;
};

export type WikiBrandContextSummary = {
  brandContextId: string;
  contextKey: string;
  name: string;
  requestedRole: WikiBrandContextRole;
  inheritedSources: WikiBrandContextInheritedSource[];
};

export type WikiInheritedContextArtifact = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  category: ContextArtifactCategory;
  status: ContextArtifactStatus;
  title: string;
  body: string;
  source: WikiEntryScope;
};

export type WikiBrandContextReadModel = {
  requestedProjectId: string;
  requestedLocaleBranchId: string;
  contexts: WikiBrandContextSummary[];
  inheritedContextArtifacts: WikiInheritedContextArtifact[];
};

export type WikiEntriesReadModel = {
  schemaVersion: typeof WIKI_ENTRIES_SCHEMA_VERSION;
  generatedAt: Date;
  filter: {
    projectId: string;
    localeBranchId: string;
    sourceRevisionId: string | null;
    kind: WikiEntryKind | null;
  };
  pagination: WikiEntriesPagination;
  brandContext: WikiBrandContextReadModel;
  entries: WikiEntry[];
};

export interface ItotoriWikiReadmodelRepositoryPort {
  loadEntries(actor: AuthorizationActor, filter: WikiEntriesFilter): Promise<WikiEntriesReadModel>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ItotoriWikiReadmodelRepository implements ItotoriWikiReadmodelRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadEntries(
    actor: AuthorizationActor,
    filter: WikiEntriesFilter,
  ): Promise<WikiEntriesReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    await this.requireBranch(filter.projectId, filter.localeBranchId);

    const limit = clampLimit(filter.limit);
    const offset = filter.offset ?? 0;
    if (offset < 0) {
      throw new Error("wiki.entries offset must be non-negative");
    }

    const scope = await this.resolveBrandContextScope(filter.projectId, filter.localeBranchId);
    const characters =
      filter.kind === wikiEntryKindValues.term
        ? []
        : await this.loadCharacterEntries(filter, sourcesForCharacterArcs(scope.sources));
    const terms =
      filter.kind === wikiEntryKindValues.character
        ? []
        : await this.loadTermEntries(filter, sourcesForGlossary(scope.sources));
    const allEntries = [...characters, ...terms].sort(compareEntries);
    const entries = allEntries.slice(offset, offset + limit);
    const nextOffset = offset + limit < allEntries.length ? offset + limit : null;
    return {
      schemaVersion: WIKI_ENTRIES_SCHEMA_VERSION,
      generatedAt: new Date(),
      filter: {
        projectId: filter.projectId,
        localeBranchId: filter.localeBranchId,
        sourceRevisionId: filter.sourceRevisionId ?? null,
        kind: filter.kind ?? null,
      },
      pagination: {
        total: allEntries.length,
        limit,
        offset,
        hasMore: nextOffset !== null,
        nextOffset,
      },
      brandContext: {
        requestedProjectId: filter.projectId,
        requestedLocaleBranchId: filter.localeBranchId,
        contexts: scope.contexts,
        inheritedContextArtifacts: await this.loadInheritedContextArtifacts(
          filter,
          sourcesForContext(scope.sources),
        ),
      },
      entries,
    };
  }

  private async requireBranch(projectId: string, localeBranchId: string): Promise<void> {
    const rows = await this.db
      .select({ total: count() })
      .from(localeBranches)
      .innerJoin(projects, eq(projects.projectId, localeBranches.projectId))
      .where(
        and(eq(projects.projectId, projectId), eq(localeBranches.localeBranchId, localeBranchId)),
      )
      .limit(1);
    if ((rows[0]?.total ?? 0) === 0) {
      throw new Error(`locale branch ${localeBranchId} does not exist for project ${projectId}`);
    }
  }

  private async loadCharacterEntries(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<WikiCharacterEntry[]> {
    const projectionSet = await this.loadCharacterArtifactProjections(filter, sources);
    const bioRows = projectionSet.projections.filter(isCharacterBioProjection);
    if (bioRows.length === 0) {
      return [];
    }

    const citationsByArtifact = await this.loadArtifactCitations(
      projectionSet.artifacts.map((row) => row.contextArtifactId),
    );
    const citationsByVersion = await this.loadVersionCitations(bioRows);

    const relationshipRows = await this.loadRelationships(filter, sources);
    const relationshipsByCharacter = new Map<string, WikiCharacterRelationship[]>();
    const relatedByCharacter = new Map<string, WikiCrossReference[]>();
    for (const relationship of relationshipRows) {
      pushMap(relationshipsByCharacter, relationship.fromCharacterId, relationship);
      pushUniqueCrossRef(relatedByCharacter, relationship.fromCharacterId, {
        refKind: "character",
        refId: relationship.toCharacterId,
        label: relationship.toCharacterId,
        relation: relationship.kind,
      });
      pushUniqueCrossRef(relatedByCharacter, relationship.toCharacterId, {
        refKind: "character",
        refId: relationship.fromCharacterId,
        label: relationship.fromCharacterId,
        relation: relationship.kind,
      });
    }

    const byCharacter = new Map<string, CharacterArtifactProjection[]>();
    for (const row of bioRows) {
      const characterId = characterIdForBio(row.data);
      if (characterId === undefined) {
        continue;
      }
      const existing = byCharacter.get(characterId);
      if (existing !== undefined && existing[0]?.wikiSource !== row.wikiSource) {
        continue;
      }
      pushMap(byCharacter, characterId, row);
    }

    const entries: WikiCharacterEntry[] = [];
    for (const [characterId, revisions] of byCharacter.entries()) {
      const current = selectCurrentCharacterProjection(revisions);
      if (current === undefined) {
        continue;
      }
      const versionRows = revisions.flatMap((row) =>
        versionsForProjection(row, projectionSet.versionsByArtifact, filter),
      );
      entries.push({
        entryId: `character:${characterId}`,
        kind: wikiEntryKindValues.character,
        projectId: current.projectId,
        localeBranchId: current.localeBranchId,
        scope: scopeForSource(filter, current.wikiSource),
        sourceRevisionId: current.sourceRevisionId,
        title: characterId,
        characterId,
        bio: {
          characterBioId: current.contextArtifactId,
          contextEntryVersionId: current.contextEntryVersionId,
          locale: stringValue(current.data.bioLocale) ?? "",
          text: current.body,
          status: normalizedCharacterStatus(current.status),
          stale: current.status !== contextArtifactStatusValues.active,
          generatedAt: current.generatedAt,
        },
        appearances:
          (current.citationSnapshot === null
            ? citationsByArtifact.get(current.contextArtifactId)
            : citationsByVersion.get(current.citationKey)) ?? [],
        related: relatedByCharacter.get(characterId) ?? [],
        relationships: relationshipsByCharacter.get(characterId) ?? [],
        revisions: wikiCharacterRevisions(versionRows, revisions),
      });
    }
    return entries;
  }

  private async loadRelationships(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<Array<WikiCharacterRelationship & { fromCharacterId: string }>> {
    const projectionSet = await this.loadCharacterArtifactProjections(filter, sources);
    const rows = projectionSet.projections.filter(isCharacterRelationshipProjection);
    if (rows.length === 0) {
      return [];
    }
    const citationsByArtifact = await this.loadArtifactCitations(
      projectionSet.artifacts.map((row) => row.contextArtifactId),
    );
    const citationsByVersion = await this.loadVersionCitations(rows);
    return rows.map((row) => ({
      fromCharacterId: stringValue(row.data.fromCharacterId) ?? "",
      characterRelationshipId: row.contextArtifactId,
      toCharacterId: stringValue(row.data.toCharacterId) ?? "",
      kind: relationshipKind(row.data.kind),
      direction: relationshipDirection(row.data.direction),
      descriptor: row.body,
      descriptorLocale: stringValue(row.data.descriptorLocale) ?? "",
      status: normalizedCharacterStatus(row.status),
      generatedAt: row.generatedAt,
      citations:
        (row.citationSnapshot === null
          ? citationsByArtifact.get(row.contextArtifactId)
          : citationsByVersion.get(row.citationKey)) ?? [],
    }));
  }

  private async loadTermEntries(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<WikiTermEntry[]> {
    const rows: Array<ScopedRow<typeof terminologyTerms.$inferSelect>> = [];
    const claimedTerms = new Set<string>();
    for (const source of sources) {
      const sourceRows = await this.db
        .select()
        .from(terminologyTerms)
        .where(
          and(
            eq(terminologyTerms.projectId, source.projectId),
            eq(terminologyTerms.localeBranchId, source.localeBranchId),
          ),
        )
        .orderBy(asc(terminologyTerms.normalizedSourceTerm), asc(terminologyTerms.termId));
      for (const row of sourceRows) {
        if (claimedTerms.has(row.normalizedSourceTerm)) {
          continue;
        }
        claimedTerms.add(row.normalizedSourceTerm);
        rows.push({ ...row, wikiSource: source });
      }
    }
    if (rows.length === 0) {
      return [];
    }

    const termIds = rows.map((row) => row.termId);
    const aliasRows = await this.db
      .select()
      .from(terminologyAliases)
      .where(inArray(terminologyAliases.termId, termIds))
      .orderBy(asc(terminologyAliases.termId), asc(terminologyAliases.aliasText));
    const aliasesByTerm = new Map<string, WikiTermAlias[]>();
    for (const row of aliasRows) {
      pushMap(aliasesByTerm, row.termId, {
        aliasId: row.aliasId,
        aliasText: row.aliasText,
        aliasKind: row.aliasKind as TerminologyAliasKind,
        locale: row.locale,
      });
    }

    const referenceRows = await this.db
      .select({
        sourceRefId: terminologySourceReferences.sourceRefId,
        termId: terminologySourceReferences.termId,
        sourceRevisionId: terminologySourceReferences.sourceRevisionId,
        bridgeUnitId: terminologySourceReferences.bridgeUnitId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        referenceKind: terminologySourceReferences.referenceKind,
        citation: terminologySourceReferences.citation,
        context: terminologySourceReferences.context,
      })
      .from(terminologySourceReferences)
      .leftJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, terminologySourceReferences.bridgeUnitId))
      .where(inArray(terminologySourceReferences.termId, termIds))
      .orderBy(asc(terminologySourceReferences.termId), asc(terminologySourceReferences.citation));
    const referencesByTerm = new Map<string, WikiTermReference[]>();
    for (const row of referenceRows) {
      if (
        filter.sourceRevisionId !== undefined &&
        row.sourceRevisionId !== null &&
        row.sourceRevisionId !== filter.sourceRevisionId
      ) {
        continue;
      }
      pushMap(referencesByTerm, row.termId, {
        sourceRefId: row.sourceRefId,
        sourceRevisionId: row.sourceRevisionId,
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        referenceKind: row.referenceKind as TerminologySourceReferenceKind,
        citation: row.citation,
        context: row.context,
      });
    }

    const characterIds = await this.loadCharacterIds(filter, sourcesForCharacterArcs(sources));
    const entries: WikiTermEntry[] = [];
    for (const row of rows) {
      const references = referencesByTerm.get(row.termId) ?? [];
      if (filter.sourceRevisionId !== undefined && references.length === 0) {
        continue;
      }
      const aliases = aliasesByTerm.get(row.termId) ?? [];
      const related = relatedCharactersForTerm(row, aliases, characterIds);
      entries.push({
        entryId: `term:${row.termId}`,
        kind: wikiEntryKindValues.term,
        projectId: row.projectId,
        localeBranchId: row.localeBranchId,
        scope: scopeForSource(filter, row.wikiSource),
        title: row.sourceTerm,
        termId: row.termId,
        sourceTerm: row.sourceTerm,
        preferredTranslation: row.preferredTranslation,
        sourceLocale: row.sourceLocale,
        targetLocale: row.targetLocale,
        termKind: row.termKind as TerminologyTermKind,
        partOfSpeech: row.partOfSpeech,
        status: row.status as TerminologyTermStatus,
        notes: row.notes,
        aliases,
        references,
        related,
      });
    }
    return entries;
  }

  private async loadCharacterIds(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<Set<string>> {
    const projectionSet = await this.loadCharacterArtifactProjections(filter, sources);
    const ids = new Set<string>();
    for (const row of projectionSet.projections) {
      const characterId = characterIdForBio(row.data);
      if (characterId !== undefined) {
        ids.add(characterId);
      }
    }
    return ids;
  }

  private async loadCharacterArtifactProjections(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<CharacterArtifactProjectionSet> {
    const artifacts: ScopedContextArtifactRow[] = [];
    for (const source of sources) {
      const rows = await this.db
        .select()
        .from(contextArtifacts)
        .where(
          and(
            eq(contextArtifacts.projectId, source.projectId),
            eq(contextArtifacts.localeBranchId, source.localeBranchId),
            eq(contextArtifacts.category, contextArtifactCategoryValues.characterNote),
          ),
        )
        .orderBy(asc(contextArtifacts.title), desc(contextArtifacts.updatedAt));
      artifacts.push(...rows.map((row) => ({ ...row, wikiSource: source })));
    }
    const versionsByArtifact = await this.loadArtifactVersions(
      artifacts.map((artifact) => artifact.contextArtifactId),
    );
    return {
      artifacts,
      versionsByArtifact,
      projections: artifacts.flatMap((artifact) =>
        projectionsForArtifact(
          artifact,
          versionsByArtifact.get(artifact.contextArtifactId) ?? [],
          filter,
        ),
      ),
    };
  }

  private async loadArtifactVersions(
    contextArtifactIds: string[],
  ): Promise<Map<string, ContextEntryVersionRow[]>> {
    const byArtifact = new Map<string, ContextEntryVersionRow[]>();
    if (contextArtifactIds.length === 0) {
      return byArtifact;
    }
    const rows = await this.db
      .select()
      .from(contextEntryVersions)
      .where(inArray(contextEntryVersions.contextArtifactId, uniqueStrings(contextArtifactIds)))
      .orderBy(
        asc(contextEntryVersions.contextArtifactId),
        asc(contextEntryVersions.createdAt),
        asc(contextEntryVersions.contextEntryVersionId),
      );
    for (const row of rows) {
      pushMap(byArtifact, row.contextArtifactId, row);
    }
    return byArtifact;
  }

  private async loadArtifactCitations(
    contextArtifactIds: string[],
  ): Promise<Map<string, WikiCitation[]>> {
    const byArtifact = new Map<string, WikiCitation[]>();
    const ids = uniqueStrings(contextArtifactIds);
    if (ids.length === 0) {
      return byArtifact;
    }
    const rows = await this.db
      .select({
        contextArtifactId: contextArtifactSourceUnits.contextArtifactId,
        bridgeUnitId: contextArtifactSourceUnits.bridgeUnitId,
        citedSourceHash: contextArtifactSourceUnits.sourceHash,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(contextArtifactSourceUnits)
      .leftJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, contextArtifactSourceUnits.bridgeUnitId))
      .where(inArray(contextArtifactSourceUnits.contextArtifactId, ids))
      .orderBy(
        asc(contextArtifactSourceUnits.contextArtifactId),
        asc(contextArtifactSourceUnits.bridgeUnitId),
      );
    for (const row of rows) {
      const citeOrdinal = (byArtifact.get(row.contextArtifactId)?.length ?? 0) + 1;
      pushMap(byArtifact, row.contextArtifactId, {
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        occurrenceId: row.occurrenceId,
        citedSourceHash: row.citedSourceHash,
        citeOrdinal,
      });
    }
    return byArtifact;
  }

  private async loadVersionCitations(
    projections: CharacterArtifactProjection[],
  ): Promise<Map<string, WikiCitation[]>> {
    const snapshots = projections.filter(
      (
        projection,
      ): projection is CharacterArtifactProjection & {
        citationSnapshot: ContextEntryVersionCitation[];
      } => projection.citationSnapshot !== null,
    );
    const unitIds = uniqueStrings(
      snapshots.flatMap((projection) =>
        projection.citationSnapshot.map((citation) => citation.bridgeUnitId),
      ),
    );
    const sourceUnitById = new Map<
      string,
      { sourceUnitKey: string; occurrenceId: string | null }
    >();
    if (unitIds.length > 0) {
      const rows = await this.db
        .select({
          bridgeUnitId: sourceUnits.bridgeUnitId,
          sourceUnitKey: sourceUnits.sourceUnitKey,
          occurrenceId: sourceUnits.occurrenceId,
        })
        .from(sourceUnits)
        .where(inArray(sourceUnits.bridgeUnitId, unitIds));
      for (const row of rows) {
        sourceUnitById.set(row.bridgeUnitId, row);
      }
    }
    const result = new Map<string, WikiCitation[]>();
    for (const projection of snapshots) {
      result.set(
        projection.citationKey,
        projection.citationSnapshot.map((citation, index) => {
          const sourceUnit = sourceUnitById.get(citation.bridgeUnitId);
          return {
            bridgeUnitId: citation.bridgeUnitId,
            sourceUnitKey: sourceUnit?.sourceUnitKey ?? null,
            occurrenceId: sourceUnit?.occurrenceId ?? null,
            citedSourceHash: citation.sourceHash,
            citeOrdinal: index + 1,
          };
        }),
      );
    }
    return result;
  }

  private async resolveBrandContextScope(
    projectId: string,
    localeBranchId: string,
  ): Promise<ResolvedWikiBrandContextScope> {
    const local = localSource(projectId, localeBranchId);
    const targetRows = await this.db
      .select({
        brandContextId: wikiBrandContextMemberships.brandContextId,
        contextKey: wikiBrandContexts.contextKey,
        name: wikiBrandContexts.name,
        contextRole: wikiBrandContextMemberships.contextRole,
        inheritsCharacterArcs: wikiBrandContextMemberships.inheritsCharacterArcs,
        inheritsGlossary: wikiBrandContextMemberships.inheritsGlossary,
        inheritsContext: wikiBrandContextMemberships.inheritsContext,
      })
      .from(wikiBrandContextMemberships)
      .innerJoin(
        wikiBrandContexts,
        eq(wikiBrandContexts.brandContextId, wikiBrandContextMemberships.brandContextId),
      )
      .where(
        and(
          eq(wikiBrandContextMemberships.projectId, projectId),
          eq(wikiBrandContextMemberships.localeBranchId, localeBranchId),
        ),
      )
      .orderBy(asc(wikiBrandContexts.name), asc(wikiBrandContextMemberships.contextRole));
    if (targetRows.length === 0) {
      return { sources: [local], contexts: [] };
    }

    const membershipRows = await this.db
      .select({
        brandContextId: wikiBrandContextMemberships.brandContextId,
        contextKey: wikiBrandContexts.contextKey,
        name: wikiBrandContexts.name,
        projectId: wikiBrandContextMemberships.projectId,
        localeBranchId: wikiBrandContextMemberships.localeBranchId,
        contextRole: wikiBrandContextMemberships.contextRole,
        inheritanceOrder: wikiBrandContextMemberships.inheritanceOrder,
        providesCharacterArcs: wikiBrandContextMemberships.providesCharacterArcs,
        providesGlossary: wikiBrandContextMemberships.providesGlossary,
        providesContext: wikiBrandContextMemberships.providesContext,
      })
      .from(wikiBrandContextMemberships)
      .innerJoin(
        wikiBrandContexts,
        eq(wikiBrandContexts.brandContextId, wikiBrandContextMemberships.brandContextId),
      )
      .where(
        inArray(
          wikiBrandContextMemberships.brandContextId,
          targetRows.map((row) => row.brandContextId),
        ),
      )
      .orderBy(
        asc(wikiBrandContextMemberships.inheritanceOrder),
        asc(wikiBrandContexts.name),
        asc(wikiBrandContextMemberships.projectId),
        asc(wikiBrandContextMemberships.localeBranchId),
      );

    const inheritedByKey = new Map<string, ScopedWikiSource>();
    const contexts: WikiBrandContextSummary[] = [];
    for (const target of targetRows) {
      const providers = membershipRows.filter(
        (row) =>
          row.brandContextId === target.brandContextId &&
          !(row.projectId === projectId && row.localeBranchId === localeBranchId),
      );
      const inheritedSources: WikiBrandContextInheritedSource[] = [];
      for (const provider of providers) {
        const inheritedCharacterArcs =
          target.inheritsCharacterArcs && provider.providesCharacterArcs;
        const inheritedGlossary = target.inheritsGlossary && provider.providesGlossary;
        const inheritedContext = target.inheritsContext && provider.providesContext;
        if (!inheritedCharacterArcs && !inheritedGlossary && !inheritedContext) {
          continue;
        }
        const source: ScopedWikiSource = {
          inheritance: "brand_context",
          projectId: provider.projectId,
          localeBranchId: provider.localeBranchId,
          brandContextId: provider.brandContextId,
          brandContextKey: provider.contextKey,
          brandContextName: provider.name,
          brandContextRole: provider.contextRole,
          inheritanceOrder: provider.inheritanceOrder,
          inheritedCharacterArcs,
          inheritedGlossary,
          inheritedContext,
        };
        const key = sourceKey(source);
        if (!inheritedByKey.has(key)) {
          inheritedByKey.set(key, source);
        }
        inheritedSources.push(toInheritedSource(projectId, localeBranchId, source));
      }
      contexts.push({
        brandContextId: target.brandContextId,
        contextKey: target.contextKey,
        name: target.name,
        requestedRole: target.contextRole,
        inheritedSources,
      });
    }

    return { sources: [local, ...inheritedByKey.values()], contexts };
  }

  private async loadInheritedContextArtifacts(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<WikiInheritedContextArtifact[]> {
    const artifacts: WikiInheritedContextArtifact[] = [];
    for (const source of sources) {
      if (source.inheritance === "local") {
        continue;
      }
      const conditions = [
        eq(contextArtifacts.projectId, source.projectId),
        eq(contextArtifacts.localeBranchId, source.localeBranchId),
        eq(contextArtifacts.status, contextArtifactStatusValues.active),
      ];
      if (filter.sourceRevisionId !== undefined) {
        conditions.push(eq(contextArtifacts.sourceRevisionId, filter.sourceRevisionId));
      }
      const rows = await this.db
        .select()
        .from(contextArtifacts)
        .where(and(...conditions))
        .orderBy(asc(contextArtifacts.category), asc(contextArtifacts.title));
      for (const row of rows) {
        if (isCharacterContextData(row.data)) {
          continue;
        }
        artifacts.push({
          contextArtifactId: row.contextArtifactId,
          projectId: row.projectId,
          localeBranchId: row.localeBranchId,
          sourceRevisionId: row.sourceRevisionId,
          category: row.category as ContextArtifactCategory,
          status: row.status as ContextArtifactStatus,
          title: row.title,
          body: row.body,
          source: scopeForSource(filter, source),
        });
      }
    }
    return artifacts;
  }
}

type ScopedWikiSource = {
  inheritance: "local" | "brand_context";
  projectId: string;
  localeBranchId: string;
  brandContextId: string | null;
  brandContextKey: string | null;
  brandContextName: string | null;
  brandContextRole: WikiBrandContextRole | null;
  inheritanceOrder: number;
  inheritedCharacterArcs: boolean;
  inheritedGlossary: boolean;
  inheritedContext: boolean;
};

type ScopedRow<T> = T & { wikiSource: ScopedWikiSource };

type ScopedContextArtifactRow = ScopedRow<typeof contextArtifacts.$inferSelect>;

type ContextEntryVersionRow = typeof contextEntryVersions.$inferSelect;

type CharacterArtifactProjection = {
  contextArtifactId: string;
  contextEntryVersionId: string | null;
  citationKey: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  status: string;
  body: string;
  data: Record<string, unknown>;
  generatedAt: Date;
  wikiSource: ScopedWikiSource;
  /** Null means the current contextArtifactSourceUnits join is authoritative. */
  citationSnapshot: ContextEntryVersionCitation[] | null;
};

type CharacterArtifactProjectionSet = {
  artifacts: ScopedContextArtifactRow[];
  versionsByArtifact: Map<string, ContextEntryVersionRow[]>;
  projections: CharacterArtifactProjection[];
};

type ResolvedWikiBrandContextScope = {
  sources: ScopedWikiSource[];
  contexts: WikiBrandContextSummary[];
};

function localSource(projectId: string, localeBranchId: string): ScopedWikiSource {
  return {
    inheritance: "local",
    projectId,
    localeBranchId,
    brandContextId: null,
    brandContextKey: null,
    brandContextName: null,
    brandContextRole: null,
    inheritanceOrder: 0,
    inheritedCharacterArcs: true,
    inheritedGlossary: true,
    inheritedContext: true,
  };
}

function sourcesForCharacterArcs(sources: ScopedWikiSource[]): ScopedWikiSource[] {
  return sources.filter(
    (source) => source.inheritance === "local" || source.inheritedCharacterArcs,
  );
}

function sourcesForGlossary(sources: ScopedWikiSource[]): ScopedWikiSource[] {
  return sources.filter((source) => source.inheritance === "local" || source.inheritedGlossary);
}

function sourcesForContext(sources: ScopedWikiSource[]): ScopedWikiSource[] {
  return sources.filter((source) => source.inheritance === "local" || source.inheritedContext);
}

function scopeForSource(filter: WikiEntriesFilter, source: ScopedWikiSource): WikiEntryScope {
  return {
    inheritance: source.inheritance,
    requestedProjectId: filter.projectId,
    requestedLocaleBranchId: filter.localeBranchId,
    sourceProjectId: source.projectId,
    sourceLocaleBranchId: source.localeBranchId,
    brandContextId: source.brandContextId,
    brandContextKey: source.brandContextKey,
    brandContextName: source.brandContextName,
    brandContextRole: source.brandContextRole,
  };
}

function toInheritedSource(
  requestedProjectId: string,
  requestedLocaleBranchId: string,
  source: ScopedWikiSource,
): WikiBrandContextInheritedSource {
  return {
    inheritance: source.inheritance,
    requestedProjectId,
    requestedLocaleBranchId,
    sourceProjectId: source.projectId,
    sourceLocaleBranchId: source.localeBranchId,
    brandContextId: source.brandContextId,
    brandContextKey: source.brandContextKey,
    brandContextName: source.brandContextName,
    brandContextRole: source.brandContextRole,
    inheritedCharacterArcs: source.inheritedCharacterArcs,
    inheritedGlossary: source.inheritedGlossary,
    inheritedContext: source.inheritedContext,
  };
}

function sourceKey(source: ScopedWikiSource): string {
  return `${source.projectId}\u0000${source.localeBranchId}`;
}

function projectionsForArtifact(
  artifact: ScopedContextArtifactRow,
  versions: ContextEntryVersionRow[],
  filter: WikiEntriesFilter,
): CharacterArtifactProjection[] {
  if (filter.sourceRevisionId !== undefined && artifact.wikiSource.inheritance === "local") {
    return versions
      .filter((version) => version.sourceRevisionId === filter.sourceRevisionId)
      .map((version) => projectionFromVersion(artifact.wikiSource, version));
  }
  return [projectionFromArtifact(artifact)];
}

function projectionFromArtifact(artifact: ScopedContextArtifactRow): CharacterArtifactProjection {
  return {
    contextArtifactId: artifact.contextArtifactId,
    contextEntryVersionId: artifact.headVersionId,
    citationKey: artifact.contextArtifactId,
    projectId: artifact.projectId,
    localeBranchId: artifact.localeBranchId,
    sourceRevisionId: artifact.sourceRevisionId,
    status: artifact.status,
    body: artifact.body,
    data: artifact.data,
    generatedAt: generatedAt(artifact.data.generatedAt, artifact.updatedAt),
    wikiSource: artifact.wikiSource,
    citationSnapshot: null,
  };
}

function projectionFromVersion(
  wikiSource: ScopedWikiSource,
  version: ContextEntryVersionRow,
): CharacterArtifactProjection {
  return {
    contextArtifactId: version.contextArtifactId,
    contextEntryVersionId: version.contextEntryVersionId,
    citationKey: versionCitationKey(version.contextEntryVersionId),
    projectId: version.projectId,
    localeBranchId: version.localeBranchId,
    sourceRevisionId: version.sourceRevisionId,
    status: version.status,
    body: version.body,
    data: version.data,
    generatedAt: generatedAt(version.data.generatedAt, version.createdAt),
    wikiSource,
    citationSnapshot: version.citations,
  };
}

function isCharacterBioProjection(
  projection: CharacterArtifactProjection,
): projection is CharacterArtifactProjection {
  return isCharacterBioData(projection.data) && characterIdForBio(projection.data) !== undefined;
}

function isCharacterRelationshipProjection(
  projection: CharacterArtifactProjection,
): projection is CharacterArtifactProjection {
  return isCharacterRelationshipData(projection.data);
}

function characterIdForBio(data: Record<string, unknown>): string | undefined {
  return isCharacterBioData(data) ? stringValue(data.characterId) : undefined;
}

/**
 * `semanticKind` is canonical on current writes. The field-level fallback
 * keeps pre-fix central entries (written by the first loop implementation)
 * visible after the retired character tables are dropped.
 */
function isCharacterBioData(data: Record<string, unknown>): boolean {
  const semanticKind = stringValue(data.semanticKind);
  if (semanticKind !== undefined) {
    return semanticKind === "character_bio";
  }
  return (
    stringValue(data.characterId) !== undefined &&
    stringValue(data.fromCharacterId) === undefined &&
    stringValue(data.toCharacterId) === undefined
  );
}

function isCharacterRelationshipData(data: Record<string, unknown>): boolean {
  const semanticKind = stringValue(data.semanticKind);
  if (semanticKind !== undefined && semanticKind !== "character_relationship") {
    return false;
  }
  return (
    stringValue(data.fromCharacterId) !== undefined && stringValue(data.toCharacterId) !== undefined
  );
}

function isCharacterContextData(data: Record<string, unknown>): boolean {
  return isCharacterBioData(data) || isCharacterRelationshipData(data);
}

function selectCurrentCharacterProjection(
  projections: CharacterArtifactProjection[],
): CharacterArtifactProjection | undefined {
  return [...projections].sort((left, right) => {
    const active =
      Number(right.status === contextArtifactStatusValues.active) -
      Number(left.status === contextArtifactStatusValues.active);
    if (active !== 0) {
      return active;
    }
    const generated = right.generatedAt.getTime() - left.generatedAt.getTime();
    if (generated !== 0) {
      return generated;
    }
    return right.citationKey.localeCompare(left.citationKey);
  })[0];
}

function versionsForProjection(
  projection: CharacterArtifactProjection,
  versionsByArtifact: Map<string, ContextEntryVersionRow[]>,
  filter: WikiEntriesFilter,
): ContextEntryVersionRow[] {
  return (versionsByArtifact.get(projection.contextArtifactId) ?? []).filter(
    (version) =>
      isCharacterBioData(version.data) &&
      (filter.sourceRevisionId === undefined ||
        projection.wikiSource.inheritance !== "local" ||
        version.sourceRevisionId === filter.sourceRevisionId),
  );
}

function wikiCharacterRevisions(
  versionRows: ContextEntryVersionRow[],
  fallbackRows: CharacterArtifactProjection[],
): WikiCharacterRevision[] {
  const uniqueVersions = new Map<string, ContextEntryVersionRow>();
  for (const row of versionRows) {
    uniqueVersions.set(row.contextEntryVersionId, row);
  }
  if (uniqueVersions.size === 0) {
    return fallbackRows.map((row) => ({
      characterBioId: row.contextArtifactId,
      contextEntryVersionId: row.contextEntryVersionId,
      sourceRevisionId: row.sourceRevisionId,
      status: normalizedCharacterStatus(row.status),
      generatedAt: row.generatedAt,
    }));
  }
  return [...uniqueVersions.values()]
    .sort((left, right) => {
      const generated =
        generatedAt(right.data.generatedAt, right.createdAt).getTime() -
        generatedAt(left.data.generatedAt, left.createdAt).getTime();
      return generated !== 0
        ? generated
        : right.contextEntryVersionId.localeCompare(left.contextEntryVersionId);
    })
    .map((row) => ({
      characterBioId: row.contextArtifactId,
      contextEntryVersionId: row.contextEntryVersionId,
      sourceRevisionId: row.sourceRevisionId,
      status: normalizedCharacterStatus(row.status),
      generatedAt: generatedAt(row.data.generatedAt, row.createdAt),
    }));
}

function versionCitationKey(contextEntryVersionId: string): string {
  return `version:${contextEntryVersionId}`;
}

function normalizedCharacterStatus(value: string): CharacterBioStatus {
  return value === contextArtifactStatusValues.active ? "Fresh" : "Stale";
}

function relationshipKind(value: unknown): CharacterRelationshipKind {
  switch (value) {
    case "FamilyRelation":
    case "Romantic":
    case "Friendship":
    case "Mentor":
    case "Rivalry":
    case "Allegiance":
    case "Antagonism":
    case "Other":
      return value;
    default:
      return "Other";
  }
}

function relationshipDirection(value: unknown): CharacterRelationshipDirection {
  return value === "FromAToB" ? "FromAToB" : "Symmetric";
}

function generatedAt(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("wiki.entries limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function compareEntries(left: WikiEntry, right: WikiEntry): number {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) {
    return kind;
  }
  const title = left.title.localeCompare(right.title);
  if (title !== 0) {
    return title;
  }
  return left.entryId.localeCompare(right.entryId);
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

function pushUniqueCrossRef(
  map: Map<string, WikiCrossReference[]>,
  key: string,
  ref: WikiCrossReference,
): void {
  const bucket = map.get(key) ?? [];
  if (
    !bucket.some((existing) => existing.refKind === ref.refKind && existing.refId === ref.refId)
  ) {
    bucket.push(ref);
  }
  map.set(key, bucket);
}

function relatedCharactersForTerm(
  row: typeof terminologyTerms.$inferSelect,
  aliases: WikiTermAlias[],
  characterIds: Set<string>,
): WikiCrossReference[] {
  const candidates = new Set([
    row.sourceTerm,
    row.preferredTranslation,
    ...aliases.map((a) => a.aliasText),
  ]);
  const refs: WikiCrossReference[] = [];
  for (const candidate of candidates) {
    if (characterIds.has(candidate)) {
      refs.push({
        refKind: "character",
        refId: candidate,
        label: candidate,
        relation: "terminology_alias",
      });
    }
  }
  return refs;
}

export { terminologyTermStatusValues };
