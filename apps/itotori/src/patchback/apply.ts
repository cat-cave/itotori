// Pure native RealLive apply: drive `kaifuu patch --engine reallive`.
//
// This is the byte-surgical apply seam, rehomed onto the accepted-output path. It
// spawns the Kaifuu CLI through the shared native-bin runner (env-scrubbed; a byte
// tool never needs provider creds) — it imports nothing from the old orchestrator
// apply/replay home. The translated bundle it applies was materialized from a
// strict PatchExportV02, so the target bodies are the accepted ones. Length-
// changing splices, protected spans, Shift-JIS, and choice encoding are the
// Kaifuu patchback's guarantees; this seam only invokes it and surfaces failure.

import { runNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** RealLive supports two byte-fidelity scopes; UI/image surfaces are carried
 * byte-identical by the patchback regardless of which is chosen. */
export type RealLivePatchScope = "dialogue-only" | "dialogue+choices";

export type RealLiveApplyArgs = {
  /** Read-only source game root (contains REALLIVEDATA/Seen.txt). */
  sourceRoot: string;
  /** Writable target root the patched archive is written under. */
  targetRoot: string;
  /** Path to the translated v0.2 bundle materialized from the PatchExportV02. */
  translatedBundlePath: string;
  scope: RealLivePatchScope;
  /** Overwrite a non-empty target (the apply always writes a fresh tree). */
  force?: boolean;
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

export type RealLiveApplyResult = {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
};

export class RealLiveApplyError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "RealLiveApplyError";
  }
}

/** The exact `kaifuu patch` argv (without the resolver prefix). Pure function so
 * a test can assert the invocation without spawning a process. */
export function realLivePatchArgs(args: RealLiveApplyArgs): string[] {
  const patchArgs = [
    "patch",
    "--engine",
    "reallive",
    "--source",
    args.sourceRoot,
    "--target",
    args.targetRoot,
    "--bundle",
    args.translatedBundlePath,
    "--scope",
    args.scope,
  ];
  if (args.force ?? true) {
    patchArgs.push("--force");
  }
  return patchArgs;
}

/**
 * Apply the translated bundle to the source `Seen.txt`, producing the byte-correct
 * patched output under `targetRoot`. Throws {@link RealLiveApplyError} on any
 * non-zero exit — there is no silent fallback.
 */
export function applyRealLivePatch(args: RealLiveApplyArgs): RealLiveApplyResult {
  const patchArgs = realLivePatchArgs(args);
  args.log?.(`native-apply: kaifuu-cli ${patchArgs.join(" ")}`);
  const res = runNativeCli("kaifuu-cli", patchArgs, args.nativeCli ?? {});
  if (res.status !== 0) {
    throw new RealLiveApplyError(
      res.status,
      res.stderr,
      `kaifuu patch (reallive) failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    command: res.command,
    args: res.args,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}
