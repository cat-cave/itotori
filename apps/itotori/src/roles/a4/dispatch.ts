// The A4 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A4 is a model-calling role. This module builds the certified A4 call spec
// (roleId A4, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through the one production dispatch seam. It NAMES no provider
// (the certified profile carries the ZDR + automatic-fallback policy), owns no
// retries, and adopts the spine deterministically before the call. The returned
// route-arc draft is UNTRUSTED: the reconciler re-resolves every endpoint, re-
// stamps every timeline, and re-derives the reveal order from the decode before
// an object is accepted.

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
  A4RoleError,
  A4_ROLE_ID,
  A4_ROUTE_ARC_KIND,
  type A4ArcDraft,
  type A4Context,
  type A4DeltaDraft,
  type A4LinkDraft,
  type A4ModelCaller,
  type A4ReconcileRequest,
} from "./types.js";

const PROMPT_VERSION = "itotori.role.A4.prompt.v1";

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

/** Render the source-facts prompt the model reasons over. The adopted spine and
 * the DETERMINISTIC covered scenes are stated as FACTS; the model is asked only
 * to reconcile continuity and pair endpoints, never to re-derive the topology. */
function renderPrompt(request: A4ReconcileRequest): string {
  const specialist = specialistFor(A4_ROLE_ID);
  const spine = request.spine.finalStorySoFar;
  const spineSummary = spine.kind === "story-so-far" ? spine.body.summary : "";
  return [
    specialist.instructions,
    `Output kind: ${A4_ROUTE_ARC_KIND}. Source language: ${request.sourceLanguage}. ` +
      `Author in the SOURCE LANGUAGE.`,
    `Adopt this final story-so-far as the route spine — do NOT reconstruct topology. ` +
      `Covered scenes (play order is a FACT): [${request.spine.coveredSceneIds.join(", ")}].`,
    `Spine summary: ${spineSummary}`,
    "Emit route-arc, callback, foreshadow, and relationship-delta claims. Every " +
      "callback and foreshadow must cite BOTH endpoints by unit id; every origin " +
      "must precede its use. Never invent a missing endpoint.",
  ].join("\n");
}

/** Build the certified A4 call spec for the route-arc terminal, plus the prompt
 * payload the runtime must resolve. The route is the certified deepseek-v4-flash
 * profile — no provider is named. */
export function buildA4CallSpec(
  model: ReadModel,
  context: A4Context,
  request: A4ReconcileRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A4_ROLE_ID);
  const promptText = renderPrompt(request);
  const prompt = sealPrompt(`a4:route-arc:${request.spine.finalStorySoFar.objectId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A4_ROLE_ID,
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

/** Drive one A4 spec through the sole dispatch boundary, layering the prompt
 * payloads over the runtime's payload reader. */
export async function dispatchA4(
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

/** Map a returned route-arc's callback / foreshadow body links into untrusted
 * link drafts (description + both endpoint ids); the reconciler re-resolves the
 * pairing and re-derives the reveal order. */
function linkDraftsFrom(
  links: readonly {
    description: string;
    originEvidenceId: string;
    destinationEvidenceId: string;
  }[],
): A4LinkDraft[] {
  return links.map((link) => ({
    description: link.description,
    originEvidenceId: link.originEvidenceId,
    destinationEvidenceId: link.destinationEvidenceId,
  }));
}

/** Map the returned relationship deltas into untrusted delta drafts. The delta's
 * bounding endpoints are read from its paired relationship claim's citations —
 * the reconciler then re-stamps the chronology from the decode. */
function deltaDraftsFrom(object: WikiObject): A4DeltaDraft[] {
  if (object.kind !== A4_ROUTE_ARC_KIND) return [];
  const relationshipClaims = object.claims.filter((claim) => claim.kind === "relationship");
  return object.body.relationshipDeltas.map((delta, ordinal) => {
    const citations = relationshipClaims[ordinal]?.citations ?? [];
    return {
      counterpartId: delta.counterpartId,
      before: delta.before,
      after: delta.after,
      fromEvidenceId: citations[0]?.evidenceId ?? "",
      toEvidenceId: citations[1]?.evidenceId ?? "",
    };
  });
}

async function dispatchRouteArc(
  model: ReadModel,
  context: A4Context,
  request: A4ReconcileRequest,
  runtime: DispatchRuntime,
): Promise<WikiObject> {
  const { spec, prompts } = buildA4CallSpec(model, context, request);
  const result = await dispatchA4(spec, prompts, runtime);
  if (result.status !== "success") {
    throw new A4RoleError("dispatch-failed", `A4 route-arc call failed: ${result.failureKind}`);
  }
  return result.value as WikiObject;
}

/**
 * The production A4 model caller: dispatch the route-arc draft through the ZDR
 * boundary and map it into an untrusted arc the reconciler then settles against
 * the decode. One terminal object, one dispatch.
 */
export function dispatchingA4Caller(
  model: ReadModel,
  context: A4Context,
  runtime: DispatchRuntime,
): A4ModelCaller {
  return async (request) => {
    const object = await dispatchRouteArc(model, context, request, runtime);
    if (object.kind !== A4_ROUTE_ARC_KIND) {
      throw new A4RoleError("dispatch-failed", "A4 draft returned an unexpected object kind");
    }
    const arc: A4ArcDraft = {
      arcSummary: object.body.arcSummary,
      callbacks: linkDraftsFrom(object.body.callbacks),
      foreshadows: linkDraftsFrom(object.body.foreshadows),
      relationshipDeltas: deltaDraftsFrom(object),
    };
    return arc;
  };
}
