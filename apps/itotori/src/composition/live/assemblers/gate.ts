// The gate assembler — the deterministic `GateDeps` that synthesizes the
// candidate `AcceptedUnitOutput[]` a drafted scene gates against.
//
// The deterministic gates are a pure function of (immutable fact snapshot,
// accepted output). The driver hands a `DraftedScene`; this module turns each
// drafted unit into the candidate unit-subject accepted output the gates bind by
// `subjectId === factId` and read (`value.targetSkeleton`, `sourceHash`). The
// gate receipts are empty at gate-INPUT time (no gate has run yet — they are
// filled from the gate report at acceptance), and evidence is carried only when
// an evidence corpus is configured so the evidence-scope gate never silently
// skips. Zero model calls.

import { createHash } from "node:crypto";

import type { DeterministicGateInput } from "../../../gates/index.js";
import type {
  AcceptedUnitOutput,
  BoxLimitPolicy,
  GlossaryApprovedForm,
  WorkScope,
} from "../../../gates/index.js";
import type { Fact } from "../../../contracts/index.js";
import type { GateDeps } from "../../deps.js";
import type { DraftedScene, DraftedUnit } from "../../../workflow/index.js";
import { AssemblerError, type DecodeFactSource, type Sha256Hash } from "./substrate.js";

/** An optional evidence corpus that turns on the evidence-scope gate: the
 * context facts accepted outputs cite plus the snapshot they must belong to. */
export interface GateEvidenceCorpus {
  readonly contextFacts: readonly Fact[];
  readonly contextSnapshotId: string;
}

/** The optional deterministic side inputs the gate pass may read. */
export interface GateSideInputs {
  readonly glossary?: readonly GlossaryApprovedForm[];
  readonly boxLimits?: BoxLimitPolicy;
  readonly workScope?: WorkScope;
  readonly evidence?: GateEvidenceCorpus;
}

function sha256(value: string): Sha256Hash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Synthesize the candidate unit-subject accepted output for one drafted unit.
 * The gates bind it to the snapshot by `subjectId === factId` and read the
 * target + source hash; `withEvidence` decides whether it carries its cited
 * evidence (so the evidence-scope gate runs) or none (so it is not required). */
function candidateAcceptedOutput(
  unit: DraftedUnit,
  parentDraftBatchId: string,
  localizationSnapshotId: string,
  withEvidence: boolean,
): AcceptedUnitOutput {
  const draft = unit.draft;
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `accepted:${draft.unitId}:draft`,
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: withEvidence ? [...draft.evidenceIds] : [],
    acceptedAt: "1970-01-01T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "production",
      contextScope: "whole-game",
      reason: "not-final",
    },
    subjectType: "unit",
    subjectId: draft.unitId,
    localizationSnapshotId,
    stage: "draft",
    sourceHash: draft.sourceHash,
    value: {
      targetSkeleton: draft.targetSkeleton,
      targetHash: sha256(draft.targetSkeleton),
      translationObjectId: `translation:${draft.unitId}`,
      translationObjectVersion: 1,
      parentDraftBatchId,
      basis: draft.basis,
      // No gate has run at gate-INPUT time; receipts are filled at acceptance.
      gateReceipts: [],
      reviewVerdictIds: [],
    },
  };
}

/** Build the deterministic-gate input for a drafted scene. */
export function buildDeterministicGateInput(input: {
  readonly scene: DraftedScene;
  readonly facts: DecodeFactSource;
  readonly side: GateSideInputs;
}): DeterministicGateInput {
  const parentDraftBatchId = input.scene.batches[0]?.batchId;
  if (parentDraftBatchId === undefined) {
    throw new AssemblerError("no-draft-batch", `scene ${input.scene.sceneId} has no draft batch`);
  }
  const localizationSnapshotId =
    input.scene.batches[0]?.localizationSnapshotId ?? input.facts.snapshot.snapshotId;
  const withEvidence = input.side.evidence !== undefined;
  const accepted = input.scene.units.map((unit) =>
    candidateAcceptedOutput(unit, parentDraftBatchId, localizationSnapshotId, withEvidence),
  );
  return {
    snapshot: input.facts.snapshot,
    accepted,
    ...(input.side.glossary !== undefined ? { glossary: input.side.glossary } : {}),
    ...(input.side.boxLimits !== undefined ? { boxLimits: input.side.boxLimits } : {}),
    ...(input.side.workScope !== undefined ? { workScope: input.side.workScope } : {}),
    ...(input.side.evidence !== undefined
      ? {
          contextFacts: input.side.evidence.contextFacts,
          contextSnapshotId: input.side.evidence.contextSnapshotId,
        }
      : {}),
  };
}

/** Build the gate seam from the fact source + optional deterministic side
 * inputs. The `evaluate` call inside the port runs the pure gates. */
export function createGateDeps(input: {
  readonly facts: DecodeFactSource;
  readonly side?: GateSideInputs;
}): GateDeps {
  const side = input.side ?? {};
  return {
    buildInput: (scene: DraftedScene) =>
      buildDeterministicGateInput({ scene, facts: input.facts, side }),
  };
}
