// The P1 agentic dispatch boundary.
//
// P1's read tools have already materialized exact context before this call. The
// provider sees an immutable source/bible/thread projection and returns a strict
// translation WikiObject draft; the P1 runner treats only its `draftBatch` body
// as untrusted content and re-seals the persisted object itself.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  assertNoProviderPin,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type WikiObject,
} from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import { specialistFor } from "../../roster/index.js";

import {
  P1RoleError,
  P1_ROLE_ID,
  type P1Context,
  type P1ModelCaller,
  type P1SegmentRequest,
} from "./agent-types.js";

interface SealedPrompt {
  readonly ref: EncryptedPayloadRef;
  readonly text: string;
}

export interface P1AgentCall {
  readonly spec: CallSpec;
  readonly prompts: readonly SealedPrompt[];
}

function sealPrompt(storageRef: string, text: string): SealedPrompt {
  return {
    text,
    ref: { storageRef, contentHash: sha256(text), encryption: "operator-managed" },
  };
}

function promptUnitIds(request: P1SegmentRequest): readonly string[] {
  return request.segment.mode === "whole-scene"
    ? request.segment.unitIds
    : request.segment.promptUnitIds;
}

function coreIds(request: P1SegmentRequest): ReadonlySet<string> {
  return new Set(
    request.segment.mode === "whole-scene" ? request.segment.unitIds : request.segment.coreUnitIds,
  );
}

function renderPrompt(request: P1SegmentRequest): string {
  const specialist = specialistFor(P1_ROLE_ID);
  const core = coreIds(request);
  const source = promptUnitIds(request).map((unitId) => {
    const unit = request.unitsById.get(unitId);
    if (!unit) throw new P1RoleError("dispatch-failed", `missing prompt source ${unitId}`);
    return {
      unitId,
      role: core.has(unitId) ? "core" : "overlap-context",
      sourceHash: unit.sourceHash,
      sourceSkeleton: unit.sourceSkeleton,
      protectedPlaceholders: unit.protectedPlaceholders,
    };
  });
  const acceptedTargetThread = promptUnitIds(request).flatMap((unitId) => {
    const targetSkeleton = request.priorAcceptedTarget.get(unitId);
    return targetSkeleton === undefined ? [] : [{ unitId, targetSkeleton }];
  });
  return [
    specialist.instructions,
    "The source skeletons, source hashes, protected placeholders, scope, and core/overlap designation below are deterministic facts. They override any contrary hypothesis.",
    "Return a translation WikiObject draft. Its body.draftBatch must contain ONLY this segment's core, in the exact listed order. Every draft must use the exact localized-bible rendering ids and type uncertainty.",
    JSON.stringify({
      kind: "p1-localizer-seed",
      segment: request.segment,
      source,
      localizedBible: request.scene.bibleEntries.map((entry) => ({
        renderingId: entry.renderingId,
        sourceObjectId: entry.sourceObjectId,
        sourceObjectKind: entry.sourceObjectKind,
        body: entry.body,
      })),
      glossary: request.scene.glossaryEntries,
      acceptedTargetThread,
    }),
  ].join("\n");
}

/** Build P1's certified draft call for one planned segment. No provider is named;
 * the role references the roster's RB-019 profile key and its ZDR policy. */
export function buildP1AgentCall(
  modelSnapshotId: `sha256:${string}`,
  localizationSnapshotId: `sha256:${string}`,
  context: P1Context,
  request: P1SegmentRequest,
): P1AgentCall {
  const specialist = specialistFor(P1_ROLE_ID);
  const text = renderPrompt(request);
  const prompt = sealPrompt(
    `p1:translation:${request.scene.sceneId}:${
      request.segment.mode === "whole-scene" ? "whole" : request.segment.chunkIndex
    }`,
    text,
  );
  const eventId = sha256({
    snapshot: modelSnapshotId,
    localizationSnapshotId,
    segment: request.segment,
  });
  return {
    spec: {
      schemaVersion: CALL_SPEC_SCHEMA_VERSION,
      purpose: "draft",
      roleId: P1_ROLE_ID,
      modelProfile: specialist.modelProfile,
      modelProfileVersion: deepSeekV4FlashProfile.version,
      requestedModel: deepSeekV4FlashProfile.model,
      providerPolicy: deepSeekV4FlashProfile.providerPolicy,
      parentEventId: eventId,
      contextSnapshotId: modelSnapshotId,
      localizationSnapshotId,
      messages: [{ kind: "text", eventId, role: "user", contentEncrypted: prompt.ref }],
      tools: [],
      output: {
        name: "wiki-object",
        schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
        schemaHash: sha256(WIKI_OBJECT_SCHEMA_VERSION),
      },
      promptVersion: specialist.version,
      reasoning: specialist.reasoning,
      sampling: { temperature: 0, topP: 1, seed: null },
      limits: { ...specialist.limits, maxSteps: 2, maxToolCalls: 0, maxParallelTools: 1 },
      sampleId: null,
      runMode: context.runMode,
      contextScope: context.contextScope,
    },
    prompts: [prompt],
  };
}

/** P1 rejects a model/profile/provider drift before the transport in every run
 * mode, including the recorded test-dev path. */
export function assertP1AgentCertifiedRoute(spec: CallSpec): void {
  const specialist = specialistFor(P1_ROLE_ID);
  const expected = {
    roleId: P1_ROLE_ID,
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
  };
  const actual = {
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new P1RoleError(
      "dispatch-failed",
      "P1 route is not the certified deepseek-v4-flash route",
    );
  }
  assertNoProviderPin(spec.providerPolicy);
}

/** Dispatch a P1 call through the sole ZDR boundary, resolving only the prompt
 * payload P1 sealed. */
export async function dispatchP1Agent(
  call: P1AgentCall,
  runtime: DispatchRuntime,
): Promise<CallResult> {
  assertP1AgentCertifiedRoute(call.spec);
  const prompts = new Map(call.prompts.map((prompt) => [prompt.ref.storageRef, prompt.text]));
  return await dispatch(call.spec, {
    ...runtime,
    readPayload: async (reference) => {
      const text = prompts.get(reference.storageRef);
      return text === undefined ? runtime.readPayload(reference) : text;
    },
  });
}

/** The production P1 caller. Its terminal object is parsed as a WikiObject, but
 * runner assembly still discards model-authored claims/provenance/dependencies. */
export function dispatchingP1ModelCaller(
  modelSnapshotId: `sha256:${string}`,
  localizationSnapshotId: `sha256:${string}`,
  context: P1Context,
  runtime: DispatchRuntime,
): P1ModelCaller {
  return async (request) => {
    const call = buildP1AgentCall(modelSnapshotId, localizationSnapshotId, context, request);
    const result = await dispatchP1Agent(call, runtime);
    if (result.status !== "success") {
      throw new P1RoleError("dispatch-failed", `P1 segment call failed: ${result.failureKind}`);
    }
    const object = result.value as WikiObject;
    if (object.kind !== "translation") {
      throw new P1RoleError(
        "unexpected-output",
        "P1 draft did not return a translation WikiObject",
      );
    }
    return object;
  };
}
