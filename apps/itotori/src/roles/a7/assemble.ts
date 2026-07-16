// Assemble + validate one source character-bio WikiObject.
//
// The model proposes prose, defining traits, and claim statements; this module
// turns them into a strict source-language `character-bio` object. Three
// invariants are enforced HERE, not trusted from the model:
//
//   1. Citations are INDEX-DERIVED. For every evidence id the model cites, the
//      citation's hash, subject, and play order are copied from the snapshot
//      evidence index — never from the model. A cited id outside the visible
//      snapshot yields an unresolvable citation, and the claim-validation gate
//      throws. The model cannot forge a passing citation.
//   2. Whole-game evidence is GUARANTEED. The module always authors a presence
//      claim citing the character-occurrence fact plus the whole-game unit set,
//      so every bio carries cited whole-game evidence regardless of the model.
//   3. A portrait is ALWAYS present. Every emitted bio carries exactly one
//      portrait media reference for its character.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type MediaRef,
  type RouteScope,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import { bioObjectId, modelClaimId, presenceClaimId } from "./ids.js";
import {
  A7RoleError,
  A7_CHARACTER_BIO_KIND,
  A7_ROLE_ID,
  type A7BioDraft,
  type A7ClaimDraft,
  type A7Context,
  type CharacterEvidence,
} from "./types.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

/** Build one citation for a model-cited evidence id. Every dimension a citation
 * is checked on — hash, subject, play order — is copied from the snapshot
 * evidence index when the id resolves. When it does NOT (a hallucinated id), the
 * citation is left deliberately unresolvable so the claim gate rejects it. */
function citationFor(index: EvidenceIndex, snapshotId: string, evidenceId: string): Citation {
  const record = index.get(evidenceId);
  if (!record) {
    return {
      evidenceId,
      evidenceHash: UNRESOLVABLE_HASH,
      snapshotId: snapshotId as `sha256:${string}`,
      subject: { kind: "unit", id: evidenceId },
      role: "supports",
      playOrderIndex: 0,
    };
  }
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "supports",
    playOrderIndex: record.fromPlayOrder,
  };
}

function claimFor(
  index: EvidenceIndex,
  snapshotId: string,
  scope: RouteScope,
  draft: A7ClaimDraft,
  claimId: string,
): Claim {
  return {
    claimId,
    statement: draft.statement,
    scope,
    kind: "bio",
    confidence: draft.confidence,
    citations: draft.evidenceIds.map((id) => citationFor(index, snapshotId, id)),
  };
}

/** The whole-game unit ids the bio treats as notable moments: the model's
 * selection, intersected with the character's actual whole-game unit set so a
 * fabricated id can never reach a body field. Falls back to the full set when
 * the model selected nothing, so the bio is always grounded in whole-game bytes. */
function notableUnitIds(evidence: CharacterEvidence, draft: A7BioDraft): readonly string[] {
  const whole = new Set(evidence.notableUnitIds);
  const chosen = draft.notableMomentEvidenceIds.filter((id) => whole.has(id));
  return chosen.length > 0 ? chosen : evidence.notableUnitIds;
}

/** The module-authored presence claim: cites the character-occurrence fact
 * (whole-game presence) plus every notable unit. This is the cited whole-game
 * evidence guarantee — index-derived and independent of the model. */
function presenceClaim(
  index: EvidenceIndex,
  snapshotId: string,
  evidence: CharacterEvidence,
  notable: readonly string[],
): Claim {
  const citations = [
    citationFor(index, snapshotId, evidence.occurrenceFactId),
    ...notable.map((id) => citationFor(index, snapshotId, id)),
  ];
  return {
    claimId: presenceClaimId(evidence.characterId),
    statement: `${evidence.decodedLabel} は本編全体にわたって登場する。`,
    scope: evidence.scope,
    kind: "bio",
    confidence: "high",
    citations,
  };
}

function provenance(model: ReadModel, context: A7Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A7_ROLE_ID,
  };
}

/** Parse through the strict WikiObject write gate, then prove every claim against
 * the snapshot. Returns the immutable, provable object. */
function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `character-bio` for one character. The body
 * carries the model's story-role prose, defining traits, and the notable-moment
 * unit ids; the claims are re-cited from the index; the portrait is attached.
 * Every claim cites index-resolved whole-game evidence or the object fails to
 * validate. A bio with no defining trait is a loud failure, never an empty bio.
 */
export function assembleCharacterBio(
  model: ReadModel,
  context: A7Context,
  evidence: CharacterEvidence,
  draft: A7BioDraft,
  portrait: MediaRef,
): WikiObject {
  if (draft.definingTraits.length === 0) {
    throw new A7RoleError(
      "degenerate-bio",
      `character ${evidence.characterId} bio carries no defining trait`,
    );
  }
  const index = buildEvidenceIndex(model);
  const notable = notableUnitIds(evidence, draft);
  const claims: Claim[] = [
    presenceClaim(index, model.snapshotId, evidence, notable),
    ...draft.claims.map((claimDraft, ordinal) =>
      claimFor(
        index,
        model.snapshotId,
        evidence.scope,
        claimDraft,
        modelClaimId(evidence.characterId, ordinal),
      ),
    ),
  ];
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: bioObjectId(evidence.characterId),
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "character", id: evidence.characterId },
      scope: evidence.scope,
      claims,
      media: [portrait],
      dependencies: [],
      provisional: false,
      kind: A7_CHARACTER_BIO_KIND,
      body: {
        characterId: evidence.characterId,
        storyRole: draft.storyRole,
        definingTraits: [...draft.definingTraits],
        notableMomentEvidenceIds: [...notable],
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
