import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { permissionValues, requirePermission, type AuthorizationActor } from "../authorization.js";
import { resolveBranchPolicyGlossaryReferenceInTx } from "./branch-reference-repository.js";
import {
  localeBranches,
  terminologyAliasKindValues,
  terminologyAliases,
  terminologyConflictStatusValues,
  terminologyConflicts,
  terminologySemanticIndex,
  terminologySourceReferenceKindValues,
  terminologySourceReferences,
  terminologyTermKindValues,
  terminologyTerms,
  terminologyTermStatusValues,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import {
  approvedStyleGuideVersionId,
  getLocaleBranchContext,
  lockTerminologySourceTerm,
  protectedSpanReferencesForSourceReferences,
  termProvenanceFromReference,
  validateSourceReferenceContext,
  validateSourceRevisionContext,
} from "./terminology-repository-context.js";
import { reconcilePreferredTranslationConflict } from "./terminology-repository-conflicts.js";
import { upsertSemanticIndex } from "./terminology-repository-index.js";
import {
  aliasFromRow,
  conflictFromRow,
  isSearchableLexicalIndexStatus,
  semanticFromRow,
  termFromRow,
} from "./terminology-repository-mappers.js";
import { getTermById, hydrateTerms } from "./terminology-repository-reads.js";
import type {
  GlossaryContextInput,
  GlossaryContextReadModel,
  ItotoriTerminologyRepositoryPort,
  TerminologyConflictFilter,
  TerminologyConflictRecord,
  TerminologySearchInput,
  TerminologySearchMatchKind,
  TerminologySearchReadModel,
  UpsertTerminologyTermInput,
  UpsertTerminologyTermResult,
} from "./terminology-repository-types.js";
import {
  enumValue,
  groupBy,
  jsonRecord,
  normalizeTerm,
  optionalNonEmpty,
  requiredString,
  tokenize,
  tokenOverlap,
} from "./terminology-repository-utils.js";

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
            preferredTranslation: requiredString(
              input.preferredTranslation,
              "preferredTranslation",
            ),
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
        const bridgeUnitId = optionalNonEmpty(
          reference.bridgeUnitId,
          "sourceReference.bridgeUnitId",
        );
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
            this.db
              .select()
              .from(terminologyAliases)
              .where(inArray(terminologyAliases.termId, termIds)),
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

    const hydrated = await hydrateTerms(
      this.db,
      matches.map((match) => match.term.termId),
    );
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

  async getGlossaryContext(
    actor: AuthorizationActor,
    input: GlossaryContextInput,
  ): Promise<GlossaryContextReadModel | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const term = await getTermById(this.db, requiredString(input.termId, "termId"));
    if (term === null) {
      return null;
    }
    const localeBranchId = requiredString(input.localeBranchId, "localeBranchId");
    const sourceRevisionId = requiredString(input.sourceRevisionId, "sourceRevisionId");
    if (term.localeBranchId !== localeBranchId) {
      return null;
    }

    const context = await getLocaleBranchContext(this.db, term.projectId, localeBranchId);
    if (context === null) {
      return null;
    }
    await validateSourceRevisionContext(this.db, context, sourceRevisionId);

    const styleGuideVersionId = await approvedStyleGuideVersionId(this.db, localeBranchId);
    const branchReference = await resolveBranchPolicyGlossaryReferenceInTx(this.db, {
      projectId: term.projectId,
      localeBranchId,
    });
    const sourceReferences = term.sourceReferences.filter(
      (reference) =>
        reference.sourceRevisionId === null || reference.sourceRevisionId === sourceRevisionId,
    );
    const protectedSpanReferences = await protectedSpanReferencesForSourceReferences(
      this.db,
      sourceReferences,
    );

    return {
      localeBranchId,
      sourceRevisionId,
      styleGuideVersionId: branchReference?.styleGuideVersionId ?? styleGuideVersionId,
      glossaryReferenceId: branchReference?.referenceId ?? null,
      branchReference,
      term,
      termProvenance: sourceReferences.map(termProvenanceFromReference),
      protectedSpanReferences,
    };
  }
}
