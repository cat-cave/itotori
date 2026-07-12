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
//                           length diagnostics.
//   - qa_findings         : the four focused LLM-QA agents (run via
//                           ScoredFindingWorkflow + optional regrade).
//   - routing             : FindingTriageRouter classification telemetry.
//   - repair              : bounded best-effort repair iteration.
//   - final_draft         : historical stage label retained as telemetry;
//                           the durable result is always `writtenOutcome`.
//
// Every stage record carries its `invocations` array (one per LLM
// call within the stage); every invocation declares the explicit
// `(modelId, providerId)` pair drawn from the pair-policy at
// orchestrator entry. There is no silent fallback — an unfilled pair
// is a typed wire-schema failure, not a missing field.
//
// The schema version is locked to a literal so any change forces a
// downstream consumer migration.

// v3 replaces the optional/deferred final-draft XOR with the canonical
// `WrittenUnitOutcome`. Every in-scope unit has a selected, non-blank target
// candidate; QA persists as annotations and cannot erase the text.
//
// No-legacy-compat: v1 and v2 bundles no longer load. Tests + drivers must
// produce the v3 written-outcome shape in the same change.
export const AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION = "itotori.agentic-loop-bundle.v3" as const;

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
 * `diagnosed:deterministic`. It is telemetry only: it can never gate or
 * remove the written outcome.
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
 * Branded target text that is safe to persist as a selected candidate. The
 * constructor and bundle validator require it to be non-blank after trimming,
 * already trimmed, and not a locale-tagged source replay such as
 * `[en-US]<source>`.
 */
export type NonBlankTargetText = string & { readonly __brand: "NonBlank" };

/**
 * Convert a known target string into its branded form. This is deliberately
 * strict rather than a trimming fallback: callers must make their selection
 * explicit, and the same invariants hold at construction and parsing time.
 */
export function asNonBlankTargetText(value: string): NonBlankTargetText {
  assertNonBlankTargetText(value, "targetText");
  return value;
}

