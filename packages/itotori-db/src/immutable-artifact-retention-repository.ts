import type { PoolClient } from "pg";

import type { AuthorizationActor } from "./authorization.js";
import { permissionValues, requirePermission } from "./authorization.js";
import type { DatabaseContext } from "./connection.js";
import type { LlmMemoCipher } from "./repositories/llm-call-memo-repository.js";

export type ImmutableArtifactRetentionReport = {
  reconciledReferences: number;
  deletedArtifacts: number;
  releasedKeyRefs: number;
};

type DeletingRow = { artifact_id: string; content_key_ref: string };

/** Reconciles project references and expires unreferenced immutable payloads.
 * Metadata, reference tombstones, and audit rows remain after content deletion. */
export class ItotoriImmutableArtifactRetentionRepository {
  constructor(
    private readonly context: Pick<DatabaseContext, "pool" | "db">,
    private readonly cipher: LlmMemoCipher,
  ) {}

  async deleteExpired(
    actor: AuthorizationActor,
    now = new Date(),
  ): Promise<ImmutableArtifactRetentionReport> {
    if (Number.isNaN(now.getTime())) throw new Error("retention cutoff must be a valid date");
    await requirePermission(this.context.db, actor, permissionValues.retentionManage);
    const client = await this.context.pool.connect();
    try {
      const reconciledReferences = await reconcileProjectReferences(client, actor, now);
      const deleting = await stageExpiredArtifacts(client, actor, now);
      const released = new Set<string>();
      for (const row of deleting) {
        await this.cipher.releaseKeyReference(row.content_key_ref);
        released.add(row.content_key_ref);
      }
      const deletedArtifacts = await finishDeletingArtifacts(client, actor, now, deleting);
      return {
        reconciledReferences,
        deletedArtifacts,
        releasedKeyRefs: released.size,
      };
    } finally {
      client.release();
    }
  }
}

async function reconcileProjectReferences(
  client: PoolClient,
  actor: AuthorizationActor,
  now: Date,
): Promise<number> {
  await client.query("begin");
  try {
    const reconciled = await client.query<{ reference_id: string }>(
      `update itotori_immutable_artifact_references r
       set removed_at = $1::timestamptz, removed_by = $2
       where r.removed_at is null
         and not exists (
           select 1 from itotori_artifacts a
           where a.project_id = r.project_id
             and a.artifact_id = r.project_artifact_id
             and a.hash = r.artifact_id
         )
       returning r.reference_id`,
      [now.toISOString(), actor.userId],
    );
    if (reconciled.rows.length > 0) {
      await client.query(
        `insert into itotori_immutable_artifact_audit_events (
           occurred_at, actor_id, action, target, outcome, details
         ) values ($1::timestamptz, $2, 'reference-reconcile',
           'project-references', 'removed', $3::jsonb)`,
        [
          now.toISOString(),
          actor.userId,
          JSON.stringify({ referenceCount: reconciled.rows.length }),
        ],
      );
    }
    await client.query("commit");
    return reconciled.rows.length;
  } catch (error: unknown) {
    await client.query("rollback");
    throw error;
  }
}

async function stageExpiredArtifacts(
  client: PoolClient,
  actor: AuthorizationActor,
  now: Date,
): Promise<DeletingRow[]> {
  await client.query("begin");
  try {
    while (true) {
      const candidates = await client.query<{ artifact_id: string }>(
        `select parent.artifact_id
         from itotori_immutable_artifacts parent
         where parent.deletion_state = 'active'
           and parent.expires_at <= $1::timestamptz
           and not exists (
             select 1 from itotori_immutable_artifact_references r
             where r.artifact_id = parent.artifact_id and r.removed_at is null
           )
           and not exists (
             select 1 from itotori_immutable_artifacts child
             where child.deletion_state = 'active'
               and parent.artifact_id = any(child.parents)
           )
         order by parent.artifact_id`,
        [now.toISOString()],
      );
      if (candidates.rows.length === 0) break;
      for (const candidate of candidates.rows) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          candidate.artifact_id,
        ]);
        await client.query(
          `update itotori_immutable_artifacts candidate
           set deletion_state = 'deleting'
           where candidate.artifact_id = $1 and candidate.deletion_state = 'active'
             and candidate.expires_at <= $2::timestamptz
             and not exists (
               select 1 from itotori_immutable_artifact_references r
               where r.artifact_id = candidate.artifact_id and r.removed_at is null
             )
             and not exists (
               select 1 from itotori_immutable_artifacts child
               where child.deletion_state = 'active'
                 and candidate.artifact_id = any(child.parents)
             )`,
          [candidate.artifact_id, now.toISOString()],
        );
      }
    }
    await client.query(
      `insert into itotori_immutable_artifact_audit_events (
         occurred_at, actor_id, action, target, outcome, artifact_id, details
       )
       select $1::timestamptz, $2, 'prune', artifact_id, 'staged', artifact_id,
         jsonb_build_object('expiresAt', expires_at)
       from itotori_immutable_artifacts
       where deletion_state = 'deleting'
         and not exists (
           select 1 from itotori_immutable_artifact_audit_events e
           where e.artifact_id = itotori_immutable_artifacts.artifact_id
             and e.action = 'prune' and e.outcome = 'staged'
         )`,
      [now.toISOString(), actor.userId],
    );
    const deleting = await client.query<DeletingRow>(
      `select artifact_id, content_key_ref
       from itotori_immutable_artifacts
       where deletion_state = 'deleting'
       order by artifact_id`,
    );
    await client.query("commit");
    return deleting.rows;
  } catch (error: unknown) {
    await client.query("rollback");
    throw error;
  }
}

async function finishDeletingArtifacts(
  client: PoolClient,
  actor: AuthorizationActor,
  now: Date,
  deleting: readonly DeletingRow[],
): Promise<number> {
  if (deleting.length === 0) return 0;
  const artifactIds = deleting.map((row) => row.artifact_id);
  await client.query("begin");
  try {
    const deleted = await client.query<{ artifact_id: string }>(
      `update itotori_immutable_artifacts
       set content_ciphertext = null, content_key_ref = null,
         deletion_state = 'deleted', deleted_at = $1::timestamptz
       where artifact_id = any($2::text[]) and deletion_state = 'deleting'
       returning artifact_id`,
      [now.toISOString(), artifactIds],
    );
    await client.query(
      `insert into itotori_immutable_artifact_audit_events (
         occurred_at, actor_id, action, target, outcome, artifact_id, details
       )
       select $1::timestamptz, $2, 'prune', artifact_id, 'pruned', artifact_id, '{}'::jsonb
       from unnest($3::text[]) artifact_id`,
      [now.toISOString(), actor.userId, deleted.rows.map((row) => row.artifact_id)],
    );
    await client.query("commit");
    return deleted.rows.length;
  } catch (error: unknown) {
    await client.query("rollback");
    throw error;
  }
}
