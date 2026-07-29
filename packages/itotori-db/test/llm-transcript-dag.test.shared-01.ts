import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe } from "vitest";
import type { DatabaseContext } from "../src/connection.js";
import { type LlmJsonValue } from "../src/llm-content-address.js";
import { type AcceptLlmOutputInput } from "../src/repositories/llm-accepted-output-repository.js";
import {
  ItotoriLlmConversationRepository,
  type LlmProjectableEventBody,
  type LlmProjectionSelector,
  type LlmProjectionVisibility,
} from "../src/repositories/llm-conversation-repository.js";
import type { LlmMemoCipher } from "../src/repositories/llm-call-memo-repository.js";
import {
  ItotoriLlmSnapshotRepository,
  namespacedFactId,
  type LlmContextSnapshotInput,
  type LlmLocalizationSnapshot,
  type LlmLocalizationSnapshotInput,
} from "../src/repositories/llm-snapshot-repository.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

class ProofCipher implements LlmMemoCipher {
  readonly #keys = new Map<string, Buffer>();
  #ordinal = 0;

  async seal(plaintext: string): Promise<{ ciphertext: Uint8Array; keyRef: string }> {
    const key = randomBytes(32);
    const keyRef = `transcript-proof-key:${(this.#ordinal += 1)}`;
    this.#keys.set(keyRef, key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), keyRef };
  }

