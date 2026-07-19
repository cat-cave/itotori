// itotori-cli-extract-command (P1, user-shaped CLI).
//
// The user-shaped `itotori extract` command wraps `kaifuu-cli extract --engine
// <engine>`, producing the BridgeBundle that `itotori localize` consumes —
// WITHOUT forcing the caller to know about the Rust binary or `cargo`. The seam
// is engine-parametric: the SAME production path drives every engine the
// kaifuu-cli `--engine` flag supports; the argv shape per engine is the only
// thing that differs. Wired engines:
//
//   * reallive (v0.2 bridge): per-scene `--scene <N>` (kaifuu-reallive
//                  `produce_bundle`) OR whole-game `--whole-seen`
//                  (`produce_whole_seen_bundle`; the replay-derived dispatch
//                  order is NOT kaifuu's concern — deps flow utsushi -> kaifuu,
//                  never the reverse). Sourcing is by-id through the vault OR a
//                  raw game root.
//   * softpal (v0.1 bridge): whole-game over SCRIPT.SRC + TEXT.DAT (the game
//                  root is passed positionally, exactly as the kaifuu-cli
//                  `extract --engine softpal <root>` arm consumes it). Softpal
//                  resolves TEXT.DAT (de)cryption internally — no scene index,
//                  vault identity, or user key is required.
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

/** The kaifuu-cli extract engines this seam dispatches. */
export type KaifuuEngine = "reallive" | "softpal";

/** Inputs shared by every engine's extract. */
type KaifuuExtractCommonArgs = {
  /** Where kaifuu writes the BridgeBundle (the localize consumer's input). */
  bundleOutputPath: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

/**
 * The sourcing + identity inputs a RealLive extract needs. The four identity
 * fields mirror kaifuu-cli's `required_reallive_metadata_flag` (`--game-id` /
 * `--game-version` / `--source-profile-id` / `--source-locale`); sourcing is
 * EITHER by-id through the read-only vault OR a raw game root.
 */
export type KaifuuRealliveExtractArgs = KaifuuExtractCommonArgs & {
  /** Engine discriminant. Optional/`"reallive"` selects the RealLive argv. */
  engine?: "reallive";
  /** Sourcing (alpha production): resolve the corpus by-id through the vault. */
  vaultCanonicalId?: string;
  /**
   * Sourcing (raw-path helper): a game root containing REALLIVEDATA/Seen.txt.
   * When omitted, kaifuu-cli falls back to the ITOTORI_REAL_GAME_ROOT env var.
   */
  gameRoot?: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
  /** Per-scene mode: the scene id (u16). Mutually exclusive with wholeSeen. */
  scene?: number;
  /** Whole-game mode: one bridge over the entire Seen.txt. */
  wholeSeen?: boolean;
  /** Optional: kaifuu's alpha-006e decompile report (zero-unknown property). */
  decompileReportOutputPath?: string;
};

/**
 * The inputs a Softpal extract needs. Softpal takes the game root POSITIONALLY
 * (matching the `extract --engine softpal <root>` arm); it enumerates
 * SCRIPT.SRC + TEXT.DAT (from `data.pac` or a loose pair) and needs no scene
 * index, vault identity, or user-provided key.
 */
export type KaifuuSoftpalExtractArgs = KaifuuExtractCommonArgs & {
  /** Engine discriminant. */
  engine: "softpal";
  /**
   * The Softpal game root (passed positionally). When omitted, kaifuu-cli falls
   * back to the ITOTORI_REAL_GAME_ROOT_SOFTPAL env var.
   */
  gameRoot?: string;
};

/** Engine-parametric extract args — a RealLive OR Softpal invocation. */
export type KaifuuExtractArgs = KaifuuRealliveExtractArgs | KaifuuSoftpalExtractArgs;

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
  /** The engine that produced the bridge. */
  engine: KaifuuEngine;
  /**
   * RealLive: `per-scene` or `whole-seen`. Softpal: `whole-game` (one bridge
   * over the entire SCRIPT.SRC/TEXT.DAT text surface).
   */
  mode: "per-scene" | "whole-seen" | "whole-game";
};

/** Narrow the engine discriminant (RealLive is the default when omitted). */
function extractEngine(args: KaifuuExtractArgs): KaifuuEngine {
  return args.engine ?? "reallive";
}

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

/**
 * Build the kaifuu-cli `extract --engine <engine>` argv (without the
 * binary-resolution prefix). Dispatches on the engine discriminant so Softpal
 * routes through the SAME seam as RealLive; the RealLive argv is byte-identical
 * to before. Exposed so a test can assert the EXACT flag shape without spawning.
 */
