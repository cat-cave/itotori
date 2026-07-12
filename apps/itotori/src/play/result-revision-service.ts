// p0-core-result-revision-hitl — play-tester target edit service.
//
// A non-source-speaker play tester edits one delivered TARGET line. This
// service is a thin typed shell over
// `ItotoriLocalizationResultRevisionRepository`: it creates a
// LocalizedResultRevision + child delivered PatchVersion atomically with
// real actor provenance, and immediately selects that child for export.
// There is no approval/reviewer-queue gate and no request_repair detour.

import type {
  ApplyPlayTesterTargetEditResult,
  AuthorizationActor,
  ItotoriLocalizationResultRevisionRepositoryPort,
  SelectedPatchExport,
} from "@itotori/db";

export type PlayTesterTargetEditRequest = {
  parentPatchVersionId: string;
  bridgeUnitId: string;
  /** Non-blank target-language text only — no source text required or accepted. */
  targetBody: string;
  artifactRootDir: string;
};

export type PlayTesterTargetEditResponse = {
  schemaVersion: "play.tester_result_revision.v0.1";
  generatedAt: Date;
  result: ApplyPlayTesterTargetEditResult;
};

export type SelectedPatchExportResponse = {
  schemaVersion: "play.selected_patch_export.v0.1";
  generatedAt: Date;
  export: SelectedPatchExport | null;
};

export type PlayTesterResultRevisionServiceDeps = {
  repository: ItotoriLocalizationResultRevisionRepositoryPort;
  now?: () => Date;
};

export interface PlayTesterResultRevisionServicePort {
  editTarget(
    actor: AuthorizationActor,
    input: PlayTesterTargetEditRequest,
  ): Promise<PlayTesterTargetEditResponse>;
  loadSelectedExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExportResponse>;
}

export class PlayTesterResultRevisionService implements PlayTesterResultRevisionServicePort {
  private readonly now: () => Date;

  constructor(private readonly deps: PlayTesterResultRevisionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async editTarget(
    actor: AuthorizationActor,
    input: PlayTesterTargetEditRequest,
  ): Promise<PlayTesterTargetEditResponse> {
    // Target-first: reject any accidental source fields so a non-source-speaker
    // path cannot be polluted by source-language requirements.
    const record = input as PlayTesterTargetEditRequest & {
      sourceText?: unknown;
      sourceBody?: unknown;
      source?: unknown;
    };
    if (
      record.sourceText !== undefined ||
      record.sourceBody !== undefined ||
      record.source !== undefined
    ) {
      throw new PlayTesterResultRevisionServiceError(
        "source_not_accepted",
        "play-tester target edit accepts only target text; source language is not required or accepted",
      );
    }
    if (input.targetBody.trim().length === 0) {
      throw new PlayTesterResultRevisionServiceError(
        "blank_target",
        "play-tester target edit requires non-blank target text",
      );
    }

    const result = await this.deps.repository.applyPlayTesterTargetEdit(actor, {
      parentPatchVersionId: input.parentPatchVersionId,
      bridgeUnitId: input.bridgeUnitId,
      targetBody: input.targetBody,
      artifactRootDir: input.artifactRootDir,
    });

    return {
      schemaVersion: "play.tester_result_revision.v0.1",
      generatedAt: this.now(),
      result,
    };
  }

  async loadSelectedExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExportResponse> {
    const selected = await this.deps.repository.loadSelectedPatchExport(actor, input);
    return {
      schemaVersion: "play.selected_patch_export.v0.1",
      generatedAt: this.now(),
      export: selected,
    };
  }
}

export class PlayTesterResultRevisionServiceError extends Error {
  constructor(
    readonly code: "blank_target" | "source_not_accepted",
    message: string,
  ) {
    super(message);
    this.name = "PlayTesterResultRevisionServiceError";
  }
}
