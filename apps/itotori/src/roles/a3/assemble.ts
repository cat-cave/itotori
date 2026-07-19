// Assemble + validate the A3 source WikiObjects.
//
// The model proposes narrative prose and claim statements; this module turns
// them into strict source-language `scene-summary` and `story-so-far`
// WikiObjects. Two invariants are enforced HERE, not trusted from the model:
//
//   1. Citations are INDEX-DERIVED. The model cites a bracketed play-order
//      label from its prompt; that label is resolved only through THIS scene's
//      units before the citation's hash, subject, and play order are copied
//      from the snapshot evidence index. A label outside this scene yields an
//      unresolvable citation, and claim validation (the RB-031 gate) throws.
//      The model cannot forge a passing citation.
//   2. Counts and speakers are NOT authored into the objects. The bodies carry
//      only prose and the DETERMINISTIC scene/through-scene id; the model's
//      re-count / re-attribution never reaches a field or a citation subject.

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

import {
  A3_ROLE_ID,
  A3_SCENE_SUMMARY_KIND,
  A3_STORY_SO_FAR_KIND,
  type A3ClaimDraft,
  type A3Context,
  type A3SceneNarrative,
  type CompleteScene,
  type StorySoFarState,
} from "./types.js";

const UNRESOLVABLE_HASH = `sha256:${"0".repeat(64)}` as `sha256:${string}`;

/** The model sees each scene unit only as its bracketed play-order label. Keep
 * this mapping scene-local so a real label from another scene cannot be used as
 * evidence for the current scene summary or story-so-far claim. */
function playOrderLabelToFactId(scene: CompleteScene): ReadonlyMap<string, string> {
  return new Map(scene.units.map((unit) => [String(unit.value.playOrderIndex), unit.factId]));
}

/** Build one citation for a model-cited play-order label. Every dimension a
 * citation is checked on — hash, subject, play order — is copied from the
 * snapshot evidence index when the label resolves to this scene's real fact id.
 * When it does NOT (a fabricated or out-of-scene label), the citation is
 * deliberately left unresolvable so the RB-031 gate rejects it. */
function citationFor(
  index: EvidenceIndex,
  snapshotId: string,
  labelToFactId: ReadonlyMap<string, string>,
  evidenceLabel: string,
): Citation {
  const factId = labelToFactId.get(evidenceLabel);
  const record = factId === undefined ? undefined : index.get(factId);
  if (!record) {
    return {
      evidenceId: evidenceLabel,
      evidenceHash: UNRESOLVABLE_HASH,
      snapshotId: snapshotId as `sha256:${string}`,
      subject: { kind: "unit", id: evidenceLabel },
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
  labelToFactId: ReadonlyMap<string, string>,
  scope: RouteScope,
  draft: A3ClaimDraft,
  claimId: string,
): Claim {
  return {
    claimId,
    statement: draft.statement,
    scope,
    kind: draft.kind,
    confidence: draft.confidence,
    citations: draft.evidenceUnitIds.map((evidenceLabel) =>
      citationFor(index, snapshotId, labelToFactId, evidenceLabel),
    ),
  };
}

function provenance(model: ReadModel, context: A3Context) {
  return {
    snapshotKind: "context" as const,
    contextSnapshotId: model.snapshotId,
    contextScope: context.contextScope,
    runMode: context.runMode,
    authorRoleId: A3_ROLE_ID,
  };
}

/** Parse the candidate through the strict WikiObject write gate, then prove every
 * claim against the snapshot (RB-031). Returns the immutable, provable object. */
function seal(candidate: unknown, model: ReadModel): WikiObject {
  const object = WikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}

/**
 * Assemble the source-language `scene-summary` for one COMPLETE scene. The body
 * carries the model's beat/subtext/open-threads prose and the DETERMINISTIC
 * scene id; it carries no counts or speakers. Every claim cites index-resolved
 * evidence or the object fails to validate.
 */
export function assembleSceneSummary(
  model: ReadModel,
  context: A3Context,
  scene: CompleteScene,
  narrative: A3SceneNarrative,
): WikiObject {
  const index = buildEvidenceIndex(model);
  const labelToFactId = playOrderLabelToFactId(scene);
  const sceneKey = String(scene.sceneId);
  const claims = narrative.sceneClaims.map((draft, ordinal) =>
    claimFor(
      index,
      model.snapshotId,
      labelToFactId,
      scene.scope,
      draft,
      `scene-summary:${sceneKey}:claim:${ordinal}`,
    ),
  );
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: `scene-summary:${sceneKey}`,
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "scene", id: sceneKey },
      scope: scene.scope,
      claims,
      media: [],
      dependencies: [],
      // Analyst prose is a cited, revisable interpretation of the deterministic
      // snapshot, not an accepted fact. A3 output stays provisional until the
      // downstream Wiki acceptance workflow promotes or supersedes it.
      provisional: true,
      kind: A3_SCENE_SUMMARY_KIND,
      body: {
        sceneId: sceneKey,
        beat: narrative.beat,
        subtext: narrative.subtext,
        openThreads: [...narrative.sceneOpenThreads],
      },
      provenance: provenance(model, context),
    },
    model,
  );
}

/**
 * Assemble the updated source-language `story-so-far` after folding one scene.
 * `throughSceneId` is the DETERMINISTIC scene id, never a model claim; the object
 * depends on both the prior story-so-far (the serial chain) and this scene's
 * summary, so the progression is a provable dependency graph.
 */
export function assembleStorySoFar(
  model: ReadModel,
  context: A3Context,
  scene: CompleteScene,
  scope: RouteScope,
  narrative: A3SceneNarrative,
  prior: StorySoFarState | null,
): WikiObject {
  const index = buildEvidenceIndex(model);
  const labelToFactId = playOrderLabelToFactId(scene);
  const sceneKey = String(scene.sceneId);
  const claims = narrative.storyClaims.map((draft, ordinal) =>
    claimFor(
      index,
      model.snapshotId,
      labelToFactId,
      scope,
      draft,
      `story-so-far:${sceneKey}:claim:${ordinal}`,
    ),
  );
  const dependencies: DependencyRef[] = [
    {
      upstreamObjectId: `scene-summary:${sceneKey}`,
      upstreamVersion: 1,
      claimId: null,
      fieldPath: ["beat"],
      renderingId: null,
      scope: scene.scope,
      fromPlayOrder: null,
      throughPlayOrder: null,
    },
  ];
  if (prior) {
    dependencies.unshift({
      upstreamObjectId: `story-so-far:${prior.throughSceneId}`,
      upstreamVersion: 1,
      claimId: null,
      fieldPath: ["summary"],
      renderingId: null,
      scope,
      fromPlayOrder: null,
      throughPlayOrder: null,
    });
  }
  return seal(
    {
      schemaVersion: "itotori.wiki-object.v1",
      objectId: `story-so-far:${sceneKey}`,
      version: 1,
      lang: model.sourceLanguage,
      subject: { kind: "scene", id: sceneKey },
      scope,
      claims,
      media: [],
      dependencies,
      // The running route narrative is also an analyst interpretation. Keep the
      // same revisable posture as its per-scene summary and cite its provenance.
      provisional: true,
      kind: A3_STORY_SO_FAR_KIND,
      body: {
        throughSceneId: sceneKey,
        summary: narrative.storySummary,
        openThreads: [...narrative.storyOpenThreads],
      },
      provenance: provenance(model, context),
    },
    model,
  );
}
