// Siglus patch-back adapter.
//
// Source discovery is artifact-based; it deliberately carries no title-specific
// path or key information. The native profile owns byte transformation and
// reports any unavailable patchback capability semantically.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  registerEnginePatchbackAdapter,
  type EnginePatchbackAdapter,
  type EnginePatchbackApplyRequest,
} from "./engine-adapter.js";

function hasEntry(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.toLowerCase() === name.toLowerCase());
  } catch {
    return false;
  }
}

function isSiglusRoot(dir: string): boolean {
  return hasEntry(dir, "Scene.pck") && hasEntry(dir, "Gameexe.dat");
}

/** Locate a Siglus root without treating an arbitrary directory as a match. */
export function probeSiglusSourceRoot(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isSiglusRoot(current)) return current;
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
        // An unreadable child cannot establish a source match.
      }
    }
  }
  return null;
}

export const siglusPatchbackAdapter: EnginePatchbackAdapter = {
  engineId: "siglus",
  supportedScopes: ["dialogue-only", "dialogue+choices"],
  probeSource: probeSiglusSourceRoot,
  buildApplyArgs(request: EnginePatchbackApplyRequest): string[] {
    const args = [
      "patch",
      "--engine",
      "siglus",
      "--source",
      request.sourceRoot,
      "--target",
      request.targetRoot,
      "--bundle",
      request.translatedBundlePath,
      "--scope",
      request.scope,
      "--cipher-method",
      "exe_angou_xor_lzss",
    ];
    if (request.force ?? true) args.push("--force");
    return args;
  },
};

registerEnginePatchbackAdapter(siglusPatchbackAdapter);
