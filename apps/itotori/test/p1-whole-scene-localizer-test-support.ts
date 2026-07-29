import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import {
  FACT_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  LocalizedRenderingSchema,
  type DraftBatch,
  type UnitFact,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import type { LocalizerRuntimeBase } from "../src/roles/p1/index.js";
import { localizedRenderingExample } from "./contract-fixtures-core.js";

// The certified P1 draft profile — its name/version must match the P1 call spec.
export const DRAFT_PROFILE: MeasuredModelProfile = {
  name: "draft",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1",
};

export const CTX = `sha256:${"a".repeat(64)}` as const;
export const LOC = `sha256:${"b".repeat(64)}` as const;
export const SCHEMA = `sha256:${"c".repeat(64)}` as const;
export const REV_A = `sha256:${"d".repeat(64)}` as const;
export const REV_B = `sha256:${"e".repeat(64)}` as const;
export const BIBLE = ["rendering:1"] as const;

// ── an in-memory, offline memo store (no DB); the recorded transport path ─────
export class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attempts = new Map<string, number>();
  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash)
        throw new LlmMemoConflictError(input.memoKey);
      return { ...existing, memoHit: true };
    }
    const ordinal = (this.#attempts.get(input.memoKey) ?? 0) + 1;
    if (ordinal > 3) throw new LlmRetriesExhaustedError(input.memoKey);
    this.#attempts.set(input.memoKey, ordinal);
    const execution = await input.execute({ ordinal, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: ordinal,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

export function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(
    "",
  );
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function draftBatchResponse(batch: DraftBatch): Response {
  const id = "generation:p1";
  const base = {
    id,
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    object: "chat.completion.chunk",
  };
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: JSON.stringify(batch) },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] },
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 30,
        total_tokens: 70,
        cost: 0.0000025, // cost-audit-allow: synthetic recorded-transport usage for the offline proof, not a billed cost
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  ]);
}

export interface Captured {
  body: Record<string, unknown>;
}

export function recordedRuntime(
  responses: readonly Response[],
  captured: Captured[],
): LocalizerRuntimeBase {
  const queue = [...responses];
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
    },
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: DRAFT_PROFILE,
      admission: { scope: "test:p1", confirmedCostCapUsd: "10" },
      snapshots: {
        decodeRevisionHash: REV_A,
        glossaryRevisionHash: REV_B,
        styleRevisionHash: REV_A,
        acceptedOutputHeadHash: REV_B,
      },
    },
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      captured.push({ body: (await request.clone().json()) as Record<string, unknown> });
      const response = queue.shift();
      if (!response) throw new Error("unexpected extra provider request");
      return response;
    },
  };
}

// ── deterministic source-skeleton fixtures ───────────────────────────────────
export function pad(base: string, bytes: number): string {
  return base.length >= bytes ? base.slice(0, bytes) : base + "-".repeat(bytes - base.length);
}

export type Placeholder = {
  placeholderId: string;
  kind: "control-markup" | "variable" | "ruby";
  sourceText: string;
};

/** Un-mask a skeleton into its raw source surface — the canonical inverse the
 * source surface (required by the fact schema). */
export function unmask(skeleton: string, placeholders: readonly Placeholder[]): string {
  const byId = new Map(placeholders.map((p) => [p.placeholderId, p.sourceText]));
  return skeleton.replace(/\{\{([^{}]+)\}\}/gu, (_match, id: string) => byId.get(id) ?? _match);
}

/** A coherent decode source fact. `overridePlaceholders` lets a test build a
 * DELIBERATELY malformed manifest (one that disagrees with the skeleton). */
export function unitFact(
  index: number,
  options: {
    sceneId?: string;
    skeleton?: string;
    placeholders?: readonly Placeholder[];
    overridePlaceholders?: readonly Placeholder[];
  } = {},
): UnitFact {
  const sceneId = options.sceneId ?? "6010";
  const unitId = `unit:${sceneId}:${index}`;
  const skeleton = options.skeleton ?? pad(`s${index}`, 10);
  const placeholders = [...(options.placeholders ?? [])];
  const surface = unmask(skeleton, placeholders);
  const value = {
    kind: "unit" as const,
    unitId,
    bridgeUnitId: `bridge:${unitId}`,
    sceneId,
    playOrderIndex: index,
    sourceHash: sha256(surface),
    sourceSurface: surface,
    sourceSkeleton: skeleton,
    surfaceKind: "dialogue" as const,
    speaker: null,
    choiceContext: null,
    protectedPlaceholders: [...(options.overridePlaceholders ?? placeholders)],
    sourceAssetRef: "asset:seen",
    byteOffset: index * 100,
    byteLength: 40,
    rawByteHandle: `bridge:${unitId}`,
    routeScopes: [{ kind: "global" as const }],
  };
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    factId: unitId,
    snapshotId: CTX,
    hash: sha256(value),
    visibility: { routeScope: { kind: "global" }, fromPlayOrder: index, throughPlayOrder: null },
    source: "decode",
    value,
  };
}

export function draftFor(unit: UnitFact, uncertainty: string[] = ["none"]) {
  return {
    unitId: unit.value.unitId,
    sourceHash: unit.value.sourceHash,
    targetSkeleton: `EN>${unit.value.sourceSkeleton}`,
    evidenceIds: [`fact:${unit.value.unitId}`],
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
    uncertainty,
  };
}

export function wholeSceneBatch(
  sceneId: string,
  units: readonly UnitFact[],
  flags: Record<string, string[]> = {},
): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `draft:${sceneId}:whole`,
    scope: { kind: "whole-scene", sceneId, expectedUnitIds: units.map((u) => u.value.unitId) },
    drafts: units.map((u) => draftFor(u, flags[u.value.unitId] ?? ["none"])),
  } as DraftBatch;
}

export function chunkBatch(
  sceneId: string,
  all: readonly UnitFact[],
  coreIds: readonly string[],
  overlapIds: readonly string[],
  chunkIndex: number,
  chunkCount: number,
): DraftBatch {
  const byId = new Map(all.map((u) => [u.value.unitId, u]));
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `draft:${sceneId}:${chunkIndex}`,
    scope: {
      kind: "overlapping-chunk",
      sceneId,
      chunkIndex,
      chunkCount,
      coreUnitIds: [...coreIds],
      overlapUnitIds: [...overlapIds],
    },
    drafts: coreIds.map((id) => draftFor(byId.get(id)!)),
  } as DraftBatch;
}

export function installedBibleRendering(renderingId: string) {
  return LocalizedRenderingSchema.parse({
    ...localizedRenderingExample,
    renderingId,
    sourceObjectId: `source:${renderingId}`,
    provenance: {
      ...localizedRenderingExample.provenance,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
    },
  });
}

export function installedBibleForUnits(units: readonly UnitFact[]) {
  return units.map((unit) => ({
    unitId: unit.value.unitId,
    renderings: [installedBibleRendering(BIBLE[0])],
  }));
}

export const BASE = {
  bibleBasis: "wiki-first" as const,
  contextSnapshotId: CTX,
  localizationSnapshotId: LOC,
  schemaHash: SCHEMA,
  runMode: "test-dev" as const,
  contextScope: "whole-game" as const,
};
