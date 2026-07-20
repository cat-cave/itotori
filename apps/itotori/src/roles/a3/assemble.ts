// Assemble + validate the A3 source WikiObjects.
//
// The model proposes narrative prose and claim statements; this module turns
// them into strict source-language `scene-summary` and `story-so-far`
// WikiObjects. Two invariants are enforced HERE, not trusted from the model:
//
//   1. Citations are INDEX-DERIVED. The model cites a short, scene-local [uN]
//      label from its prompt; that label is resolved only through THIS scene's
//      units before the citation's hash, subject, and play order are copied
//      from the snapshot evidence index. The model cannot forge a passing
//      citation: a label outside this scene resolves to nothing and is DROPPED —
//      never admitted uncited, never a poison-pill that hard-fails the whole
//      build. A claim left with no resolvable citation is discarded, not crashed
//      over; the RB-031 gate still runs over the surviving, provable citations
//      so nothing unresolved enters the Wiki. The short label is what makes
//      correct citations resolve in the first place — the flash model copies
//      `u1`, `u2`, … reliably where it fumbled the large GLOBAL play-order index.
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
  citeableSceneUnits,
  type A3ClaimDraft,
  type A3Context,
  type A3SceneNarrative,
  type CompleteScene,
  type StorySoFarState,
} from "./types.js";

/** The model sees each scene unit only as its short, scene-local citation label
 * (`u1`, `u2`, …). Keep this mapping scene-local — derived from the SAME
 * {@link citeableSceneUnits} the prompt rendered — so a label the model echoes
 * always resolves and a label from another scene cannot be used as evidence for
 * the current scene summary or story-so-far claim. */
function citationLabelToFactId(scene: CompleteScene): ReadonlyMap<string, string> {
  return new Map(citeableSceneUnits(scene).map(({ label, factId }) => [label, factId]));
}

/** Resolve one model-cited [uN] label to a snapshot-owned citation, or `null`
 * when the label names no unit shown in THIS scene. Every dimension a citation
 * is checked on — hash, subject, play order — is copied from the snapshot
 * evidence index; the model supplies only the label. A label the model
 * mis-transcribes or invents resolves to nothing and is DROPPED, so a single
 * recoverable mis-citation cannot poison the object and hard-fail the whole
 * build. A dropped citation is never admitted and never counts as support — the
 * RB-031 gate still runs over the citations that survive. */
function citationFor(
  index: EvidenceIndex,
  labelToFactId: ReadonlyMap<string, string>,
  evidenceLabel: string,
): Citation | null {
  const factId = labelToFactId.get(evidenceLabel);
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

/** Build one claim from a model draft, keeping only the citations that resolve
 * to this scene's evidence. A claim left with NO resolvable citation is dropped
 * (returns `null`): an unsupported analyst hypothesis is discarded, never
 * admitted uncited and never crashed over. */
function claimFor(
  index: EvidenceIndex,
  labelToFactId: ReadonlyMap<string, string>,
  scope: RouteScope,
  draft: A3ClaimDraft,
  claimId: string,
): Claim | null {
  const citations = draft.evidenceUnitIds
    .map((evidenceLabel) => citationFor(index, labelToFactId, evidenceLabel))
    .filter((citation): citation is Citation => citation !== null);
  if (citations.length === 0) return null;
  return {
    claimId,
    statement: draft.statement,
    scope,
    kind: draft.kind,
    confidence: draft.confidence,
    citations,
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
  const labelToFactId = citationLabelToFactId(scene);
  const sceneKey = String(scene.sceneId);
  const claims = narrative.sceneClaims
    .map((draft, ordinal) =>
      claimFor(
        index,
        labelToFactId,
        scene.scope,
        draft,
        `scene-summary:${sceneKey}:claim:${ordinal}`,
      ),
    )
    .filter((claim): claim is Claim => claim !== null);
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
  const labelToFactId = citationLabelToFactId(scene);
  const sceneKey = String(scene.sceneId);
  const claims = narrative.storyClaims
    .map((draft, ordinal) =>
      claimFor(index, labelToFactId, scope, draft, `story-so-far:${sceneKey}:claim:${ordinal}`),
    )
    .filter((claim): claim is Claim => claim !== null);
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
