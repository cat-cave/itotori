// Byte-range-scoped patch update — the offline-provable LOGIC for the patch
// half of a precise enhancement.
//
// A real patch run splices accepted-target bytes into the game via the native
// patchback; THAT byte-for-byte assertion over real patched bytes is a
// LIVE-LANE follow-up (it needs the native Kaifuu apply over the real game
// root, not a deterministic fixture). This module proves the SCOPING LOGIC
// deterministically: given the prior patch entries and the set of consumers an
// enhancement reached, ONLY the reached entries' accepted-target bytes may
// change; every other entry is copied BYTE-IDENTICAL (the same object
// reference, the same content hash). It is the same partition the enhancement
// impact uses, lifted onto the patch bytes.
//
// No model, no I/O, no native binary: same prior + impacted keys + redraft =>
// same scoped entries. The byte-range overlap is pure interval math, so a
// change confined to one entry's range cannot reach another's.

import type { PatchExportEntryV02 } from "@itotori/localization-bridge-schema";

/** A half-open byte range `[start, end)`: the bytes an accepted target occupies
 * in the assembled patch, and the primitive that decides whether a change
 * reaches a given entry. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * True when two byte ranges share any byte. Pure interval math — the byte-level
 * analogue of the route/play-window overlap the impact set uses. A change
 * confined to one entry's range provably cannot reach a disjoint entry's range.
 */
export function byteRangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.end && right.start < left.end;
}

const encoder = new TextEncoder();

/** The UTF-8 byte length of an accepted target's text. */
export function targetTextByteLength(entry: Pick<PatchExportEntryV02, "targetText">): number {
  return encoder.encode(entry.targetText).length;
}

/**
 * The byte range an accepted target occupies at a stable `offset`. Used with
 * {@link byteRangesOverlap} to prove that a change scoped to one entry's
 * accepted-target bytes cannot overlap a disjoint entry's bytes — the
 * deterministic half of the "changes only expected patch BYTE ranges" clause.
 */
export function targetTextByteRange(
  entry: Pick<PatchExportEntryV02, "targetText">,
  offset = 0,
): ByteRange {
  return { start: offset, end: offset + targetTextByteLength(entry) };
}

/** The scoped patch update: the re-emitted entries plus the partition that
 * proves which accepted-target byte ranges changed and which stayed identical. */
export interface PatchUpdateScope {
  /** The next entries, in prior order, with impacted entries re-emitted and
   * every preserved entry the SAME object reference (byte-identical). */
  readonly entries: readonly PatchExportEntryV02[];
  /** Source-unit keys whose accepted target the enhancement reached — their
   * patch bytes may change. */
  readonly changedSourceUnitKeys: readonly string[];
  /** Source-unit keys the enhancement did not reach — their patch bytes are
   * byte/hash-identical. */
  readonly preservedSourceUnitKeys: readonly string[];
}

/**
 * Scope a patch update to ONLY the entries whose accepted target an enhancement
 * reached. Impacted entries are re-emitted via `redraft`; every other entry is
 * returned UNCHANGED — the same object reference, so its patch bytes are
 * byte/hash-identical. Pure in `(prior, impactedSourceUnitKeys, redraft)`.
 *
 * This is the deterministic scoping logic; the live lane proves the SAME
 * partition over the real Kaifuu-spliced game bytes (a live-only follow-up).
 */
export function scopePatchUpdate(input: {
  readonly prior: readonly PatchExportEntryV02[];
  readonly impactedSourceUnitKeys: readonly string[];
  readonly redraft: (sourceUnitKey: string) => PatchExportEntryV02;
}): PatchUpdateScope {
  const impacted = new Set(input.impactedSourceUnitKeys);
  const changedKeys: string[] = [];
  const preservedKeys: string[] = [];
  const entries = input.prior.map((entry) => {
    if (impacted.has(entry.sourceUnitKey)) {
      changedKeys.push(entry.sourceUnitKey);
      return input.redraft(entry.sourceUnitKey);
    }
    preservedKeys.push(entry.sourceUnitKey);
    return entry;
  });
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return {
    entries,
    changedSourceUnitKeys: [...changedKeys].sort(compare),
    preservedSourceUnitKeys: [...preservedKeys].sort(compare),
  };
}
