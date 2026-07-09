// The SINGLE source of truth for how the itotori app locates its native Rust
// CLI drivers (utsushi-cli / kaifuu-cli). Mirrors the EXACT order the
// native-deps doctor (`scripts/native-deps.mjs` `rustBinCandidates`) resolves
// them, so the shipped runtime and the doctor never disagree about which
// binary is authoritative (the codex-audit P1 on `itotori structure-export`).
//
// Resolution order (the authoritative doctor order + the dev-shell fallback
// the itotori seams add over the doctor):
//
//   1. explicit env override         ITOTORI_<X>_BIN
//   2. bundled libexec dir           ITOTORI_LIBEXEC_DIR/<bin>(.exe)
//   3. CARGO_TARGET_DIR release|debug
//   4. repo target/ release|debug    plain `cargo build` checkout (best-effort)
//   5. bare name on PATH             cargo install / operator PATH
//   6. cargo run -p <pkg> --quiet -- dev-shell fallback (matches the suite runner)
//
// Steps 1-5 are the doctor's `rustBinCandidates` order. Step 6 is the
// dev-checkout convenience the itotori seams add so a fresh checkout with no
// built bin still runs (the doctor simply reports fail there). Reusing this
// resolver from both `resolveKaifuuCli` (`orchestrator/patch-apply-seam.ts`)
// and `resolveUtsushiCli` (`structure-export/utsushi-structure-seam.ts`)
// guarantees the two seams — and the doctor — all settle on the SAME binary,
// so an installed / PATH / libexec scenario can never pick a divergent bin.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubLiveProviderSecretsFromEnv } from "../env/live-provider-secret-vars.js";

/**
 * Return a shallow copy of `env` with the live-provider secrets removed. Used
 * at the spawn boundary so the resolver still sees the full env (PATH, cargo
 * dirs, ITOTORI_*_BIN overrides) while the spawned child never receives the
 * OpenRouter credentials. The native tools (kaifuu-cli / utsushi-cli) are
 * byte/decode/render drivers — they never call OpenRouter, so they must not
 * inherit those credentials (a child could log its env, core-dump it, etc.).
 * Delegates to the single source of truth in `live-provider-secret-vars.mjs`
 * (shared with the external env-file loader + the native-deps doctor) so the
 * list + scrub logic can never drift; removes both file-loaded AND
 * caller-exported live-provider vars.
 */
export function scrubLiveProviderSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return scrubLiveProviderSecretsFromEnv(env);
}

