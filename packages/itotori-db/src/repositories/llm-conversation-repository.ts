import type { DatabaseContext } from "../connection.js";
import type { LlmContentReadAuthorizer } from "../llm-content-access.js";
import {
  assertLlmSha256,
  canonicalLlmJson,
  canonicalParentIds,
  conversationEventId,
  llmSha256,
  parseLlmJson,
  type LlmJsonValue,
} from "../llm-content-address.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";
import {
  ItotoriLlmSnapshotRepository,
  type LlmContextSnapshot,
  type LlmSnapshotFact,
} from "./llm-snapshot-repository.js";
import {
  LLM_CONVERSATION_EVENT_SCHEMA_VERSION,
  type AppendLlmConversationEventInput,
  type LlmConversationEvent,
  type LlmProjectionSelector,
  type LlmConversationSnapshotKind,
  type LlmThreadProjectionInput,
  type ProjectedLlmConversationEvent,
} from "./llm-conversation-repository-types.js";
import {
  assertIdempotent,
  assertProjectionBounds,
  boundProjection,
  conversationEventProjectionMetadata,
  eligibleSelector,
  eligibleSnapshotFacts,
  eventRecord,
  asHash,
  asKind,
  projectableBody,
  topologicalRows,
  type AcceptedHeadSets,
  type EventRow,
  type NormalizedAppend,
  type ThreadRow,
} from "./llm-conversation-repository-support.js";

export {
  LLM_CONVERSATION_EVENT_SCHEMA_VERSION,
  LlmConversationEventConflictError,
} from "./llm-conversation-repository-types.js";
export type {
  AppendLlmConversationEventInput,
  LlmConversationEvent,
  LlmConversationEventKind,
  LlmConversationProjectionMetadata,
  LlmConversationSnapshotKind,
  LlmProjectionSelector,
  LlmProjectionVisibility,
  LlmProjectableEventBody,
  LlmThreadProjectionInput,
  ProjectedLlmConversationEvent,
} from "./llm-conversation-repository-types.js";
export { conversationEventProjectionMetadata } from "./llm-conversation-repository-support.js";

