import { createHash } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  branchPolicyGlossaryReferences,
  events,
  localeBranches,
  styleGuides,
  styleGuideVersions,
  terminologyTermStatusValues,
  terminologyTerms,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";

export const branchPolicyGlossaryReferenceSchemaVersion =
  "itotori.branch_policy_glossary_reference.v1";
export const branchPolicyGlossaryReferenceUpdatedEventKind =
  "branch_policy_glossary_reference_updated";

export type BranchReferenceJsonRecord = Record<string, unknown>;

export type BranchPolicyGlossaryReferenceRecord = {
  referenceId: string;
  projectId: string;
  localeBranchId: string;
  versionSequence: number;
  styleGuideVersionId: string | null;
  glossaryContentHash: string;
  glossaryTermRefs: BranchReferenceJsonRecord[];
  updateReason: string;
  eventId: string | null;
  supersedesReferenceId: string | null;
  actorUserId: string | null;
  metadata: BranchReferenceJsonRecord;
  createdAt: Date;
};

export type ResolveBranchPolicyGlossaryReferenceInput = {
  projectId?: string;
  localeBranchId: string;
};

export type UpdateBranchPolicyGlossaryReferenceInput = {
  projectId: string;
  localeBranchId: string;
  referenceId?: string;
  styleGuideVersionId?: string | null;
  updateReason: string;
  metadata?: BranchReferenceJsonRecord;
};

export interface ItotoriBranchReferenceRepositoryPort {
  resolveBranchPolicyGlossaryReference(
    actor: AuthorizationActor,
    input: ResolveBranchPolicyGlossaryReferenceInput,
  ): Promise<BranchPolicyGlossaryReferenceRecord | null>;
  updateBranchPolicyGlossaryReference(
    actor: AuthorizationActor,
    input: UpdateBranchPolicyGlossaryReferenceInput,
  ): Promise<BranchPolicyGlossaryReferenceRecord>;
}

export class ItotoriBranchReferenceRepository implements ItotoriBranchReferenceRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async resolveBranchPolicyGlossaryReference(
    actor: AuthorizationActor,
    input: ResolveBranchPolicyGlossaryReferenceInput,
  ): Promise<BranchPolicyGlossaryReferenceRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return resolveBranchPolicyGlossaryReferenceInTx(this.db, input);
  }

  async updateBranchPolicyGlossaryReference(
    actor: AuthorizationActor,
    input: UpdateBranchPolicyGlossaryReferenceInput,
  ): Promise<BranchPolicyGlossaryReferenceRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    return this.db.transaction((tx) =>
      ensureBranchPolicyGlossaryReferenceInTx(tx, actor, { ...input, force: true }),
    );
  }
}

export async function resolveBranchPolicyGlossaryReferenceInTx(
  db: ItotoriDatabase,
  input: ResolveBranchPolicyGlossaryReferenceInput,
): Promise<BranchPolicyGlossaryReferenceRecord | null> {
  const conditions = [eq(branchPolicyGlossaryReferences.localeBranchId, input.localeBranchId)];
  if (input.projectId !== undefined) {
    conditions.push(eq(branchPolicyGlossaryReferences.projectId, input.projectId));
  }
  const rows = await db
    .select()
    .from(branchPolicyGlossaryReferences)
    .where(and(...conditions))
    .orderBy(desc(branchPolicyGlossaryReferences.versionSequence))
    .limit(1);
  return rows[0] === undefined ? null : branchReferenceFromRow(rows[0]);
}

export async function ensureBranchPolicyGlossaryReferenceInTx(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  input: UpdateBranchPolicyGlossaryReferenceInput & { force?: boolean },
): Promise<BranchPolicyGlossaryReferenceRecord> {
  const context = await getBranchContext(db, input.projectId, input.localeBranchId);
  if (context === null) {
    throw new Error(
      `locale branch ${input.localeBranchId} does not exist for project ${input.projectId}`,
    );
  }

  await db.execute(sql`
    select pg_advisory_xact_lock(hashtext(${"branch-policy-glossary:" + input.localeBranchId}))
  `);

  const styleGuideVersionId =
    input.styleGuideVersionId === undefined
      ? await approvedStyleGuideVersionId(db, input.localeBranchId)
      : input.styleGuideVersionId;
  if (styleGuideVersionId !== null) {
    await validateStyleGuideVersion(db, context, styleGuideVersionId);
  }

  const glossarySnapshot = await glossarySnapshotForBranch(db, input.localeBranchId);
  const latest = await resolveBranchPolicyGlossaryReferenceInTx(db, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
  });
  if (
    input.force !== true &&
    latest !== null &&
    latest.styleGuideVersionId === styleGuideVersionId &&
    latest.glossaryContentHash === glossarySnapshot.glossaryContentHash
  ) {
    return latest;
  }

  const versionSequence = (latest?.versionSequence ?? 0) + 1;
  const referenceId = input.referenceId ?? createUuid7();
  const eventId = createUuid7();
  const metadata = jsonRecord(input.metadata ?? {}, "metadata");
  const subjectRefs = [
    {
      refKind: "locale_branch",
      localeBranchId: input.localeBranchId,
    },
    ...(styleGuideVersionId === null
      ? []
      : [
          {
            refKind: "style_guide_version",
            styleGuideVersionId,
          },
        ]),
    {
      refKind: "glossary_reference",
      glossaryReferenceId: referenceId,
      glossaryContentHash: glossarySnapshot.glossaryContentHash,
    },
  ];
  const provenance = [
    {
      schemaVersion: branchPolicyGlossaryReferenceSchemaVersion,
      actorUserId: actor.userId,
      repository: "ItotoriBranchReferenceRepository",
      supersedesReferenceId: latest?.referenceId ?? null,
      styleGuideVersionId,
      glossaryContentHash: glossarySnapshot.glossaryContentHash,
      updateReason: requiredString(input.updateReason, "updateReason"),
    },
  ];

  await db.insert(events).values({
    eventId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    eventKind: branchPolicyGlossaryReferenceUpdatedEventKind,
    occurredAt: new Date(),
    actor,
    subjectRefs,
    provenance,
    causalLinks: latest?.eventId === null || latest === null ? [] : [{ eventId: latest.eventId }],
    payload: {
      schemaVersion: branchPolicyGlossaryReferenceSchemaVersion,
      referenceId,
      versionSequence,
      styleGuideVersionId,
      glossaryContentHash: glossarySnapshot.glossaryContentHash,
      supersedesReferenceId: latest?.referenceId ?? null,
      updateReason: input.updateReason,
      metadata,
    },
  });

  const rows = await db
    .insert(branchPolicyGlossaryReferences)
    .values({
      referenceId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      versionSequence,
      styleGuideVersionId,
      glossaryContentHash: glossarySnapshot.glossaryContentHash,
      glossaryTermRefs: glossarySnapshot.glossaryTermRefs,
      updateReason: requiredString(input.updateReason, "updateReason"),
      eventId,
      supersedesReferenceId: latest?.referenceId ?? null,
      actorUserId: actor.userId,
      metadata,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`branch policy/glossary reference ${referenceId} was not persisted`);
  }
  return branchReferenceFromRow(row);
}

