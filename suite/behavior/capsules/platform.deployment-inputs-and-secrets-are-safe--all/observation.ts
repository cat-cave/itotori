import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DeploymentScenarioObservation {
  readonly id: string;
  readonly startup: string;
  readonly exactAcceptedConfiguration: boolean;
  readonly noPartialReadiness: boolean;
  readonly preReadinessRefusal: boolean;
  readonly secretRedacted: boolean;
  readonly suppliedFileUntouched: boolean;
  readonly wrapperSecretFileRemoved: boolean;
  readonly diagnosticCode: string | null;
  readonly documentedSettingCount: number;
}

export interface DeploymentObservation {
  readonly configurationSchemaCount: number;
  readonly missingRequiredDatabaseUrl: {
    readonly typed: boolean;
    readonly preReadiness: boolean;
    readonly code: string | null;
    readonly inputName: string | null;
    readonly configWrites: number;
  };
  readonly negativeControls: {
    readonly unknownRefusedBeforeReadiness: boolean;
    readonly malformedRefusedBeforeReadiness: boolean;
    readonly insecureRefusedBeforeReadiness: boolean;
    readonly diagnosticsRedacted: boolean;
  };
  readonly scenarios: readonly DeploymentScenarioObservation[];
  readonly observedFields: number;
}

interface Call {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let normal: Promise<DeploymentObservation> | undefined;
let mutated: Promise<DeploymentObservation> | undefined;
let builtCliFor: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isScenario(value: unknown): value is DeploymentScenarioObservation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.startup === "string" &&
    typeof value.exactAcceptedConfiguration === "boolean" &&
    typeof value.noPartialReadiness === "boolean" &&
    typeof value.preReadinessRefusal === "boolean" &&
    typeof value.secretRedacted === "boolean" &&
    typeof value.suppliedFileUntouched === "boolean" &&
    typeof value.wrapperSecretFileRemoved === "boolean" &&
    isNullableString(value.diagnosticCode) &&
    typeof value.documentedSettingCount === "number"
  );
}

function isObservation(value: unknown): value is DeploymentObservation {
  if (!isRecord(value) || typeof value.configurationSchemaCount !== "number") return false;
  const missing = value.missingRequiredDatabaseUrl;
  const controls = value.negativeControls;
  return (
    isRecord(missing) &&
    typeof missing.typed === "boolean" &&
    typeof missing.preReadiness === "boolean" &&
    isNullableString(missing.code) &&
    isNullableString(missing.inputName) &&
    typeof missing.configWrites === "number" &&
    isRecord(controls) &&
    typeof controls.unknownRefusedBeforeReadiness === "boolean" &&
    typeof controls.malformedRefusedBeforeReadiness === "boolean" &&
    typeof controls.insecureRefusedBeforeReadiness === "boolean" &&
    typeof controls.diagnosticsRedacted === "boolean" &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every(isScenario) &&
    typeof value.observedFields === "number"
  );
}

function run(command: string, args: readonly string[], cwd: string): Call {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
    "deployment-inputs-and-secrets-boundary.js",
  );
}

function mutatedModulePath(repositoryRoot: string): string {
  return resolve(
    repositoryRoot,
    ".tmp",
    "behavior-proof",
    "deployment-inputs-fixed-success-mutation",
    "apps",
    "itotori",
    "src",
    "config",
    "deployment-config-file.js",
  );
}

function request(repositoryRoot: string, fixedSuccess: boolean): string {
  if (!fixedSuccess) return "{}";
  const modulePath = mutatedModulePath(repositoryRoot);
  if (!existsSync(modulePath)) throw new Error("deployment-inputs-mutation-module-missing");
  return JSON.stringify({ modulePath });
}

function ensureBuiltCli(repositoryRoot: string): void {
  if (builtCliFor === repositoryRoot) return;
  const build = run("pnpm", ["exec", "tsc", "-p", "apps/itotori/tsconfig.json"], repositoryRoot);
  if (build.status !== 0 || build.signal !== null) {
    throw new Error(`deployment-inputs-cli-build-failed:${String(build.status)}`);
  }
  builtCliFor = repositoryRoot;
}

function collect(repositoryRoot: string, fixedSuccess: boolean): DeploymentObservation {
  ensureBuiltCli(repositoryRoot);
  const call = run(
    process.execPath,
    [boundaryPath(repositoryRoot), request(repositoryRoot, fixedSuccess)],
    repositoryRoot,
  );
  if (call.status !== 0 || call.signal !== null || call.stderr.length > 0) {
    throw new Error(`deployment-inputs-boundary-failed:${String(call.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.stdout);
  } catch {
    throw new Error("deployment-inputs-boundary-invalid-json");
  }
  if (!isObservation(parsed)) throw new Error("deployment-inputs-boundary-invalid-observation");
  return parsed;
}

/** Observes real typed deployment loaders through the emitted product boundary. */
export function observeDeploymentInputs(
  repositoryRoot: string,
  fixedSuccess: boolean,
): Promise<DeploymentObservation> {
  if (fixedSuccess) {
    mutated ??= Promise.resolve().then(() => collect(repositoryRoot, true));
    return mutated;
  }
  normal ??= Promise.resolve().then(() => collect(repositoryRoot, false));
  return normal;
}
