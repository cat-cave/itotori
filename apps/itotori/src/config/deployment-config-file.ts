// Strict application deployment-configuration file loader.
//
// This is intentionally separate from environment input: these documented
// settings describe application policy and are supplied only through
// `--deployment-config <path>`. They are not environment variables and do not
// enlarge config/environment-registry.json. The CLI validates the whole file
// before dispatch so an unknown, duplicate, malformed, or insecure setting
// cannot create a partly ready service.

import { lstatSync, readFileSync } from "node:fs";

export const DEPLOYMENT_CONFIG_FILE_FLAG = "--deployment-config";

export type DeploymentConfigSetting = {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
};

/**
 * The documented non-environment application configuration surface. Keeping
 * this as a reviewed closed schema permits large deployment files without
 * reintroducing translator choices as ad-hoc environment variables.
 */
export const DEPLOYMENT_CONFIG_SCHEMA: readonly DeploymentConfigSetting[] = Object.freeze([
  { name: "application.profile", required: true, description: "Named deployment profile." },
  { name: "application.display_name", required: false, description: "Operator-facing name." },
  { name: "application.locale", required: false, description: "Default target locale." },
  { name: "application.source_locale", required: false, description: "Default source locale." },
  { name: "application.engine_family", required: false, description: "Selected engine family." },
  { name: "application.run_mode", required: false, description: "Default run mode." },
  { name: "application.release_channel", required: false, description: "Release channel policy." },
  { name: "application.update_policy", required: false, description: "Update admission policy." },
  { name: "application.telemetry_policy", required: false, description: "Telemetry policy." },
  { name: "workspace.root", required: false, description: "Application workspace root." },
  { name: "workspace.cache_root", required: false, description: "Application cache root." },
  { name: "workspace.artifact_root", required: false, description: "Application artifact root." },
  {
    name: "workspace.retention_policy",
    required: false,
    description: "Workspace retention policy.",
  },
  { name: "workspace.concurrency", required: false, description: "Workspace concurrency policy." },
  { name: "database.migration_policy", required: false, description: "Database migration policy." },
  {
    name: "database.connection_policy",
    required: false,
    description: "Database connection policy.",
  },
  { name: "database.backup_policy", required: false, description: "Database backup policy." },
  { name: "database.recovery_policy", required: false, description: "Database recovery policy." },
  { name: "provider.model", required: false, description: "Provider model selection policy." },
  { name: "provider.routing_policy", required: false, description: "Provider routing policy." },
  { name: "provider.retry_policy", required: false, description: "Provider retry policy." },
  { name: "provider.cost_policy", required: false, description: "Provider cost policy." },
  { name: "provider.redaction_policy", required: false, description: "Provider redaction policy." },
  { name: "render.font_policy", required: false, description: "Render font policy." },
  { name: "render.browser_policy", required: false, description: "Render browser policy." },
  {
    name: "render.accessibility_policy",
    required: false,
    description: "Render accessibility policy.",
  },
  { name: "render.capture_policy", required: false, description: "Render capture policy." },
  { name: "patch.output_policy", required: false, description: "Patch output policy." },
  { name: "patch.validation_policy", required: false, description: "Patch validation policy." },
  { name: "patch.rollback_policy", required: false, description: "Patch rollback policy." },
  { name: "security.custody_policy", required: false, description: "Custody policy." },
  { name: "security.audit_policy", required: false, description: "Audit policy." },
  {
    name: "security.secret_reference_policy",
    required: false,
    description: "Secret-reference policy; secret values stay in the env file.",
  },
]);

const documentedSettings = new Map(
  DEPLOYMENT_CONFIG_SCHEMA.map((setting) => [setting.name, setting]),
);
const CONFIGURATION_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const PRIVATE_FILE_MASK = 0o077;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type DeploymentConfigFileErrorCode =
  | "flag-path-required"
  | "unreadable"
  | "source-not-regular-file"
  | "source-permissions-insecure"
  | "non-unicode"
  | "malformed-assignment"
  | "unknown-setting"
  | "duplicate-setting"
  | "missing-required-setting"
  | "unsupported-value-form";

const errorDetails: Readonly<Record<DeploymentConfigFileErrorCode, string>> = {
  "flag-path-required": "requires a path argument",
  unreadable: "could not be read",
  "source-not-regular-file": "must be a regular file",
  "source-permissions-insecure": "has group or world permissions",
  "non-unicode": "contains a non-Unicode value",
  "malformed-assignment": "contains a malformed assignment",
  "unknown-setting": "contains an undocumented setting",
  "duplicate-setting": "contains a duplicate setting",
  "missing-required-setting": "is missing a required setting",
  "unsupported-value-form": "contains an unsupported value form",
};

/** Typed, redacted startup failure: a setting name is safe; its value is not. */
export class DeploymentConfigFileError extends Error {
  readonly path: string;
  readonly code: DeploymentConfigFileErrorCode;
  readonly settingName: string | undefined;

  constructor(path: string, code: DeploymentConfigFileErrorCode, settingName?: string) {
    const named = settingName === undefined ? "" : ` for ${settingName}`;
    super(`deployment configuration file '${path}' ${errorDetails[code]}${named}`);
    this.name = "DeploymentConfigFileError";
    this.path = path;
    this.code = code;
    this.settingName = settingName;
  }
}

export interface DeploymentConfigFileSource {
  readonly isRegularFile: boolean;
  readonly mode: number;
}

