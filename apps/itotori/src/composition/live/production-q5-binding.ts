// Production Q5 binding.
//
// The role receives a completed RenderAndOcrResult from the physical adapter;
// it has no launcher or renderer dependency of its own. The frame is projected
// through q5FrameFromRenderResult so the reviewer's only on-screen text channel
// remains the pixel OCR readback.

import type { EncryptedPayloadRef, LocalizedRendering } from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import { q5FrameFromRenderResult, runQ5Review } from "../../roles/q5/index.js";
import type { LaneVerdict } from "../../workflow/index.js";
import {
  createCertifiedDispatch,
  type DispatchRuntimeBase,
  type PayloadResolver,
} from "./dispatch-runtime.js";
import type { LiveWorkflowRoleBindingInput } from "./factory.js";
import { ProductionRoleBindingError } from "./production-role-support.js";
import type { BuildLqaReviewer } from "./render-evidence-adapter.js";

/** Bind Q5 after the snapshot-scoped facts, installed bible, and certified
 * dispatch runtime exist. Fresh accepted outputs and fresh frame IDs are added
 * to the same per-run evidence index used by the rest of the production roles. */
export function createProductionBuildLqaReviewer(input: {
  readonly binding: LiveWorkflowRoleBindingInput;
  readonly evidence: Map<string, string>;
  readonly sealPayload: (plaintext: string) => EncryptedPayloadRef;
  readonly readPayload: PayloadResolver;
}): BuildLqaReviewer {
  const bibleById = new Map<string, LocalizedRendering>();
  for (const rendering of input.binding.bible.renderings()) {
    bibleById.set(rendering.renderingId, rendering);
  }
  const dispatch = createCertifiedDispatch(q5Runtime(input.binding.runtime), input.readPayload);
  return async (request) =>
    await Promise.all(
      request.unitIds.map(async (unitId) => {
        const output = request.accepted.find((candidate) => candidate.subjectId === unitId);
        if (output === undefined) {
          throw new ProductionRoleBindingError(`Q5 has no accepted target for ${unitId}`);
        }
        const frame = exactFrame(request.render, unitId, output.outputId);
        registerEvidence(input.evidence, frame.frameId, `render-frame:${frame.contentHash}`);
        registerEvidence(input.evidence, output.outputId, output.value.targetSkeleton);
        const bibleRenderingIds = output.value.basis.bibleRenderingIds;
        if (output.value.basis.kind !== "wiki-first" || bibleRenderingIds.length === 0) {
          throw new ProductionRoleBindingError(
            `Q5 requires a wiki-first accepted target for ${unitId}`,
          );
        }
        const localizedBible = bibleRenderingIds.map((renderingId) => {
          const rendering = bibleById.get(renderingId);
          if (rendering === undefined) {
            throw new ProductionRoleBindingError(
              `Q5 target ${unitId} cites a missing localized bible rendering ${renderingId}`,
            );
          }
          return { renderingId, text: canonicalJson(rendering.body) };
        });
        const reviewInput = {
          unitId,
          localizationSnapshotId: input.binding.scope.localizationSnapshotId,
          frame,
          expectedTarget: output.value.targetSkeleton,
          bibleRenderingIds,
          localizedBible,
        };
        const visible = new Set<string>([frame.frameId, output.outputId, ...bibleRenderingIds]);
        const outcome = await runQ5Review(
          reviewInput,
          refsFor(input.binding, input.sealPayload, reviewInput),
          {
            dispatch,
            resolveEvidence: (evidenceId) => ({
              resolved: input.evidence.has(evidenceId),
              visible: visible.has(evidenceId),
            }),
          },
        );
        if (outcome.outcome !== "reviewed" || !outcome.canFinalize) {
          throw new ProductionRoleBindingError(`Q5 did not return a clean PASS for ${unitId}`);
        }
        const verdict = outcome.interpretation.verdict;
        if (verdict === null || verdict.verdict !== "PASS") {
          throw new ProductionRoleBindingError(`Q5 returned no finalizable verdict for ${unitId}`);
        }
        request.recordReceipt?.({
          unitId,
          reviewId: verdict.reviewId,
          memoKey: outcome.callResult.memoKey,
        });
        return { lane: "Q5" as const, verdict } satisfies LaneVerdict;
      }),
    );
}

function exactFrame(
  render: Parameters<BuildLqaReviewer>[0]["render"],
  unitId: string,
  acceptedOutputId: string,
) {
  const frames = render.frames.filter(
    (frame) =>
      frame.expectedAcceptedOutputId === acceptedOutputId && frame.observedUnitIds.includes(unitId),
  );
  const selected = frames[0];
  if (frames.length !== 1 || selected === undefined) {
    throw new ProductionRoleBindingError(`Q5 requires one exact captured frame for ${unitId}`);
  }
  return q5FrameFromRenderResult(render, selected.frameId);
}

function refsFor(
  binding: LiveWorkflowRoleBindingInput,
  sealPayload: (plaintext: string) => EncryptedPayloadRef,
  reviewInput: unknown,
) {
  return {
    parentEventId: sha256({
      stage: "build-lqa",
      role: "Q5",
      contextSnapshotId: binding.scope.contextSnapshotId,
      localizationSnapshotId: binding.scope.localizationSnapshotId,
      reviewInput,
    }),
    contextSnapshotId: binding.scope.contextSnapshotId,
    localizationSnapshotId: binding.scope.localizationSnapshotId,
    sealPayload,
    runMode: binding.scope.runMode,
  };
}

function q5Runtime(runtime: DispatchRuntimeBase): DispatchRuntimeBase {
  const profile = resolveRoleModelProfile("Q5");
  return {
    ...runtime,
    memo: {
      ...runtime.memo,
      profile: { ...runtime.memo.profile, name: profile.modelProfile, version: profile.version },
    },
  };
}

function registerEvidence(evidence: Map<string, string>, evidenceId: string, text: string): void {
  const prior = evidence.get(evidenceId);
  if (prior !== undefined && prior !== text) {
    throw new ProductionRoleBindingError(`Q5 evidence ${evidenceId} resolves to conflicting data`);
  }
  evidence.set(evidenceId, text);
}