/** True when a value uses the toxic locale-tagged source-replay convention. */
export function isLocaleTaggedSourceEcho(value: string): boolean {
  return /^\[[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*\]/u.test(value);
}

/** A candidate generated by a primary or repair translation attempt. */
export type TranslationCandidate = {
  id: string;
  outcomeId: string;
  body: NonBlankTargetText;
  producedBy: AgenticLoopProviderPair;
  attemptId: string;
  kind: "primary" | "repair";
};

export const WRITTEN_QA_FINDING_SEVERITIES = ["info", "minor", "major", "critical"] as const;
export type WrittenQaFindingSeverity = (typeof WRITTEN_QA_FINDING_SEVERITIES)[number];

/**
 * A permanent QA annotation scoped to the candidate it judged. This is distinct
 * from the agent response `QaFinding`: outcome findings contain durable
 * candidate/outcome identities and never encode a release decision.
 */
export type WrittenQaFinding = {
  id: string;
  outcomeId: string;
  candidateId: string;
  severity: WrittenQaFindingSeverity;
  category: string;
  note: string;
  contested: boolean;
  confidence: number;
};

/**
 * The canonical terminal result for one in-scope unit. `status` intentionally
 * has one value: all quality and repair state lives in `findings` and
 * `qualityFlags`, never in a missing/cleared target draft.
 */
export type WrittenUnitOutcome = {
  /** Stable outcome identity referenced by candidates and QA annotations. */
  id: string;
  status: "written";
  unitId: string;
  targetLocale: string;
  selectedCandidateId: string;
  candidates: TranslationCandidate[];
  findings: WrittenQaFinding[];
  qualityFlags: string[];
  provenance: unknown;
  writtenAt: string;
};

export type AgenticLoopBundle = {
  schemaVersion: typeof AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION;
  bridgeUnitId: string;
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  stages: AgenticLoopStageRecord[];
  writtenOutcome: WrittenUnitOutcome;
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
const WRITTEN_QA_FINDING_SEVERITY_VALUES: ReadonlyArray<string> = [
  ...WRITTEN_QA_FINDING_SEVERITIES,
];

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
    "writtenOutcome",
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
  assertWrittenUnitOutcome(record.writtenOutcome, "writtenOutcome");
  const writtenOutcome = record.writtenOutcome as WrittenUnitOutcome;
  if (writtenOutcome.unitId !== record.bridgeUnitId) {
    throw new AgenticLoopBundleValidationError(
      "writtenOutcome.unitId",
      "unitBinding",
      `must equal bundle bridgeUnitId '${String(record.bridgeUnitId)}'`,
    );
  }
  if (writtenOutcome.targetLocale !== record.targetLocale) {
    throw new AgenticLoopBundleValidationError(
      "writtenOutcome.targetLocale",
      "localeBinding",
      `must equal bundle targetLocale '${String(record.targetLocale)}'`,
    );
  }
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

/**
 * Validate the canonical terminal outcome independently of an enclosing loop
 * bundle. Downstream artifact boundaries use this instead of reintroducing a
 * second optional-draft result model.
 */
export function assertWrittenUnitOutcome(
  value: unknown,
  label: string,
): asserts value is WrittenUnitOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "status",
    "unitId",
    "targetLocale",
    "selectedCandidateId",
    "candidates",
    "findings",
    "qualityFlags",
    "provenance",
    "writtenAt",
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
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (record.status !== "written") {
    throw new AgenticLoopBundleValidationError(`${label}.status`, "const", "expected 'written'");
  }
  assertTrimmedNonEmptyString(record.unitId, `${label}.unitId`);
  assertTrimmedNonEmptyString(record.targetLocale, `${label}.targetLocale`);
  assertTrimmedNonEmptyString(record.selectedCandidateId, `${label}.selectedCandidateId`);
  if (!Array.isArray(record.candidates)) {
    throw new AgenticLoopBundleValidationError(`${label}.candidates`, "type", "expected array");
  }
  if (record.candidates.length === 0) {
    throw new AgenticLoopBundleValidationError(
      `${label}.candidates`,
      "minItems",
      "must contain at least one non-blank candidate",
    );
  }
  const candidateIds = new Set<string>();
  for (const [index, candidate] of record.candidates.entries()) {
    assertTranslationCandidate(candidate, `${label}.candidates[${index}]`, record.id, candidateIds);
  }
  if (!candidateIds.has(record.selectedCandidateId as string)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.selectedCandidateId`,
      "reference",
      "must resolve to a candidate in writtenOutcome.candidates",
    );
  }
  if (!Array.isArray(record.findings)) {
    throw new AgenticLoopBundleValidationError(`${label}.findings`, "type", "expected array");
  }
  const findingIds = new Set<string>();
  for (const [index, finding] of record.findings.entries()) {
    assertWrittenQaFinding(
      finding,
      `${label}.findings[${index}]`,
      record.id,
      candidateIds,
      findingIds,
    );
  }
  if (!Array.isArray(record.qualityFlags)) {
    throw new AgenticLoopBundleValidationError(`${label}.qualityFlags`, "type", "expected array");
  }
  const qualityFlags = new Set<string>();
  for (const [index, flag] of record.qualityFlags.entries()) {
    assertTrimmedNonEmptyString(flag, `${label}.qualityFlags[${index}]`);
    if (qualityFlags.has(flag as string)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.qualityFlags[${index}]`,
        "uniqueItems",
        `duplicate quality flag '${String(flag)}'`,
      );
    }
    qualityFlags.add(flag as string);
  }
  if (!("provenance" in record)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.provenance`,
      "required",
      "missing required field provenance",
    );
  }
  assertTrimmedNonEmptyString(record.writtenAt, `${label}.writtenAt`);
}

function assertTranslationCandidate(
  value: unknown,
  label: string,
  outcomeId: unknown,
  candidateIds: Set<string>,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["id", "outcomeId", "body", "producedBy", "attemptId", "kind"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AgenticLoopBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (candidateIds.has(record.id as string)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.id`,
      "uniqueItems",
      `duplicate candidate id '${String(record.id)}'`,
    );
  }
  candidateIds.add(record.id as string);
  assertTrimmedNonEmptyString(record.outcomeId, `${label}.outcomeId`);
  if (record.outcomeId !== outcomeId) {
    throw new AgenticLoopBundleValidationError(
      `${label}.outcomeId`,
      "outcomeBinding",
      `must equal writtenOutcome.id '${String(outcomeId)}'`,
    );
  }
  assertNonBlankTargetText(record.body, `${label}.body`);
  assertProviderPair(record.producedBy, `${label}.producedBy`);
  assertTrimmedNonEmptyString(record.attemptId, `${label}.attemptId`);
  if (record.kind !== "primary" && record.kind !== "repair") {
    throw new AgenticLoopBundleValidationError(
      `${label}.kind`,
      "enum",
      "must be one of [primary, repair]",
    );
  }
}