/** The raw shape a native-CLI spawn returns (mirrors the relevant spawnSync fields). */
export type NativeSpawnResult = {
  error: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * THE single sanitized spawn boundary for native-tool child processes.
 *
 * Every native-CLI seam (extract / structure-export / patch-apply /
 * runNativeCli) MUST route its `spawnSync` through here so the live-provider
 * secrets are scrubbed from the child env in exactly one place — a new seam
 * that calls `spawnSync` directly with the full env is a regression the guard
 * test flags. Bin resolution still happens against the FULL env upstream; only
 * the CHILD env is scrubbed. The raw result (including any spawn `error`) is
 * returned so each seam keeps its own typed error wrapping.
 */
export function spawnNativeCliProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): NativeSpawnResult {
  const res = spawnSync(command, args, {
    env: scrubLiveProviderSecrets(env),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    error: res.error,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * The bin the shared resolver resolves for. `binName` is the cargo bin target
 * (e.g. "utsushi-cli"); `envVar` is the explicit-override env var
 * (ITOTORI_UTSUSHI_BIN); `cargoPackage` is the crate driven by the dev-shell
 * `cargo run -p <pkg>` fallback.
 */
export type NativeCliBinSpec = {
  binName: string;
  envVar: string;
  cargoPackage: string;
};

/** The resolved invocation shape the two seams drive `spawnSync` with. */
export type ResolvedCliBin = {
  command: string;
  prefixArgs: string[];
};

/**
 * Resolve a native CLI bin through the authoritative doctor order, falling
 * back to `cargo run -p <pkg> --quiet --` in a dev checkout. The two itotori
 * seams (`resolveUtsushiCli`, `resolveKaifuuCli`) are thin wrappers over this
 * so they can NEVER diverge — and so they match `rustBinCandidates` in
 * `scripts/native-deps.mjs` exactly (the doctor that gates an install).
 *
 * `repoRoot` is the optional best-effort repo root for step 4 (the plain
 * `cargo build` checkout target). Omit it in an installed artifact where no
 * repo is reachable; the seams pass `defaultRepoRoot()`, which walks up from
 * this module's location to a `flake.nix`+`Cargo.toml` marker (a no-op when
 * shipped without a repo). `env.PATH` (not `process.env.PATH`) drives the
 * step-5 `which` walk so the resolver is a pure function of `env` — callers
 * thread `process.env` at runtime, and tests can pass a deterministic `env`.
 */
export function resolveNativeCliBin(
  spec: NativeCliBinSpec,
  env: NodeJS.ProcessEnv,
  options?: { repoRoot?: string | undefined },
): ResolvedCliBin {
  // 1. explicit env override (operator / artifact pins an exact binary).
  const explicit = env[spec.envVar];
  if (explicit !== undefined && explicit.length > 0 && isExecutableFile(explicit)) {
    return { command: explicit, prefixArgs: [] };
  }
  // 2-4. bundled libexec + built targets, in the doctor's candidate order.
  for (const candidate of rustBinCandidatePaths(spec.binName, env, options?.repoRoot)) {
    if (isExecutableFile(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  // 5. bare name on PATH (cargo install / operator PATH) — the doctor's final
  //    `which` step. This is the step the ad-hoc utsushi resolver previously
  //    MISSED, so an installed/PATH scenario could resolve a different bin
  //    than the doctor (the P1).
  const onPath = whichOnPath(spec.binName, env.PATH);
  if (onPath !== undefined) {
    return { command: onPath, prefixArgs: [] };
  }
  // 6. dev-shell fallback the itotori seams add over the doctor (matches the
  //    suite runner's `run.mjs` invocation).
  return { command: "cargo", prefixArgs: ["run", "-p", spec.cargoPackage, "--quiet", "--"] };
}

/**
 * The ordered ABSOLUTE-path candidate list for steps 2-4 of the doctor order
 * (bundled libexec -> CARGO_TARGET_DIR -> repo target). Mirrors
 * `rustBinCandidates` minus the env-override (step 1, handled by the caller's
 * explicit check) and the bare-name PATH candidate (step 5, resolved via
 * `whichOnPath` because it needs a PATH walk, not a single-path probe).
 */
export function rustBinCandidatePaths(
  binName: string,
  env: NodeJS.ProcessEnv,
  repoRoot?: string,
): string[] {
  const out: string[] = [];
  if (env.ITOTORI_LIBEXEC_DIR !== undefined && env.ITOTORI_LIBEXEC_DIR.length > 0) {
    out.push(join(env.ITOTORI_LIBEXEC_DIR, binName));
    out.push(join(env.ITOTORI_LIBEXEC_DIR, `${binName}.exe`));
  }
  const targetDirs: string[] = [];
  if (env.CARGO_TARGET_DIR !== undefined && env.CARGO_TARGET_DIR.length > 0) {
    targetDirs.push(env.CARGO_TARGET_DIR);
  }
  if (repoRoot !== undefined) {
    targetDirs.push(join(repoRoot, "target"));
  }
  for (const dir of targetDirs) {
    out.push(join(dir, "release", binName));
    out.push(join(dir, "debug", binName));
  }
  return out;
}

/**
 * Best-effort repo-root for step 4 (plain `cargo build` checkout). Walks up
 * from this module's location to the nearest directory holding both
 * `flake.nix` and `Cargo.toml` (the repo root — there is exactly one
 * `flake.nix` in the tree). Returns `undefined` in an installed artifact with
 * no reachable repo, in which case step 4 is simply skipped (the installed
 * path resolves via libexec / PATH instead). Memoized: the walk happens once.
 */
export function defaultRepoRoot(): string | undefined {
  if (!repoRootComputed) {
    repoRootCached = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
    repoRootComputed = true;
  }
  return repoRootCached;
}

let repoRootComputed = false;
let repoRootCached: string | undefined;

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "flake.nix")) && existsSync(join(dir, "Cargo.toml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walk `path` (a PATH-style delimited string) for the first dir holding an
 * executable-file entry named `binName`. Mirrors the doctor probe's `which`.
 * `undefined` / empty `path` resolves nothing, so a resolver driven by an
 * `env` with no PATH skips the PATH step deterministically.
 */
function whichOnPath(binName: string, path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const full = join(dir, binName);
    if (isExecutableFile(full)) return full;
  }
  return undefined;
}

/**
 * Mirrors the native-deps doctor's real probe: a candidate only resolves when
 * it is an executable regular file. This matters for parity because an
 * earlier non-executable libexec/target file must not hide a later PATH hit
 * that the doctor would select.
 */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Named-bin registry + spawn wrapper.
//
// The commands that spawn a native CLI by a KNOWN name (itotori extract /
// patch / validate) go through `runNativeCli`, which resolves the bin via the
// SAME canonical `resolveNativeCliBin` (so there is exactly one resolver) and
// then drives it through an injectable process runner (CI touches no real
// bytes). The per-name specs live here so callers name the bin, not its env
// var / cargo package.
// ---------------------------------------------------------------------------

export type NativeCliName = "kaifuu-cli" | "utsushi-cli";

/** The per-name resolver specs — the single place bin names map to their spec. */
const NATIVE_CLI_SPECS = {
  "kaifuu-cli": {
    binName: "kaifuu-cli",
    envVar: "ITOTORI_KAIFUU_BIN",
    cargoPackage: "kaifuu-cli",
  },
  "utsushi-cli": {
    binName: "utsushi-cli",
    envVar: "ITOTORI_UTSUSHI_BIN",
    cargoPackage: "utsushi-cli",
  },
} as const satisfies Record<NativeCliName, NativeCliBinSpec>;

export type NativeCliProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type NativeCliRunProcess = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => NativeCliProcessResult;

export type NativeCliRunner = {
  env?: NodeJS.ProcessEnv;
  runProcess?: NativeCliRunProcess;
};

/**
 * Resolve a named native CLI through the canonical {@link resolveNativeCliBin}
 * (doctor order + dev-shell fallback), threading the best-effort repo root so a
 * plain `cargo build` checkout is honored. A thin name->spec convenience so the
 * spawning commands can name the bin.
 */
export function resolveNativeCli(
  bin: NativeCliName,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCliBin {
  return resolveNativeCliBin(NATIVE_CLI_SPECS[bin], env, { repoRoot: defaultRepoRoot() });
}

/**
 * Resolve a named native CLI and drive it through an injectable process
 * runner (default: a real `spawnSync`). The command commands (extract / patch /
 * validate) spawn through this so they NEVER re-implement resolution — the one
 * resolver stays authoritative.
 */
export function runNativeCli(
  bin: NativeCliName,
  args: string[],
  options: NativeCliRunner = {},
): NativeCliProcessResult & { command: string; args: string[] } {
  const env = options.env ?? process.env;
  // Resolve the bin against the FULL env (PATH, cargo dirs, ITOTORI_*_BIN
  // overrides all matter for resolution); the shared spawn boundary scrubs the
  // live-provider secrets from the CHILD env — a byte/decode/render tool never
  // needs OpenRouter creds, so they must not leak into its process environment.
  const { command, prefixArgs } = resolveNativeCli(bin, env);
  const fullArgs = [...prefixArgs, ...args];
  const runProcess = options.runProcess ?? defaultRunProcess;
  const result = runProcess(command, fullArgs, env);
  return { command, args: fullArgs, ...result };
}

function defaultRunProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): NativeCliProcessResult {
  const res = spawnNativeCliProcess(command, args, env);
  if (res.error !== undefined) {
    throw new Error(`native CLI could not be spawned (${command}): ${res.error.message}`);
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
