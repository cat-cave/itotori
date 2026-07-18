// itotori-cli-extract-command (P1, user-shaped CLI).
//
// The user-shaped `itotori extract` command wraps
// `kaifuu-cli extract --engine <engine>`, producing the v0.2 BridgeBundle that
// `itotori localize` consumes — WITHOUT forcing the
// caller to know about the Rust binary or `cargo`. Engines are parametric:
// the same production seam dispatches RealLive, Softpal, and any future
// extract engine through `--engine <name>` from the caller / detection path.
//
// RealLive modes:
//   * per-scene:  `itotori extract --engine reallive --scene <N> ...`
//   * whole-game: `itotori extract --engine reallive --whole-seen ...`
// Softpal (and other whole-game engines):
//   * whole-game: `itotori extract --engine softpal ...` (no scene / whole-seen)
//
// Mirrors the M1 patch-apply seam (`applyKaifuuRealLivePatch`): the kaifuu-cli
// binary is resolved through the SAME authoritative order the native-deps
// doctor uses (ITOTORI_KAIFUU_BIN -> ITOTORI_LIBEXEC_DIR -> CARGO_TARGET_DIR /
// target release|debug -> PATH), falling back to `cargo run -p kaifuu-cli` in a
// dev checkout so the seam ships in both an installed artifact and the dev
// shell. `runProcess` is the injection seam so CI touches NO real bytes; the
// env-gated real-corpus proof exercises the real `spawnSync` path.

import {
  resolveNativeCli,
  spawnNativeCliProcess,
  type NativeCliProcessResult,
} from "../native-bin/cli-bin-resolver.js";

type KaifuuProcessResult = NativeCliProcessResult;

/**
 * Extract engines the app production path can dispatch through
 * `kaifuu-cli extract --engine <name>`. Keep this list in lockstep with the
 * engines wired into kaifuu-cli's extract arm and the capability matrix.
 */
export const KAIFUU_EXTRACT_ENGINES = ["reallive", "softpal"] as const;
export type KaifuuExtractEngine = (typeof KAIFUU_EXTRACT_ENGINES)[number];

export function isKaifuuExtractEngine(value: string): value is KaifuuExtractEngine {
  return (KAIFUU_EXTRACT_ENGINES as readonly string[]).includes(value);
}

/**
 * Per-engine extract-mode policy. RealLive is scene-scoped (u16 directory) or
 * whole-Seen; Softpal is always whole-game (SCRIPT.SRC + TEXT.DAT over the
 * title). Policy drives validation + which mode flags are forwarded to
 * kaifuu-cli — not a dual code path.
 */
export type KaifuuExtractModePolicy = "scene-or-whole-seen" | "whole-game";

export const KAIFUU_EXTRACT_MODE_POLICY: Record<KaifuuExtractEngine, KaifuuExtractModePolicy> = {
  reallive: "scene-or-whole-seen",
  softpal: "whole-game",
};

/**
 * The sourcing + identity inputs every extract needs. The four identity fields
 * mirror kaifuu-cli's required metadata flags (`--game-id` / `--game-version` /
 * `--source-profile-id` / `--source-locale`); sourcing is EITHER by-id through
 * the read-only vault OR a raw game root. `engine` selects the kaifuu-cli
 * `--engine` dispatch target (defaults to RealLive for back-compat).
 */
export type KaifuuExtractArgs = {
  /**
   * kaifuu-cli extract engine id. Defaults to `"reallive"` so existing
   * RealLive callers stay shape-compatible; Softpal (and future engines)
   * pass the id explicitly.
   */
  engine?: KaifuuExtractEngine;
  /** Sourcing (alpha production): resolve the corpus by-id through the vault. */
  vaultCanonicalId?: string;
  /**
   * Sourcing (raw-path helper): a game root containing the engine's source tree
   * (RealLive: REALLIVEDATA/Seen.txt; Softpal: data.pac / dll/Pal.dll, …).
   * When omitted, kaifuu-cli falls back to the ITOTORI_REAL_GAME_ROOT env var
   * (RealLive) / engine-specific corpus env vars.
   */
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  /** Per-scene mode (RealLive): the scene id (u16). Mutually exclusive with wholeSeen. */
  scene?: number;
  /** Whole-game mode (RealLive: entire Seen.txt). Softpal is whole-game by policy. */
  wholeSeen?: boolean;
  /** Where kaifuu writes the v0.2 BridgeBundle (the localize consumer's input). */
  bundleOutputPath: string;
  /** Optional: kaifuu's alpha-006e decompile report (zero-unknown property). */
  decompileReportOutputPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

export type KaifuuExtractMode = "per-scene" | "whole-seen" | "whole-game";

export type KaifuuExtractResult = {
  command: string;
  args: string[];
  status: number;
  /**
   * Deliberately redacted native output. A kaifuu decode diagnostic can embed
   * protected source dialogue, so this seam never lets native stdout escape.
   */
  stdout: string;
  /** Deliberately redacted native output; see {@link stdout}. */
  stderr: string;
  /** The bridge output path (verbatim from the args — kaifuu writes the file). */
  bundleOutputPath: string;
  mode: KaifuuExtractMode;
  /** The engine that was dispatched (resolved, never undefined). */
  engine: KaifuuExtractEngine;
};

export class KaifuuExtractError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "KaifuuExtractError";
  }
}

