// Production patched-byte render evidence for Build-LQA.
//
// The adapter joins the existing generic native patch producer with the runtime
// launcher registry. It owns no engine coordinate parser and never writes a
// substitute image: a selected runtime adapter replays the hash-verified patch
// and captures its E2 frame, while this layer only projects those receipts into
// the shared RenderAndOcrResult contract and runs the shared deterministic gate.

import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AcceptedOutput, Defect, RenderAndOcrResult } from "../../contracts/index.js";
import { RenderAndOcrResultSchema } from "../../contracts/index.js";
import { renderOcrGate } from "../../gates/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { type NativePatchbackInput, type PatchbackScope } from "../../patchback/index.js";
import {
  produceNativePatchbackBuild,
  type ProducedPatchbackManifest,
} from "../../patchback/produce-build.js";
import { createRuntimeLauncherRegistry } from "../../play/patch-runtime-launcher.js";
import type { FactSnapshot } from "../../prepass/index.js";
import type { FinalizedUnit, LaneVerdict } from "../../workflow/index.js";
import type { PatchbackDeps } from "../deps.js";

type AcceptedUnitOutput = Extract<AcceptedOutput, { readonly subjectType: "unit" }>;

/** Physical, per-invocation paths supplied by the operator through the kept
 * localize boundary. `buildRoot` is only used to create a fresh owned child;
 * completed evidence remains there for inspection rather than being cleaned up. */
export type ProductionRenderEvidencePlan = {
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly patchScope: PatchbackScope;
  readonly runId: string;
  /** Required only when the selected scene inherits a background from an
   * earlier scene; Utsushi still decodes this real asset from the patch tree. */
  readonly backgroundAsset?: string;
};

/** The Q5 role binder receives the already-validated runtime fact, not a
 * renderer capability. This keeps the reviewer read-only over the evidence. */
/** Q5's verified provider memo and verdict identity. The physical adapter
 * augments this reviewer-owned receipt with its patched-byte frame facts before
 * the finalizer seals the build-LQA accepted output. */
export type BuildLqaReviewerReceipt = {
  readonly unitId: string;
  readonly reviewId: string;
  readonly memoKey: string;
};

/** The content-free provenance sealed into a build-LQA accepted output. */
export type BuildLqaReviewEvidence = {
  readonly unitId: string;
  readonly patchId: string;
  readonly renderResultHash: string;
  readonly patchedBytesHash: string;
  readonly frameId: string;
  readonly frameContentHash: string;
  readonly reviewId: string;
  readonly memoKey: string;
};

export type BuildLqaReviewer = (input: {
  readonly render: RenderAndOcrResult;
  readonly accepted: readonly AcceptedUnitOutput[];
  readonly unitIds: readonly string[];
  /** Q5 supplies its provider-backed receipt; the physical adapter verifies
   * coverage and adds frame/build hashes before finalization. */
  readonly recordReceipt?: (receipt: BuildLqaReviewerReceipt) => void;
}) => Promise<readonly LaneVerdict[]>;

export class RenderEvidenceAdapterError extends Error {
  constructor(
    readonly code: "missing-patch" | "render-defects" | "runtime-receipt" | "reviewer-receipt",
    detail: string,
    readonly defects: readonly Defect[] = [],
  ) {
    super(`production render evidence refused: ${detail}`);
    this.name = "RenderEvidenceAdapterError";
  }
}

type StoredPatch = {
  readonly patch: ProducedPatchbackManifest;
  readonly input: NativePatchbackInput;
  readonly buildRoot: string;
};

/** Extend the captured finalizer's standard patchback seam with the physical
 * producer and mandatory Q5 evidence pass. It is deliberately unavailable
 * without a per-run physical plan; callers then fail rather than emitting
 * invented frames. */
