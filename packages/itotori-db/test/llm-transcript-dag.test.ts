import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DatabaseContext } from "../src/connection.js";
import { conversationEventId, type LlmJsonValue } from "../src/llm-content-address.js";
import {
  ItotoriLlmAcceptedOutputRepository,
  LlmQuarantinedResponseError,
  type AcceptLlmOutputInput,
} from "../src/repositories/llm-accepted-output-repository.js";
import {
  ItotoriLlmConversationRepository,
  type LlmProjectableEventBody,
  type LlmProjectionSelector,
  type LlmProjectionVisibility,
} from "../src/repositories/llm-conversation-repository.js";
import type { LlmMemoCipher } from "../src/repositories/llm-call-memo-repository.js";
import {
  ItotoriLlmSnapshotRepository,
  contextSnapshot,
  localizationSnapshot,
  namespacedFactId,
  type LlmContextSnapshotInput,
  type LlmLocalizationSnapshot,
  type LlmLocalizationSnapshotInput,
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

  async destroyKey(keyRef: string): Promise<void> {
    this.#keys.delete(keyRef);
  }
}

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

  it("PROOF: snapshot facts ignore adversarial body visibility and require immutable membership", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const contentReads: string[] = [];
      const repository = new ItotoriLlmConversationRepository(context.pool, cipher, {
        requireContentRead: async ({ contentRef }) => {
          contentReads.push(contentRef);
        },
      });
      let head: string | null = null;
      const appendFact = async (factId: string, label: string) => {
        const event = await repository.append({
          parentIds: head ? [head] : [],
          kind: "input",
          snapshotKind: "localization",
          snapshotId: snapshots.localization.snapshotId,
          role: "application",
          body: projectable(
            {
              kind: "snapshot-fact",
              factId,
              visibility: visible({ kind: "route", routeId: "route:active" }, 0),
            },
            label,
          ),
          accepted: true,
          createdAt: nextTimestamp(),
        });
        head = event.id;
        return event;
      };

      const visibleFact = await appendFact(namespacedFactId("scene", "current"), "visible-fact");
      const beyondHorizon = await appendFact(
        namespacedFactId("scene", "future"),
        "mis-tagged-spoiler",
      );
      const otherRoute = await appendFact(
        namespacedFactId("scene", "other"),
        "mis-tagged-other-route",
      );
      const nonMember = await appendFact(
        namespacedFactId("scene", "not-in-snapshot"),
        "mis-tagged-non-member",
      );

      const projected = await repository.thread({
        ...projectionInput(snapshots.localization.snapshotId),
        headId: head!,
      });
      expect(projected.map(projectedLabel)).toEqual(["visible-fact"]);
      expect(projected[0]?.id).toBe(visibleFact.id);
      expect(projected[0]?.body.projection).toMatchObject({
        kind: "snapshot-fact",
        factId: namespacedFactId("scene", "current"),
        visibility: { fromPlayOrder: 2 },
      });
      expect(contentReads).not.toContain(beyondHorizon.id);
      expect(contentReads).not.toContain(otherRoute.id);
      expect(contentReads).not.toContain(nonMember.id);

      const isolatedNonMember = await repository.append({
        parentIds: [],
        kind: "input",
        snapshotKind: "localization",
        snapshotId: snapshots.localization.snapshotId,
        role: "application",
        body: projectable(
          {
            kind: "snapshot-fact",
            factId: namespacedFactId("scene", "also-not-in-snapshot"),
            visibility: visible({ kind: "route", routeId: "route:active" }, 0),
          },
          "isolated-mis-tagged-non-member",
        ),
        accepted: true,
        createdAt: nextTimestamp(),
      });
      await expect(
        repository.thread({
          ...projectionInput(snapshots.localization.snapshotId),
          headId: isolatedNonMember.id,
        }),
      ).resolves.toEqual([]);
      expect(contentReads).not.toContain(isolatedNonMember.id);
    } finally {
      await context.close();
    }
  });

  it("PROOF: snapshots are immutable content addresses and every committed input changes identity", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriLlmSnapshotRepository(context.pool);
      const base = contextInput();
      const original = contextSnapshot(base);
      expect(
        contextSnapshot({ ...base, sourceUnits: [...base.sourceUnits].reverse() }).snapshotId,
      ).toBe(original.snapshotId);
      expect(contextSnapshot({ ...base, facts: [...base.facts].reverse() }).snapshotId).toBe(
        original.snapshotId,
      );
      const mutations: readonly LlmContextSnapshotInput[] = [
        { ...base, sourceLanguage: "zh-Hans" },
        { ...base, decode: revision("decode:next") },
        {
          ...base,
          sourceUnits: base.sourceUnits.map((unit, index) =>
            index === 0 ? { ...unit, sourceHash: hash("source:changed") } : unit,
          ),
        },
        {
          ...base,
          facts: base.facts.map((fact, index) =>
            index === 0 ? { ...fact, playOrderIndex: fact.playOrderIndex + 1 } : fact,
          ),
        },
        {
          ...base,
          facts: base.facts.map((fact, index) =>
            index === 0
              ? { ...fact, routeScope: { kind: "route", routeId: "route:other" } as const }
              : fact,
          ),
        },
        { ...base, facts: base.facts.slice(1) },
        { ...base, structure: revision("structure:next") },
        { ...base, routeGraph: revision("route-graph:next") },
        { ...base, glossary: revision("glossary:next") },
        { ...base, style: revision("style:next") },
        { ...base, revealHorizon: { kind: "through-play-order", playOrderIndex: 6 } },
        { ...base, humanCorrections: revision("corrections:next") },
        {
          ...base,
          externalSources: revision("external-sources:next"),
          contextScope: "external-augmented",
        },
        { ...base, contextScope: "narrowed:scene:opening" },
      ];
      expect(
        new Set(mutations.map((mutation) => contextSnapshot(mutation).snapshotId)),
      ).not.toContain(original.snapshotId);
      expect(new Set(mutations.map((mutation) => contextSnapshot(mutation).snapshotId)).size).toBe(
        mutations.length,
      );

      const stored = await repository.putContext(base);
      expect((await repository.putContext(base)).snapshotId).toBe(stored.snapshotId);
      const localizationBase = localizationInput(stored.snapshotId);
      const localized = localizationSnapshot(localizationBase);
      const localizationMutations: readonly LlmLocalizationSnapshotInput[] = [
        { ...localizationBase, targetLocale: "fr-FR" },
        { ...localizationBase, localeBranchId: "branch:other" },
        {
          ...localizationBase,
          acceptedBibleHead: { headId: "bible:2", version: 2, contentHash: hash("bible:2") },
        },
        {
          ...localizationBase,
          acceptedTargetOutputHead: {
            headId: "target:2",
            version: 2,
            contentHash: hash("target:2"),
          },
        },
      ];
      expect(
        localizationMutations.every(
          (mutation) => localizationSnapshot(mutation).snapshotId !== localized.snapshotId,
        ),
      ).toBe(true);
      await repository.putLocalization(localizationBase);
      expect(namespacedFactId("unit", "1017", "0042")).toBe("unit:1017:0042");
      expect(namespacedFactId("output", "en-US", "unit-42", "v3")).toBe("output:en-US:unit-42:v3");
      await expect(
        context.pool.query(
          `update itotori_llm_context_snapshots set snapshot_identity = '{}'::jsonb where snapshot_id = $1`,
          [stored.snapshotId],
        ),
      ).rejects.toThrow(/immutable/u);
    } finally {
      await context.close();
    }
  });

  it("PROOF: per-unit CAS failure cannot roll back an accepted sibling", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new ProofCipher();
    try {
      const snapshots = await putSnapshots(context);
      const accepted = new ItotoriLlmAcceptedOutputRepository(context.pool, cipher);
      const acceptedMemo = hash("accepted-sibling-memo");
      await insertVerifiedMemo(context, acceptedMemo);
      const firstUnitCandidate = outputCandidate(
        snapshots.localization.snapshotId,
        acceptedMemo,
        "unit:first",
        1,
        null,
      );
      const firstUnit = await accepted.acceptAndAdvance(firstUnitCandidate);
      const failingSibling = outputCandidate(
        snapshots.localization.snapshotId,
        hash("missing-sibling-memo"),
        "unit:second",
        1,
        null,
      );

      await expect(accepted.acceptAndAdvance(failingSibling)).rejects.toBeInstanceOf(
        LlmQuarantinedResponseError,
      );
      await expect(accepted.readHead(headIdentity(firstUnitCandidate))).resolves.toEqual(firstUnit);
      await expect(accepted.readHead(headIdentity(failingSibling))).resolves.toBeNull();
      const heads = await context.pool.query<{ subject_id: string }>(
        `
          select subject_id from itotori_llm_cas_heads
          where head_namespace = 'accepted-output' and snapshot_id = $1
          order by subject_id
        `,
        [snapshots.localization.snapshotId],
      );
      expect(heads.rows).toEqual([{ subject_id: "unit:first" }]);
    } finally {
      await context.close();
    }
  });
});

