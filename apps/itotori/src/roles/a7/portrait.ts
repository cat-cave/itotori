// The per-character portrait reference.
//
// Every bio carries a portrait media reference — always. A portrait is
// REFERENCE-ONLY: it binds the character subject to a sanitized artifact URI, a
// content hash, a media type, dimensions, and a redaction/permission policy —
// and to no bytes. The producer facts come from a real render/patch report
// through the injected provider; this module fabricates no hash, URI, or
// dimension, and re-validates the ref through the strict media contract. When a
// run has no served portrait artifact for a character, the reference is recorded
// as explicitly UNAVAILABLE (still a portrait ref, content-addressed by its
// expected hash) rather than dropped — the absence is visible, never silent.

import { buildMediaRef, type MediaArtifactFacts } from "../../wiki/media-index.js";
import { MediaRefSchema, type MediaRef } from "../../contracts/index.js";

import { portraitMediaId } from "./ids.js";

/** The portrait a run holds for one character: either a served artifact's
 * producer facts, or the expected content hash of a portrait that is not
 * currently served. */
export type A7PortraitSource =
  | { readonly status: "available"; readonly facts: MediaArtifactFacts }
  | { readonly status: "missing"; readonly expectedContentHash: string };

/** Supplies the reference-only portrait source for one character. */
export type A7PortraitProvider = (characterId: string) => A7PortraitSource;

/**
 * Build the strictly-validated portrait reference for a character. An available
 * source yields a content-addressed available ref; a missing source yields an
 * explicit unavailable ref that preserves the expected hash for later
 * re-resolution. Either way a portrait ref is ALWAYS present, and never any bytes.
 */
export function buildCharacterPortrait(characterId: string, source: A7PortraitSource): MediaRef {
  const mediaId = portraitMediaId(characterId);
  if (source.status === "available") {
    return buildMediaRef({ kind: "portrait", mediaId, characterId }, source.facts);
  }
  return MediaRefSchema.parse({
    kind: "portrait",
    mediaId,
    characterId,
    availability: {
      status: "unavailable",
      expectedContentHash: source.expectedContentHash,
      reason: "missing",
    },
  });
}
