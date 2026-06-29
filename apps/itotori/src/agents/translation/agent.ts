// ITOTORI-075 — TranslationAgent: structured translation invocation +
// recorded replay + protected-span enforcement.
//
// Pre-flight contract:
//   1. The provider MUST declare `supportsStructuredOutput === true`,
//      asserted via the existing structured-output capability guard.
//      Failure → TranslationProviderCapabilityError.
//   2. Empty input rejected up-front → TranslationEmptyInputError.
//   3. Locale fields rejected on blank → TranslationLocaleMismatchError.
//
// Invocation contract:
//   1. Build the deterministic prompt (see prompt-template.ts).
//   2. Issue a structured-output `json_schema` request bound to the
//      `StructuredTranslationDraftOutput` schema.
//   3. Parse + validate the content against the wire schema. Schema
//      failure → TranslationDraftResponseValidationError (typed by the
//      schema package).
//   4. Each draft's bridgeUnitId must resolve to a unit in the input
//      → otherwise TranslationUnknownBridgeUnitError.
//   5. Every protected span in the input catalog MUST appear in the
//      corresponding draft's protectedSpanRefs with a valid range and
//      byte-equal preservation of the source span's text. Any
//      divergence → TranslationProtectedSpanViolationError naming the
//      bridgeUnitId + spanRef + closed-enum reason.
//   6. Every citationRef must resolve to a glossary termId or to a
//      contextArtifactRef → otherwise TranslationUnknownCitationError.
//   7. If the provider reported a finish reason that indicates a
//      partial response (length / stop-sequence / content-filter), or
//      content was null, throw `TranslationPartialResultError` — never
//      silently empty the draft list.
//
// Recorded replay:
//   Recorded mode is opt-in via the `provider` field on the
//   `TranslationAgent` instance. The agent does NOT itself probe the
//   environment variable — that's the CLI / orchestrator's job. This
//   keeps the agent deterministic for tests.

import type { AuthorizationActor } from "@itotori/db";
import {
  parseStructuredTranslationDraftOutput,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  TranslationDraftResponseValidationError,
  type StructuredTranslationDraftOutput,
  type TranslationDraft,
} from "@itotori/localization-bridge-schema";
import { estimateTokens } from "../../batch-planner/token-estimator.js";
import { selectStructuredOutputRequest } from "../../providers/structured-output.js";
import { RecordedModelProvider } from "../../providers/recorded.js";
import type {
  JsonObject,
  ModelInvocationRequest,
  ModelMessage,
  ModelProvider,
  StructuredOutputRequest,
} from "../../providers/types.js";
import { buildTranslationPrompt, translationPromptHash } from "./prompt-template.js";
import {
  TRANSLATION_DEFAULT_STRUCTURED_OUTPUT_NAME,
  TranslationEmptyInputError,
  TranslationLocaleMismatchError,
  TranslationPartialResultError,
  TranslationProtectedSpanViolationError,
  TranslationProviderCapabilityError,
  TranslationUnknownBridgeUnitError,
  TranslationUnknownCitationError,
  type TranslationInvocationInput,
  type TranslationInvocationResult,
  type TranslationProtectedSpanInput,
} from "./shapes.js";

export type TranslationAgentOptions = {
  /**
   * The model provider the agent invokes. May be a `FakeModelProvider`,
   * a `RecordedModelProvider`, or a live family. The capability guard
   * runs before any provider call.
   */
  provider: ModelProvider;
};

/**
 * Structured translation invocation seam. Constructed once per
 * process / request scope; the underlying provider is fixed at
 * construction time.
 */
export class TranslationAgent {
  constructor(private readonly options: TranslationAgentOptions) {}

  /**
   * Invoke the translation agent on a single draft job attempt. The
   * actor is required for symmetry with the persistence-bearing
   * agents — even though this seam does not persist drafts yet
   * (deferred to a follow-up node), the caller's permission context
   * is still meaningful for downstream provenance.
   */
  async invokeTranslation(
    _actor: AuthorizationActor,
    input: TranslationInvocationInput,
  ): Promise<TranslationInvocationResult> {
    this.assertInputWellFormed(input);
    const structuredOutput = this.resolveStructuredOutput();

    const rendered = buildTranslationPrompt(input);
    const promptHashUsed = translationPromptHash(rendered);

    const messages: ModelMessage[] = [
      { role: "system", content: rendered.systemText },
      { role: "user", content: rendered.userText },
    ];

    const request: ModelInvocationRequest = {
      taskKind: "draft_translation",
      modelId: input.modelProfile.modelId,
      providerId: input.modelProfile.providerId,
      inputClassification: "private_corpus",
      messages,
      structuredOutput,
      prompt: {
        presetId: "itotori-translation-agent",
        templateVersion: input.promptTemplateVersion,
        promptHash: `sha256:${promptHashUsed}`,
        schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
      },
      generation:
        input.modelProfile.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.modelProfile.maxOutputTokens },
    };

