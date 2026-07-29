import { eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  terminologyAliases,
  terminologySemanticIndex,
  terminologySourceReferences,
  terminologyTerms,
} from "../schema.js";
import {
  aliasFromRow,
  semanticFromRow,
  sourceReferenceFromRow,
  termFromRow,
} from "./terminology-repository-mappers.js";
import type { TerminologyTermRecord } from "./terminology-repository-types.js";
import { groupBy } from "./terminology-repository-utils.js";

export async function getTermById(
  db: ItotoriDatabase,
  termId: string,
): Promise<TerminologyTermRecord | null> {
  const rows = await hydrateTerms(db, [termId]);
  return rows[0] ?? null;
}

export async function hydrateTerms(
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
  const referencesByTerm = groupBy(
    references.map(sourceReferenceFromRow),
    (reference) => reference.termId,
  );
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

export async function getTermBaseById(
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
