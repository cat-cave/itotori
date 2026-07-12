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
import type { StructuredContextInjection } from "../structure-informed-context/shapes.js";

export const TRANSLATION_PROMPT_TEMPLATE_VERSION_V1 = "itotori-translation-agent-v1";
export const TRANSLATION_DEFAULT_STRUCTURED_OUTPUT_NAME =
  "itotori-structured-translation-draft-output";

export type TranslationModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  /**
   * ITOTORI-220 — required (modelId, providerId) pair. Names the specific
   * upstream provider the agent must be pinned to; surfaced into the
   * `ModelInvocationRequest.providerId` field on every call.
   */
  providerId: string;
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

export type TranslationScopeContextProvenance = "inherited" | "override";

/**
 * Per-work continuity context resolved by the multi-work scope graph. This is
 * deliberately game-agnostic: callers hand the translation agent the effective
 * work scope (shared context inherited, per-work overrides already applied),
 * and the prompt renders it as drafting context without knowing how the work
 * was carved out of an archive.
 */
export type TranslationWorkScopeContext = {
  workId: string;
  glossary: ReadonlyArray<{
    termId: string;
    sourceForm: string;
    targetForm: string;
    policyAction?: "localize" | "romanize" | "do_not_translate" | undefined;
    provenance: TranslationScopeContextProvenance;
  }>;
  characters: ReadonlyArray<{
    characterId: string;
    displayName: string;
    voiceNote?: string | undefined;
    provenance: TranslationScopeContextProvenance;
  }>;
};

/**
 * durable-journal — prior-pass feedback threaded into the translation
 * prompt so a pass N+1 draft BUILDS ON pass N's accepted state / flagged
 * units instead of re-running from scratch. Strictly project-agnostic: the
 * journal records whatever the prior localization pass surfaced for this unit
 * (the written draft, informational quality flags, and any free-form feedback
 * note a play tester / QA finding emitted); the prompt
 * template renders it verbatim into a dedicated "Prior pass feedback" block.
 *
 * The shape carries no game / engine / title fields — the multi-pass loop is
 * generic over any project whose units flow through the agentic loop.
 */
export type PriorPassFeedback = {
  /** 1-based number of the prior localization pass this feedback came from. */
  passNumber: number;
  /**
   * The non-blank target draft the prior pass wrote for this unit. Every
   * written outcome carries one, so pass N+1 always has a baseline to improve
   * on rather than a blank or source-repetition fallback.
   */
  priorDraftText: string;
  /** Informational QA/repair flags retained with the written outcome. */
  qualityFlags: string[];
  /**
   * Free-form feedback note carried from the prior pass — a reviewer
   * correction, a QA-finding recommendation, or any project-agnostic hint the
   * ledger recorded. Rendered verbatim into the prompt so pass N+1 addresses
   * the SAME flagged issue rather than rediscovering it.
   */
  feedbackNote?: string;
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
 * One resolved context artifact supplied to the translation agent with
 * REAL body content (node 6 context brain). Cite `contextArtifactId`
 * verbatim in `citationRefs`.
 */
export type TranslationContextArtifact = {
  contextArtifactId: string;
  category: string;
  title: string;
  body: string;
  /** Content-hash / version identity for the resolved artifact. */
  contentHash?: string;
  data?: Record<string, unknown>;
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
   * Resolved context artifacts with REAL body content the agent may consult
   * and cite via `TranslationDraft.citationRefs` (cite `contextArtifactId`
   * verbatim). Glossary `termId`s are also permitted citations. The prompt
   * renders each artifact's title + body — never bare id lists. Empty /
   * omitted means no enrichment content for this unit.
   */
  contextArtifacts?: ReadonlyArray<TranslationContextArtifact>;
  /**
   * itotori-structure-informed-context-building — the structurally-grounded
   * context injected from the Kaifuu/Utsushi decode: the scene summary, the
   * slice's position in the route/branch map, and the speakers' character
   * arcs. Built by
   * `agents/structure-informed-context` (a deterministic reduction of the
   * decode, NOT an LLM guess). When present the prompt template renders a
   * dedicated "Structure-informed context" block; when ABSENT the prompt is
   * byte-identical to the pre-feature template (the no-structure baseline).
   * Structure artifact ids should also appear in `contextArtifacts` so the
   * agent may cite them with their resolved content.
   */
  structuredContext?: StructuredContextInjection | undefined;
  /**
   * itotori-crosswork-context-injection — the effective multi-work scope for
   * this unit: shared glossary/characters/style continuity inherited from the
   * parent work collection with any per-work overrides already resolved. When
   * present the prompt renders a dedicated continuity block; when absent the
   * prompt remains byte-identical to the pre-feature path.
   */
  workScopeContext?: TranslationWorkScopeContext | undefined;
  /**
   * durable-journal — prior-pass feedback for this unit, threaded from the
   * localization journal so a pass N+1 draft consumes pass N's accepted
   * state + flagged-unit feedback as drafting context. When present the prompt
   * template renders a strictly-additive "Prior pass feedback" block; when
   * ABSENT the prompt is byte-identical to the pre-feature template (the
   * no-prior-pass baseline), so recorded fixtures keyed by prompt hash stay
   * stable. Generic over any project — the field carries no game-specific data.
   */
  priorPassFeedback?: PriorPassFeedback | undefined;
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
  retryProviderRuns: ProviderRunRecord[];
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
 * glossary `termId` or `contextArtifacts[].contextArtifactId` member.
 * Forces every draft citation to be traceable.
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
