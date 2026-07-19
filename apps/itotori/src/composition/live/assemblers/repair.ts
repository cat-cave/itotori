// The repair assembler — the deterministic `RepairDeps` that projects the P2
// line-edit and P3 semantic-repair inputs from the THREADED drafted scene.
//
// These inputs cannot be built from the defects alone: the P2 editor continues
// the CURRENT DRAFT and the P3 fork re-grounds the failing CANDIDATE. Part 1
// threads the run-scoped `DraftedScene` to this seam, so the assembler projects:
//   - the current-draft batch (from the scene's per-unit finalized drafts),
//   - the repair defect bundle (from the implicated defects),
//   - the implicated source `UnitFact`s (masking skeletons + placeholders),
//   - the P3 candidates (source + current target for each failing unit).
// The role's own `deriveEditScope` / `normalizeRepairRequest` are the oracle the
// proof runs the projected inputs through. Zero model calls; the ZDR runtimes are
// injected and carried through.

import type { Defect, DefectBundle, DraftBatch } from "../../../contracts/index.js";
import type { EditLineInput, EditorRuntimeBase } from "../../../roles/p2/index.js";
import type {
  RepairCandidateUnit,
  RepairOptions,
  RepairRequest,
  RepairRuntimeBase,
} from "../../../roles/p3/index.js";
import type { RepairDeps } from "../../deps.js";
import type { DraftedScene, DraftedUnit } from "../../../workflow/index.js";
import {
  AssemblerError,
  projectSceneUnitFacts,
  type DecodeFactSource,
  type RunScopeConfig,
} from "./substrate.js";

/** Index the scene's finalized per-unit drafts by unit id. */
function draftsByUnit(scene: DraftedScene): ReadonlyMap<string, DraftedUnit> {
  return new Map(scene.units.map((unit) => [unit.unitId, unit]));
}

/** The scene's batch identity — the current draft + repair bundle share it so
 * the P2 scope check binds them. Fails loud on a scene with no batch. */
function batchIdentity(scene: DraftedScene): {
  readonly batchId: string;
  readonly localizationSnapshotId: string;
} {
  const batch = scene.batches[0];
  if (batch === undefined) {
    throw new AssemblerError("no-draft-batch", `scene ${scene.sceneId} has no draft batch`);
  }
  return { batchId: batch.batchId, localizationSnapshotId: batch.localizationSnapshotId };
}

/** Synthesize the current-draft batch from the scene's finalized per-unit drafts
 * — the parent the P2 editor patches back over. */
function currentDraftBatch(scene: DraftedScene): DraftBatch {
  const { batchId, localizationSnapshotId } = batchIdentity(scene);
  const drafts = scene.units.map((unit) => unit.draft);
  return {
    schemaVersion: "itotori.draft-batch.v1",
    localizationSnapshotId,
    batchId,
    scope: {
      kind: "whole-scene",
      sceneId: scene.sceneId,
      expectedUnitIds: drafts.map((draft) => draft.unitId),
    },
    drafts,
  };
}

/** Synthesize the repair defect bundle from the implicated defects — a genuine
 * per-unit repair bundle tied to the current draft. */
function repairBundle(
  defects: readonly Defect[],
  batchId: string,
  localizationSnapshotId: string,
): DefectBundle {
  return {
    schemaVersion: "itotori.defect-bundle.v1",
    bundleId: `bundle:repair:${batchId}`,
    localizationSnapshotId,
    draftBatchId: batchId,
    defects: [...defects],
    factDominance: [],
    resolution: "repair",
  };
}

/** The de-duplicated, stably-ordered wiki-first basis of the implicated drafted
 * units — exactly the rendering ids the repaired lines cite. */
