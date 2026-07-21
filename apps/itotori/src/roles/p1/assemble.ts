// Seal P1's untrusted draft batch as a strict translation WikiObject.
//
// The model cannot author P1 provenance, scope, object identity, dependencies,
// or citations. This module derives every one from the exact read context,
// then validates the result with the same citation-gate claim resolver used
// by all Wiki objects. P1 outputs remain provisional until deterministic
// gates/review accept individual units.

import {
  TranslationWikiObjectSchema,
  type Citation,
  type Claim,
  type DependencyRef,
  type DraftBatch,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { buildEvidenceIndex } from "../../wiki/evidence-index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import type { LocalizationSegment } from "./plan.js";
import { P1_ROLE_ID, type P1Context, type P1ReadScene } from "./agent-types.js";

function coreIds(segment: LocalizationSegment): readonly string[] {
  return segment.mode === "whole-scene" ? segment.unitIds : segment.coreUnitIds;
}

function objectIdFor(sceneId: string, segment: LocalizationSegment): string {
  return segment.mode === "whole-scene"
    ? `translation:${sceneId}:whole`
    : `translation:${sceneId}:chunk:${segment.chunkIndex}`;
}

function citationFor(model: ReadModel, unitId: string): Citation {
  const record = buildEvidenceIndex(model).get(unitId);
  if (!record) throw new Error(`P1 assemble: ${unitId} is absent from the evidence index`);
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash as `sha256:${string}`,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "supports",
    playOrderIndex: record.fromPlayOrder,
  };
}

function dependencies(scene: P1ReadScene, segment: LocalizationSegment): readonly DependencyRef[] {
  const unitById = new Map(scene.units.map((unit) => [unit.factId, unit]));
  const core = coreIds(segment).map((unitId) => unitById.get(unitId)!);
  const from = Math.min(...core.map((unit) => unit.value.playOrderIndex));
  const through = Math.max(...core.map((unit) => unit.value.playOrderIndex));
  return scene.bibleEntries.map((entry) => ({
    upstreamObjectId: entry.sourceObjectId,
    upstreamVersion: entry.version,
    claimId: null,
    fieldPath: ["body"],
    renderingId: entry.renderingId,
    scope: entry.scope,
    fromPlayOrder: from,
    throughPlayOrder: through,
  }));
}

function claimsFor(model: ReadModel, batch: DraftBatch): readonly Claim[] {
  return batch.drafts.map((draft) => ({
    claimId: `translation:${batch.batchId}:unit:${draft.unitId}`,
    statement: `Target realization drafted for ${draft.unitId}.`,
    scope: { kind: "global" } as const,
    kind: "style" as const,
    confidence: "high" as const,
    citations: [citationFor(model, draft.unitId)],
  }));
}

/** Re-seal a validated P1 batch. The object is necessarily provisional: per-unit
 * deterministic gates and reviewer lanes, not the localizer, decide finality. */
export function assembleP1TranslationObject(
  model: ReadModel,
  context: P1Context,
  scene: P1ReadScene,
  segment: LocalizationSegment,
  batch: DraftBatch,
): WikiObject {
  const claims = claimsFor(model, batch).map((claim) => ({ ...claim, scope: scene.scope }));
  const candidate = {
    schemaVersion: "itotori.wiki-object.v1" as const,
    objectId: objectIdFor(scene.sceneId, segment),
    version: 1,
    lang: model.localization!.targetLocale,
    subject: { kind: "scene" as const, id: scene.sceneId },
    scope: scene.scope,
    claims,
    media: [],
    dependencies: dependencies(scene, segment),
    provisional: true,
    kind: "translation" as const,
    body: { draftBatch: batch },
    provenance: {
      snapshotKind: "localization" as const,
      contextSnapshotId: model.snapshotId,
      localizationSnapshotId: model.localization!.localizationSnapshotId,
      contextScope: context.contextScope,
      runMode: context.runMode,
      authorRoleId: P1_ROLE_ID,
      editedBy: "agent" as const,
    },
  };
  const object = TranslationWikiObjectSchema.parse(candidate);
  validateWikiObjectClaims(object, model);
  return object;
}
