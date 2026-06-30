// Git provenance for the generated dashboard, so the page can warn loudly when
// it was generated from a stale or dirty tree.
//
// The pure parsers/derivations live in provenance-status.ts (no node imports,
// shared with the browser client); collectGitProvenance is the only impure part
// and only ever reads local git state (NO network/fetch). Every git call is
// wrapped in try/catch so a missing repo, detached state, or absent origin/main
// degrades gracefully to "unknown" rather than throwing.

import { execFileSync } from "node:child_process";

import {
  deriveProvenanceStatus,
  parseCommitsBehind,
  parseDirty,
  provenanceBannerClassName,
  type ProvenanceStatus,
} from "./provenance-status.js";
import type { Provenance } from "./types.js";

export {
  deriveProvenanceStatus,
  parseCommitsBehind,
  parseDirty,
  provenanceBannerClassName,
  type ProvenanceStatus,
};

function tryGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Collect local git provenance for the repo at repoRoot. Network-free: it never
 * fetches; commitsBehind reflects whatever origin/main is already known locally.
 */
export function collectGitProvenance(repoRoot: string): Provenance {
  const generatedAt = new Date().toISOString();

  const headOut = tryGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const headShortSha = headOut == null ? null : headOut.trim() || null;

  const porcelain = tryGit(repoRoot, ["status", "--porcelain"]);
  const dirty = porcelain == null ? false : parseDirty(porcelain);

  const originRef = tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  const originMainKnown = originRef != null && originRef.trim().length > 0;

  let commitsBehind: number | null = null;
  if (originMainKnown) {
    const behindOut = tryGit(repoRoot, ["rev-list", "--count", "HEAD..origin/main"]);
    commitsBehind = behindOut == null ? null : parseCommitsBehind(behindOut);
  }

  return { headShortSha, generatedAt, dirty, commitsBehind, originMainKnown };
}
