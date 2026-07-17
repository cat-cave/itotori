// beta-packaged-install-surface — `itotori init` guided setup.
//
// The culminating beta 'ready for a non-developer user' gate: a guided setup
// that walks a non-developer through:
//   1. OpenRouter API key
//   2. Account-wide Zero-Data-Retention (ZDR) posture assertion
//   3. Database footprint (so the user does not hand-provision Postgres)
//   4. Config file creation
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
//   - The ZDR assertion (`OPENROUTER_ZDR_ACCOUNT_ASSERTED=1`) is written ONLY
//     after the user explicitly confirms their OpenRouter account is
//     ZDR-only — it is the operator's fail-closed acknowledgement, not an
//     auto-set flag (mirrors providers/account-zdr.ts).

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "itotori");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.env");

export const INIT_FLAG_ZDR_ASSERTED = "--zdr-asserted";
export const INIT_FLAG_CONFIG = "--config";
export const INIT_FLAG_NON_INTERACTIVE = "--non-interactive";
export const INIT_FLAG_ALL = "--all";

const REMOVED_SECRET_FLAGS = ["--api-key", "--database-url"] as const;

export type DatabaseProvisionResult = {
  readonly ok: boolean;
  readonly message: string;
};

export type InitCommandDeps = {
  readonly env: Record<string, string | undefined>;
  readonly existsPath: (path: string) => boolean;
  readonly writeText: (path: string, contents: string, mode?: number) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly log: (message: string) => void;
  readonly defaultDatabaseUrl?: () => string | undefined;
  readonly provisionDatabase?: (databaseUrl: string) => Promise<DatabaseProvisionResult>;
};

export type InitFlags = {
  zdrAsserted: boolean;
  configPath: string;
  nonInteractive: boolean;
};

export function parseInitFlags(args: string[]): InitFlags {
  for (const flag of REMOVED_SECRET_FLAGS) {
    rejectRemovedSecretFlag(args, flag);
  }
  const nonInteractive = args.includes(INIT_FLAG_NON_INTERACTIVE);
  const configPath = optionalFlag(args, INIT_FLAG_CONFIG) ?? DEFAULT_CONFIG_PATH;
  const zdrAsserted = args.includes(INIT_FLAG_ZDR_ASSERTED);
  return { zdrAsserted, configPath, nonInteractive };
}

export async function runInitCommand(args: string[], deps: InitCommandDeps): Promise<void> {
  const flags = parseInitFlags(args);

  deps.log("");
  deps.log("Welcome to itotori! This guided setup will configure:");
  deps.log("  1. Your OpenRouter API key");
  deps.log("  2. Zero-Data-Retention (ZDR) posture");
  deps.log("  3. Database footprint");
  deps.log("  4. Config file");
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

  // ── Step 2: ZDR posture ─────────────────────────────────────────────────
  const zdrConfirmed = await resolveZdrConfirmation(flags, deps);
  if (zdrConfirmed) {
    deps.log("  [ok] ZDR posture asserted (OPENROUTER_ZDR_ACCOUNT_ASSERTED=1).");
  } else {
    deps.log("  [warning] ZDR not confirmed. Live runs will FAIL — the OpenRouter");
    deps.log("           provider refuses to construct without ZDR assertion.");
    deps.log("           Configure ZDR at https://openrouter.ai/settings then re-run init.");
  }
  deps.log("");

  // ── Step 3: Database footprint ──────────────────────────────────────────
  const databaseUrl = await resolveDatabaseUrl(flags, deps);
  if (databaseUrl !== undefined) {
    deps.log("  [ok] DATABASE_URL captured (value hidden).");
  } else {
    deps.log("  [warning] No DATABASE_URL set. Database commands (db-migrate, localize)");
    deps.log("           will fail until Postgres is provisioned.");
    deps.log("           See `just db-up` (docker) or docs/native-deps-provisioning.md.");
  }
  deps.log("");

  // ── Step 4: Write config file ───────────────────────────────────────────
  const configContents = buildConfigFileContents({
    apiKey,
    zdrConfirmed,
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
    deps.log("       itotori db-migrate");
    deps.log("");
  } else {
    deps.log("       Provision Postgres or set DATABASE_URL, then re-run `itotori init`.");
    deps.log("");
  }
  deps.log("  3. Localize a game. The full pipeline is a multi-command flow:");
  deps.log("       extract -> structure-export -> wiki build -> localize -> patch -> validate");
  deps.log("       Run `itotori --help` for each command's required flags.");
  deps.log("");
  if (!zdrConfirmed) {
    deps.log("  WARNING: ZDR is not confirmed. Live runs will fail until you");
    deps.log("  configure ZDR on your OpenRouter account and re-run `itotori init`.");
    deps.log("");
  }
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

async function resolveZdrConfirmation(flags: InitFlags, deps: InitCommandDeps): Promise<boolean> {
  if (flags.zdrAsserted) {
    return true;
  }
  const fromEnv = deps.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
  if (fromEnv === "1") {
    return true;
  }
  if (flags.nonInteractive) {
    return false;
  }
  deps.log("  itotori requires your OpenRouter account to be configured for");
  deps.log("  Zero-Data-Retention (ZDR). This means no prompt/response data is");
  deps.log("  retained by the provider.");
  deps.log("");
  deps.log("  To enable ZDR:");
  deps.log("    1. Go to https://openrouter.ai/settings");
  deps.log("    2. Enable 'Zero Data Retention' at the account level");
  deps.log("");
  const answer = await deps.prompt(
    "  Confirm your OpenRouter account is configured ZDR-only (yes/no): ",
  );
  return answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y";
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
  deps.log("    a) If you have docker: run `just db-up` to start a container");
  deps.log("    b) Export DATABASE_URL for an existing Postgres instance and re-run init");
  deps.log("    c) Use a portable Postgres (ITOTORI_POSTGRES_BIN_DIR)");
  return undefined;
}

export function buildConfigFileContents(input: {
  apiKey: string | undefined;
  zdrConfirmed: boolean;
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
  if (input.zdrConfirmed) {
    lines.push("export OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
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
  return index >= 0 && value && !value.startsWith("-") ? value : undefined;
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