    const invocation = await this.options.provider.invoke(request);
    const providerRun = invocation.providerRun;
    const finishReason = invocation.finishReason;
    const rawContent = invocation.content;

    if (rawContent === null || rawContent.trim().length === 0) {
      throw new TranslationPartialResultError(
        providerRun.runId,
        input.draftJobAttemptId,
        finishReason,
        "provider returned no content",
      );
    }
    // Stop-reason vocabularies vary across providers. We treat
    // anything other than a clean stop / end_turn as partial;
    // recorded provider responses always normalize to `stop`.
    if (!isCleanStopReason(finishReason)) {
      throw new TranslationPartialResultError(
        providerRun.runId,
        input.draftJobAttemptId,
        finishReason,
        "finish reason is not a clean stop",
      );
    }

    const parsed = parseStructuredTranslationDraftOutput(rawContent);
    this.assertBridgeUnitsResolve(parsed, input);
    this.assertLocaleConsistency(parsed, input);
    this.assertCitationsResolve(parsed, input);
    this.assertProtectedSpansPreserved(parsed, input);

    const tokensIn =
      providerRun.tokenUsage.promptTokens ??
      estimateTokens(`${rendered.systemText}\n${rendered.userText}`);
    const tokensOut = providerRun.tokenUsage.completionTokens ?? estimateTokens(rawContent);

    const result: TranslationInvocationResult = {
      drafts: parsed.drafts,
      providerRunId: providerRun.runId,
      promptHashUsed,
      modelMetadata: {
        modelProfile: input.modelProfile,
        providerIdentity: providerRun.provider,
        providerRun,
      },
      tokensIn,
      tokensOut,
    };
    if (this.options.provider instanceof RecordedModelProvider) {
      result.recordedArtifactId = this.options.provider.bundleId();
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Pre-flight helpers
  // -------------------------------------------------------------------------

  private assertInputWellFormed(input: TranslationInvocationInput): void {
    if (input.sourceBridgeUnits.length === 0) {
      throw new TranslationEmptyInputError(input.draftJobId, input.draftJobAttemptId);
    }
    if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
      throw new TranslationLocaleMismatchError(
        "sourceLocale",
        input.sourceLocale ?? "",
        "empty or whitespace",
      );
    }
    if (!input.targetLocale || input.targetLocale.trim().length === 0) {
      throw new TranslationLocaleMismatchError(
        "targetLocale",
        input.targetLocale ?? "",
        "empty or whitespace",
      );
    }
    if (input.sourceLocale === input.targetLocale) {
      throw new TranslationLocaleMismatchError(
        "targetLocale",
        input.targetLocale,
        `must differ from sourceLocale '${input.sourceLocale}'`,
      );
    }
  }

