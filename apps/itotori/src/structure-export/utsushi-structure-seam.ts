// itotori-structure-export — the seam that wraps the `utsushi structure`
// subcommand so the narrative-structure artifact (the real dispatch-order +
// per-scene play-order message stream + speaker decode + choice/branch graph)
// is a FIRST-CLASS itotori command, not a foreign Rust bin.
//
// The narrative-structure producer lives on the UTSUSHI side
// (`crates/utsushi-cli/src/structure.rs` — it owns the replay engine that
// derives the real scene-dispatch order via `observe_playthrough`, with the
// `use_xor_2` Sweetie HD compiler-110002 staging + the Gameexe `#NAMAE` /
// `#COLOR_TABLE` speaker resolver). It emits the
// narrative-structure artifact the itotori whole-game localize driver consumes
// as its structure-informed context. This module is the
// user-shaped itotori front-door over that producer: the agent / operator
// asks `itotori structure-export` and gets the structure JSON, never having
// to know the utsushi-cli crate name or its flag surface.
//
// The binary is resolved through the SAME authoritative order the native-deps
// doctor uses (ITOTORI_UTSUSHI_BIN -> ITOTORI_LIBEXEC_DIR -> CARGO_TARGET_DIR /
// target release|debug -> PATH), falling back to `cargo run -p utsushi-cli`
// in a dev checkout so the seam ships in both an installed artifact and the
// dev shell — mirroring `resolveKaifuuCli` in `orchestrator/patch-apply-seam.ts`.

import {
  defaultRepoRoot,
  resolveNativeCliBin,
  spawnNativeCliProcess,
} from "../native-bin/cli-bin-resolver.js";

/**
 * The exit-code / stdout / stderr shape a `runProcess` injection returns.
 * Mirrors `KaifuuProcessResult` from `orchestrator/patch-apply-seam.ts` so the
 * two seams share a uniform injection contract for tests.
 */
export type UtsushiProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type RunUtsushiStructureArgs = {
  /** Path to Gameexe.ini (resolves `SEEN_START` + `#NAMAE`/`#COLOR_TABLE`). */
  gameexePath: string;
  /** Path to Seen.txt (the compressed scene archive). */
  seenPath: string;
  /** Where the producer writes the narrative-structure JSON. */
  outputPath: string;
  /** Exact Kaifuu bridge whose unit evidence is joined into the v2 export. */
  bridgePath?: string;
  /**
   * Override the Gameexe `SEEN_START` entry scene. Pass a scene id to drive
   * the dispatch-order walk from a route-specific entry (e.g. a different
   * route's opening); omit to fall back to the game's declared `SEEN_START`.
   */
  entryScene?: number;
  /**
   * Require an archive to contain at most N scenes. A smaller limit fails
   * without writing an artifact; it never produces a partial export.
   */
  maxScenes?: number;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => UtsushiProcessResult;
  log?: (message: string) => void;
};

export type RunUtsushiStructureResult = {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * Clear, typed error when the underlying `utsushi structure` invocation exits
 * non-zero. The message surfaces the producer's own stderr verbatim (the
 * utsushi-side errors are already prefixed `utsushi.structure.<step>:` so the
 * operator can trace the failure to the replay / decode step that raised it)
 * — never the spawned stdout/stderr that might carry retail script text.
 */
export class UtsushiStructureExportError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "UtsushiStructureExportError";
  }
}

/**
 * Run `utsushi structure --gameexe <Gameexe.ini> --seen <Seen.txt> --output
 * <PATH> [--bridge <PATH>] [--entry-scene <N>] [--max-scenes <N>]` and assert
 * it exited 0.
 *
 * The producer owns its own JSON write (it writes the structure artifact to
 * `outputPath` directly via `utsushi_core::write_json`); this seam returns the
 * captured invocation shape so the CLI handler can log it and tests can
 * assert the exact flag surface. A non-zero exit raises a typed
 * `UtsushiStructureExportError` carrying the producer's stderr.
 */
export function runUtsushiStructureExport(
  args: RunUtsushiStructureArgs,
): RunUtsushiStructureResult {
  const env = args.env ?? process.env;
  const { command, prefixArgs } = resolveUtsushiCli(env);
  const structureArgs = buildUtsushiStructureArgs(args);
  args.log?.(`structure-export: ${command} ${structureArgs.join(" ")}`);
  const runProcess = args.runProcess ?? defaultRunUtsushiProcess;
  const res = runProcess(command, [...prefixArgs, ...structureArgs], env);
  if (res.status !== 0) {
    throw new UtsushiStructureExportError(
      res.status,
      res.stderr,
      `utsushi structure failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    command,
    args: [...prefixArgs, ...structureArgs],
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/**
 * Build the flag surface the producer parses. The order mirrors the
 * invocation the M1 layering-fix proof (`crates/utsushi-cli/tests/
 * structure_real_sweetie_hd.rs`) drives: `structure --gameexe <p> --seen <p>
 * --output <p>` with the optional `--entry-scene` / `--max-scenes` trailing.
 */
export function buildUtsushiStructureArgs(args: RunUtsushiStructureArgs): string[] {
  const out = [
    "structure",
    "--gameexe",
    args.gameexePath,
    "--seen",
    args.seenPath,
    "--output",
    args.outputPath,
  ];
  if (args.bridgePath !== undefined) {
    out.push("--bridge", args.bridgePath);
  }
  if (args.entryScene !== undefined) {
    out.push("--entry-scene", String(args.entryScene));
  }
  if (args.maxScenes !== undefined) {
    out.push("--max-scenes", String(args.maxScenes));
  }
  return out;
}

/**
 * Resolve the utsushi-cli invocation. Delegates to the shared
 * `resolveNativeCliBin` so `itotori structure-export`, the kaifuu patch-apply
 * seam, and the native-deps doctor all settle on the SAME utsushi-cli — env
 * override -> libexec -> CARGO_TARGET_DIR -> repo target -> PATH, with a
 * `cargo run -p utsushi-cli` dev-shell fallback. The previous ad-hoc
 * resolution MISSED the repo-target + PATH steps, so an installed/PATH
 * scenario could resolve a different bin than the doctor (the codex-audit P1);
 * the shared resolver closes that gap.
 */
export function resolveUtsushiCli(env: NodeJS.ProcessEnv): {
  command: string;
  prefixArgs: string[];
} {
  return resolveNativeCliBin(
    { binName: "utsushi-cli", envVar: "ITOTORI_UTSUSHI_BIN", cargoPackage: "utsushi-cli" },
    env,
    { repoRoot: defaultRepoRoot() },
  );
}

function defaultRunUtsushiProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): UtsushiProcessResult {
  // Route through the ONE sanitized native-CLI spawn boundary so the
  // live-provider secrets are scrubbed from the child env (structure-export is
  // a decode tool — it never needs OpenRouter creds).
  const res = spawnNativeCliProcess(command, args, env);
  if (res.error !== undefined) {
    throw new UtsushiStructureExportError(
      null,
      res.error.message,
      `utsushi structure could not be spawned (${command}): ${res.error.message}`,
    );
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
