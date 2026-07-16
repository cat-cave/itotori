// Deterministic UUIDv7 minting for the patchback export.
//
// The PatchExportV02 identities (patchExportId, per-entry entryId) must be
// content-addressed so a re-export over identical inputs is byte-identical (the
// moat's determinism guarantee). We derive all 16 bytes from a SHA-256 of the
// seed and stamp the version (7) + RFC-4122 variant nibbles, so the value passes
// `isUuid7` yet is a pure function of the seed — no clock, no randomness.

import { createHash } from "node:crypto";

/** Mint a deterministic, `isUuid7`-valid identifier from a stable string seed. */
export function deterministicUuid7(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const bytes = Buffer.alloc(16);
  digest.copy(bytes, 0, 0, 16);
  // Version 7 in the high nibble of byte 6; RFC-4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