export interface LoadDeploymentConfigurationFileOptions {
  readonly args: readonly string[];
  readonly readFile?: (path: string) => string | Uint8Array;
  readonly inspectSource?: (path: string) => DeploymentConfigFileSource;
}

export interface DeploymentConfigurationLoadResult {
  readonly path: string | undefined;
  readonly values: ReadonlyMap<string, string>;
}

/** Immutable validated configuration retained for the lifetime of one command. */
export interface DeploymentStartupContext {
  readonly configuration: DeploymentConfigurationLoadResult;
  readonly settings: ReadonlyMap<string, string>;
  readonly profile: string | undefined;
}

export function createDeploymentStartupContext(
  configuration: DeploymentConfigurationLoadResult,
): DeploymentStartupContext {
  return Object.freeze({
    configuration,
    settings: configuration.values,
    profile: configuration.values.get("application.profile"),
  });
}

/** Defends command entrypoints even if a context was constructed by another caller. */
export function assertDeploymentStartupContext(context: DeploymentStartupContext): void {
  if (context.configuration.path !== undefined && context.profile === undefined) {
    throw new DeploymentConfigFileError(
      context.configuration.path,
      "missing-required-setting",
      "application.profile",
    );
  }
}

/** Resolve the explicit application config path without consulting environment state. */
export function resolveDeploymentConfigurationPath(args: readonly string[]): string | undefined {
  const index = args.indexOf(DEPLOYMENT_CONFIG_FILE_FLAG);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new DeploymentConfigFileError(String(value ?? ""), "flag-path-required");
  }
  return value;
}

/**
 * Load a complete configuration file before CLI dispatch. No value is applied
 * to another system here: callers receive an immutable view only after all
 * lines and required settings validate, so a late failure has no partial state.
 */
export function loadDeploymentConfigurationFile(
  options: LoadDeploymentConfigurationFileOptions,
): DeploymentConfigurationLoadResult {
  const path = resolveDeploymentConfigurationPath(options.args);
  if (path === undefined) return { path: undefined, values: new Map() };
  const inspectSource = options.inspectSource ?? inspectDeploymentConfigSource;
  const readFile = options.readFile ?? ((candidate: string) => readFileSync(candidate));
  let text: string;
  try {
    assertPrivateRegularFile(inspectSource(path), path);
    text = decodeUtf8(readFile(path), path);
  } catch (error) {
    if (error instanceof DeploymentConfigFileError) throw error;
    throw new DeploymentConfigFileError(path, "unreadable");
  }
  return { path, values: parseDeploymentConfiguration(text, path) };
}

/** Parse the closed documented schema without logging or shell expansion. */
export function parseDeploymentConfiguration(
  text: string,
  path = "<inline>",
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimStart();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) throw new DeploymentConfigFileError(path, "malformed-assignment");
    const name = line.slice(0, equals).trim();
    if (!CONFIGURATION_NAME.test(name)) {
      throw new DeploymentConfigFileError(path, "malformed-assignment");
    }
    // Fixed-success mutation seam: a closed documented schema refuses unknown
    // configuration before a command can use a partial startup state.
    if (!documentedSettings.has(name)) {
      throw new DeploymentConfigFileError(path, "unknown-setting", name);
    }
    if (values.has(name)) {
      throw new DeploymentConfigFileError(path, "duplicate-setting", name);
    }
    values.set(name, parseValue(line.slice(equals + 1), path, name));
  }
  for (const setting of DEPLOYMENT_CONFIG_SCHEMA) {
    if (setting.required && !values.has(setting.name)) {
      throw new DeploymentConfigFileError(path, "missing-required-setting", setting.name);
    }
  }
  return values;
}

function parseValue(rawValue: string, path: string, settingName: string): string {
  const value = rawValue.trim();
  if (value.length === 0) return "";
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    if (value.endsWith("\\") || value.includes('"') || value.includes("'")) {
      throw new DeploymentConfigFileError(path, "unsupported-value-form", settingName);
    }
    return value;
  }
  if (value.length < 2 || !value.endsWith(quote)) {
    throw new DeploymentConfigFileError(path, "unsupported-value-form", settingName);
  }
  let parsed = "";
  const interior = value.slice(1, -1);
  for (let index = 0; index < interior.length; index += 1) {
    const current = interior[index];
    if (current === quote) {
      throw new DeploymentConfigFileError(path, "unsupported-value-form", settingName);
    }
    if (current !== "\\") {
      parsed += current;
      continue;
    }
    const escaped = interior[index + 1];
    if (
      escaped === undefined ||
      (escaped !== "\\" && escaped !== quote && escaped !== "$" && escaped !== " ")
    ) {
      throw new DeploymentConfigFileError(path, "unsupported-value-form", settingName);
    }
    parsed += escaped;
    index += 1;
  }
  return parsed;
}

function inspectDeploymentConfigSource(path: string): DeploymentConfigFileSource {
  const stat = lstatSync(path);
  return { isRegularFile: stat.isFile(), mode: stat.mode };
}

function assertPrivateRegularFile(source: DeploymentConfigFileSource, path: string): void {
  if (!source.isRegularFile) throw new DeploymentConfigFileError(path, "source-not-regular-file");
  if (!Number.isSafeInteger(source.mode) || (source.mode & PRIVATE_FILE_MASK) !== 0) {
    throw new DeploymentConfigFileError(path, "source-permissions-insecure");
  }
}

function decodeUtf8(value: string | Uint8Array, path: string): string {
  if (typeof value === "string") return value;
  try {
    return utf8.decode(value);
  } catch {
    throw new DeploymentConfigFileError(path, "non-unicode");
  }
}
