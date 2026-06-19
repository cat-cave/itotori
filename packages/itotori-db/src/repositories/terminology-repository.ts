import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  assets,
  catalogSourceProvenance,
  findings,
  localeBranchUnits,
  localeBranches,
  projects,
  sourceBundles,
  sourceRevisions,
  sourceUnits,
  terminologyAliasKindValues,
  terminologyAliases,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflicts,
  terminologyConflictStatusValues,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologySourceReferences,
  terminologyTermKindValues,
  terminologyTerms,
  terminologyTermStatusValues,
  type TerminologyAliasKind,
  type TerminologyConflictKind,
  type TerminologyConflictStatus,
  type TerminologySemanticIndexStatus,
  type TerminologySourceReferenceKind,
  type TerminologyTermKind,
  type TerminologyTermStatus,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

export type TerminologyJsonRecord = Record<string, unknown>;

export type TerminologyAliasInput = {
  aliasId?: string;
  aliasText: string;
  aliasKind: TerminologyAliasKind;
  locale?: string;
  metadata?: TerminologyJsonRecord;
};

export type TerminologySourceReferenceInput = {
  sourceRefId?: string;
  sourceRevisionId?: string;
  bridgeUnitId?: string;
  sourceProvenanceId?: string;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context?: string;
  metadata?: TerminologyJsonRecord;
};

export type TerminologySemanticIndexInput = {
  semanticIndexId?: string;
  searchDocument?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingVector?: number[] | null;
  status?: TerminologySemanticIndexStatus;
  metadata?: TerminologyJsonRecord;
};

export type UpsertTerminologyTermInput = {
  termId?: string;
  projectId: string;
  localeBranchId: string;
  sourceTerm: string;
  preferredTranslation: string;
  termKind?: TerminologyTermKind;
  partOfSpeech?: string;
  caseSensitive?: boolean;
  notes?: string;
  metadata?: TerminologyJsonRecord;
  aliases?: TerminologyAliasInput[];
  sourceReferences?: TerminologySourceReferenceInput[];
  semanticIndex?: TerminologySemanticIndexInput;
  conflictPolicy?: "record" | "reject";
};

export type TerminologySearchInput = {
  projectId?: string;
  localeBranchId: string;
  query: string;
  limit?: number;
  includeDeprecated?: boolean;
};

export type TerminologyConflictFilter = {
  projectId?: string;
  localeBranchId?: string;
  status?: TerminologyConflictStatus;
};

export type TerminologyTermRecord = {
  termId: string;
  projectId: string;
  localeBranchId: string;
  sourceTerm: string;
  normalizedSourceTerm: string;
  sourceLocale: string;
  targetLocale: string;
  preferredTranslation: string;
  normalizedPreferredTranslation: string;
  termKind: TerminologyTermKind;
  partOfSpeech: string | null;
  status: TerminologyTermStatus;
  caseSensitive: boolean;
  notes: string | null;
  metadata: TerminologyJsonRecord;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  aliases: TerminologyAliasRecord[];
  sourceReferences: TerminologySourceReferenceRecord[];
  semanticIndex: TerminologySemanticIndexRecord | null;
};

export type TerminologyAliasRecord = {
  aliasId: string;
  termId: string;
  aliasText: string;
  normalizedAliasText: string;
  aliasKind: TerminologyAliasKind;
  locale: string | null;
  metadata: TerminologyJsonRecord;
  createdAt: Date;
};

export type TerminologySourceReferenceRecord = {
  sourceRefId: string;
  termId: string;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceProvenanceId: string | null;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context: string | null;
  metadata: TerminologyJsonRecord;
  createdAt: Date;
};

