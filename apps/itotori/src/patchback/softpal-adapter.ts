// Softpal (Amuse Craft / "Pal") patch-back adapter.
//
// Softpal patches by rebuilding TEXT.DAT and repointing SCRIPT.SRC as loose
// files under a writable output directory via `kaifuu patch --engine softpal
// --patch <PatchExportV02> --output <dir>`. Unlike RealLive it consumes the
// strict PatchExportV02 JSON (`--patch`), not the translated bundle, and takes
// no `--scope` / `--force`: the units it rewrites are exactly those the export
// names, so the config-driven scope is already honored by unit selection
// upstream. The produced tree is the loose-file `data\` override the engine
// prefers over `data.pac`.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  PatchbackEngineSelectionError,
  registerEnginePatchbackAdapter,
  type EnginePatchbackAdapter,
  type EnginePatchbackApplyRequest,
} from "./engine-adapter.js";

/** Case-insensitively test whether `dir` directly contains `name`. */
function hasEntry(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.toLowerCase() === name.toLowerCase());
  } catch {
    return false;
  }
}

/** A Softpal game root carries the scripts EITHER inside `data.pac` OR as a
 * loose `SCRIPT.SRC` + `TEXT.DAT` pair (matching the kaifuu-softpal inventory
 * resolver). */
function isSoftpalRoot(dir: string): boolean {
  if (hasEntry(dir, "data.pac")) return true;
  return hasEntry(dir, "SCRIPT.SRC") && hasEntry(dir, "TEXT.DAT");
}

/** Locate the Softpal game root under `root` (direct hit, then a bounded walk).
 * Returns null when no Softpal source artifacts are present. */
function findSoftpalRoot(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isSoftpalRoot(current)) return current;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry);
      try {
        if (statSync(child).isDirectory()) pending.push(child);
      } catch {
        // Skip unreadable children and keep looking for the Softpal root.
      }
    }
  }
  return null;
}

export const softpalPatchbackAdapter: EnginePatchbackAdapter = {
  engineId: "softpal",
  // Softpal rewrites exactly the units the PatchExport names, so both
  // config-driven scopes resolve to the same full-text-surface patch.
  supportedScopes: ["dialogue-only", "dialogue+choices"],
  probeSource(root: string): string | null {
    return findSoftpalRoot(root);
  },
  buildApplyArgs(request: EnginePatchbackApplyRequest): string[] {
    if (request.patchExportPath === undefined) {
      throw new PatchbackEngineSelectionError(
        "missing-artifact",
        "softpal patch requires the strict PatchExportV02 to be materialized (patchExportPath is missing)",
      );
    }
    return [
      "patch",
      "--engine",
      "softpal",
      "--source",
      request.sourceRoot,
      "--patch",
      request.patchExportPath,
      "--output",
      request.targetRoot,
    ];
  },
};

registerEnginePatchbackAdapter(softpalPatchbackAdapter);
