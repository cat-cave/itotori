// ITOTORI-021 — Calibration recorded-bundle authority.
//
// One bundle entry per (fixture, focused-agent) combo. The recorded
// payload is the JSON shape the focused agent's underlying provider
// would have produced (a serialized `StructuredQaFindingOutput`).
//
// At test time the bundle is keyed off the deterministic prompt hash
// computed by `buildQaPrompt` against the focused-agent-augmented
// input. Tests therefore call `buildFocusedRecordedBundle` to produce
// a `RecordedProviderBundle` whose `responses` map already carries the
// hash key the QaAgent will resolve at invocation time.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  type QaFinding,
  type StructuredQaFindingOutput,
} from "@itotori/localization-bridge-schema";
import { buildQaPrompt, qaPromptHash } from "../../agents/qa/prompt-template.js";
import type { FocusedQaAgentDescriptor, FocusedQaAgentName } from "../../agents/qa/agents/index.js";
import type { QaBridgeUnit, QaInvocationInput } from "../../agents/qa/shapes.js";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  recordedBundleKey,
  type RecordedProviderBundle,
  type RecordedProviderResponse,
} from "../../providers/recorded.js";
import { ZERO_COST } from "../../providers/cost.js";
import type { ProviderFamily } from "../../providers/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Canonical on-disk shape for the per-(fixture, agent, authority) JSON
 * snapshots under `original/` and `fresh-judge/`. The schema-version
 * gate is enforced strictly so a stale file fails fast instead of
 * silently mis-seeding the calibration tests.
 *
 * ITOTORI-220 v2 — the on-disk bundle gains a required `providerId`
 * field; the `v2` bump rejects any v1 file still on disk so calibration
 * cannot accidentally replay a pre-pair bundle.
 */
export const QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION =
  "itotori.qa-calibration-recorded-bundle.v2" as const;

export type QaCalibrationRecordedBundleFile = {
  schemaVersion: typeof QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION;
  fixtureId: string;
  agentName: FocusedQaAgentName;
  authority: RecordedBundleAuthority;
  /**
   * ITOTORI-220 — providerId pinned by the bundle. Must match what the
   * test's invocation pins via `modelProfile.providerId` so the key
   * computed at runtime matches what the bundle was authored for.
   */
  providerId: string;
  findings: QaFinding[];
};

export class QaCalibrationBundleMissingError extends Error {
  constructor(
    public readonly fixtureId: string,
    public readonly agentName: FocusedQaAgentName,
    public readonly authority: RecordedBundleAuthority,
    public readonly path: string,
    cause: NodeJS.ErrnoException,
  ) {
    super(
      `calibration recorded bundle missing: fixture='${fixtureId}' agent='${agentName}' authority='${authority}' at ${path}: ${cause.message}`,
    );
    this.name = "QaCalibrationBundleMissingError";
  }
}

export class QaCalibrationBundleSchemaError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail: string,
  ) {
    super(`calibration recorded bundle schema mismatch at ${path}: ${detail}`);
    this.name = "QaCalibrationBundleSchemaError";
  }
}

/**
 * Read the canonical on-disk findings snapshot for a (fixture, agent,
 * authority) triple. Throws — never silently returns an empty list.
 */
export function loadCalibrationBundleFindings(
  fixtureId: string,
  agentName: FocusedQaAgentName,
  authority: RecordedBundleAuthority,
): QaFinding[] {
  return loadCalibrationBundleFile(fixtureId, agentName, authority).findings;
}

/**
 * Read the canonical on-disk recorded bundle for a (fixture, agent,
 * authority) triple, including the ITOTORI-220 `providerId` metadata.
 */