export type TerminologySemanticIndexRecord = {
  semanticIndexId: string;
  termId: string;
  searchDocument: string;
  searchTokens: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVector: number[] | null;
  contentHash: string;
  status: TerminologySemanticIndexStatus;
  metadata: TerminologyJsonRecord;
  refreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TerminologyConflictRecord = {
  conflictId: string;
  projectId: string;
  localeBranchId: string;
  normalizedSourceTerm: string;
  conflictKind: TerminologyConflictKind;
  status: TerminologyConflictStatus;
  summary: string;
  findingId: string | null;
  metadata: TerminologyJsonRecord;
  detectedAt: Date;
  updatedAt: Date;
};

export type TerminologySearchMatchKind =
  | "exact_source"
  | "exact_translation"
  | "alias"
  | "lexical_hook";

export type TerminologySearchResult = {
  term: TerminologyTermRecord;
  matchKinds: TerminologySearchMatchKind[];
  score: number;
};

export type TerminologySearchReadModel = {
  query: string;
  normalizedQuery: string;
  localeBranchId: string;
  results: TerminologySearchResult[];
};

export type UpsertTerminologyTermResult = {
  term: TerminologyTermRecord;
  conflict: TerminologyConflictRecord | null;
};

export class TerminologySourceReferenceError extends Error {
  constructor(
    readonly code:
      | "terminology.source_reference.source_revision_mismatch"
      | "terminology.source_reference.bridge_unit_mismatch"
      | "terminology.source_reference.source_provenance_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TerminologySourceReferenceError";
  }
}

export interface ItotoriTerminologyRepositoryPort {
  upsertTerm(
    actor: AuthorizationActor,
    input: UpsertTerminologyTermInput,
  ): Promise<UpsertTerminologyTermResult>;
  searchTerms(
    actor: AuthorizationActor,
    input: TerminologySearchInput,
  ): Promise<TerminologySearchReadModel>;
  listConflicts(
    actor: AuthorizationActor,
    filter?: TerminologyConflictFilter,
  ): Promise<TerminologyConflictRecord[]>;
}

export class ItotoriTerminologyRepository implements ItotoriTerminologyRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async upsertTerm(
    actor: AuthorizationActor,
    input: UpsertTerminologyTermInput,
  ): Promise<UpsertTerminologyTermResult> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    return this.db.transaction(async (tx) => {
      const context = await getLocaleBranchContext(tx, input.projectId, input.localeBranchId);
      if (context === null) {
        throw new Error(
          `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
        );
      }

      const normalizedSourceTerm = normalizeTerm(input.sourceTerm, "sourceTerm");
      const normalizedPreferredTranslation = normalizeTerm(
        input.preferredTranslation,
        "preferredTranslation",
      );
      const termKind = enumValue(
        input.termKind ?? terminologyTermKindValues.general,
        Object.values(terminologyTermKindValues),
        "termKind",
      );

      await lockTerminologySourceTerm(tx, input.localeBranchId, normalizedSourceTerm);

      const conflictingTerms = await tx
        .select()
        .from(terminologyTerms)
        .where(
          and(
            eq(terminologyTerms.localeBranchId, input.localeBranchId),
            eq(terminologyTerms.normalizedSourceTerm, normalizedSourceTerm),
            ne(terminologyTerms.normalizedPreferredTranslation, normalizedPreferredTranslation),
          ),
        )
        .orderBy(asc(terminologyTerms.createdAt));
      if (conflictingTerms.length > 0 && input.conflictPolicy === "reject") {
        throw new Error(
          `terminology preferred translation conflict for ${input.sourceTerm}: ${conflictingTerms
            .map((term) => term.preferredTranslation)
            .join(", ")}`,
        );
      }

      const termId = input.termId ?? createUuid7();
      const rows = await tx
        .insert(terminologyTerms)
        .values({
          termId,
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceTerm: requiredString(input.sourceTerm, "sourceTerm"),
          normalizedSourceTerm,
          sourceLocale: context.sourceLocale,
          targetLocale: context.targetLocale,
          preferredTranslation: requiredString(input.preferredTranslation, "preferredTranslation"),
          normalizedPreferredTranslation,
          termKind,
          partOfSpeech: optionalNonEmpty(input.partOfSpeech, "partOfSpeech"),
          status:
            conflictingTerms.length > 0
              ? terminologyTermStatusValues.conflicted
              : terminologyTermStatusValues.active,
          caseSensitive: input.caseSensitive ?? false,
          notes: optionalNonEmpty(input.notes, "notes"),
          metadata: jsonRecord(input.metadata ?? {}, "metadata"),
          createdByUserId: actor.userId,
        })
        .onConflictDoUpdate({
          target: [
            terminologyTerms.localeBranchId,
            terminologyTerms.normalizedSourceTerm,
            terminologyTerms.normalizedPreferredTranslation,
          ],
          set: {
            sourceTerm: requiredString(input.sourceTerm, "sourceTerm"),
            preferredTranslation: requiredString(input.preferredTranslation, "preferredTranslation"),
            termKind,
            partOfSpeech: optionalNonEmpty(input.partOfSpeech, "partOfSpeech"),
            caseSensitive: input.caseSensitive ?? false,
            notes: optionalNonEmpty(input.notes, "notes"),
            metadata: jsonRecord(input.metadata ?? {}, "metadata"),
            updatedAt: sql`now()`,
          },
        })
        .returning();
      const persistedTerm = rows[0];
      if (persistedTerm === undefined) {
        throw new Error("terminology term was not persisted");
      }

      for (const alias of input.aliases ?? []) {
        const aliasKind = enumValue(
          alias.aliasKind,
          Object.values(terminologyAliasKindValues),
          "alias.aliasKind",
        );
        await tx
          .insert(terminologyAliases)
          .values({
            aliasId: alias.aliasId ?? createUuid7(),
            termId: persistedTerm.termId,
            aliasText: requiredString(alias.aliasText, "alias.aliasText"),
            normalizedAliasText: normalizeTerm(alias.aliasText, "alias.aliasText"),
            aliasKind,
            locale: optionalNonEmpty(alias.locale, "alias.locale"),
            metadata: jsonRecord(alias.metadata ?? {}, "alias.metadata"),
          })
          .onConflictDoUpdate({
            target: [
              terminologyAliases.termId,
              terminologyAliases.aliasKind,
              terminologyAliases.normalizedAliasText,
            ],
            set: {
              aliasText: requiredString(alias.aliasText, "alias.aliasText"),
              locale: optionalNonEmpty(alias.locale, "alias.locale"),
              metadata: jsonRecord(alias.metadata ?? {}, "alias.metadata"),
            },
          });
      }

      for (const reference of input.sourceReferences ?? []) {
        const referenceKind = enumValue(
          reference.referenceKind,
          Object.values(terminologySourceReferenceKindValues),
          "sourceReference.referenceKind",
        );
        const sourceRevisionId = optionalNonEmpty(
          reference.sourceRevisionId,
          "sourceReference.sourceRevisionId",
        );
        const bridgeUnitId = optionalNonEmpty(reference.bridgeUnitId, "sourceReference.bridgeUnitId");
        const sourceProvenanceId = optionalNonEmpty(
          reference.sourceProvenanceId,
          "sourceReference.sourceProvenanceId",
        );
        await validateSourceReferenceContext(tx, context, {
          sourceRevisionId,
          bridgeUnitId,
          sourceProvenanceId,
        });
        await tx.insert(terminologySourceReferences).values({
          sourceRefId: reference.sourceRefId ?? createUuid7(),
          termId: persistedTerm.termId,
          sourceRevisionId,
          bridgeUnitId,
          sourceProvenanceId,
          referenceKind,
          citation: requiredString(reference.citation, "sourceReference.citation"),
          context: optionalNonEmpty(reference.context, "sourceReference.context"),
          metadata: jsonRecord(reference.metadata ?? {}, "sourceReference.metadata"),
        });
      }

      await upsertSemanticIndex(tx, persistedTerm.termId, input.semanticIndex);

      const conflict = await reconcilePreferredTranslationConflict(tx, {
        actor,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        normalizedSourceTerm,
        sourceTerm: persistedTerm.sourceTerm,
      });

      const term = await getTermById(tx, persistedTerm.termId);
      if (term === null) {
        throw new Error(`terminology term ${persistedTerm.termId} was not readable after write`);
      }
      return { term, conflict };
    });
  }

  async searchTerms(
    actor: AuthorizationActor,
    input: TerminologySearchInput,
  ): Promise<TerminologySearchReadModel> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const normalizedQuery = normalizeTerm(input.query, "query");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 through 100");
    }

    if (input.projectId !== undefined) {
      const branch = await this.db
        .select({ projectId: localeBranches.projectId })
        .from(localeBranches)
        .where(eq(localeBranches.localeBranchId, input.localeBranchId))
        .limit(1);
      if (branch[0]?.projectId !== input.projectId) {
        throw new Error(
          `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
        );
      }
    }

    const allRows = await this.db
      .select()
      .from(terminologyTerms)
      .where(
        input.includeDeprecated
          ? eq(terminologyTerms.localeBranchId, input.localeBranchId)
          : and(
              eq(terminologyTerms.localeBranchId, input.localeBranchId),
              ne(terminologyTerms.status, terminologyTermStatusValues.deprecated),
            ),
      )
      .orderBy(asc(terminologyTerms.sourceTerm));
    const termIds = allRows.map((row) => row.termId);
    const [aliases, semanticRows] =
      termIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.db.select().from(terminologyAliases).where(inArray(terminologyAliases.termId, termIds)),
            this.db
              .select()
              .from(terminologySemanticIndex)
              .where(inArray(terminologySemanticIndex.termId, termIds)),
          ]);
    const aliasesByTerm = groupBy(aliases.map(aliasFromRow), (alias) => alias.termId);
    const semanticByTerm = new Map(semanticRows.map((row) => [row.termId, semanticFromRow(row)]));
    const queryTokens = tokenize(normalizedQuery);

    const matches = allRows
      .map((row) => {
        const term = termFromRow(
          row,
          aliasesByTerm.get(row.termId) ?? [],
          [],
          semanticByTerm.get(row.termId) ?? null,
        );
        const matchKinds = new Set<TerminologySearchMatchKind>();
        let score = 0;
        if (row.normalizedSourceTerm === normalizedQuery) {
          matchKinds.add("exact_source");
          score += 100;
        }
        if (row.normalizedPreferredTranslation === normalizedQuery) {
          matchKinds.add("exact_translation");
          score += 90;
        }
        for (const alias of term.aliases) {
          if (alias.normalizedAliasText === normalizedQuery) {
            matchKinds.add("alias");
            score += 80;
          }
        }
        const semantic = term.semanticIndex;
        if (semantic !== null && isSearchableLexicalIndexStatus(semantic.status)) {
          const overlap = tokenOverlap(queryTokens, semantic.searchTokens);
          if (overlap > 0) {
            matchKinds.add("lexical_hook");
            score += overlap;
          }
        }
        return { term, matchKinds: [...matchKinds], score };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.term.sourceTerm.localeCompare(right.term.sourceTerm);
      })
      .slice(0, limit);

    const hydrated = await hydrateTerms(this.db, matches.map((match) => match.term.termId));
    const hydratedById = new Map(hydrated.map((term) => [term.termId, term]));
    return {
      query: input.query,
      normalizedQuery,
      localeBranchId: input.localeBranchId,
      results: matches.map((match) => ({
        ...match,
        term: hydratedById.get(match.term.termId) ?? match.term,
      })),
    };
  }

  async listConflicts(
    actor: AuthorizationActor,
    filter: TerminologyConflictFilter = {},
  ): Promise<TerminologyConflictRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const conditions = [];
    if (filter.projectId !== undefined) {
      conditions.push(eq(terminologyConflicts.projectId, filter.projectId));
    }
    if (filter.localeBranchId !== undefined) {
      conditions.push(eq(terminologyConflicts.localeBranchId, filter.localeBranchId));
    }
    if (filter.status !== undefined) {
      conditions.push(eq(terminologyConflicts.status, filter.status));
    }

    const rows = await this.db
      .select()
      .from(terminologyConflicts)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(terminologyConflicts.detectedAt));
    return rows.map(conflictFromRow);
  }
}