export function createProductionRenderEvidencePatchback(input: {
  readonly plan: ProductionRenderEvidencePlan;
  readonly snapshot: FactSnapshot;
  readonly buildPatchInput: (finalized: readonly FinalizedUnit[]) => NativePatchbackInput;
  readonly reviewer: BuildLqaReviewer | undefined;
  readonly recordBuildLqaEvidence?: (evidence: readonly BuildLqaReviewEvidence[]) => void;
}): Pick<PatchbackDeps, "exportPatch" | "buildLqa"> {
  const producedByPatchId = new Map<string, StoredPatch>();
  return {
    async exportPatch(finalized) {
      const buildRoot = ownedBuildRoot(input.plan.buildRoot);
      const patchInput = input.buildPatchInput(finalized);
      const produced = produceNativePatchbackBuild(patchInput, {
        sourceRoot: input.plan.sourceRoot,
        buildRoot,
        scope: input.plan.patchScope,
        runId: input.plan.runId,
      });
      producedByPatchId.set(produced.patch.patchVersionId, {
        patch: produced.patch,
        input: patchInput,
        buildRoot,
      });
      return { patchId: produced.patch.patchVersionId };
    },
    async buildLqa(request) {
      const stored = producedByPatchId.get(request.patchId);
      if (stored === undefined) {
        throw new RenderEvidenceAdapterError(
          "missing-patch",
          "Build-LQA has no produced patched-byte manifest for this patch id",
        );
      }
      if (input.reviewer === undefined) {
        throw new RenderEvidenceAdapterError(
          "missing-patch",
          "Build-LQA has no installed Q5 reviewer binding",
        );
      }
      const accepted = acceptedForUnits(stored.input.accepted, request.unitIds);
      const render = await renderAndOcrPatchedBuild({
        snapshot: input.snapshot,
        patch: stored.patch,
        accepted,
        unitIds: request.unitIds,
        buildRoot: stored.buildRoot,
        runtimeAssetRoot: input.plan.sourceRoot,
        ...(input.plan.backgroundAsset === undefined
          ? {}
          : { backgroundAsset: input.plan.backgroundAsset }),
      });
      const defects = renderOcrGate(input.snapshot, accepted, render);
      if (defects.length > 0) {
        throw new RenderEvidenceAdapterError(
          "render-defects",
          `Build-LQA recorded ${String(defects.length)} deterministic render/OCR defect(s)`,
          defects,
        );
      }
      const receipts: BuildLqaReviewerReceipt[] = [];
      const verdicts = await input.reviewer({
        render,
        accepted,
        unitIds: request.unitIds,
        recordReceipt(receipt) {
          if (receipts.some((candidate) => candidate.unitId === receipt.unitId)) {
            throw new RenderEvidenceAdapterError(
              "reviewer-receipt",
              "Q5 reported more than one provider receipt for a Build-LQA unit",
            );
          }
          receipts.push(receipt);
        },
      });
      const evidence = buildLqaEvidence({
        patchId: stored.patch.patchVersionId,
        render,
        accepted,
        unitIds: request.unitIds,
        verdicts,
        receipts,
      });
      input.recordBuildLqaEvidence?.(evidence);
      return verdicts;
    },
  };
}

/** Capture actual runtime frames for a previously produced patch. Exported for
 * focused real-byte tests; it never accepts a frame, OCR string, or native-run
 * simulation from a caller. */
