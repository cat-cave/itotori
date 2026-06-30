// ITOTORI-099 — Experiment matrix config schema (typed).
//
// A matrix declares the controlled axes of a provider/model/prompt/policy
// experiment as a set of CELLS. Every cell pins a (model, provider) PAIR —
// not a bare model — because OpenRouter is a marketplace and provider
// quality, cost, latency, and structured-output support vary by provider
// for the same model (feedback-model-provider-pair; providers/types.ts
// ITOTORI-220). The pair is non-optional at the type level AND re-checked
// by `assertExperimentMatrixConfig` so a caller cannot smuggle a
// model-only cell past the schema.
//
// Each cell additionally declares the prompt preset, policy version,
// target locale, and the fixture corpus ids it runs over — exactly the
// axes the ITOTORI-099 acceptance requires.
//
// The audit focus "Unbounded experiment scope" is enforced structurally:
// a config MUST declare explicit `bounds` (maxCells / maxInvocations) and
// the validator refuses a config whose realized cell / invocation count
// exceeds them. There is no implicit ceiling — the experiment author
// commits to a bound in the checked-in config, visible in review.

import type { ProviderInputClassification } from "../providers/types.js";

export const EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION =
  "itotori.experiment_matrix_config.v0.1" as const;

/**
 * The (modelId, providerId) PAIR every cell pins. Mirrors
 * providers/dev-pair.ts `ModelProviderPair`; redeclared here so the
 * experiment-matrix schema is self-contained and both fields are
 * required at the type level.
 */
export type ExperimentModelProviderPair = {
  readonly modelId: string;
  readonly providerId: string;
};

/**
 * Prompt preset reference for a cell. Carries the preset id, template
 * version, and the prompt hash — the same triple
 * `PromptPresetReference` (providers/types.ts) requires on every
 * invocation, so the runner can build the request without re-deriving it.
 */
export type ExperimentPromptPreset = {
  readonly presetId: string;
  readonly templateVersion: string;
  /** `sha256:<64 hex>` — pins the rendered prompt bytes. */
  readonly promptHash: string;
};

/**
 * A single experiment cell: one controlled combination of the matrix
 * axes. The (model, provider) PAIR, prompt preset, policy version, target
 * locale, and fixture corpus ids are all REQUIRED — these are the axes
 * the ITOTORI-099 acceptance enumerates.
 */
export type ExperimentMatrixCell = {
  /** Unique within the config; stamped onto every artifact + finding. */
  readonly cellId: string;
  /** The (model, provider) PAIR this cell routes to. */
  readonly pair: ExperimentModelProviderPair;
  readonly promptPreset: ExperimentPromptPreset;
  /** Policy version under test (e.g. a pair-policy stage posture id). */
  readonly policyVersion: string;
  readonly targetLocale: string;
  /** Fixture corpus ids this cell runs over (one invocation each). */
  readonly fixtureCorpusIds: readonly string[];
  /**
   * Input classification of the cell's corpus. Drives the artifact
   * redaction decision: non-public classifications mark the artifact
   * `redacted`. Required so redaction is never left implicit.
   */
  readonly inputClassification: ProviderInputClassification;
};

/**
 * Explicit scope ceiling. Addresses the audit focus "Unbounded
 * experiment scope": the experiment author commits to a maximum cell and
 * invocation count in the checked-in config; the validator refuses a
 * config that exceeds them.
 */
export type ExperimentMatrixBounds = {
  readonly maxCells: number;
  readonly maxInvocations: number;
};

export type ExperimentMatrixConfig = {
  readonly schemaVersion: typeof EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly bounds: ExperimentMatrixBounds;
  readonly cells: readonly ExperimentMatrixCell[];
};

/**
 * Thrown by {@link assertExperimentMatrixConfig} when a config violates
 * the schema. The message names the offending field / cell so a malformed
 * config is easy to locate. A structured failure — never a silent repair.
 */
export class ExperimentMatrixConfigError extends Error {
  constructor(detail: string) {
    super(`ExperimentMatrixConfigError: ${detail}`);
    this.name = "ExperimentMatrixConfigError";
  }
}

const PROMPT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const VALID_INPUT_CLASSIFICATIONS: ReadonlySet<ProviderInputClassification> = new Set([
  "synthetic_public",
  "public",
  "private_corpus",
  "confidential",
  "secret",
]);

/**
 * Validate an experiment matrix config. Throws
 * {@link ExperimentMatrixConfigError} on the first violation. The checks
 * are intentionally strict: a missing pair half, an empty axis, a
 * duplicate cell id, or a scope-bound breach is a hard, typed failure —
 * the no-optionality / evidence-first posture forbids silently dropping
 * or repairing a malformed cell.
 */
