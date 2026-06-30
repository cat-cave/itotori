// ITOTORI-017 — SpeakerLabelAgent: structured speaker-labeling +
// hidden-identity preservation + patch-safe metadata serialization.
//
// Pre-flight contract:
//   1. The provider MUST declare `supportsStructuredOutput === true`,
//      asserted via the existing structured-output capability guard.
//      Failure → SpeakerLabelProviderCapabilityError.
//   2. Empty input rejected up-front → SpeakerLabelEmptyInputError.
//   3. Source locale rejected on blank → SpeakerLabelLocaleMismatchError.
//   4. Hidden characters MUST carry both maskedCharacterId AND
//      maskedDisplayName — otherwise the input is internally inconsistent
//      and we refuse rather than guess.
//
// Invocation contract:
//   1. Build the deterministic prompt (see prompt-template.ts).
//   2. Issue a structured-output `json_schema` request bound to the
//      `SpeakerLabelOutput` schema.
//   3. Parse + validate the content against the wire schema. Schema
//      failure → SpeakerLabelResponseValidationError.
//   4. Each label's bridgeUnitId must resolve to a unit in the input
//      → otherwise SpeakerLabelUnknownCitationError.
//   5. Enforce the HIDDEN-IDENTITY INVARIANT — see
//      `assertHiddenIdentityNotLeaked` below. Any `named` label whose
//      characterId or displayName matches a hidden bio is rejected with
//      HiddenIdentityLeakError. This is the P0 safety check.
//   6. Confidence floor (optional, caller-driven) → otherwise
//      SpeakerLabelBelowConfidenceFloorError.
//   7. If the provider reported a partial finish reason or empty content,
//      throw SpeakerLabelPartialResultError — never silently empty the
//      labels list.
//
// Recorded replay:
//   Recorded mode is opt-in via the `RecordedModelProvider` instance
//   passed in `options.provider`. The agent does NOT itself probe the
//   environment variable — that's the CLI / orchestrator's job.

import type { AuthorizationActor } from "@itotori/db";
import {
  parseSpeakerLabelOutput,
  SPEAKER_LABEL_OUTPUT_JSON_SCHEMA,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  SpeakerLabelResponseValidationError,
  type SpeakerLabel,
  type SpeakerLabelConfidence,
  type SpeakerLabelOutput,
  type SpeakerLabelUnknownReason,
} from "@itotori/localization-bridge-schema";
import { assertReportedTokenUsage } from "../../providers/token-accounting.js";
import { selectStructuredOutputRequest } from "../../providers/structured-output.js";
import type {
  JsonObject,
  ModelInvocationRequest,
  ModelMessage,
  ModelProvider,
  StructuredOutputRequest,
} from "../../providers/types.js";
import { RecordedModelProvider } from "../../providers/recorded.js";
import { buildSpeakerLabelPrompt, speakerLabelPromptHash } from "./prompt-template.js";
import {
  CharacterBio,
  HiddenIdentityLeakError,
  SPEAKER_LABEL_DEFAULT_STRUCTURED_OUTPUT_NAME,
  SpeakerLabelBelowConfidenceFloorError,
  SpeakerLabelEmptyInputError,
  SpeakerLabelHiddenMaskMismatchError,
  SpeakerLabelInvocationInput,
  SpeakerLabelInvocationResult,
  SpeakerLabelLocaleMismatchError,
  SpeakerLabelPartialResultError,
  SpeakerLabelProviderCapabilityError,
  SpeakerLabelUnknownCitationError,
} from "./shapes.js";

export type SpeakerLabelAgentOptions = {
  /**
   * The model provider the agent invokes. May be a `FakeModelProvider`,
   * a `RecordedModelProvider`, or a live family. The capability guard
   * runs before any provider call.
   */
  provider: ModelProvider;
};

/**
 * Structured speaker-label invocation seam. Constructed once per process
 * / request scope; the underlying provider is fixed at construction time.
 */