export class ItotoriLlmConversationRepository {
  readonly #snapshots: ItotoriLlmSnapshotRepository;

  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
    private readonly contentAccess: LlmContentReadAuthorizer,
  ) {
    this.#snapshots = new ItotoriLlmSnapshotRepository(pool);
  }

  async append(input: AppendLlmConversationEventInput): Promise<LlmConversationEvent> {
    const normalized = await this.normalizeAppend(input);
    const existing = await this.findEvent(normalized.id);
    if (existing) return assertIdempotent(existing, normalized);

    const sealed = await this.cipher.seal(normalized.bodyJson);
    try {
      const inserted = await this.pool.query<EventRow>(
        `
          insert into itotori_llm_conversation_events (
            event_id, schema_version, parent_event_ids, event_kind, snapshot_kind,
            snapshot_id, actor_role, event_body_ciphertext, event_body_key_ref,
            event_body_content_hash, memo_key, projection_kind, projection_ref,
            projection_auxiliary_ref, accepted, created_at, retention_deadline
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16::timestamptz, $16::timestamptz + interval '30 days'
          )
          on conflict (event_id) do nothing
          returning event_id, parent_event_ids, event_kind, snapshot_kind, snapshot_id,
            actor_role, event_body_content_hash, memo_key, projection_kind, projection_ref,
            projection_auxiliary_ref, accepted, created_at, deletion_state
        `,
        [
          normalized.id,
          LLM_CONVERSATION_EVENT_SCHEMA_VERSION,
          normalized.parentIds,
          normalized.kind,
          normalized.snapshotKind,
          normalized.snapshotId,
          normalized.role,
          sealed.ciphertext,
          sealed.keyRef,
          normalized.bodyHash,
          normalized.memoKey ?? null,
          normalized.projection?.kind ?? null,
          normalized.projection?.ref ?? null,
          normalized.projection?.auxiliaryRef ?? null,
          normalized.accepted,
          normalized.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row) return eventRecord(row);
      await this.cipher.releaseKeyReference(sealed.keyRef);
      const raced = await this.findEvent(normalized.id);
      if (!raced) throw new Error("conversation event insert lost without a durable winner");
      return assertIdempotent(raced, normalized);
    } catch (error: unknown) {
      await this.cipher.releaseKeyReference(sealed.keyRef);
      throw error;
    }
  }

  async fork(headId: string): Promise<`sha256:${string}`> {
    assertLlmSha256(headId, "conversation fork head");
    const result = await this.pool.query(
      `select 1 from itotori_llm_conversation_events where event_id = $1`,
      [headId],
    );
    if (result.rowCount !== 1) throw new Error("conversation fork head does not exist");
    return headId;
  }

  async join(input: {
    heads: readonly string[];
    snapshotKind: LlmConversationSnapshotKind;
    snapshotId: string;
    role: string;
    artifact: LlmJsonValue;
    memoKey?: string;
    accepted: boolean;
    createdAt: string;
  }): Promise<LlmConversationEvent> {
    const heads = canonicalParentIds(input.heads);
    if (heads.length < 2) throw new Error("a conversation join requires at least two heads");
    return this.append({
      parentIds: heads,
      kind: "artifact",
      snapshotKind: input.snapshotKind,
      snapshotId: input.snapshotId,
      role: input.role,
      body: input.artifact,
      ...(input.memoKey ? { memoKey: input.memoKey } : {}),
      accepted: input.accepted,
      createdAt: input.createdAt,
    });
  }

  async thread(input: LlmThreadProjectionInput): Promise<readonly ProjectedLlmConversationEvent[]> {
    assertLlmSha256(input.headId, "conversation thread head");
    assertLlmSha256(input.snapshotId, "conversation thread snapshot");
    assertProjectionBounds(input);
    const snapshotScope = await this.projectionSnapshotScope(input.snapshotId);
    const acceptedHeads = await this.currentAcceptedHeads(snapshotScope.snapshotIds);
    const eligibleFacts = eligibleSnapshotFacts(snapshotScope.context, input.activeRouteId);
    const ancestry = await this.ancestorRows(
      input.headId,
      snapshotScope.snapshotIds,
      acceptedHeads,
      eligibleFacts,
    );
    if (ancestry.length === 0) {
      if (await this.findEvent(input.headId)) return [];
      throw new Error("conversation thread head does not exist");
    }
    const rows = topologicalRows(ancestry);

    const projected: Array<{
      event: ProjectedLlmConversationEvent;
      selector: LlmProjectionSelector;
      sequence: number;
    }> = [];
    for (const [sequence, row] of rows.entries()) {
      if (!row.event_body_ciphertext) continue;
      await this.contentAccess.requireContentRead({
        contentRef: row.event_id,
        purpose: "transcript-projection",
      });
      const plaintext = await this.cipher.open(row.event_body_ciphertext, row.event_body_key_ref);
      if (llmSha256(plaintext) !== row.event_body_content_hash) {
        throw new Error("encrypted conversation event body hash mismatch");
      }
      const body = projectableBody(parseLlmJson(plaintext));
      if (!body) continue;
      const selector = eligibleSelector(
        body.projection,
        input,
        snapshotScope.context,
        acceptedHeads,
        eligibleFacts,
      );
      if (!selector) continue;
      const trustedBody = selector === body.projection ? body : { ...body, projection: selector };
      projected.push({
        event: {
          id: asHash(row.event_id),
          parentIds: row.parent_event_ids,
          kind: asKind(row.event_kind),
          snapshotId: row.snapshot_id,
          role: row.actor_role,
          body: trustedBody,
          ...(row.memo_key ? { memoKey: row.memo_key } : {}),
        },
        selector,
        sequence,
      });
    }

    const recentTurns = new Set(
      projected
        .filter(({ selector }) => selector.kind === "local-turn")
        .slice(-input.recentLocalTurnLimit)
        .map(({ event }) => event.id),
    );
    const eligible = projected.filter(
      ({ event, selector }) => selector.kind !== "local-turn" || recentTurns.has(event.id),
    );
    return boundProjection(eligible, input.maxMessages).map(({ event }) => event);
  }

  private async normalizeAppend(input: AppendLlmConversationEventInput): Promise<NormalizedAppend> {
    assertLlmSha256(input.snapshotId, "conversation snapshot ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/u.test(input.role)) {
      throw new Error("conversation role is not a stable identifier");
    }
    if (!Number.isFinite(Date.parse(input.createdAt))) {
      throw new Error("conversation event timestamp is invalid");
    }
    if (input.memoKey !== undefined) assertLlmSha256(input.memoKey, "conversation memo key");
    const parentIds = canonicalParentIds(input.parentIds);
    await this.requireSnapshot(input.snapshotKind, input.snapshotId);
    await this.requireParents(parentIds);
    const bodyJson = canonicalLlmJson(input.body);
    const bodyHash = llmSha256(bodyJson);
    const projection = conversationEventProjectionMetadata(input.body);
    const id = conversationEventId({
      parentIds,
      kind: input.kind,
      snapshotId: input.snapshotId,
      role: input.role,
      body: input.body,
      ...(input.memoKey ? { memoKey: input.memoKey } : {}),
    });
    return { ...input, id, parentIds, bodyJson, bodyHash, projection };
  }

  private async requireSnapshot(kind: LlmConversationSnapshotKind, snapshotId: string) {
    const table =
      kind === "context" ? "itotori_llm_context_snapshots" : "itotori_llm_localization_snapshots";
    const result = await this.pool.query(`select 1 from ${table} where snapshot_id = $1`, [
      snapshotId,
    ]);
    if (result.rowCount !== 1) throw new Error(`conversation ${kind} snapshot does not exist`);
  }

  private async requireParents(parentIds: readonly string[]): Promise<void> {
    if (parentIds.length === 0) return;
    const result = await this.pool.query<{ event_id: string }>(
      `select event_id from itotori_llm_conversation_events where event_id = any($1::text[])`,
      [parentIds],
    );
    const found = new Set(result.rows.map((row) => row.event_id));
    if (parentIds.some((parentId) => !found.has(parentId))) {
      throw new Error("conversation event parent does not exist");
    }
  }

  private async findEvent(eventId: string): Promise<EventRow | null> {
    const result = await this.pool.query<EventRow>(
      `
        select event_id, parent_event_ids, event_kind, snapshot_kind, snapshot_id,
          actor_role, event_body_content_hash, memo_key, projection_kind, projection_ref,
          projection_auxiliary_ref, accepted, created_at, deletion_state
        from itotori_llm_conversation_events where event_id = $1
      `,
      [eventId],
    );
    return result.rows[0] ?? null;
  }

  private async projectionSnapshotScope(snapshotId: string): Promise<{
    context: LlmContextSnapshot;
    snapshotIds: readonly string[];
  }> {
    const context = await this.#snapshots.readContext(snapshotId);
    if (context) return { context, snapshotIds: [snapshotId] };
    const localization = await this.#snapshots.readLocalization(snapshotId);
    if (!localization) throw new Error("conversation projection snapshot does not exist");
    const sourceContext = await this.#snapshots.readContext(localization.contextSnapshot.id);
    if (!sourceContext) throw new Error("localization snapshot context does not exist");
    return { context: sourceContext, snapshotIds: [snapshotId, sourceContext.snapshotId] };
  }

  private async currentAcceptedHeads(snapshotIds: readonly string[]): Promise<AcceptedHeadSets> {
    const result = await this.pool.query<{ head_namespace: string; head_id: string }>(
      `
        select head.head_namespace, head.head_id
        from itotori_llm_cas_heads head
        join itotori_llm_accepted_outputs output on output.output_id = head.head_id
        where head.head_namespace = 'accepted-output'
          and head.snapshot_id = any($1::text[])
          and output.deletion_state = 'active'
          and not exists (
            select 1
            from unnest(output.memo_keys) required(memo_key)
            left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
            where memo.verification_status not in ('verified', 'explicit-unknown')
              or memo.deletion_state is distinct from 'active'
          )
        union all
        select head.head_namespace, head.head_id
        from itotori_llm_cas_heads head
        join itotori_llm_wiki_versions wiki on wiki.wiki_version_id = head.head_id
        where head.head_namespace = 'wiki-version'
          and head.snapshot_id = any($1::text[])
          and wiki.deletion_state = 'active'
      `,
      [snapshotIds],
    );
    return {
      outputs: new Set(
        result.rows
          .filter((row) => row.head_namespace === "accepted-output")
          .map((row) => row.head_id),
      ),
      semanticNotes: new Set(
        result.rows
          .filter((row) => row.head_namespace === "wiki-version")
          .map((row) => row.head_id),
      ),
    };
  }

  private async ancestorRows(
    headId: string,
    snapshotIds: readonly string[],
    heads: AcceptedHeadSets,
    eligibleFacts: ReadonlyMap<string, LlmSnapshotFact>,
  ): Promise<readonly ThreadRow[]> {
    const result = await this.pool.query<ThreadRow>(
      `
        with recursive ancestor_ids(event_id) as (
          select event_id
          from itotori_llm_conversation_events
          where event_id = $1
            and accepted = true
            and deletion_state = 'active'
            and snapshot_id = any($2::text[])
          union
          select parent_ref.event_id
          from ancestor_ids child
          join itotori_llm_conversation_events child_event
            on child_event.event_id = child.event_id
          cross join lateral unnest(child_event.parent_event_ids) parent_ref(event_id)
          join itotori_llm_conversation_events parent
            on parent.event_id = parent_ref.event_id
        ), bounded_ancestor_ids as (
          select event_id, count(*) over ()::int as ancestry_count
          from ancestor_ids
          order by event_id
          limit 4097
        ), eligible_ancestor_ids(event_id) as (
          select event.event_id
          from bounded_ancestor_ids ancestor
          join itotori_llm_conversation_events event on event.event_id = ancestor.event_id
          where event.accepted = true
            and event.deletion_state = 'active'
            and event.snapshot_id = any($2::text[])
            and (
              event.projection_kind is distinct from 'accepted-target'
              or event.projection_ref = any($3::text[])
            )
            and (
              event.projection_kind is distinct from 'semantic-note'
              or event.projection_ref = any($4::text[])
            )
            and (
              event.projection_kind is distinct from 'snapshot-fact'
              or event.projection_ref = any($5::text[])
            )
        ), projection_edges(child_id, candidate_parent_id) as (
          select eligible.event_id, parent_ref.event_id
          from eligible_ancestor_ids eligible
          join itotori_llm_conversation_events event on event.event_id = eligible.event_id
          cross join lateral unnest(event.parent_event_ids) parent_ref(event_id)
          union
          select edge.child_id, parent_ref.event_id
          from projection_edges edge
          join itotori_llm_conversation_events candidate
            on candidate.event_id = edge.candidate_parent_id
          cross join lateral unnest(candidate.parent_event_ids) parent_ref(event_id)
          where not exists (
            select 1 from eligible_ancestor_ids eligible
            where eligible.event_id = edge.candidate_parent_id
          )
        )
        select event.event_id, event.parent_event_ids, event.event_kind, event.snapshot_kind,
          event.snapshot_id, event.actor_role, event.event_body_ciphertext,
          event.event_body_key_ref, event.event_body_content_hash, event.memo_key,
          event.projection_kind, event.projection_ref, event.projection_auxiliary_ref,
          event.accepted, event.created_at, event.deletion_state, ancestor.ancestry_count,
          coalesce(projected_parents.parent_event_ids, '{}'::text[])
            as topology_parent_event_ids
        from bounded_ancestor_ids ancestor
        join itotori_llm_conversation_events event on event.event_id = ancestor.event_id
        join eligible_ancestor_ids eligible on eligible.event_id = event.event_id
        left join lateral (
          select array_agg(edge.candidate_parent_id order by edge.candidate_parent_id)
            as parent_event_ids
          from projection_edges edge
          join eligible_ancestor_ids parent on parent.event_id = edge.candidate_parent_id
          where edge.child_id = event.event_id
        ) projected_parents on true
        order by event.event_id
      `,
      [
        headId,
        snapshotIds,
        [...heads.outputs],
        [...heads.semanticNotes],
        [...eligibleFacts.keys()],
      ],
    );
    if ((result.rows[0]?.ancestry_count ?? 0) > 4096) {
      throw new Error("conversation ancestry exceeds the bounded projection traversal limit");
    }
    if (result.rows.length === 0) {
      const ancestryCount = await this.ancestorCount(headId, snapshotIds);
      if (ancestryCount > 4096) {
        throw new Error("conversation ancestry exceeds the bounded projection traversal limit");
      }
    }
    return result.rows;
  }

  private async ancestorCount(headId: string, snapshotIds: readonly string[]): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `
        with recursive ancestor_ids(event_id) as (
          select event_id
          from itotori_llm_conversation_events
          where event_id = $1
            and accepted = true
            and deletion_state = 'active'
            and snapshot_id = any($2::text[])
          union
          select parent_ref.event_id
          from ancestor_ids child
          join itotori_llm_conversation_events child_event
            on child_event.event_id = child.event_id
          cross join lateral unnest(child_event.parent_event_ids) parent_ref(event_id)
          join itotori_llm_conversation_events parent
            on parent.event_id = parent_ref.event_id
        )
        select count(*)::int as count from (
          select 1 from ancestor_ids limit 4097
        ) bounded_ancestors
      `,
      [headId, snapshotIds],
    );
    return result.rows[0]?.count ?? 0;
  }
}
