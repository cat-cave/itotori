// RPG Maker MV/MZ JSON-text patch-back adapter.
//
// The engine's writable source is its `www/` directory. Kaifuu's rpgmaker
// patch command consumes the generic translated bundle, rewrites only the
// supported `data/*.json` text literals into a fresh output tree, and emits a
// sibling `.kaifuu` delta. The generic producer owns unit selection; this
// adapter owns only source discovery and the exact native argv.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  registerEnginePatchbackAdapter,
  type EnginePatchbackAdapter,
  type EnginePatchbackApplyRequest,
} from "./engine-adapter.js";

function rpgMakerDataRoot(dir: string): string | null {
  if (existsSync(join(dir, "data", "System.json"))) return dir;
  const www = join(dir, "www");
  return existsSync(join(www, "data", "System.json")) ? www : null;
}

/** Locate the engine's `www/` source directory under a direct path or a
 * mounted parent. The `data/System.json` marker is the engine contract; no
 * title-specific profile participates in selection. */
function findRpgMakerDataRoot(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const found = rpgMakerDataRoot(current);
    if (found !== null) return found;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "www") continue;
      const child = join(current, entry);
      try {
        if (statSync(child).isDirectory()) pending.push(child);
      } catch {
        // Skip unreadable mount points and continue looking for the declared
        // engine marker.
      }
    }
  }
  return null;
}

export const rpgMakerPatchbackAdapter: EnginePatchbackAdapter = {
  engineId: "rpg-maker",
  supportedScopes: ["dialogue-only", "dialogue+choices"],
  probeSource(root: string): string | null {
    return findRpgMakerDataRoot(root);
  },
  buildApplyArgs(request: EnginePatchbackApplyRequest): string[] {
    return [
      "patch",
      "--engine",
      "rpgmaker",
      "--source",
      request.sourceRoot,
      "--bundle",
      request.translatedBundlePath,
      "--delta-output",
      join(dirname(request.targetRoot), "patch-delta.kaifuu"),
      "--patched-data-output",
      request.targetRoot,
    ];
  },
};

registerEnginePatchbackAdapter(rpgMakerPatchbackAdapter);
