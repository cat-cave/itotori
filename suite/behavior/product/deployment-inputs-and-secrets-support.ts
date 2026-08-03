import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as currentConfiguration from "../../../apps/itotori/src/config/deployment-config-file.js";
import * as currentEnvironment from "../../../apps/itotori/src/env/external-env-file.js";
import { withTemporarySecretFile } from "../../../apps/itotori/src/env/temporary-secret-file.js";

export type StringEnvironment = Record<string, string | undefined>;
export type ScenarioId =
  | "001"
  | "002"
  | "003"
  | "004"
  | "005"
  | "006"
  | "007"
  | "008"
  | "009"
  | "010";
export type Startup = "ready" | "refused" | "interrupted";
export type ConfigEntry = readonly [string, string];

export interface ConfigurationModule {
  readonly DEPLOYMENT_CONFIG_SCHEMA: readonly { readonly name: string }[];
  loadDeploymentConfigurationFile(input: { readonly args: readonly string[] }): {
    readonly path: string | undefined;
    readonly values: ReadonlyMap<string, string>;
  };
}

export interface EnvironmentModule {
  loadExternalEnvFile(input: {
    readonly args: readonly string[];
    readonly env: StringEnvironment;
  }): {
    readonly path: string | undefined;
    readonly appliedKeys: readonly string[];
    readonly skippedAlreadySetKeys: readonly string[];
  };
}

export interface Request {
  readonly modulePath: string | undefined;
  readonly envModulePath: string | undefined;
}

export interface Refusal {
  readonly code: string | null;
  readonly redacted: boolean;
}

export interface NegativeControls {
  readonly unknownRefusedBeforeReadiness: boolean;
  readonly malformedRefusedBeforeReadiness: boolean;
  readonly insecureRefusedBeforeReadiness: boolean;
  readonly diagnosticsRedacted: boolean;
}

export interface DeploymentInputScenarioObservation {
  readonly id: ScenarioId;
  readonly startup: Startup;
  readonly exactAcceptedConfiguration: boolean;
  readonly noPartialReadiness: boolean;
  readonly preReadinessRefusal: boolean;
  readonly secretRedacted: boolean;
  readonly suppliedFileUntouched: boolean;
  readonly wrapperSecretFileRemoved: boolean;
  readonly diagnosticCode: string | null;
  readonly documentedSettingCount: number;
}

interface ApplicationCliModule {
  main(args: string[]): Promise<void>;
}

