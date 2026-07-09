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
  localeBranches,
  projects,
  sourceUnits,
  terminologyAliases,
  terminologySourceReferences,
  terminologyTermStatusValues,
  terminologyTerms,
} from "../schema.js";
import type {
  CharacterBioStatus,
  CharacterRelationshipDirection,
  CharacterRelationshipKind,
  CharacterRelationshipStatus,
  TerminologyAliasKind,
  TerminologySourceReferenceKind,
  TerminologyTermKind,
  TerminologyTermStatus,
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

    const characters =
      filter.kind === wikiEntryKindValues.term ? [] : await this.loadCharacterEntries(filter);
    const terms =
      filter.kind === wikiEntryKindValues.character ? [] : await this.loadTermEntries(filter);
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

  private async loadCharacterEntries(filter: WikiEntriesFilter): Promise<WikiCharacterEntry[]> {
    const conditions = [
      eq(characterBios.projectId, filter.projectId),
      eq(characterBios.localeBranchId, filter.localeBranchId),
    ];
    if (filter.sourceRevisionId !== undefined) {
      conditions.push(eq(characterBios.sourceRevisionId, filter.sourceRevisionId));
    }
    const bioRows = await this.db
      .select()
      .from(characterBios)
      .where(and(...conditions))
      .orderBy(asc(characterBios.characterId), desc(characterBios.generatedAt));
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

    const relationshipRows = await this.loadRelationships(filter);
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

    const byCharacter = new Map<string, typeof bioRows>();
    for (const row of bioRows) {
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
  ): Promise<Array<WikiCharacterRelationship & { fromCharacterId: string }>> {
    const conditions = [
      eq(characterRelationships.projectId, filter.projectId),
      eq(characterRelationships.localeBranchId, filter.localeBranchId),
    ];
    if (filter.sourceRevisionId !== undefined) {
      conditions.push(eq(characterRelationships.sourceRevisionId, filter.sourceRevisionId));
    }
    const rows = await this.db
      .select()
      .from(characterRelationships)
      .where(and(...conditions))
      .orderBy(
        asc(characterRelationships.fromCharacterId),
        asc(characterRelationships.toCharacterId),
      );
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

  private async loadTermEntries(filter: WikiEntriesFilter): Promise<WikiTermEntry[]> {
    const conditions = [
      eq(terminologyTerms.projectId, filter.projectId),
      eq(terminologyTerms.localeBranchId, filter.localeBranchId),
    ];
    const rows = await this.db
      .select()
      .from(terminologyTerms)
      .where(and(...conditions))
      .orderBy(asc(terminologyTerms.normalizedSourceTerm), asc(terminologyTerms.termId));
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

    const characterIds = await this.loadCharacterIds(filter);
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

  private async loadCharacterIds(filter: WikiEntriesFilter): Promise<Set<string>> {
    const conditions = [
      eq(characterBios.projectId, filter.projectId),
      eq(characterBios.localeBranchId, filter.localeBranchId),
    ];
    if (filter.sourceRevisionId !== undefined) {
      conditions.push(eq(characterBios.sourceRevisionId, filter.sourceRevisionId));
    }
    const rows = await this.db
      .select({ characterId: characterBios.characterId })
      .from(characterBios)
      .where(and(...conditions));
    return new Set(rows.map((row) => row.characterId));
  }
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
