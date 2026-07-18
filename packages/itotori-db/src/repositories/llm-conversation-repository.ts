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

export const LLM_CONVERSATION_EVENT_SCHEMA_VERSION = "itotori.conversation-event.v1" as const;

export type LlmConversationEventKind =
  | "instruction"
  | "input"
  | "assistant"
  | "tool"
  | "artifact"
  | "defects";

export type LlmConversationSnapshotKind = "context" | "localization";

export interface AppendLlmConversationEventInput {
  parentIds: readonly string[];
  kind: LlmConversationEventKind;
  snapshotKind: LlmConversationSnapshotKind;
  snapshotId: string;
  role: string;
  body: LlmJsonValue;
  memoKey?: string;
  accepted: boolean;
  createdAt: string;
}

export interface LlmConversationEvent {
  id: `sha256:${string}`;
  parentIds: readonly string[];
  kind: LlmConversationEventKind;
  snapshotId: string;
  role: string;
  bodyEncrypted: {
    storageRef: string;
    contentHash: `sha256:${string}`;
    encryption: "operator-managed";
  };
  memoKey?: string;
  accepted: boolean;
  createdAt: string;
}

export interface LlmProjectionVisibility {
  routeScope:
    | { kind: "global" }
    | { kind: "route"; routeId: string }
    | { kind: "route-set"; routeIds: readonly string[] };
  fromPlayOrder: number;
  throughPlayOrder: number | null;
}

export type LlmProjectionSelector =
  | { kind: "role-contract"; contractVersion: string }
  | { kind: "snapshot-fact"; factId: string; visibility: LlmProjectionVisibility }
  | { kind: "semantic-note"; artifactId: string; visibility: LlmProjectionVisibility }
  | { kind: "accepted-target"; outputId: string; visibility: LlmProjectionVisibility }
  | { kind: "source-batch"; batchId: string; visibility: LlmProjectionVisibility }
  | { kind: "local-turn"; visibility: LlmProjectionVisibility }
  | {
      kind: "tool-loop";
      loopId: string;
      modelId: string;
      visibility: LlmProjectionVisibility;
    };

export interface LlmProjectableEventBody {
  projection: LlmProjectionSelector;
  message: LlmJsonValue;
}

export interface LlmConversationProjectionMetadata {
  kind: LlmProjectionSelector["kind"];
  ref: string | null;
  auxiliaryRef: string | null;
}

export interface LlmThreadProjectionInput {
  headId: string;
  snapshotId: string;
  activeRouteId: string;
  roleContractVersion: string;
  activeSourceBatchId: string;
  activeToolLoop: { loopId: string; modelId: string } | null;
  recentLocalTurnLimit: number;
  maxMessages: number;
}

export interface ProjectedLlmConversationEvent {
  id: `sha256:${string}`;
  parentIds: readonly string[];
  kind: LlmConversationEventKind;
  snapshotId: string;
  role: string;
  body: LlmProjectableEventBody;
  memoKey?: string;
}

