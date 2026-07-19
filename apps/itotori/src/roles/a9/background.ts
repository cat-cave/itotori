// Provenance verification for A9's A8 relationship input.
//
// A9 may interpret a character differently per route, but it never invents a
// character's relationship baseline. That comes from A8's same-snapshot
// character-background object. Verify the cross-role hand-off at this boundary
// and record the exact object/field consumed, so a changed relationship can
// invalidate only the affected character-route arcs.

import { WikiObjectSchema, type WikiObject } from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";

import { A9RoleError } from "./types.js";

/** A parsed A8 character-background object suitable for A9 to consume. */
export type A8CharacterBackground = Extract<WikiObject, { kind: "character-background" }>;

/**
 * Prove that an A8 character-background belongs to this character and this
 * immutable context snapshot. An `unknown` value is accepted deliberately: the
 * integration boundary is runtime data, and a forged TypeScript cast must not
 * let an unrelated or foreign-snapshot analyst output enter A9's prompt.
 */
export function verifyA8CharacterBackground(
  model: ReadModel,
  characterId: string,
  candidate: unknown,
): A8CharacterBackground {
  const parsed = WikiObjectSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind !== "character-background") {
    throw new A9RoleError(
      "unverified-background",
      `character ${characterId} was not supplied an A8 character-background object`,
    );
  }
  const background = parsed.data;
  if (
    background.subject.kind !== "character" ||
    background.subject.id !== characterId ||
    background.body.characterId !== characterId ||
    background.provenance.authorRoleId !== "A8" ||
    background.provenance.contextSnapshotId !== model.snapshotId ||
    background.lang !== model.sourceLanguage
  ) {
    throw new A9RoleError(
      "unverified-background",
      `character ${characterId} received a background with mismatched subject, A8 provenance, snapshot, or language`,
    );
  }
  return background;
}
