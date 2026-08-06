import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type ConditionResult = { readonly passed: boolean; readonly reason: string };

export interface AuthenticateSessionObservation {
  readonly scenarios: ReadonlyMap<string, ConditionResult>;
  readonly invariants: ReadonlyMap<string, ConditionResult>;
  readonly observedFields: number;
  readonly allPass: boolean;
}

/** Absent DATABASE_URL is configuration failure, not a green proof. */
export class AuthenticateSessionDatabaseConfigurationError extends Error {
  readonly inputName = "DATABASE_URL";

  constructor() {
    super("required input is absent: DATABASE_URL");
    this.name = "AuthenticateSessionDatabaseConfigurationError";
  }
}

let cachedNormal: Promise<AuthenticateSessionObservation> | undefined;
let cachedMutant: Promise<AuthenticateSessionObservation> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function condition(value: unknown, label: string): ConditionResult {
  if (!isRecord(value) || typeof value.passed !== "boolean" || typeof value.reason !== "string") {
    throw new Error(`${label}-invalid`);
  }
  return { passed: value.passed, reason: value.reason };
}

function parseObservation(value: unknown): AuthenticateSessionObservation {
  if (!isRecord(value) || value.schema !== "itotori.identity-authenticate-session-observation.v1") {
    throw new Error("authenticate-session-observation-schema-invalid");
  }
  if (!isRecord(value.scenarios) || !isRecord(value.invariants)) {
    throw new Error("authenticate-session-observation-collections-invalid");
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
    throw new Error("authenticate-session-observation-count-invalid");
  }
  return {
    scenarios,
    invariants,
    observedFields: value.observedFields,
    allPass: value.allPass === true,
  };
}

function failedObservation(reason: string): AuthenticateSessionObservation {
  const failed: ConditionResult = { passed: false, reason };
  return {
    scenarios: new Map(),
    invariants: new Map([
      ["opaqueCredential", failed],
      ["forgedExposesNoSession", failed],
      ["revokedNoLongerAuthorizes", failed],
    ]),
    observedFields: 0,
    allPass: false,
  };
}

function productRoot(repositoryRoot: string, fixedSuccess: boolean): string {
  return fixedSuccess
    ? resolve(
        repositoryRoot,
        ".tmp",
        "behavior-proof",
        "authenticate-session-fixed-success-mutation",
      )
    : repositoryRoot;
}

function observeProduct(
  repositoryRoot: string,
  fixedSuccess: boolean,
): AuthenticateSessionObservation {
  const root = productRoot(repositoryRoot, fixedSuccess);
  const boundary = resolve(
    root,
    "packages/itotori-db/scripts/identity-authenticate-session-boundary.mjs",
  );
  const result = spawnSync(process.execPath, [boundary], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    env: process.env,
  });
  if (result.status !== 0 || result.signal !== null) {
    return failedObservation("authenticate-session-product-boundary-failed");
  }
  try {
    return parseObservation(JSON.parse(result.stdout));
  } catch {
    return failedObservation("authenticate-session-product-boundary-invalid");
  }
}

export async function observeAuthenticateSessionBehavior(
  repositoryRoot: string,
  fixedSuccess = false,
): Promise<AuthenticateSessionObservation> {
  if (!process.env.DATABASE_URL) throw new AuthenticateSessionDatabaseConfigurationError();
  if (fixedSuccess) {
    cachedMutant ??= Promise.resolve(observeProduct(repositoryRoot, true));
    return await cachedMutant;
  }
  cachedNormal ??= Promise.resolve(observeProduct(repositoryRoot, false));
  return await cachedNormal;
}

export function invariantResult(
  observation: AuthenticateSessionObservation,
  name: string,
): ConditionResult {
  return (
    observation.invariants.get(name) ?? {
      passed: false,
      reason: "authenticate-session-invariant-missing",
    }
  );
}

export function scenarioResult(
  observation: AuthenticateSessionObservation,
  name: string,
): ConditionResult {
  return (
    observation.scenarios.get(name) ?? {
      passed: false,
      reason: "authenticate-session-scenario-missing",
    }
  );
}
