import type { LlmRevisionRef } from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import { buildContextSnapshotInput, buildFactSnapshot } from "../prepass/index.js";
import {
  parseNarrativeStructure,
  SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
} from "../structure/index.js";

export type ProductionLocalizationConfig = {
  readonly targetLocale: string;
  readonly schemaHash: `sha256:${string}`;
  readonly decodeRevisionHash: `sha256:${string}`;
  readonly glossaryRevisionHash: `sha256:${string}`;
  readonly styleRevisionHash: `sha256:${string}`;
  readonly maxAttemptExposureUsd: string;
  readonly confirmedCostCapUsd: string;
};

export function productionLocalizationConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProductionLocalizationConfig {
  requireEnvironmentValue(env, "OPENROUTER_API_KEY");
  return {
    targetLocale: requireEnvironmentValue(env, "ITOTORI_TARGET_LOCALE"),
    schemaHash: requireSha256EnvironmentValue(env, "ITOTORI_DRAFT_SCHEMA_HASH"),
    decodeRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_DECODE_REVISION_HASH"),
    glossaryRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_GLOSSARY_REVISION_HASH"),
    styleRevisionHash: requireSha256EnvironmentValue(env, "ITOTORI_STYLE_REVISION_HASH"),
    maxAttemptExposureUsd: requireDecimalEnvironmentValue(
      env,
      "ITOTORI_LOCALIZE_MAX_ATTEMPT_EXPOSURE_USD",
    ),
    confirmedCostCapUsd: requireDecimalEnvironmentValue(env, "ITOTORI_LOCALIZE_COST_CAP_USD"),
  };
}

export function contextSnapshotInputForRun(
  input: {
    readonly structureJson: unknown;
    readonly bridge: BridgeBundleV02;
  },
  config: ProductionLocalizationConfig,
  sourceLanguage: string,
) {
  const structure = parseNarrativeStructure(
    input.structureJson,
    SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS,
  );
  const factSnapshot = buildFactSnapshot(structure, input.bridge);
  return buildContextSnapshotInput({
    factSnapshot,
    sourceLanguage,
    decodeRef: revisionRef(config.decodeRevisionHash),
    glossaryRef: revisionRef(config.glossaryRevisionHash),
    styleRef: revisionRef(config.styleRevisionHash),
  });
}

export function decimalUsdToExactMicros(value: string, label: string): number {
  const micros = decimalUsdToMicros(value, label);
  if (micros.remainder !== 0) {
    throw new Error(`${label} must be representable in whole micros-USD for a project run`);
  }
  return micros.floor;
}

function revisionRef(contentHash: `sha256:${string}`): LlmRevisionRef {
  return {
    revisionId: contentHash.slice("sha256:".length),
    contentHash,
  };
}

function decimalUsdToMicros(value: string, label: string): { floor: number; remainder: number } {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null) throw new Error(`${label} must be a non-negative decimal USD value`);
  const whole = Number(match[1]);
  const fraction = match[2] ?? "";
  if (!Number.isSafeInteger(whole) || fraction.length > 18) {
    throw new Error(`${label} is outside the supported project-run cost range`);
  }
  const microFraction = `${fraction.slice(0, 6)}${"0".repeat(Math.max(0, 6 - fraction.length))}`;
  const floor = whole * 1_000_000 + Number(microFraction);
  if (!Number.isSafeInteger(floor)) {
    throw new Error(`${label} is outside the supported project-run cost range`);
  }
  return { floor, remainder: Number(fraction.slice(6) || "0") };
}

function requireEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`localize production configuration requires ${name}`);
  }
  return value;
}

function requireSha256EnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): `sha256:${string}` {
  const value = requireEnvironmentValue(env, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`localize production configuration requires ${name} to be a sha256 hash`);
  }
  return value as `sha256:${string}`;
}

function requireDecimalEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requireEnvironmentValue(env, name);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(value)) {
    throw new Error(
      `localize production configuration requires ${name} to be an exact decimal USD`,
    );
  }
  return value;
}
