import { and, asc, eq, sql } from "drizzle-orm";
import type { AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  findings,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflicts,
  terminologyConflictStatusValues,
  terminologyTerms,
  terminologyTermStatusValues,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import { conflictFromRow } from "./terminology-repository-mappers.js";
import type {
  TerminologyConflictRecord,
  TerminologyJsonRecord,
} from "./terminology-repository-types.js";

export async function reconcilePreferredTranslationConflict(
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
        metadata: conflictMetadata(
          translations,
          terms.map((term) => term.termId),
        ),
        updatedAt: sql`now()`,
      })
      .where(eq(terminologyConflicts.conflictId, existingConflict.conflictId));
    await appendMissingConflictEvidence(
      db,
      existingConflict.conflictId,
      terms.map((term) => term.termId),
    );
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
    impact:
      "Translation and QA batches need a canonical terminology correction before this glossary term is trusted.",
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
    metadata: conflictMetadata(
      translations,
      terms.map((term) => term.termId),
    ),
  });
  await appendMissingConflictEvidence(
    db,
    conflictId,
    terms.map((term) => term.termId),
  );
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
  const existing = new Set(
    existingRows.map((row) => row.termId).filter((termId) => termId !== null),
  );
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
function conflictMetadata(translations: string[], termIds: string[]): TerminologyJsonRecord {
  return {
    reasonCode: "preferred_translation_conflict",
    translations,
    termIds,
  };
}
