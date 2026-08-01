import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type ArtifactCondition =
  | "reload"
  | "authorized-retention"
  | "expiry"
  | "collision"
  | "mutation"
  | "incompatible-version"
  | "audit"
  | "lineage"
  | "prune";

export type ArtifactConditionResult = { passed: boolean; reason: string };
export type ImmutableArtifactObservation = {
  readonly actions: ReadonlyMap<string, ArtifactConditionResult>;
  readonly conditions: ReadonlyMap<ArtifactCondition, ArtifactConditionResult>;
  readonly observedFields: number;
};

/** The behavior ledger cannot turn an absent DB into a normal failed proof. */
export class ArtifactBehaviorDatabaseConfigurationError extends Error {
  readonly inputName = "DATABASE_URL";

  constructor() {
    super("required input is absent: DATABASE_URL");
    this.name = "ArtifactBehaviorDatabaseConfigurationError";
  }
}

let cachedObservation: Promise<ImmutableArtifactObservation> | undefined;
let cachedFixedSuccessObservation: Promise<ImmutableArtifactObservation> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}-invalid`);
  return value;
}

function conditionResult(value: unknown, label: string): ArtifactConditionResult {
  const parsed = record(value, label);
  return {
    passed: boolean(parsed.passed, `${label}-passed`),
    reason: text(parsed.reason, `${label}-reason`),
  };
}

function isArtifactCondition(value: string): value is ArtifactCondition {
  return (
    value === "reload" ||
    value === "authorized-retention" ||
    value === "expiry" ||
    value === "collision" ||
    value === "mutation" ||
    value === "incompatible-version" ||
    value === "audit" ||
    value === "lineage" ||
    value === "prune"
  );
}

function parseObservation(value: unknown): ImmutableArtifactObservation {
  const parsed = record(value, "artifact-observation");
  if (parsed.schema !== "itotori.immutable-artifact-observation.v1") {
    throw new Error("artifact-observation-schema-invalid");
  }
  if (!Array.isArray(parsed.actions) || !Array.isArray(parsed.conditions)) {
    throw new Error("artifact-observation-collections-invalid");
  }
  const actions = new Map<string, ArtifactConditionResult>();
  for (const [index, raw] of parsed.actions.entries()) {
    const entry = record(raw, `artifact-action-${index}`);
    const action = text(entry.action, `artifact-action-${index}-name`);
    if (actions.has(action)) throw new Error(`artifact-action-duplicate:${action}`);
    actions.set(action, conditionResult(entry, `artifact-action-${index}`));
  }
  const conditions = new Map<ArtifactCondition, ArtifactConditionResult>();
  for (const [index, raw] of parsed.conditions.entries()) {
    const entry = record(raw, `artifact-condition-${index}`);
    const name = text(entry.name, `artifact-condition-${index}-name`);
    if (!isArtifactCondition(name) || conditions.has(name)) {
      throw new Error(`artifact-condition-name-invalid:${name}`);
    }
    conditions.set(name, conditionResult(entry, `artifact-condition-${index}`));
  }
  const observedFields = parsed.observedFields;
  if (
    typeof observedFields !== "number" ||
    !Number.isSafeInteger(observedFields) ||
    observedFields < 1
  ) {
    throw new Error("artifact-observation-count-invalid");
  }
  return { actions, conditions, observedFields };
}

function failedObservation(reason: string): ImmutableArtifactObservation {
  const failed: ArtifactConditionResult = { passed: false, reason };
  return {
    actions: new Map(),
    conditions: new Map<ArtifactCondition, ArtifactConditionResult>([
      ["reload", failed],
      ["authorized-retention", failed],
      ["expiry", failed],
      ["collision", failed],
      ["mutation", failed],
      ["incompatible-version", failed],
      ["audit", failed],
      ["lineage", failed],
      ["prune", failed],
    ]),
    observedFields: 0,
  };
}

function observeArtifactProduct(
  repositoryRoot: string,
  fixedSuccess: boolean,
): ImmutableArtifactObservation {
  const productRoot = fixedSuccess
    ? resolve(repositoryRoot, ".tmp", "behavior-proof", "immutable-artifact-fixed-success-mutation")
    : repositoryRoot;
  const boundary = resolve(
    productRoot,
    "packages/itotori-db/scripts/immutable-artifact-behavior-boundary.mjs",
  );
  const result = spawnSync(process.execPath, [boundary], {
    cwd: productRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    return failedObservation("artifact-product-boundary-failed");
  }
  try {
    return parseObservation(JSON.parse(result.stdout));
  } catch {
    return failedObservation("artifact-product-boundary-invalid");
  }
}

export async function observeImmutableArtifactBehavior(
  repositoryRoot: string,
  fixedSuccess = false,
): Promise<ImmutableArtifactObservation> {
  if (!process.env.DATABASE_URL) throw new ArtifactBehaviorDatabaseConfigurationError();
  if (fixedSuccess) {
    cachedFixedSuccessObservation ??= Promise.resolve(observeArtifactProduct(repositoryRoot, true));
    return await cachedFixedSuccessObservation;
  }
  cachedObservation ??= Promise.resolve(observeArtifactProduct(repositoryRoot, false));
  return await cachedObservation;
}

export function artifactActionResult(
  observation: ImmutableArtifactObservation,
  action: string,
): ArtifactConditionResult {
  return (
    observation.actions.get(action) ?? {
      passed: false,
      reason: "artifact-action-driver-missing-observation",
    }
  );
}

export function artifactConditionResult(
  observation: ImmutableArtifactObservation,
  name: ArtifactCondition,
): ArtifactConditionResult {
  return (
    observation.conditions.get(name) ?? {
      passed: false,
      reason: "artifact-condition-driver-missing-observation",
    }
  );
}
