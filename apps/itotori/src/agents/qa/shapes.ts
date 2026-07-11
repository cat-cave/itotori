// ITOTORI-078 — QA agent shapes.
//
// `QaAgent.invokeQa` takes a draft job + its bridges + glossary + style
// guide and asks an LLM QA agent to produce a strict
// `StructuredQaFindingOutput`. The wire shape lives in
// `@itotori/localization-bridge-schema` (qa-finding.ts).
//
// Persistence of findings is intentionally deferred to a follow-up node
// (ITOTORI-074 owns the draft_jobs FK target); this module supplies a
// pure-TS fixture factory in `qa-finding-fixtures.ts` so consumers can
// assemble realistic finding shapes before the table exists.

import type {
  QaFinding,
  QaFindingCategory,
  QaFindingSeverity,
} from "@itotori/localization-bridge-schema";
import type {
  ProviderFamily,
  ProviderRunIdentity,
  ProviderRunRecord,
} from "../../providers/types.js";
import type { Bcp47Locale, Uuid7 } from "../../batch-planner/shapes.js";

export const QA_PROMPT_TEMPLATE_VERSION_V1 = "itotori-qa-agent-v1";
export const QA_DEFAULT_STRUCTURED_OUTPUT_NAME = "itotori-structured-qa-finding-output";

export type QaModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  /**
   * ITOTORI-220 — required (modelId, providerId) pair. Names the specific
   * upstream provider the QA agent must be pinned to.
   */
  providerId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

/**
 * Minimal bridge-unit projection the QA agent receives. We intentionally
 * do NOT lean on the full `BridgeUnit` type from the schema package
 * because the agent only needs the surface text and the bridge id to
 * cite. Callers project from whichever bridge representation they hold.
 */
export type QaBridgeUnit = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  draftText: string;
  draftHash: string;
  speaker?: string | undefined;
};

export type QaGlossaryEntry = {
  termId: Uuid7;
  preferredSourceForm: string;
  preferredTargetForm?: string | undefined;
  policyAction?: "localize" | "romanize" | "do_not_translate" | undefined;
};

export type QaStyleGuideRule = {
  ruleId: string;
  section: "tone" | "terminology" | "honorifics" | "formatting" | "protectedSpans";
  guidance: string;
};

/**
 * Strictly-typed input to `QaAgent.invokeQa`. The `draftJobId` references
 * the row owned by ITOTORI-074. We accept the id as an opaque Uuid7 here
 * so we can build and test the seam before that node lands.
 */
export type QaInvocationInput = {
  draftJobId: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  units: ReadonlyArray<QaBridgeUnit>;
  glossary: ReadonlyArray<QaGlossaryEntry>;
  styleGuide: ReadonlyArray<QaStyleGuideRule>;
  modelProfile: QaModelProfile;
  qaPromptVersion: string;
  now?: (() => Date) | undefined;
};

/**
 * Full result surface returned by `invokeQa`. `recordedArtifactId` is
 * populated when the request was satisfied by `RecordedModelProvider`;
 * `providerRunId` is the live provider's run id otherwise. Callers (and
 * future persistence) get a single typed object that always names which
 * proof persisted the findings.
 */
export type QaInvocationResult = {
  findings: QaFinding[];
  providerRunId: string;
  recordedArtifactId?: string;
  promptHashUsed: string;
  modelMetadata: QaInvocationModelMetadata;
  tokensIn: number;
  tokensOut: number;
};

export type QaInvocationModelMetadata = {
  modelProfile: QaModelProfile;
  providerIdentity: ProviderRunIdentity;
  providerRun: ProviderRunRecord;
  retryProviderRuns: ProviderRunRecord[];
};

// ---------------------------------------------------------------------------
// Typed errors. The service NEVER returns silent fallbacks — every recovery
// path goes through one of these.
// ---------------------------------------------------------------------------

/** Provider does not declare structured-output support. */
export class QaProviderCapabilityError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly providerFamily: ProviderFamily,
    public readonly detail: string,
  ) {
    super(
      `QA agent refused: provider ${providerName} (family=${providerFamily}) does not support structured output (${detail})`,
    );
    this.name = "QaProviderCapabilityError";
  }
}

/** Empty input — the agent never invokes the provider in this case. */
export class QaEmptyInputError extends Error {
  constructor(public readonly draftJobId: string) {
    super(`QA agent refused: draft job ${draftJobId} has no units to evaluate`);
    this.name = "QaEmptyInputError";
  }
}

/** Source / target locale invariants. */
export class QaLocaleMismatchError extends Error {
  constructor(
    public readonly field: "sourceLocale" | "targetLocale",
    public readonly observed: string,
  ) {
    super(`QA agent refused: ${field} '${observed}' is empty or invalid`);
    this.name = "QaLocaleMismatchError";
  }
}

/**
 * Provider returned a structurally-incomplete response — empty content,
 * or a `finishReason` indicating a stop before the parser could even
 * read JSON. Distinct from `QaResponseValidationError` (which means the
 * response was decodable JSON but failed schema validation).
 */
export class QaPartialResultError extends Error {
  constructor(
    public readonly providerRunId: string,
    public readonly finishReason: string,
    public readonly detail: string,
  ) {
    super(
      `QA agent refused: provider run ${providerRunId} returned a partial result (finishReason=${finishReason}): ${detail}`,
    );
    this.name = "QaPartialResultError";
  }
}

/**
 * One of the findings cites a bridge unit id that was not in the
 * caller-supplied input. Catches drift between recorded bundle and input.
 */
export class QaUnknownCitationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly findingId: string,
  ) {
    super(`QA agent refused: finding ${findingId} cites unknown bridge unit ${bridgeUnitId}`);
    this.name = "QaUnknownCitationError";
  }
}

/** A finding span extends beyond the text of its cited bridge unit. */
export class QaSpanOutOfBoundsError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly findingId: string,
    public readonly span: "sourceSpan" | "draftSpan",
    public readonly end: number,
    public readonly textLength: number,
  ) {
    super(
      `QA agent refused: finding ${findingId} ${span} for bridge unit ${bridgeUnitId} ` +
        `ends at ${end}, beyond text length ${textLength}`,
    );
    this.name = "QaSpanOutOfBoundsError";
  }
}

// Re-export the wire enums so consumers can stay on one import path.
export type { QaFinding, QaFindingCategory, QaFindingSeverity };
