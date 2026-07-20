// RealLive patch-back adapter.
//
// Re-homes the former standalone `applyRealLivePatch` behind the engine registry
// (no dual path). RealLive patches the source's `REALLIVEDATA/Seen.txt` in place
// under a writable target via `kaifuu patch --engine reallive --bundle <translated>`;
// the translated v0.2 bundle it consumes is the generic producer's output. Both
// byte-fidelity scopes are honored (out-of-scope surfaces carried byte-identical
// by the patchback), and the produced tree is the patched Seen.txt archive.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  registerEnginePatchbackAdapter,
  type EnginePatchbackAdapter,
  type EnginePatchbackApplyRequest,
} from "./engine-adapter.js";

/** Locate the RealLive game root under `root`: the directory that holds
 * `REALLIVEDATA/Seen.txt` (+ `Gameexe.ini`). Direct hit first, then a bounded
 * walk so a caller may point at a mounted retail parent. Returns null when no
 * RealLive archive is present. */
function findRealLiveRoot(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      existsSync(join(current, "REALLIVEDATA", "Seen.txt")) &&
      existsSync(join(current, "REALLIVEDATA", "Gameexe.ini"))
    ) {
      return current;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "REALLIVEDATA") continue;
      const child = join(current, entry);
      try {
        if (statSync(child).isDirectory()) pending.push(child);
      } catch {
        // A real game tree can carry unreadable mount points; skip and keep
        // looking for the declared RealLive root.
      }
    }
  }
  return null;
}

export const realLivePatchbackAdapter: EnginePatchbackAdapter = {
  engineId: "reallive",
  supportedScopes: ["dialogue-only", "dialogue+choices"],
  probeSource(root: string): string | null {
    return findRealLiveRoot(root);
  },
  buildApplyArgs(request: EnginePatchbackApplyRequest): string[] {
    const args = [
      "patch",
      "--engine",
      "reallive",
      "--source",
      request.sourceRoot,
      "--target",
      request.targetRoot,
      "--bundle",
      request.translatedBundlePath,
      "--scope",
      request.scope,
    ];
    // The apply always writes a fresh tree; RealLive overwrites a non-empty
    // target only with --force. Preserve the historical default (force on).
    if (request.force ?? true) {
      args.push("--force");
    }
    return args;
  },
};

registerEnginePatchbackAdapter(realLivePatchbackAdapter);
