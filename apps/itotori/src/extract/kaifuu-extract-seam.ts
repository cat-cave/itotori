// itotori-cli-extract-command (P1, user-shaped CLI).
//
// The user-shaped `itotori extract` command wraps
// `kaifuu-cli extract --engine reallive`, producing the v0.2 BridgeBundle that
// `itotori localize` consumes — WITHOUT forcing the
// caller to know about the Rust binary or `cargo`. Both RealLive modes are
// wired:
//
//   * per-scene:  `itotori extract --scene <N> ...`  -> one bridge over scene N
//                  (kaifuu-reallive `produce_bundle`).
//   * whole-game: `itotori extract --whole-seen ...` -> one bridge over the
//                  entire Seen.txt (kaifuu-reallive `produce_whole_seen_bundle`;
//                  the replay-derived dispatch order is NOT kaifuu's concern —
//                  deps flow utsushi -> kaifuu, never the reverse).
//
// Mirrors the M1 patch-apply seam (`applyKaifuuRealLivePatch`): the kaifuu-cli
// binary is resolved through the SAME authoritative order the native-deps
// doctor uses (ITOTORI_KAIFUU_BIN -> ITOTORI_LIBEXEC_DIR -> CARGO_TARGET_DIR /
// target release|debug -> PATH), falling back to `cargo run -p kaifuu-cli` in a
// dev checkout so the seam ships in both an installed artifact and the dev
// shell. `runProcess` is the injection seam so CI touches NO real bytes; the
// env-gated real-Sweetie proof exercises the real `spawnSync` path.

import { resolveKaifuuCli, type KaifuuProcessResult } from "../orchestrator/patch-apply-seam.js";
import { spawnNativeCliProcess } from "../native-bin/cli-bin-resolver.js";

/**
 * The sourcing + identity inputs every RealLive extract needs. The four
 * identity fields mirror kaifuu-cli's `required_reallive_metadata_flag`
 * (`--game-id` / `--game-version` / `--source-profile-id` / `--source-locale`);
 * sourcing is EITHER by-id through the read-only vault OR a raw game root.
 */
export type KaifuuExtractArgs = {
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
  /** Where kaifuu writes the v0.2 BridgeBundle (the localize consumer's input). */
  bundleOutputPath: string;
  /** Optional: kaifuu's alpha-006e decompile report (zero-unknown property). */
  decompileReportOutputPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

export type KaifuuExtractResult = {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
  /** The bridge output path (verbatim from the args — kaifuu writes the file). */
  bundleOutputPath: string;
  mode: "per-scene" | "whole-seen";
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

/** The highest scene id RealLive's u16 scene directory can address. */
export const REALLIVE_SCENE_ID_MAX = 65_535;

/**
 * Build the kaifuu-cli `extract --engine reallive` argv (without the
 * binary-resolution prefix). The ordering mirrors the suite runner's Phase 1
 * invocation (`suite/scripts/localize-project/run.mjs`):
 *
 *   extract --engine reallive
 *     [--vault-canonical-id <ID> | --game-root <PATH>]
 *     --game-id <ID> --game-version <V> --source-profile-id <ID> --source-locale <L>
 *     (--scene <N> | --whole-seen)
 *     --bundle-output <PATH> [--decompile-report-output <PATH>]
 *
 * Exposed so a test can assert the EXACT flag shape without spawning.
 */
export function buildExtractArgs(args: KaifuuExtractArgs): string[] {
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
 * Run `kaifuu-cli extract --engine reallive` (per-scene OR --whole-seen),
 * writing the v0.2 BridgeBundle to `bundleOutputPath` (kaifuu writes the file
 * directly — this seam does NOT touch the bridge bytes). Throws a
 * {@link KaifuuExtractError} on a non-zero exit or a spawn failure.
 */
export function runKaifuuRealliveExtract(args: KaifuuExtractArgs): KaifuuExtractResult {
  const env = args.env ?? process.env;
  validateExtractArgs(args, env);

  const { command, prefixArgs } = resolveKaifuuCli(env);
  const extractArgs = [...prefixArgs, ...buildExtractArgs(args)];
  args.log?.(`kaifuu-extract: ${command} ${extractArgs.join(" ")}`);
  const runProcess = args.runProcess ?? ((cmd, a, e) => defaultRunProcess(cmd, a, e));
  const res = runProcess(command, extractArgs, env);
  if (res.status !== 0) {
    throw new KaifuuExtractError(
      res.status,
      res.stderr,
      `kaifuu extract (reallive) failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    command,
    args: extractArgs,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    bundleOutputPath: args.bundleOutputPath,
    mode: args.wholeSeen === true ? "whole-seen" : "per-scene",
  };
}

function validateExtractArgs(args: KaifuuExtractArgs, env: NodeJS.ProcessEnv): void {
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
): KaifuuProcessResult {
  // Route through the ONE sanitized native-CLI spawn boundary so the
  // live-provider secrets are scrubbed from the child env (extract is a decode
  // tool — it never needs OpenRouter creds).
  const res = spawnNativeCliProcess(command, args, env);
  if (res.error !== undefined) {
    throw new KaifuuExtractError(
      null,
      res.error.message,
      `kaifuu extract (reallive) could not be spawned (${command}): ${res.error.message}`,
    );
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
