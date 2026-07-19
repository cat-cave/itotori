// A minimally valid, same-snapshot A8 character-background hand-off for A9
// contract tests. The fixture models the immutable persisted source object, not
// a fake response shape, so A9 exercises its actual provenance boundary.

import { WikiObjectSchema } from "../../src/contracts/index.js";
import type { ReadModel } from "../../src/read-tools/index.js";
import type { A8CharacterBackground } from "../../src/roles/a9/index.js";

export function a8BackgroundFor(model: ReadModel, characterId: string): A8CharacterBackground {
  return WikiObjectSchema.parse({
    schemaVersion: "itotori.wiki-object.v1",
    objectId: `character-background:${characterId}`,
    version: 1,
    lang: model.sourceLanguage,
    subject: { kind: "character", id: characterId },
    scope: { kind: "global" },
    claims: [],
    media: [],
    dependencies: [],
    provisional: true,
    kind: "character-background",
    body: {
      characterId,
      background: "同じ学園に通う。",
      relationships: [
        {
          counterpartId: characterId,
          relationship: "関係の基線。",
          scope: { kind: "global" },
          establishingEvidenceIds: ["fact:unit:0"],
        },
      ],
    },
    provenance: {
      snapshotKind: "context",
      contextSnapshotId: model.snapshotId,
      contextScope: "whole-game",
      runMode: "test-dev",
      authorRoleId: "A8",
    },
  }) as A8CharacterBackground;
}
