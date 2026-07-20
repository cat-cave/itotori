// itotori-cli-extract-command (P1, user-shaped CLI) — the engine-agnostic spawn
// orchestration behind every `itotori extract`.
//
// The user-shaped extract wraps `kaifuu-cli extract --engine <engine>`, producing
// the BridgeBundle that `itotori localize` consumes — WITHOUT forcing the caller
// to know about the Rust binary or `cargo`. This module is engine-agnostic: it
// resolves the ADAPTER for the request's REQUIRED `engine` discriminant from the
// `extract-adapter-registry`, then delegates argv construction, pre-spawn
// validation, and mode reporting to that adapter. There is NO default engine —
// an omitted or unregistered engine is REJECTED at the boundary (see
// `resolveExtractAdapter`), never silently routed to RealLive. Output is always
// the common `BridgeBundleV02`, whichever engine produced it.
//
// The kaifuu-cli binary is resolved through the SAME authoritative order the
// native-deps doctor uses (ITOTORI_KAIFUU_BIN -> ITOTORI_LIBEXEC_DIR ->
// CARGO_TARGET_DIR / target release|debug -> PATH), falling back to `cargo run -p
// kaifuu-cli` in a dev checkout so the seam ships in both an installed artifact
// and the dev shell. `runProcess` is the injection seam so CI touches NO real
// bytes; the env-gated real-corpus proof exercises the real `spawnSync` path.

import { resolveNativeCli, spawnNativeCliProcess } from "../native-bin/cli-bin-resolver.js";
import {
  resolveExtractAdapter,
  type ExtractEngineId,
  type ExtractMode,
  type KaifuuExtractArgs,
  type KaifuuProcessResult,
} from "./extract-adapter-registry.js";

// Re-export the engine-discriminated request vocabulary so existing importers
// (CLI handler, Studio decode/extract runner, tests) keep a single entry point.
export {
  extractCapabilities,
  isRegisteredExtractEngine,
  REALLIVE_SCENE_ID_MAX,
  registeredExtractEngines,
} from "./extract-adapter-registry.js";
export type {
  ExtractCapability,
  ExtractSource,
  KaifuuEngine,
  KaifuuRealliveExtractArgs,
  KaifuuRpgMakerExtractArgs,
  KaifuuSoftpalExtractArgs,
  RealliveExtractSource,
  RpgMakerExtractSource,
  SoftpalExtractSource,
} from "./extract-adapter-registry.js";
// Locally-bound (used here) re-exports.
export { resolveExtractAdapter };
export type { ExtractEngineId, ExtractMode, KaifuuExtractArgs, KaifuuProcessResult };

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
  engine: ExtractEngineId;
  /**
   * RealLive: `per-scene` or `whole-seen`. Softpal / RPG Maker: `whole-game`
   * (one bridge over the engine's whole text surface).
   */
  mode: ExtractMode;
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

/**
 * Build the kaifuu-cli `extract --engine <engine>` argv (without the
 * binary-resolution prefix) by delegating to the request's registered adapter.
 * Exposed (re-exported as `buildExtractArgs`) so a test can assert the EXACT flag
 * shape without spawning.
 */
export function buildExtractArgs(args: KaifuuExtractArgs): string[] {
  return resolveExtractAdapter(args.engine).buildArgs(args);
}

/**
 * Run `kaifuu-cli extract --engine <engine>`, writing the BridgeBundle to
 * `bundleOutputPath` (kaifuu writes the file directly — this seam does NOT touch
 * the bridge bytes). The engine's registered adapter owns argv/validation/mode;
 * an omitted or unregistered engine is rejected here BEFORE any spawn. Throws a
 * {@link KaifuuExtractError} on a non-zero exit or a spawn failure.
 */
export function runKaifuuExtract(args: KaifuuExtractArgs): KaifuuExtractResult {
  const adapter = resolveExtractAdapter(args.engine);
  const engine = adapter.engine;
  const env = args.env ?? process.env;
  adapter.validate(args, env);

  const { command, prefixArgs } = resolveNativeCli("kaifuu-cli", env);
  const extractArgs = [...prefixArgs, ...adapter.buildArgs(args)];
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
    mode: adapter.mode(args),
  };
}

function defaultRunProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  engine: ExtractEngineId,
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
