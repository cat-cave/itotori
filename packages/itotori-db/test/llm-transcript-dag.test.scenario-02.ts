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

  async releaseKeyReference(keyRef: string): Promise<void> {
    this.#keys.delete(keyRef);
  }
}

import {
  conversationRepository,
  putSnapshots,
  contextInput,
  localizationInput,
  revision,
  projectable,
  visible,
  appendLabel,
  projectionInput,
  projectedLabel,
  eventCount,
  insertVerifiedMemo,
  outputCandidate,
  headIdentity,
  insertSemanticNoteHead,
  timestampOrdinal,
  nextTimestamp,
  hash,
  compareCodeUnits,
} from "./llm-transcript-dag.test.shared-01.js";

postgresDescribe("immutable transcript DAG and checkpoints", () => {
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
