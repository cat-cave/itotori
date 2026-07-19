// The immutable read model the local tools read from.
//
// It is assembled once from a committed ContextSnapshot (the trust root), the
// deterministic fact snapshot the context committed, and the bridge units the
// snapshot bound. The build FAILS LOUD when the context did not commit exactly
// this fact snapshot, or when a fact references a unit/scene the snapshot does
// not carry — so a tool can never serve a fact from an unbound source. Locale-
// scoped inputs (glossary target forms, accepted outputs) are injected and
// bound to the snapshot's units; reference notes are injected excerpts.

import type { LlmContextSnapshot, LlmRevealHorizon, LlmRevisionRef } from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

import type { AcceptedOutput, GlossaryFactValue, HumanNoteFactValue } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { ReadToolError } from "./access.js";
import type { CharacterProfile } from "./projection.js";

export interface ReadModelLocalization {
  localizationSnapshotId: `sha256:${string}`;
  targetLocale: string;
  localeBranchId: string;
  glossaryRevision: LlmRevisionRef;
  /** Approved target forms, bound to the snapshot's units by occurrenceUnitIds. */
  glossaryEntries: readonly GlossaryFactValue[];
  /** Accepted outputs for exactly this localization snapshot. */
  acceptedOutputs: readonly AcceptedOutput[];
}

export interface ReadModel {
  snapshotId: `sha256:${string}`;
  sourceLanguage: string;
  revealHorizon: LlmRevealHorizon;
  factSnapshot: FactSnapshot;
  bundleUnits: ReadonlyMap<string, LocalizationUnitV02>;
  characterProfiles: ReadonlyMap<string, CharacterProfile>;
  references: readonly HumanNoteFactValue[];
  localization: ReadModelLocalization | null;
}

export interface BuildReadModelInput {
  contextSnapshot: LlmContextSnapshot;
  factSnapshot: FactSnapshot;
  bundle: BridgeBundleV02;
  characterProfiles?: ReadonlyMap<string, CharacterProfile>;
  references?: readonly HumanNoteFactValue[];
  localization?: ReadModelLocalization;
}

/** Assemble the immutable read model, proving snapshot integrity up front. */
export function buildReadModel(input: BuildReadModelInput): ReadModel {
  const { contextSnapshot, factSnapshot, bundle } = input;

  const materialization = contextSnapshot.factMaterialization;
  if (!materialization || materialization.contentHash !== factSnapshot.contentHash) {
    throw new ReadToolError(
      "snapshot-integrity",
      "the context snapshot did not commit this fact snapshot",
    );
  }

  const bundleUnits = new Map<string, LocalizationUnitV02>();
  for (const unit of bundle.units) bundleUnits.set(unit.bridgeUnitId, unit);
  for (const unit of factSnapshot.orderedUnits) {
    if (!bundleUnits.has(unit.bridgeUnitId)) {
      throw new ReadToolError("snapshot-integrity", `unit ${unit.factId} has no bound bridge unit`);
    }
  }

  const unitFactIds = new Set(factSnapshot.orderedUnits.map((unit) => unit.factId));
  const sceneIds = new Set(factSnapshot.scenes.map((scene) => scene.sceneId));

  const characterProfiles = input.characterProfiles ?? new Map<string, CharacterProfile>();
  for (const [characterId, profile] of characterProfiles) {
    for (const unitId of profile.unitIds) {
      if (!unitFactIds.has(unitId)) {
        throw new ReadToolError(
          "snapshot-integrity",
          `character ${characterId} cites unbound unit ${unitId}`,
        );
      }
    }
  }

  if (input.localization) {
    for (const entry of input.localization.glossaryEntries) {
      for (const unitId of entry.occurrenceUnitIds) {
        if (!unitFactIds.has(unitId)) {
          throw new ReadToolError(
            "snapshot-integrity",
            `glossary ${entry.termId} cites unbound unit ${unitId}`,
          );
        }
      }
    }
    for (const output of input.localization.acceptedOutputs) {
      if (!("localizationSnapshotId" in output)) {
        throw new ReadToolError(
          "snapshot-integrity",
          `accepted output ${output.outputId} is not bound to this localization snapshot`,
        );
      }
      if (output.localizationSnapshotId !== input.localization.localizationSnapshotId) {
        throw new ReadToolError(
          "snapshot-integrity",
          `accepted output ${output.outputId} is not on this localization snapshot`,
        );
      }
      if (output.subjectType === "unit") {
        const unit = factSnapshot.orderedUnits.find(
          (candidate) => candidate.factId === output.subjectId,
        );
        if (!unit) {
          throw new ReadToolError(
            "snapshot-integrity",
            `accepted output ${output.outputId} cites unbound unit ${output.subjectId}`,
          );
        }
        if (output.sourceHash !== unit.sourceHash) {
          throw new ReadToolError(
            "snapshot-integrity",
            `accepted output ${output.outputId} has a stale source hash`,
          );
        }
      }
      if (
        output.subjectType === "translation-object" &&
        output.value.provenance.localizationSnapshotId !== input.localization.localizationSnapshotId
      ) {
        throw new ReadToolError(
          "snapshot-integrity",
          `translation output ${output.outputId} has a mismatched provenance snapshot`,
        );
      }
      if (
        output.subjectType === "localized-rendering" &&
        output.value.provenance.localizationSnapshotId !== input.localization.localizationSnapshotId
      ) {
        throw new ReadToolError(
          "snapshot-integrity",
          `localized rendering ${output.outputId} has a mismatched provenance snapshot`,
        );
      }
    }
  }

  void sceneIds;
  return {
    snapshotId: contextSnapshot.snapshotId,
    sourceLanguage: contextSnapshot.sourceLanguage,
    revealHorizon: contextSnapshot.revealHorizon,
    factSnapshot,
    bundleUnits,
    characterProfiles,
    references: input.references ?? [],
    localization: input.localization ?? null,
  };
}
