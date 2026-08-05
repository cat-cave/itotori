// Native structure-export seam — wraps `utsushi structure` so the
// narrative-structure artifact is a first-class itotori command, not a
// foreign Rust bin.
//
// The narrative-structure producer lives on the UTSUSHI side
// (`crates/utsushi-cli/src/structure.rs` — it owns the replay engine that
// derives the real scene-dispatch order via `observe_playthrough`, with the
// `use_xor_2` compiler-110002 staging + the Gameexe `#NAMAE` /
// `#COLOR_TABLE` speaker resolver). It emits the narrative-structure artifact
// the itotori whole-game localize driver consumes as its structure-informed
// context. The engine project layer supplies one uniform source-root + bridge
// envelope; format-specific path resolution belongs to the native adapter.
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
import {
  nativeFailureDiagnostic,
  redactNativeDiagnostic,
} from "../native-bin/native-diagnostics.js";

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

type UtsushiStructureProcessArgs = {
  /** Where the producer writes the narrative-structure JSON. */
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => UtsushiProcessResult;
  log?: (message: string) => void;
};

/** Primitive format settings declared by an adapter manifest. */
export type UtsushiStructureAdapterConfig = Readonly<Record<string, boolean | number | string>>;

/**
 * The single operator-neutral envelope every native structure adapter accepts.
 * The engine resolves its own format files below `gameRoot`; it may interpret
 * only its declared `adapterConfig` properties.
 */
export type RunUtsushiStructureArgs = UtsushiStructureProcessArgs & {
  /** The selected source-format adapter. */
  engine: string;
  /** Read-only root containing the source material. */
  gameRoot: string;
  /** Exact bridge artifact whose units are projected into structure. */
  bridgePath: string;
  /** Optional declared format-only settings. */
  adapterConfig?: UtsushiStructureAdapterConfig;
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
 * non-zero. The message preserves the producer's safe diagnostic context,
 * while content and secret spans are removed before it reaches the operator.
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
 * Run a native adapter's uniform `utsushi structure` command and assert it
 * exited 0. The native adapter resolves format-specific files below the supplied
 * game root rather than exposing them as operator flags.
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
  // A supplied runner owns an explicit process seam. Keep its resolution
  // bounded to that runner's environment rather than letting a cached binary
  // under this checkout change the injected invocation shape. Production keeps
  // the full native-deps resolution order, including the checkout target.
  const { command, prefixArgs } = resolveUtsushiCli(env, {
    includeCheckoutTarget: args.runProcess === undefined,
  });
  const structureArgs = buildUtsushiStructureArgs(args);
  args.log?.(`structure-export: ${command} ${structureArgs.join(" ")}`);
  const runProcess = args.runProcess ?? defaultRunUtsushiProcess;
  const res = runProcess(command, [...prefixArgs, ...structureArgs], env);
  if (res.status !== 0) {
    const diagnostic = nativeFailureDiagnostic(res, env);
    throw new UtsushiStructureExportError(
      res.status,
      diagnostic,
      `utsushi structure failed with status ${String(res.status)}: ${diagnostic}`,
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
 * Build the one native structure invocation used by every adapter. A non-empty
 * adapter config remains one generic JSON value; no format-specific flag enters
 * this boundary.
 */
export function buildUtsushiStructureArgs(args: RunUtsushiStructureArgs): string[] {
  const out = [
    "structure",
    "--engine",
    args.engine,
    "--game-root",
    args.gameRoot,
    "--bridge",
    args.bridgePath,
    "--output",
    args.outputPath,
  ];
  if (args.adapterConfig !== undefined && Object.keys(args.adapterConfig).length > 0) {
    out.push("--adapter-config", JSON.stringify(args.adapterConfig));
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
export function resolveUtsushiCli(
  env: NodeJS.ProcessEnv,
  options: { includeCheckoutTarget?: boolean } = {},
): {
  command: string;
  prefixArgs: string[];
} {
  return resolveNativeCliBin(
    { binName: "utsushi-cli", envVar: "ITOTORI_UTSUSHI_BIN", cargoPackage: "utsushi-cli" },
    env,
    {
      repoRoot: options.includeCheckoutTarget === false ? undefined : defaultRepoRoot(),
    },
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
    const diagnostic = nativeFailureDiagnostic(res, env);
    throw new UtsushiStructureExportError(
      null,
      diagnostic,
      `utsushi structure could not be spawned (${redactNativeDiagnostic(command, env)}): ${diagnostic}`,
    );
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
