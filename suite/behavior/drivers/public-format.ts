import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type PublicFormatCondition =
  | "typed-incompatibility"
  | "one-negotiated-meaning"
  | "no-persisted-effect"
  | "version-agreement";

export type PublicFormatConditionResult = { readonly passed: boolean; readonly reason: string };

export interface PublicFormatObservation {
  readonly currentAccepted: boolean;
  readonly typedIncompatibility: boolean;
  readonly allBoundariesAgree: boolean;
  readonly noPersistedEffect: boolean;
  readonly versionAgreement: boolean;
  readonly observedVersion: string;
  readonly supportedVersion: string;
  readonly migrationPath: string;
  readonly observedFields: number;
}

interface BoundaryObservation {
  readonly schema: "itotori.public-format-observation.v1";
  readonly currentAccepted: boolean;
  readonly typedIncompatibility: boolean;
  readonly allBoundariesAgree: boolean;
  readonly versionAgreement: boolean;
  readonly fixturesUnchanged: boolean;
  readonly observedVersion: string;
  readonly supportedVersion: string;
  readonly migrationPath: string;
  readonly observedFields: number;
}

const CURRENT_FIXTURE = "packages/localization-bridge-schema/test/examples/bridge-v0.2.json";
const LEGACY_FIXTURE =
  "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-schema-version-0.1.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}-invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}-invalid`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function parseObservation(value: unknown): BoundaryObservation {
  if (!isRecord(value) || value.schema !== "itotori.public-format-observation.v1") {
    throw new Error("public-format-observation-invalid");
  }
  return {
    schema: "itotori.public-format-observation.v1",
    currentAccepted: boolean(value.currentAccepted, "public-format-current-accepted"),
    typedIncompatibility: boolean(
      value.typedIncompatibility,
      "public-format-typed-incompatibility",
    ),
    allBoundariesAgree: boolean(value.allBoundariesAgree, "public-format-boundary-agreement"),
    versionAgreement: boolean(value.versionAgreement, "public-format-version-agreement"),
    fixturesUnchanged: boolean(value.fixturesUnchanged, "public-format-fixtures-unchanged"),
    observedVersion: text(value.observedVersion, "public-format-observed-version"),
    supportedVersion: text(value.supportedVersion, "public-format-supported-version"),
    migrationPath: text(value.migrationPath, "public-format-migration-path"),
    observedFields: count(value.observedFields, "public-format-observed-fields"),
  };
}

function failedObservation(): PublicFormatObservation {
  return {
    currentAccepted: false,
    typedIncompatibility: false,
    allBoundariesAgree: false,
    noPersistedEffect: false,
    versionAgreement: false,
    observedVersion: "",
    supportedVersion: "",
    migrationPath: "",
    observedFields: 0,
  };
}

function effectSnapshot(root: string): string {
  const entries = readdirSync(root).toSorted();
  return entries
    .map((entry) => `${entry}\0${readFileSync(resolve(root, entry), "utf8")}`)
    .join("\n");
}

function modulePath(repositoryRoot: string, fixedSuccess: boolean): string {
  return fixedSuccess
    ? resolve(
        repositoryRoot,
        ".tmp",
        "behavior-proof",
        "public-format-fixed-success-mutation",
        "packages",
        "localization-bridge-schema",
        "dist",
        "index.js",
      )
    : resolve(repositoryRoot, "packages", "localization-bridge-schema", "dist", "index.js");
}

function boundaryPath(repositoryRoot: string): string {
  return resolve(
    repositoryRoot,
    ".tmp",
    "behavior-proof",
    "glue",
    "product",
    "suite",
    "behavior",
    "product",
    "public-format-boundary.js",
  );
}

export function observePublicFormatBehavior(
  repositoryRoot: string,
  fixedSuccess = false,
): PublicFormatObservation {
  const effectRoot = mkdtempSync(join(tmpdir(), "behavior-public-format-"));
  try {
    writeFileSync(resolve(effectRoot, "sentinel"), "public-format-effect-sentinel\n", "utf8");
    const before = effectSnapshot(effectRoot);
    const result = spawnSync(
      process.execPath,
      [
        boundaryPath(repositoryRoot),
        JSON.stringify({
          modulePath: modulePath(repositoryRoot, fixedSuccess),
          currentFixturePath: resolve(repositoryRoot, CURRENT_FIXTURE),
          legacyFixturePath: resolve(repositoryRoot, LEGACY_FIXTURE),
        }),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const noPersistedEffect = before === effectSnapshot(effectRoot);
    if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
      return failedObservation();
    }
    let observed: BoundaryObservation;
    try {
      observed = parseObservation(JSON.parse(result.stdout));
    } catch {
      return failedObservation();
    }
    return { ...observed, noPersistedEffect: noPersistedEffect && observed.fixturesUnchanged };
  } finally {
    rmSync(effectRoot, { force: true, recursive: true });
  }
}

export function publicFormatOutcomeResult(
  observation: PublicFormatObservation,
  expectedOutcome: string,
): PublicFormatConditionResult {
  switch (expectedOutcome) {
    case "one equivalent migrated value":
      return {
        passed:
          observation.currentAccepted &&
          observation.typedIncompatibility &&
          observation.versionAgreement,
        reason: "public-format-supported-migration-not-negotiated",
      };
    case "named incompatibility":
      return {
        passed: observation.typedIncompatibility,
        reason: "public-format-incompatible-version-not-typed",
      };
    case "one accepted meaning":
      return {
        passed: observation.currentAccepted && observation.allBoundariesAgree,
        reason: "public-format-current-version-has-divergent-meaning",
      };
    case "exact client refusal before any effect":
      return {
        passed: observation.typedIncompatibility && observation.noPersistedEffect,
        reason: "public-format-client-refusal-not-effect-free",
      };
    case "the exact schema-valid outcome":
      return {
        passed: observation.currentAccepted && observation.versionAgreement,
        reason: "public-format-current-schema-outcome-invalid",
      };
    default:
      return { passed: false, reason: "public-format-expected-outcome-unrecognized" };
  }
}

export function publicFormatConditionResult(
  observation: PublicFormatObservation,
  condition: PublicFormatCondition,
): PublicFormatConditionResult {
  switch (condition) {
    case "typed-incompatibility":
      return {
        passed:
          observation.typedIncompatibility &&
          observation.observedVersion === "0.1.0" &&
          observation.supportedVersion === "0.2.0" &&
          observation.migrationPath.length > 0,
        reason: "public-format-incompatible-version-not-typed",
      };
    case "one-negotiated-meaning":
      return {
        passed: observation.allBoundariesAgree,
        reason: "public-format-boundaries-disagree",
      };
    case "no-persisted-effect":
      return {
        passed: observation.noPersistedEffect,
        reason: "public-format-rejection-persisted-an-effect",
      };
    case "version-agreement":
      return {
        passed: observation.versionAgreement,
        reason: "public-format-version-registry-disagrees",
      };
  }
}
