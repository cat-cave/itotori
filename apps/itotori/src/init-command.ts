// beta-packaged-install-surface — `itotori init` guided setup.
//
// The culminating beta 'ready for a non-developer user' gate: a guided setup
// that walks a non-developer through:
//   1. OpenRouter API key
//   2. Database footprint (so the user does not hand-provision Postgres)
//   3. Config file creation
//
// The config file is a `.env`-style file written to a standard location
// (`~/.config/itotori/config.env` by default). The CLI's existing
// `--env-file` / `ITOTORI_LOCAL_ENV_FILE` mechanism loads the allowlisted
// live-provider vars from it; `DATABASE_URL` is written alongside so the user
// can `source` the file or export the vars individually.
//
// SECRET HYGIENE (mirrors external-env-file.ts):
//   - The API key is NEVER logged, printed, or echoed — only written to the
//     config file (mode 0600).
//   - The config file path may appear in output; secret values never do.
//   - Secret values are loaded only from env/file, never CLI flags or prompts.

import { homedir } from "node:os";
import { join } from "node:path";
import { requireDatabaseUrl, RequiredDeploymentInputError } from "./deployment-required-input.js";
import type { HostInitializationInput, LifecycleResult } from "./install-lifecycle.js";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "itotori");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.env");

export const INIT_FLAG_CONFIG = "--config";
export const INIT_FLAG_NON_INTERACTIVE = "--non-interactive";
export const INIT_FLAG_ALL = "--all";
export const INIT_FLAG_STATE_ROOT = "--state-root";
export const INIT_FLAG_RELEASE_VERSION = "--release-version";
export const INIT_FLAG_RELEASE_PAYLOAD = "--release-payload";
export const INIT_FLAG_REQUIRED_FONT = "--required-font";
export const INIT_FLAG_REQUIRED_GLYPH = "--required-glyph";

const REMOVED_SECRET_FLAGS = ["--api-key", "--database-url"] as const;

export type DatabaseProvisionResult = {
  readonly ok: boolean;
  readonly message: string;
};

export { RequiredDeploymentInputError } from "./deployment-required-input.js";

export type InitCommandDeps = {
  readonly env: Record<string, string | undefined>;
  readonly existsPath: (path: string) => boolean;
  readonly writeText: (path: string, contents: string, mode?: number) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly log: (message: string) => void;
  readonly defaultDatabaseUrl?: () => string | undefined;
  readonly provisionDatabase?: (databaseUrl: string) => Promise<DatabaseProvisionResult>;
  /** No-write host checks, deliberately before config persistence. */
  readonly preflightHostLifecycle?: (input: HostInitializationInput) => void;
  readonly initializeHostLifecycle?: (input: HostInitializationInput) => LifecycleResult;
  readonly currentReleasePayloadPath?: () => string;
  readonly currentReleaseVersion?: () => string;
  /** Runs the real migration/readiness check for an explicitly managed host. */
  readonly migrateDatabaseForHostLifecycle?: () => Promise<void>;
};

export type InitFlags = {
  configPath: string;
  nonInteractive: boolean;
  stateRoot: string | undefined;
  releaseVersion: string | undefined;
  releasePayloadPath: string | undefined;
  requiredFonts: readonly string[];
  requiredGlyphs: readonly string[];
};

export function parseInitFlags(args: string[]): InitFlags {
  for (const flag of REMOVED_SECRET_FLAGS) {
    rejectRemovedSecretFlag(args, flag);
  }
  const nonInteractive = args.includes(INIT_FLAG_NON_INTERACTIVE);
  const configPath = optionalFlag(args, INIT_FLAG_CONFIG) ?? DEFAULT_CONFIG_PATH;
  const stateRoot = optionalFlag(args, INIT_FLAG_STATE_ROOT);
  const releaseVersion = optionalFlag(args, INIT_FLAG_RELEASE_VERSION);
  const releasePayloadPath = optionalFlag(args, INIT_FLAG_RELEASE_PAYLOAD);
  const requiredFonts = repeatedFlag(args, INIT_FLAG_REQUIRED_FONT);
  const requiredGlyphs = repeatedFlag(args, INIT_FLAG_REQUIRED_GLYPH);
  if (
    stateRoot === undefined &&
    (releaseVersion !== undefined ||
      releasePayloadPath !== undefined ||
      requiredFonts.length > 0 ||
      requiredGlyphs.length > 0)
  ) {
    throw new Error(`${INIT_FLAG_STATE_ROOT} is required when requesting host lifecycle readiness`);
  }
  return {
    configPath,
    nonInteractive,
    stateRoot,
    releaseVersion,
    releasePayloadPath,
    requiredFonts,
    requiredGlyphs,
  };
}