export class LlmConversationEventConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`conversation event conflicts with immutable event ${eventId}`);
    this.name = "LlmConversationEventConflictError";
  }
}

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
      await this.cipher.destroyKey(sealed.keyRef);
      const raced = await this.findEvent(normalized.id);
      if (!raced) throw new Error("conversation event insert lost without a durable winner");
      return assertIdempotent(raced, normalized);
    } catch (error: unknown) {
      await this.cipher.destroyKey(sealed.keyRef);
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

function eligibleSelector(
  selector: LlmProjectionSelector,
  input: LlmThreadProjectionInput,
  context: LlmContextSnapshot,
  heads: AcceptedHeadSets,
  eligibleFacts: ReadonlyMap<string, LlmSnapshotFact>,
): LlmProjectionSelector | null {
  if (selector.kind === "role-contract") {
    return selector.contractVersion === input.roleContractVersion ? selector : null;
  }
  if (selector.kind === "snapshot-fact") {
    const fact = eligibleFacts.get(selector.factId);
    return fact
      ? {
          kind: "snapshot-fact",
          factId: fact.factId,
          visibility: {
            routeScope: fact.routeScope,
            fromPlayOrder: fact.playOrderIndex,
            throughPlayOrder: null,
          },
        }
      : null;
  }
  if (!visible(selector.visibility, input.activeRouteId, context.revealHorizon)) {
    return null;
  }
  switch (selector.kind) {
    case "local-turn":
      return selector;
    case "semantic-note":
      return heads.semanticNotes.has(selector.artifactId) ? selector : null;
    case "accepted-target":
      return heads.outputs.has(selector.outputId) ? selector : null;
    case "source-batch":
      return selector.batchId === input.activeSourceBatchId ? selector : null;
    case "tool-loop":
      return input.activeToolLoop !== null &&
        selector.loopId === input.activeToolLoop.loopId &&
        selector.modelId === input.activeToolLoop.modelId
        ? selector
        : null;
  }
}

function eligibleSnapshotFacts(
  context: LlmContextSnapshot,
  activeRouteId: string,
): ReadonlyMap<string, LlmSnapshotFact> {
  return new Map(
    context.facts
      .filter(
        (fact) =>
          factRouteVisible(fact, activeRouteId) &&
          (context.revealHorizon.kind === "complete" ||
            fact.playOrderIndex <= context.revealHorizon.playOrderIndex),
      )
      .map((fact) => [fact.factId, fact]),
  );
}

function factRouteVisible(fact: LlmSnapshotFact, activeRouteId: string): boolean {
  return (
    fact.routeScope.kind === "global" ||
    (fact.routeScope.kind === "route" && fact.routeScope.routeId === activeRouteId) ||
    (fact.routeScope.kind === "route-set" && fact.routeScope.routeIds.includes(activeRouteId))
  );
}

function visible(
  visibility: LlmProjectionVisibility,
  activeRouteId: string,
  horizon: LlmContextSnapshot["revealHorizon"],
): boolean {
  const routeVisible =
    visibility.routeScope.kind === "global" ||
    (visibility.routeScope.kind === "route" && visibility.routeScope.routeId === activeRouteId) ||
    (visibility.routeScope.kind === "route-set" &&
      visibility.routeScope.routeIds.includes(activeRouteId));
  if (!routeVisible) return false;
  if (horizon.kind === "complete") return true;
  return (
    visibility.fromPlayOrder <= horizon.playOrderIndex &&
    (visibility.throughPlayOrder === null || horizon.playOrderIndex <= visibility.throughPlayOrder)
  );
}

function projectableBody(value: LlmJsonValue): LlmProjectableEventBody | null {
  const body = asRecord(value);
  if (!body || !("message" in body)) return null;
  const projection = projectionSelector(body.projection);
  if (!projection) return null;
  return { projection, message: body.message! };
}

export function conversationEventProjectionMetadata(
  bodyValue: LlmJsonValue,
): LlmConversationProjectionMetadata | null {
  const body = projectableBody(bodyValue);
  if (!body) return null;
  const selector = body.projection;
  switch (selector.kind) {
    case "role-contract":
      return { kind: selector.kind, ref: selector.contractVersion, auxiliaryRef: null };
    case "snapshot-fact":
      return { kind: selector.kind, ref: selector.factId, auxiliaryRef: null };
    case "semantic-note":
      return { kind: selector.kind, ref: selector.artifactId, auxiliaryRef: null };
    case "accepted-target":
      return { kind: selector.kind, ref: selector.outputId, auxiliaryRef: null };
    case "source-batch":
      return { kind: selector.kind, ref: selector.batchId, auxiliaryRef: null };
    case "local-turn":
      return { kind: selector.kind, ref: null, auxiliaryRef: null };
    case "tool-loop":
      return { kind: selector.kind, ref: selector.loopId, auxiliaryRef: selector.modelId };
  }
}

function projectionSelector(value: LlmJsonValue | undefined): LlmProjectionSelector | null {
  const selector = asRecord(value);
  if (!selector || typeof selector.kind !== "string") return null;
  if (selector.kind === "role-contract") {
    return typeof selector.contractVersion === "string"
      ? { kind: "role-contract", contractVersion: selector.contractVersion }
      : null;
  }
  const visibility = projectionVisibility(selector.visibility);
  if (!visibility) return null;
  switch (selector.kind) {
    case "snapshot-fact":
      return typeof selector.factId === "string"
        ? { kind: selector.kind, factId: selector.factId, visibility }
        : null;
    case "semantic-note":
      return typeof selector.artifactId === "string"
        ? { kind: selector.kind, artifactId: selector.artifactId, visibility }
        : null;
    case "accepted-target":
      return typeof selector.outputId === "string"
        ? { kind: selector.kind, outputId: selector.outputId, visibility }
        : null;
    case "source-batch":
      return typeof selector.batchId === "string"
        ? { kind: selector.kind, batchId: selector.batchId, visibility }
        : null;
    case "local-turn":
      return { kind: selector.kind, visibility };
    case "tool-loop":
      return typeof selector.loopId === "string" && typeof selector.modelId === "string"
        ? {
            kind: selector.kind,
            loopId: selector.loopId,
            modelId: selector.modelId,
            visibility,
          }
        : null;
    default:
      return null;
  }
}

function projectionVisibility(value: LlmJsonValue | undefined): LlmProjectionVisibility | null {
  const visibility = asRecord(value);
  const scope = asRecord(visibility?.routeScope);
  if (
    !visibility ||
    !scope ||
    !Number.isSafeInteger(visibility.fromPlayOrder) ||
    (visibility.throughPlayOrder !== null && !Number.isSafeInteger(visibility.throughPlayOrder))
  ) {
    return null;
  }
  const fromPlayOrder = visibility.fromPlayOrder as number;
  const throughPlayOrder = visibility.throughPlayOrder as number | null;
  if (fromPlayOrder < 0 || (throughPlayOrder !== null && throughPlayOrder < fromPlayOrder)) {
    return null;
  }
  if (scope.kind === "global") {
    return { routeScope: { kind: "global" }, fromPlayOrder, throughPlayOrder };
  }
  if (scope.kind === "route" && typeof scope.routeId === "string") {
    return {
      routeScope: { kind: "route", routeId: scope.routeId },
      fromPlayOrder,
      throughPlayOrder,
    };
  }
  if (
    scope.kind === "route-set" &&
    Array.isArray(scope.routeIds) &&
    scope.routeIds.every((routeId) => typeof routeId === "string")
  ) {
    return {
      routeScope: { kind: "route-set", routeIds: scope.routeIds as string[] },
      fromPlayOrder,
      throughPlayOrder,
    };
  }
  return null;
}

function asRecord(value: LlmJsonValue | undefined): Record<string, LlmJsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, LlmJsonValue>)
    : null;
}