export async function renderAndOcrPatchedBuild(input: {
  readonly snapshot: FactSnapshot;
  readonly patch: ProducedPatchbackManifest;
  readonly accepted: readonly AcceptedUnitOutput[];
  readonly unitIds: readonly string[];
  readonly buildRoot: string;
  /** Game assets paired with the patch; selected engines decide how to consume
   * them, while all rendered script bytes remain in the verified patch. */
  readonly runtimeAssetRoot: string;
  readonly backgroundAsset?: string;
}): Promise<RenderAndOcrResult> {
  const accepted = acceptedForUnits(input.accepted, input.unitIds);
  const facts = new Map(input.snapshot.orderedUnits.map((fact) => [fact.factId, fact]));
  const launcher = createRuntimeLauncherRegistry();
  const frames = [];
  let patchedBytesHash: `sha256:${string}` | undefined;
  for (const [index, output] of accepted.entries()) {
    const fact = facts.get(output.subjectId);
    if (fact === undefined) {
      throw new RenderEvidenceAdapterError(
        "missing-patch",
        "a patch accepted output does not map to a snapshot fact",
      );
    }
    const captureRoot = mkdtempSync(join(input.buildRoot, "q5-runtime-frame-"));
    // The native public artifact root must begin empty. Keep reports in a
    // sibling scratch directory; the runtime removes their content after it
    // has verified the captured public frame.
    const reportRoot = mkdtempSync(join(input.buildRoot, "q5-runtime-reports-"));
    const captureId = sha256({
      patchId: input.patch.patchVersionId,
      unitId: output.subjectId,
      index,
    }).slice("sha256:".length, "sha256:".length + 24);
    const receipt = await launcher.launch({
      patch: {
        patchVersionId: input.patch.patchVersionId,
        status: "playable",
        artifactHashes: input.patch.artifactHashes,
        artifactRefs: input.patch.artifactRefs,
        runtimeAssets: input.patch.runtimeAssets,
      },
      request: {
        adapterId: input.patch.engineId,
        operation: "render-evidence",
        output: join(reportRoot, "render-receipt.json"),
        launchDescriptor: {
          [input.patch.engineId]: {
            sourceUnitKey: fact.sourceUnitKey,
            runtimeAssetRoot: input.runtimeAssetRoot,
            evidenceRoot: captureRoot,
            runId: `q5-${captureId}`,
            replayLogPath: join(reportRoot, "replay-receipt.json"),
            ...(input.backgroundAsset === undefined
              ? {}
              : { backgroundAsset: input.backgroundAsset }),
          },
        },
      },
    });
    if (receipt.operation !== "render-evidence") {
      throw new RenderEvidenceAdapterError(
        "runtime-receipt",
        "runtime launcher returned a non-render receipt for Build-LQA",
      );
    }
    const observed = receipt.adapterReceipt.frame;
    if (patchedBytesHash !== undefined && patchedBytesHash !== observed.patchedBytesHash) {
      throw new RenderEvidenceAdapterError(
        "runtime-receipt",
        "Build-LQA frames did not originate from one patched-byte surface",
      );
    }
    patchedBytesHash = observed.patchedBytesHash;
    const ocrMatches =
      normalizedOcr(observed.ocrText) === normalizedOcr(output.value.targetSkeleton);
    frames.push({
      frameId: `frame:${captureId}`,
      artifactUri: reviewerArtifactUri(observed.artifactUri),
      contentHash: observed.contentHash,
      expectedAcceptedOutputId: output.outputId,
      observedUnitIds: [output.subjectId],
      width: observed.width,
      height: observed.height,
      ocrText: observed.ocrText,
      observations: [
        observation("replay-coverage", observed.replayObserved ? "PASS" : "FAIL", output.subjectId),
        observation("layout", observed.pixelGateStatus, output.subjectId),
        observation("missing-glyph", observed.ocrStatus, output.subjectId),
        observation("charset", observed.ocrStatus, output.subjectId),
        observation(
          "ocr-mismatch",
          ocrMatches && observed.ocrStatus === "PASS" ? "PASS" : "FAIL",
          output.subjectId,
        ),
      ],
    });
  }
  if (patchedBytesHash === undefined) {
    throw new RenderEvidenceAdapterError(
      "runtime-receipt",
      "Build-LQA received no units to render",
    );
  }
  const requestHash = sha256({
    tool: "render_and_ocr",
    snapshotId: input.snapshot.snapshotId,
    patchVersionId: input.patch.patchVersionId,
    accepted: accepted.map((output) => ({
      outputId: output.outputId,
      targetHash: output.value.targetHash,
    })),
  });
  const resultBase = {
    schemaVersion: "itotori.tool.render-and-ocr-result.v1" as const,
    tool: "render_and_ocr" as const,
    snapshotId: input.snapshot.snapshotId,
    requestHash,
    patchedBytesHash,
    frames,
  };
  const renderedBytes = Buffer.byteLength(canonicalJson(resultBase), "utf8");
  return RenderAndOcrResultSchema.parse({
    ...resultBase,
    resultHash: sha256(resultBase),
    page: {
      kind: "complete",
      requestCursor: null,
      returnedRows: frames.length,
      returnedBytes: renderedBytes,
      maxRows: 100_000,
      maxBytes: Math.max(renderedBytes, 1),
      nextCursor: null,
    },
  });
}

