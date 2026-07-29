import type { AuthorizationActor } from "../authorization.js";

export type PlayTesterResultRevisionRecord = {
  resultRevisionId: string;
  journalOutcomeId: string;
  runId: string;
  bridgeUnitId: string;
  selectedCandidateId: string;
  targetBody: string;
  origin: "play_tester_edit";
  parentRevisionId: string;
  actorUserId: string;
  createdForPatchVersionId: string;
  createdAt: Date;
};

export type PlayTesterChildPatchVersionRecord = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string;
  status: "playable";
  origin: "play_tester_edit";
  actorUserId: string;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  playableAt: Date;
  selectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  units: SelectedPatchExportUnit[];
};

export type ApplyPlayTesterTargetEditInput = {
  parentPatchVersionId: string;
  bridgeUnitId: string;
  targetBody: string;
};

export type RecordPlayTestFeedbackEventInput = {
  feedbackBatchId?: string;
  body?: string;
  metadata: Record<string, unknown>;
};

export type ApplyPlayTesterTargetEditWithFeedbackInput = ApplyPlayTesterTargetEditInput & {
  feedback: RecordPlayTestFeedbackEventInput;
};

export type PlayTestFeedbackEventRecord = {
  feedbackEventId: string;
  feedbackBatchId: string;
  observedPatchVersionId: string;
  resultRevisionId: string;
  createdAt: Date;
};

export type ApplyPlayTesterTargetEditResult = {
  resultRevision: PlayTesterResultRevisionRecord;
  patchVersion: PlayTesterChildPatchVersionRecord;
  idempotentReplay: boolean;
};

export type ApplyPlayTesterTargetEditWithFeedbackResult = {
  edit: ApplyPlayTesterTargetEditResult;
  feedback: PlayTestFeedbackEventRecord;
};

export type PlayTesterPatchArtifactMaterializationInput = {
  childPatchVersionId: string;
  parentPatchVersionId: string;
  runId: string;
  bridgeUnitId: string;
  targetBody: string;
  parentArtifactRefs: Record<string, string>;
  parentArtifactHashes: Record<string, string>;
};

export type MaterializedPlayTesterPatchArtifact = {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): Promise<void> | void;
};

export interface PlayTesterPatchArtifactMaterializer {
  materialize(
    input: PlayTesterPatchArtifactMaterializationInput,
  ): Promise<MaterializedPlayTesterPatchArtifact>;
}

export type SelectedPatchExportUnit = {
  bridgeUnitId: string;
  sourceRunId: string;
  journalOutcomeId: string;
  resultRevisionId: string;
  memberOrigin: string;
  reusedFromPatchVersionId: string | null;
  unitOrdinal: number;
  targetBody: string;
  origin: string;
  actorUserId: string | null;
  selectedCandidateId: string;
};

export type SelectedPatchExport = {
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: string;
  actorUserId: string | null;
  status: string;
  selectedAt: Date;
  playableAt: Date | null;
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  units: SelectedPatchExportUnit[];
};

export type PlayablePatchExport = Omit<SelectedPatchExport, "selectedAt"> & {
  selectedAt: Date | null;
};

export class LocalizationResultRevisionRepositoryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "patch_not_found"
      | "unit_not_in_patch"
      | "patch_not_playable"
      | "blank_target"
      | "artifact_fault",
    message: string,
  ) {
    super(message);
    this.name = "LocalizationResultRevisionRepositoryError";
  }
}

export interface ItotoriLocalizationResultRevisionRepositoryPort {
  applyPlayTesterTargetEdit(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditInput,
  ): Promise<ApplyPlayTesterTargetEditResult>;
  applyPlayTesterTargetEditWithFeedback(
    actor: AuthorizationActor,
    input: ApplyPlayTesterTargetEditWithFeedbackInput,
  ): Promise<ApplyPlayTesterTargetEditWithFeedbackResult>;
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
  loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null>;
}
