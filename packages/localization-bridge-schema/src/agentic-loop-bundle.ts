// ITOTORI-222 — AgenticLoopBundle wire schema.
//
// The full agentic-loop orchestrator
// (`apps/itotori/src/orchestrator/agentic-loop.ts`) writes one of
// these bundles per `runAgenticLoopForUnit(unit, pairPolicy, policy)`
// call. The bundle is the deterministic, structural summary of every
// stage the orchestrator chained through:
//
//   - context             : scene-summary / character-relationship /
//                           terminology-candidate / route-choice-map
//                           context-artifact production.
//   - pre_translation     : speaker-label invocation + glossary lookup.
//   - translation         : draft generation by the TranslationAgent.
//   - deterministic_checks: protected-spans / glossary / charset /
//                           length / punctuation gates.
//   - qa_findings         : the four focused LLM-QA agents (run via
//                           ScoredFindingWorkflow + optional regrade).
//   - routing             : FindingTriageRouter classification of every
//                           finding / violation produced upstream.
//   - repair              : bounded repair iteration when routing
//                           identified a repairable cause. May be
//                           skipped (no repairable cause) or capped at
//                           policy.maxRepairAttempts.
//   - final_draft         : the resolved draft surface — either the
//                           accepted draft or a `deferred_to_human`
//                           outcome.
//
// Every stage record carries its `invocations` array (one per LLM
// call within the stage); every invocation declares the explicit
// `(modelId, providerId)` pair drawn from the pair-policy at
// orchestrator entry. There is no silent fallback — an unfilled pair
// is a typed wire-schema failure, not a missing field.
//
// The schema version is locked to a literal so any change forces a
// downstream consumer migration.

// ITOTORI-234 bumped v1 -> v2 to add per-invocation `zdr` + `seed`
// fields on every `AgenticLoopInvocation`. The fields are drawn from
// the parsed v0.2 pair-policy's per-stage posture and recorded verbatim
// so an audit can prove the ZDR posture + seed-derived nondeterminism
// applied at each call.
//
// No-legacy-compat: v1 bundles no longer load. Tests + driver fixtures
// were rewritten in the same change.
export const AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION = "itotori.agentic-loop-bundle.v2" as const;

/**
 * Closed enum of stage names. Order is the orchestrator's invocation
 * order; the bundle's `stages` array preserves the same order. Tests
 * may assert byte-equal stage-name sequences against this list.
 */
export const AGENTIC_LOOP_STAGE_NAMES = [
  "context",
  "pre_translation",
  "translation",
  "deterministic_checks",
  "qa_findings",
  "routing",
  "repair",
  "final_draft",
] as const;
export type AgenticLoopStageName = (typeof AGENTIC_LOOP_STAGE_NAMES)[number];

/**
 * Closed enum of routing outcomes. `accepted` means the draft cleared
 * every gate AND triage routed everything to a benign class.
 * `repaired_then_accepted` means a repair iteration produced a draft
 * that cleared BOTH the deterministic recheck AND a bounded re-QA pass
 * (the QA judge re-evaluated the repaired draft and confirmed the
 * QA-flagged issue that drove the repair is resolved — zero repairable
 * causes + zero critical findings). `repaired_then_qa_rejected` means a
 * repair iteration cleared the deterministic recheck but the bounded
 * re-QA pass STILL flagged a repairable/critical issue on the repaired
 * draft: the repair did not confirmably fix the problem, so the draft is
 * NOT persisted and is routed to the human queue (distinct from a plain
 * budget-exhaustion defer so telemetry shows repair WAS attempted +
 * re-judged but not confirmed). `deferred_to_human` means the
 * orchestrator exhausted the repair budget without ever producing a
 * deterministically-clean repaired draft (or routing immediately
 * requested human review) and the draft was NOT persisted — the human
 * triage queue owns the next step. `escalated_to_runtime` is reserved
 * for runtime-attribution routing (HumanFinding with attribution=runtime).
 */
