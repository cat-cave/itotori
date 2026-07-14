import {
  CALL_RESULT_SCHEMA_VERSION,
  CALL_SPEC_SCHEMA_VERSION,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  CONVERSATION_EVENT_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
} from "../src/contracts/index.js";
import {
  H1,
  H2,
  H3,
  H4,
  NOW,
  acceptedOutputExample,
  contextSnapshotExample,
  draftBatchExample,
  encrypted,
  localizationSnapshotExample,
} from "./contract-fixtures-core.js";

const providerPolicy = {
  order: ["provider:primary"],
  only: ["provider:primary"],
  allowFallbacks: false,
  zdr: true,
  dataCollection: "deny",
  requireParameters: true,
} as const;

const terminalSchema = {
  name: "draft-batch",
  schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
  schemaHash: H4,
} as const;

const limits = {
  maxSteps: 4,
  maxToolCalls: 8,
  maxParallelTools: 4,
  maxOutputTokens: 4096,
  timeoutClass: "normal",
} as const;

export const callSpecExample = {
  schemaVersion: CALL_SPEC_SCHEMA_VERSION,
  purpose: "draft",
  roleId: "P1",
  modelProfile: "draft",
  modelProfileVersion: "profile:v1",
  requestedModel: "deepseek-v4-flash",
  providerPolicy,
  parentEventId: H1,
  contextSnapshotId: contextSnapshotExample.snapshotId,
  localizationSnapshotId: localizationSnapshotExample.snapshotId,
  messages: [{ kind: "text", eventId: H1, role: "user", contentEncrypted: encrypted }],
  tools: [],
  output: terminalSchema,
  promptVersion: "prompt:v1",
  reasoning: { effort: "medium" },
  sampling: { temperature: 0.2, topP: 0.9, seed: null },
  limits,
  sampleId: null,
  runMode: "production",
  contextScope: "whole-game",
} as const;

export const callResultExample = {
  schemaVersion: CALL_RESULT_SCHEMA_VERSION,
  memoKey: H1,
  requested: { model: "deepseek-v4-flash", providerOrder: ["provider:primary"] },
  memoHit: false,
  status: "success",
  value: draftBatchExample,
  responseEventId: H2,
  served: { model: "deepseek-v4-flash", provider: "provider:primary" },
  generationId: "generation:1",
  verification: "verified",
  usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
  billing: { status: "confirmed", costUsd: "0.001" },
} as const;

export const memoKeyExample = {
  schemaVersion: PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION,
  memoKey: H1,
  semanticHash: H2,
  semantic: {
    substrate: { name: "tanstack-ai", version: "0.28.0", openRouterAdapterVersion: "0.15.8" },
    purpose: "draft",
    roleId: "P1",
    modelProfile: "draft",
    modelProfileVersion: "profile:v1",
    requestedModel: "deepseek-v4-flash",
    providerPolicy,
    parentEventHash: H1,
    projectedMessages: [{ eventId: H1, eventHash: H1 }],
    promptVersion: "prompt:v1",
    tools: [],
    orderedToolResultHashes: [],
    terminalSchema,
    reasoning: { effort: "medium" },
    sampling: { temperature: 0.2, topP: 0.9, seed: null },
    limits,
    snapshots: {
      contextSnapshotId: contextSnapshotExample.snapshotId,
      contextSnapshotSchemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
      localizationSnapshotId: localizationSnapshotExample.snapshotId,
      localizationSnapshotSchemaVersion: LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
      decodeRevisionHash: H1,
      glossaryRevisionHash: H2,
      styleRevisionHash: H3,
      acceptedOutputHeadHash: H4,
    },
    sampleId: null,
  },
} as const;

export const memoValueExample = {
  schemaVersion: PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
  memoKey: H1,
  requestEncrypted: encrypted,
  responseEncrypted: { ...encrypted, storageRef: "encrypted:response:1", contentHash: H2 },
  outcome: { kind: "terminal", output: draftBatchExample },
  verification: {
    status: "verified",
    generationId: "generation:1",
    served: { model: "deepseek-v4-flash", provider: "provider:primary" },
  },
  requestedModel: "deepseek-v4-flash",
  providerPolicy,
  routerAttempts: [
    {
      ordinal: 1,
      provider: "provider:primary",
      startedAt: NOW,
      completedAt: NOW,
      httpStatus: 200,
      generationId: "generation:1",
      billing: { status: "confirmed", costUsd: "0.001" },
    },
  ],
  usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
  billing: { status: "confirmed", costUsd: "0.001" },
  completedAt: NOW,
} as const;

export const memoExample = {
  schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
  key: memoKeyExample,
  value: memoValueExample,
} as const;

export const conversationEventExample = {
  schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
  eventId: H3,
  parentEventIds: [H1],
  kind: "artifact",
  snapshot: { kind: "localization", snapshotId: localizationSnapshotExample.snapshotId },
  role: "application",
  body: {
    kind: "artifact",
    artifactType: "accepted-output",
    artifactId: acceptedOutputExample.outputId,
    artifactHash: H4,
  },
  bodyEncrypted: encrypted,
  memoKey: H1,
  accepted: true,
  createdAt: NOW,
} as const;
