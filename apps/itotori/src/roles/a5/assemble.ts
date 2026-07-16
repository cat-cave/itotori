// Assemble + validate one source `voice-profile` WikiObject.
//
// The model proposes register prose, address forms, and arc-register shifts; this
// module turns them into a strict, addressable object. The guarantees are enforced
// HERE, not trusted from the model:
//
//   1. The base register is the per-character (least-specific) slice; it is stamped
//      as a global claim citing the character-occurrence fact.
//   2. Every counterpart rule addresses a REAL, non-self character and cites a
//      decoded occurrence unit visible under the rule's route scope.
//   3. Every arc-position rule's from/to PLAY-ORDER RANGE is stamped from the cited
//      units' decoded play order — never the model's asserted re-timing — and a
//      reversed range is rejected; each rule cites units in the occurrence window.
//   4. Citations are INDEX-DERIVED: hash, subject, and play order are copied from
//      the snapshot evidence index, so the model cannot forge a passing citation.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type RouteScope,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import type { OrderedUnitFact } from "../../prepass/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import {
  arcPositionClaimId,
  baseRegisterClaimId,
  counterpartClaimId,
  voiceProfileObjectId,
} from "./ids.js";
import { occurrenceWindow, unitVisibleUnderScope } from "./windows.js";
import {
  A5RoleError,
  A5_ROLE_ID,
  A5_VOICE_PROFILE_KIND,
  type A5ArcPositionDraft,
  type A5Confidence,
  type A5Context,
  type A5CounterpartDraft,
  type A5VoiceDraft,
  type CharacterVoiceEvidence,
} from "./types.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;
const DEFAULT_CONFIDENCE: A5Confidence = "medium";

/** Build one citation for an evidence id. Every dimension a citation is checked
 * on — hash, subject, play order — is copied from the snapshot evidence index
 * when the id resolves; when it does NOT, the citation is left deliberately
 * unresolvable so the claim gate rejects it. */