/**
 * The only native-process diagnostic this boundary may expose. In particular,
 * RealLive protected-span drift errors can include the source dialogue that
 * drifted; retaining the original stderr (or stdout fallback) would leak it
 * into CLI/API error handling and logs.
 */
export const KAIFUU_NATIVE_OUTPUT_REDACTED = "[native kaifuu output redacted]";

/** The highest scene id RealLive's u16 scene directory can address. */
export const REALLIVE_SCENE_ID_MAX = 65_535;

/** Resolve the engine id (default RealLive). */
export function resolveExtractEngine(args: Pick<KaifuuExtractArgs, "engine">): KaifuuExtractEngine {
  return args.engine ?? "reallive";
}

/**
 * Build the kaifuu-cli `extract --engine <engine>` argv (without the
 * binary-resolution prefix). Ordering mirrors the suite runner's Phase 1
 * invocation for RealLive and the whole-game flag shape for Softpal:
 *
 *   extract --engine <engine>
 *     [--vault-canonical-id <ID> | --game-root <PATH>]
 *     --game-id <ID> --game-version <V> --source-profile-id <ID> --source-locale <L>
 *     [(--scene <N> | --whole-seen)]   # only for scene-or-whole-seen engines
 *     --bundle-output <PATH> [--decompile-report-output <PATH>]
 *
 * Exposed so a test can assert the EXACT flag shape without spawning.
 */
export function buildExtractArgs(args: KaifuuExtractArgs): string[] {
  const engine = resolveExtractEngine(args);
  const policy = KAIFUU_EXTRACT_MODE_POLICY[engine];
  const out: string[] = ["extract", "--engine", engine];
  if (args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0) {
    out.push("--vault-canonical-id", args.vaultCanonicalId);
  }
  if (args.gameRoot !== undefined && args.gameRoot.length > 0) {
    out.push("--game-root", args.gameRoot);
  }
  out.push(
    "--game-id",
    args.gameId,
    "--game-version",
    args.gameVersion,
    "--source-profile-id",
    args.sourceProfileId,
    "--source-locale",
    args.sourceLocale,
  );
  if (policy === "scene-or-whole-seen") {
    if (args.wholeSeen === true) {
      out.push("--whole-seen");
    } else if (args.scene !== undefined) {
      out.push("--scene", String(args.scene));
    }
  }
  out.push("--bundle-output", args.bundleOutputPath);
  if (args.decompileReportOutputPath !== undefined) {
    out.push("--decompile-report-output", args.decompileReportOutputPath);
  }
  return out;
}

/**
 * Run `kaifuu-cli extract --engine <engine>` (per-scene / whole-seen / whole-game
 * depending on engine policy), writing the v0.2 BridgeBundle to
 * `bundleOutputPath` (kaifuu writes the file directly — this seam does NOT
 * touch the bridge bytes). Throws a {@link KaifuuExtractError} on a non-zero
 * exit or a spawn failure.
 */