function conversationRepository(context: DatabaseContext, cipher: LlmMemoCipher) {
  return new ItotoriLlmConversationRepository(context.pool, cipher, {
    requireContentRead: async () => undefined,
  });
}

async function putSnapshots(context: DatabaseContext) {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshotValue = await repository.putContext(contextInput());
  const localization = await repository.putLocalization(
    localizationInput(contextSnapshotValue.snapshotId),
  );
  return { context: contextSnapshotValue, localization };
}

function contextInput(): LlmContextSnapshotInput {
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

function localizationInput(contextSnapshotId: string): LlmLocalizationSnapshotInput {
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

function revision(revisionId: string) {
  return { revisionId, contentHash: hash(revisionId) };
}

function projectable(
  projection: LlmProjectionSelector,
  label: string,
): LlmProjectableEventBody & LlmJsonValue {
  return { projection, message: { label } } as LlmProjectableEventBody & LlmJsonValue;
}

function visible(
  routeScope: LlmProjectionVisibility["routeScope"] = {
    kind: "route",
    routeId: "route:active",
  },
  fromPlayOrder = 0,
) {
  return { routeScope, fromPlayOrder, throughPlayOrder: null };
}

async function appendLabel(
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

function projectionInput(snapshotId: string) {
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

function projectedLabel(event: { body: LlmProjectableEventBody }): string {
  const message = event.body.message as { label?: unknown };
  if (typeof message.label !== "string") throw new Error("projected proof message lacks a label");
  return message.label;
}

async function eventCount(context: DatabaseContext): Promise<number> {
  const result = await context.pool.query<{ count: number }>(
    "select count(*)::int as count from itotori_llm_conversation_events",
  );
  return result.rows[0]!.count;
}

async function insertVerifiedMemo(context: DatabaseContext, memoKey: string): Promise<void> {
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

function outputCandidate(
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

function headIdentity(candidate: AcceptLlmOutputInput) {
  return {
    snapshotId: candidate.snapshotId,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    stage: candidate.stage,
  };
}

async function insertSemanticNoteHead(context: DatabaseContext, snapshotId: string): Promise<void> {
  const contentHash = hash("wiki:current");
  await context.pool.query(
    `
      insert into itotori_llm_wiki_versions (
        wiki_version_id, wiki_kind, object_id, object_version,
        snapshot_kind, snapshot_id, object_kind,
        wiki_ciphertext, wiki_key_ref, wiki_content_hash, created_at, retention_deadline
      ) values (
        'wiki:current', 'source-object', 'semantic-note:current', 1,
        'context', $1, 'semantic-note',
        decode('04', 'hex'), 'proof/wiki', $2, now(), now() + interval '1 day'
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

let timestampOrdinal = 0;
function nextTimestamp(): string {
  timestampOrdinal += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, timestampOrdinal)).toISOString();
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