export function assertExperimentMatrixConfig(
  value: unknown,
): asserts value is ExperimentMatrixConfig {
  const config = asObject(value, "config");
  if (config.schemaVersion !== EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION) {
    throw new ExperimentMatrixConfigError(
      `schemaVersion must be '${EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION}', got ${JSON.stringify(config.schemaVersion)}`,
    );
  }
  assertNonEmptyString(config.experimentId, "experimentId");

  const bounds = asObject(config.bounds, "bounds");
  assertPositiveInteger(bounds.maxCells, "bounds.maxCells");
  assertPositiveInteger(bounds.maxInvocations, "bounds.maxInvocations");

  if (!Array.isArray(config.cells) || config.cells.length === 0) {
    throw new ExperimentMatrixConfigError("cells must be a non-empty array");
  }
  if (config.cells.length > (bounds.maxCells as number)) {
    throw new ExperimentMatrixConfigError(
      `unbounded experiment scope: ${config.cells.length} cells exceeds declared bounds.maxCells=${bounds.maxCells}`,
    );
  }

  const seenCellIds = new Set<string>();
  let invocationCount = 0;
  for (let index = 0; index < config.cells.length; index += 1) {
    const cell = asObject(config.cells[index], `cells[${index}]`);
    assertNonEmptyString(cell.cellId, `cells[${index}].cellId`);
    const cellId = cell.cellId as string;
    if (seenCellIds.has(cellId)) {
      throw new ExperimentMatrixConfigError(`duplicate cellId '${cellId}'`);
    }
    seenCellIds.add(cellId);

    // The PAIR law: both halves required and non-empty. A model-only cell
    // is a P0 violation (feedback-model-provider-pair).
    const pair = asObject(cell.pair, `cells[${index}].pair`);
    assertNonEmptyString(pair.modelId, `cells[${index}].pair.modelId`);
    assertNonEmptyString(pair.providerId, `cells[${index}].pair.providerId`);

    const preset = asObject(cell.promptPreset, `cells[${index}].promptPreset`);
    assertNonEmptyString(preset.presetId, `cells[${index}].promptPreset.presetId`);
    assertNonEmptyString(preset.templateVersion, `cells[${index}].promptPreset.templateVersion`);
    assertNonEmptyString(preset.promptHash, `cells[${index}].promptPreset.promptHash`);
    if (!PROMPT_HASH_PATTERN.test(preset.promptHash as string)) {
      throw new ExperimentMatrixConfigError(
        `cells[${index}].promptPreset.promptHash must match sha256:<64 hex>, got ${JSON.stringify(preset.promptHash)}`,
      );
    }

    assertNonEmptyString(cell.policyVersion, `cells[${index}].policyVersion`);
    assertNonEmptyString(cell.targetLocale, `cells[${index}].targetLocale`);

    if (!Array.isArray(cell.fixtureCorpusIds) || cell.fixtureCorpusIds.length === 0) {
      throw new ExperimentMatrixConfigError(
        `cells[${index}].fixtureCorpusIds must be a non-empty array`,
      );
    }
    const seenFixtures = new Set<string>();
    for (let f = 0; f < cell.fixtureCorpusIds.length; f += 1) {
      assertNonEmptyString(cell.fixtureCorpusIds[f], `cells[${index}].fixtureCorpusIds[${f}]`);
      const fixtureId = cell.fixtureCorpusIds[f] as string;
      if (seenFixtures.has(fixtureId)) {
        throw new ExperimentMatrixConfigError(
          `cells[${index}] declares duplicate fixtureCorpusId '${fixtureId}'`,
        );
      }
      seenFixtures.add(fixtureId);
      invocationCount += 1;
    }

    if (
      typeof cell.inputClassification !== "string" ||
      !VALID_INPUT_CLASSIFICATIONS.has(cell.inputClassification as ProviderInputClassification)
    ) {
      throw new ExperimentMatrixConfigError(
        `cells[${index}].inputClassification must be one of ${[...VALID_INPUT_CLASSIFICATIONS].join(", ")}, got ${JSON.stringify(cell.inputClassification)}`,
      );
    }
  }

  if (invocationCount > (bounds.maxInvocations as number)) {
    throw new ExperimentMatrixConfigError(
      `unbounded experiment scope: ${invocationCount} total invocations exceeds declared bounds.maxInvocations=${bounds.maxInvocations}`,
    );
  }
}

/** Total (cell, fixtureCorpusId) invocations the config will realize. */
export function experimentInvocationCount(config: ExperimentMatrixConfig): number {
  return config.cells.reduce((total, cell) => total + cell.fixtureCorpusIds.length, 0);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExperimentMatrixConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExperimentMatrixConfigError(`${label} must be a non-empty string`);
  }
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ExperimentMatrixConfigError(
      `${label} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
}
