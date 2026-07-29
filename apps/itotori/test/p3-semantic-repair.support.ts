import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  DEFECT_BUNDLE_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  type DefectBundle,
  type DraftBatch,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { realliveSjisPolicy } from "../src/gates/index.js";
import { specialistFor, toolsForRole } from "../src/roster/index.js";
import {
  assertBlindedGroundedFork,
  assertRepairPatchBatch,
  buildRepairCall,
  normalizeRepairRequest,
  repairSemanticDefects,
  REPAIR_MODE,
  RepairError,
  RepairFinalizeError,
  type RepairCandidateUnit,
  type RepairRequest,
  type RepairRuntimeBase,
} from "../src/roles/p3/index.js";

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

export const PARENT_BATCH = "draft:6010:whole";

export const BUNDLE_ID = "bundle:6010:1";

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
  const base = {
    id: "generation:p3",
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
): RepairRuntimeBase {
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
      admission: { scope: "test:p3", confirmedCostCapUsd: "10" },
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

export function candidate(
  index: number,
  placeholders: RepairCandidateUnit["protectedPlaceholders"] = [],
): RepairCandidateUnit {
  const skeleton = `s${index}`;
  return {
    unitId: `unit:6010:${index}`,
    sourceHash: sha256(skeleton),
    sourceSkeleton: skeleton,
    protectedPlaceholders: placeholders,
    currentTargetSkeleton: `MT>${skeleton}`,
  };
}

export function meaningDefect(unitId: string, defectId: string): DefectBundle["defects"][number] {
  return {
    origin: "reviewer",
    defectId,
    unitId,
    severity: "major",
    span: { spanId: `span:${defectId}`, surface: "target", text: "wrong referent" },
    evidenceIds: [`fact:${unitId}`],
    basisFactIds: [`fact:${unitId}`],
    repairConstraint: "restore the source's referent without adding honorifics",
    implicatedGates: [],
    implicatedReviewLanes: ["Q1"],
    category: "meaning",
    reviewId: `review:${defectId}`,
    reviewLane: "Q1",
  };
}

export function defectBundle(units: readonly string[]): DefectBundle {
  return {
    schemaVersion: DEFECT_BUNDLE_SCHEMA_VERSION,
    bundleId: BUNDLE_ID,
    localizationSnapshotId: LOC,
    draftBatchId: PARENT_BATCH,
    defects: units.map((unitId, i) => meaningDefect(unitId, `defect:${i}`)),
    factDominance: [],
    resolution: "repair",
  } as DefectBundle;
}

export function patchDraft(c: RepairCandidateUnit) {
  return {
    unitId: c.unitId,
    sourceHash: c.sourceHash,
    targetSkeleton: `EN>${c.sourceSkeleton}`,
    evidenceIds: [`fact:${c.unitId}`],
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [...BIBLE] },
    uncertainty: ["none"],
  };
}

export function repairPatchBatch(
  cands: readonly RepairCandidateUnit[],
  failedUnitIds: readonly string[],
): DraftBatch {
  return {
    schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
    localizationSnapshotId: LOC,
    batchId: `patch:${BUNDLE_ID}`,
    scope: {
      kind: "repair-patch",
      parentDraftBatchId: PARENT_BATCH,
      defectBundleId: BUNDLE_ID,
      repairMode: REPAIR_MODE,
      failedUnitIds: [...failedUnitIds],
    },
    drafts: cands.map(patchDraft),
  } as DraftBatch;
}

export function request(cands: readonly RepairCandidateUnit[]): RepairRequest {
  return {
    defectBundle: defectBundle(cands.map((c) => c.unitId)),
    candidateBatchId: PARENT_BATCH,
    candidates: cands,
    bibleRenderingIds: BIBLE,
    preDraftContext: {
      sourceFacts: cands.map((candidate) => ({
        unitId: candidate.unitId,
        sourceHash: candidate.sourceHash,
        sourceSkeleton: candidate.sourceSkeleton,
        protectedPlaceholders: candidate.protectedPlaceholders,
        surfaceKind: candidate.surfaceKind ?? null,
        choiceContext: candidate.choiceContext ?? null,
      })),
      wikiFacts: cands.map((candidate) => ({
        factId: `fact:${candidate.unitId}`,
        kind: "meaning-evidence",
        text: `Pinned meaning evidence for ${candidate.unitId}`,
      })),
      bible: BIBLE.map((renderingId) => ({
        renderingId,
        text: "Use neutral register for the heroine's dialogue.",
      })),
    },
    tripwires: ["do not add an honorific the source lacks"],
  };
}

export const OPTIONS = {
  contextSnapshotId: CTX,
  localizationSnapshotId: LOC,
  schemaHash: SCHEMA,
  runMode: "test-dev" as const,
  contextScope: "whole-game" as const,
  policy: realliveSjisPolicy,
};