type BranchReferenceContext = {
  projectId: string;
  localeBranchId: string;
};

type BranchGlossarySnapshot = {
  glossaryContentHash: string;
  glossaryTermRefs: BranchReferenceJsonRecord[];
};

async function getBranchContext(
  db: ItotoriDatabase,
  projectId: string,
  localeBranchId: string,
): Promise<BranchReferenceContext | null> {
  const rows = await db
    .select({
      projectId: localeBranches.projectId,
      localeBranchId: localeBranches.localeBranchId,
    })
    .from(localeBranches)
    .where(
      and(
        eq(localeBranches.projectId, projectId),
        eq(localeBranches.localeBranchId, localeBranchId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function approvedStyleGuideVersionId(
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

async function validateStyleGuideVersion(
  db: ItotoriDatabase,
  context: BranchReferenceContext,
  styleGuideVersionId: string,
): Promise<void> {
  const rows = await db
    .select({ styleGuideVersionId: styleGuideVersions.styleGuideVersionId })
    .from(styleGuideVersions)
    .where(
      and(
        eq(styleGuideVersions.styleGuideVersionId, styleGuideVersionId),
        eq(styleGuideVersions.projectId, context.projectId),
        eq(styleGuideVersions.localeBranchId, context.localeBranchId),
      ),
    )
    .limit(1);
  if (rows[0] === undefined) {
    throw new Error(
      `style guide version ${styleGuideVersionId} does not exist for locale branch ${context.localeBranchId}`,
    );
  }
}

async function glossarySnapshotForBranch(
  db: ItotoriDatabase,
  localeBranchId: string,
): Promise<BranchGlossarySnapshot> {
  const terms = await db
    .select({
      termId: terminologyTerms.termId,
      sourceTerm: terminologyTerms.sourceTerm,
      normalizedSourceTerm: terminologyTerms.normalizedSourceTerm,
      preferredTranslation: terminologyTerms.preferredTranslation,
      normalizedPreferredTranslation: terminologyTerms.normalizedPreferredTranslation,
      termKind: terminologyTerms.termKind,
      status: terminologyTerms.status,
      updatedAt: terminologyTerms.updatedAt,
    })
    .from(terminologyTerms)
    .where(
      and(
        eq(terminologyTerms.localeBranchId, localeBranchId),
        ne(terminologyTerms.status, terminologyTermStatusValues.deprecated),
      ),
    )
    .orderBy(asc(terminologyTerms.normalizedSourceTerm), asc(terminologyTerms.termId));

  const glossaryTermRefs = terms.map((term) => ({
    termId: term.termId,
    sourceTerm: term.sourceTerm,
    normalizedSourceTerm: term.normalizedSourceTerm,
    preferredTranslation: term.preferredTranslation,
    normalizedPreferredTranslation: term.normalizedPreferredTranslation,
    termKind: term.termKind,
    status: term.status,
    updatedAt: term.updatedAt.toISOString(),
  }));
  const hashPayload = {
    schemaVersion: branchPolicyGlossaryReferenceSchemaVersion,
    glossaryTermRefs,
  };

  return {
    glossaryContentHash: `sha256:${createHash("sha256")
      .update(stableStringify(hashPayload))
      .digest("hex")}`,
    glossaryTermRefs,
  };
}

function branchReferenceFromRow(
  row: typeof branchPolicyGlossaryReferences.$inferSelect,
): BranchPolicyGlossaryReferenceRecord {
  return {
    referenceId: row.referenceId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    versionSequence: row.versionSequence,
    styleGuideVersionId: row.styleGuideVersionId,
    glossaryContentHash: row.glossaryContentHash,
    glossaryTermRefs: row.glossaryTermRefs,
    updateReason: row.updateReason,
    eventId: row.eventId,
    supersedesReferenceId: row.supersedesReferenceId,
    actorUserId: row.actorUserId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function jsonRecord(value: unknown, label: string): BranchReferenceJsonRecord {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as BranchReferenceJsonRecord;
  }
  throw new Error(`${label} must be a JSON object`);
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
