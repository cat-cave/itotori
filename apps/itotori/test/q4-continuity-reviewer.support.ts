import {
  REVIEW_VERDICT_SCHEMA_VERSION,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type RouteScope,
} from "../src/contracts/index.js";

import {
  continuityLedgerFrom,
  type ContinuityLedger,
  type Q4ContinuityFacts,
  type Q4DispatchRefs,
  type Q4ReviewInput,
} from "../src/roles/q4/index.js";

export const SNAP = `sha256:${"a".repeat(64)}` as const;

export const HASH = `sha256:${"b".repeat(64)}` as const;

export const ROUTE_A: RouteScope = { kind: "route", routeId: "route-a" };

export const ROUTE_B: RouteScope = { kind: "route", routeId: "route-b" };

export const GLOBAL: RouteScope = { kind: "global" };

export const synthLedger: ContinuityLedger = continuityLedgerFrom([
  { unitId: "u-origin", playOrderIndex: 0, routeScope: { kind: "route", routeId: "route-a" } },
  { unitId: "u-use", playOrderIndex: 5, routeScope: { kind: "route", routeId: "route-a" } },
]);

export const baseInput: Q4ReviewInput = {
  unitId: "u-use",
  localizationSnapshotId: SNAP,
  reviewScope: ROUTE_A,
  currentTarget: "As you promised me back at the shrine, you finally came.",
  bibleRenderingIds: ["rendering:1"],
  originTranslations: [{ unitId: "u-origin", acceptedTarget: "I promise I'll come find you." }],
};

export function facts(over: Partial<Q4ContinuityFacts> = {}): Q4ContinuityFacts {
  return {
    useUnitId: "u-use",
    reviewScope: ROUTE_A,
    acceptedOriginUnitIds: ["u-origin"],
    ledger: synthLedger,
    ...over,
  };
}

export function passVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:1",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["u-origin"],
    repairConstraint: null,
    ...over,
  };
}

export function failVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:2",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "at the shrine" },
    category: "callback",
    // A contradiction carries BOTH real endpoint citations. `u-origin` is the
    // accepted prior translation; `u-use` is the candidate under review.
    evidenceIds: ["u-origin", "u-use"],
    repairConstraint: "Match the callback to the origin promise at the origin location.",
    ...over,
  };
}

export function cannotAssessVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
    reviewId: "review:3",
    localizationSnapshotId: SNAP,
    roleId: "Q4",
    rubric: "continuity",
    unitId: "u-use",
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["Need the accepted origin translation for the shrine scene."],
    ...over,
  };
}

export const refs: Q4DispatchRefs = {
  parentEventId: HASH,
  contextSnapshotId: HASH,
  localizationSnapshotId: SNAP,
  sealPayload: (plaintext): EncryptedPayloadRef => ({
    storageRef: `encrypted:q4:${plaintext.length}`,
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