export class SpeakerLabelAgent {
  constructor(private readonly options: SpeakerLabelAgentOptions) {}

  async invokeSpeakerLabel(
    _actor: AuthorizationActor,
    input: SpeakerLabelInvocationInput,
  ): Promise<SpeakerLabelInvocationResult> {
    this.assertInputWellFormed(input);
    const structuredOutput = this.resolveStructuredOutput();

    const rendered = buildSpeakerLabelPrompt(input);
    const promptHashUsed = speakerLabelPromptHash(rendered);

    const messages: ModelMessage[] = [
      { role: "system", content: rendered.systemText },
      { role: "user", content: rendered.userText },
    ];

    const request: ModelInvocationRequest = {
      taskKind: "experiment",
      modelId: input.modelMetadata.modelId,
      providerId: input.modelMetadata.providerId,
      inputClassification: "private_corpus",
      messages,
      structuredOutput,
      prompt: {
        presetId: "itotori-speaker-label-agent",
        templateVersion: input.promptTemplateVersion,
        promptHash: `sha256:${promptHashUsed}`,
        schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
      },
      generation:
        input.modelMetadata.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.modelMetadata.maxOutputTokens },
    };

    const invocation = await this.options.provider.invoke(request);
    const providerRun = invocation.providerRun;
    const finishReason = invocation.finishReason;
    const rawContent = invocation.content;

    if (rawContent === null || rawContent.trim().length === 0) {
      throw new SpeakerLabelPartialResultError(
        providerRun.runId,
        finishReason,
        "provider returned no content",
      );
    }
    if (!isCleanStopReason(finishReason)) {
      throw new SpeakerLabelPartialResultError(
        providerRun.runId,
        finishReason,
        "finish reason is not a clean stop",
      );
    }

    const parsed = parseSpeakerLabelOutput(rawContent);
    this.assertCitationsResolve(parsed, input);
    this.assertHiddenIdentityNotLeaked(parsed, input);
    this.assertHiddenMaskConsistency(parsed, input);
    if (input.confidenceFloor !== undefined) {
      this.assertConfidenceFloor(parsed, input.confidenceFloor);
    }

    // PROJECT LAW: real provider token counts only — throw on absence
    // rather than substitute a char/4 estimate (mirror of assertBilledCost).
    const { tokensIn, tokensOut } = assertReportedTokenUsage(
      providerRun.tokenUsage,
      providerRun.runId,
    );

