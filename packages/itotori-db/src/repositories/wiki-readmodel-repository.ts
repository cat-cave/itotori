import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  characterBioEvidence,
  characterBioStatusValues,
  characterBios,
  characterRelationshipEvidence,
  characterRelationshipStatusValues,
  characterRelationships,
  contextArtifactStatusValues,
  contextArtifacts,
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
  CharacterBioStatus,
  CharacterRelationshipDirection,
  CharacterRelationshipKind,
  CharacterRelationshipStatus,
  ContextArtifactCategory,
  ContextArtifactStatus,
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
  characterBioId: string;
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
    characterBioId: string;
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
    const bioRows: Array<ScopedRow<typeof characterBios.$inferSelect>> = [];
    for (const source of sources) {
      const conditions = [
        eq(characterBios.projectId, source.projectId),
        eq(characterBios.localeBranchId, source.localeBranchId),
      ];
      if (filter.sourceRevisionId !== undefined && source.inheritance === "local") {
        conditions.push(eq(characterBios.sourceRevisionId, filter.sourceRevisionId));
      }
      const rows = await this.db
        .select()
        .from(characterBios)
        .where(and(...conditions))
        .orderBy(asc(characterBios.characterId), desc(characterBios.generatedAt));
      bioRows.push(...rows.map((row) => ({ ...row, wikiSource: source })));
    }
    if (bioRows.length === 0) {
      return [];
    }

    const bioIds = bioRows.map((row) => row.characterBioId);
    const citationRows = await this.db
      .select({
        characterBioId: characterBioEvidence.characterBioId,
        bridgeUnitId: characterBioEvidence.bridgeUnitId,
        citedSourceHash: characterBioEvidence.citedSourceHash,
        citeOrdinal: characterBioEvidence.citeOrdinal,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(characterBioEvidence)
      .leftJoin(sourceUnits, eq(sourceUnits.bridgeUnitId, characterBioEvidence.bridgeUnitId))
      .where(inArray(characterBioEvidence.characterBioId, bioIds))
      .orderBy(asc(characterBioEvidence.characterBioId), asc(characterBioEvidence.citeOrdinal));
    const citationsByBio = new Map<string, WikiCitation[]>();
    for (const row of citationRows) {
      pushMap(citationsByBio, row.characterBioId, {
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        occurrenceId: row.occurrenceId,
        citedSourceHash: row.citedSourceHash,
        citeOrdinal: row.citeOrdinal,
      });
    }

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

    const byCharacter = new Map<string, Array<ScopedRow<typeof characterBios.$inferSelect>>>();
    for (const row of bioRows) {
      const existing = byCharacter.get(row.characterId);
      if (existing !== undefined && existing[0]?.wikiSource !== row.wikiSource) {
        continue;
      }
      pushMap(byCharacter, row.characterId, row);
    }

    const entries: WikiCharacterEntry[] = [];
    for (const [characterId, revisions] of byCharacter.entries()) {
      const current =
        revisions.find((row) => row.status === characterBioStatusValues.fresh) ?? revisions[0];
      if (current === undefined) {
        continue;
      }
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
          characterBioId: current.characterBioId,
          locale: current.bioLocale,
          text: current.bioText,
          status: current.status as CharacterBioStatus,
          stale: current.status !== characterBioStatusValues.fresh,
          generatedAt: current.generatedAt,
        },
        appearances: citationsByBio.get(current.characterBioId) ?? [],
        related: relatedByCharacter.get(characterId) ?? [],
        relationships: relationshipsByCharacter.get(characterId) ?? [],
        revisions: revisions.map((row) => ({
          characterBioId: row.characterBioId,
          sourceRevisionId: row.sourceRevisionId,
          status: row.status as CharacterBioStatus,
          generatedAt: row.generatedAt,
        })),
      });
    }
    return entries;
  }

  private async loadRelationships(
    filter: WikiEntriesFilter,
    sources: ScopedWikiSource[],
  ): Promise<Array<WikiCharacterRelationship & { fromCharacterId: string }>> {
    const rows: Array<typeof characterRelationships.$inferSelect> = [];
    for (const source of sources) {
      const conditions = [
        eq(characterRelationships.projectId, source.projectId),
        eq(characterRelationships.localeBranchId, source.localeBranchId),
      ];
      if (filter.sourceRevisionId !== undefined && source.inheritance === "local") {
        conditions.push(eq(characterRelationships.sourceRevisionId, filter.sourceRevisionId));
      }
      rows.push(
        ...(await this.db
          .select()
          .from(characterRelationships)
          .where(and(...conditions))
          .orderBy(
            asc(characterRelationships.fromCharacterId),
            asc(characterRelationships.toCharacterId),
          )),
      );
    }
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.characterRelationshipId);
    const citationRows = await this.db
      .select({
        characterRelationshipId: characterRelationshipEvidence.characterRelationshipId,
        bridgeUnitId: characterRelationshipEvidence.bridgeUnitId,
        citedSourceHash: characterRelationshipEvidence.citedSourceHash,
        citeOrdinal: characterRelationshipEvidence.citeOrdinal,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(characterRelationshipEvidence)
      .leftJoin(
        sourceUnits,
        eq(sourceUnits.bridgeUnitId, characterRelationshipEvidence.bridgeUnitId),
      )
      .where(inArray(characterRelationshipEvidence.characterRelationshipId, ids))
      .orderBy(
        asc(characterRelationshipEvidence.characterRelationshipId),
        asc(characterRelationshipEvidence.citeOrdinal),
      );
    const citationsByRelationship = new Map<string, WikiCitation[]>();
    for (const row of citationRows) {
      pushMap(citationsByRelationship, row.characterRelationshipId, {
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        occurrenceId: row.occurrenceId,
        citedSourceHash: row.citedSourceHash,
        citeOrdinal: row.citeOrdinal,
      });
    }
    return rows.map((row) => ({
      fromCharacterId: row.fromCharacterId,
      characterRelationshipId: row.characterRelationshipId,
      toCharacterId: row.toCharacterId,
      kind: row.kind,
      direction: row.direction,
      descriptor: row.descriptor,
      descriptorLocale: row.descriptorLocale,
      status: row.status as CharacterRelationshipStatus,
      generatedAt: row.generatedAt,
      citations: citationsByRelationship.get(row.characterRelationshipId) ?? [],
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
    const ids = new Set<string>();
    for (const source of sources) {
      const conditions = [
        eq(characterBios.projectId, source.projectId),
        eq(characterBios.localeBranchId, source.localeBranchId),
      ];
      if (filter.sourceRevisionId !== undefined && source.inheritance === "local") {
        conditions.push(eq(characterBios.sourceRevisionId, filter.sourceRevisionId));
      }
      const rows = await this.db
        .select({ characterId: characterBios.characterId })
        .from(characterBios)
        .where(and(...conditions));
      for (const row of rows) {
        ids.add(row.characterId);
      }
    }
    return ids;
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

export { terminologyTermStatusValues, characterRelationshipStatusValues };