  /**
   * ITOTORI-241 — select the ZDR-routable structured-output mode for the
   * active pair instead of forcing json_schema. json_schema when the
   * pair's ZDR providers advertise it, otherwise json_object (the
   * proven-routable deterministic mode). Refuses with the typed capability
   * error when the pair supports neither — never a silent degrade.
   */
  private resolveStructuredOutput(): StructuredOutputRequest {
    const capabilities = this.options.provider.descriptor.capabilities;
    try {
      return selectStructuredOutputRequest(capabilities, {
        name: TRANSLATION_DEFAULT_STRUCTURED_OUTPUT_NAME,
        schema: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA as unknown as JsonObject,
        strict: true,
      });
    } catch (error) {
      throw new TranslationProviderCapabilityError(
        this.options.provider.descriptor.providerName,
        this.options.provider.descriptor.family,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private assertBridgeUnitsResolve(
    parsed: StructuredTranslationDraftOutput,
    input: TranslationInvocationInput,
  ): void {
    const known = new Set(input.sourceBridgeUnits.map((unit) => unit.bridgeUnitId));
    for (const draft of parsed.drafts) {
      if (!known.has(draft.bridgeUnitId)) {
        throw new TranslationUnknownBridgeUnitError(draft.bridgeUnitId, input.draftJobAttemptId);
      }
    }
  }

  private assertLocaleConsistency(
    parsed: StructuredTranslationDraftOutput,
    input: TranslationInvocationInput,
  ): void {
    for (const draft of parsed.drafts) {
      if (draft.sourceLocale !== input.sourceLocale) {
        throw new TranslationLocaleMismatchError(
          "sourceLocale",
          draft.sourceLocale,
          `draft for bridge unit ${draft.bridgeUnitId} does not match input '${input.sourceLocale}'`,
        );
      }
      if (draft.targetLocale !== input.targetLocale) {
        throw new TranslationLocaleMismatchError(
          "targetLocale",
          draft.targetLocale,
          `draft for bridge unit ${draft.bridgeUnitId} does not match input '${input.targetLocale}'`,
        );
      }
    }
  }

  private assertCitationsResolve(
    parsed: StructuredTranslationDraftOutput,
    input: TranslationInvocationInput,
  ): void {
    const knownGlossary = new Set(input.glossary.map((entry) => entry.termId));
    const knownArtifacts = new Set(input.contextArtifactRefs ?? []);
    for (const draft of parsed.drafts) {
      for (const ref of draft.citationRefs) {
        if (!knownGlossary.has(ref) && !knownArtifacts.has(ref)) {
          throw new TranslationUnknownCitationError(
            draft.bridgeUnitId,
            ref,
            input.draftJobAttemptId,
          );
        }
      }
    }
  }

  private assertProtectedSpansPreserved(
    parsed: StructuredTranslationDraftOutput,
    input: TranslationInvocationInput,
  ): void {
    for (const draft of parsed.drafts) {
      const required = input.protectedSpansBySource.get(draft.bridgeUnitId) ?? [];
      const requiredByRef = new Map<string, TranslationProtectedSpanInput>();
      for (const span of required) {
        requiredByRef.set(span.refId, span);
      }

      const seenRefs = new Set<string>();
      const sortedRefs = [...draft.protectedSpanRefs].sort(
        (a, b) => a.startInDraft - b.startInDraft,
      );
      let previousEnd = -1;
      for (const ref of sortedRefs) {
        if (!requiredByRef.has(ref.refId)) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "unknown_ref",
            "ref id was not in the input protected-span catalog for this bridge unit",
          );
        }
        if (seenRefs.has(ref.refId)) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "duplicate_ref",
            "ref id appeared more than once in protectedSpanRefs",
          );
        }
        seenRefs.add(ref.refId);

        if (ref.endInDraft <= ref.startInDraft) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "invalid_range",
            `endInDraft ${ref.endInDraft} must be greater than startInDraft ${ref.startInDraft}`,
          );
        }
        if (ref.endInDraft > draft.draftText.length) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "out_of_bounds",
            `endInDraft ${ref.endInDraft} exceeds draftText length ${draft.draftText.length}`,
          );
        }
        if (ref.startInDraft < previousEnd) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "overlapping_ref",
            `startInDraft ${ref.startInDraft} overlaps a previously-claimed span ending at ${previousEnd}`,
          );
        }
        previousEnd = ref.endInDraft;

        const sourceSpan = requiredByRef.get(ref.refId);
        // sourceSpan is guaranteed to be defined because we checked
        // `requiredByRef.has` above.
        if (sourceSpan === undefined) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "unknown_ref",
            "internal: ref id resolved but span definition was missing",
          );
        }
        const observed = draft.draftText.slice(ref.startInDraft, ref.endInDraft);
        if (observed !== sourceSpan.sourceText) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            ref.refId,
            "preservation_mismatch",
            `expected draftText[${ref.startInDraft}..${ref.endInDraft}] to equal source ${JSON.stringify(sourceSpan.sourceText)} but got ${JSON.stringify(observed)}`,
          );
        }
      }

      // Every required span must be present.
      for (const requiredRefId of requiredByRef.keys()) {
        if (!seenRefs.has(requiredRefId)) {
          throw new TranslationProtectedSpanViolationError(
            draft.bridgeUnitId,
            requiredRefId,
            "missing_ref",
            "input catalog required this span but draft omitted it from protectedSpanRefs",
          );
        }
      }
    }
  }
}

// Re-export the schema-package error so callers can `import` from one
// place without reaching across packages.
export { TranslationDraftResponseValidationError };

function isCleanStopReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === "stop" || normalized === "end_turn" || normalized === "complete";
}

// Re-export for downstream consumers; matches the QA agent's surface.
export type { TranslationDraft };
