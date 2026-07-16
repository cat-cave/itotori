// The live content-addressed durability store — the REAL adapter behind the
// driver's `WorkflowArtifactStore` seam.
//
// Two distinct durability mechanisms meet here:
//
//   - The per-unit CAS accepted-output heads (`readUnitHead` / `finalizeUnit`) map
//     directly onto the real `ItotoriLlmAcceptedOutputRepository` — `readHead`
//     for the restart query (a `null` head is the "must produce" signal), and
//     `acceptAndAdvance` for the independent per-unit compare-and-swap finalize.
//     The finalize input the driver carries (identity + content hash + shippable)
//     is deliberately light, so the sealed target bytes and the VERIFIED physical
//     memo keys that produced them are resolved through an injected seam.
//
//   - The workflow-step memo (`runMemoizedStep` / `attemptLineage`) single-flights
//     one physical STEP (a whole scene draft, one review lane) and counts every
//     physical attempt. The LLM calls INSIDE a step are already durably memoized
//     by the dispatch runtime's `LlmCallMemoStore` single-flight and physical-
//     attempt ledger; this layer coalesces the step, records the step-level
//     lineage, and skips a completed step on restart via an injected durable cache.

import type { ItotoriLlmAcceptedOutputRepository, LlmAcceptedOutputHead } from "@itotori/db";
import {
  TransientStepError,
  type AttemptContext,
  type AttemptLineageEntry,
  type MemoStepResult,
  type UnitArtifactRef,
  type UnitStage,
  type WorkflowArtifactStore,
} from "../../workflow/index.js";

/** The CAS surface the store needs — the real repository satisfies it. */
export type AcceptedOutputCas = Pick<
  ItotoriLlmAcceptedOutputRepository,
  "readHead" | "acceptAndAdvance"
>;

/** The per-unit accepted-output payload the CAS finalize needs but the driver's
 * light finalize input does not carry: a stable output identity, the sealed
 * target bytes, and the VERIFIED physical memo keys that produced them. Production
 * resolves this from the unit's accepted draft plus its dispatch receipts; the
 * driver hands only identity + content hash + shippability. */
export interface AcceptedUnitOutput {
  readonly outputId: string;
  readonly semanticKey: string;
  readonly schemaVersion: string;
  readonly outputJson: string;
  readonly memoKeys: readonly string[];
  readonly sourceHash: string | null;
}

/** Resolve the full accepted-output payload for a unit finalize. The prior head
 * is supplied so the resolver can chain `supersedesOutputId` / version. */
export type FinalizeArtifactResolver = (input: {
  readonly unitId: string;
  readonly stage: UnitStage;
  readonly contentHash: `sha256:${string}`;
  readonly shippable: boolean;
  readonly priorHead: LlmAcceptedOutputHead | null;
}) => Promise<AcceptedUnitOutput> | AcceptedUnitOutput;

/** A durable cache for completed workflow-step values — restart skip. A `set`
 * makes a later `runMemoizedStep` of the same key a memo hit that never re-runs
 * `produce`. Production binds a durable table; a proof binds an in-memory map. */
export interface WorkflowStepCache {
  get(memoKey: string): Promise<string | undefined> | string | undefined;
  set(memoKey: string, valueJson: string): Promise<void> | void;
}

/** An in-memory step cache — the offline-proof default. */
export function inMemoryStepCache(): WorkflowStepCache {
  const values = new Map<string, string>();
  return {
    get: (memoKey) => values.get(memoKey),
    set: (memoKey, valueJson) => {
      values.set(memoKey, valueJson);
    },
  };
}

export interface LiveWorkflowArtifactStoreConfig {
  readonly accepted: AcceptedOutputCas;
  /** The run's localization snapshot id — the CAS head namespace scope. */
  readonly snapshotId: string;
  readonly resolveFinalizeArtifact: FinalizeArtifactResolver;
  /** Durable step cache; defaults to an in-memory (single-process) cache. */
  readonly stepCache?: WorkflowStepCache;
  /** Max physical attempts per step before a `TransientStepError` is fatal. */
  readonly maxStepAttempts?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_STEP_ATTEMPTS = 3;

class LiveWorkflowArtifactStore implements WorkflowArtifactStore {
  readonly #accepted: AcceptedOutputCas;
  readonly #snapshotId: string;
  readonly #resolveFinalizeArtifact: FinalizeArtifactResolver;
  readonly #stepCache: WorkflowStepCache;
  readonly #maxStepAttempts: number;
  readonly #now: () => Date;
  readonly #lineage: AttemptLineageEntry[] = [];
  readonly #inflight = new Map<string, Promise<MemoStepResult<unknown>>>();