function citationFor(
  index: EvidenceIndex,
  snapshotId: string,
  evidenceId: string,
  role: Citation["role"],
): Citation {
  const record = index.get(evidenceId);
  if (!record) {
    return {
      evidenceId,
      evidenceHash: UNRESOLVABLE_HASH,
      snapshotId: snapshotId as `sha256:${string}`,
      subject: { kind: "unit", id: evidenceId },
      role,
      playOrderIndex: 0,
    };
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

/** The module-authored base-register (per-character) claim: cites the character-
 * occurrence fact, whole-game scoped. Index-derived and independent of the model. */
function baseClaim(
  index: EvidenceIndex,
  snapshotId: string,
  evidence: CharacterVoiceEvidence,
  register: string,
  confidence: A5Confidence,
): Claim {
  return {
    claimId: baseRegisterClaimId(evidence.characterId),
    statement: `${evidence.decodedLabel} の基本レジスター: ${register}`,
    scope: evidence.scope,
    kind: "voice",
    confidence,
    citations: [citationFor(index, snapshotId, evidence.occurrenceFactId, "supports")],
  };
}

/** One counterpart rule, resolved: the model's address prose plus the cited,
 * scope-visible occurrence unit. */
interface ResolvedCounterpart {
  readonly counterpartId: string;
  readonly addressForm: string;
  readonly registerDelta: string;
  readonly scope: RouteScope;
  readonly evidenceId: string;
  readonly confidence: A5Confidence;
}

/** One arc-position rule, resolved: the model's shift prose plus the decode-
 * stamped play-order range and the anchoring occurrence units (from, then to). */
interface ResolvedArcPosition {
  readonly scope: RouteScope;
  readonly register: string;
  readonly note: string;
  readonly fromPlayOrder: number;
  readonly toPlayOrder: number;
  readonly evidenceId: string;
  readonly toEvidenceId: string;
  readonly confidence: A5Confidence;
}

function requireWindowUnit(
  characterId: string,
  window: ReadonlyMap<string, OrderedUnitFact>,
  scope: RouteScope,
  evidenceId: string,
): OrderedUnitFact {
  const unit = window.get(evidenceId);
  if (!unit) {
    throw new A5RoleError(
      "unknown-voice-evidence",
      `${characterId} cites ${evidenceId}, not a decoded occurrence unit`,
    );
  }
  if (!unitVisibleUnderScope(unit.routeScope, scope)) {
    throw new A5RoleError(
      "unknown-voice-evidence",
      `${characterId} cites ${evidenceId}, not visible under the rule's route scope`,
    );
  }
  return unit;
}

/** Resolve one counterpart rule: the counterpart is a REAL, non-self character;
 * the address prose is non-empty; the cited unit is a scope-visible occurrence
 * unit. */
function resolveCounterpart(
  characterId: string,
  counterparts: ReadonlySet<string>,
  window: ReadonlyMap<string, OrderedUnitFact>,
  draft: A5CounterpartDraft,
): ResolvedCounterpart {
  if (!counterparts.has(draft.counterpartId)) {
    throw new A5RoleError(
      "unknown-counterpart",
      `${characterId} addresses ${draft.counterpartId}, absent from the character index`,
    );
  }
  if (draft.counterpartId === characterId) {
    throw new A5RoleError("self-counterpart", `${characterId} cannot be its own counterpart`);
  }
  if (draft.addressForm.trim().length === 0 || draft.registerDelta.trim().length === 0) {
    throw new A5RoleError(
      "degenerate-counterpart",
      `${characterId}→${draft.counterpartId} carries an empty address form or register delta`,
    );
  }
  const unit = requireWindowUnit(characterId, window, draft.scope, draft.evidenceId);
  return {
    counterpartId: draft.counterpartId,
    addressForm: draft.addressForm,
    registerDelta: draft.registerDelta,
    scope: draft.scope,
    evidenceId: unit.factId,
    confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
  };
}

/** Resolve one arc-position rule against the occurrence window: both bounding
 * units are scope-visible occurrence units; the play-order range is stamped from
 * their decoded play order (the model's asserted re-timing is ignored); a reversed
 * range and empty prose are rejected. */
function resolveArcPosition(
  characterId: string,
  window: ReadonlyMap<string, OrderedUnitFact>,
  draft: A5ArcPositionDraft,
): ResolvedArcPosition {
  if (draft.register.trim().length === 0 || draft.note.trim().length === 0) {
    throw new A5RoleError(
      "degenerate-arc",
      `${characterId} arc rule carries an empty register or note`,
    );
  }
  const fromUnit = requireWindowUnit(characterId, window, draft.scope, draft.fromEvidenceId);
  const toUnit = requireWindowUnit(characterId, window, draft.scope, draft.toEvidenceId);
  const fromPlayOrder = fromUnit.playReveal.playOrderIndex;
  const toPlayOrder = toUnit.playReveal.playOrderIndex;
  if (toPlayOrder < fromPlayOrder) {
    throw new A5RoleError(
      "reversed-arc",
      `${characterId} arc ends at play order ${toPlayOrder} before it begins at ${fromPlayOrder}`,
    );
  }
  return {
    scope: draft.scope,
    register: draft.register,
    note: draft.note,
    fromPlayOrder,
    toPlayOrder,
    evidenceId: fromUnit.factId,
    toEvidenceId: toUnit.factId,
    confidence: draft.confidence ?? DEFAULT_CONFIDENCE,
  };
}

function counterpartClaim(
  index: EvidenceIndex,
  snapshotId: string,
  characterId: string,
  rule: ResolvedCounterpart,
  ordinal: number,
): Claim {
  return {
    claimId: counterpartClaimId(characterId, ordinal),
    statement: `${rule.counterpartId} への呼称「${rule.addressForm}」/ ${rule.registerDelta}`,
    scope: rule.scope,
    kind: "voice",
    confidence: rule.confidence,
    citations: [citationFor(index, snapshotId, rule.evidenceId, "supports")],
  };
}

function arcClaim(
  index: EvidenceIndex,
  snapshotId: string,
  characterId: string,
  rule: ResolvedArcPosition,
  ordinal: number,
): Claim {
  return {
    claimId: arcPositionClaimId(characterId, ordinal),
    statement: `${rule.register} (${rule.note})`,
    scope: rule.scope,
    kind: "voice",
    confidence: rule.confidence,
    citations: [
      citationFor(index, snapshotId, rule.evidenceId, "supports"),
      citationFor(index, snapshotId, rule.toEvidenceId, "reveal"),
    ],
  };
}

function provenance(model: ReadModel, context: A5Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A5_ROLE_ID,
  };
}

function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `voice-profile` for one character. The base
 * register is the per-character fallback; every counterpart addresses a real
 * non-self character; every arc-position range is decode-stamped; every claim
 * cites index-resolved evidence or the object fails to validate.
 */
export function assembleVoiceProfile(
  model: ReadModel,
  context: A5Context,
  evidence: CharacterVoiceEvidence,
  counterpartUniverse: readonly string[],
  draft: A5VoiceDraft,
): WikiObject {
  if (draft.base.pronoun.trim().length === 0 || draft.base.register.trim().length === 0) {
    throw new A5RoleError(
      "degenerate-base",
      `${evidence.characterId} base register carries no pronoun or register`,
    );
  }
  const windowUnits = occurrenceWindow(model, evidence.sceneIds);
  const window = new Map(windowUnits.map((unit) => [unit.factId, unit]));
  const counterparts = new Set(counterpartUniverse);

  const resolvedCounterparts = draft.counterparts.map((rule) =>
    resolveCounterpart(evidence.characterId, counterparts, window, rule),
  );
  const resolvedArcs = draft.arcPositions.map((rule) =>
    resolveArcPosition(evidence.characterId, window, rule),
  );

  const index = buildEvidenceIndex(model);
  const baseConfidence = draft.base.confidence ?? "high";
  const claims: Claim[] = [
    baseClaim(index, model.snapshotId, evidence, draft.base.register, baseConfidence),
    ...resolvedCounterparts.map((rule, ordinal) =>
      counterpartClaim(index, model.snapshotId, evidence.characterId, rule, ordinal),
    ),
    ...resolvedArcs.map((rule, ordinal) =>
      arcClaim(index, model.snapshotId, evidence.characterId, rule, ordinal),
    ),
  ];

  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: voiceProfileObjectId(evidence.characterId),
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "character", id: evidence.characterId },
      scope: evidence.scope,
      claims,
      media: [],
      dependencies: [],
      provisional: false,
      kind: A5_VOICE_PROFILE_KIND,
      body: {
        characterId: evidence.characterId,
        base: {
          pronoun: draft.base.pronoun,
          register: draft.base.register,
          tics: [...draft.base.tics],
        },
        perCounterpart: resolvedCounterparts.map((rule) => ({
          counterpartId: rule.counterpartId,
          addressForm: rule.addressForm,
          registerDelta: rule.registerDelta,
          scope: rule.scope,
        })),
        perArcPosition: resolvedArcs.map((rule) => ({
          scope: rule.scope,
          fromPlayOrder: rule.fromPlayOrder,
          toPlayOrder: rule.toPlayOrder,
          register: rule.register,
          note: rule.note,
          evidenceId: rule.evidenceId,
        })),
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