function ownedBuildRoot(configuredRoot: string): string {
  const root = resolve(configuredRoot);
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "itotori-q5-build-"));
}

function acceptedForUnits(
  accepted: readonly AcceptedUnitOutput[],
  unitIds: readonly string[],
): readonly AcceptedUnitOutput[] {
  const byUnit = new Map(accepted.map((output) => [output.subjectId, output]));
  const duplicate = new Set<string>();
  for (const unitId of unitIds) {
    if (duplicate.has(unitId)) {
      throw new RenderEvidenceAdapterError(
        "missing-patch",
        "Build-LQA requested a unit more than once",
      );
    }
    duplicate.add(unitId);
    if (!byUnit.has(unitId)) {
      throw new RenderEvidenceAdapterError(
        "missing-patch",
        "Build-LQA requested a unit absent from the produced accepted outputs",
      );
    }
  }
  const selected: AcceptedUnitOutput[] = [];
  for (const unitId of unitIds) {
    const output = byUnit.get(unitId);
    if (output === undefined) {
      throw new RenderEvidenceAdapterError(
        "missing-patch",
        "Build-LQA requested a unit absent from the produced accepted outputs",
      );
    }
    selected.push(output);
  }
  return selected;
}

function normalizedOcr(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t\n]+/gu, " ")
    .trim();
}

function reviewerArtifactUri(managedUri: string): string {
  const segments = managedUri.split("/").map(encodeURIComponent).join("/");
  return `runtime://utsushi/${segments}`;
}

function observation(
  kind: "replay-coverage" | "layout" | "missing-glyph" | "charset" | "ocr-mismatch",
  status: "PASS" | "FAIL",
  unitId: string,
) {
  return {
    observationId: `observation:${kind}:${sha256({ kind, status, unitId }).slice("sha256:".length, "sha256:".length + 24)}`,
    kind,
    status,
    unitId,
    detail:
      status === "PASS"
        ? `${kind} observation passed on the captured frame`
        : `${kind} observation failed on the captured frame`,
  } as const;
}

function buildLqaEvidence(input: {
  readonly patchId: string;
  readonly render: RenderAndOcrResult;
  readonly accepted: readonly AcceptedUnitOutput[];
  readonly unitIds: readonly string[];
  readonly verdicts: readonly LaneVerdict[];
  readonly receipts: readonly BuildLqaReviewerReceipt[];
}): readonly BuildLqaReviewEvidence[] {
  return input.unitIds.map((unitId) => {
    const accepted = input.accepted.find((candidate) => candidate.subjectId === unitId);
    const receipt = input.receipts.find((candidate) => candidate.unitId === unitId);
    const verdict = input.verdicts.find(
      (candidate) =>
        candidate.lane === "Q5" &&
        candidate.verdict.unitId === unitId &&
        candidate.verdict.roleId === "Q5" &&
        candidate.verdict.rubric === "build-lqa" &&
        candidate.verdict.verdict === "PASS",
    );
    if (accepted === undefined || receipt === undefined || verdict === undefined) {
      throw new RenderEvidenceAdapterError(
        "reviewer-receipt",
        "Q5 did not return exact PASS and provider-receipt coverage for a Build-LQA unit",
      );
    }
    if (receipt.reviewId !== verdict.verdict.reviewId) {
      throw new RenderEvidenceAdapterError(
        "reviewer-receipt",
        "Q5 provider receipt does not match its Build-LQA verdict",
      );
    }
    const frames = input.render.frames.filter(
      (frame) =>
        frame.expectedAcceptedOutputId === accepted.outputId &&
        frame.observedUnitIds.includes(unitId),
    );
    const frame = frames[0];
    if (frames.length !== 1 || frame === undefined) {
      throw new RenderEvidenceAdapterError(
        "reviewer-receipt",
        "Q5 cannot seal Build-LQA without one exact captured frame",
      );
    }
    return {
      unitId,
      patchId: input.patchId,
      renderResultHash: input.render.resultHash,
      patchedBytesHash: input.render.patchedBytesHash,
      frameId: frame.frameId,
      frameContentHash: frame.contentHash,
      reviewId: receipt.reviewId,
      memoKey: receipt.memoKey,
    };
  });
}
