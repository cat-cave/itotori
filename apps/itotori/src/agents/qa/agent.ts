// ITOTORI-078 — QaAgent: structured QA invocation + recorded replay.
//
// Pre-flight contract:
//   1. The provider MUST declare `supportsStructuredOutput === true`,
//      asserted via the existing structured-output capability guard.
//      Failure → QaProviderCapabilityError.
//   2. Empty input rejected up-front → QaEmptyInputError.
//   3. Locale fields rejected on blank → QaLocaleMismatchError.
//
// Invocation contract:
//   1. Build the deterministic prompt (see prompt-template.ts).
//   2. Issue a structured-output `json_schema` request bound to the
//      `StructuredQaFindingOutput` schema.
//   3. Parse + validate the content against the wire schema. Schema
//      failure → QaResponseValidationError (typed by the schema package).
//   4. Each finding's bridgeUnitId must resolve to a unit in the input
//      → otherwise QaUnknownCitationError; each evidenceRef must resolve
//      to supplied glossary, style, or context-artifact evidence
//      → otherwise QaUnknownEvidenceRefError.
//   5. If the provider reported a finish reason that indicates a partial
//      response (length / stop-sequence / content-filter), or content
//      was null, throw `QaPartialResultError` — never silently empty the
//      finding list.
//
// Recorded replay:
//   Recorded mode is opt-in via the `recordedProvider` field on the
//   `QaAgent` instance. The agent does NOT itself probe the environment
//   variable — that's the CLI / orchestrator's job. This keeps the agent
//   deterministic for tests.

import type { AuthorizationActor } from "@itotori/db";
import {
  parseStructuredQaFindingOutput,
  QaResponseValidationError,
  STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  type StructuredQaFindingOutput,
} from "@itotori/localization-bridge-schema";
import { executeStructuredInvocation } from "../../orchestrator/invocation-supervisor.js";
import { assertReportedTokenUsage } from "../../providers/token-accounting.js";
import { selectStructuredOutputRequest } from "../../providers/structured-output.js";
import type {
  JsonObject,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelProvider,
  StructuredOutputRequest,
} from "../../providers/types.js";
import { RecordedModelProvider } from "../../providers/recorded.js";
import { buildQaPrompt, qaPromptHash } from "./prompt-template.js";
import {
  QA_DEFAULT_STRUCTURED_OUTPUT_NAME,
  QaEmptyInputError,
  QaLocaleMismatchError,
  QaPartialResultError,
  QaProviderCapabilityError,
  QaSpanOutOfBoundsError,
  QaUnknownCitationError,
  QaUnknownEvidenceRefError,
  type QaInvocationInput,
  type QaInvocationResult,
} from "./shapes.js";

export type QaAgentOptions = {
  /**
   * The model provider the agent invokes. May be a `FakeModelProvider`,
   * a `RecordedModelProvider`, or a live family. The capability guard
   * runs before any provider call.
   */
  provider: ModelProvider;
};

/**
 * Structured QA invocation seam. Constructed once per process / request
 * scope; the underlying provider is fixed at construction time.
 */
export class QaAgent {
  constructor(private readonly options: QaAgentOptions) {}

  /**
   * Invoke the QA agent on a single draft job. The actor is required for
   * symmetry with the persistence-bearing agents — even though this seam
   * does not persist findings yet (deferred to a follow-up node), the
   * caller's permission context is still meaningful for downstream
   * provenance.
   */
  async invokeQa(
    _actor: AuthorizationActor,
    input: QaInvocationInput,
  ): Promise<QaInvocationResult> {
    this.assertInputWellFormed(input);
    const structuredOutput = this.resolveStructuredOutput();

    const rendered = buildQaPrompt(input);
    const promptHashUsed = qaPromptHash(rendered);

    const messages: ModelMessage[] = [
      { role: "system", content: rendered.systemText },
      { role: "user", content: rendered.userText },
    ];

    const request: ModelInvocationRequest = {
      taskKind: "llm_qa",
      modelId: input.modelProfile.modelId,
      providerId: input.modelProfile.providerId,
      inputClassification: "private_corpus",
      messages,
      structuredOutput,
      prompt: {
        presetId: "itotori-qa-agent",
        templateVersion: input.qaPromptVersion,
        promptHash: `sha256:${promptHashUsed}`,
        schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
      },
      generation:
        input.modelProfile.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.modelProfile.maxOutputTokens },
    };

    const { invocation, parsed, priorAttempts } = await executeStructuredInvocation(
      this.options.provider,
      {
        request,
        parse: parseStructuredQaFindingOutput,
        isSchemaValidationError: (error) => error instanceof QaResponseValidationError,
        validateResponse: (candidate) => this.assertCompleteInvocation(candidate),
        validateParsed: (candidate) => {
          this.assertCitationsResolve(candidate, input);
          this.assertEvidenceRefsResolve(candidate, input);
          this.assertSpansWithinBounds(candidate, input);
        },
        requiredUnitIds: input.units.map((unit) => unit.bridgeUnitId),
        successDecision: "advance",
      },
    );
    const providerRun = invocation.providerRun;
    const retryProviderRuns = priorAttempts.map((attempt) => attempt.providerRun);

