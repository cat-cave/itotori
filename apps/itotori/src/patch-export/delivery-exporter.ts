import {
  verifyLocalizationArtifactManifest,
  type AuthorizationActor,
  type PlayablePatchExport,
  type SelectedPatchExport,
} from "@itotori/db";
import { createDeliveredPatchArchive, type DeliveredPatchArchive } from "./delivery-archive.js";

export interface SelectedPatchDeliveryLoaderPort {
  loadSelectedPatchExport(
    actor: AuthorizationActor,
    input: { runId?: string; patchVersionId?: string },
  ): Promise<SelectedPatchExport | null>;
}

export interface PlayablePatchDeliveryLoaderPort {
  loadPlayablePatchExport(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null>;
}

export type DeliveredPatchExportInput = { runId?: string; patchVersionId?: string };

export class DeliveredPatchExporter {
  constructor(
    private readonly loader: SelectedPatchDeliveryLoaderPort & PlayablePatchDeliveryLoaderPort,
  ) {}

  async export(
    actor: AuthorizationActor,
    input: DeliveredPatchExportInput,
  ): Promise<SelectedPatchExport | null> {
    const selected = await this.loader.loadSelectedPatchExport(actor, input);
    if (selected === null) return null;
    if (selected.status !== "playable" || selected.playableAt === null) {
      throw new Error(
        `delivered patch export refused: selected patch ${selected.patchVersionId} is not playable`,
      );
    }
    verifyLocalizationArtifactManifest(selected.artifactRefs, selected.artifactHashes);
    return selected;
  }

  async exportExact(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<PlayablePatchExport | null> {
    const patch = await this.loader.loadPlayablePatchExport(actor, input);
    if (patch === null) return null;
    if (patch.status !== "playable" || patch.playableAt === null) {
      throw new Error(
        `delivered patch export refused: patch ${patch.patchVersionId} is not playable`,
      );
    }
    verifyLocalizationArtifactManifest(patch.artifactRefs, patch.artifactHashes);
    return patch;
  }

  async archive(
    actor: AuthorizationActor,
    input: DeliveredPatchExportInput,
  ): Promise<DeliveredPatchArchive | null> {
    const selected = await this.export(actor, input);
    return selected === null ? null : createDeliveredPatchArchive(selected);
  }

  async archiveExact(
    actor: AuthorizationActor,
    input: { patchVersionId: string },
  ): Promise<DeliveredPatchArchive | null> {
    const patch = await this.exportExact(actor, input);
    return patch === null ? null : createDeliveredPatchArchive(patch);
  }
}