export async function runInitCommand(args: string[], deps: InitCommandDeps): Promise<void> {
  const flags = parseInitFlags(args);

  deps.log("");
  deps.log("Welcome to itotori! This guided setup will configure:");
  deps.log("  1. Your OpenRouter API key");
  deps.log("  2. Database footprint");
  deps.log("  3. Config file");
  deps.log("");

  // ── Step 1: OpenRouter API key ──────────────────────────────────────────
  const apiKey = await resolveApiKey(flags, deps);
  if (apiKey === undefined) {
    deps.log("  [warning] No OpenRouter API key set. Live localization will not work.");
    deps.log("           Set OPENROUTER_API_KEY or ITOTORI_LOCAL_ENV_FILE and re-run init.");
  } else {
    deps.log("  [ok] OpenRouter API key captured (value hidden).");
  }
  deps.log("");

  const lifecycle = hostLifecycleInput(flags, deps);
  if (lifecycle !== undefined) {
    if (deps.preflightHostLifecycle === undefined || deps.initializeHostLifecycle === undefined) {
      throw new Error("itotori init cannot establish host lifecycle readiness in this runtime");
    }
    // This is deliberately before database auto-provisioning and config writes:
    // an unavailable font is diagnosed before any readiness evidence is created.
    deps.preflightHostLifecycle(lifecycle);
    deps.log("  [ok] Required host fonts and representative glyphs are available.");
    deps.log("");
    requireDatabaseUrl(deps.env);
  }

  // ── Step 2: Database footprint ──────────────────────────────────────────
  const databaseUrl = await resolveDatabaseUrl(flags, deps);
  if (databaseUrl !== undefined) {
    deps.log("  [ok] DATABASE_URL captured (value hidden).");
  } else {
    deps.log("  [warning] No DATABASE_URL set. Database commands (db-migrate, localize)");
    deps.log("           will fail until Postgres is provisioned.");
    deps.log("           See `just dev db-up` (docker) or docs/native-deps-provisioning.md.");
  }
  deps.log("");

  if (lifecycle !== undefined) {
    if (databaseUrl === undefined) {
      throw new RequiredDeploymentInputError();
    }
    if (deps.migrateDatabaseForHostLifecycle === undefined) {
      throw new Error("itotori init cannot verify database readiness in this runtime");
    }
    await deps.migrateDatabaseForHostLifecycle();
    deps.log("  [ok] Database migration/readiness check completed.");
  }

  // ── Step 3: Write config file ───────────────────────────────────────────
  const configContents = buildConfigFileContents({
    apiKey,
    databaseUrl,
  });

  if (deps.existsPath(flags.configPath) && !flags.nonInteractive) {
    const answer = await deps.prompt(
      `  Config file already exists at ${flags.configPath}. Overwrite? (yes/no): `,
    );
    if (answer.trim().toLowerCase() !== "yes" && answer.trim().toLowerCase() !== "y") {
      deps.log("  [skipped] Config file not overwritten. Setup aborted.");
      return;
    }
  }

  deps.writeText(flags.configPath, configContents, 0o600);
  deps.log(`  [ok] Config file written to: ${flags.configPath}`);
  if (lifecycle !== undefined) {
    const installed = deps.initializeHostLifecycle?.(lifecycle);
    if (installed === undefined)
      throw new Error("itotori init did not establish host lifecycle readiness");
    deps.log(
      `  [ok] Host lifecycle ${installed.outcome}: active release ${installed.state.active.version} at ${lifecycle.stateRoot}`,
    );
  }
  deps.log("");

  // ── Next steps ──────────────────────────────────────────────────────────
  deps.log("NEXT STEPS:");
  deps.log("  1. Add to your shell profile (~/.bashrc, ~/.zshrc, etc.):");
  deps.log(`       export ITOTORI_LOCAL_ENV_FILE=${shellQuote(flags.configPath)}`);
  if (databaseUrl !== undefined) {
    deps.log("       # DATABASE_URL was written to the config file above (value hidden).");
    deps.log(`       . ${shellQuote(flags.configPath)}`);
  }
  deps.log("");
  deps.log("  2. Run database migrations:");
  if (databaseUrl !== undefined) {
    deps.log(
      lifecycle === undefined
        ? "       itotori db-migrate"
        : "       already verified during managed host initialization",
    );
    deps.log("");
  } else {
    deps.log("       Provision Postgres or set DATABASE_URL, then re-run `itotori init`.");
    deps.log("");
  }
  deps.log("  3. Start a corpus run: extract -> structure-export.");
  deps.log("       wiki/localize need ITOTORI_FIELD_CIPHER_KEY; this CLI does not export");
  deps.log("       localize output as the translated bridge required by patch.");
  deps.log("       Run `itotori <command> --help` for that command's required flags.");
  deps.log("");
  deps.log("Setup complete!");
}