function boundProjection<T extends { selector: LlmProjectionSelector; sequence: number }>(
  events: readonly T[],
  maxMessages: number,
): readonly T[] {
  if (events.length <= maxMessages) return events;
  const currentContract = events.findLast(({ selector }) => selector.kind === "role-contract");
  if (!currentContract) return events.slice(-maxMessages);
  const tail = events.filter((event) => event !== currentContract).slice(-(maxMessages - 1));
  return [...tail, currentContract].sort((left, right) => left.sequence - right.sequence);
}

function topologicalRows(rows: readonly ThreadRow[]): readonly ThreadRow[] {
  const byId = new Map(rows.map((row) => [row.event_id, row]));
  const childIds = new Map<string, string[]>();
  const remainingParents = new Map<string, number>();
  for (const row of rows) {
    const parents = row.topology_parent_event_ids.filter((parentId) => byId.has(parentId));
    remainingParents.set(row.event_id, parents.length);
    for (const parentId of parents) {
      const children = childIds.get(parentId) ?? [];
      children.push(row.event_id);
      childIds.set(parentId, children);
    }
  }
  const ready = rows
    .filter((row) => remainingParents.get(row.event_id) === 0)
    .map((row) => row.event_id)
    .sort(compareCodeUnits);
  const ordered: ThreadRow[] = [];
  while (ready.length > 0) {
    const eventId = ready.shift()!;
    ordered.push(byId.get(eventId)!);
    for (const childId of (childIds.get(eventId) ?? []).sort(compareCodeUnits)) {
      const remaining = remainingParents.get(childId)! - 1;
      remainingParents.set(childId, remaining);
      if (remaining === 0) insertSorted(ready, childId);
    }
  }
  if (ordered.length !== rows.length) throw new Error("conversation ancestry contains a cycle");
  return ordered;
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => compareCodeUnits(value, candidate) < 0);
  if (index === -1) values.push(value);
  else values.splice(index, 0, value);
}

