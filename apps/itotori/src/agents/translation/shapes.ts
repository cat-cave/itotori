// ITOTORI-075 — Translation agent shapes.
//
// `TranslationAgent.invokeTranslation` takes a draft job + its source
// bridge units + glossary + style guide + per-bridge protected-span
// catalog and asks an LLM translation agent to produce a strict
// `StructuredTranslationDraftOutput`. The wire shape lives in
// `@itotori/localization-bridge-schema` (translation-draft.ts).
//
// Persistence of accepted drafts is intentionally deferred to a
// downstream node (ITOTORI-076 will thread results into the
// `draft_jobs` repository delivered by ITOTORI-074); this module
// supplies a pure-TS fixture factory in
// `translation-payload-fixtures.ts` so consumers can assemble
// realistic draft shapes before the table is fully wired.

import type {
  ProtectedSpanRef,
  TranslationDraft,
  TranslationDraftConfidenceFloor,
} from "@itotori/localization-bridge-schema";
import type {
  ProviderFamily,
  ProviderRunIdentity,
  ProviderRunRecord,
} from "../../providers/types.js";
import type { Bcp47Locale, Uuid7 } from "../../batch-planner/shapes.js";

export const TRANSLATION_PROMPT_TEMPLATE_VERSION_V1 = "itotori-translation-agent-v1";
export const TRANSLATION_DEFAULT_STRUCTURED_OUTPUT_NAME =
  "itotori-structured-translation-draft-output";

export type TranslationModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

/**
 * Minimal bridge-unit projection the translation agent receives. We
 * intentionally do NOT lean on the full `LocalizationUnitV02` type
 * from the schema package because the agent only needs the surface
 * text + the bridge id + the source-hash for provenance. Callers
 * project from whichever bridge representation they hold.
 */
export type TranslationBridgeUnit = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string | undefined;
};

export type TranslationGlossaryEntry = {
  termId: Uuid7;
  preferredSourceForm: string;
  preferredTargetForm?: string | undefined;
  policyAction?: "localize" | "romanize" | "do_not_translate" | undefined;
};

export type TranslationStyleGuideRule = {
  ruleId: string;
  section: "tone" | "terminology" | "honorifics" | "formatting" | "protectedSpans";
  guidance: string;
};

/**
 * A protected span the agent MUST preserve byte-equal in the draft.
 * The agent's response references each span by its `refId`; the
 * invocation service then validates the (refId, startInDraft,
 * endInDraft) triple against the source-side span catalog and the
 * preservation policy.
 *
 * Kept minimal: callers project from the full
 * `BridgeSpanV02` (schema package) or the legacy `ProtectedSpan`
 * shape. The agent never needs the source byte range — only the
 * literal text it must keep intact.
 */
export type TranslationProtectedSpanInput = {
  refId: string;
  /** The literal source text the agent must preserve in the draft. */
  sourceText: string;
};

/**
 * Strictly-typed input to `TranslationAgent.invokeTranslation`. The
 * `draftJobId` references the row owned by ITOTORI-074; the
 * `draftJobAttemptId` distinguishes retry attempts so diagnostic
 * errors can name the specific attempt.
 */
export type TranslationInvocationInput = {
  draftJobId: Uuid7;
  draftJobAttemptId: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  sourceBridgeUnits: ReadonlyArray<TranslationBridgeUnit>;
  /**
   * Catalog of protected spans, keyed by bridgeUnitId. EACH span MUST
   * appear in the agent's response for the corresponding draft; the
   * invocation service throws `TranslationProtectedSpanViolationError`
   * otherwise.
   */
  protectedSpansBySource: ReadonlyMap<Uuid7, ReadonlyArray<TranslationProtectedSpanInput>>;
  glossary: ReadonlyArray<TranslationGlossaryEntry>;
  styleGuide: ReadonlyArray<TranslationStyleGuideRule>;
  /**
   * Context artifact ids the agent is permitted to cite via
   * `TranslationDraft.citationRefs`. Glossary `termId`s are also
   * permitted citations and need not be repeated here.
   */
  contextArtifactRefs?: ReadonlyArray<string>;
  modelProfile: TranslationModelProfile;
  promptTemplateVersion: string;
  now?: (() => Date) | undefined;
};

/**
 * Full result surface returned by `invokeTranslation`.
 * `recordedArtifactId` is populated when the request was satisfied
 * by `RecordedModelProvider`; `providerRunId` is the live provider's
 * run id otherwise. Callers (and downstream persistence) get a
 * single typed object that always names which proof persisted the
 * drafts.
 */
