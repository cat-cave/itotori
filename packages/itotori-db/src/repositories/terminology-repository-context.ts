import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import {
  assets,
  catalogSourceProvenance,
  localeBranchUnits,
  localeBranches,
  projects,
  sourceBundles,
  sourceRevisions,
  sourceUnits,
  styleGuides,
} from "../schema.js";
import {
  TerminologySourceReferenceError,
  type GlossaryProtectedSpanReference,
  type GlossaryTermProvenance,
  type TerminologySourceReferenceRecord,
} from "./terminology-repository-types.js";
import {
  metadataString,
  nonNullable,
  numberValue,
  spanRecord,
  stringValue,
} from "./terminology-repository-utils.js";

type LocaleBranchTerminologyContext = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  sourceBundleId: string;
  sourceRevisionId: string;
};

export async function getLocaleBranchContext(
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
    .where(
      and(
        eq(localeBranches.projectId, projectId),
        eq(localeBranches.localeBranchId, localeBranchId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : row;
}

export async function lockTerminologySourceTerm(
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

export async function validateSourceReferenceContext(
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
    const localeBranchId =
      metadata === undefined ? null : metadataString(metadata, "localeBranchId");
    const sourceBundleId =
      metadata === undefined ? null : metadataString(metadata, "sourceBundleId");
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

export async function validateSourceRevisionContext(
  db: ItotoriDatabase,
  context: LocaleBranchTerminologyContext,
  sourceRevisionId: string,
): Promise<void> {
  const exists = await sourceRevisionExistsInProject(db, context.projectId, sourceRevisionId);
  if (!exists) {
    throw new TerminologySourceReferenceError(
      "terminology.source_reference.source_revision_mismatch",
      `source revision ${sourceRevisionId} does not exist for project ${context.projectId}`,
    );
  }
}

async function sourceRevisionExistsInProject(
  db: ItotoriDatabase,
  projectId: string,
  sourceRevisionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ sourceRevisionId: sourceRevisions.sourceRevisionId })
    .from(sourceRevisions)
    .where(
      and(
        eq(sourceRevisions.projectId, projectId),
        eq(sourceRevisions.sourceRevisionId, sourceRevisionId),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

export async function approvedStyleGuideVersionId(
  db: ItotoriDatabase,
  localeBranchId: string,
): Promise<string | null> {
  const rows = await db
    .select({ approvedVersionId: styleGuides.approvedVersionId })
    .from(styleGuides)
    .where(eq(styleGuides.localeBranchId, localeBranchId))
    .limit(1);
  return rows[0]?.approvedVersionId ?? null;
}

export async function protectedSpanReferencesForSourceReferences(
  db: ItotoriDatabase,
  references: TerminologySourceReferenceRecord[],
): Promise<GlossaryProtectedSpanReference[]> {
  const bridgeUnitIds = [
    ...new Set(references.map((reference) => reference.bridgeUnitId).filter(nonNullable)),
  ];
  if (bridgeUnitIds.length === 0) {
    return [];
  }
  const refsByBridgeUnitId = new Map(
    references
      .filter((reference) => reference.bridgeUnitId !== null)
      .map((reference) => [reference.bridgeUnitId as string, reference]),
  );
  const rows = await db
    .select()
    .from(sourceUnits)
    .where(inArray(sourceUnits.bridgeUnitId, bridgeUnitIds));
  return rows.flatMap((row) =>
    protectedSpanReferencesFromSourceUnit(row, refsByBridgeUnitId.get(row.bridgeUnitId) ?? null),
  );
}

function protectedSpanReferencesFromSourceUnit(
  row: typeof sourceUnits.$inferSelect,
  reference: TerminologySourceReferenceRecord | null,
): GlossaryProtectedSpanReference[] {
  return row.spans.flatMap((span, index) => {
    const record = spanRecord(span);
    if (record === null) {
      return [];
    }
    const spanId = stringValue(record.spanId) ?? `${row.bridgeUnitId}:span:${index}`;
    return [
      {
        protectedSpanRefId: `${row.bridgeUnitId}:${spanId}`,
        sourceRefId: sourceRefIdFromReference(reference),
        bridgeUnitId: row.bridgeUnitId,
        sourceRevisionId: row.sourceRevisionId,
        sourceUnitKey: row.sourceUnitKey,
        spanId,
        spanKind: stringValue(record.spanKind) ?? "protected_span",
        raw: stringValue(record.raw) ?? "",
        startByte: numberValue(record.startByte),
        endByte: numberValue(record.endByte),
        preserveMode: stringValue(record.preserveMode),
      },
    ];
  });
}

export function termProvenanceFromReference(
  reference: TerminologySourceReferenceRecord,
): GlossaryTermProvenance {
  return {
    sourceRefId: reference.sourceRefId,
    sourceRevisionId: reference.sourceRevisionId,
    bridgeUnitId: reference.bridgeUnitId,
    sourceProvenanceId: reference.sourceProvenanceId,
    referenceKind: reference.referenceKind,
    citation: reference.citation,
    context: reference.context,
    metadata: reference.metadata,
  };
}

function sourceRefIdFromReference(
  reference: TerminologySourceReferenceRecord | null,
): string | null {
  return reference?.sourceRefId ?? null;
}
