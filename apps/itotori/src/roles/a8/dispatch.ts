// The A8 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A8 is a model-calling role. This module builds the certified A8 call spec
// (roleId A8, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam that constructs an
// OpenRouter-backed adapter. It NAMES no provider (the certified profile carries
// the ZDR + automatic-fallback policy) and owns no retries. A8 holds NO web-
// egress grant, so its spec carries ZERO tools in every run — there is no shape
// in which it offers web_search. The returned background draft is UNTRUSTED:
// assembly re-verifies the bio, the counterparts, the establishing scenes, and
// every citation before an object is accepted.
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

import { a8Caller } from "./characters.js";
import { buildSceneReachabilityIndex, type SceneReachability } from "./scenes.js";
import {
  A8RoleError,
  A8_CHARACTER_BACKGROUND_KIND,
  A8_ROLE_ID,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
  type A8ModelCaller,
  type A8RelationshipDraft,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A8.prompt.v1";

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
 * Assert a spec is the certified A8 route, in EVERY run mode. Independent of the
 * profile-certification `dispatch()` performs (which relaxes under test-dev),
 * this guard runs at the public entry so no run — offline proofs included — can
 * drive a spec that names a provider, drops ZDR, offers a tool, or drifts off the
 * certified deepseek-v4-flash model.
 */
export function assertCertifiedRoute(spec: CallSpec): void {
  const specialist = specialistFor(A8_ROLE_ID);
  const reject = (detail: string): never => {
    throw new A8RoleError("route-not-certified", detail);
  };
  if (spec.roleId !== A8_ROLE_ID) reject(`spec roleId ${spec.roleId} is not ${A8_ROLE_ID}`);
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
  if (spec.tools.length !== 0) reject("A8 holds no tool grant; its spec must carry zero tools");
}

function sceneLine(scene: SceneReachability): string {
  const routes =
    scene.routeScope.kind === "global"
      ? "global"
      : scene.routeScope.kind === "route"
        ? `route ${scene.routeScope.routeId}`
        : `routes [${scene.routeScope.routeIds.join(", ")}]`;
  return `  ${scene.evidenceId} (reachable=${scene.reachable}, ${routes})`;
}

/** Render the source-facts prompt the model reasons over. The character label,
 * the verified bio's story role, the real counterpart ids, and the reachable
 * establishing-scene evidence ids are stated as FACTS; the model compresses
 * meaning and cites scene evidence ids, never re-deriving topology. */
function renderPrompt(model: ReadModel, context: A8Context, request: A8BackgroundRequest): string {
  const specialist = specialistFor(A8_ROLE_ID);
  const character = request.character;
  const bioStoryRole = request.bio.kind === "character-bio" ? request.bio.body.storyRole : "";
  const scenes = [...buildSceneReachabilityIndex(model, a8Caller(context)).values()].filter(
    (scene) => scene.reachable,
  );
  return [
    specialist.instructions,
    `Output kind: character-background. Source language: ${request.sourceLanguage}. Author in the SOURCE LANGUAGE.`,
    `Character ${character.characterId} — decoded label is a FACT: ${character.decodedLabel}.`,
    bioStoryRole ? `Upstream bio story role: ${bioStoryRole}` : "",
    "Real counterpart ids (relate only to these):",
    ...request.counterpartIds.map((id) => `  ${id}`),
    "Establishing-scene evidence ids (cite only reachable scenes on the relationship's route):",
    ...scenes.map(sceneLine),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Build the certified A8 call spec for one character background, plus the prompt
 * payload the runtime must resolve. The route is the certified deepseek-v4-flash
 * profile — no provider is named, and no tool is offered. */
export function buildA8CallSpec(
  model: ReadModel,
  context: A8Context,
  request: A8BackgroundRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A8_ROLE_ID);
  const promptText = renderPrompt(model, context, request);
  const prompt = sealPrompt(`a8:background:${request.character.characterId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A8_ROLE_ID,
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

/** Drive one A8 spec through the sole dispatch boundary, asserting the certified
 * route first (every mode), then layering the prompt payloads over the runtime's
 * payload reader. */
export async function dispatchA8(
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

/** Map a returned draft background WikiObject into an untrusted draft; the
 * assembly re-resolves counterparts, scenes, scope, and citations. */
function backgroundDraft(object: WikiObject): A8BackgroundDraft {
  if (object.kind !== A8_CHARACTER_BACKGROUND_KIND) {
    throw new A8RoleError("dispatch-failed", "A8 draft returned an unexpected object kind");
  }
  const relationships: A8RelationshipDraft[] = object.body.relationships.map((relationship) => ({
    counterpartId: relationship.counterpartId,
    relationship: relationship.relationship,
    confidence: "medium",
    scope: relationship.scope,
    establishingSceneIds: [...relationship.establishingEvidenceIds],
  }));
  return { background: object.body.background, relationships };
}

/**
 * The production A8 model caller: assert the certified route, dispatch one
 * character-background draft through the ZDR boundary, and map it into an
 * untrusted draft the assembly then validates.
 */
export function dispatchingA8Caller(
  model: ReadModel,
  context: A8Context,
  runtime: DispatchRuntime,
): A8ModelCaller {
  return async (request) => {
    const { spec, prompts } = buildA8CallSpec(model, context, request);
    assertCertifiedRoute(spec);
    const result = await dispatchA8(spec, prompts, runtime);
    if (result.status !== "success") {
      throw new A8RoleError("dispatch-failed", `A8 background call failed: ${result.failureKind}`);
    }
    return backgroundDraft(result.value as WikiObject);
  };
}
