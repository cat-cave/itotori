import { assertLlmSha256, type LlmJsonValue } from "../llm-content-address.js";
import { type LlmContextSnapshot, type LlmSnapshotFact } from "./llm-snapshot-repository.js";
import {
  LlmConversationEventConflictError,
  type AppendLlmConversationEventInput,
  type LlmConversationEvent,
  type LlmConversationEventKind,
  type LlmConversationProjectionMetadata,
  type LlmProjectionSelector,
  type LlmProjectionVisibility,
  type LlmProjectableEventBody,
  type LlmThreadProjectionInput,
} from "./llm-conversation-repository-types.js";

export function eligibleSelector(
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

export function eligibleSnapshotFacts(
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

export function projectableBody(value: LlmJsonValue): LlmProjectableEventBody | null {
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

export function boundProjection<T extends { selector: LlmProjectionSelector; sequence: number }>(
  events: readonly T[],
  maxMessages: number,
): readonly T[] {
  if (events.length <= maxMessages) return events;
  const currentContract = events.findLast(({ selector }) => selector.kind === "role-contract");
  if (!currentContract) return events.slice(-maxMessages);
  const tail = events.filter((event) => event !== currentContract).slice(-(maxMessages - 1));
  return [...tail, currentContract].sort((left, right) => left.sequence - right.sequence);
}

export function topologicalRows(rows: readonly ThreadRow[]): readonly ThreadRow[] {
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

export function assertProjectionBounds(input: LlmThreadProjectionInput): void {
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

export function assertIdempotent(row: EventRow, input: NormalizedAppend): LlmConversationEvent {
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

export function eventRecord(row: EventRow): LlmConversationEvent {
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

export function asHash(value: string): `sha256:${string}` {
  assertLlmSha256(value, "persisted SHA-256 value");
  return value;
}

export function asKind(value: string): LlmConversationEventKind {
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

export type NormalizedAppend = AppendLlmConversationEventInput & {
  id: `sha256:${string}`;
  parentIds: readonly string[];
  bodyJson: string;
  bodyHash: `sha256:${string}`;
  projection: LlmConversationProjectionMetadata | null;
};

export type EventRow = {
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

export type ThreadRow = EventRow & {
  event_body_ciphertext: Uint8Array | null;
  event_body_key_ref: string;
  ancestry_count: number;
  topology_parent_event_ids: string[];
};

export type AcceptedHeadSets = {
  outputs: ReadonlySet<string>;
  semanticNotes: ReadonlySet<string>;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