export const AGENTIC_LOOP_ROUTING_OUTCOMES = [
  "accepted",
  "repaired_then_accepted",
  "repaired_then_qa_rejected",
  "deferred_to_human",
  "escalated_to_runtime",
  "short_circuit_deterministic_p0",
] as const;
export type AgenticLoopRoutingOutcome = (typeof AGENTIC_LOOP_ROUTING_OUTCOMES)[number];

/**
 * Pair declaration that EVERY invocation in the bundle carries.
 * Surfaces the (modelId, providerId) pair the orchestrator pinned for
 * that specific call. The schema asserter rejects bundles whose
 * invocations omit either field — silent defaulting is a structural
 * failure mode, not a recoverable warning.
 */
export type AgenticLoopProviderPair = {
  modelId: string;
  providerId: string;
};

/**
 * One LLM (or context-artifact) invocation inside a stage. Keyed on
 * `runId` (provider proof id), which is also the join key for the
 * draft-attempt provider ledger. `costUsd` is the real billed USD
 * cost as a decimal string (the field carries actual cost, not an
 * estimate), rendered at FULL precision — the same authoritative value
 * the ledger persists (`ProviderCost.amountUsd`, the verbatim provider
 * `usage.cost`). It is NOT rounded to integer micros: a `0.00000602`
 * charge is recorded verbatim as `"0.00000602"`, never truncated to
 * `"0.000006"`, so the sub-micro tail cheap models bill is preserved.
 * `tokensIn` / `tokensOut` and `latencyMs` are non-negative integers.
 */
export type AgenticLoopInvocation = {
  invocationId: string;
  agentLabel: string;
  pair: AgenticLoopProviderPair;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  latencyMs: number;
  providerProofId: string;
  /**
   * ITOTORI-234 — per-invocation ZDR posture drawn from the v0.2
   * pair-policy's per-stage value. `true` is the canonical alpha
   * posture; `false` is only reachable when the operator approved the
   * downgrade via OPENROUTER_ZDR_DOWNGRADE. Recorded verbatim so the
   * bundle is self-describing without re-reading the policy file.
   */
  zdr: boolean;
  /**
   * ITOTORI-234 — per-invocation seed. For the primary attempt this is
   * the policy's leaf seed; bounded-repair retries add the attempt
   * number so each attempt records its own differentiated seed.
   */
  seed: number;
};

/**
 * A semantic-context enrichment that was DROPPED because its live agent
 * threw / emitted a malformed or uncitable pack. The context stage is
 * BEST-EFFORT: a single semantic agent's bad output degrades the unit to the
 * deterministic structure-informed context (+ whichever agents did succeed)
 * instead of failing the whole unit. Each drop names which agent was dropped
 * and why, so the enrichment loss is TELEMETRY, never silent.
 */
export type DroppedContextEnrichment = {
  agentLabel: string;
  reason: string;
};

/**
 * One stage of the agentic loop. `outcome` is a free-text status
 * tag — e.g. `succeeded`, `skipped:no-repairable-cause`,
 * `short_circuit:p0-deterministic`. The router stage carries a more
 * specific `routingOutcome` on the bundle's top-level summary.
 *
 * `droppedEnrichments` is present ONLY on the context stage and ONLY when at
 * least one best-effort semantic agent was dropped; an all-succeed context
 * stage omits the field entirely (byte-identical to the pre-robustness shape).
 */
export type AgenticLoopStageRecord = {
  stageName: AgenticLoopStageName;
  outcome: string;
  invocations: AgenticLoopInvocation[];
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  latencyMs: number;
  droppedEnrichments?: DroppedContextEnrichment[];
};

/**
 * Summary of routing classifications applied to all findings +
 * deterministic violations that emerged from the loop. Mirrors the
 * `FindingTriageSummary` shape but is denormalized into the wire
 * surface so the bundle is self-describing.
 */
export type AgenticLoopRoutingSummary = {
  outcome: AgenticLoopRoutingOutcome;
  routedFindingCount: number;
  criticalFindingCount: number;
  repairAttempts: number;
  maxRepairAttempts: number;
};

/**
 * The final-draft slice surfaced into the bundle. For a repaired or
 * accepted draft this carries `draftText`; for a `deferred_to_human`
 * outcome it carries `deferredReason` instead and `draftText` is
 * undefined.
 */
