import { asc, sql } from "drizzle-orm";
import {
  artifacts,
  eventOutbox,
  findings,
  localeBranchUnits,
  outboxEventTypeValues,
  outboxStatusValues,
} from "../schema.js";
import { createUuid7, type OutboxEventRecord } from "./event-queue-repository.js";
import {
  affectedWorkInvalidatedPayloadSchemaVersion,
  assertStyleGuideVersionChangedPayload,
  type AffectedWorkInvalidatedPayload,
  type AffectedWorkReference,
  type AffectedWorkSurface,
  type StyleGuideVersionChangedPayload,
  type StyleGuideVersionRecord,
} from "./style-guide-repository-contracts.js";
import { outboxEventFromRow, type StyleGuideDb } from "./style-guide-repository-rows.js";

export async function appendStyleGuideVersionChangedEventInTx(
  db: StyleGuideDb,
  eventPayload: StyleGuideVersionChangedPayload,
): Promise<OutboxEventRecord> {
  assertStyleGuideVersionChangedPayload(eventPayload);
  const outboxEventId = createUuid7();
  const idempotencyKey = styleGuideVersionChangedIdempotencyKey(eventPayload);
  const rows = await db.execute(sql`
    insert into ${eventOutbox} (
      outbox_event_id,
      project_id,
      locale_branch_id,
      event_type,
      status,
      idempotency_key,
      correlation_id,
      payload
    )
    values (
      ${outboxEventId},
      ${eventPayload.projectId},
      ${eventPayload.localeBranchId},
      ${outboxEventTypeValues.styleGuideVersionChanged},
      ${outboxStatusValues.pending},
      ${idempotencyKey},
      ${outboxEventId},
      ${JSON.stringify(eventPayload)}::jsonb
    )
    on conflict (idempotency_key) do nothing
    returning *
  `);
  if (rows.rows[0] !== undefined) {
    return outboxEventFromRow(rows.rows[0] as Record<string, unknown>);
  }

  const existingRows = await db.execute(sql`
    select *
    from ${eventOutbox}
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  const existing = existingRows.rows[0];
  if (existing === undefined) {
    throw new Error(`outbox event ${outboxEventId} was not persisted`);
  }
  return outboxEventFromRow(existing as Record<string, unknown>);
}

function styleGuideVersionChangedIdempotencyKey(payload: StyleGuideVersionChangedPayload): string {
  return [
    "style-guide-version-changed",
    payload.changeKind,
    payload.localeBranchId,
    payload.previousVersionId ?? "none",
    payload.newVersionId,
  ].join(":");
}

type AffectedWorkBySurface = Record<AffectedWorkSurface, AffectedWorkReference[]>;

type AppendAffectedWorkInvalidatedInput = {
  projectId: string;
  localeBranchId: string;
  approverUserId: string;
  priorVersion: StyleGuideVersionRecord;
  approvedVersion: StyleGuideVersionRecord;
  causationOutboxEvent: OutboxEventRecord;
};

export async function appendAffectedWorkInvalidatedEventsInTx(
  db: StyleGuideDb,
  input: AppendAffectedWorkInvalidatedInput,
): Promise<OutboxEventRecord[]> {
  const affectedWork = await listAffectedWorkByPriorStyleGuideVersionInTx(db, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    priorStyleGuideVersionId: input.priorVersion.styleGuideVersionId,
  });
  const outboxEvents: OutboxEventRecord[] = [];

  for (const surface of affectedWorkSurfaces) {
    const references = affectedWork[surface];
    if (references.length === 0) {
      continue;
    }

    outboxEvents.push(
      await appendAffectedWorkInvalidatedEventInTx(db, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        approverUserId: input.approverUserId,
        priorStyleGuideVersionId: input.priorVersion.styleGuideVersionId,
        approvedStyleGuideVersionId: input.approvedVersion.styleGuideVersionId,
        sourceRevisionBoundary: {
          prior: input.priorVersion.sourceRevisionReference,
          approved: input.approvedVersion.sourceRevisionReference,
        },
        affectedWork: {
          surface,
          count: references.length,
          references,
        },
        causationOutboxEvent: input.causationOutboxEvent,
      }),
    );
  }

  return outboxEvents;
}

const affectedWorkSurfaces = [
  "drafts",
  "qa_findings",
  "exports",
  "benchmarks",
] as const satisfies readonly AffectedWorkSurface[];

async function listAffectedWorkByPriorStyleGuideVersionInTx(
  db: StyleGuideDb,
  input: {
    projectId: string;
    localeBranchId: string;
    priorStyleGuideVersionId: string;
  },
): Promise<AffectedWorkBySurface> {
  // Unknown-provenance invalidation policy
  // --------------------------------------
  // A draft is affected when its provenance names the prior approved version
  // (`style_guide_version_id = prior`). But a draft can also carry non-null
  // target text with a NULL provenance -- a pre-provenance row (written before
  // migration 0018) that migration 0057 could not attribute deterministically
  // (its locale branch had no approved version to attribute to). Such a draft
  // has UNKNOWN provenance: we cannot prove it is unaffected by this style-guide
  // change. The safe default is to FLAG it on any approval-with-prior rather
  // than silently skip a draft that should be reviewed -- over-flagging costs a
  // human a second look; silently missing loses the review entirely. So a
  // NULL-provenance draft with target text is treated as affected here.
  const drafts = await db
    .select({ bridgeUnitId: localeBranchUnits.bridgeUnitId })
    .from(localeBranchUnits)
    .where(
      sql`${localeBranchUnits.localeBranchId} = ${input.localeBranchId}
        and ${localeBranchUnits.targetText} is not null
        and (
          ${localeBranchUnits.styleGuideVersionId} = ${input.priorStyleGuideVersionId}
          or ${localeBranchUnits.styleGuideVersionId} is null
        )`,
    )
    .orderBy(asc(localeBranchUnits.bridgeUnitId));

  const findingsRows = await db
    .select({ findingId: findings.findingId })
    .from(findings)
    .where(
      sql`${findings.projectId} = ${input.projectId}
        and ${findings.localeBranchId} = ${input.localeBranchId}
        and ${findings.status} <> 'resolved'
        and (
          ${findings.affectedRefs} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.evidence} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.provenance} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
          or ${findings.causalLinks} @> ${JSON.stringify([{ styleGuideVersionId: input.priorStyleGuideVersionId }])}::jsonb
        )`,
    )
    .orderBy(asc(findings.findingId));

  const exportRows = await db
    .select({ artifactId: artifacts.artifactId, artifactKind: artifacts.artifactKind })
    .from(artifacts)
    .where(
      sql`${artifacts.projectId} = ${input.projectId}
        and ${artifacts.localeBranchId} = ${input.localeBranchId}
        and ${artifacts.artifactKind} in ('patch_export', 'patch_result', 'delta_package')
        and (
          ${artifacts.metadata}->>'styleGuideVersionId' = ${input.priorStyleGuideVersionId}
          or ${artifacts.metadata}->>'styleGuidePolicyVersionId' = ${input.priorStyleGuideVersionId}
        )`,
    )
    .orderBy(asc(artifacts.artifactId));

  const benchmarkRows = await db
    .select({ artifactId: artifacts.artifactId, artifactKind: artifacts.artifactKind })
    .from(artifacts)
    .where(
      sql`${artifacts.projectId} = ${input.projectId}
        and ${artifacts.localeBranchId} = ${input.localeBranchId}
        and ${artifacts.artifactKind} = 'benchmark_report'
        and (
          ${artifacts.metadata}->>'styleGuideVersionId' = ${input.priorStyleGuideVersionId}
          or ${artifacts.metadata}->>'styleGuidePolicyVersionId' = ${input.priorStyleGuideVersionId}
        )`,
    )
    .orderBy(asc(artifacts.artifactId));

  return {
    drafts: drafts.map((row) => ({
      surface: "drafts",
      draftId: `${input.localeBranchId}:${row.bridgeUnitId}`,
      bridgeUnitId: row.bridgeUnitId,
    })),
    qa_findings: findingsRows.map((row) => ({
      surface: "qa_findings",
      findingId: row.findingId,
    })),
    exports: exportRows.map((row) => ({
      surface: "exports",
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
    })),
    benchmarks: benchmarkRows.map((row) => ({
      surface: "benchmarks",
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
    })),
  };
}

async function appendAffectedWorkInvalidatedEventInTx(
  db: StyleGuideDb,
  input: Omit<
    AffectedWorkInvalidatedPayload,
    "schemaVersion" | "eventName" | "invalidationKind"
  > & {
    causationOutboxEvent: OutboxEventRecord;
  },
): Promise<OutboxEventRecord> {
  const outboxEventId = createUuid7();
  const payload: AffectedWorkInvalidatedPayload = {
    schemaVersion: affectedWorkInvalidatedPayloadSchemaVersion,
    eventName: "AffectedWorkInvalidated",
    invalidationKind: "style_guide_version_approved",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    approverUserId: input.approverUserId,
    priorStyleGuideVersionId: input.priorStyleGuideVersionId,
    approvedStyleGuideVersionId: input.approvedStyleGuideVersionId,
    sourceRevisionBoundary: input.sourceRevisionBoundary,
    affectedWork: input.affectedWork,
  };
  const idempotencyKey = affectedWorkInvalidatedIdempotencyKey(payload);

  const rows = await db.execute(sql`
    insert into ${eventOutbox} (
      outbox_event_id,
      project_id,
      locale_branch_id,
      event_type,
      status,
      idempotency_key,
      correlation_id,
      causation_id,
      payload
    )
    values (
      ${outboxEventId},
      ${input.projectId},
      ${input.localeBranchId},
      ${outboxEventTypeValues.affectedWorkInvalidated},
      ${outboxStatusValues.pending},
      ${idempotencyKey},
      ${input.causationOutboxEvent.correlationId},
      ${input.causationOutboxEvent.outboxEventId},
      ${JSON.stringify(payload)}::jsonb
    )
    on conflict (idempotency_key) do nothing
    returning *
  `);
  if (rows.rows[0] !== undefined) {
    return outboxEventFromRow(rows.rows[0] as Record<string, unknown>);
  }

  const existingRows = await db.execute(sql`
    select *
    from ${eventOutbox}
    where idempotency_key = ${idempotencyKey}
    limit 1
  `);
  const existing = existingRows.rows[0];
  if (existing === undefined) {
    throw new Error(`outbox event ${outboxEventId} was not persisted`);
  }
  return outboxEventFromRow(existing as Record<string, unknown>);
}

function affectedWorkInvalidatedIdempotencyKey(payload: AffectedWorkInvalidatedPayload): string {
  return [
    "affected-work-invalidated",
    "style-guide-approved",
    payload.localeBranchId,
    payload.priorStyleGuideVersionId,
    payload.approvedStyleGuideVersionId,
    payload.affectedWork.surface,
  ].join(":");
}
