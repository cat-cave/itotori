// A1 Style Lead — the model-calling analyst role, end to end.
//
// runStyleLead composes the prompt, assembles the strict A1 CallSpec, dispatches
// it through the sole ZDR dispatch boundary (the injected `dispatch`), and returns
// a CITED source-language style-contract WikiObject whose every claim the claim-validation gate has
// re-proven against the immutable snapshot. It records the actually-served
// (model, provider) pair (the model is certified deepseek-v4-flash; the
// provider is recorded telemetry, never a pinned input). The reusable abstract
// style artifact is derived separately (see ./abstract-style.ts).

import {
  WikiObjectSchema,
  type CallResult,
  type CallSpec,
  type WikiObject,
} from "../../contracts/index.js";
import type { dispatch, DispatchRuntime } from "../../llm/dispatch.js";
import { deepSeekV4FlashProfile, servedModelIsCertified } from "../../llm/role-model-profiles.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";
import type { ReadModel } from "../../read-tools/index.js";
import {
  assembleStyleLeadCallSpec,
  composeStyleLeadPrompt,
  type StyleLeadRequest,
  type StylePromptStore,
} from "./spec.js";

export class StyleLeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StyleLeadError";
  }
}

/** The model seam: it takes A1's strict CallSpec and returns the dispatch result.
 * Production binds the real dispatcher; the offline proof binds a recorded
 * result. The port is the ONLY place a model is reached. */
export type StyleLeadModelPort = (spec: CallSpec) => Promise<CallResult>;

/** Production binding: route A1's CallSpec through the real dispatcher.
 * No provider is chosen here — the spec's certified profile does the routing. */
export function dispatchStyleLeadModel(
  dispatcher: typeof dispatch,
  runtime: DispatchRuntime,
): StyleLeadModelPort {
  return (spec) => dispatcher(spec, runtime);
}

/** Offline / recorded binding: replay a captured success result. The recorded
 * value must itself be a style-contract WikiObject — the memo cannot smuggle a
 * different terminal kind past A1. */
export function recordedStyleLeadModel(result: CallResult): StyleLeadModelPort {
  return async () => result;
}

export interface StyleLeadDeps {
  readonly model: StyleLeadModelPort;
  readonly storePrompt: StylePromptStore;
  /** The immutable snapshot A1's claims are re-proven against by the claim-validation gate. */
  readonly validationModel: ReadModel;
}

export interface StyleLeadResult {
  readonly styleContract: WikiObject;
  readonly spec: CallSpec;
  readonly served: { readonly model: string; readonly provider: string };
}

/**
 * Run A1 once for a game. Emits a cited source-language style-contract
 * WikiObject or throws a loud {@link StyleLeadError}: a non-success result, a
 * non-style-contract terminal, a wrong served model, a target-language object,
 * or any claim that fails claim validation is a hard failure — never a silent
 * pass.
 */
export async function runStyleLead(
  request: StyleLeadRequest,
  deps: StyleLeadDeps,
): Promise<StyleLeadResult> {
  const prompt = composeStyleLeadPrompt(request);
  const systemRef = await deps.storePrompt(prompt.system, "system");
  const userRef = await deps.storePrompt(prompt.user, "user");
  const spec = assembleStyleLeadCallSpec(request, { systemRef, userRef });

  const result = await deps.model(spec);
  if (result.status !== "success") {
    throw new StyleLeadError(`A1 dispatch did not succeed: ${result.status}/${result.failureKind}`);
  }
  // The served MODEL must be the certified deepseek-v4-flash; the served
  // PROVIDER is recorded telemetry, whatever compliant provider OpenRouter used.
  if (!servedModelIsCertified(result.served.model, deepSeekV4FlashProfile.model)) {
    throw new StyleLeadError(
      `A1 was served ${result.served.model}, not ${deepSeekV4FlashProfile.model}`,
    );
  }

  const parsed = WikiObjectSchema.safeParse(result.value);
  if (!parsed.success || parsed.data.kind !== "style-contract") {
    throw new StyleLeadError("A1 terminal output is not a style-contract WikiObject");
  }
  const object = parsed.data;
  if (object.lang !== request.sourceLanguage) {
    throw new StyleLeadError(
      `A1 must emit a ${request.sourceLanguage} source contract, not ${object.lang}`,
    );
  }
  if (object.provenance.contextSnapshotId !== request.contextSnapshotId) {
    throw new StyleLeadError("A1 contract is not pinned to the requested context snapshot");
  }

  // Claim validation: every claim must re-prove against the immutable snapshot. A
  // fabricated citation throws a ClaimValidationError here — A1 never ships one.
  validateWikiObjectClaims(object, deps.validationModel);

  return {
    styleContract: object,
    spec,
    served: { model: result.served.model, provider: result.served.provider },
  };
}