export type AgenticLoopFinalDraft = {
  bridgeUnitId: string;
  draftText?: string;
  deferredReason?: string;
};

export type AgenticLoopBundle = {
  schemaVersion: typeof AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION;
  bridgeUnitId: string;
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  stages: AgenticLoopStageRecord[];
  routingSummary: AgenticLoopRoutingSummary;
  finalDraft: AgenticLoopFinalDraft;
};

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class AgenticLoopBundleValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`AgenticLoopBundle.${path} failed rule '${rule}': ${detail}`);
    this.name = "AgenticLoopBundleValidationError";
  }
}

const STAGE_NAME_VALUES: ReadonlyArray<string> = [...AGENTIC_LOOP_STAGE_NAMES];
const ROUTING_OUTCOME_VALUES: ReadonlyArray<string> = [...AGENTIC_LOOP_ROUTING_OUTCOMES];

export function assertAgenticLoopBundle(value: unknown): asserts value is AgenticLoopBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "bridgeUnitId",
    "projectId",
    "localeBranchId",
    "sourceLocale",
    "targetLocale",
    "stages",
    "routingSummary",
    "finalDraft",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION) {
    throw new AgenticLoopBundleValidationError(
      "schemaVersion",
      "const",
      `expected ${AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertNonEmptyString(record.bridgeUnitId, "bridgeUnitId");
  assertNonEmptyString(record.projectId, "projectId");
  assertNonEmptyString(record.localeBranchId, "localeBranchId");
  assertNonEmptyString(record.sourceLocale, "sourceLocale");
  assertNonEmptyString(record.targetLocale, "targetLocale");
  if (!Array.isArray(record.stages)) {
    throw new AgenticLoopBundleValidationError("stages", "type", "expected array");
  }
  for (const [index, stage] of record.stages.entries()) {
    assertStageRecord(stage, `stages[${index}]`);
  }
  assertRoutingSummary(record.routingSummary, "routingSummary");
  assertFinalDraft(record.finalDraft, "finalDraft");
}

function assertStageRecord(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "stageName",
    "outcome",
    "invocations",
    "tokensIn",
    "tokensOut",
    "costUsd",
    "latencyMs",
    "droppedEnrichments",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  if (typeof record.stageName !== "string" || !STAGE_NAME_VALUES.includes(record.stageName)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.stageName`,
      "enum",
      `must be one of [${STAGE_NAME_VALUES.join(", ")}]`,
    );
  }
  assertNonEmptyString(record.outcome, `${label}.outcome`);
  if (!Array.isArray(record.invocations)) {
    throw new AgenticLoopBundleValidationError(`${label}.invocations`, "type", "expected array");
  }
  for (const [index, invocation] of record.invocations.entries()) {
    assertInvocation(invocation, `${label}.invocations[${index}]`);
  }
  assertNonNegativeInteger(record.tokensIn, `${label}.tokensIn`);
  assertNonNegativeInteger(record.tokensOut, `${label}.tokensOut`);
  assertDecimalString(record.costUsd, `${label}.costUsd`);
  assertNonNegativeInteger(record.latencyMs, `${label}.latencyMs`);
  if (record.droppedEnrichments !== undefined) {
    if (!Array.isArray(record.droppedEnrichments)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.droppedEnrichments`,
        "type",
        "expected array",
      );
    }
    if (record.droppedEnrichments.length === 0) {
      // The field is present ONLY to carry drops; an empty array would be an
      // ambiguous shape (indistinguishable from "no drops" but not omitted).
      throw new AgenticLoopBundleValidationError(
        `${label}.droppedEnrichments`,
        "nonEmpty",
        "must be omitted when empty",
      );
    }
    for (const [index, drop] of record.droppedEnrichments.entries()) {
      assertDroppedEnrichment(drop, `${label}.droppedEnrichments[${index}]`);
    }
  }
}

function assertDroppedEnrichment(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["agentLabel", "reason"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.agentLabel, `${label}.agentLabel`);
  assertNonEmptyString(record.reason, `${label}.reason`);
}

function assertInvocation(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "invocationId",
    "agentLabel",
    "pair",
    "tokensIn",
    "tokensOut",
    "costUsd",
    "latencyMs",
    "providerProofId",
    "zdr",
    "seed",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.invocationId, `${label}.invocationId`);
  assertNonEmptyString(record.agentLabel, `${label}.agentLabel`);
  assertProviderPair(record.pair, `${label}.pair`);
  assertNonNegativeInteger(record.tokensIn, `${label}.tokensIn`);
  assertNonNegativeInteger(record.tokensOut, `${label}.tokensOut`);
  assertDecimalString(record.costUsd, `${label}.costUsd`);
  assertNonNegativeInteger(record.latencyMs, `${label}.latencyMs`);
  assertNonEmptyString(record.providerProofId, `${label}.providerProofId`);
  // ITOTORI-234 — every invocation carries the per-stage zdr posture +
  // seed from the v0.2 pair-policy. Defaulting is a structural failure.
  if (typeof record.zdr !== "boolean") {
    throw new AgenticLoopBundleValidationError(`${label}.zdr`, "type", "expected boolean");
  }
  assertNonNegativeInteger(record.seed, `${label}.seed`);
}

function assertProviderPair(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["modelId", "providerId"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.modelId, `${label}.modelId`);
  assertNonEmptyString(record.providerId, `${label}.providerId`);
}

function assertRoutingSummary(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "outcome",
    "routedFindingCount",
    "criticalFindingCount",
    "repairAttempts",
    "maxRepairAttempts",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  if (typeof record.outcome !== "string" || !ROUTING_OUTCOME_VALUES.includes(record.outcome)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.outcome`,
      "enum",
      `must be one of [${ROUTING_OUTCOME_VALUES.join(", ")}]`,
    );
  }
  assertNonNegativeInteger(record.routedFindingCount, `${label}.routedFindingCount`);
  assertNonNegativeInteger(record.criticalFindingCount, `${label}.criticalFindingCount`);
  assertNonNegativeInteger(record.repairAttempts, `${label}.repairAttempts`);
  assertNonNegativeInteger(record.maxRepairAttempts, `${label}.maxRepairAttempts`);
}