interface RequiredInputModule {
  readonly RequiredDeploymentInputError: new () => Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApplicationCliModule(value: unknown): value is ApplicationCliModule {
  return isRecord(value) && typeof value.main === "function";
}

function isRequiredInputModule(value: unknown): value is RequiredInputModule {
  return isRecord(value) && typeof value.RequiredDeploymentInputError === "function";
}

function optionalPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

export function request(value: string | undefined): Request {
  if (value === undefined) return { modulePath: undefined, envModulePath: undefined };
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("deployment-inputs-request-invalid");
  return {
    modulePath: optionalPath(parsed.modulePath, "deployment-inputs-module-path"),
    envModulePath: optionalPath(parsed.envModulePath, "deployment-inputs-env-module-path"),
  };
}

function isConfigurationModule(value: unknown): value is ConfigurationModule {
  return (
    isRecord(value) &&
    Array.isArray(value.DEPLOYMENT_CONFIG_SCHEMA) &&
    value.DEPLOYMENT_CONFIG_SCHEMA.every(
      (setting) => isRecord(setting) && typeof setting.name === "string" && setting.name.length > 0,
    ) &&
    typeof value.loadDeploymentConfigurationFile === "function"
  );
}

function isEnvironmentModule(value: unknown): value is EnvironmentModule {
  return isRecord(value) && typeof value.loadExternalEnvFile === "function";
}

export async function loadConfiguration(input: Request): Promise<ConfigurationModule> {
  const module: unknown =
    input.modulePath === undefined
      ? currentConfiguration
      : await import(pathToFileURL(input.modulePath).href);
  if (!isConfigurationModule(module)) throw new Error("deployment-config-module-invalid");
  return module;
}

export async function loadEnvironment(input: Request): Promise<EnvironmentModule> {
  const module: unknown =
    input.envModulePath === undefined
      ? currentEnvironment
      : await import(pathToFileURL(input.envModulePath).href);
  if (!isEnvironmentModule(module)) throw new Error("deployment-env-module-invalid");
  return module;
}

export function writePrivate(path: string, contents: string | Uint8Array): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function encodeQuoted(value: string): string {
  let encoded = '"';
  for (const character of value) {
    encoded +=
      character === "\\" || character === '"' || character === "$" || character === " "
        ? `\\${character}`
        : character;
  }
  return `${encoded}"`;
}

export function fullConfiguration(configuration: ConfigurationModule): readonly ConfigEntry[] {
  return configuration.DEPLOYMENT_CONFIG_SCHEMA.map((setting, index) => [
    setting.name,
    `documented-value-${String(index + 1).padStart(2, "0")}`,
  ]);
}

export function configurationText(entries: readonly ConfigEntry[]): string {
  return entries.map(([name, value]) => `${name}=${value}`).join("\n");
}

export function exactEntries(
  values: ReadonlyMap<string, string>,
  entries: readonly ConfigEntry[],
): boolean {
  return (
    values.size === entries.length && entries.every(([name, value]) => values.get(name) === value)
  );
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export function refusal(action: () => unknown, secret: string): Refusal {
  try {
    action();
    return { code: null, redacted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: errorCode(error), redacted: !message.includes(secret) };
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function negativeControls(
  root: string,
  configuration: ConfigurationModule,
  environment: EnvironmentModule,
): NegativeControls {
  const secret = "negative-control-secret-not-for-output";
  const unknownPath = join(root, "unknown.conf");
  writePrivate(unknownPath, `application.profile=valid\nunknown.setting=${secret}`);
  const unknown = refusal(
    () =>
      configuration.loadDeploymentConfigurationFile({ args: ["--deployment-config", unknownPath] }),
    secret,
  );
  const malformedPath = join(root, "malformed.env");
  writePrivate(malformedPath, `OPENROUTER_API_KEY=${secret}\nnot-an-assignment`);
  const malformedEnv: StringEnvironment = {};
  const malformed = refusal(
    () =>
      environment.loadExternalEnvFile({ args: ["--env-file", malformedPath], env: malformedEnv }),
    secret,
  );
  const insecurePath = join(root, "insecure.env");
  writeFileSync(insecurePath, `OPENROUTER_API_KEY=${secret}`, { mode: 0o644 });
  chmodSync(insecurePath, 0o644);
  const insecureEnv: StringEnvironment = {};
  const insecure = refusal(
    () => environment.loadExternalEnvFile({ args: ["--env-file", insecurePath], env: insecureEnv }),
    secret,
  );
  return {
    unknownRefusedBeforeReadiness: unknown.code === "unknown-setting",
    malformedRefusedBeforeReadiness:
      malformed.code === "malformed-assignment" && malformedEnv.OPENROUTER_API_KEY === undefined,
    insecureRefusedBeforeReadiness:
      insecure.code === "source-permissions-insecure" &&
      insecureEnv.OPENROUTER_API_KEY === undefined,
    diagnosticsRedacted: unknown.redacted && malformed.redacted && insecure.redacted,
  };
}

export function wrapperSecretFileRemoved(): boolean {
  let temporaryPath = "";
  let interrupted = false;
  try {
    withTemporarySecretFile(
      {
        contents: "wrapper-secret-not-for-output",
        directoryPrefix: "itotori-deployment-wrapper-",
        fileName: "secret.env",
      },
      (path) => {
        temporaryPath = path;
        if (!existsSync(path)) throw new Error("wrapper-secret-file-not-created");
        throw new Error("wrapper-interrupted");
      },
    );
  } catch (error) {
    interrupted = error instanceof Error && error.message === "wrapper-interrupted";
  }
  return interrupted && temporaryPath.length > 0 && !existsSync(temporaryPath);
}

export async function missingRequiredDatabaseUrl(): Promise<{
  readonly typed: boolean;
  readonly preReadiness: boolean;
  readonly code: string | null;
  readonly inputName: string | null;
  readonly configWrites: number;
}> {
  const repositoryRoot = process.cwd();
  const priorWorkingDirectory = repositoryRoot;
  const observationRoot = mkdtempSync(join(tmpdir(), "itotori-missing-database-input-"));
  const isolatedEnvRoot = mkdtempSync(join(tmpdir(), "itotori-empty-env-file-"));
  const isolatedEnvFile = join(isolatedEnvRoot, "empty.env");
  const priorDatabaseUrl = process.env.DATABASE_URL;
  let typed = false;
  let code: string | null = null;
  let inputName: string | null = null;
  let configWrites = 0;
  writeFileSync(isolatedEnvFile, "", { mode: 0o600 });
  chmodSync(isolatedEnvFile, 0o600);
  delete process.env.DATABASE_URL;
  let inputModule: RequiredInputModule | undefined;
  try {
    process.chdir(observationRoot);
    const appDist = resolve(repositoryRoot, "apps", "itotori", "dist");
    const [cliModule, loadedInputModule] = await Promise.all([
      import(pathToFileURL(join(appDist, "cli.js")).href),
      import(pathToFileURL(join(appDist, "deployment-required-input.js")).href),
    ]);
    if (!isApplicationCliModule(cliModule) || !isRequiredInputModule(loadedInputModule)) {
      throw new Error("deployment-cli-module-invalid");
    }
    inputModule = loadedInputModule;
    await cliModule.main(["db-migrate", "--env-file", isolatedEnvFile]);
  } catch (error) {
    if (inputModule !== undefined && error instanceof inputModule.RequiredDeploymentInputError) {
      typed = true;
      code = "missing-required-deployment-input";
      inputName = "DATABASE_URL";
    }
  } finally {
    configWrites = readdirSync(observationRoot).length;
    process.chdir(priorWorkingDirectory);
    rmSync(observationRoot, { force: true, recursive: true });
    rmSync(isolatedEnvRoot, { force: true, recursive: true });
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  }
  return {
    typed,
    preReadiness: typed && configWrites === 0,
    code,
    inputName,
    configWrites,
  };
}

export function scenario(
  id: ScenarioId,
  startup: Startup,
  exactAcceptedConfiguration: boolean,
  noPartialReadiness: boolean,
  diagnosticCode: string | null,
  controls: NegativeControls,
  secretRedacted: boolean,
  suppliedFileUntouched: boolean,
  wrapperRemoved: boolean,
  documentedSettingCount: number,
): DeploymentInputScenarioObservation {
  return {
    id,
    startup,
    exactAcceptedConfiguration,
    noPartialReadiness,
    preReadinessRefusal:
      controls.unknownRefusedBeforeReadiness &&
      controls.malformedRefusedBeforeReadiness &&
      controls.insecureRefusedBeforeReadiness,
    secretRedacted: controls.diagnosticsRedacted && secretRedacted,
    suppliedFileUntouched,
    wrapperSecretFileRemoved: wrapperRemoved,
    diagnosticCode,
    documentedSettingCount,
  };
}

export function suppliedFileBytes(path: string): Uint8Array {
  return readFileSync(path);
}
