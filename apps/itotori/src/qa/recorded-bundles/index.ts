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
import type { RecordedProviderBundle, RecordedProviderResponse } from "../../providers/recorded.js";
import type { ProviderFamily } from "../../providers/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Canonical on-disk shape for the per-(fixture, agent, authority) JSON
 * snapshots under `original/` and `fresh-judge/`. The schema-version
 * gate is enforced strictly so a stale file fails fast instead of
 * silently mis-seeding the calibration tests.
 */
export const QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION =
  "itotori.qa-calibration-recorded-bundle.v1" as const;

export type QaCalibrationRecordedBundleFile = {
  schemaVersion: typeof QA_CALIBRATION_RECORDED_BUNDLE_SCHEMA_VERSION;
  fixtureId: string;
  agentName: FocusedQaAgentName;
  authority: RecordedBundleAuthority;
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
  if (!Array.isArray(parsed.findings)) {
    throw new QaCalibrationBundleSchemaError(path, "findings field is not an array");
  }
  return parsed.findings;
}

/**
 * Captured identity baked into every calibration bundle. Same shape as
 * the recorded-bundle authority used elsewhere in the codebase; the
 * `capturedProviderFamily` is `openrouter` because the calibration
 * authority pretends a real OpenRouter run produced the bytes.
 */
const CAPTURED_PROVIDER_FAMILY: ProviderFamily = "openrouter";
const CAPTURED_PROVIDER_NAME = "openrouter:itotori-qa-calibration-recorder";
const CAPTURED_ACTUAL_MODEL_ID = "openrouter:claude-opus-itotori-qa-calibration-v1";

/**
 * Stable captured identity for the fresh-judge bundles. Different
 * provider name + actual model id from the original capture so the
 * regrade independence guard accepts the bundle.
 */
const FRESH_JUDGE_CAPTURED_PROVIDER_NAME = "openrouter:itotori-qa-calibration-fresh-judge-recorder";
const FRESH_JUDGE_CAPTURED_ACTUAL_MODEL_ID =
  "openrouter:claude-sonnet-itotori-qa-calibration-fresh-judge-v1";

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
  const promptHashKey = `sha256:${qaPromptHash(rendered)}`;

  const payload: StructuredQaFindingOutput = {
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: args.findings.map((finding) => ({ ...finding })),
  };
  const response: RecordedProviderResponse = {
    content: JSON.stringify(payload),
    finishReason: "stop",
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 1024,
      completionTokens: 256,
      totalTokens: 1280,
    },
  };

  const bundleId = `qa-calibration-${args.fixtureId}-${args.agentDescriptor.name}-${args.authority}`;
  const isFresh = args.authority === "fresh-judge";

  return {
    bundleId,
    capturedProviderFamily: CAPTURED_PROVIDER_FAMILY,
    capturedProviderName: isFresh ? FRESH_JUDGE_CAPTURED_PROVIDER_NAME : CAPTURED_PROVIDER_NAME,
    capturedRequestedModelId: args.input.modelProfile.modelId,
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
