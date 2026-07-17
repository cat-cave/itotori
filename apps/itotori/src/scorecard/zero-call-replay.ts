// Zero-call deterministic replay — re-derive finalized outputs from the
// persisted accepted-output CAS heads and memoized physical steps with NO
// model dispatch.
//
// Ports abstract the durable repositories (`@itotori/db` accepted-output CAS
// + physical-step memo). Production adapters read live store rows; fixture
// proofs populate an in-memory store. Neither path accepts a dispatch /
// provider client, so the wire-request count is structurally zero.
//
// For each CAS head the replay:
//   1. resolves every source memo key as a verified memo hit,
//   2. re-hashes the persisted finalized output body,
//   3. requires that hash to equal the CAS head content hash.
//
// A real terminal-run scorecard over live RB provider receipts is a
// downstream live-lane input — see `LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP`.

import { createHash } from "node:crypto";
import { LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP } from "./strict-from-lineage.js";

export const ZERO_CALL_REPLAY_SCHEMA_VERSION = "itotori.zero-call-replay-result.v1" as const;

/** One accepted-output CAS head as persisted by the durable store. */
export type AcceptedOutputCasHead = {
  readonly outputId: string;
  readonly version: number;
  /** Content hash of `outputJson` at accept time (`sha256:<hex>`). */
  readonly contentHash: string;
  readonly memoKeys: readonly string[];
  /** Finalized accepted-output body (ciphertext is opened by the store adapter). */
  readonly outputJson: string;
};

/**
 * A memoized physical step required by an accepted output. Only verification
 * identity is required for the zero-call proof — the body is not re-dispatched.
 */
export type MemoizedPhysicalStep = {
  readonly memoKey: string;
  readonly verificationStatus: "verified";
  readonly generationId: string;
};

/**
 * Read-only ports over the accepted-output CAS and physical-step memo.
 * Implementations must not perform model dispatch; fixture stores are pure maps.
 */
export type ZeroCallReplayStore = {
  listAcceptedHeads(): readonly AcceptedOutputCasHead[] | Promise<readonly AcceptedOutputCasHead[]>;
  getMemo(memoKey: string): MemoizedPhysicalStep | null | Promise<MemoizedPhysicalStep | null>;
};

export type ZeroCallReplayedOutput = {
  readonly outputId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly matchesCasHead: boolean;
  readonly memoKeysResolved: boolean;
  readonly memoHitCount: number;
};

export type ZeroCallReplayResult = {
  readonly schemaVersion: typeof ZERO_CALL_REPLAY_SCHEMA_VERSION;
  /** Structurally zero: this path has no model-dispatch port. */
  readonly wireRequestCount: 0;
  /** Structurally zero: every step is served from the memo store. */
  readonly newPhysicalAttempts: 0;
  readonly outputs: readonly ZeroCallReplayedOutput[];
  readonly allHashMatched: boolean;
  readonly allMemosResolved: boolean;
  readonly acceptedOutputsHash: string;
  /** The scorecard over a real terminal run is a live-lane follow-up. */
  readonly liveTerminalRunScorecard: typeof LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP;
};

/** Deterministic in-memory CAS + memo store for offline fixture proofs. */
export class InMemoryZeroCallReplayStore implements ZeroCallReplayStore {
  readonly #heads: AcceptedOutputCasHead[] = [];
  readonly #memos = new Map<string, MemoizedPhysicalStep>();

  putHead(head: AcceptedOutputCasHead): void {
    assertHash(head.contentHash, "accepted-output content hash");
    for (const memoKey of head.memoKeys) assertHash(memoKey, "accepted-output memo key");
    if (head.memoKeys.length === 0 || new Set(head.memoKeys).size !== head.memoKeys.length) {
      throw new Error("accepted-output head requires unique source memo keys");
    }
    const contentHash = hashOutputJson(head.outputJson);
    if (contentHash !== head.contentHash) {
      throw new Error("accepted-output head content hash does not match its body");
    }
    this.#heads.push({
      outputId: head.outputId,
      version: head.version,
      contentHash: head.contentHash,
      memoKeys: [...head.memoKeys],
      outputJson: head.outputJson,
    });
  }

  putMemo(memo: MemoizedPhysicalStep): void {
    assertHash(memo.memoKey, "memo key");
    if (memo.verificationStatus !== "verified") {
      throw new Error("zero-call memo must be verified");
    }
    if (this.#memos.has(memo.memoKey)) {
      throw new Error(`memo already present for ${memo.memoKey}`);
    }
    this.#memos.set(memo.memoKey, memo);
  }

  listAcceptedHeads(): readonly AcceptedOutputCasHead[] {
    return this.#heads.map((head) => ({
      ...head,
      memoKeys: [...head.memoKeys],
    }));
  }

  getMemo(memoKey: string): MemoizedPhysicalStep | null {
    return this.#memos.get(memoKey) ?? null;
  }
}

/**
 * Re-derive finalized outputs from persisted CAS heads + memoized physical
 * steps. Never dispatches a model: the wire-request count is always 0 and
 * every physical step is a memo hit.
 */
export async function replayZeroCallFromPersisted(
  store: ZeroCallReplayStore,
): Promise<ZeroCallReplayResult> {
  const heads = [...(await store.listAcceptedHeads())];
  heads.sort((left, right) => {
    const byId = left.outputId.localeCompare(right.outputId);
    return byId !== 0 ? byId : left.version - right.version;
  });

  const outputs: ZeroCallReplayedOutput[] = [];
  for (const head of heads) {
    let memoKeysResolved = head.memoKeys.length > 0;
    let memoHitCount = 0;
    for (const memoKey of head.memoKeys) {
      const memo = await store.getMemo(memoKey);
      if (
        memo === null ||
        memo.verificationStatus !== "verified" ||
        memo.generationId.length === 0
      ) {
        memoKeysResolved = false;
        continue;
      }
      memoHitCount += 1;
    }
    if (memoHitCount !== head.memoKeys.length) memoKeysResolved = false;

    const contentHash = hashOutputJson(head.outputJson);
    outputs.push({
      outputId: head.outputId,
      version: head.version,
      contentHash,
      matchesCasHead: contentHash === head.contentHash,
      memoKeysResolved,
      memoHitCount,
    });
  }

  const allHashMatched = outputs.every((output) => output.matchesCasHead);
  const allMemosResolved = outputs.every((output) => output.memoKeysResolved);
  const acceptedOutputsHash = hashOutputJson(
    JSON.stringify(outputs.map((output) => ({ id: output.outputId, hash: output.contentHash }))),
  );

  return {
    schemaVersion: ZERO_CALL_REPLAY_SCHEMA_VERSION,
    wireRequestCount: 0,
    newPhysicalAttempts: 0,
    outputs,
    allHashMatched,
    allMemosResolved,
    acceptedOutputsHash,
    liveTerminalRunScorecard: LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP,
  };
}

/** Content-address an accepted-output body the same way the durable CAS does. */
export function hashOutputJson(outputJson: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(outputJson).digest("hex")}`;
}

function assertHash(value: string, label: string): void {
  // Durable CAS form only (`sha256:<hex>`); bare 64-hex without the prefix is rejected.
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
}