    // PROJECT LAW: real provider token counts only — throw on absence
    // rather than substitute a char/4 estimate (mirror of assertBilledCost).
    let tokensIn = 0;
    let tokensOut = 0;
    for (const attempt of [...priorAttempts, invocation]) {
      const usage = assertReportedTokenUsage(
        attempt.providerRun.tokenUsage,
        attempt.providerRun.runId,
      );
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
    }

    const result: QaInvocationResult = {
      findings: parsed.findings,
      providerRunId: providerRun.runId,
      promptHashUsed,
      modelMetadata: {
        modelProfile: input.modelProfile,
        providerIdentity: providerRun.provider,
        providerRun,
        retryProviderRuns,
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

  private assertInputWellFormed(input: QaInvocationInput): void {
    if (input.units.length === 0) {
      throw new QaEmptyInputError(input.draftJobId);
    }
    if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
      throw new QaLocaleMismatchError("sourceLocale", input.sourceLocale ?? "");
    }
    if (!input.targetLocale || input.targetLocale.trim().length === 0) {
      throw new QaLocaleMismatchError("targetLocale", input.targetLocale ?? "");
    }
  }

  private assertCompleteInvocation(invocation: ModelInvocationResult): string {
    const providerRun = invocation.providerRun;
    const finishReason = invocation.finishReason;
    const rawContent = invocation.content;

    if (rawContent === null || rawContent.trim().length === 0) {
      throw new QaPartialResultError(
        providerRun.runId,
        finishReason,
        "provider returned no content",
      );
    }
    // Stop-reason vocabularies vary across providers. We treat anything
    // other than a clean stop / end_turn as partial; recorded provider
    // responses always normalize to `stop`.
    if (!isCleanStopReason(finishReason)) {
      throw new QaPartialResultError(
        providerRun.runId,
        finishReason,
        "finish reason is not a clean stop",
      );
    }
    return rawContent;
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
        name: QA_DEFAULT_STRUCTURED_OUTPUT_NAME,
        schema: STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA as unknown as JsonObject,
        strict: true,
      });
    } catch (error) {
      throw new QaProviderCapabilityError(
        this.options.provider.descriptor.providerName,
        this.options.provider.descriptor.family,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private assertCitationsResolve(
    parsed: StructuredQaFindingOutput,
    input: QaInvocationInput,
  ): void {
    const known = new Set(input.units.map((unit) => unit.bridgeUnitId));
    for (const finding of parsed.findings) {
      if (!known.has(finding.bridgeUnitId)) {
        throw new QaUnknownCitationError(finding.bridgeUnitId, finding.findingId);
      }
    }
  }

  private assertSpansWithinBounds(
    parsed: StructuredQaFindingOutput,
    input: QaInvocationInput,
  ): void {
    const unitsById = new Map(input.units.map((unit) => [unit.bridgeUnitId, unit]));
    for (const finding of parsed.findings) {
      const unit = unitsById.get(finding.bridgeUnitId);
      if (unit === undefined) {
        throw new QaUnknownCitationError(finding.bridgeUnitId, finding.findingId);
      }
      if (finding.sourceSpan !== undefined && finding.sourceSpan.end > unit.sourceText.length) {
        throw new QaSpanOutOfBoundsError(
          finding.bridgeUnitId,
          finding.findingId,
          "sourceSpan",
          finding.sourceSpan.end,
          unit.sourceText.length,
        );
      }
      if (finding.draftSpan !== undefined && finding.draftSpan.end > unit.draftText.length) {
        throw new QaSpanOutOfBoundsError(
          finding.bridgeUnitId,
          finding.findingId,
          "draftSpan",
          finding.draftSpan.end,
          unit.draftText.length,
        );
      }
    }
  }

  private assertEvidenceRefsResolve(
    parsed: StructuredQaFindingOutput,
    input: QaInvocationInput,
  ): void {
    const knownEvidenceRefs = new Set([
      ...input.glossary.map((entry) => entry.termId),
      ...input.styleGuide.map((rule) => rule.ruleId),
      ...input.contextArtifacts.map((artifact) => artifact.contextArtifactId),
    ]);
    for (const finding of parsed.findings) {
      for (const evidenceRef of finding.evidenceRefs) {
        if (!knownEvidenceRefs.has(evidenceRef)) {
          throw new QaUnknownEvidenceRefError(evidenceRef, finding.findingId);
        }
      }
    }
  }
}

// Re-export the schema-package error so callers can `import` from one
// place without reaching across packages.
export { QaResponseValidationError };

function isCleanStopReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === "stop" || normalized === "end_turn" || normalized === "complete";
}
