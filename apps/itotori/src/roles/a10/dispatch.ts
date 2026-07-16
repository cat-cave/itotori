// The A10 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A10 is a model-calling role. This module builds the certified A10 call spec
// (roleId A10, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam. It NAMES no
// provider (the certified profile carries the ZDR + automatic-fallback policy)
// and owns no retries. The certified route is ASSERTED at the public dispatch
// entry in EVERY run mode — including test-dev — so a drifted route can never
// reach the transport, even offline. The returned hypothesis draft is UNTRUSTED:
// assembly re-resolves the candidate + reveal scene and re-cites from the index.

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
import type { ReadModel } from "../../read-tools/index.js";

import {
  A10RoleError,
  A10_ROLE_ID,
  A10_SPEAKER_HYPOTHESIS_KIND,
  type A10Context,
  type A10HypothesisDraft,
  type A10HypothesisRequest,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A10.prompt.v1";

/** A prompt payload paired with its content-addressed reference. */
interface SealedPrompt {
  readonly ref: EncryptedPayloadRef;
  readonly text: string;
}

function sealPrompt(storageRef: string, text: string): SealedPrompt {
  return {
    text,
    ref: { storageRef, contentHash: sha256(text), encryption: "operator-managed" },
  };
}

/** Render the source-facts prompt the model reasons over. The unknown-speaker
 * unit, its reveal-safe label, and the whole-game candidate + reveal-scene pools
 * are stated as FACTS; the model chooses WITHIN the pools and never invents an
 * id, and is reminded it emits a HYPOTHESIS, never a decoded speaker. */
function renderPrompt(request: A10HypothesisRequest): string {
  const specialist = specialistFor(A10_ROLE_ID);
  const unit = request.unit;
  return [
    specialist.instructions,
    `Output kind: ${A10_SPEAKER_HYPOTHESIS_KIND}. Source language: ${request.sourceLanguage}. ` +
      `Reason in the SOURCE LANGUAGE.`,
    `Unit ${unit.unitId} (scene ${unit.sceneId}) has an unresolved speaker ` +
      `(${unit.speakerStatus}); its reveal-safe label is "${unit.revealSafeLabel}".`,
    "Emit a HYPOTHESIS only: a candidate speaker, a confidence, and the reveal scene " +
      "where hindsight discloses the identity. You cannot assert the decoded speaker.",
    "Choose the candidate character id from this whole-game pool:",
    ...request.candidateCharacterIds.map((id) => `  ${id}`),
    "Choose the reveal scene id from this whole-game pool:",
    ...request.revealSceneIds.map((id) => `  ${id}`),
  ].join("\n");
}

/** Build the certified A10 call spec for one unit's speaker hypothesis, plus the
 * prompt payload the runtime must resolve. The route is the certified
 * deepseek-v4-flash profile — no provider is named. */
export function buildA10CallSpec(
  model: ReadModel,
  context: A10Context,
  request: A10HypothesisRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A10_ROLE_ID);
  const promptText = renderPrompt(request);
  const prompt = sealPrompt(`a10:speaker-hypothesis:${request.unit.unitId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A10_ROLE_ID,
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    parentEventId: eventId,
    contextSnapshotId: model.snapshotId,
    localizationSnapshotId: null,
    messages: [{ kind: "text", eventId, role: "user", contentEncrypted: prompt.ref }],
    tools: [],
    output: {
      name: "wiki-object",
      schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
      schemaHash: sha256(WIKI_OBJECT_SCHEMA_VERSION),
    },
    promptVersion: PROMPT_VERSION,
    reasoning: specialist.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: specialist.limits,
    sampleId: null,
    runMode: context.runMode,
    contextScope: context.contextScope,
  };
  return { spec, prompts: [prompt] };
}

/**
 * Assert the spec routes to A10's certified deepseek-v4-flash profile — the exact
 * model, the reasoning profile + version, and the ZDR + no-provider policy — in
 * EVERY run mode, test-dev included. Unlike the shared certified-route check, this
 * has no test-dev bypass: an offline proof that drifted the route would still be
 * caught here before it reached the transport.
 */
export function assertA10CertifiedRoute(spec: CallSpec): void {
  const specialist = specialistFor(A10_ROLE_ID);
  const certified = {
    roleId: A10_ROLE_ID,
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
  };
  const selected = {
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  if (canonicalJson(selected) !== canonicalJson(certified)) {
    throw new A10RoleError(
      "dispatch-failed",
      "A10 call route is not the certified deepseek-v4-flash route",
    );
  }
  if (!spec.providerPolicy.zdr) {
    throw new A10RoleError("dispatch-failed", "A10 call route is not ZDR-bound");
  }
  assertNoProviderPin(spec.providerPolicy);
}

/** Drive one A10 spec through the sole dispatch boundary, layering the prompt
 * payloads over the runtime's payload reader. */
export async function dispatchA10(
  spec: CallSpec,
  prompts: readonly SealedPrompt[],
  runtime: DispatchRuntime,
): Promise<CallResult> {
  const byRef = new Map(prompts.map((prompt) => [prompt.ref.storageRef, prompt.text]));
  return dispatch(spec, {
    ...runtime,
    readPayload: async (reference) => {
      const local = byRef.get(reference.storageRef);
      return local === undefined ? runtime.readPayload(reference) : local;
    },
  });
}

/**
 * The production A10 model caller: assert the certified route (every mode),
 * dispatch one speaker-hypothesis draft through the ZDR boundary, and map it into
 * an untrusted draft assembly then re-resolves and validates.
 */
export function dispatchingA10Caller(
  model: ReadModel,
  context: A10Context,
  runtime: DispatchRuntime,
): (request: A10HypothesisRequest) => Promise<A10HypothesisDraft> {
  return async (request) => {
    const { spec, prompts } = buildA10CallSpec(model, context, request);
    assertA10CertifiedRoute(spec);
    const result = await dispatchA10(spec, prompts, runtime);
    if (result.status !== "success") {
      throw new A10RoleError(
        "dispatch-failed",
        `A10 hypothesis call failed: ${result.failureKind}`,
      );
    }
    const object = result.value as WikiObject;
    if (object.kind !== A10_SPEAKER_HYPOTHESIS_KIND) {
      throw new A10RoleError("dispatch-failed", "A10 draft returned an unexpected object kind");
    }
    const body = object.body;
    return {
      candidateCharacterId: body.candidateCharacterId,
      confidence: body.confidence,
      revealSceneId: body.revealSceneId,
      rationale: object.claims[0]?.statement ?? "",
    };
  };
}