function assertWrittenQaFinding(
  value: unknown,
  label: string,
  outcomeId: unknown,
  candidateIds: ReadonlySet<string>,
  findingIds: Set<string>,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgenticLoopBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "outcomeId",
    "candidateId",
    "severity",
    "category",
    "note",
    "contested",
    "confidence",
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
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (findingIds.has(record.id as string)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.id`,
      "uniqueItems",
      `duplicate finding id '${String(record.id)}'`,
    );
  }
  findingIds.add(record.id as string);
  assertTrimmedNonEmptyString(record.outcomeId, `${label}.outcomeId`);
  if (record.outcomeId !== outcomeId) {
    throw new AgenticLoopBundleValidationError(
      `${label}.outcomeId`,
      "outcomeBinding",
      `must equal writtenOutcome.id '${String(outcomeId)}'`,
    );
  }
  assertTrimmedNonEmptyString(record.candidateId, `${label}.candidateId`);
  if (!candidateIds.has(record.candidateId as string)) {
    throw new AgenticLoopBundleValidationError(
      `${label}.candidateId`,
      "reference",
      "must resolve to a candidate in writtenOutcome.candidates",
    );
  }
  if (
    typeof record.severity !== "string" ||
    !WRITTEN_QA_FINDING_SEVERITY_VALUES.includes(record.severity)
  ) {
    throw new AgenticLoopBundleValidationError(
      `${label}.severity`,
      "enum",
      `must be one of [${WRITTEN_QA_FINDING_SEVERITY_VALUES.join(", ")}]`,
    );
  }
  assertTrimmedNonEmptyString(record.category, `${label}.category`);
  assertTrimmedNonEmptyString(record.note, `${label}.note`);
  if (typeof record.contested !== "boolean") {
    throw new AgenticLoopBundleValidationError(`${label}.contested`, "type", "expected boolean");
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new AgenticLoopBundleValidationError(
      `${label}.confidence`,
      "range",
      "expected a finite number from 0 through 1",
    );
  }
}

export function assertNonBlankTargetText(
  value: unknown,
  label = "targetText",
): asserts value is NonBlankTargetText {
  if (typeof value !== "string") {
    throw new AgenticLoopBundleValidationError(label, "type", "expected string");
  }
  if (value.trim().length === 0) {
    throw new AgenticLoopBundleValidationError(label, "nonBlank", "must not be blank");
  }
  if (value !== value.trim()) {
    throw new AgenticLoopBundleValidationError(
      label,
      "trimmed",
      "must not have leading or trailing whitespace",
    );
  }
  if (isLocaleTaggedSourceEcho(value)) {
    throw new AgenticLoopBundleValidationError(
      label,
      "sourceEcho",
      "must not use a locale-tagged source replay",
    );
  }
}

function assertTrimmedNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new AgenticLoopBundleValidationError(label, "type", "expected string");
  }
  if (value.trim().length === 0) {
    throw new AgenticLoopBundleValidationError(label, "minLength", "must be non-blank");
  }
  if (value !== value.trim()) {
    throw new AgenticLoopBundleValidationError(
      label,
      "trimmed",
      "must not have leading or trailing whitespace",
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
