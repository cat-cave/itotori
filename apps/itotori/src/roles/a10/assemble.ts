// Assemble + validate one source `speaker-hypothesis` WikiObject.
//
// The model proposes a candidate character, a confidence, a reveal scene, and a
// rationale; this module turns them into a strict, PROVISIONAL hypothesis object.
// Three things are enforced HERE, not trusted from the model:
//
//   1. It is STRUCTURALLY a hypothesis, never a decoded fact. The only object
//      this module can build is a `speaker-hypothesis` whose body carries a
//      CANDIDATE id and a confidence — there is no field for the authoritative
//      decoded speaker, and `provisional` is always true. The decoded speaker
//      truth lives on the immutable decode fact, which A10 has no write path to.
//   2. Known speakers are REFUSED. Assembly only accepts an already-narrowed
//      unknown-speaker unit; a decoded (`known`) speaker never reaches here.
//   3. Citations are INDEX-DERIVED. The unit, the candidate's occurrence fact,
//      and the reveal-scene node are cited by copying hash / subject / play order
//      from the snapshot evidence index, and the whole object re-proves through
//      the claim-validation gate. A fabricated citation cannot pass.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import { hypothesisClaimId, hypothesisObjectId } from "./ids.js";
import {
  A10RoleError,
  A10_ROLE_ID,
  A10_SPEAKER_HYPOTHESIS_KIND,
  type A10Context,
  type A10HypothesisDraft,
  type UnknownSpeakerUnit,
} from "./types.js";

/** Copy one citation for a citeable evidence id straight from the snapshot
 * evidence index. Every checked dimension — hash, subject, route scope, play
 * order — is the index's, so the model can neither forge nor drift a citation.
 * An id absent from the index throws loud rather than yielding a fake citation. */
function citationFor(index: EvidenceIndex, evidenceId: string, role: Citation["role"]): Citation {
  const record = index.get(evidenceId);
  if (!record) {
    throw new A10RoleError(
      "dispatch-failed",
      `hypothesis cites ${evidenceId}, absent from the snapshot evidence index`,
    );
  }
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role,
    playOrderIndex: record.fromPlayOrder,
  };
}

/** The module-authored hypothesis claim: the unit whose speaker is unknown, the
 * candidate character's whole-game occurrence, and the hindsight reveal scene —
 * all index-derived, with the candidate's confidence carried from the model. */
function hypothesisClaim(
  index: EvidenceIndex,
  unit: UnknownSpeakerUnit,
  draft: A10HypothesisDraft,
  candidateOccurrenceFactId: string,
  revealNodeFactId: string,
): Claim {
  return {
    claimId: hypothesisClaimId(unit.unitId),
    statement: draft.rationale,
    scope: unit.scope,
    kind: A10_SPEAKER_HYPOTHESIS_KIND,
    confidence: draft.confidence,
    citations: [
      citationFor(index, unit.unitId, "supports"),
      citationFor(index, candidateOccurrenceFactId, "supports"),
      citationFor(index, revealNodeFactId, "reveal"),
    ],
  };
}

function provenance(model: ReadModel, context: A10Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A10_ROLE_ID,
  };
}

/**
 * Assemble the source `speaker-hypothesis` for one genuinely-unknown-speaker
 * unit. The body carries the model's candidate, confidence, and reveal scene; the
 * single claim is re-cited from the index and re-proven against the snapshot. The
 * object is always PROVISIONAL — a hypothesis, never a decoded fact — and it is
 * structurally incapable of asserting the authoritative decoded speaker.
 */
export function assembleSpeakerHypothesis(
  model: ReadModel,
  context: A10Context,
  unit: UnknownSpeakerUnit,
  draft: A10HypothesisDraft,
  candidateOccurrenceFactId: string,
  revealNodeFactId: string,
): WikiObject {
  const index = buildEvidenceIndex(model);
  const claim = hypothesisClaim(index, unit, draft, candidateOccurrenceFactId, revealNodeFactId);
  const candidate = {
    schemaVersion: "itotori.wiki-object.v1",
    objectId: hypothesisObjectId(unit.unitId),
    version: 1,
    lang: model.sourceLanguage,
    subject: { kind: "unit", id: unit.unitId },
    scope: unit.scope,
    claims: [claim],
    media: [],
    dependencies: [],
    provisional: true,
    kind: A10_SPEAKER_HYPOTHESIS_KIND,
    body: {
      unitId: unit.unitId,
      candidateCharacterId: draft.candidateCharacterId,
      confidence: draft.confidence,
      revealSceneId: draft.revealSceneId,
    },
    provenance: provenance(model, context),
  };
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}