export type TranslationInvocationResult = {
  drafts: TranslationDraft[];
  providerRunId: string;
  recordedArtifactId?: string;
  promptHashUsed: string;
  modelMetadata: TranslationInvocationModelMetadata;
  tokensIn: number;
  tokensOut: number;
};

export type TranslationInvocationModelMetadata = {
  modelProfile: TranslationModelProfile;
  providerIdentity: ProviderRunIdentity;
  providerRun: ProviderRunRecord;
};

// ---------------------------------------------------------------------------
// Typed errors. The service NEVER returns silent fallbacks — every recovery
// path goes through one of these.
// ---------------------------------------------------------------------------

/** Provider does not declare structured-output support. */
export class TranslationProviderCapabilityError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly providerFamily: ProviderFamily,
    public readonly detail: string,
  ) {
    super(
      `Translation agent refused: provider ${providerName} (family=${providerFamily}) does not support structured output (${detail})`,
    );
    this.name = "TranslationProviderCapabilityError";
  }
}

/** Empty input — the agent never invokes the provider in this case. */
export class TranslationEmptyInputError extends Error {
  constructor(
    public readonly draftJobId: string,
    public readonly draftJobAttemptId: string,
  ) {
    super(
      `Translation agent refused: draft job ${draftJobId} attempt ${draftJobAttemptId} has no source units to translate`,
    );
    this.name = "TranslationEmptyInputError";
  }
}

/** Source / target locale invariants. */
export class TranslationLocaleMismatchError extends Error {
  constructor(
    public readonly field: "sourceLocale" | "targetLocale",
    public readonly observed: string,
    public readonly detail: string,
  ) {
    super(`Translation agent refused: ${field} '${observed}' is invalid (${detail})`);
    this.name = "TranslationLocaleMismatchError";
  }
}

/**
 * Provider returned a structurally-incomplete response — empty
 * content, or a `finishReason` indicating a stop before the parser
 * could even read JSON. Distinct from
 * `TranslationDraftResponseValidationError` (which means the
 * response was decodable JSON but failed schema validation).
 */
export class TranslationPartialResultError extends Error {
  constructor(
    public readonly providerRunId: string,
    public readonly draftJobAttemptId: string,
    public readonly finishReason: string,
    public readonly detail: string,
  ) {
    super(
      `Translation agent refused: provider run ${providerRunId} (attempt ${draftJobAttemptId}) returned a partial result (finishReason=${finishReason}): ${detail}`,
    );
    this.name = "TranslationPartialResultError";
  }
}

/**
 * The agent omitted, duplicated, mislocated, or mutated a protected
 * span that the caller required. Names the specific bridgeUnitId +
 * span refId + reason for diagnostics.
 *
 * `reason` is a closed-enum tag so downstream triage can branch on
 * the specific failure mode without parsing free-text.
 */
export type TranslationProtectedSpanViolationReason =
  | "missing_ref"
  | "unknown_ref"
  | "duplicate_ref"
  | "out_of_bounds"
  | "invalid_range"
  | "overlapping_ref"
  | "preservation_mismatch";

export class TranslationProtectedSpanViolationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly spanRefId: string,
    public readonly reason: TranslationProtectedSpanViolationReason,
    public readonly detail: string,
  ) {
    super(
      `Translation agent refused: bridge unit ${bridgeUnitId} protected span '${spanRefId}' violated preservation policy (${reason}): ${detail}`,
    );
    this.name = "TranslationProtectedSpanViolationError";
  }
}

/**
 * A `TranslationDraft.bridgeUnitId` does not match any source
 * bridge unit in the caller-supplied input. Catches drift between
 * recorded bundle and input.
 */
export class TranslationUnknownBridgeUnitError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly draftJobAttemptId: string,
  ) {
    super(
      `Translation agent refused: draft cites unknown bridge unit ${bridgeUnitId} (attempt ${draftJobAttemptId})`,
    );
    this.name = "TranslationUnknownBridgeUnitError";
  }
}

/**
 * A `TranslationDraft.citationRefs` entry does not resolve to any
 * glossary `termId` or `contextArtifactRefs` member. Forces every
 * draft citation to be traceable.
 */
export class TranslationUnknownCitationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly citationRef: string,
    public readonly draftJobAttemptId: string,
  ) {
    super(
      `Translation agent refused: draft for bridge unit ${bridgeUnitId} cites unknown reference '${citationRef}' (attempt ${draftJobAttemptId})`,
    );
    this.name = "TranslationUnknownCitationError";
  }
}

// Re-export the wire enum so consumers can stay on one import path.
export type { ProtectedSpanRef, TranslationDraft, TranslationDraftConfidenceFloor };
