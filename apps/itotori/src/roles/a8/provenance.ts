// Provenance verification for the upstream input A8 consumes.
//
// A8 does not trust a caller-supplied character bio on its face: it BINDS the
// bio to its authoritative artifact before using it. A bio is authentic only
// when it is a `character-bio` object ABOUT this exact character, authored by the
// biographer role over the SAME immutable snapshot A8 reasons from, carrying the
// deterministic object id the biographer stamps, and whose every claim resolves
// against that snapshot. A fabricated bio — wrong subject, wrong snapshot, forged
// object id, or an unresolvable claim — is rejected loud, never silently consumed.

import type { ReadModel } from "../../read-tools/index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";
import type { WikiObject } from "../../contracts/index.js";

import { A8RoleError, CONSUMED_BIO_KIND } from "./types.js";

/** The deterministic object id the biographer stamps for one character's bio.
 * A8 recomputes it here so a forged id cannot masquerade as the real artifact. */
function expectedBioObjectId(characterId: string): string {
  return `character-bio:${characterId}`;
}

/**
 * Verify a caller-supplied bio is the authentic upstream artifact for
 * `characterId` over `model`'s snapshot, or throw {@link A8RoleError}
 * (`unverified-bio`). Returns the bio unchanged when it binds. Every dimension is
 * checked against the authoritative snapshot, never against the bio's own claims
 * about itself.
 */
export function verifyBioProvenance(
  model: ReadModel,
  characterId: string,
  bio: WikiObject,
): WikiObject {
  const reject = (detail: string): never => {
    throw new A8RoleError("unverified-bio", `bio for ${characterId} ${detail}`);
  };
  if (bio.kind !== CONSUMED_BIO_KIND) reject(`is not a ${CONSUMED_BIO_KIND} object`);
  if (bio.subject.kind !== "character" || bio.subject.id !== characterId) {
    reject("subject is not this character");
  }
  if (bio.objectId !== expectedBioObjectId(characterId)) reject("object id is forged");
  if (bio.provenance.authorRoleId !== "A7") reject("was not authored by the biographer");
  if (bio.provenance.contextSnapshotId !== model.snapshotId) {
    reject("was authored over a different snapshot");
  }
  if (bio.kind === CONSUMED_BIO_KIND && bio.body.characterId !== characterId) {
    reject("body names a different character");
  }
  // Bind to the snapshot: every claim the bio carries must resolve against it.
  validateWikiObjectClaims(bio, model);
  return bio;
}
