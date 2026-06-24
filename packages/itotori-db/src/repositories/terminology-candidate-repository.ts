import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  sourceUnits,
  terminologyAliases,
  terminologyCandidateEvidence,
  terminologyCandidateInvalidatedReasonValues,
  terminologyCandidateKindValues,
  terminologyCandidateStatusValues,
  terminologyCandidates,
  terminologyTerms,
  type TerminologyCandidateInvalidatedReason,
  type TerminologyCandidateKind,
  type TerminologyCandidateStatus,
} from "../schema.js";

export const terminologyCandidateKindList: ReadonlyArray<TerminologyCandidateKind> = [
  terminologyCandidateKindValues.properNoun,
  terminologyCandidateKindValues.titleOrHonorific,
  terminologyCandidateKindValues.technicalTerm,
  terminologyCandidateKindValues.catchphrase,
  terminologyCandidateKindValues.soundEffect,
  terminologyCandidateKindValues.writtenSign,
  terminologyCandidateKindValues.other,
];

export type TerminologyCandidateCitationRecord = {
  bridgeUnitId: string;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type TerminologyCandidateRecord = {
  terminologyCandidateId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  kind: TerminologyCandidateKind;
  surfaceForm: string;
  surfaceLocale: string;
  rationale: string;
  readingHint: string | null;
  conflictingTerminologyTermId: string | null;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  status: TerminologyCandidateStatus;
  invalidatedAt: Date | null;
  invalidatedReason: TerminologyCandidateInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: TerminologyCandidateCitationRecord[];
};

export type SaveTerminologyCandidateInput = Omit<
  TerminologyCandidateRecord,
  "status" | "invalidatedAt" | "invalidatedReason" | "createdAt" | "conflictingTerminologyTermId"
> & {
  /** Optional override; the repo will populate from the
   *  pre-persist cross-check if absent. */
  conflictingTerminologyTermId?: string | null;
};

export type LoadTerminologyCandidatesQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  surfaceForm?: string;
  status?: TerminologyCandidateStatus;
  promptTemplateVersion?: string;
};

export type MarkTerminologyCandidateStaleInput = {
  terminologyCandidateId: string;
  reason: TerminologyCandidateInvalidatedReason;
  invalidatedAt?: Date;
};

export type MarkTerminologyCandidatePromotedInput = {
  terminologyCandidateId: string;
  terminologyTermId: string;
};

export type LoadCurrentSourceHashesInput = {
  bridgeUnitIds: string[];
};

export type ExistsTerminologyTermBySurfaceFormInput = {
  projectId: string;
  surfaceForm: string;
};

export interface ItotoriTerminologyCandidateRepositoryPort {
  saveCandidate(
    actor: AuthorizationActor,
    input: SaveTerminologyCandidateInput,
  ): Promise<TerminologyCandidateRecord>;
  loadCandidatesByProject(
    actor: AuthorizationActor,
    query: LoadTerminologyCandidatesQuery,
  ): Promise<TerminologyCandidateRecord[]>;
  markCandidateStale(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidateStaleInput,
  ): Promise<void>;
  markCandidatePromoted(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidatePromotedInput,
  ): Promise<void>;
  markCandidateRejected(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidateStaleInput,
  ): Promise<void>;
  currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>>;
  existsTerminologyTermBySurfaceForm(
    actor: AuthorizationActor,
    input: ExistsTerminologyTermBySurfaceFormInput,
  ): Promise<string | null>;
}

