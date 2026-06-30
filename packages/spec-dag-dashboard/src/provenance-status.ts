// Pure provenance helpers — NO node imports, so the browser client can share
// this exact logic without esbuild pulling node:child_process into the bundle.
// The impure git collector lives in provenance.ts and re-exports these.

import type { Provenance } from "./types.js";

export type ProvenanceStatus = "current" | "behind" | "dirty" | "behind-dirty" | "unknown";

/** Parse `git rev-list --count` output ("3\n") to a number, else null. */
export function parseCommitsBehind(out: string): number | null {
  const trimmed = out.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A non-empty `git status --porcelain` means the working tree is dirty. */
export function parseDirty(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

/** Derive the headline provenance status from a collected Provenance record. */
export function deriveProvenanceStatus(p: Provenance): ProvenanceStatus {
  if (!p.originMainKnown) return "unknown";
  const behind = (p.commitsBehind ?? 0) > 0;
  if (behind && p.dirty) return "behind-dirty";
  if (behind) return "behind";
  if (p.dirty) return "dirty";
  return "current";
}

/**
 * The provenance banner's CSS class. Only `current` (verified up-to-date,
 * clean tree) earns the reassuring `ok` styling; `unknown` is a WARN, not a
 * neutral state, because an absent origin/main means staleness is
 * unverifiable — rendering it as "ok"/neutral would mask stale provenance.
 */
export function provenanceBannerClassName(p: Provenance): string {
  return deriveProvenanceStatus(p) === "current" ? "provbanner ok" : "provbanner warn";
}
