// Assemble + validate one source character-bio WikiObject.
//
// The model proposes prose, defining traits, and claim statements; this module
// turns them into a strict source-language `character-bio` object. Three
// invariants are enforced HERE, not trusted from the model:
//
//   1. Citations are INDEX-DERIVED. The model cites a short [uN] label; the
//      module binds it back to the real whole-game fact id, then copies the
//      citation's hash, subject, and play order from the snapshot evidence index
//      — never from the model. A label the model mis-copies or invents resolves
//      to nothing and is DROPPED — never admitted uncited, never a poison-pill
//      that hard-fails the whole build. A model claim left with no resolvable
//      citation is discarded; the RB-031 gate still runs over the surviving,
//      provable citations so nothing unresolved enters the Wiki. The structural
//      presence claim's index-derived fact ids instead REQUIRE resolution: a
//      miss there is a genuine snapshot-integrity bug and stays loud.
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
  citeableCharacterUnits,
  type A7BioDraft,
  type A7ClaimDraft,
  type A7Context,
  type CharacterEvidence,
} from "./types.js";

/** Resolve a fact id to a snapshot-owned citation, or `null` when it (or the
 * label that produced it) names nothing in the visible snapshot. Every dimension
 * a citation is checked on — hash, subject, play order — is copied from the
 * snapshot evidence index; the model supplies only a short label. */
function citationFor(index: EvidenceIndex, factId: string | undefined): Citation | null {
  const record = factId === undefined ? undefined : index.get(factId);
  if (!record) return null;
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "supports",
    playOrderIndex: record.fromPlayOrder,
  };
}

/** Resolve a REQUIRED index-derived citation (the whole-game presence
 * evidence). Unlike a model-cited label, these come from the deterministic
 * character-occurrence fact and the character's real whole-game unit set, so a
 * miss is a snapshot-integrity bug — never a recoverable model slip — and fails
 * loud rather than being silently dropped. */
function requireCitation(index: EvidenceIndex, factId: string): Citation {
  const citation = citationFor(index, factId);
  if (!citation) {
    throw new A7RoleError(
      "no-evidence",
      `presence evidence ${factId} does not resolve in this snapshot`,
    );
  }
  return citation;
}

/** Build one MODEL claim, mapping each cited SHORT label back to its whole-game
 * fact id and keeping only the citations that resolve. A claim left with NO
 * resolvable citation is dropped (returns `null`): an unsupported model
 * hypothesis is discarded, never admitted uncited and never crashed over. The
 * short label is why a CORRECT citation resolves without a drop — the flash
 * model copies `u1`, `u2`, … reliably where it fumbled a uuid-based fact id. */
function claimFor(
  index: EvidenceIndex,
  labelToFactId: ReadonlyMap<string, string>,
  scope: RouteScope,
  draft: A7ClaimDraft,
  claimId: string,
): Claim | null {
  const citations = draft.evidenceIds
    .map((label) => citationFor(index, labelToFactId.get(label)))
    .filter((citation): citation is Citation => citation !== null);
  if (citations.length === 0) return null;
  return {
    claimId,
    statement: draft.statement,
    scope,
    kind: "bio",
    confidence: draft.confidence,
    citations,
  };
}

/** The whole-game unit ids the bio treats as notable moments: the model's short
 * label SELECTION mapped back through `labelToFactId` and intersected with the
 * character's actual whole-game unit set, so a fabricated or mis-copied label
 * can never reach a body field. Falls back to the full set when the model
 * selected nothing usable, so the bio is always grounded in whole-game bytes. */
function notableUnitIds(
  evidence: CharacterEvidence,
  labelToFactId: ReadonlyMap<string, string>,
  draft: A7BioDraft,
): readonly string[] {
  const whole = new Set(evidence.notableUnitIds);
  const chosen = draft.notableMomentEvidenceIds
    .map((label) => labelToFactId.get(label))
    .filter((factId): factId is string => factId !== undefined && whole.has(factId));
  return chosen.length > 0 ? chosen : evidence.notableUnitIds;
}

/** The module-authored presence claim: cites the character-occurrence fact
 * (whole-game presence) plus every notable unit. This is the cited whole-game
 * evidence guarantee — index-derived and independent of the model. */
function presenceClaim(
  index: EvidenceIndex,
  evidence: CharacterEvidence,
  notable: readonly string[],
): Claim {
  const citations = [
    requireCitation(index, evidence.occurrenceFactId),
    ...notable.map((id) => requireCitation(index, id)),
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
  // The model cited SHORT labels (u1, u2, …); bind each back to its real fact id
  // through the SAME citeableCharacterUnits the prompt rendered.
  const labelToFactId = new Map(
    citeableCharacterUnits(evidence).map(({ label, factId }) => [label, factId]),
  );
  const notable = notableUnitIds(evidence, labelToFactId, draft);
  const claims: Claim[] = [
    presenceClaim(index, evidence, notable),
    ...draft.claims
      .map((claimDraft, ordinal) =>
        claimFor(
          index,
          labelToFactId,
          evidence.scope,
          claimDraft,
          modelClaimId(evidence.characterId, ordinal),
        ),
      )
      .filter((claim): claim is Claim => claim !== null),
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
      // A bio is a cited analyst interpretation of immutable decode facts, not
      // an accepted fact itself. Keep it revisable until the Wiki acceptance
      // workflow promotes or supersedes it; a model must never self-promote a
      // character interpretation by emitting a non-provisional object.
      provisional: true,
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
