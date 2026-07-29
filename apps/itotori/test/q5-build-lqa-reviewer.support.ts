import { describe, expect, it } from "vitest";
import {
  RENDER_AND_OCR_RESULT_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type RenderAndOcrResult,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  Q5DecodedObservationError,
  Q5_ONSCREEN_CATEGORIES,
  Q5RouteError,
  assertCertifiedBuildLqaRoute,
  assertBuildLqaOnlyToolGrant,
  buildQ5CallSpec,
  canFinalize,
  deterministicFaults,
  frameHasBlockingFault,
  gateForFaultKind,
  interpretQ5Verdict,
  parseQ5ReviewInput,
  q5BuildLqaToolGrant,
  q5FrameFromRenderResult,
  q5SystemPrompt,
  q5UserPrompt,
  Q5_PROMPT_VERSION,
  runQ5Review,
  type EvidenceResolver,
  type Q5DispatchRefs,
  type Q5RenderFrame,
  type Q5ReviewInput,
} from "../src/roles/q5/index.js";

export const SNAP = `sha256:${"a".repeat(64)}` as const;

export const HASH = `sha256:${"b".repeat(64)}` as const;

export const BYTES = `sha256:${"c".repeat(64)}` as const;

export const cleanFrame: Q5RenderFrame = {
  frameId: "frame:1",
  artifactUri: "https://frames.example/frame-1.png",
  patchedBytesHash: BYTES,
  contentHash: HASH,
  expectedAcceptedOutputId: "accepted:1",
  observedUnitIds: ["unit:1"],
  width: 640,
  height: 480,
  ocrText: "He was waiting at the station.",
  observations: [
    {
      observationId: "obs:1",
      kind: "layout",
      status: "PASS",
      unitId: "unit:1",
      detail: "fits box",
    },
  ],
};

export const baseInput: Q5ReviewInput = {
  unitId: "unit:1",
  localizationSnapshotId: SNAP,
  frame: cleanFrame,
  expectedTarget: "He was waiting at the station.",
  bibleRenderingIds: ["rendering:1"],
  localizedBible: [
    { renderingId: "rendering:1", text: "Use clear, neutral past-tense narration." },
  ],
};

export const allVisible: EvidenceResolver = () => ({ resolved: true, visible: true });

export function countingDispatch(value: Record<string, unknown>): {
  readonly dispatch: (spec: CallSpec) => Promise<CallResult>;
  calls: () => number;
} {
  let calls = 0;
  const inner = recordedDispatch(value);
  return {
    dispatch: async (spec) => {
      calls += 1;
      return inner(spec);
    },
    calls: () => calls,
  };
}

export function faultedFrame(kind: Q5RenderFrame["observations"][number]["kind"]): Q5RenderFrame {
  return {
    ...cleanFrame,
    observations: [
      { observationId: "obs:f", kind, status: "FAIL", unitId: "unit:1", detail: `${kind} fault` },
    ],
  };
}

export function passVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q5",
    rubric: "build-lqa",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["frame:1", "accepted:1"],
    repairConstraint: null,
    ...overrides,
  };
}

export function failVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q5",
    rubric: "build-lqa",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "statoin" },
    category: "onscreen-language",
    evidenceIds: ["frame:1", "accepted:1"],
    repairConstraint: "Fix the on-screen spelling to match the accepted target.",
    ...overrides,
  };
}

export function cannotAssessVerdict(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q5",
    rubric: "build-lqa",
    unitId: "unit:1",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: ["frame:1", "accepted:1"],
    repairConstraint: null,
    requestedEvidence: ["Need a re-render at a legible scale."],
    ...overrides,
  };
}

export const refs: Q5DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q5:${plaintext.length}`,
    contentHash: HASH,
    encryption: "operator-managed",
  }),
};

export function recordedDispatch(
  value: Record<string, unknown>,
): (spec: CallSpec) => Promise<CallResult> {
  return async () =>
    ({
      schemaVersion: "itotori.call-result.v2",
      memoKey: HASH,
      requested: { model: "deepseek/deepseek-v4-flash" },
      memoHit: true,
      status: "success",
      value,
      responseEventId: HASH,
      served: { status: "confirmed", model: "deepseek/deepseek-v4-flash", provider: "provider:x" },
      generationId: "generation:1",
      verification: "verified",
      usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, cachedTokens: 0 },
      billing: { status: "confirmed", costUsd: "0.001" },
      events: [{ kind: "run-started", iteration: 0 }],
    }) as unknown as CallResult;
}