  async open(ciphertext: Uint8Array, keyRef: string): Promise<string> {
    const key = this.#keys.get(keyRef);
    if (!key) throw new Error("proof envelope key does not exist");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  async releaseKeyReference(keyRef: string): Promise<void> {
    this.#keys.delete(keyRef);
  }
}

export function conversationRepository(context: DatabaseContext, cipher: LlmMemoCipher) {
  return new ItotoriLlmConversationRepository(context.pool, cipher, {
    requireContentRead: async () => undefined,
  });
}

export async function putSnapshots(context: DatabaseContext) {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshotValue = await repository.putContext(contextInput());
  const localization = await repository.putLocalization(
    localizationInput(contextSnapshotValue.snapshotId),
  );
  return { context: contextSnapshotValue, localization };
}

export function contextInput(): LlmContextSnapshotInput {
  return {
    sourceLanguage: "ja-JP",
    decode: revision("decode:current"),
    sourceUnits: [
      { unitId: "unit:alpha", sourceHash: hash("source:alpha") },
      { unitId: "unit:beta", sourceHash: hash("source:beta") },
    ],
    facts: [
      {
        factId: namespacedFactId("scene", "current"),
        playOrderIndex: 2,
        routeScope: { kind: "route", routeId: "route:active" },
      },
      {
        factId: namespacedFactId("unit", "alpha", "0001"),
        playOrderIndex: 3,
        routeScope: { kind: "route", routeId: "route:active" },
      },
      {
        factId: namespacedFactId("scene", "other"),
        playOrderIndex: 4,
        routeScope: { kind: "route", routeId: "route:other" },
      },
      {
        factId: namespacedFactId("scene", "future"),
        playOrderIndex: 6,
        routeScope: { kind: "route", routeId: "route:active" },
      },
    ],
    structure: revision("structure:current"),
    routeGraph: revision("route-graph:current"),
    glossary: revision("glossary:current"),
    style: revision("style:current"),
    revealHorizon: { kind: "through-play-order", playOrderIndex: 5 },
    humanCorrections: revision("corrections:current"),
    externalSources: null,
    contextScope: "whole-game",
  };
}

export function localizationInput(contextSnapshotId: string): LlmLocalizationSnapshotInput {
  return {
    contextSnapshotId,
    targetLocale: "en-US",
    localeBranchId: "branch:primary",
    acceptedBibleHead: { headId: "bible:1", version: 1, contentHash: hash("bible:1") },
    acceptedTargetOutputHead: {
      headId: "target:1",
      version: 1,
      contentHash: hash("target:1"),
    },
  };
}

export function revision(revisionId: string) {
  return { revisionId, contentHash: hash(revisionId) };
}

export function projectable(
  projection: LlmProjectionSelector,
  label: string,
): LlmProjectableEventBody & LlmJsonValue {
  return { projection, message: { label } } as LlmProjectableEventBody & LlmJsonValue;
}

export function visible(
  routeScope: LlmProjectionVisibility["routeScope"] = {
    kind: "route",
    routeId: "route:active",
  },
  fromPlayOrder = 0,
) {
  return { routeScope, fromPlayOrder, throughPlayOrder: null };
}

export async function appendLabel(
  repository: ItotoriLlmConversationRepository,
  snapshot: LlmLocalizationSnapshot,
  parentId: string | null,
  label: string,
) {
  return repository.append({
    parentIds: parentId ? [parentId] : [],
    kind: "input",
    snapshotKind: "localization",
    snapshotId: snapshot.snapshotId,
    role: "application",
    body: projectable(
      { kind: "source-batch", batchId: "batch:current", visibility: visible() },
      label,
    ),
    accepted: true,
    createdAt: nextTimestamp(),
  });
}

export function projectionInput(snapshotId: string) {
  return {
    headId: hash("placeholder-head"),
    snapshotId,
    activeRouteId: "route:active",
    roleContractVersion: "contract:current",
    activeSourceBatchId: "batch:current",
    activeToolLoop: { loopId: "loop:active", modelId: "model:current" },
    recentLocalTurnLimit: 2,
    maxMessages: 64,
  } as const;
}

export function projectedLabel(event: { body: LlmProjectableEventBody }): string {
  const message = event.body.message as { label?: unknown };
  if (typeof message.label !== "string") throw new Error("projected proof message lacks a label");
  return message.label;
}

export async function eventCount(context: DatabaseContext): Promise<number> {
  const result = await context.pool.query<{ count: number }>(
    "select count(*)::int as count from itotori_llm_conversation_events",
  );
  return result.rows[0]!.count;
}

export async function insertVerifiedMemo(context: DatabaseContext, memoKey: string): Promise<void> {
  await context.pool.query(
    `
      insert into itotori_llm_call_memos (
        memo_key, semantic_hash, schema_version,
        request_ciphertext, request_key_ref, request_content_hash,
        response_ciphertext, response_key_ref, response_content_hash,
        outcome_ciphertext, outcome_key_ref, outcome_content_hash,
        outcome_kind, verification_status, generation_id, requested_model,
        provider_policy, served_model, served_provider, served_pair_status,
        prompt_token_count, completion_token_count, reasoning_token_count, cached_token_count,
        billing_state, cost_usd, completed_at, retention_deadline
      ) values (
        $1, $2, 'itotori.physical-step-memo.v2',
        decode('01', 'hex'), 'proof/request', $3,
        decode('02', 'hex'), 'proof/response', $4,
        decode('03', 'hex'), 'proof/outcome', $5,
        'terminal', 'verified', $6, 'model:requested', '{}'::jsonb,
        'model:served', 'provider:served', 'confirmed', 1, 1, 0, 0,
        'confirmed', 0, now(), now() + interval '1 day'
      )
    `,
    [
      memoKey,
      hash(`semantic:${memoKey}`),
      hash(`request:${memoKey}`),
      hash(`response:${memoKey}`),
      hash(`outcome:${memoKey}`),
      `generation:${memoKey.slice(-12)}`,
    ],
  );
}

export function outputCandidate(
  snapshotId: string,
  memoKey: string,
  subjectId: string,
  version: number,
  expectedHead: { outputId: string; version: number; contentHash: string } | null,
): AcceptLlmOutputInput {
  const outputId = `${subjectId}:v${version}`;
  return {
    outputId,
    semanticKey: hash(`semantic:${outputId}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: version,
    supersedesOutputId: expectedHead?.outputId ?? null,
    parentOutputIds: expectedHead ? [expectedHead.outputId] : [],
    memoKeys: [memoKey],
    snapshotKind: "localization",
    snapshotId,
    subjectType: "unit",
    subjectId,
    stage: "final",
    sourceHash: hash(`source:${subjectId}`),
    outputJson: JSON.stringify({ outputId, target: `target:${version}` }),
    acceptedAt: `2026-01-01T00:${version.toString().padStart(2, "0")}:00.000Z`,
    expectedHead,
  };
}

export function headIdentity(candidate: AcceptLlmOutputInput) {
  return {
    snapshotId: candidate.snapshotId,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    stage: candidate.stage,
  };
}

export async function insertSemanticNoteHead(
  context: DatabaseContext,
  snapshotId: string,
): Promise<void> {
  const contentHash = hash("wiki:current");
  await context.pool.query(
    `
      insert into itotori_llm_wiki_versions (
        wiki_version_id, wiki_kind, object_id, object_version,
        snapshot_kind, snapshot_id, object_kind,
        wiki_ciphertext, wiki_key_ref, wiki_content_hash, created_at, retention_deadline,
        object_language, subject_kind, subject_id, scope_kind, provisional,
        context_scope, run_mode
      ) values (
        'wiki:current', 'source-object', 'semantic-note:current', 1,
        'context', $1, 'scene-summary',
        decode('04', 'hex'), 'proof/wiki', $2, now(), now() + interval '1 day',
        'ja-JP', 'scene', 'scene:current', 'global', false,
        'whole-game', 'production'
      )
    `,
    [snapshotId, contentHash],
  );
  await context.pool.query(
    `
      insert into itotori_llm_cas_heads (
        head_namespace, snapshot_id, subject_type, subject_id, head_stage,
        head_id, head_version, head_content_hash, updated_at
      ) values (
        'wiki-version', $1, 'wiki-object', 'semantic-note:current', 'source-wiki',
        'wiki:current', 1, $2, now()
      )
    `,
    [snapshotId, contentHash],
  );
}

export let timestampOrdinal = 0;

export function nextTimestamp(): string {
  timestampOrdinal += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, timestampOrdinal)).toISOString();
}

export function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
