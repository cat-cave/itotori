import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type ConditionResult = { readonly passed: boolean; readonly reason: string };

export interface AdministerAccessObservation {
  readonly scenarios: ReadonlyMap<string, ConditionResult>;
  readonly invariants: ReadonlyMap<string, ConditionResult>;
  readonly observedFields: number;
  readonly allPass: boolean;
}

/** Absent DATABASE_URL is configuration failure, not a green proof. */
export class AdministerAccessDatabaseConfigurationError extends Error {
  readonly inputName = "DATABASE_URL";

  constructor() {
    super("required input is absent: DATABASE_URL");
    this.name = "AdministerAccessDatabaseConfigurationError";
  }
}

let cachedNormal: Promise<AdministerAccessObservation> | undefined;
let cachedMutant: Promise<AdministerAccessObservation> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function condition(value: unknown, label: string): ConditionResult {
  if (!isRecord(value) || typeof value.passed !== "boolean" || typeof value.reason !== "string") {
    throw new Error(`${label}-invalid`);
  }
  return { passed: value.passed, reason: value.reason };
}

function parseObservation(value: unknown): AdministerAccessObservation {
  if (!isRecord(value) || value.schema !== "itotori.identity-administer-access-observation.v1") {
    throw new Error("administer-access-observation-schema-invalid");
  }
  if (!isRecord(value.scenarios) || !isRecord(value.invariants)) {
    throw new Error("administer-access-observation-collections-invalid");
  }
  const scenarios = new Map<string, ConditionResult>();
  for (const [key, entry] of Object.entries(value.scenarios)) {
    scenarios.set(key, condition(entry, `scenario-${key}`));
  }
  const invariants = new Map<string, ConditionResult>();
  for (const [key, entry] of Object.entries(value.invariants)) {
    invariants.set(key, condition(entry, `invariant-${key}`));
  }
  if (
    typeof value.observedFields !== "number" ||
    !Number.isSafeInteger(value.observedFields) ||
    value.observedFields < 1
  ) {
    throw new Error("administer-access-observation-count-invalid");
  }
  return {
    scenarios,
    invariants,
    observedFields: value.observedFields,
    allPass: value.allPass === true,
  };
}

function failedObservation(reason: string): AdministerAccessObservation {
  const failed: ConditionResult = { passed: false, reason };
  return {
    scenarios: new Map(),
    invariants: new Map([
      ["crossTenantRefused", failed],
      ["auditRetained", failed],
      ["disableEndsSessions", failed],
      ["collisionFree", failed],
      ["noUndeclaredAuthority", failed],
      ["protectedActionsEnforced", failed],
      ["foreignResourcesUnavailable", failed],
    ]),
    observedFields: 0,
    allPass: false,
  };
}

function productRoot(repositoryRoot: string, fixedSuccess: boolean): string {
  return fixedSuccess
    ? resolve(repositoryRoot, ".tmp", "behavior-proof", "administer-access-fixed-success-mutation")
    : repositoryRoot;
}

function observeProduct(
  repositoryRoot: string,
  fixedSuccess: boolean,
): AdministerAccessObservation {
  const root = productRoot(repositoryRoot, fixedSuccess);
  const boundary = resolve(
    root,
    "packages/itotori-db/scripts/identity-administer-access-boundary.mjs",
  );
  const result = spawnSync(process.execPath, [boundary], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    env: process.env,
  });
  if (result.status !== 0 || result.signal !== null) {
    return failedObservation("administer-access-product-boundary-failed");
  }
  try {
    return parseObservation(JSON.parse(result.stdout));
  } catch {
    return failedObservation("administer-access-product-boundary-invalid");
  }
}

export async function observeAdministerAccessBehavior(
  repositoryRoot: string,
  fixedSuccess = false,
): Promise<AdministerAccessObservation> {
  if (!process.env.DATABASE_URL) throw new AdministerAccessDatabaseConfigurationError();
  if (fixedSuccess) {
    cachedMutant ??= Promise.resolve(observeProduct(repositoryRoot, true));
    return await cachedMutant;
  }
  cachedNormal ??= Promise.resolve(observeProduct(repositoryRoot, false));
  return await cachedNormal;
}

export function invariantResult(
  observation: AdministerAccessObservation,
  name: string,
): ConditionResult {
  return (
    observation.invariants.get(name) ?? {
      passed: false,
      reason: "administer-access-invariant-missing",
    }
  );
}

export function scenarioResult(
  observation: AdministerAccessObservation,
  name: string,
): ConditionResult {
  return (
    observation.scenarios.get(name) ?? {
      passed: false,
      reason: "administer-access-scenario-missing",
    }
  );
}