export function buildExtractArgs(args: KaifuuExtractArgs): string[] {
  if (extractEngine(args) === "softpal") {
    return buildSoftpalExtractArgs(args as KaifuuSoftpalExtractArgs);
  }
  return buildRealliveExtractArgs(args as KaifuuRealliveExtractArgs);
}

/**
 * The RealLive argv. The ordering mirrors the suite runner's Phase 1 invocation
 * (`suite/scripts/localize-project/run.mjs`):
 *
 *   extract --engine reallive
 *     [--vault-canonical-id <ID> | --game-root <PATH>]
 *     --game-id <ID> --game-version <V> --source-profile-id <ID> --source-locale <L>
 *     (--scene <N> | --whole-seen)
 *     --bundle-output <PATH> [--decompile-report-output <PATH>]
 */
function buildRealliveExtractArgs(args: KaifuuRealliveExtractArgs): string[] {
  const out: string[] = ["extract", "--engine", "reallive"];
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
  if (args.wholeSeen === true) {
    out.push("--whole-seen");
  } else if (args.scene !== undefined) {
    out.push("--scene", String(args.scene));
  }
  out.push("--bundle-output", args.bundleOutputPath);
  if (args.decompileReportOutputPath !== undefined) {
    out.push("--decompile-report-output", args.decompileReportOutputPath);
  }
  return out;
}

/**
 * The Softpal argv. The game root is POSITIONAL (exactly as the kaifuu-cli
 * `extract --engine softpal <root> --bundle-output <PATH>` arm consumes it);
 * when omitted, kaifuu-cli reads ITOTORI_REAL_GAME_ROOT_SOFTPAL itself:
 *
 *   extract --engine softpal [<root>] --bundle-output <PATH>
 */
function buildSoftpalExtractArgs(args: KaifuuSoftpalExtractArgs): string[] {
  const out: string[] = ["extract", "--engine", "softpal"];
  if (args.gameRoot !== undefined && args.gameRoot.length > 0) {
    out.push(args.gameRoot);
  }
  out.push("--bundle-output", args.bundleOutputPath);
  return out;
}

function extractMode(args: KaifuuExtractArgs): KaifuuExtractResult["mode"] {
  if (extractEngine(args) === "softpal") {
    return "whole-game";
  }
  return (args as KaifuuRealliveExtractArgs).wholeSeen === true ? "whole-seen" : "per-scene";
}

/**
 * Run `kaifuu-cli extract --engine <engine>` (RealLive per-scene / --whole-seen,
 * or Softpal whole-game), writing the BridgeBundle to `bundleOutputPath` (kaifuu
 * writes the file directly — this seam does NOT touch the bridge bytes). Throws
 * a {@link KaifuuExtractError} on a non-zero exit or a spawn failure.
 */
export function runKaifuuExtract(args: KaifuuExtractArgs): KaifuuExtractResult {
  const engine = extractEngine(args);
  const env = args.env ?? process.env;
  validateExtractArgs(args, env);

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
    engine,
    mode: extractMode(args),
  };
}

function validateExtractArgs(args: KaifuuExtractArgs, env: NodeJS.ProcessEnv): void {
  if (extractEngine(args) === "softpal") {
    validateSoftpalExtractArgs(args as KaifuuSoftpalExtractArgs, env);
    return;
  }
  validateRealliveExtractArgs(args as KaifuuRealliveExtractArgs, env);
}

/**
 * Softpal sourcing: the game root must be resolvable BEFORE spawning — either a
 * positional root (`gameRoot`) or the ITOTORI_REAL_GAME_ROOT_SOFTPAL env var
 * kaifuu-cli reads itself. Softpal needs no scene index, vault identity, or key.
 */
function validateSoftpalExtractArgs(args: KaifuuSoftpalExtractArgs, env: NodeJS.ProcessEnv): void {
  const hasGameRoot = args.gameRoot !== undefined && args.gameRoot.length > 0;
  const hasEnvGameRoot =
    env.ITOTORI_REAL_GAME_ROOT_SOFTPAL !== undefined &&
    env.ITOTORI_REAL_GAME_ROOT_SOFTPAL.length > 0;
  if (!hasGameRoot && !hasEnvGameRoot) {
    throw new Error(
      "kaifuu extract (softpal) refused: sourcing requires a game root — pass gameRoot or set the ITOTORI_REAL_GAME_ROOT_SOFTPAL env var",
    );
  }
}

function validateRealliveExtractArgs(
  args: KaifuuRealliveExtractArgs,
  env: NodeJS.ProcessEnv,
): void {
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
  engine: KaifuuEngine,
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