async function resolveApiKey(flags: InitFlags, deps: InitCommandDeps): Promise<string | undefined> {
  const fromEnv = deps.env.OPENROUTER_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  if (flags.nonInteractive) {
    return undefined;
  }
  deps.log("  OpenRouter API keys are not accepted in prompts or CLI flags.");
  deps.log("  Set OPENROUTER_API_KEY or load it from an env file, then re-run init.");
  return undefined;
}

async function resolveDatabaseUrl(
  flags: InitFlags,
  deps: InitCommandDeps,
): Promise<string | undefined> {
  const fromEnv = deps.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const defaultDatabaseUrl = deps.defaultDatabaseUrl?.();
  if (defaultDatabaseUrl !== undefined && defaultDatabaseUrl.length > 0) {
    deps.log("  No DATABASE_URL was set; configuring a local packaged Postgres footprint.");
    if (deps.provisionDatabase !== undefined) {
      const result = await deps.provisionDatabase(defaultDatabaseUrl);
      if (result.ok) {
        deps.log(`  [ok] ${result.message}`);
        return defaultDatabaseUrl;
      }
      throw new Error(
        `itotori init failed to provision the required database footprint: ${result.message}`,
      );
    }
    deps.log("  [ok] Derived local DATABASE_URL (value hidden).");
    return defaultDatabaseUrl;
  }
  if (flags.nonInteractive) {
    return undefined;
  }
  deps.log("  itotori uses Postgres to store localization state.");
  deps.log("");
  deps.log("  DATABASE_URL is not accepted in prompts or CLI flags.");
  deps.log("  Options:");
  deps.log("    a) If you have docker: run `just dev db-up` to start a container");
  deps.log("    b) Export DATABASE_URL for an existing Postgres instance and re-run init");
  deps.log("    c) Use a portable Postgres (ITOTORI_POSTGRES_BIN_DIR)");
  return undefined;
}

export function buildConfigFileContents(input: {
  apiKey: string | undefined;
  databaseUrl: string | undefined;
}): string {
  const lines: string[] = [
    "# itotori configuration file",
    "# Generated by `itotori init`",
    "#",
    "# This file contains live-provider credentials. Keep it private (mode 0600).",
    "# Load it via: export ITOTORI_LOCAL_ENV_FILE=<this-path>",
    "#",
    "# The allowlisted vars (OPENROUTER_*) are loaded by the CLI's --env-file",
    "# mechanism. DATABASE_URL must be exported separately or sourced.",
    "",
  ];
  if (input.apiKey !== undefined) {
    lines.push(`export OPENROUTER_API_KEY=${shellQuote(input.apiKey)}`);
  }
  if (input.databaseUrl !== undefined) {
    lines.push(`export DATABASE_URL=${shellQuote(input.databaseUrl)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function optionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0) return undefined;
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function repeatedFlag(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function hostLifecycleInput(
  flags: InitFlags,
  deps: InitCommandDeps,
): HostInitializationInput | undefined {
  if (flags.stateRoot === undefined) return undefined;
  const releaseVersion = flags.releaseVersion ?? deps.currentReleaseVersion?.();
  const releasePayloadPath = flags.releasePayloadPath ?? deps.currentReleasePayloadPath?.();
  if (releaseVersion === undefined || releasePayloadPath === undefined) {
    throw new Error(
      "itotori init cannot identify the installed release for host lifecycle readiness",
    );
  }
  return {
    stateRoot: flags.stateRoot,
    releaseVersion,
    releasePayloadPath,
    requiredFonts: flags.requiredFonts,
    requiredGlyphs: flags.requiredGlyphs,
  };
}

function rejectRemovedSecretFlag(args: readonly string[], name: string): void {
  if (args.includes(name)) {
    throw new Error(
      `itotori init no longer accepts ${name}; put the secret in the environment or an env file and pass only the file path`,
    );
  }
}

export function shellQuote(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new Error("cannot write shell export: value contains a newline");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