export function runKaifuuExtract(args: KaifuuExtractArgs): KaifuuExtractResult {
  const env = args.env ?? process.env;
  const engine = resolveExtractEngine(args);
  validateExtractArgs(args, env, engine);

  const { command, prefixArgs } = resolveNativeCli("kaifuu-cli", env);
  const extractArgs = [...prefixArgs, ...buildExtractArgs(args)];
  args.log?.(`kaifuu-extract: ${command} ${extractArgs.join(" ")}`);
  const runProcess = args.runProcess ?? ((cmd, a, e) => defaultRunProcess(cmd, a, e, engine));
  const res = runProcess(command, extractArgs, env);
  if (res.status !== 0) {
    throw new KaifuuExtractError(
      res.status,
      KAIFUU_NATIVE_OUTPUT_REDACTED,
      `kaifuu extract (${engine}) failed with status ${String(res.status)}: ${KAIFUU_NATIVE_OUTPUT_REDACTED}`,
    );
  }
  return {
    command,
    args: extractArgs,
    status: res.status,
    stdout: redactNativeOutput(res.stdout),
    stderr: redactNativeOutput(res.stderr),
    bundleOutputPath: args.bundleOutputPath,
    mode: resolveExtractMode(args, engine),
    engine,
  };
}

function resolveExtractMode(
  args: KaifuuExtractArgs,
  engine: KaifuuExtractEngine,
): KaifuuExtractMode {
  const policy = KAIFUU_EXTRACT_MODE_POLICY[engine];
  if (policy === "whole-game") {
    return "whole-game";
  }
  return args.wholeSeen === true ? "whole-seen" : "per-scene";
}

function validateExtractArgs(
  args: KaifuuExtractArgs,
  env: NodeJS.ProcessEnv,
  engine: KaifuuExtractEngine,
): void {
  const policy = KAIFUU_EXTRACT_MODE_POLICY[engine];
  if (policy === "scene-or-whole-seen") {
    if (args.wholeSeen === true && args.scene !== undefined) {
      throw new Error(
        "kaifuu extract refused: --whole-seen and --scene are mutually exclusive (--whole-seen produces one bridge over the entire Seen.txt)",
      );
    }
    if (args.wholeSeen !== true && args.scene === undefined) {
      throw new Error(
        "kaifuu extract refused: provide --scene <N> (per-scene) or --whole-seen (whole-game)",
      );
    }
    if (
      args.scene !== undefined &&
      (!Number.isInteger(args.scene) || args.scene < 0 || args.scene > REALLIVE_SCENE_ID_MAX)
    ) {
      throw new Error(
        `kaifuu extract refused: --scene '${String(args.scene)}' must be a u16 (0..${REALLIVE_SCENE_ID_MAX})`,
      );
    }
  } else {
    // whole-game engines: refuse RealLive-only mode flags so a misrouted
    // --scene never silently drops on the floor.
    if (args.scene !== undefined) {
      throw new Error(
        `kaifuu extract refused: --scene is not valid for engine '${engine}' (whole-game extract only)`,
      );
    }
    if (args.wholeSeen === true) {
      throw new Error(
        `kaifuu extract refused: --whole-seen is not valid for engine '${engine}' (whole-game extract is implicit; omit the RealLive mode flags)`,
      );
    }
  }
  // Sourcing: at least one route must be resolvable, else fail with a clear
  // message BEFORE spawning (kaifuu-cli would error too, but the wrapper owns
  // the user-facing UX).
  const hasVault = args.vaultCanonicalId !== undefined && args.vaultCanonicalId.length > 0;
  const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
  const hasEnvGameRoot =
    env.ITOTORI_REAL_GAME_ROOT !== undefined && env.ITOTORI_REAL_GAME_ROOT.length > 0;
  if (!hasVault && !hasGameRoot && !hasEnvGameRoot) {
    throw new Error(
      "kaifuu extract refused: sourcing requires --vault-canonical-id <ID>, --game-root <PATH>, or the ITOTORI_REAL_GAME_ROOT env var",
    );
  }
}

function defaultRunProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  engine: KaifuuExtractEngine,
): KaifuuProcessResult {
  // Route through the ONE sanitized native-CLI spawn boundary so the
  // live-provider secrets are scrubbed from the child env (extract is a decode
  // tool — it never needs OpenRouter creds).
  const res = spawnNativeCliProcess(command, args, env);
  if (res.error !== undefined) {
    throw new KaifuuExtractError(
      null,
      KAIFUU_NATIVE_OUTPUT_REDACTED,
      `kaifuu extract (${engine}) could not be spawned (${command}): ${KAIFUU_NATIVE_OUTPUT_REDACTED}`,
    );
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/** Return a content-free marker whenever the native CLI emitted any bytes. */
function redactNativeOutput(output: string): string {
  return output.length === 0 ? "" : KAIFUU_NATIVE_OUTPUT_REDACTED;
}
