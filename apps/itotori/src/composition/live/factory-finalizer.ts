import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";

import type { AcceptedOutput, Draft } from "../../contracts/index.js";
import type { NativePatchbackInput } from "../../patchback/index.js";
import type { FactSnapshot } from "../../prepass/index.js";
import type { SceneLocalization } from "../../roles/p1/index.js";
import type { FinalizedUnit } from "../../workflow/index.js";
import type { PatchbackDeps } from "../deps.js";
import type { RunScopeConfig } from "./assemblers/index.js";
import type { FinalizeArtifactResolver } from "./artifact-store.js";
import {
  createProductionRenderEvidencePatchback,
  type BuildLqaReviewEvidence,
  type BuildLqaReviewer,
  type ProductionRenderEvidencePlan,
} from "./render-evidence-adapter.js";

/** A malformed persisted bible relation is a factory fault. A merely missing
 * bible entry is not: it is represented by an incomplete installed bible and
 * blocks unit readiness through the normal workflow port. */
export class LiveWorkflowFactoryError extends Error {
  constructor(detail: string) {
    super(`live workflow factory refused: ${detail}`);
    this.name = "LiveWorkflowFactoryError";
  }
}

/**
 * P1 owns draft validation; the CAS finalizer owns sealing that validated draft
 * as the accepted unit output. Keeping the short-lived receipt index inside the
 * per-run factory gives the finalizer the actual target text and verified model
 * memo keys instead of attempting to reconstruct either from a content hash.
 */