export function loadCalibrationBundleFile(
  fixtureId: string,
  agentName: FocusedQaAgentName,
  authority: RecordedBundleAuthority,
): QaCalibrationRecordedBundleFile {
  const path = resolve(__dirname, authority, `${fixtureId}.${agentName}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    throw new QaCalibrationBundleMissingError(
      fixtureId,
      agentName,
      authority,
      path,
      error as NodeJS.ErrnoException,
    );
  }
  const parsed = JSON.parse(raw) as Partial<QaCalibrationRecordedBundleFile>;
  if (parsed.schemaVersion !== QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION) {
    throw new QaCalibrationBundleSchemaError(
      path,
      `expected schemaVersion ${QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION}, got ${String(parsed.schemaVersion)}`,
    );
  }
  if (parsed.fixtureId !== fixtureId) {
    throw new QaCalibrationBundleSchemaError(
      path,
      `fixtureId mismatch: file='${parsed.fixtureId}' expected='${fixtureId}'`,
    );
  }
  if (parsed.agentName !== agentName) {
    throw new QaCalibrationBundleSchemaError(
      path,
      `agentName mismatch: file='${parsed.agentName}' expected='${agentName}'`,
    );
  }
  if (parsed.authority !== authority) {
    throw new QaCalibrationBundleSchemaError(
      path,
      `authority mismatch: file='${parsed.authority}' expected='${authority}'`,
    );
  }
  if (typeof parsed.providerId !== "string" || parsed.providerId.length === 0) {
    throw new QaCalibrationBundleSchemaError(
      path,
      `providerId mismatch: file must declare a non-empty providerId per ITOTORI-220 (got '${String(parsed.providerId)}')`,
    );
  }
  if (!Array.isArray(parsed.findings)) {
    throw new QaCalibrationBundleSchemaError(path, "findings field is not an array");
  }
  return {
    schemaVersion: parsed.schemaVersion,
    fixtureId: parsed.fixtureId,
    agentName: parsed.agentName,
    authority: parsed.authority,
    providerId: parsed.providerId,
    findings: parsed.findings,
  };
}

/**
 * Captured identity baked into every calibration bundle. Same shape as
 * the recorded-bundle authority used elsewhere in the codebase; the
 * `capturedProviderFamily` is `openrouter` because the calibration
 * authority pretends a real OpenRouter run produced the bytes.
 *
 * ITOTORI-220 — the calibration bundles also carry an explicit
 * providerId. The original authority routes through `anthropic` (the
 * pinned upstream for the calibration capture); the fresh-judge
 * authority routes through `google-vertex` to keep the regrade
 * independent at both the model and the provider level.
 */
const CAPTURED_PROVIDER_FAMILY: ProviderFamily = "openrouter";
const CAPTURED_PROVIDER_NAME = "openrouter:itotori-qa-calibration-recorder";
const CAPTURED_ACTUAL_MODEL_ID = "openrouter:claude-opus-itotori-qa-calibration-v1";
export const QA_CALIBRATION_ORIGINAL_PROVIDER_ID = "anthropic" as const;

/**
 * Stable captured identity for the fresh-judge bundles. Different
 * provider name + actual model id from the original capture so the
 * regrade independence guard accepts the bundle.
 */
const FRESH_JUDGE_CAPTURED_PROVIDER_NAME = "openrouter:itotori-qa-calibration-fresh-judge-recorder";
const FRESH_JUDGE_CAPTURED_ACTUAL_MODEL_ID =
  "openrouter:claude-sonnet-itotori-qa-calibration-fresh-judge-v1";
export const QA_CALIBRATION_FRESH_JUDGE_PROVIDER_ID = "google-vertex" as const;

export type RecordedBundleAuthority = "original" | "fresh-judge";

/**
 * Inputs needed to build a focused recorded-provider bundle that the
 * QaAgent will hit on its next invocation.
 */
export type BuildFocusedRecordedBundleArgs = {
  fixtureId: string;
  agentDescriptor: FocusedQaAgentDescriptor;
  input: QaInvocationInput;
  findings: ReadonlyArray<QaFinding>;
  authority: RecordedBundleAuthority;
};

/**
 * Build a `RecordedProviderBundle` keyed on the deterministic prompt
 * hash the focused agent will compute when it runs. Tests construct
 * this once per (fixture, agent) pair.
 */
export function buildFocusedRecordedBundle(
  args: BuildFocusedRecordedBundleArgs,
): RecordedProviderBundle {
  // The focused agent injects a synthetic style guide rule into the
  // input before rendering. Replicate that injection so the hash we
  // compute matches what the agent will compute. Keep the rule exactly
  // identical to the one in `focused-agent.ts`.
  const augmentedInput = withFocusedScopeDirective(args.input, args.agentDescriptor);
  const rendered = buildQaPrompt(augmentedInput);
  // ITOTORI-220 — pair-aware bundle key. The runtime `RecordedModelProvider`
  // computes the same hash from the request's (modelId, providerId,
  // promptHash, inputClassification); we mirror that here.
  const promptHashKey = recordedBundleKey({
    modelId: args.input.modelProfile.modelId,
    providerId: args.input.modelProfile.providerId,
    promptHash: `sha256:${qaPromptHash(rendered)}`,
    inputClassification: "private_corpus",
  });

  const payload: StructuredQaFindingOutput = {
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: args.findings.map((finding) => ({ ...finding })),
  };
  const isFresh = args.authority === "fresh-judge";
  const bundleId = `qa-calibration-${args.fixtureId}-${args.agentDescriptor.name}-${args.authority}`;
  const response: RecordedProviderResponse = {
    content: JSON.stringify(payload),
    finishReason: "stop",
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 1024,
      completionTokens: 256,
      totalTokens: 1280,
    },
    // ITOTORI-228 — the QA calibration bundles are synthesised in-code
    // (no LIVE OR call ever produced them) so there is no captured
    // `usage.cost` to mirror. We declare ZERO_COST explicitly: the
    // calibration suite's purpose is to assert findings/regrade
    // behaviour, not cost-cap arithmetic, so the response shape
    // validates without misrepresenting a real charge. When a future
    // calibration capture is taken against live OR, this constant must
    // be replaced with the real micros derived from `usage.cost`.
    cost: ZERO_COST,
    // ITOTORI-230 — synthesised bundle, no real captured posture. We
    // record the canonical alpha posture as a "what a real capture
    // would have produced" placeholder. A future LIVE capture against
    // OR must REPLACE this with the actual wire-level posture.
    routingPosture: {
      only: [
        isFresh ? QA_CALIBRATION_FRESH_JUDGE_PROVIDER_ID : QA_CALIBRATION_ORIGINAL_PROVIDER_ID,
      ],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
  };

  return {
    schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
    bundleId,
    capturedProviderFamily: CAPTURED_PROVIDER_FAMILY,
    capturedProviderName: isFresh ? FRESH_JUDGE_CAPTURED_PROVIDER_NAME : CAPTURED_PROVIDER_NAME,
    capturedRequestedModelId: args.input.modelProfile.modelId,
    capturedProviderId: isFresh
      ? QA_CALIBRATION_FRESH_JUDGE_PROVIDER_ID
      : QA_CALIBRATION_ORIGINAL_PROVIDER_ID,
    capturedActualModelId: isFresh
      ? FRESH_JUDGE_CAPTURED_ACTUAL_MODEL_ID
      : CAPTURED_ACTUAL_MODEL_ID,
    responses: {
      [promptHashKey]: response,
    },
  };
}

/**
 * Replicates `FocusedQaAgent.applyScopeDirective` for bundle-building.
 * MUST stay byte-equal with the runtime implementation so the recorded
 * hash matches what the agent computes.
 */
function withFocusedScopeDirective(
  input: QaInvocationInput,
  descriptor: FocusedQaAgentDescriptor,
): QaInvocationInput {
  const focusRule = {
    ruleId: `${descriptor.name}-focus-directive`,
    section: "formatting" as const,
    guidance: descriptor.scopeDirective,
  };
  return { ...input, styleGuide: [...input.styleGuide, focusRule] };
}

/**
 * Deterministic stable id that uniquely names (fixture, agent,
 * authority). Useful for snapshot tests and audit trails.
 */
export function calibrationBundleId(
  fixtureId: string,
  agentName: FocusedQaAgentName,
  authority: RecordedBundleAuthority,
): string {
  const hash = createHash("sha256");
  hash.update(`${fixtureId}|${agentName}|${authority}`);
  return `qa-calibration::${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Reproject a calibration fixture's units onto a different bridge-unit
 * id range. Currently unused outside the test suite but exposed so the
 * regrade-trigger fixture can produce a SECOND bundle (the fresh
 * judge's findings often differ in shape from the original).
 */
export function withRekeyedUnits(
  units: ReadonlyArray<QaBridgeUnit>,
  rekey: (unit: QaBridgeUnit) => QaBridgeUnit,
): QaBridgeUnit[] {
  return units.map(rekey);
}