export class ItotoriTerminologyCandidateRepository implements ItotoriTerminologyCandidateRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveCandidate(
    actor: AuthorizationActor,
    input: SaveTerminologyCandidateInput,
  ): Promise<TerminologyCandidateRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(
        `terminology candidate ${input.terminologyCandidateId} must cite at least one bridge unit`,
      );
    }
    assertOrdinalsUnique(input.citations, `terminology candidate ${input.terminologyCandidateId}`);

    let resolvedConflictId: string | null = input.conflictingTerminologyTermId ?? null;

    await this.db.transaction(async (tx) => {
      // Pre-persist cross-check: if a glossary term already exists for the
      // same project + surface form (or via an alias), persist the
      // candidate as RejectedByReviewer with the conflict reference.
      if (resolvedConflictId === null) {
        const matches = await tx
          .select({ termId: terminologyTerms.termId })
          .from(terminologyTerms)
          .where(
            and(
              eq(terminologyTerms.projectId, input.projectId),
              eq(terminologyTerms.sourceTerm, input.surfaceForm),
            ),
          )
          .limit(1);
        const directMatch = matches[0];
        if (directMatch) {
          resolvedConflictId = directMatch.termId;
        } else {
          const aliasMatches = await tx
            .select({ termId: terminologyAliases.termId })
            .from(terminologyAliases)
            .innerJoin(terminologyTerms, eq(terminologyAliases.termId, terminologyTerms.termId))
            .where(
              and(
                eq(terminologyTerms.projectId, input.projectId),
                eq(terminologyAliases.aliasText, input.surfaceForm),
              ),
            )
            .limit(1);
          const aliasMatch = aliasMatches[0];
          if (aliasMatch) {
            resolvedConflictId = aliasMatch.termId;
          }
        }
      }

      const persistedStatus: TerminologyCandidateStatus =
        resolvedConflictId !== null
          ? terminologyCandidateStatusValues.rejectedByReviewer
          : terminologyCandidateStatusValues.fresh;
      const persistedReason: TerminologyCandidateInvalidatedReason | null =
        resolvedConflictId !== null
          ? terminologyCandidateInvalidatedReasonValues.glossaryConflictPostPersist
          : null;
      const persistedInvalidatedAt: Date | null = resolvedConflictId !== null ? new Date() : null;

      const existing = await tx
        .select({ id: terminologyCandidates.terminologyCandidateId })
        .from(terminologyCandidates)
        .where(
          and(
            eq(terminologyCandidates.projectId, input.projectId),
            eq(terminologyCandidates.localeBranchId, input.localeBranchId),
            eq(terminologyCandidates.sourceRevisionId, input.sourceRevisionId),
            eq(terminologyCandidates.surfaceForm, input.surfaceForm),
            eq(terminologyCandidates.kind, input.kind),
            eq(terminologyCandidates.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.id);
        await tx
          .delete(terminologyCandidateEvidence)
          .where(inArray(terminologyCandidateEvidence.terminologyCandidateId, ids));
        await tx
          .delete(terminologyCandidates)
          .where(inArray(terminologyCandidates.terminologyCandidateId, ids));
      }

      await tx.insert(terminologyCandidates).values({
        terminologyCandidateId: input.terminologyCandidateId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        kind: input.kind,
        surfaceForm: input.surfaceForm,
        surfaceLocale: input.surfaceLocale,
        rationale: input.rationale,
        readingHint: input.readingHint,
        conflictingTerminologyTermId: resolvedConflictId,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        inputTokenEstimate: input.inputTokenEstimate,
        completionTokens: input.completionTokens,
        status: persistedStatus,
        invalidatedAt: persistedInvalidatedAt,
        invalidatedReason: persistedReason,
        generatedAt: input.generatedAt,
      });

      await tx.insert(terminologyCandidateEvidence).values(
        input.citations.map((citation) => ({
          terminologyCandidateId: input.terminologyCandidateId,
          bridgeUnitId: citation.bridgeUnitId,
          citedSourceHash: citation.citedSourceHash,
          citeOrdinal: citation.citeOrdinal,
        })),
      );
    });

    const saved = await this.fetchById(input.terminologyCandidateId);
    if (!saved) {
      throw new Error(`failed to load saved terminology candidate ${input.terminologyCandidateId}`);
    }
    return saved;
  }

  async loadCandidatesByProject(
    actor: AuthorizationActor,
    query: LoadTerminologyCandidatesQuery,
  ): Promise<TerminologyCandidateRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(terminologyCandidates.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(terminologyCandidates.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(terminologyCandidates.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.surfaceForm !== undefined) {
      conditions.push(eq(terminologyCandidates.surfaceForm, query.surfaceForm));
    }
    if (query.status !== undefined) {
      conditions.push(eq(terminologyCandidates.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(terminologyCandidates.promptTemplateVersion, query.promptTemplateVersion));
    }

    const rows = await this.db
      .select()
      .from(terminologyCandidates)
      .where(and(...conditions))
      .orderBy(
        asc(terminologyCandidates.projectId),
        asc(terminologyCandidates.localeBranchId),
        asc(terminologyCandidates.sourceRevisionId),
        asc(terminologyCandidates.surfaceForm),
        desc(terminologyCandidates.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.terminologyCandidateId);
    const evidenceRows = await this.db
      .select()
      .from(terminologyCandidateEvidence)
      .where(inArray(terminologyCandidateEvidence.terminologyCandidateId, ids))
      .orderBy(
        asc(terminologyCandidateEvidence.terminologyCandidateId),
        asc(terminologyCandidateEvidence.citeOrdinal),
      );
    const evidenceByCandidate = new Map<string, TerminologyCandidateCitationRecord[]>();
    for (const evidence of evidenceRows) {
      const bucket = evidenceByCandidate.get(evidence.terminologyCandidateId) ?? [];
      bucket.push({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      });
      evidenceByCandidate.set(evidence.terminologyCandidateId, bucket);
    }
    return rows.map((row) =>
      candidateRowToRecord(row, evidenceByCandidate.get(row.terminologyCandidateId) ?? []),
    );
  }

  async markCandidateStale(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidateStaleInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(terminologyCandidates)
      .set({
        status: terminologyCandidateStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(terminologyCandidates.terminologyCandidateId, input.terminologyCandidateId),
          eq(terminologyCandidates.status, terminologyCandidateStatusValues.fresh),
        ),
      );
  }

  async markCandidateRejected(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidateStaleInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(terminologyCandidates)
      .set({
        status: terminologyCandidateStatusValues.rejectedByReviewer,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(eq(terminologyCandidates.terminologyCandidateId, input.terminologyCandidateId));
  }

  async markCandidatePromoted(
    actor: AuthorizationActor,
    input: MarkTerminologyCandidatePromotedInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    await this.db
      .update(terminologyCandidates)
      .set({
        status: terminologyCandidateStatusValues.promoted,
        conflictingTerminologyTermId: input.terminologyTermId,
      })
      .where(eq(terminologyCandidates.terminologyCandidateId, input.terminologyCandidateId));
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

  async existsTerminologyTermBySurfaceForm(
    actor: AuthorizationActor,
    input: ExistsTerminologyTermBySurfaceFormInput,
  ): Promise<string | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const direct = await this.db
      .select({ termId: terminologyTerms.termId })
      .from(terminologyTerms)
      .where(
        and(
          eq(terminologyTerms.projectId, input.projectId),
          eq(terminologyTerms.sourceTerm, input.surfaceForm),
        ),
      )
      .limit(1);
    if (direct[0]) {
      return direct[0].termId;
    }
    const alias = await this.db
      .select({ termId: terminologyAliases.termId })
      .from(terminologyAliases)
      .innerJoin(terminologyTerms, eq(terminologyAliases.termId, terminologyTerms.termId))
      .where(
        and(
          eq(terminologyTerms.projectId, input.projectId),
          eq(terminologyAliases.aliasText, input.surfaceForm),
        ),
      )
      .limit(1);
    if (alias[0]) {
      return alias[0].termId;
    }
    return null;
  }

  private async fetchById(
    terminologyCandidateId: string,
  ): Promise<TerminologyCandidateRecord | null> {
    const rows = await this.db
      .select()
      .from(terminologyCandidates)
      .where(eq(terminologyCandidates.terminologyCandidateId, terminologyCandidateId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const evidenceRows = await this.db
      .select()
      .from(terminologyCandidateEvidence)
      .where(eq(terminologyCandidateEvidence.terminologyCandidateId, terminologyCandidateId))
      .orderBy(asc(terminologyCandidateEvidence.citeOrdinal));
    return candidateRowToRecord(
      row,
      evidenceRows.map((evidence) => ({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      })),
    );
  }
}

function assertOrdinalsUnique(
  citations: TerminologyCandidateCitationRecord[],
  label: string,
): void {
  const seen = new Set<number>();
  for (const citation of citations) {
    if (seen.has(citation.citeOrdinal)) {
      throw new Error(`${label} has duplicate cite ordinal ${citation.citeOrdinal}`);
    }
    seen.add(citation.citeOrdinal);
  }
}

function candidateRowToRecord(
  row: typeof terminologyCandidates.$inferSelect,
  citations: TerminologyCandidateCitationRecord[],
): TerminologyCandidateRecord {
  return {
    terminologyCandidateId: row.terminologyCandidateId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    kind: row.kind,
    surfaceForm: row.surfaceForm,
    surfaceLocale: row.surfaceLocale,
    rationale: row.rationale,
    readingHint: row.readingHint,
    conflictingTerminologyTermId: row.conflictingTerminologyTermId,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    inputTokenEstimate: row.inputTokenEstimate,
    completionTokens: row.completionTokens,
    status: row.status as TerminologyCandidateStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as TerminologyCandidateInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

/**
 * Helper exposed for the agent CLI: counts how many terminology terms
 * exist for a given project. Useful for `--dry-run` summaries.
 */
export async function countTerminologyTerms(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  projectId: string,
): Promise<number> {
  await requirePermission(db, actor, permissionValues.catalogRead);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(terminologyTerms)
    .where(eq(terminologyTerms.projectId, projectId));
  return rows[0]?.count ?? 0;
}

export {
  terminologyCandidateInvalidatedReasonValues,
  terminologyCandidateKindValues,
  terminologyCandidateStatusValues,
};
