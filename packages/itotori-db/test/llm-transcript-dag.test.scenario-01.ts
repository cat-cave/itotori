import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { conversationEventId } from "../src/llm-content-address.js";
import { ItotoriLlmAcceptedOutputRepository } from "../src/repositories/llm-accepted-output-repository.js";
import {
  ItotoriLlmConversationRepository,
  type LlmProjectionSelector,
} from "../src/repositories/llm-conversation-repository.js";
import type { LlmMemoCipher } from "../src/repositories/llm-call-memo-repository.js";
import {
  ItotoriLlmSnapshotRepository,
  namespacedFactId,
  type LlmLocalizationSnapshot,
} from "../src/repositories/llm-snapshot-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

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

import {
  conversationRepository,
  putSnapshots,
  localizationInput,
  projectable,
  visible,
  appendLabel,
  projectionInput,
  projectedLabel,
  eventCount,
  insertVerifiedMemo,
  outputCandidate,
  insertSemanticNoteHead,
  nextTimestamp,
  hash,
  compareCodeUnits,
} from "./llm-transcript-dag.test.shared-01.js";

postgresDescribe("immutable transcript DAG and checkpoints", () => {
  it("PROOF: derives event IDs from canonical content, inserts idempotently, and encrypts bodies", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = conversationRepository(context, cipher);
      const body = projectable(
        { kind: "source-batch", batchId: "batch:current", visibility: visible() },
        "PRIVATE_TRANSCRIPT_SENTINEL",
      );
      const input = {
        parentIds: [] as const,
        kind: "input" as const,
        snapshotKind: "localization" as const,
        snapshotId: snapshots.localization.snapshotId,
        role: "application",
        body,
        accepted: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      const first = await repository.append(input);
      const repeated = await repository.append({
        ...input,
        body: { message: body.message, projection: body.projection },
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      expect(repeated.id).toBe(first.id);
      expect(
        conversationEventId({
          parentIds: [],
          kind: "input",
          snapshotId: snapshots.localization.snapshotId,
          role: "application",
          body,
        }),
      ).toBe(first.id);
      expect(
        conversationEventId({
          parentIds: [],
          kind: "input",
          snapshotId: snapshots.localization.snapshotId,
          role: "application",
          body: projectable(
            { kind: "source-batch", batchId: "batch:current", visibility: visible() },
            "changed",
          ),
        }),
      ).not.toBe(first.id);

      const persisted = await context.pool.query<{
        count: number;
        event_body_ciphertext: Uint8Array;
      }>(
        `
          select count(*) over ()::int as count, event_body_ciphertext
          from itotori_llm_conversation_events where event_id = $1
        `,
        [first.id],
      );
      expect(persisted.rows[0]?.count).toBe(1);
      expect(
        Buffer.from(persisted.rows[0]!.event_body_ciphertext).includes(
          Buffer.from("PRIVATE_TRANSCRIPT_SENTINEL"),
        ),
      ).toBe(false);
      expect(
        await context.pool.query(
          `
            select 1 from itotori_llm_encrypted_column_registry
            where table_name = 'itotori_llm_conversation_events'
              and ciphertext_column = 'event_body_ciphertext'
          `,
        ),
      ).toHaveProperty("rowCount", 1);
      await expect(
        context.pool.query(
          "update itotori_llm_conversation_events set actor_role = 'human' where event_id = $1",
          [first.id],
        ),
      ).rejects.toThrow(/immutable/u);
    } finally {
      await context.close();
    }
  });

  it("PROOF: the database rejects a fabricated event ID unrelated to canonical content", async () => {
    const context = await isolatedMigratedContext();
    try {
      const snapshots = await putSnapshots(context);
      await expect(
        context.pool.query(
          `
            insert into itotori_llm_conversation_events (
              event_id, schema_version, parent_event_ids, event_kind, snapshot_kind,
              snapshot_id, actor_role, event_body_ciphertext, event_body_key_ref,
              event_body_content_hash, accepted, created_at, retention_deadline
            ) values (
              $1, 'itotori.conversation-event.v1', '{}', 'input', 'localization',
              $2, 'application', decode('01', 'hex'), 'proof/fabricated',
              $3, true, now(), now() + interval '1 day'
            )
          `,
          [hash("fabricated-event-id"), snapshots.localization.snapshotId, hash("real-body")],
        ),
      ).rejects.toThrow(/event ID does not match its canonical content/u);
    } finally {
      await context.close();
    }
  });

  it("PROOF: forks share immutable prefix IDs and joins append one canonical multi-parent event", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const repository = conversationRepository(context, cipher);
      const root = await appendLabel(repository, snapshots.localization, null, "root");
      const shared = await appendLabel(repository, snapshots.localization, root.id, "shared");
      const beforeFork = await eventCount(context);
      const leftFork = await repository.fork(shared.id);
      const rightFork = await repository.fork(shared.id);
      expect(leftFork).toBe(shared.id);
      expect(rightFork).toBe(shared.id);
      expect(await eventCount(context)).toBe(beforeFork);

      const left = await appendLabel(repository, snapshots.localization, leftFork, "left");
      const right = await appendLabel(repository, snapshots.localization, rightFork, "right");
      const projection = projectionInput(snapshots.localization.snapshotId);
      const leftIds = (await repository.thread({ ...projection, headId: left.id })).map(
        (event) => event.id,
      );
      const rightIds = (await repository.thread({ ...projection, headId: right.id })).map(
        (event) => event.id,
      );
      expect(leftIds.slice(0, 2)).toEqual([root.id, shared.id]);
      expect(rightIds.slice(0, 2)).toEqual([root.id, shared.id]);

      const artifact = projectable(
        { kind: "source-batch", batchId: "batch:current", visibility: visible() },
        "joined",
      );
      const joined = await repository.join({
        heads: [right.id, left.id],
        snapshotKind: "localization",
        snapshotId: snapshots.localization.snapshotId,
        role: "application",
        artifact,
        accepted: true,
        createdAt: "2026-01-01T00:10:00.000Z",
      });
      const repeated = await repository.join({
        heads: [left.id, right.id],
        snapshotKind: "localization",
        snapshotId: snapshots.localization.snapshotId,
        role: "application",
        artifact,
        accepted: true,
        createdAt: "2026-01-01T00:11:00.000Z",
      });
      expect(repeated.id).toBe(joined.id);
      const joinRows = await context.pool.query<{ parent_event_ids: string[] }>(
        "select parent_event_ids from itotori_llm_conversation_events where event_id = $1",
        [joined.id],
      );
      expect(joinRows.rows).toEqual([
        { parent_event_ids: [left.id, right.id].sort(compareCodeUnits) },
      ]);
      expect(await eventCount(context)).toBe(beforeFork + 3);
    } finally {
      await context.close();
    }
  });

  it("PROOF: bounded projection is mutation-sensitive to every forbidden input class", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const snapshotRepository = new ItotoriLlmSnapshotRepository(context.pool);
      const stale = await snapshotRepository.putLocalization({
        ...localizationInput(snapshots.context.snapshotId),
        targetLocale: "fr-FR",
      });
      const memoKey = hash("projection-memo");
      await insertVerifiedMemo(context, memoKey);
      const outputs = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const firstOutput = await outputs.acceptAndAdvance(
        outputCandidate(snapshots.localization.snapshotId, memoKey, "unit:alpha", 1, null),
      );
      const secondOutput = await outputs.acceptAndAdvance(
        outputCandidate(snapshots.localization.snapshotId, memoKey, "unit:alpha", 2, firstOutput),
      );
      await insertSemanticNoteHead(context, snapshots.context.snapshotId);

      const contentReads: string[] = [];
      const repository = new ItotoriLlmConversationRepository(context.pool, cipher, {
        requireContentRead: async ({ contentRef }) => {
          contentReads.push(contentRef);
        },
      });
      const contextFact = await repository.append({
        parentIds: [],
        kind: "input",
        snapshotKind: "context",
        snapshotId: snapshots.context.snapshotId,
        role: "application",
        body: projectable(
          {
            kind: "snapshot-fact",
            factId: namespacedFactId("scene", "current"),
            visibility: visible(),
          },
          "context-fact",
        ),
        accepted: true,
        createdAt: nextTimestamp(),
      });
      let head: string | null = contextFact.id;
      const append = async (
        label: string,
        projection: LlmProjectionSelector,
        options: { accepted?: boolean; snapshot?: LlmLocalizationSnapshot } = {},
      ) => {
        const event = await repository.append({
          parentIds: head ? [head] : [],
          kind: projection.kind === "role-contract" ? "instruction" : "input",
          snapshotKind: "localization",
          snapshotId: (options.snapshot ?? snapshots.localization).snapshotId,
          role: "application",
          body: projectable(projection, label),
          accepted: options.accepted ?? true,
          createdAt: nextTimestamp(),
        });
        head = event.id;
        return event.id;
      };

      await append("current-contract", {
        kind: "role-contract",
        contractVersion: "contract:current",
      });
      await append("old-contract", { kind: "role-contract", contractVersion: "contract:old" });
      await append("current-fact", {
        kind: "snapshot-fact",
        factId: namespacedFactId("unit", "alpha", "0001"),
        visibility: visible(),
      });
      await append("current-note", {
        kind: "semantic-note",
        artifactId: "wiki:current",
        visibility: visible(),
      });
      const supersededTargetId = await append("superseded-target", {
        kind: "accepted-target",
        outputId: firstOutput.outputId,
        visibility: visible(),
      });
      const currentTargetId = await append("current-target", {
        kind: "accepted-target",
        outputId: secondOutput.outputId,
        visibility: visible(),
      });
      const rejectedId = await append(
        "rejected",
        {
          kind: "source-batch",
          batchId: "batch:current",
          visibility: visible(),
        },
        { accepted: false },
      );
      const softDeletedId = await append("soft-deleted", {
        kind: "source-batch",
        batchId: "batch:current",
        visibility: visible(),
      });
      await context.pool.query(
        `
          update itotori_llm_conversation_events
          set event_body_ciphertext = null, deletion_state = 'deleted', deleted_at = now()
          where event_id = $1
        `,
        [softDeletedId],
      );
      const staleSnapshotId = await append(
        "stale-snapshot",
        {
          kind: "source-batch",
          batchId: "batch:current",
          visibility: visible(),
        },
        { snapshot: stale },
      );
      const unrelatedRouteId = await append("unrelated-route", {
        kind: "snapshot-fact",
        factId: namespacedFactId("scene", "other"),
        visibility: visible({ kind: "route", routeId: "route:other" }),
      });
      const spoilerId = await append("spoiler", {
        kind: "snapshot-fact",
        factId: namespacedFactId("scene", "future"),
        visibility: visible({ kind: "global" }, 6),
      });
      await append("unrelated-batch", {
        kind: "source-batch",
        batchId: "batch:other",
        visibility: visible(),
      });
      await append("other-model-reasoning", {
        kind: "tool-loop",
        loopId: "loop:active",
        modelId: "model:other",
        visibility: visible(),
      });
      await append("old-local-turn", { kind: "local-turn", visibility: visible() });
      await append("current-batch", {
        kind: "source-batch",
        batchId: "batch:current",
        visibility: visible(),
      });
      await append("active-tool-loop", {
        kind: "tool-loop",
        loopId: "loop:active",
        modelId: "model:current",
        visibility: visible(),
      });
      await append("recent-local-turn", { kind: "local-turn", visibility: visible() });

      const projected = await repository.thread({
        ...projectionInput(snapshots.localization.snapshotId),
        headId: head!,
        recentLocalTurnLimit: 1,
      });
      const labels = projected.map(projectedLabel);
      expect(labels).toEqual([
        "context-fact",
        "current-contract",
        "current-fact",
        "current-note",
        "current-target",
        "current-batch",
        "active-tool-loop",
        "recent-local-turn",
      ]);
      const mutationSentinels = [
        "old-contract",
        "superseded-target",
        "rejected",
        "soft-deleted",
        "stale-snapshot",
        "unrelated-route",
        "spoiler",
        "unrelated-batch",
        "other-model-reasoning",
        "old-local-turn",
      ];
      expect(labels.filter((label) => mutationSentinels.includes(label))).toEqual([]);
      expect(projected.length).toBeLessThanOrEqual(64);
      expect(
        contentReads.filter((eventId) =>
          [
            supersededTargetId,
            rejectedId,
            softDeletedId,
            staleSnapshotId,
            unrelatedRouteId,
            spoilerId,
          ].includes(eventId),
        ),
      ).toEqual([]);

      const ancestry = await context.pool.query<{ count: number }>(
        `
          with recursive ancestry as (
            select event_id, parent_event_ids from itotori_llm_conversation_events
            where event_id = $1
            union all
            select parent.event_id, parent.parent_event_ids
            from ancestry child
            cross join lateral unnest(child.parent_event_ids) parent_ref(event_id)
            join itotori_llm_conversation_events parent on parent.event_id = parent_ref.event_id
          ) select count(*)::int as count from ancestry
        `,
        [head],
      );
      expect(ancestry.rows[0]?.count).toBe(18);

      await context.pool.query(
        `
          update itotori_llm_call_memos
          set request_ciphertext = null, response_ciphertext = null, outcome_ciphertext = null,
              deletion_state = 'deleted', deleted_at = now()
          where memo_key = $1
        `,
        [memoKey],
      );
      contentReads.length = 0;
      const afterMemoDeletion = await repository.thread({
        ...projectionInput(snapshots.localization.snapshotId),
        headId: head!,
        recentLocalTurnLimit: 1,
      });
      expect(afterMemoDeletion.map(projectedLabel)).not.toContain("current-target");
      expect(contentReads).not.toContain(currentTargetId);
    } finally {
      await context.close();
    }
  });
});