function assertFinalDraft(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["bridgeUnitId", "draftText", "deferredReason"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.bridgeUnitId, `${label}.bridgeUnitId`);
  if (record.draftText !== undefined && typeof record.draftText !== "string") {
    throw new AgenticLoopBundleValidationError(
      `${label}.draftText`,
      "type",
      "expected string when present",
    );
  }
  if (record.deferredReason !== undefined && typeof record.deferredReason !== "string") {
    throw new AgenticLoopBundleValidationError(
      `${label}.deferredReason`,
      "type",
      "expected string when present",
    );
  }
  // Exactly one of draftText / deferredReason must be present so the
  // bundle is unambiguous about whether the loop produced a draft.
  const hasDraft = typeof record.draftText === "string";
  const hasDeferred = typeof record.deferredReason === "string";
  if (hasDraft === hasDeferred) {
    throw new AgenticLoopBundleValidationError(
      label,
      "oneOf",
      "exactly one of finalDraft.draftText or finalDraft.deferredReason must be present",
    );
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new AgenticLoopBundleValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new AgenticLoopBundleValidationError(label, "minLength", "must be non-empty");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected integer");
  }
  if (value < 0) {
    throw new AgenticLoopBundleValidationError(label, "minimum", "must be >= 0");
  }
}

function assertDecimalString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new AgenticLoopBundleValidationError(label, "type", "expected decimal string");
  }
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw new AgenticLoopBundleValidationError(
      label,
      "pattern",
      "expected decimal string (e.g. '0.000000')",
    );
  }
}

/**
 * Strict-parsing wrapper for raw JSON. JSON parse failures are wrapped
 * in `AgenticLoopBundleValidationError` so callers never see a raw
 * `SyntaxError`.
 */
export function parseAgenticLoopBundle(raw: string): AgenticLoopBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgenticLoopBundleValidationError(
      "",
      "json",
      `bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertAgenticLoopBundle(parsed);
  return parsed;
}
