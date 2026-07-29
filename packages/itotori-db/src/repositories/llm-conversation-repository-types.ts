import type { LlmJsonValue } from "../llm-content-address.js";

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

