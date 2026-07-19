// The A5 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A5 is a model-calling role. This module builds the certified A5 call spec
// (roleId A5, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam that constructs an
// OpenRouter-backed adapter. It NAMES no provider (the certified profile carries
// the ZDR + automatic-fallback policy) and owns no retries. A5 holds NO web-egress
// grant, so its spec carries ZERO tools in every run — there is no shape in which
// it offers web_search. The returned voice draft is UNTRUSTED: assembly re-proves
// every counterpart, the occurrence window, the play-order ranges, and every
// citation before an object is accepted.
//
// The public dispatch entry asserts the certified deepseek-v4-flash route in EVERY
// run mode — including test-dev — as an independent guard over the profile
// certification `dispatch()` performs, so an offline proof can never route a forged
// spec.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  assertNoProviderPin,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type WikiObject,
} from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import { specialistFor } from "../../roster/index.js";
import type { ReadModel } from "../../read-tools/index.js";

import { arcPositionClaimId, counterpartClaimId } from "./ids.js";
import {
  A5RoleError,
  A5_ROLE_ID,
  A5_VOICE_PROFILE_KIND,
  type A5ArcPositionDraft,
  type A5Context,
  type A5CounterpartDraft,
  type A5VoiceDraft,
  type A5VoiceRequest,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A5.prompt.v2";

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

/**
 * Assert a spec is the certified A5 route, in EVERY run mode. Independent of the
 * profile-certification `dispatch()` performs (which relaxes under test-dev), this
 * guard runs at the public entry so no run — offline proofs included — can drive a
 * spec that names a provider, drops ZDR, offers a tool, or drifts off the certified
 * deepseek-v4-flash model.
 */
export function assertCertifiedRoute(spec: CallSpec): void {
  const specialist = specialistFor(A5_ROLE_ID);
  const reject = (detail: string): never => {
    throw new A5RoleError("route-not-certified", detail);
  };
  if (spec.roleId !== A5_ROLE_ID) reject(`spec roleId ${spec.roleId} is not ${A5_ROLE_ID}`);
  if (spec.requestedModel !== deepSeekV4FlashProfile.model) {
    reject(`spec model ${spec.requestedModel} is not the certified route`);
  }
  if (spec.modelProfileVersion !== deepSeekV4FlashProfile.version) {
    reject("spec model profile version is not the certified route");
  }
  if (spec.modelProfile !== specialist.modelProfile) reject("spec model profile tier drifted");
  if (!spec.providerPolicy.zdr) reject("spec provider policy is not ZDR");
  assertNoProviderPin(spec.providerPolicy);
  if (spec.output.name !== "wiki-object") reject("spec terminal is not a wiki-object");
  if (spec.tools.length !== 0) reject("A5 holds no tool grant; its spec must carry zero tools");
}

/** Render the source-facts prompt the model reasons over. The character label, the
 * real counterpart ids, the routes, and the ordered occurrence-unit ids are stated
 * as FACTS; the model authors register prose and cites those ids, never re-deriving
 * play order or route membership. */
function renderPrompt(request: A5VoiceRequest): string {
  const specialist = specialistFor(A5_ROLE_ID);
  const evidence = request.evidence;
  return [
    specialist.instructions,
    `Output kind: voice-profile. Source language: ${request.sourceLanguage}. Author in the SOURCE LANGUAGE.`,
    `Character ${evidence.characterId} — decoded label is a FACT: ${evidence.decodedLabel}.`,
    `Real counterpart ids (address only these): ${request.counterpartIds.join(", ")}`,
    `Routes the character occurs on: ${request.routeIds.join(", ")}`,
    "Occurrence-unit evidence ids (in play order; cite these to back each rule):",
    ...request.occurrenceUnitIds.map((id) => `  ${id}`),
  ].join("\n");
}

/** Build the certified A5 call spec for one character's voice profile, plus the
 * prompt payload the runtime must resolve. The route is the certified deepseek-v4-
 * flash profile — no provider is named, and no tool is offered. */
export function buildA5CallSpec(
  model: ReadModel,
  context: A5Context,
  request: A5VoiceRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A5_ROLE_ID);
  const evidence = request.evidence;
  const promptText = renderPrompt(request);
  const prompt = sealPrompt(`a5:voice:${evidence.characterId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A5_ROLE_ID,
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

/** Drive one A5 spec through the sole dispatch boundary, asserting the certified
 * route first (every mode), then layering the prompt payloads over the runtime's
 * payload reader. */
export async function dispatchA5(
  spec: CallSpec,
  prompts: readonly SealedPrompt[],
  runtime: DispatchRuntime,
): Promise<CallResult> {
  assertCertifiedRoute(spec);
  const byRef = new Map(prompts.map((prompt) => [prompt.ref.storageRef, prompt.text]));
  return dispatch(spec, {
    ...runtime,
    readPayload: async (reference) => {
      const local = byRef.get(reference.storageRef);
      return local === undefined ? runtime.readPayload(reference) : local;
    },
  });
}

/** Map a returned voice-profile WikiObject into an untrusted draft; the assembly
 * re-resolves every counterpart and RE-STAMPS every play-order range. Arc from/to
 * play orders are carried only as the model's asserted (ignored) re-timing. */
function voiceDraft(object: WikiObject): A5VoiceDraft {
  if (object.kind !== A5_VOICE_PROFILE_KIND) {
    throw new A5RoleError("dispatch-failed", "A5 draft returned an unexpected object kind");
  }
  const body = object.body;
  const citationsOf = (claimId: string): readonly string[] => {
    const claim = object.claims.find((candidate) => candidate.claimId === claimId);
    return claim ? claim.citations.map((citation) => citation.evidenceId) : [];
  };
  const counterparts: A5CounterpartDraft[] = body.perCounterpart.map((rule, ordinal) => ({
    counterpartId: rule.counterpartId,
    addressForm: rule.addressForm,
    registerDelta: rule.registerDelta,
    scope: rule.scope,
    evidenceId: citationsOf(counterpartClaimId(body.characterId, ordinal))[0] ?? rule.counterpartId,
  }));
  const arcPositions: A5ArcPositionDraft[] = body.perArcPosition.map((rule, ordinal) => {
    const citations = citationsOf(arcPositionClaimId(body.characterId, ordinal));
    return {
      scope: rule.scope,
      register: rule.register,
      note: rule.note,
      fromEvidenceId: citations[0] ?? rule.evidenceId,
      toEvidenceId: citations[citations.length - 1] ?? rule.evidenceId,
      assertedFromPlayOrder: rule.fromPlayOrder,
      assertedToPlayOrder: rule.toPlayOrder,
    };
  });
  return {
    base: { pronoun: body.base.pronoun, register: body.base.register, tics: body.base.tics },
    counterparts,
    arcPositions,
  };
}

/**
 * The production A5 model caller: assert the certified route, dispatch one voice-
 * profile draft through the ZDR boundary, and map it into an untrusted draft the
 * assembly then validates.
 */
export function dispatchingA5Caller(
  model: ReadModel,
  context: A5Context,
  runtime: DispatchRuntime,
): (request: A5VoiceRequest) => Promise<A5VoiceDraft> {
  return async (request) => {
    const { spec, prompts } = buildA5CallSpec(model, context, request);
    assertCertifiedRoute(spec);
    const result = await dispatchA5(spec, prompts, runtime);
    if (result.status !== "success") {
      throw new A5RoleError("dispatch-failed", `A5 voice call failed: ${result.failureKind}`);
    }
    return voiceDraft(result.value as WikiObject);
  };
}