  constructor(config: LiveWorkflowArtifactStoreConfig) {
    this.#accepted = config.accepted;
    this.#snapshotId = config.snapshotId;
    this.#resolveFinalizeArtifact = config.resolveFinalizeArtifact;
    this.#stepCache = config.stepCache ?? inMemoryStepCache();
    this.#maxStepAttempts = config.maxStepAttempts ?? DEFAULT_MAX_STEP_ATTEMPTS;
    this.#now = config.now ?? (() => new Date());
  }

  async readUnitHead(unitId: string, stage: UnitStage): Promise<UnitArtifactRef | null> {
    const head = await this.#accepted.readHead({
      snapshotId: this.#snapshotId,
      subjectType: "unit",
      subjectId: unitId,
      stage,
    });
    return head === null ? null : toRef(unitId, stage, head);
  }

  async finalizeUnit(input: {
    readonly unitId: string;
    readonly stage: UnitStage;
    readonly contentHash: `sha256:${string}`;
    readonly shippable: boolean;
  }): Promise<UnitArtifactRef> {
    const priorHead = await this.#accepted.readHead({
      snapshotId: this.#snapshotId,
      subjectType: "unit",
      subjectId: input.unitId,
      stage: input.stage,
    });
    const artifact = await this.#resolveFinalizeArtifact({ ...input, priorHead });
    const head = await this.#accepted.acceptAndAdvance({
      outputId: artifact.outputId,
      semanticKey: artifact.semanticKey,
      schemaVersion: artifact.schemaVersion,
      outputVersion: (priorHead?.version ?? 0) + 1,
      supersedesOutputId: priorHead?.outputId ?? null,
      parentOutputIds: priorHead ? [priorHead.outputId] : [],
      memoKeys: artifact.memoKeys,
      snapshotKind: "localization",
      snapshotId: this.#snapshotId,
      subjectType: "unit",
      subjectId: input.unitId,
      stage: input.stage,
      sourceHash: artifact.sourceHash,
      outputJson: artifact.outputJson,
      acceptedAt: this.#now().toISOString(),
      expectedHead: priorHead,
    });
    return toRef(input.unitId, input.stage, head);
  }

  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    const cached = await this.#stepCache.get(memoKey);
    if (cached !== undefined) {
      return { memoHit: true, value: JSON.parse(cached) as T };
    }
    const inflight = this.#inflight.get(memoKey);
    if (inflight) return (await inflight) as MemoStepResult<T>;
    const run = this.#produceWithAttempts(memoKey, produce);
    this.#inflight.set(memoKey, run as Promise<MemoStepResult<unknown>>);
    try {
      return await run;
    } finally {
      this.#inflight.delete(memoKey);
    }
  }

  attemptLineage(): readonly AttemptLineageEntry[] {
    return [...this.#lineage];
  }

  async #produceWithAttempts<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    let ordinal = 0;
    for (;;) {
      ordinal += 1;
      try {
        const value = await produce({ memoKey, ordinal });
        this.#lineage.push({ memoKey, ordinal, outcome: "completed" });
        await this.#stepCache.set(memoKey, JSON.stringify(value));
        return { memoHit: false, value };
      } catch (error: unknown) {
        if (error instanceof TransientStepError && ordinal < this.#maxStepAttempts) {
          // A counted retry — never silent; the next producer call carries the
          // next ordinal so the lineage records every physical attempt.
          this.#lineage.push({ memoKey, ordinal, outcome: "transient-retry" });
          continue;
        }
        this.#lineage.push({ memoKey, ordinal, outcome: "failed" });
        throw error;
      }
    }
  }
}

/** Build the live CAS/memo/attempt-ledger-backed workflow artifact store. */
export function createLiveWorkflowArtifactStore(
  config: LiveWorkflowArtifactStoreConfig,
): WorkflowArtifactStore {
  return new LiveWorkflowArtifactStore(config);
}

function toRef(unitId: string, stage: UnitStage, head: LlmAcceptedOutputHead): UnitArtifactRef {
  return {
    unitId,
    stage,
    contentHash: assertSha256(head.contentHash),
    version: head.version,
  };
}

function assertSha256(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`accepted-output head content hash is not a SHA-256 hash: ${value}`);
  }
  return value as `sha256:${string}`;
}
