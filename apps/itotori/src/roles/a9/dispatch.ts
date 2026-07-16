// The A9 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A9 is a model-calling role. This module builds the certified A9 call spec
// (roleId A9, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam that constructs an
// OpenRouter-backed adapter. It NAMES no provider (the certified profile carries
// the ZDR + automatic-fallback policy) and owns no retries. A9 holds NO web-
// egress grant, so its spec carries ZERO tools in every run — there is no shape
// in which it offers web_search. The returned arc draft is UNTRUSTED: assembly
// re-proves the pair, the occurrence window, the play-order ranges, and every
// citation before an object is accepted.
//
// The public dispatch entry asserts the certified deepseek-v4-flash route in
// EVERY run mode — including test-dev — as an independent guard over the profile
// certification `dispatch()` performs, so an offline proof can never route a
// forged spec.

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

import {
  A9RoleError,
  A9_CHARACTER_ROUTE_ARC_KIND,
  A9_ROLE_ID,
  type A9ArcDraft,
  type A9ArcRequest,
  type A9Context,
  type A9ShiftDraft,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A9.prompt.v1";

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
 * Assert a spec is the certified A9 route, in EVERY run mode. Independent of the
 * profile-certification `dispatch()` performs (which relaxes under test-dev),
 * this guard runs at the public entry so no run — offline proofs included — can
 * drive a spec that names a provider, drops ZDR, offers a tool, or drifts off the
 * certified deepseek-v4-flash model.
 */
export function assertCertifiedRoute(spec: CallSpec): void {
  const specialist = specialistFor(A9_ROLE_ID);
  const reject = (detail: string): never => {
    throw new A9RoleError("route-not-certified", detail);
  };
  if (spec.roleId !== A9_ROLE_ID) reject(`spec roleId ${spec.roleId} is not ${A9_ROLE_ID}`);
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
  if (spec.tools.length !== 0) reject("A9 holds no tool grant; its spec must carry zero tools");
}

/** Render the source-facts prompt the model reasons over. The character label,
 * the route, and the ordered occurrence-unit evidence ids are stated as FACTS;
 * the model compresses meaning into state shifts and cites window unit ids, never
 * re-deriving play order or route membership. */
function renderPrompt(request: A9ArcRequest): string {
  const specialist = specialistFor(A9_ROLE_ID);
  const evidence = request.evidence;
  return [
    specialist.instructions,
    `Output kind: character-route-arc. Source language: ${request.sourceLanguage}. Author in the SOURCE LANGUAGE.`,
    `Character ${evidence.characterId} — decoded label is a FACT: ${evidence.decodedLabel}.`,
    `Route ${evidence.routeId} — this arc is scoped to this route ONLY.`,
    "Occurrence-unit evidence ids (in play order; bound each state shift by two of these):",
    ...request.windowUnitIds.map((id) => `  ${id}`),
  ].join("\n");
}

/** Build the certified A9 call spec for one character-route arc, plus the prompt
 * payload the runtime must resolve. The route is the certified deepseek-v4-flash
 * profile — no provider is named, and no tool is offered. */
export function buildA9CallSpec(
  model: ReadModel,
  context: A9Context,
  request: A9ArcRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A9_ROLE_ID);
  const evidence = request.evidence;
  const promptText = renderPrompt(request);
  const prompt = sealPrompt(`a9:arc:${evidence.characterId}:${evidence.routeId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A9_ROLE_ID,
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

/** Drive one A9 spec through the sole dispatch boundary, asserting the certified
 * route first (every mode), then layering the prompt payloads over the runtime's
 * payload reader. */
export async function dispatchA9(
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

/** Map a returned draft arc WikiObject into an untrusted draft; the assembly re-
 * resolves the bounding units and RE-STAMPS every play-order range. The returned
 * from/to play orders are carried only as the model's asserted (ignored) re-timing. */
function arcDraft(object: WikiObject): A9ArcDraft {
  if (object.kind !== A9_CHARACTER_ROUTE_ARC_KIND) {
    throw new A9RoleError("dispatch-failed", "A9 draft returned an unexpected object kind");
  }
  const shifts: A9ShiftDraft[] = object.body.shifts.map((shift) => ({
    stateBefore: shift.stateBefore,
    stateAfter: shift.stateAfter,
    fromEvidenceId: shift.evidenceIds[0]!,
    toEvidenceId: shift.evidenceIds[shift.evidenceIds.length - 1]!,
    assertedFromPlayOrder: shift.fromPlayOrder,
    assertedToPlayOrder: shift.toPlayOrder,
  }));
  return { shifts };
}

/**
 * The production A9 model caller: assert the certified route, dispatch one
 * character-route-arc draft through the ZDR boundary, and map it into an untrusted
 * draft the assembly then validates.
 */
export function dispatchingA9Caller(
  model: ReadModel,
  context: A9Context,
  runtime: DispatchRuntime,
): (request: A9ArcRequest) => Promise<A9ArcDraft> {
  return async (request) => {
    const { spec, prompts } = buildA9CallSpec(model, context, request);
    assertCertifiedRoute(spec);
    const result = await dispatchA9(spec, prompts, runtime);
    if (result.status !== "success") {
      throw new A9RoleError("dispatch-failed", `A9 arc call failed: ${result.failureKind}`);
    }
    return arcDraft(result.value as WikiObject);
  };
}