function implicatedBibleRenderingIds(
  unitIds: readonly string[],
  drafts: ReadonlyMap<string, DraftedUnit>,
): readonly string[] {
  const ids = new Set<string>();
  for (const unitId of unitIds) {
    for (const id of drafts.get(unitId)?.bibleRenderingIds ?? []) ids.add(id);
  }
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Build the P2 `EditLineInput`: current draft + repair bundle + implicated
 * source facts + rendering basis. Deterministic projection of the threaded scene
 * + injected fact source. */
export function buildEditLineInput(input: {
  readonly scene: DraftedScene;
  readonly unitIds: readonly string[];
  readonly defects: readonly Defect[];
  readonly facts: DecodeFactSource;
  readonly config: RunScopeConfig;
}): EditLineInput {
  const drafts = draftsByUnit(input.scene);
  const currentDraft = currentDraftBatch(input.scene);
  return {
    currentDraft,
    defectBundle: repairBundle(
      input.defects,
      currentDraft.batchId,
      currentDraft.localizationSnapshotId,
    ),
    units: projectSceneUnitFacts(input.unitIds, input.facts),
    bibleRenderingIds: implicatedBibleRenderingIds(input.unitIds, drafts),
    contextSnapshotId: input.config.contextSnapshotId,
    localizationSnapshotId: input.config.localizationSnapshotId,
    schemaHash: input.config.schemaHash,
    runMode: input.config.runMode,
    contextScope: input.config.contextScope,
  };
}

/** Build one P3 repair candidate: the failing unit's grounded source + its
 * anonymous current target. Fails loud on a unit missing from the scene. */
function repairCandidate(
  unitId: string,
  drafts: ReadonlyMap<string, DraftedUnit>,
  facts: DecodeFactSource,
): RepairCandidateUnit {
  const drafted = drafts.get(unitId);
  if (drafted === undefined) {
    throw new AssemblerError("unknown-candidate", `unit ${unitId} is not in the drafted scene`);
  }
  const fact = projectSceneUnitFacts([unitId], facts)[0]!.value;
  return {
    unitId,
    sourceHash: fact.sourceHash,
    sourceSkeleton: fact.sourceSkeleton,
    protectedPlaceholders: fact.protectedPlaceholders.map((placeholder) => ({
      placeholderId: placeholder.placeholderId,
      kind: placeholder.kind,
      sourceText: placeholder.sourceText,
    })),
    surfaceKind: fact.surfaceKind,
    choiceContext: fact.choiceContext,
    currentTargetSkeleton: drafted.draft.targetSkeleton,
  };
}

/** Build the P3 `RepairRequest`: the repair bundle + one candidate per failing
 * unit (exactly the failed units — no passing unit rides along). */
export function buildRepairRequest(input: {
  readonly scene: DraftedScene;
  readonly unitIds: readonly string[];
  readonly defects: readonly Defect[];
  readonly facts: DecodeFactSource;
}): RepairRequest {
  const drafts = draftsByUnit(input.scene);
  const { batchId, localizationSnapshotId } = batchIdentity(input.scene);
  const candidates = input.unitIds.map((unitId) => repairCandidate(unitId, drafts, input.facts));
  const bibleRenderingIds = implicatedBibleRenderingIds(input.unitIds, drafts);
  const wikiFacts = input.defects.flatMap((defect) =>
    defect.evidenceIds.map((factId) => ({
      factId,
      kind: defect.category,
      // The assembler never manufactures a review rationale. This is the
      // exact, traceable fact reference; the repair separately receives the
      // review's span/evidence/constraint bundle.
      text: `Pinned evidence reference ${factId}`,
    })),
  );
  return {
    defectBundle: repairBundle(input.defects, batchId, localizationSnapshotId),
    candidateBatchId: batchId,
    candidates,
    bibleRenderingIds,
    preDraftContext: {
      sourceFacts: candidates.map((candidate) => ({
        unitId: candidate.unitId,
        sourceHash: candidate.sourceHash,
        sourceSkeleton: candidate.sourceSkeleton,
        protectedPlaceholders: candidate.protectedPlaceholders,
        surfaceKind: candidate.surfaceKind ?? null,
        choiceContext: candidate.choiceContext ?? null,
      })),
      wikiFacts,
      // This pure composition projection has immutable localized-Wiki handles
      // rather than a second mutable author thread. The role receives the
      // pinned rendering id (and its explicit reference label) as bible ground;
      // richer rendered text is preserved when a caller supplies it directly.
      bible: bibleRenderingIds.map((renderingId) => ({
        renderingId,
        text: `Pinned localized-bible rendering ${renderingId}`,
      })),
    },
    tripwires: [],
  };
}

/** Build the P3 `RepairOptions` — the snapshot ids, realization mode, and the
 * bounded-repair ledger the fork is bounded by. */
export function buildRepairOptions(input: {
  readonly repairedDefectLedger: ReadonlySet<string>;
  readonly config: RunScopeConfig;
}): RepairOptions {
  return {
    contextSnapshotId: input.config.contextSnapshotId,
    localizationSnapshotId: input.config.localizationSnapshotId,
    schemaHash: input.config.schemaHash,
    runMode: input.config.runMode,
    contextScope: input.config.contextScope,
    repairedDefectLedger: input.repairedDefectLedger,
  };
}

/** Build the correction seam from the fact source + run config + injected ZDR
 * runtimes. Every builder is a deterministic projection. */
export function createRepairDeps(input: {
  readonly facts: DecodeFactSource;
  readonly config: RunScopeConfig;
  readonly editRuntime: EditorRuntimeBase;
  readonly repairRuntime: RepairRuntimeBase;
}): RepairDeps {
  return {
    buildEditInput: (portInput) =>
      buildEditLineInput({
        scene: portInput.scene,
        unitIds: portInput.unitIds,
        defects: portInput.defects,
        facts: input.facts,
        config: input.config,
      }),
    editRuntime: input.editRuntime,
    buildRepairRequest: (portInput) =>
      buildRepairRequest({
        scene: portInput.scene,
        unitIds: portInput.unitIds,
        defects: portInput.defects,
        facts: input.facts,
      }),
    buildRepairOptions: (portInput) =>
      buildRepairOptions({
        repairedDefectLedger: portInput.repairedDefectLedger,
        config: input.config,
      }),
    repairRuntime: input.repairRuntime,
  };
}
