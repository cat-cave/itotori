// p0-core-result-revision-hitl — play-tester target edit service.
//
// A non-source-speaker play tester edits one delivered TARGET line. This
// service is a thin typed shell over
// `ItotoriLocalizationResultRevisionRepository`: it creates a
// LocalizedResultRevision + child delivered PatchVersion atomically with
// real actor provenance, and immediately selects that child for export.
// There is no approval/reviewer-queue gate between an edit and delivery.

import type {
  ApplyPlayTesterTargetEditResult,
  AuthorizationActor,
  ItotoriLocalizationResultRevisionRepositoryPort,
  PlayablePatchExport,
  SelectedPatchExport,
} from "@itotori/db";
import { DeliveredPatchExporter } from "../patch-export/exporter.js";
import type { DeliveredPatchArchive } from "../patch-export/delivery-archive.js";

export type PlayTesterTargetEditRequest = {
  parentPatchVersionId: string;
  bridgeUnitId: string;
  /** Non-blank target-language text only — no source text required or accepted. */
  targetBody: string;
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

export type PlayablePatchExportResponse = {
  schemaVersion: "play.playable_patch_export.v0.1";
  generatedAt: Date;
  export: PlayablePatchExport | null;
};

export type PlayTesterResultRevisionServiceDeps = {
  repository: ItotoriLocalizationResultRevisionRepositoryPort;
  /** The production selected-patch delivery boundary. */
  deliveryExporter?: DeliveredPatchExporter;
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
  loadSelectedArchive(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<DeliveredPatchArchive | null>;
  loadExactPatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExportResponse>;
  loadExactPatchArchive(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<DeliveredPatchArchive | null>;
}

/**
 * The HTTP/CLI-facing projection. The factory binds the authenticated actor,
 * so callers can submit target text but cannot impersonate another tester.
 */
export interface BoundPlayTesterResultRevisionServicePort {
  editTarget(input: PlayTesterTargetEditRequest): Promise<PlayTesterTargetEditResponse>;
  loadSelectedExport(input: {
    runId?: string;
    patchVersionId?: string;
  }): Promise<SelectedPatchExportResponse>;
  loadSelectedArchive(input: {
    runId?: string;
    patchVersionId?: string;
  }): Promise<DeliveredPatchArchive | null>;
  loadExactPatchExport(input: { patchVersionId: string }): Promise<PlayablePatchExportResponse>;
  loadExactPatchArchive(input: { patchVersionId: string }): Promise<DeliveredPatchArchive | null>;
}

export class PlayTesterResultRevisionService implements PlayTesterResultRevisionServicePort {
  private readonly now: () => Date;
  private readonly deliveryExporter: DeliveredPatchExporter;

  constructor(private readonly deps: PlayTesterResultRevisionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.deliveryExporter = deps.deliveryExporter ?? new DeliveredPatchExporter(deps.repository);
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
    const selected = await this.deliveryExporter.export(actor, input);
    return {
      schemaVersion: "play.selected_patch_export.v0.1",
      generatedAt: this.now(),
      export: selected,
    };
  }

  async loadSelectedArchive(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<DeliveredPatchArchive | null> {
    return this.deliveryExporter.archive(actor, input);
  }

  async loadExactPatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExportResponse> {
    const patch = await this.deliveryExporter.exportExact(actor, input);
    return {
      schemaVersion: "play.playable_patch_export.v0.1",
      generatedAt: this.now(),
      export: patch,
    };
  }

  async loadExactPatchArchive(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<DeliveredPatchArchive | null> {
    return this.deliveryExporter.archiveExact(actor, input);
  }
}

export function bindPlayTesterResultRevisionService(
  service: PlayTesterResultRevisionServicePort,
  actor: AuthorizationActor,
): BoundPlayTesterResultRevisionServicePort {
  return {
    editTarget: (input) => service.editTarget(actor, input),
    loadSelectedExport: (input) => service.loadSelectedExport(actor, input),
    loadSelectedArchive: (input) => service.loadSelectedArchive(actor, input),
    loadExactPatchExport: (input) => service.loadExactPatchExport(actor, input),
    loadExactPatchArchive: (input) => service.loadExactPatchArchive(actor, input),
  };
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
