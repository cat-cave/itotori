// Secure, portable deployment env-file loader for CLI startup.
//
// The file is a closed deployment boundary, not a dotenv convenience parser:
// every non-comment line names a documented setting, is validated before any
// process state changes, and failure names only a safe path/key classification
// (never a credential value). `cli-handler-dispatch.ts` invokes this before it
// dispatches every command, including --help and --version.

import { lstatSync, readFileSync } from "node:fs";

import { LIVE_PROVIDER_SECRET_VARS } from "./live-provider-secret-vars.js";

/**
 * The existing live-provider names which may arrive through the explicit
 * deployment file. Host-held registry entries intentionally do not enter this
 * process-wide loader: native-spawn redaction is scoped to these two names.
 */
export const EXTERNAL_ENV_FILE_ALLOWLIST: readonly string[] = LIVE_PROVIDER_SECRET_VARS;

// `itotori init` has historically written this existing database connection
// line next to provider credentials. It remains recognized so those private
// files keep working, but it is deliberately never applied by this loader;
// callers must source/export it separately for database commands.
const DOCUMENTED_BUT_NOT_APPLIED_NAMES: readonly string[] = ["DATABASE_URL"];
const DOCUMENTED_ENV_FILE_NAMES = new Set([
  ...EXTERNAL_ENV_FILE_ALLOWLIST,
  ...DOCUMENTED_BUT_NOT_APPLIED_NAMES,
]);

/** The CLI flag that names an external env file. */
export const EXTERNAL_ENV_FILE_FLAG = "--env-file";

/** The existing environment pointer used when the CLI flag is absent. */
export const EXTERNAL_ENV_FILE_ENV_VAR = "ITOTORI_LOCAL_ENV_FILE";

export type ExternalEnvFileErrorCode =
  | "flag-path-required"
  | "unreadable"
  | "source-not-regular-file"
  | "source-permissions-insecure"
  | "non-unicode"
  | "malformed-assignment"
  | "unknown-setting"
  | "duplicate-setting"
  | "unsupported-value-form";

const errorDetails: Readonly<Record<ExternalEnvFileErrorCode, string>> = {
  "flag-path-required": "requires a path argument",
  unreadable: "could not be read",
  "source-not-regular-file": "must be a regular file",
  "source-permissions-insecure": "has group or world permissions",
  "non-unicode": "contains a non-Unicode value",
  "malformed-assignment": "contains a malformed assignment",
  "unknown-setting": "contains an undocumented setting",
  "duplicate-setting": "contains a duplicate setting",
  "unsupported-value-form": "contains an unsupported credential form",
};

/**
 * Typed, redacted startup failure. `inputName`, when present, is a setting
 * name rather than its value; values never reach this error or CLI output.
 */
export class ExternalEnvFileError extends Error {
  readonly path: string;
  readonly code: ExternalEnvFileErrorCode;
  readonly inputName: string | undefined;

  constructor(path: string, code: ExternalEnvFileErrorCode, inputName?: string) {
    const named = inputName === undefined ? "" : ` for ${inputName}`;
    super(`deployment env file '${path}' ${errorDetails[code]}${named}`);
    this.name = "ExternalEnvFileError";
    this.path = path;
    this.code = code;
    this.inputName = inputName;
  }
}

export interface ExternalEnvFileLoadResult {
  /** The env-file path that was read, or `undefined` if no file was specified. */
  readonly path: string | undefined;
  /** Applied setting names only; values are intentionally absent. */
  readonly appliedKeys: readonly string[];
  /** Setting names whose process environment values already won precedence. */
  readonly skippedAlreadySetKeys: readonly string[];
}

/** A minimal injectable source stat seam; production always uses lstatSync. */
export interface ExternalEnvFileSource {
  readonly isRegularFile: boolean;
  readonly mode: number;
}

export interface LoadExternalEnvFileOptions {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  /** Test seam only; production reads bytes from the supplied path. */
  readonly readFile?: (path: string) => string | Uint8Array;
  /** Test seam only; production verifies a regular private file with lstat. */
  readonly inspectSource?: (path: string) => ExternalEnvFileSource;
}

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u;
const PRIVATE_FILE_MASK = 0o077;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Resolve the requested path; the CLI flag wins over the existing pointer. */
export function resolveExternalEnvFilePath(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const flagIndex = args.indexOf(EXTERNAL_ENV_FILE_FLAG);
  if (flagIndex >= 0) {
    const value = args[flagIndex + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new ExternalEnvFileError(String(value ?? ""), "flag-path-required");
    }
    return value;
  }
  const fromEnv = env[EXTERNAL_ENV_FILE_ENV_VAR];
  return fromEnv === undefined || fromEnv.length === 0 ? undefined : fromEnv;
}