type LocaleBranchTerminologyContext = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  sourceBundleId: string;
  sourceRevisionId: string;
};

async function getLocaleBranchContext(
  db: ItotoriDatabase,
  projectId: string,
  localeBranchId: string,
): Promise<LocaleBranchTerminologyContext | null> {
  const rows = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
      sourceLocale: projects.sourceLocale,
      targetLocale: localeBranches.targetLocale,
      sourceBundleId: localeBranches.sourceBundleId,
      sourceRevisionId: sourceRevisions.sourceRevisionId,
    })
    .from(localeBranches)
    .innerJoin(projects, eq(projects.projectId, localeBranches.projectId))
    .innerJoin(sourceBundles, eq(sourceBundles.sourceBundleId, localeBranches.sourceBundleId))
    .innerJoin(
      sourceRevisions,
      eq(sourceRevisions.sourceRevisionId, sourceBundles.sourceBundleRevisionId),
    )
    .where(and(eq(localeBranches.projectId, projectId), eq(localeBranches.localeBranchId, localeBranchId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row;
}

async function lockTerminologySourceTerm(
  db: ItotoriDatabase,
  localeBranchId: string,
  normalizedSourceTerm: string,
): Promise<void> {
  const lockKey = `terminology:${createHash("sha256")
    .update(localeBranchId)
    .update("\0")
    .update(normalizedSourceTerm)
    .digest("hex")}`;
  await db.execute(sql`
    select pg_advisory_xact_lock(hashtext(${lockKey}))
  `);
}

async function validateSourceReferenceContext(
  db: ItotoriDatabase,
  context: LocaleBranchTerminologyContext,
  reference: {
    sourceRevisionId: string | null;
    bridgeUnitId: string | null;
    sourceProvenanceId: string | null;
  },
): Promise<void> {
  if (reference.sourceRevisionId !== null) {
    const rows = await db.execute<{ exists: boolean }>(sql`
      select exists(
        select 1 from ${sourceRevisions}
        where ${sourceRevisions.sourceRevisionId} = ${reference.sourceRevisionId}
          and ${sourceRevisions.projectId} = ${context.projectId}
          and (
            ${sourceRevisions.sourceRevisionId} = ${context.sourceRevisionId}
            or exists (
              select 1 from ${assets}
              where ${assets.sourceBundleId} = ${context.sourceBundleId}
                and ${assets.sourceRevisionId} = ${sourceRevisions.sourceRevisionId}
            )
            or exists (
              select 1 from ${sourceUnits}
              where ${sourceUnits.sourceBundleId} = ${context.sourceBundleId}
                and ${sourceUnits.sourceRevisionId} = ${sourceRevisions.sourceRevisionId}
            )
          )
      ) as exists
    `);
    if (rows.rows[0]?.exists !== true) {
      throw new TerminologySourceReferenceError(
        "terminology.source_reference.source_revision_mismatch",
        `source revision ${reference.sourceRevisionId} is not part of locale branch ${context.localeBranchId}`,
      );
    }
  }

  if (reference.bridgeUnitId !== null) {
    const rows = await db.execute<{ exists: boolean }>(sql`
      select exists(
        select 1 from ${sourceUnits}
        inner join ${localeBranchUnits}
          on ${localeBranchUnits.bridgeUnitId} = ${sourceUnits.bridgeUnitId}
        where ${sourceUnits.bridgeUnitId} = ${reference.bridgeUnitId}
          and ${sourceUnits.projectId} = ${context.projectId}
          and ${sourceUnits.sourceBundleId} = ${context.sourceBundleId}
          and ${localeBranchUnits.localeBranchId} = ${context.localeBranchId}
      ) as exists
    `);
    if (rows.rows[0]?.exists !== true) {
      throw new TerminologySourceReferenceError(
        "terminology.source_reference.bridge_unit_mismatch",
        `bridge unit ${reference.bridgeUnitId} is not part of locale branch ${context.localeBranchId}`,
      );
    }
  }

  if (reference.sourceProvenanceId !== null) {
    const rows = await db
      .select({ metadata: catalogSourceProvenance.metadata })
      .from(catalogSourceProvenance)
      .where(eq(catalogSourceProvenance.sourceProvenanceId, reference.sourceProvenanceId))
      .limit(1);
    const metadata = rows[0]?.metadata;
    const projectId = metadata === undefined ? null : metadataString(metadata, "projectId");
    const localeBranchId = metadata === undefined ? null : metadataString(metadata, "localeBranchId");
    const sourceBundleId = metadata === undefined ? null : metadataString(metadata, "sourceBundleId");
    const sourceRevisionId =
      metadata === undefined ? null : metadataString(metadata, "sourceRevisionId");
    const branchMatches = localeBranchId === null || localeBranchId === context.localeBranchId;
    const sourceMatches =
      sourceBundleId === context.sourceBundleId || sourceRevisionId === context.sourceRevisionId;

    if (projectId !== context.projectId || !branchMatches || !sourceMatches) {
      throw new TerminologySourceReferenceError(
        "terminology.source_reference.source_provenance_mismatch",
        `source provenance ${reference.sourceProvenanceId} is not scoped to locale branch ${context.localeBranchId}`,
      );
    }
  }
}

async function upsertSemanticIndex(
  db: ItotoriDatabase,
  termId: string,
  input: TerminologySemanticIndexInput | undefined,
): Promise<void> {
  const baseTerm = await getTermBaseById(db, termId);
  if (baseTerm === null) {
    throw new Error(`terminology term ${termId} does not exist`);
  }
  const existingAliases = await db
    .select()
    .from(terminologyAliases)
    .where(eq(terminologyAliases.termId, termId));
  const existingReferences = await db
    .select()
    .from(terminologySourceReferences)
    .where(eq(terminologySourceReferences.termId, termId));
  const searchDocument =
    input?.searchDocument ??
    [
      baseTerm.sourceTerm,
      baseTerm.preferredTranslation,
      ...existingAliases.map((alias) => alias.aliasText),
      ...existingReferences.flatMap((reference) => [reference.citation, reference.context ?? ""]),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  const searchTokens = tokenize(searchDocument);
  const contentHash = `sha256:${createHash("sha256").update(searchDocument).digest("hex")}`;
  const semanticIndex = normalizeSemanticIndexInput(input);
  await db
    .insert(terminologySemanticIndex)
    .values({
      semanticIndexId: input?.semanticIndexId ?? createUuid7(),
      termId,
      searchDocument,
      searchTokens,
      embeddingProvider: semanticIndex.embeddingProvider,
      embeddingModel: semanticIndex.embeddingModel,
      embeddingDimension: semanticIndex.embeddingDimension,
      embeddingVector: semanticIndex.embeddingVector,
      contentHash,
      status: semanticIndex.status,
      metadata: semanticIndex.metadata,
      refreshedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: terminologySemanticIndex.termId,
      set: {
        searchDocument,
        searchTokens,
        embeddingProvider: semanticIndex.embeddingProvider,
        embeddingModel: semanticIndex.embeddingModel,
        embeddingDimension: semanticIndex.embeddingDimension,
        embeddingVector: semanticIndex.embeddingVector,
        contentHash,
        status: semanticIndex.status,
        metadata: semanticIndex.metadata,
        refreshedAt: new Date(),
        updatedAt: sql`now()`,
      },
    });
}

type NormalizedTerminologySemanticIndexInput = {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVector: number[] | null;
  status: TerminologySemanticIndexStatus;
  metadata: TerminologyJsonRecord;
};

const lexicalEmbeddingProvider = "itotori-lexical";
const lexicalEmbeddingModel = "terminology-lexical-token-index-v1";

function normalizeSemanticIndexInput(
  input: TerminologySemanticIndexInput | undefined,
): NormalizedTerminologySemanticIndexInput {
  const embeddingProvider =
    input?.embeddingProvider === undefined
      ? lexicalEmbeddingProvider
      : requiredString(input.embeddingProvider, "semanticIndex.embeddingProvider");
  const embeddingModel =
    input?.embeddingModel === undefined
      ? lexicalEmbeddingModel
      : requiredString(input.embeddingModel, "semanticIndex.embeddingModel");
  const embeddingDimension = input?.embeddingDimension ?? 0;
  if (
    !Number.isInteger(embeddingDimension) ||
    embeddingDimension < 0 ||
    !Number.isSafeInteger(embeddingDimension)
  ) {
    throw new Error("semanticIndex.embeddingDimension must be a non-negative safe integer");
  }

  const embeddingVector = input?.embeddingVector ?? null;
  if (embeddingVector !== null) {
    if (!Array.isArray(embeddingVector) || !embeddingVector.every((value) => Number.isFinite(value))) {
      throw new Error("semanticIndex.embeddingVector must be an array of finite numbers");
    }
    if (embeddingVector.length !== embeddingDimension) {
      throw new Error("semanticIndex.embeddingDimension must match embeddingVector length");
    }
  }

  const status =
    input?.status === undefined
      ? terminologySemanticIndexStatusValues.indexedLexical
      : enumValue(
          input.status,
          Object.values(terminologySemanticIndexStatusValues),
          "semanticIndex.status",
        );
  const vectorReady = embeddingVector !== null && embeddingDimension > 0;
  const semanticReady =
    status === terminologySemanticIndexStatusValues.ready &&
    vectorReady &&
    embeddingProvider !== lexicalEmbeddingProvider &&
    embeddingModel !== lexicalEmbeddingModel;

  if (status === terminologySemanticIndexStatusValues.ready && !semanticReady) {
    throw new Error(
      "semanticIndex.status ready requires a non-lexical provider/model and a non-empty matching embedding vector",
    );
  }

  return {
    embeddingProvider,
    embeddingModel,
    embeddingDimension,
    embeddingVector,
    status,
    metadata: {
      ...jsonRecord(input?.metadata ?? {}, "semanticIndex.metadata"),
      hookKind: "lexical_token_index",
      indexKind: semanticReady ? "semantic_vector_index" : "lexical_token_index",
      semanticReady,
      vectorReady,
    },
  };
}

async function reconcilePreferredTranslationConflict(
  db: ItotoriDatabase,
  input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
    normalizedSourceTerm: string;
    sourceTerm: string;
  },
): Promise<TerminologyConflictRecord | null> {
  const translations = await db
    .selectDistinct({
      normalizedPreferredTranslation: terminologyTerms.normalizedPreferredTranslation,
    })
    .from(terminologyTerms)
    .where(
      and(
        eq(terminologyTerms.localeBranchId, input.localeBranchId),
        eq(terminologyTerms.normalizedSourceTerm, input.normalizedSourceTerm),
      ),
    );
  if (translations.length <= 1) {
    return null;
  }

  await db
    .update(terminologyTerms)
    .set({ status: terminologyTermStatusValues.conflicted, updatedAt: sql`now()` })
    .where(
      and(
        eq(terminologyTerms.localeBranchId, input.localeBranchId),
        eq(terminologyTerms.normalizedSourceTerm, input.normalizedSourceTerm),
      ),
    );
  return recordPreferredTranslationConflict(db, input);
}

async function recordPreferredTranslationConflict(
  db: ItotoriDatabase,
  input: {
    actor: AuthorizationActor;
    projectId: string;
    localeBranchId: string;
    normalizedSourceTerm: string;
    sourceTerm: string;
  },
): Promise<TerminologyConflictRecord> {
  const existing = await db
    .select()
    .from(terminologyConflicts)
    .where(
      and(
        eq(terminologyConflicts.localeBranchId, input.localeBranchId),
        eq(terminologyConflicts.normalizedSourceTerm, input.normalizedSourceTerm),
        eq(terminologyConflicts.conflictKind, terminologyConflictKindValues.preferredTranslation),
        eq(terminologyConflicts.status, terminologyConflictStatusValues.open),
      ),
    )
    .limit(1);
  const terms = await db
    .select()
    .from(terminologyTerms)
    .where(
      and(
        eq(terminologyTerms.localeBranchId, input.localeBranchId),
        eq(terminologyTerms.normalizedSourceTerm, input.normalizedSourceTerm),
      ),
    )
    .orderBy(asc(terminologyTerms.createdAt));
  const translations = [...new Set(terms.map((term) => term.preferredTranslation))];
  const summary = `Terminology term "${input.sourceTerm}" has conflicting preferred translations: ${translations.join(", ")}`;
  const existingConflict = existing[0];

  if (existingConflict !== undefined) {
    await db
      .update(terminologyConflicts)
      .set({
        summary,
        metadata: conflictMetadata(translations, terms.map((term) => term.termId)),
        updatedAt: sql`now()`,
      })
      .where(eq(terminologyConflicts.conflictId, existingConflict.conflictId));
    await appendMissingConflictEvidence(db, existingConflict.conflictId, terms.map((term) => term.termId));
    const conflict = await getConflictById(db, existingConflict.conflictId);
    if (conflict === null) {
      throw new Error(`terminology conflict ${existingConflict.conflictId} disappeared`);
    }
    return conflict;
  }

  const findingId = createUuid7();
  await db.insert(findings).values({
    findingId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    findingKind: "terminology_conflict",
    severity: "medium",
    qualityCategory: "terminology",
    title: "Glossary preferred translation conflict",
    description: summary,
    impact: "Translation and QA batches need a reviewer decision before this glossary term is trusted.",
    status: "open",
    createdAt: new Date(),
    affectedRefs: terms.map((term) => ({
      refKind: "terminology_term",
      termId: term.termId,
      sourceTerm: term.sourceTerm,
      preferredTranslation: term.preferredTranslation,
    })),
    evidence: [
      {
        provenanceKind: "terminology_conflict",
        normalizedSourceTerm: input.normalizedSourceTerm,
        translations,
      },
    ],
    provenance: [
      {
        actorUserId: input.actor.userId,
        repository: "ItotoriTerminologyRepository",
      },
    ],
    causalLinks: [],
  });

  const conflictId = createUuid7();
  await db.insert(terminologyConflicts).values({
    conflictId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    normalizedSourceTerm: input.normalizedSourceTerm,
    conflictKind: terminologyConflictKindValues.preferredTranslation,
    status: terminologyConflictStatusValues.open,
    summary,
    findingId,
    metadata: conflictMetadata(translations, terms.map((term) => term.termId)),
  });
  await appendMissingConflictEvidence(db, conflictId, terms.map((term) => term.termId));
  const conflict = await getConflictById(db, conflictId);
  if (conflict === null) {
    throw new Error(`terminology conflict ${conflictId} was not persisted`);
  }
  return conflict;
}

async function appendMissingConflictEvidence(
  db: ItotoriDatabase,
  conflictId: string,
  termIds: string[],
): Promise<void> {
  const existingRows = await db
    .select({ termId: terminologyConflictEvidence.termId })
    .from(terminologyConflictEvidence)
    .where(eq(terminologyConflictEvidence.conflictId, conflictId));
  const existing = new Set(existingRows.map((row) => row.termId).filter((termId) => termId !== null));
  let position = existing.size;
  for (const termId of termIds) {
    if (existing.has(termId)) {
      continue;
    }
    await db.insert(terminologyConflictEvidence).values({
      conflictEvidenceId: createUuid7(),
      conflictId,
      termId,
      evidencePosition: position,
      metadata: { subjectKind: "terminology_term" },
    });
    position += 1;
  }
}

async function getConflictById(
  db: ItotoriDatabase,
  conflictId: string,
): Promise<TerminologyConflictRecord | null> {
  const rows = await db
    .select()
    .from(terminologyConflicts)
    .where(eq(terminologyConflicts.conflictId, conflictId))
    .limit(1);
  return rows[0] === undefined ? null : conflictFromRow(rows[0]);
}

async function getTermById(
  db: ItotoriDatabase,
  termId: string,
): Promise<TerminologyTermRecord | null> {
  const rows = await hydrateTerms(db, [termId]);
  return rows[0] ?? null;
}

async function hydrateTerms(
  db: ItotoriDatabase,
  termIds: string[],
): Promise<TerminologyTermRecord[]> {
  if (termIds.length === 0) {
    return [];
  }
  const [terms, aliases, references, semanticRows] = await Promise.all([
    db.select().from(terminologyTerms).where(inArray(terminologyTerms.termId, termIds)),
    db.select().from(terminologyAliases).where(inArray(terminologyAliases.termId, termIds)),
    db
      .select()
      .from(terminologySourceReferences)
      .where(inArray(terminologySourceReferences.termId, termIds)),
    db
      .select()
      .from(terminologySemanticIndex)
      .where(inArray(terminologySemanticIndex.termId, termIds)),
  ]);
  const aliasesByTerm = groupBy(aliases.map(aliasFromRow), (alias) => alias.termId);
  const referencesByTerm = groupBy(references.map(sourceReferenceFromRow), (reference) => reference.termId);
  const semanticByTerm = new Map(semanticRows.map((row) => [row.termId, semanticFromRow(row)]));
  const order = new Map(termIds.map((termId, index) => [termId, index]));
  return terms
    .map((term) =>
      termFromRow(
        term,
        aliasesByTerm.get(term.termId) ?? [],
        referencesByTerm.get(term.termId) ?? [],
        semanticByTerm.get(term.termId) ?? null,
      ),
    )
    .sort((left, right) => (order.get(left.termId) ?? 0) - (order.get(right.termId) ?? 0));
}

async function getTermBaseById(
  db: ItotoriDatabase,
  termId: string,
): Promise<typeof terminologyTerms.$inferSelect | null> {
  const rows = await db
    .select()
    .from(terminologyTerms)
    .where(eq(terminologyTerms.termId, termId))
    .limit(1);
  return rows[0] ?? null;
}

function conflictMetadata(translations: string[], termIds: string[]): TerminologyJsonRecord {
  return {
    reasonCode: "preferred_translation_conflict",
    translations,
    termIds,
  };
}

function isSearchableLexicalIndexStatus(status: TerminologySemanticIndexStatus): boolean {
  return (
    status === terminologySemanticIndexStatusValues.indexedLexical ||
    status === terminologySemanticIndexStatusValues.ready
  );
}

function termFromRow(
  row: typeof terminologyTerms.$inferSelect,
  aliases: TerminologyAliasRecord[],
  sourceReferences: TerminologySourceReferenceRecord[],
  semanticIndex: TerminologySemanticIndexRecord | null,
): TerminologyTermRecord {
  return {
    termId: row.termId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceTerm: row.sourceTerm,
    normalizedSourceTerm: row.normalizedSourceTerm,
    sourceLocale: row.sourceLocale,
    targetLocale: row.targetLocale,
    preferredTranslation: row.preferredTranslation,
    normalizedPreferredTranslation: row.normalizedPreferredTranslation,
    termKind: row.termKind as TerminologyTermKind,
    partOfSpeech: row.partOfSpeech,
    status: row.status as TerminologyTermStatus,
    caseSensitive: row.caseSensitive,
    notes: row.notes,
    metadata: row.metadata,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    aliases,
    sourceReferences,
    semanticIndex,
  };
}

function aliasFromRow(row: typeof terminologyAliases.$inferSelect): TerminologyAliasRecord {
  return {
    aliasId: row.aliasId,
    termId: row.termId,
    aliasText: row.aliasText,
    normalizedAliasText: row.normalizedAliasText,
    aliasKind: row.aliasKind as TerminologyAliasKind,
    locale: row.locale,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function sourceReferenceFromRow(
  row: typeof terminologySourceReferences.$inferSelect,
): TerminologySourceReferenceRecord {
  return {
    sourceRefId: row.sourceRefId,
    termId: row.termId,
    sourceRevisionId: row.sourceRevisionId,
    bridgeUnitId: row.bridgeUnitId,
    sourceProvenanceId: row.sourceProvenanceId,
    referenceKind: row.referenceKind as TerminologySourceReferenceKind,
    citation: row.citation,
    context: row.context,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function semanticFromRow(row: typeof terminologySemanticIndex.$inferSelect): TerminologySemanticIndexRecord {
  return {
    semanticIndexId: row.semanticIndexId,
    termId: row.termId,
    searchDocument: row.searchDocument,
    searchTokens: row.searchTokens,
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    embeddingDimension: row.embeddingDimension,
    embeddingVector: row.embeddingVector,
    contentHash: row.contentHash,
    status: row.status as TerminologySemanticIndexStatus,
    metadata: row.metadata,
    refreshedAt: row.refreshedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function conflictFromRow(row: typeof terminologyConflicts.$inferSelect): TerminologyConflictRecord {
  return {
    conflictId: row.conflictId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    normalizedSourceTerm: row.normalizedSourceTerm,
    conflictKind: row.conflictKind as TerminologyConflictKind,
    status: row.status as TerminologyConflictStatus,
    summary: row.summary,
    findingId: row.findingId,
    metadata: row.metadata,
    detectedAt: row.detectedAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeTerm(value: string, label: string): string {
  return requiredString(value, label).normalize("NFKC").trim().toLocaleLowerCase();
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  ];
}

function tokenOverlap(queryTokens: string[], documentTokens: string[]): number {
  if (queryTokens.length === 0 || documentTokens.length === 0) {
    return 0;
  }
  const document = new Set(documentTokens);
  return queryTokens.filter((token) => document.has(token)).length * 10;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = key(value);
    const existing = grouped.get(group) ?? [];
    existing.push(value);
    grouped.set(group, existing);
  }
  return grouped;
}

function enumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function requiredString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmpty(value: string | undefined, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty when provided`);
  }
  return value.trim();
}

function jsonRecord(value: TerminologyJsonRecord, label: string): TerminologyJsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function metadataString(metadata: TerminologyJsonRecord, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