export function createCapturedDraftFinalizer(
  scope: RunScopeConfig,
  rawBridge: BridgeBundleV02,
  snapshot: FactSnapshot,
  targetLocale: string,
  options: {
    readonly renderEvidence?: ProductionRenderEvidencePlan;
    readonly buildLqaReviewer?: BuildLqaReviewer;
    /** Schema-validated final heads supplied by the encrypted CAS reader when
     * a fresh factory resumes after patch export. */
    readonly recoveredFinalOutputs?: readonly Extract<
      AcceptedOutput,
      { readonly subjectType: "unit" }
    >[];
  } = {},
): {
  readonly record: (localized: SceneLocalization) => void;
  readonly resolve: FinalizeArtifactResolver;
  readonly patchback: PatchbackDeps;
} {
  const byUnit = new Map<
    string,
    {
      readonly draft: Draft;
      readonly parentDraftBatchId: string;
      readonly memoKeys: readonly string[];
    }
  >();
  const acceptedByUnit = new Map<
    string,
    Extract<AcceptedOutput, { readonly subjectType: "unit" }>
  >();
  for (const output of options.recoveredFinalOutputs ?? []) {
    if (
      output.stage !== "final" ||
      output.localizationSnapshotId !== scope.localizationSnapshotId
    ) {
      throw new LiveWorkflowFactoryError("recovered final output is outside this localization run");
    }
    if (acceptedByUnit.has(output.subjectId)) {
      throw new LiveWorkflowFactoryError(`recovered final output repeats ${output.subjectId}`);
    }
    acceptedByUnit.set(output.subjectId, output);
  }
  const buildLqaEvidenceByUnit = new Map<string, BuildLqaReviewEvidence>();
  const record = (localized: SceneLocalization): void => {
    const memoKeys = localized.results.flatMap((result) =>
      result.status === "success" ? [result.memoKey] : [],
    );
    for (const draft of localized.finalizedDrafts) {
      const parent = localized.batches.find((batch) =>
        batch.drafts.some((candidate) => candidate.unitId === draft.unitId),
      );
      if (parent === undefined) {
        throw new LiveWorkflowFactoryError(`draft ${draft.unitId} has no parent P1 batch`);
      }
      byUnit.set(draft.unitId, { draft, parentDraftBatchId: parent.batchId, memoKeys });
    }
  };
  const resolve: FinalizeArtifactResolver = (input) => {
    if (input.stage !== "final" && input.stage !== "build-lqa") {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: stage ${input.stage} is not a final-stage output`,
      );
    }
    const buildLqaEvidence =
      input.stage === "build-lqa" ? buildLqaEvidenceByUnit.get(input.unitId) : undefined;
    if (input.stage === "build-lqa" && buildLqaEvidence === undefined) {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: no Q5 render/review evidence was captured for this build`,
      );
    }
    if (input.stage === "build-lqa" && buildLqaEvidence !== undefined) {
      const final = acceptedByUnit.get(input.unitId);
      if (final === undefined || final.stage !== "final") {
        throw new LiveWorkflowFactoryError(
          `cannot finalize ${input.unitId}: no verified final accepted output is available for Q5`,
        );
      }
      const output = acceptedOutputForBuildLqa({
        final,
        version: (input.priorHead?.version ?? 0) + 1,
        priorOutputId: input.priorHead?.outputId,
        shippable: input.shippable,
        buildLqaEvidence,
      });
      return finalizedArtifact(input, output);
    }
    const captured = byUnit.get(input.unitId);
    if (captured === undefined) {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: no validated P1 draft was captured for this run`,
      );
    }
    if (captured.memoKeys.length === 0) {
      throw new LiveWorkflowFactoryError(
        `cannot finalize ${input.unitId}: P1 produced no verified physical memo receipt`,
      );
    }
    const version = (input.priorHead?.version ?? 0) + 1;
    const output = acceptedOutputForCapturedDraft({
      unitId: input.unitId,
      version,
      priorOutputId: input.priorHead?.outputId,
      draft: captured.draft,
      parentDraftBatchId: captured.parentDraftBatchId,
      memoKeys: captured.memoKeys,
      scope,
      shippable: input.shippable,
    });
    acceptedByUnit.set(input.unitId, output);
    return finalizedArtifact(input, output);
  };
  const patchDirectory = mkdtempSync(join(tmpdir(), "itotori-native-patch-"));
  const basePatchback: PatchbackDeps = {
    buildInput(finalized: readonly FinalizedUnit[]): NativePatchbackInput {
      const accepted = finalized.map((unit) => {
        const output = acceptedByUnit.get(unit.unitId);
        if (output === undefined || output.stage !== "final") {
          throw new LiveWorkflowFactoryError(
            `cannot export patch: ${unit.unitId} has no captured final accepted output`,
          );
        }
        return output;
      });
      return {
        snapshot,
        accepted,
        rawBridge,
        workScope: {
          inScopeUnitFactIds: finalized.map((unit) => unit.unitId),
        },
        sourceLocale: rawBridge.sourceLocale,
        targetLocale,
      };
    },
    translatedBundlePath(finalized: readonly FinalizedUnit[]): string {
      const suffix = sha256(
        finalized
          .map((unit) => unit.unitId)
          .sort()
          .join(","),
      ).slice(7, 23);
      return join(patchDirectory, `translated-${suffix}.json`);
    },
    async buildLqa() {
      throw new LiveWorkflowFactoryError(
        "Build-LQA requires a patched-byte render/OCR adapter; no render evidence adapter is configured",
      );
    },
  };
  const productionRenderPatchback =
    options.renderEvidence === undefined
      ? undefined
      : createProductionRenderEvidencePatchback({
          plan: options.renderEvidence,
          snapshot,
          buildPatchInput: basePatchback.buildInput,
          reviewer: options.buildLqaReviewer,
          recoveredAccepted: [...acceptedByUnit.values()].filter(
            (output) => output.stage === "final",
          ),
          recordBuildLqaEvidence(evidence) {
            for (const receipt of evidence) {
              const prior = buildLqaEvidenceByUnit.get(receipt.unitId);
              if (prior !== undefined && !sameBuildLqaEvidence(prior, receipt)) {
                throw new LiveWorkflowFactoryError(
                  `Q5 captured conflicting render/review evidence for ${receipt.unitId}`,
                );
              }
              buildLqaEvidenceByUnit.set(receipt.unitId, receipt);
            }
          },
        });
  const patchback: PatchbackDeps = { ...basePatchback, ...productionRenderPatchback };
  return { record, resolve, patchback };
}

function acceptedOutputForCapturedDraft(input: {
  readonly unitId: string;
  readonly version: number;
  readonly priorOutputId: string | undefined;
  readonly draft: Draft;
  readonly parentDraftBatchId: string;
  readonly memoKeys: readonly string[];
  readonly scope: RunScopeConfig;
  readonly shippable: boolean;
}): Extract<AcceptedOutput, { readonly subjectType: "unit" }> {
  const releaseEligibility = input.shippable
    ? {
        kind: "shippable" as const,
        runMode: input.scope.runMode as "production" | "pilot",
        contextScope: input.scope.contextScope as "whole-game" | "external-augmented",
        basis: "wiki-first" as const,
      }
    : {
        kind: "artifact-only" as const,
        runMode: input.scope.runMode,
        contextScope: input.scope.contextScope,
        reason:
          input.draft.basis.kind === "pure-mtl-ablation"
            ? ("pure-mtl-ablation" as const)
            : input.scope.runMode === "test-dev"
              ? ("test-dev" as const)
              : ("not-final" as const),
      };
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: `accepted:${input.unitId}:final:v${input.version}`,
    version: input.version,
    ...(input.priorOutputId === undefined ? {} : { supersedesOutputId: input.priorOutputId }),
    parentOutputIds: input.priorOutputId === undefined ? [] : [input.priorOutputId],
    memoKeys: uniqueStrings(input.memoKeys),
    evidenceIds: uniqueStrings(input.draft.evidenceIds),
    acceptedAt: new Date().toISOString(),
    releaseEligibility,
    subjectType: "unit",
    subjectId: input.unitId,
    localizationSnapshotId: input.scope.localizationSnapshotId,
    stage: "final",
    sourceHash: input.draft.sourceHash,
    value: {
      targetSkeleton: input.draft.targetSkeleton,
      targetHash: sha256(input.draft.targetSkeleton),
      translationObjectId: `translation:${input.parentDraftBatchId}`,
      translationObjectVersion: 1,
      parentDraftBatchId: input.parentDraftBatchId,
      basis: input.draft.basis,
      // P1 validates protected spans before a draft reaches this boundary.
      gateReceipts: [
        {
          gate: "protected-spans",
          evidenceHash: sha256(input.draft.targetSkeleton),
          status: "PASS",
        },
      ],
      reviewVerdictIds: [],
    },
  };
}

/** Seal Q5 against the final accepted output itself. This gives a restarted
 * factory the same P1 provenance, basis, and target that the original patch
 * used; only verified Q5 evidence is appended here. */
function acceptedOutputForBuildLqa(input: {
  readonly final: Extract<AcceptedOutput, { readonly subjectType: "unit" }>;
  readonly version: number;
  readonly priorOutputId: string | undefined;
  readonly shippable: boolean;
  readonly buildLqaEvidence: BuildLqaReviewEvidence;
}): Extract<AcceptedOutput, { readonly subjectType: "unit" }> {
  if ((input.final.releaseEligibility.kind === "shippable") !== input.shippable) {
    throw new LiveWorkflowFactoryError(
      "Q5 finalization changed the final output's release posture",
    );
  }
  return {
    ...input.final,
    outputId: `accepted:${input.final.subjectId}:build-lqa:v${input.version}`,
    version: input.version,
    ...(input.priorOutputId === undefined ? {} : { supersedesOutputId: input.priorOutputId }),
    parentOutputIds: uniqueStrings([
      input.final.outputId,
      ...(input.priorOutputId === undefined ? [] : [input.priorOutputId]),
    ]),
    memoKeys: uniqueStrings([...input.final.memoKeys, input.buildLqaEvidence.memoKey]),
    evidenceIds: uniqueStrings([
      ...input.final.evidenceIds,
      ...buildLqaEvidenceIds(input.buildLqaEvidence),
    ]),
    acceptedAt: new Date().toISOString(),
    stage: "build-lqa",
    value: {
      ...input.final.value,
      reviewVerdictIds: uniqueStrings([
        ...input.final.value.reviewVerdictIds,
        input.buildLqaEvidence.reviewId,
      ]),
    },
  };
}

function finalizedArtifact(
  input: Parameters<FinalizeArtifactResolver>[0],
  output: Extract<AcceptedOutput, { readonly subjectType: "unit" }>,
) {
  return {
    outputId: output.outputId,
    semanticKey: sha256(`${input.unitId}:${input.stage}:${input.contentHash}`),
    schemaVersion: output.schemaVersion,
    outputJson: JSON.stringify(output),
    memoKeys: output.memoKeys,
    sourceHash: output.sourceHash,
  };
}

function buildLqaEvidenceIds(evidence: BuildLqaReviewEvidence | undefined): readonly string[] {
  if (evidence === undefined) return [];
  return [
    evidence.patchId,
    `render-result:${evidence.renderResultHash.slice("sha256:".length)}`,
    `render-patched-bytes:${evidence.patchedBytesHash.slice("sha256:".length)}`,
    evidence.frameId,
    `render-frame:${evidence.frameContentHash.slice("sha256:".length)}`,
  ];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameBuildLqaEvidence(
  left: BuildLqaReviewEvidence,
  right: BuildLqaReviewEvidence,
): boolean {
  return (
    left.unitId === right.unitId &&
    left.patchId === right.patchId &&
    left.renderResultHash === right.renderResultHash &&
    left.patchedBytesHash === right.patchedBytesHash &&
    left.frameId === right.frameId &&
    left.frameContentHash === right.frameContentHash &&
    left.reviewId === right.reviewId &&
    left.memoKey === right.memoKey
  );
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
