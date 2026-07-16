// A later decode resolution INVALIDATES a hypothesis — it never merges it.
//
// When the decode later fixes a unit's speaker as a `known` truth, the earlier
// A10 hypothesis for that unit is superseded and discarded. The decoded fact
// stands ALONE: its authoritative character id is the decode's, and the
// hypothesis's candidate is NOT folded into it — even when the candidate happens
// to match the decoded speaker, the outcome is still `invalidated`, never a merge
// or a confirmation. A hypothesis is a provisional guess; a decode is ground
// truth, and ground truth replaces the guess rather than absorbing it.
//
// Every input's provenance is verified: the resolution must target the exact unit
// the hypothesis is about, and it must be a genuine `known` decode — a resolution
// that still carries an unknown speaker is not a resolution at all.

import { WikiObjectSchema, type WikiObject } from "../../contracts/index.js";

import {
  A10RoleError,
  A10_SPEAKER_HYPOTHESIS_KIND,
  type DecodeResolution,
  type HypothesisInvalidation,
} from "./types.js";

/** Narrow an untrusted object to a source `speaker-hypothesis`, or throw. */
function asSpeakerHypothesis(object: WikiObject) {
  if (object.kind !== A10_SPEAKER_HYPOTHESIS_KIND) {
    throw new A10RoleError(
      "dispatch-failed",
      `object ${object.objectId} is not a speaker-hypothesis`,
    );
  }
  return object;
}

/**
 * Invalidate one hypothesis against a later decode resolution. The hypothesis is
 * discarded and the decoded character id is taken from the RESOLUTION, never from
 * the hypothesis. Throws when the resolution targets a different unit
 * (`resolution-mismatch`) or is not a genuine `known` decode (`unresolved-decode`).
 * The returned outcome is always `invalidated` — decode never merges into a guess.
 */
export function invalidateOnDecodeResolution(
  hypothesisObject: WikiObject,
  resolution: DecodeResolution,
): HypothesisInvalidation {
  const hypothesis = asSpeakerHypothesis(WikiObjectSchema.parse(hypothesisObject));
  if (resolution.unitId !== hypothesis.body.unitId) {
    throw new A10RoleError(
      "resolution-mismatch",
      `decode resolution targets unit ${resolution.unitId}, not the hypothesis unit ${hypothesis.body.unitId}`,
    );
  }
  if (resolution.resolvedSpeaker.status !== "known") {
    throw new A10RoleError(
      "unresolved-decode",
      `unit ${resolution.unitId} still has an unknown speaker; nothing to invalidate against`,
    );
  }
  const decodedCharacterId = resolution.resolvedSpeaker.canonicalCharacterId;
  const hypothesizedCandidateId = hypothesis.body.candidateCharacterId;
  return {
    outcome: "invalidated",
    unitId: hypothesis.body.unitId,
    invalidatedObjectId: hypothesis.objectId,
    invalidatedObjectVersion: hypothesis.version,
    decodedCharacterId,
    hypothesizedCandidateId,
    candidateMatchedDecode: hypothesizedCandidateId === decodedCharacterId,
  };
}