/**
 * Parse a strict `.env`-style body. The syntax admits blank lines, comments,
 * `KEY=value`, and `export KEY=value`. Quoted values preserve dollar signs,
 * quotes, spaces, and backslashes literally; no shell expansion is performed.
 *
 * The full body is validated before this function returns, which lets the
 * caller mutate the process environment transactionally after a late failure.
 */
export function parseAllowlistedEnvFile(body: string, path = "<inline>"): Map<string, string> {
  const out = new Map<string, string>();
  for (const [index, rawLine] of body.split(/\r?\n/u).entries()) {
    const line = rawLine.trimStart();
    if (line.length === 0 || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equals = assignment.indexOf("=");
    if (equals <= 0) {
      throw new ExternalEnvFileError(path, "malformed-assignment");
    }
    const name = assignment.slice(0, equals).trim();
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new ExternalEnvFileError(path, "malformed-assignment");
    }
    // Fixed-success mutation seam: this refusal protects every later startup
    // action from an undocumented setting being silently ignored.
    if (!DOCUMENTED_ENV_FILE_NAMES.has(name)) {
      throw new ExternalEnvFileError(path, "unknown-setting", name);
    }
    if (out.has(name)) {
      throw new ExternalEnvFileError(path, "duplicate-setting", name);
    }
    out.set(name, parseValue(assignment.slice(equals + 1), path, index + 1, name));
  }
  return out;
}

function parseValue(rawValue: string, path: string, line: number, name: string): string {
  const value = rawValue.trim();
  if (value.length === 0) return "";
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    if (value.endsWith("\\") || value.includes('"') || value.includes("'")) {
      throw new ExternalEnvFileError(path, "unsupported-value-form", name);
    }
    return value;
  }
  if (value.length < 2 || !value.endsWith(quote)) {
    throw new ExternalEnvFileError(path, "unsupported-value-form", name);
  }
  return parseQuotedValue(value.slice(1, -1), quote, path, line, name);
}

function parseQuotedValue(
  value: string,
  quote: string,
  path: string,
  _line: number,
  name: string,
): string {
  let parsed = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current === quote) {
      throw new ExternalEnvFileError(path, "unsupported-value-form", name);
    }
    if (current !== "\\") {
      parsed += current;
      continue;
    }
    const escaped = value[index + 1];
    if (
      escaped === undefined ||
      (escaped !== "\\" && escaped !== quote && escaped !== "$" && escaped !== " ")
    ) {
      throw new ExternalEnvFileError(path, "unsupported-value-form", name);
    }
    parsed += escaped;
    index += 1;
  }
  return parsed;
}

/**
 * Load a requested file only after validating its source and every entry.
 * A late duplicate/unknown/malformed entry leaves `env` exactly unchanged.
 */
export function loadExternalEnvFile(
  options: LoadExternalEnvFileOptions,
): ExternalEnvFileLoadResult {
  const { args, env } = options;
  const path = resolveExternalEnvFilePath(args, env);
  if (path === undefined) return { path: undefined, appliedKeys: [], skippedAlreadySetKeys: [] };

  const inspectSource = options.inspectSource ?? inspectExternalEnvFileSource;
  const readFile = options.readFile ?? ((candidate: string) => readFileSync(candidate));
  let body: string;
  try {
    assertPrivateRegularFile(inspectSource(path), path);
    body = decodeUtf8(readFile(path), path);
  } catch (error) {
    if (error instanceof ExternalEnvFileError) throw error;
    throw new ExternalEnvFileError(path, "unreadable");
  }

  const parsed = parseAllowlistedEnvFile(body, path);
  const toApply: Array<readonly [string, string]> = [];
  const skippedAlreadySetKeys: string[] = [];
  for (const [name, value] of parsed) {
    if (!EXTERNAL_ENV_FILE_ALLOWLIST.includes(name)) continue;
    if (env[name] === undefined) toApply.push([name, value]);
    else skippedAlreadySetKeys.push(name);
  }
  for (const [name, value] of toApply) env[name] = value;
  return {
    path,
    appliedKeys: toApply.map(([name]) => name),
    skippedAlreadySetKeys,
  };
}

function inspectExternalEnvFileSource(path: string): ExternalEnvFileSource {
  const stat = lstatSync(path);
  return { isRegularFile: stat.isFile(), mode: stat.mode };
}

function assertPrivateRegularFile(source: ExternalEnvFileSource, path: string): void {
  if (!source.isRegularFile) throw new ExternalEnvFileError(path, "source-not-regular-file");
  if (!Number.isSafeInteger(source.mode) || (source.mode & PRIVATE_FILE_MASK) !== 0) {
    throw new ExternalEnvFileError(path, "source-permissions-insecure");
  }
}

function decodeUtf8(value: string | Uint8Array, path: string): string {
  if (typeof value === "string") return value;
  try {
    return utf8.decode(value);
  } catch {
    throw new ExternalEnvFileError(path, "non-unicode");
  }
}