    const result: SpeakerLabelInvocationResult = {
      labels: parsed.labels,
      providerRunId: providerRun.runId,
      promptHashUsed,
      modelMetadata: {
        modelProfile: input.modelMetadata,
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

  private assertInputWellFormed(input: SpeakerLabelInvocationInput): void {
    if (input.bridgeUnits.length === 0) {
      throw new SpeakerLabelEmptyInputError(input.projectId);
    }
    if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
      throw new SpeakerLabelLocaleMismatchError(input.sourceLocale ?? "");
    }
    for (const bio of input.knownCharacters) {
      if (bio.hiddenFromReader) {
        const maskedId = bio.maskedCharacterId ?? "";
        const maskedName = bio.maskedDisplayName ?? "";
        if (maskedId.length === 0 || maskedName.length === 0) {
          throw new SpeakerLabelHiddenMaskMismatchError(
            "(roster)",
            maskedId,
            `roster entry ${bio.characterId} is hiddenFromReader but missing maskedCharacterId or maskedDisplayName`,
          );
        }
      }
    }
  }

  /**
   * ITOTORI-241 — select the ZDR-routable structured-output mode for the
   * active pair instead of forcing json_schema. The pair's capability
   * sheet decides: json_schema when its ZDR providers advertise it,
   * otherwise json_object (the proven-routable deterministic mode). A pair
   * that supports neither is refused with the agent's typed capability
   * error — never a silent degrade.
   */
  private resolveStructuredOutput(): StructuredOutputRequest {
    const capabilities = this.options.provider.descriptor.capabilities;
    try {
      return selectStructuredOutputRequest(capabilities, {
        name: SPEAKER_LABEL_DEFAULT_STRUCTURED_OUTPUT_NAME,
        schema: SPEAKER_LABEL_OUTPUT_JSON_SCHEMA as unknown as JsonObject,
        strict: true,
      });
    } catch (error) {
      throw new SpeakerLabelProviderCapabilityError(
        this.options.provider.descriptor.providerName,
        this.options.provider.descriptor.family,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private assertCitationsResolve(
    parsed: SpeakerLabelOutput,
    input: SpeakerLabelInvocationInput,
  ): void {
    const known = new Set(input.bridgeUnits.map((unit) => unit.bridgeUnitId));
    for (const label of parsed.labels) {
      if (!known.has(label.bridgeUnitId)) {
        throw new SpeakerLabelUnknownCitationError(label.bridgeUnitId);
      }
    }
  }

  /**
   * LOAD-BEARING SAFETY CHECK. Walks every emitted label and refuses any
   * `named` label whose characterId or displayName matches a hidden bio.
   * A leak here means the agent named a character the reader is not
   * supposed to know yet — a critical spoiler.
   */
  private assertHiddenIdentityNotLeaked(
    parsed: SpeakerLabelOutput,
    input: SpeakerLabelInvocationInput,
  ): void {
    const hiddenById = new Map<string, CharacterBio>();
    const hiddenByDisplayName = new Map<string, CharacterBio>();
    for (const bio of input.knownCharacters) {
      if (bio.hiddenFromReader) {
        hiddenById.set(bio.characterId, bio);
        hiddenByDisplayName.set(bio.displayName, bio);
      }
    }
    if (hiddenById.size === 0) {
      return;
    }
    for (const label of parsed.labels) {
      const identity = label.speakerId;
      if (identity.kind !== "named") {
        continue;
      }
      const leakedBio =
        hiddenById.get(identity.characterId) ?? hiddenByDisplayName.get(identity.displayName);
      if (leakedBio !== undefined) {
        throw new HiddenIdentityLeakError(
          label.bridgeUnitId,
          identity.characterId,
          leakedBio.maskedCharacterId ?? "(unmasked)",
        );
      }
    }
  }

  /**
   * Verifies that any `unknown_to_reader` label whose mask matches a
   * roster entry uses the EXACT maskedCharacterId from the roster — no
   * drift between the agent's mask and the bio's mask. Distinct from
   * the leak check: this catches mis-masking, not over-disclosure.
   */
  private assertHiddenMaskConsistency(
    parsed: SpeakerLabelOutput,
    input: SpeakerLabelInvocationInput,
  ): void {
    const maskedRoster = new Map<string, CharacterBio>();
    for (const bio of input.knownCharacters) {
      if (bio.hiddenFromReader && bio.maskedCharacterId !== undefined) {
        maskedRoster.set(bio.maskedCharacterId, bio);
      }
    }
    if (maskedRoster.size === 0) {
      return;
    }
    for (const label of parsed.labels) {
      const identity = label.speakerId;
      if (identity.kind !== "unknown_to_reader") {
        continue;
      }
      // If the agent emitted an internalCharacterId, it MUST correspond
      // to a hidden roster entry whose maskedCharacterId matches the
      // label's mask. (No internalCharacterId is also fine — it's
      // optional metadata.)
      if (identity.internalCharacterId !== undefined) {
        const bioByInternal = input.knownCharacters.find(
          (bio) => bio.characterId === identity.internalCharacterId,
        );
        if (bioByInternal === undefined || !bioByInternal.hiddenFromReader) {
          throw new SpeakerLabelHiddenMaskMismatchError(
            label.bridgeUnitId,
            identity.maskedCharacterId,
            "(no matching hidden roster entry)",
          );
        }
        if (bioByInternal.maskedCharacterId !== identity.maskedCharacterId) {
          throw new SpeakerLabelHiddenMaskMismatchError(
            label.bridgeUnitId,
            identity.maskedCharacterId,
            bioByInternal.maskedCharacterId ?? "(unmasked)",
          );
        }
      }
    }
  }

  private assertConfidenceFloor(parsed: SpeakerLabelOutput, floor: SpeakerLabelConfidence): void {
    const rank: Record<SpeakerLabelConfidence, number> = {
      low: 0,
      medium: 1,
      high: 2,
    };
    const floorRank = rank[floor];
    for (const label of parsed.labels) {
      if (rank[label.confidence] < floorRank) {
        throw new SpeakerLabelBelowConfidenceFloorError(
          label.bridgeUnitId,
          label.confidence,
          floor,
        );
      }
    }
  }
}

// ===========================================================================
// Patch-safe serialization
// ===========================================================================

/**
 * Public, patch-export-safe projection of a SpeakerLabel.
 *
 * Differs from the internal `SpeakerLabel` in exactly one way: the
 * `unknown_to_reader` variant carries NO `internalCharacterId`. That
 * field exists only for in-system tracking and MUST NOT ride along on
 * the patch export — leaking it would defeat the entire hidden-identity
 * mechanism.
 *
 * The named / unknown_to_parser / narration variants pass through
 * unchanged, but we re-state them here so the type is self-documenting
 * (a callsite that imports `PublicSpeakerLabel` should not have to read
 * the schema package to know what they're allowed to surface).
 */
export type PublicSpeakerIdentity =
  | { kind: "named"; characterId: string; displayName: string }
  | {
      kind: "unknown_to_reader";
      maskedCharacterId: string;
      maskedDisplayName: string;
    }
  | { kind: "unknown_to_parser"; reason: SpeakerLabelUnknownReason }
  | { kind: "narration" };

export type PublicSpeakerLabel = {
  bridgeUnitId: string;
  speakerId: PublicSpeakerIdentity;
  confidence: SpeakerLabelConfidence;
  evidenceRefs: string[];
  agentRationale: string;
};

/**
 * Strips every internal-only field from a SpeakerLabel and returns the
 * patch-export-safe projection. Specifically: when the identity is
 * `unknown_to_reader`, the `internalCharacterId` field is dropped. All
 * other variants are returned verbatim.
 *
 * Tests enumerate every SpeakerIdentity variant and assert that the
 * resulting JSON does NOT contain the string `internalCharacterId`.
 */
export function prepareSpeakerLabelForPatchExport(label: SpeakerLabel): PublicSpeakerLabel {
  const identity = label.speakerId;
  let publicIdentity: PublicSpeakerIdentity;
  switch (identity.kind) {
    case "named":
      publicIdentity = {
        kind: "named",
        characterId: identity.characterId,
        displayName: identity.displayName,
      };
      break;
    case "unknown_to_reader":
      // Critical: drop `internalCharacterId` here. Even when it is
      // undefined we construct the object without the key so JSON
      // serialization can never emit it.
      publicIdentity = {
        kind: "unknown_to_reader",
        maskedCharacterId: identity.maskedCharacterId,
        maskedDisplayName: identity.maskedDisplayName,
      };
      break;
    case "unknown_to_parser":
      publicIdentity = {
        kind: "unknown_to_parser",
        reason: identity.reason,
      };
      break;
    case "narration":
      publicIdentity = { kind: "narration" };
      break;
  }
  return {
    bridgeUnitId: label.bridgeUnitId,
    speakerId: publicIdentity,
    confidence: label.confidence,
    evidenceRefs: [...label.evidenceRefs],
    agentRationale: label.agentRationale,
  };
}

// Re-export the schema-package error so callers can `import` from one
// place without reaching across packages.
export { SpeakerLabelResponseValidationError };

function isCleanStopReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized === "stop" || normalized === "end_turn" || normalized === "complete";
}
