// The Terminology Analyst — the model-calling analyst role, end to end.
//
// runTermAnalyst composes the prompt, assembles the strict CallSpec, dispatches
// it through the sole ZDR dispatch boundary (the injected `dispatch`), and
// returns a CITED, SOURCE-LANGUAGE term ruling whose meaning / register / source
// scope / confidence the model authored but whose alias/occurrence ENUMERATION
// is copied verbatim from the byte-derived index. It records the actually-served
// (model, provider) pair (the model is certified deepseek-v4-flash; the provider
// is recorded telemetry, never a pinned input). A ruling for an unambiguous
// term, an object with a re-counted enumeration, a ghost-occurrence citation, a
// target-language object, or any unprovable claim is a HARD failure — never a
// silent pass.

import { WikiObjectSchema, type CallResult, type CallSpec } from "../../contracts/index.js";
import type { dispatch, DispatchRuntime } from "../../llm/dispatch.js";
import { deepSeekV4FlashProfile, servedModelIsCertified } from "../../llm/role-model-profiles.js";
import type { ReadModel } from "../../read-tools/index.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import {
  assertByteDerivedTermEnumeration,
  assertOccurrenceCitationsByteDerived,
  type AmbiguousTermCandidate,
  type TermRulingObject,
} from "./candidates.js";
import {
  assembleTermAnalystCallSpec,
  composeTermAnalystPrompt,
  type TermAnalystRequest,
  type TermPromptStore,
} from "./spec.js";

export class TermAnalystError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermAnalystError";
  }
}

/** The model seam: it takes the strict CallSpec and returns the dispatch result.
 * Production binds the real dispatcher; the offline proof binds a recorded
 * result. The port is the ONLY place a model is reached. */
export type TermAnalystModelPort = (spec: CallSpec) => Promise<CallResult>;

/** Production binding: route the CallSpec through the real dispatcher. No
 * provider is chosen here — the spec's certified profile does the routing. */
export function dispatchTermAnalystModel(
  dispatcher: typeof dispatch,
  runtime: DispatchRuntime,
): TermAnalystModelPort {
  return (spec) => dispatcher(spec, runtime);
}

/** Offline / recorded binding: replay a captured success result. The recorded
 * value must itself be a term-ruling WikiObject — the memo cannot smuggle a
 * different terminal kind past the analyst. */
export function recordedTermAnalystModel(result: CallResult): TermAnalystModelPort {
  return async () => result;
}

export interface TermAnalystDeps {
  readonly model: TermAnalystModelPort;
  readonly storePrompt: TermPromptStore;
  /** The immutable snapshot the ruling's claims and occurrences are proven
   * against — its byte-derived ordered units back the occurrence check. */
  readonly validationModel: ReadModel;
}

/** The byte-derived enumeration, surfaced authoritatively on the result so a
 * downstream consumer reads the index's counts, never the model's. */
export interface TermRulingEnumeration {
  readonly termKey: string;
  readonly aliases: readonly string[];
  readonly occurrenceCount: number;
  readonly occurrenceUnitKeys: readonly string[];
}

export interface TermAnalystResult {
  readonly termRuling: TermRulingObject;
  readonly spec: CallSpec;
  readonly served: CallResult["served"];
  readonly enumeration: TermRulingEnumeration;
}

function byteDerivedEnumeration(candidate: AmbiguousTermCandidate): TermRulingEnumeration {
  return {
    termKey: candidate.termKey,
    aliases: candidate.aliases,
    occurrenceCount: candidate.occurrenceCount,
    occurrenceUnitKeys: candidate.occurrenceUnitKeys,
  };
}

/**
 * Run the analyst once for ONE ambiguous candidate. Emits a cited source-language
 * term ruling or throws a loud {@link TermAnalystError} / enumeration error: a
 * non-success result, a non-term-ruling terminal, a wrong served model, a
 * target-language object, a re-counted enumeration, a ghost-occurrence citation,
 * or any unprovable claim is a hard failure.
 */
export async function runTermAnalyst(
  request: TermAnalystRequest,
  deps: TermAnalystDeps,
): Promise<TermAnalystResult> {
  const prompt = composeTermAnalystPrompt(request);
  const systemRef = await deps.storePrompt(prompt.system, "system");
  const userRef = await deps.storePrompt(prompt.user, "user");
  const spec = assembleTermAnalystCallSpec(request, { systemRef, userRef });

  const result = await deps.model(spec);
  if (result.status !== "success") {
    throw new TermAnalystError(
      `terminology dispatch did not succeed: ${result.status}/${result.failureKind}`,
    );
  }
  // Unknown served metadata is explicitly accepted while the upstream TanStack
  // event surface is incomplete. A reported pair must still match the profile.
  if (
    result.served.status === "confirmed" &&
    !servedModelIsCertified(result.served.model, deepSeekV4FlashProfile.model)
  ) {
    throw new TermAnalystError(
      `terminology analyst was served ${result.served.model}, not ${deepSeekV4FlashProfile.model}`,
    );
  }

  const parsed = WikiObjectSchema.safeParse(result.value);
  if (!parsed.success || parsed.data.kind !== "term-ruling") {
    throw new TermAnalystError("terminal output is not a term-ruling WikiObject");
  }
  const ruling = parsed.data;
  if (ruling.lang !== request.sourceLanguage) {
    throw new TermAnalystError(
      `analyst must emit a ${request.sourceLanguage} source ruling, not ${ruling.lang}`,
    );
  }
  // Provenance identifiers are SYSTEM-stamped in the wiki-build runner before the
  // object is accepted (the model cannot reliably author the snapshot hash).

  // The enumeration is byte-derived: an alias re-count or a ghost occurrence is
  // ignored/rejected here, never folded into the ruling as if it were fact.
  assertByteDerivedTermEnumeration(ruling, request.candidate);
  assertOccurrenceCitationsByteDerived(
    ruling,
    request.candidate,
    deps.validationModel.factSnapshot,
  );

  // Claim validation: every claim must re-prove against the immutable snapshot. A
  // fabricated citation throws a ClaimValidationError here — never shipped.
  validateWikiObjectClaims(ruling, deps.validationModel);

  return {
    termRuling: ruling,
    spec,
    served: result.served,
    enumeration: byteDerivedEnumeration(request.candidate),
  };
}
