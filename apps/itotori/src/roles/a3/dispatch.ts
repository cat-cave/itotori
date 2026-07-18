// The A3 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A3 is a model-calling role. This module builds the certified A3 call spec
// (roleId A3, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam that constructs an
// OpenRouter-backed adapter. It NAMES no provider (the certified profile carries
// the ZDR + automatic-fallback policy), owns no retries, and reads its scene
// facts deterministically before the call. The returned scene-summary /
// story-so-far draft is UNTRUSTED: the fold re-derives every citation and
// structural fact from the index before an object is accepted.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
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
  A3RoleError,
  A3_ROLE_ID,
  A3_SCENE_SUMMARY_KIND,
  A3_STORY_SO_FAR_KIND,
  type A3ClaimDraft,
  type A3Context,
  type A3ModelCaller,
  type A3SceneNarrative,
  type A3SceneRequest,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A3.prompt.v1";

/** A prompt payload paired with its content-addressed reference, so the runtime
 * can resolve the encrypted ref back to its exact plaintext. */
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

/** Render the source-facts prompt the model reasons over. The complete scene,
 * the deterministic counts/speakers, and the prior story-so-far are stated as
 * FACTS; the model is asked only to compress meaning, never to re-count. */
function renderPrompt(request: A3SceneRequest, kind: string): string {
  const specialist = specialistFor(A3_ROLE_ID);
  const scene = request.scene;
  const lines = scene.units.map(
    (unit) =>
      `  [${unit.value.playOrderIndex}] ${unit.value.speaker?.revealSafeLabel ?? "(narration)"}: ${unit.value.sourceSurface}`,
  );
  const prior = request.priorStory
    ? `Prior story-so-far (through scene ${request.priorStory.throughSceneId}): ${request.priorStory.summary}`
    : "Prior story-so-far: (this is the first scene on the route).";
  return [
    specialist.instructions,
    `Output kind: ${kind}. Source language: ${request.sourceLanguage}. Author in the SOURCE LANGUAGE.`,
    `Scene ${scene.sceneId} — decoded counts are FACTS: ${scene.factCard.messageCount} messages, ` +
      `${scene.factCard.choiceCount} choices, speakers: [${scene.speakerLabels.join(", ")}]. ` +
      `Do not re-count or re-attribute; cite every claim using the bracketed [N] label shown for its unit (the playOrderIndex), never a unit id.`,
    prior,
    "Complete scene stream:",
    ...lines,
  ].join("\n");
}

/** Build the certified A3 call spec for one terminal wiki-object, plus the
 * prompt payload the runtime must resolve. The route is the certified
 * deepseek-v4-flash profile — no provider is named. */
export function buildA3CallSpec(
  model: ReadModel,
  context: A3Context,
  request: A3SceneRequest,
  kind: string,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A3_ROLE_ID);
  const promptText = renderPrompt(request, kind);
  const prompt = sealPrompt(`a3:${kind}:scene-${request.scene.sceneId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A3_ROLE_ID,
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

/** Drive one A3 spec through the sole dispatch boundary, layering the prompt
 * payloads over the runtime's payload reader. */
export async function dispatchA3(
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

/** Map a returned draft WikiObject's claims back into untrusted claim drafts
 * (statement + cited bracketed play-order labels); the fold re-resolves them. */
function claimDrafts(object: WikiObject, kind: A3ClaimDraft["kind"]): A3ClaimDraft[] {
  return object.claims.map((claim) => ({
    statement: claim.statement,
    kind,
    confidence: claim.confidence,
    evidenceUnitIds: claim.citations.map((citation) => citation.evidenceId),
  }));
}

async function dispatchObject(
  model: ReadModel,
  context: A3Context,
  request: A3SceneRequest,
  kind: string,
  runtime: DispatchRuntime,
): Promise<WikiObject> {
  const { spec, prompts } = buildA3CallSpec(model, context, request, kind);
  const result = await dispatchA3(spec, prompts, runtime);
  if (result.status !== "success") {
    throw new A3RoleError("dispatch-failed", `A3 ${kind} call failed: ${result.failureKind}`);
  }
  return result.value as WikiObject;
}

/**
 * The production A3 model caller: dispatch the scene-summary and story-so-far
 * drafts through the ZDR boundary and merge them into an untrusted narrative the
 * fold then validates. Two terminal objects require two dispatches.
 */
export function dispatchingA3Caller(
  model: ReadModel,
  context: A3Context,
  runtime: DispatchRuntime,
): A3ModelCaller {
  return async (request) => {
    const summary = await dispatchObject(model, context, request, A3_SCENE_SUMMARY_KIND, runtime);
    const story = await dispatchObject(model, context, request, A3_STORY_SO_FAR_KIND, runtime);
    const summaryBody = summary.kind === A3_SCENE_SUMMARY_KIND ? summary.body : null;
    const storyBody = story.kind === A3_STORY_SO_FAR_KIND ? story.body : null;
    if (!summaryBody || !storyBody) {
      throw new A3RoleError("dispatch-failed", "A3 draft returned an unexpected object kind");
    }
    const narrative: A3SceneNarrative = {
      beat: summaryBody.beat,
      subtext: summaryBody.subtext,
      sceneOpenThreads: summaryBody.openThreads,
      sceneClaims: claimDrafts(summary, "beat"),
      storySummary: storyBody.summary,
      storyOpenThreads: storyBody.openThreads,
      storyClaims: claimDrafts(story, "story-so-far"),
    };
    return narrative;
  };
}
