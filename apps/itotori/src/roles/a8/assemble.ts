// Assemble + validate one source character-background WikiObject.
//
// The model proposes background prose and relationships; this module turns them
// into a strict source-language `character-background` object. The guarantees are
// enforced HERE, not trusted from the model:
//
//   1. The upstream bio is PROVENANCE-VERIFIED and recorded as a dependency, so
//      the background is a provable edge back to the artifact it consumed.
//   2. Every counterpart is a REAL character in the deterministic index.
//   3. Every relationship cites an ESTABLISHING same-game scene that is real,
//      reachable, and route-compatible; its route scope is validated against the
//      reachable topology. A fabricated / unreachable / out-of-route scene, or an
//      unreachable scope, rejects the object.
//   4. Citations are INDEX-DERIVED: hash, subject, and play order are copied from
//      the snapshot evidence index, so the model cannot forge a passing citation.

import {
  WikiObjectSchema,
  type Citation,
  type Claim,
  type DependencyRef,
  type RouteScope,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { buildEvidenceIndex, type EvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import { assertRealCounterpartCharacter, a8Caller } from "./characters.js";
import { backgroundObjectId, presenceClaimId, relationshipClaimId } from "./ids.js";
import { verifyBioProvenance } from "./provenance.js";
import {
  buildSceneReachabilityIndex,
  reachableRoutes,
  resolveRelationshipScope,
} from "./scenes.js";
import {
  A8RoleError,
  A8_CHARACTER_BACKGROUND_KIND,
  A8_ROLE_ID,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
  type CharacterEvidence,
} from "./types.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

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

/** The module-authored whole-game presence claim: cites the character-occurrence
 * fact. Index-derived and independent of the model. */
function presenceClaim(
  index: EvidenceIndex,
  snapshotId: string,
  evidence: CharacterEvidence,
): Claim {
  return {
    claimId: presenceClaimId(evidence.characterId),
    statement: `${evidence.decodedLabel} は本編全体にわたって登場する。`,
    scope: evidence.scope,
    kind: "background",
    confidence: "high",
    citations: [citationFor(index, snapshotId, evidence.occurrenceFactId, "supports")],
  };
}

/** One relationship, resolved: the draft plus the establishing scene evidence ids
 * the topology validated (in cited order). */
interface ResolvedRelationship {
  readonly counterpartId: string;
  readonly relationship: string;
  readonly confidence: "low" | "medium" | "high";
  readonly scope: RouteScope;
  readonly establishingEvidenceIds: readonly string[];
}

function relationshipClaim(
  index: EvidenceIndex,
  snapshotId: string,
  characterId: string,
  resolved: ResolvedRelationship,
  ordinal: number,
): Claim {
  return {
    claimId: relationshipClaimId(characterId, ordinal),
    statement: `${resolved.counterpartId}: ${resolved.relationship}`,
    scope: resolved.scope,
    kind: "relationship",
    confidence: resolved.confidence,
    citations: resolved.establishingEvidenceIds.map((id) =>
      citationFor(index, snapshotId, id, "establishes"),
    ),
  };
}

function provenance(model: ReadModel, context: A8Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A8_ROLE_ID,
  };
}

function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `character-background` for one character. The bio
 * is provenance-verified and recorded as a dependency; every counterpart is
 * checked against the real index; every relationship's establishing scenes and
 * scope are validated against the reachable topology; every claim cites index-
 * resolved evidence or the object fails to validate.
 */
export function assembleCharacterBackground(
  model: ReadModel,
  context: A8Context,
  evidence: CharacterEvidence,
  request: A8BackgroundRequest,
  draft: A8BackgroundDraft,
): WikiObject {
  if (draft.background.trim().length === 0) {
    throw new A8RoleError(
      "degenerate-background",
      `character ${evidence.characterId} background carries no prose`,
    );
  }
  const bio = verifyBioProvenance(model, evidence.characterId, request.bio);
  const counterparts = new Set(request.counterpartIds);
  const sceneIndex = buildSceneReachabilityIndex(model, a8Caller(context));
  const routes = reachableRoutes(sceneIndex);

  const resolved: ResolvedRelationship[] = draft.relationships.map((relationship) => {
    // The request manifest is untrusted input. Resolve the cited id through the
    // local character-evidence tool before consulting that manifest, so a
    // poisoned counterpartIds array cannot manufacture a relationship target.
    assertRealCounterpartCharacter(model, context, relationship.counterpartId);
    if (!counterparts.has(relationship.counterpartId)) {
      throw new A8RoleError(
        "unknown-counterpart",
        `relationship names ${relationship.counterpartId}, absent from the character index`,
      );
    }
    const establishingEvidenceIds = resolveRelationshipScope(
      evidence.characterId,
      relationship,
      sceneIndex,
      routes,
    );
    return {
      counterpartId: relationship.counterpartId,
      relationship: relationship.relationship,
      confidence: relationship.confidence,
      scope: relationship.scope,
      establishingEvidenceIds,
    };
  });

  const index = buildEvidenceIndex(model);
  const claims: Claim[] = [
    presenceClaim(index, model.snapshotId, evidence),
    ...resolved.map((relationship, ordinal) =>
      relationshipClaim(index, model.snapshotId, evidence.characterId, relationship, ordinal),
    ),
  ];
  const dependencies: DependencyRef[] = [
    {
      upstreamObjectId: bio.objectId,
      upstreamVersion: bio.version,
      claimId: null,
      fieldPath: ["storyRole"],
      renderingId: null,
      scope: evidence.scope,
      fromPlayOrder: null,
      throughPlayOrder: null,
    },
  ];
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: backgroundObjectId(evidence.characterId),
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "character", id: evidence.characterId },
      scope: evidence.scope,
      claims,
      media: [],
      dependencies,
      // A background is a cited analyst interpretation of immutable decode
      // facts and the upstream bio, not an accepted fact itself. Keep it
      // revisable until Wiki acceptance promotes or supersedes it; a model
      // must never self-promote a relationship interpretation.
      provisional: true,
      kind: A8_CHARACTER_BACKGROUND_KIND,
      body: {
        characterId: evidence.characterId,
        background: draft.background,
        relationships: resolved.map((relationship) => ({
          counterpartId: relationship.counterpartId,
          relationship: relationship.relationship,
          scope: relationship.scope,
          establishingEvidenceIds: [...relationship.establishingEvidenceIds],
        })),
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
