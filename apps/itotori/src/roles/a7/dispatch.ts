// The A7 model boundary — dispatch deepseek-v4-flash through the SOLE ZDR
// dispatch boundary.
//
// A7 is a model-calling role. This module builds the certified A7 call spec
// (roleId A7, purpose analysis, the reasoning profile, a wiki-object terminal)
// and drives it through `dispatch()` — the one production seam that constructs an
// OpenRouter-backed adapter. It NAMES no provider (the certified profile carries
// the ZDR + automatic-fallback policy) and owns no retries. The web_search tool
// is offered ONLY when the operator has opened the egress boundary; local-only
// runs carry no tools at all. The returned bio draft is UNTRUSTED: assembly
// re-derives every citation from the index before an object is accepted.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WEB_SEARCH_RESULT_SCHEMA_VERSION,
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
  A7RoleError,
  A7_CHARACTER_BIO_KIND,
  A7_ROLE_ID,
  citeableCharacterUnits,
  type A7BioDraft,
  type A7CharacterRequest,
  type A7ClaimDraft,
  type A7Context,
  type A7ModelCaller,
} from "./types.js";

// v2: prompt cites units by a short [uN] label the flash model can copy
// verbatim, replacing the uuid-based fact ids it could not transcribe.
const PROMPT_VERSION = "itotori.role.A7.prompt.v2";
const WEB_SEARCH_IMPLEMENTATION_VERSION = "itotori.role.A7.web-search.v1";
const WEB_SEARCH_ARGS_SCHEMA_VERSION = "itotori.tool.web-search-args.v1";

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

/** The web_search tool contract A7 offers when egress is open. The contract gate
 * independently binds web_search to A7, so a non-A7 spec carrying it is rejected. */
function webSearchToolContract(): CallSpec["tools"][number] {
  return {
    name: "web_search",
    input: {
      name: "web-search-args",
      schemaVersion: WEB_SEARCH_ARGS_SCHEMA_VERSION,
      schemaHash: sha256(WEB_SEARCH_ARGS_SCHEMA_VERSION),
    },
    output: {
      name: "web-search-result",
      schemaVersion: WEB_SEARCH_RESULT_SCHEMA_VERSION,
      schemaHash: sha256(WEB_SEARCH_RESULT_SCHEMA_VERSION),
    },
    implementationVersion: WEB_SEARCH_IMPLEMENTATION_VERSION,
  };
}

/** Render the source-facts prompt the model reasons over. The decoded label and
 * whole-game unit count are stated as FACTS; each unit is shown by a short [uN]
 * label the model can copy verbatim. The model is asked to compress meaning and
 * cite those labels, never to re-derive the character set or transcribe a raw
 * unit id. */
function renderPrompt(request: A7CharacterRequest): string {
  const specialist = specialistFor(A7_ROLE_ID);
  const character = request.character;
  const egress = request.webEnabled
    ? "Web egress is OPEN: web claims are separate, capped at medium, and can never override a same-game fact."
    : "Web egress is CLOSED: author from same-game evidence only.";
  return [
    specialist.instructions,
    `Output kind: character-bio. Source language: ${request.sourceLanguage}. Author in the SOURCE LANGUAGE.`,
    `Character ${character.characterId} — decoded label is a FACT: ${character.decodedLabel}. ` +
      `The character speaks in ${character.notableUnitIds.length} whole-game unit(s); cite every claim and ` +
      `every notable moment using the short [uN] label shown for its unit, exactly as written — never a unit id.`,
    egress,
    "Whole-game units:",
    ...citeableCharacterUnits(character).map(({ label }) => `  [${label}]`),
  ].join("\n");
}

/** Build the certified A7 call spec for one character bio, plus the prompt
 * payload the runtime must resolve. The route is the certified deepseek-v4-flash
 * profile — no provider is named. */
export function buildA7CallSpec(
  model: ReadModel,
  context: A7Context,
  request: A7CharacterRequest,
): { spec: CallSpec; prompts: readonly SealedPrompt[] } {
  const specialist = specialistFor(A7_ROLE_ID);
  const promptText = renderPrompt(request);
  const prompt = sealPrompt(`a7:bio:${request.character.characterId}`, promptText);
  const eventId = sha256(promptText);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: A7_ROLE_ID,
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    parentEventId: eventId,
    contextSnapshotId: model.snapshotId,
    localizationSnapshotId: null,
    messages: [{ kind: "text", eventId, role: "user", contentEncrypted: prompt.ref }],
    tools: request.webEnabled ? [webSearchToolContract()] : [],
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

/** Drive one A7 spec through the sole dispatch boundary, layering the prompt
 * payloads over the runtime's payload reader. */
export async function dispatchA7(
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

/** Map a returned draft bio WikiObject's claims into untrusted claim drafts; the
 * assembly re-resolves the citations against the index. */
function claimDrafts(object: WikiObject): A7ClaimDraft[] {
  return object.claims.map((claim) => ({
    statement: claim.statement,
    confidence: claim.confidence,
    evidenceIds: claim.citations.map((citation) => citation.evidenceId),
  }));
}

/**
 * The production A7 model caller: dispatch one character-bio draft through the
 * ZDR boundary and map it into an untrusted draft the assembly then validates.
 */
export function dispatchingA7Caller(
  model: ReadModel,
  context: A7Context,
  runtime: DispatchRuntime,
): A7ModelCaller {
  return async (request) => {
    const { spec, prompts } = buildA7CallSpec(model, context, request);
    const result = await dispatchA7(spec, prompts, runtime);
    if (result.status !== "success") {
      throw new A7RoleError("dispatch-failed", `A7 bio call failed: ${result.failureKind}`);
    }
    const object = result.value as WikiObject;
    if (object.kind !== A7_CHARACTER_BIO_KIND) {
      throw new A7RoleError("dispatch-failed", "A7 draft returned an unexpected object kind");
    }
    const body = object.body;
    const draft: A7BioDraft = {
      storyRole: body.storyRole,
      definingTraits: [...body.definingTraits],
      notableMomentEvidenceIds: [...body.notableMomentEvidenceIds],
      claims: claimDrafts(object),
    };
    return draft;
  };
}