function assertProjectionBounds(input: LlmThreadProjectionInput): void {
  if (
    !Number.isSafeInteger(input.maxMessages) ||
    input.maxMessages < 1 ||
    input.maxMessages > 256
  ) {
    throw new Error("conversation projection maxMessages must be between 1 and 256");
  }
  if (
    !Number.isSafeInteger(input.recentLocalTurnLimit) ||
    input.recentLocalTurnLimit < 0 ||
    input.recentLocalTurnLimit > 64
  ) {
    throw new Error("conversation recent-local-turn limit must be between 0 and 64");
  }
}

function assertIdempotent(row: EventRow, input: NormalizedAppend): LlmConversationEvent {
  if (
    row.deletion_state !== "active" ||
    row.parent_event_ids.length !== input.parentIds.length ||
    row.parent_event_ids.some((parentId, index) => parentId !== input.parentIds[index]) ||
    row.event_kind !== input.kind ||
    row.snapshot_kind !== input.snapshotKind ||
    row.snapshot_id !== input.snapshotId ||
    row.actor_role !== input.role ||
    row.event_body_content_hash !== input.bodyHash ||
    row.memo_key !== (input.memoKey ?? null) ||
    row.projection_kind !== (input.projection?.kind ?? null) ||
    row.projection_ref !== (input.projection?.ref ?? null) ||
    row.projection_auxiliary_ref !== (input.projection?.auxiliaryRef ?? null) ||
    row.accepted !== input.accepted
  ) {
    throw new LlmConversationEventConflictError(input.id);
  }
  return eventRecord(row);
}

function eventRecord(row: EventRow): LlmConversationEvent {
  return {
    id: asHash(row.event_id),
    parentIds: row.parent_event_ids,
    kind: asKind(row.event_kind),
    snapshotId: row.snapshot_id,
    role: row.actor_role,
    bodyEncrypted: {
      storageRef: row.event_id,
      contentHash: asHash(row.event_body_content_hash),
      encryption: "operator-managed",
    },
    ...(row.memo_key ? { memoKey: row.memo_key } : {}),
    accepted: row.accepted,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function asHash(value: string): `sha256:${string}` {
  assertLlmSha256(value, "persisted SHA-256 value");
  return value;
}

function asKind(value: string): LlmConversationEventKind {
  if (
    value !== "instruction" &&
    value !== "input" &&
    value !== "assistant" &&
    value !== "tool" &&
    value !== "artifact" &&
    value !== "defects"
  ) {
    throw new Error("persisted conversation event kind is invalid");
  }
  return value;
}

type NormalizedAppend = AppendLlmConversationEventInput & {
  id: `sha256:${string}`;
  parentIds: readonly string[];
  bodyJson: string;
  bodyHash: `sha256:${string}`;
  projection: LlmConversationProjectionMetadata | null;
};

type EventRow = {
  event_id: string;
  parent_event_ids: string[];
  event_kind: string;
  snapshot_kind: string;
  snapshot_id: string;
  actor_role: string;
  event_body_content_hash: string;
  memo_key: string | null;
  projection_kind: string | null;
  projection_ref: string | null;
  projection_auxiliary_ref: string | null;
  accepted: boolean;
  created_at: Date;
  deletion_state: string;
};

type ThreadRow = EventRow & {
  event_body_ciphertext: Uint8Array | null;
  event_body_key_ref: string;
  ancestry_count: number;
  topology_parent_event_ids: string[];
};

type AcceptedHeadSets = {
  outputs: ReadonlySet<string>;
  semanticNotes: ReadonlySet<string>;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
