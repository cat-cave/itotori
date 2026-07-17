// Secure, portable external env-file loader for live-provider runs.
//
// itotori is Nix/sops-agnostic. A caller may hand the CLI an ARBITRARY
// env-file path (via `--env-file <path>` or `ITOTORI_LOCAL_ENV_FILE`) that
// carries the live-provider credentials — nothing here depends on Nix, sops,
// direnv, or any particular workstation path. nix-desktop happens to render
// such a file at `~/.config/nix-desktop/secrets/env.d/itotori-openrouter.env`,
// but that is one example of many valid callers.
//
// SECRET HYGIENE (load-bearing):
//   - The file PATH may appear in logs/errors; the VALUES never do. No loaded
//     value is written to argv, stdout/stderr, or any report.
//   - Only an ALLOWLIST of live-provider vars is read from the file; any other
//     key in the file is ignored (a rogue var can never enter the process env).
//   - An already-exported process env var WINS: a file value is applied only
//     when the target var is currently unset. Callers can always override the
//     file via the real environment.
//   - A specified-but-missing file FAILS LOUD (typed error), never silently.

import { readFileSync } from "node:fs";
import { LIVE_PROVIDER_SECRET_VARS } from "./live-provider-secret-vars.js";

/**
 * The ONLY env vars the external env-file loader will ever apply to the
 * process environment. This is the union of what the live dispatch boundary
 * consumes:
 *
 *   - OPENROUTER_API_KEY               — the provider credential
 *     (the pinned LLM dispatch boundary)
 *   - OPENROUTER_ZDR_ACCOUNT_ASSERTED  — the account-wide ZDR posture gate
 *     (zdr-admission/account-zdr.ts `assertOpenRouterZdrAccount`)
 *   - OPENROUTER_ZDR_DOWNGRADE         — operator-level per-leaf ZDR downgrade
 *     (the active dispatch policy)
 *
 * Any key in the env file NOT in this set is ignored. Backed by the single
 * source of truth in `live-provider-secret-vars.mjs`, shared with the native-CLI
 * spawn boundary + the native-deps doctor so the allowlist can never drift.
 */
export const EXTERNAL_ENV_FILE_ALLOWLIST: readonly string[] = LIVE_PROVIDER_SECRET_VARS;

/**
 * The CLI flag that names an external env file. Takes precedence over
 * {@link EXTERNAL_ENV_FILE_ENV_VAR} when both are supplied.
 */
export const EXTERNAL_ENV_FILE_FLAG = "--env-file";

/**
 * The env var that names an external env file. Used when the CLI flag is
 * absent.
 */
export const EXTERNAL_ENV_FILE_ENV_VAR = "ITOTORI_LOCAL_ENV_FILE";

/**
 * Thrown when a caller specifies an external env file that cannot be read
 * (missing path, not a file, permission error). Specifying a path is an
 * explicit intent, so a broken path must fail loudly — never silently
 * continue as if no file were given.
 *
 * The message includes the offending PATH (safe) but never any value read
 * from the file.
 */
export class ExternalEnvFileError extends Error {
  readonly path: string;

  constructor(path: string, cause: string) {
    super(`failed to load env file '${path}': ${cause}`);
    this.name = "ExternalEnvFileError";
    this.path = path;
  }
}

/**
 * Result of a load attempt. Reports only the NAMES of vars that were applied
 * (never their values) so callers can log a non-secret summary.
 */
export interface ExternalEnvFileLoadResult {
  /** The env-file path that was read, or `undefined` if no file was specified. */
  readonly path: string | undefined;
  /**
   * Allowlisted var names that were applied to the environment from the file
   * (i.e. were previously unset). NAMES only — never values.
   */
  readonly appliedKeys: readonly string[];
  /**
   * Allowlisted var names that were present in the file but skipped because
   * the environment already had them set. NAMES only.
   */
  readonly skippedAlreadySetKeys: readonly string[];
}

/**
 * Resolve which env-file path to use. The CLI flag wins over the env var;
 * returns `undefined` when neither is supplied.
 */
export function resolveExternalEnvFilePath(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const flagIndex = args.indexOf(EXTERNAL_ENV_FILE_FLAG);
  if (flagIndex >= 0) {
    const value = args[flagIndex + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new ExternalEnvFileError(
        String(value ?? ""),
        `${EXTERNAL_ENV_FILE_FLAG} requires a path argument`,
      );
    }
    return value;
  }
  const fromEnv = env[EXTERNAL_ENV_FILE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return undefined;
}

/**
 * Parse a `.env`-style file body into a name→value map, filtered to the
 * allowlist. Supports `KEY=value`, `export KEY=value`, `#` comments, blank
 * lines, and surrounding single/double quotes. Non-allowlisted keys are
 * dropped. This parser never logs; it operates purely in-memory.
 */
export function parseAllowlistedEnvFile(body: string): Map<string, string> {
  const allow = new Set(EXTERNAL_ENV_FILE_ALLOWLIST);
  const out = new Map<string, string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) {
      // No key, or malformed line — ignore (never throw on a stray line so a
      // rogue var can't wedge the load; the allowlist is the real gate).
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!allow.has(key)) {
      continue;
    }
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Load allowlisted live-provider vars from a caller-specified external env
 * file into `target` (defaults to `process.env`), honoring precedence:
 *
 *   1. If neither the flag nor the env var names a file, this is a no-op
 *      (returns a result with `path: undefined`). The repo-local `.env`
 *      fallback, if any, is handled by direnv/`.envrc.local` OUTSIDE this
 *      loader — this function never reads a repo `.env`.
 *   2. A specified-but-unreadable path throws {@link ExternalEnvFileError}.
 *   3. Only {@link EXTERNAL_ENV_FILE_ALLOWLIST} keys are considered.
 *   4. An already-set var in `target` is NEVER overwritten.
 *
 * No value is ever logged or returned; only applied var NAMES are reported.
 */
export function loadExternalEnvFile(options: {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
}): ExternalEnvFileLoadResult {
  const { args, env } = options;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const path = resolveExternalEnvFilePath(args, env);
  if (path === undefined) {
    return { path: undefined, appliedKeys: [], skippedAlreadySetKeys: [] };
  }

  let body: string;
  try {
    body = readFile(path);
  } catch (error) {
    // Surface only the path + a terse cause; never echo file contents.
    const cause = error instanceof Error ? error.message : String(error);
    throw new ExternalEnvFileError(path, cause);
  }

  const parsed = parseAllowlistedEnvFile(body);
  const appliedKeys: string[] = [];
  const skippedAlreadySetKeys: string[] = [];
  for (const [key, value] of parsed) {
    if (env[key] !== undefined) {
      // Exported process env wins — never overwrite.
      skippedAlreadySetKeys.push(key);
      continue;
    }
    env[key] = value;
    appliedKeys.push(key);
  }

  return { path, appliedKeys, skippedAlreadySetKeys };
}
