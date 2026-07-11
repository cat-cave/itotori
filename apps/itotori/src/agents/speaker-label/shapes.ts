// ITOTORI-017 — Speaker-label agent shapes.
//
// `SpeakerLabelAgent.invokeSpeakerLabel` takes a slice of bridge units +
// the known character roster (with reader-hidden flags) and asks an LLM
// to label each unit's speaker. The wire shape lives in
// `@itotori/localization-bridge-schema` (speaker-label.ts).
//
// Persistence is intentionally NOT this seam's job: speaker labels ship
// alongside the draft as patch-export metadata, and the patch export step
// runs `prepareSpeakerLabelForPatchExport` to strip private fields. The
// agent module owns the in-memory metadata; downstream persistence
// (under follow-up nodes) consumes the typed result here.

import type { SpeakerLabel, SpeakerLabelConfidence } from "@itotori/localization-bridge-schema";
import type {
  ProviderFamily,
  ProviderRunIdentity,
  ProviderRunRecord,
} from "../../providers/types.js";
import type { Bcp47Locale, Uuid7 } from "../../batch-planner/shapes.js";

export const SPEAKER_LABEL_PROMPT_TEMPLATE_VERSION_V1 = "itotori-speaker-label-agent-v1";
export const SPEAKER_LABEL_DEFAULT_STRUCTURED_OUTPUT_NAME = "itotori-speaker-label-output";

export type SpeakerLabelModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  /**
   * ITOTORI-220 — required (modelId, providerId) pair. Pins the speaker-
   * label invocation to a specific upstream provider.
   */
  providerId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

/**
 * Minimal bridge-unit projection the speaker-label agent receives. Only
 * the surface text + a bridge-unit id are required; the agent invents no
 * structure beyond what callers pass.
 *
 * `parserSpeakerHint` is whatever the bridge extraction layer recorded as
 * the speaker tag (e.g. "????" for a hooded speaker, or a parsed name
 * tag). The agent MAY use it as a signal but MUST NOT trust it blindly —
 * the parser hint can be wrong, ambient, or a deliberate redaction in the
 * source itself.
 */
export type SpeakerLabelBridgeUnit = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  parserSpeakerHint?: string | undefined;
};

/**
 * Character roster entry. `hiddenFromReader: true` marks a character whose
 * identity is currently a narrative reveal — voice-only, masked, hooded,
 * not-yet-introduced, etc. The agent MUST produce `unknown_to_reader` for
 * any line spoken by such a character; the hidden-identity invariant
 * enforcement runs after the structured parse.
 *
 * `maskedDisplayName` and `maskedCharacterId` are the reader-facing
 * masked identifiers; the `characterId` here is the INTERNAL identity
 * used for tracking. Crucially: the internal identity must NEVER appear
 * in any patch-export payload — `prepareSpeakerLabelForPatchExport`
 * enforces that filter.
 */
export type CharacterBio = {
  /** Internal canonical character id. PRIVATE for hidden characters. */
  characterId: string;
  /** Internal canonical display name. PRIVATE for hidden characters. */
  displayName: string;
  /** Locale of `bioText`; informational only. */
  bioLocale: Bcp47Locale;
  /** Free-text biographical summary the agent may cite. */
  bioText: string;
  /**
   * True iff the reader does not yet know who this character is. Drives
   * the hidden-identity preservation invariant — any label whose internal
   * speaker resolves to this character MUST be emitted as
   * `kind: 'unknown_to_reader'`, citing the masked identifiers below.
   */
  hiddenFromReader: boolean;
  /**
   * Required iff `hiddenFromReader === true`. The reader-facing id this
   * character should appear under in masked output.
   */
  maskedCharacterId?: string;
  /**
   * Required iff `hiddenFromReader === true`. The reader-facing display
   * name this character should appear under in masked output.
   */
  maskedDisplayName?: string;
};

/**
 * Strictly-typed input to `SpeakerLabelAgent.invokeSpeakerLabel`.
 *
 * `existingSpeakerLabels` lets callers pre-load labels from earlier
 * passes (e.g. for incremental runs over a long scene). The agent uses
 * them as evidence-bearing context; the invariant checks still run on
 * the freshly-emitted labels, never on the pre-loaded ones.
 */
export type SpeakerLabelInvocationInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceLocale: Bcp47Locale;
  bridgeUnits: ReadonlyArray<SpeakerLabelBridgeUnit>;
  knownCharacters: ReadonlyArray<CharacterBio>;
  existingSpeakerLabels: ReadonlyMap<Uuid7, SpeakerLabel>;
  promptTemplateVersion: string;
  modelMetadata: SpeakerLabelModelProfile;
  /** Optional minimum confidence the agent's labels must clear. */
  confidenceFloor?: SpeakerLabelConfidence;
  /** Test seam — deterministic clock. */
  now?: (() => Date) | undefined;
};

/**
 * Result surface returned by `invokeSpeakerLabel`. `recordedArtifactId`
 * is populated when the request was satisfied by the
 * `RecordedModelProvider`; `providerRunId` is the live provider's run id
 * otherwise.
 */
export type SpeakerLabelInvocationResult = {
  labels: SpeakerLabel[];
  providerRunId: string;
  recordedArtifactId?: string;
  promptHashUsed: string;
  modelMetadata: SpeakerLabelInvocationModelMetadata;
  tokensIn: number;
  tokensOut: number;
};

export type SpeakerLabelInvocationModelMetadata = {
  modelProfile: SpeakerLabelModelProfile;
  providerIdentity: ProviderRunIdentity;
  providerRun: ProviderRunRecord;
  retryProviderRuns: ProviderRunRecord[];
};

// ---------------------------------------------------------------------------
// Typed errors. The agent NEVER returns silent fallbacks — every recovery
// path goes through one of these.
// ---------------------------------------------------------------------------

/** Provider does not declare structured-output support. */
export class SpeakerLabelProviderCapabilityError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly providerFamily: ProviderFamily,
    public readonly detail: string,
  ) {
    super(
      `speaker-label agent refused: provider ${providerName} (family=${providerFamily}) does not support structured output (${detail})`,
    );
    this.name = "SpeakerLabelProviderCapabilityError";
  }
}

/** Empty input — the agent never invokes the provider in this case. */
export class SpeakerLabelEmptyInputError extends Error {
  constructor(public readonly projectId: string) {
    super(`speaker-label agent refused: project ${projectId} has no bridge units to label`);
    this.name = "SpeakerLabelEmptyInputError";
  }
}

/** Source-locale invariant. */
export class SpeakerLabelLocaleMismatchError extends Error {
  constructor(public readonly observed: string) {
    super(`speaker-label agent refused: sourceLocale '${observed}' is empty or invalid`);
    this.name = "SpeakerLabelLocaleMismatchError";
  }
}

/**
 * Provider returned a structurally-incomplete response — empty content,
 * or a `finishReason` indicating a stop before the parser could even read
 * JSON. Distinct from `SpeakerLabelResponseValidationError` (which means
 * the response was decodable JSON but failed schema validation).
 */
export class SpeakerLabelPartialResultError extends Error {
  constructor(
    public readonly providerRunId: string,
    public readonly finishReason: string,
    public readonly detail: string,
  ) {
    super(
      `speaker-label agent refused: provider run ${providerRunId} returned a partial result (finishReason=${finishReason}): ${detail}`,
    );
    this.name = "SpeakerLabelPartialResultError";
  }
}

/**
 * One of the labels cites a bridge unit id that was not in the
 * caller-supplied input. Catches drift between recorded bundle and input.
 */
export class SpeakerLabelUnknownCitationError extends Error {
  constructor(public readonly bridgeUnitId: string) {
    super(`speaker-label agent refused: label cites unknown bridge unit ${bridgeUnitId}`);
    this.name = "SpeakerLabelUnknownCitationError";
  }
}

/**
 * The agent emitted a `named` label for a character marked
 * `hiddenFromReader: true` (matched by characterId OR by displayName).
 * This is the load-bearing safety invariant for ITOTORI-017 — a violation
 * is a critical leak of an in-story reveal.
 *
 * The error carries the offending `bridgeUnitId` AND the masked id of the
 * character that should have been used instead. Downstream auditors must
 * be able to reproduce the leak attempt from these two fields alone.
 */
export class HiddenIdentityLeakError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly leakedCharacterId: string,
    public readonly maskedCharacterId: string,
  ) {
    super(
      `speaker-label agent refused: bridge unit ${bridgeUnitId} attempted to leak hidden identity '${leakedCharacterId}'; expected masked id '${maskedCharacterId}'`,
    );
    this.name = "HiddenIdentityLeakError";
  }
}

/**
 * A label's confidence falls below the caller's `confidenceFloor`. The
 * agent rejects the entire response rather than silently dropping any
 * low-confidence labels — silent drops would let real ambiguity vanish.
 */
export class SpeakerLabelBelowConfidenceFloorError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly observed: SpeakerLabelConfidence,
    public readonly floor: SpeakerLabelConfidence,
  ) {
    super(
      `speaker-label agent refused: label for ${bridgeUnitId} reports confidence '${observed}' below floor '${floor}'`,
    );
    this.name = "SpeakerLabelBelowConfidenceFloorError";
  }
}

/**
 * The agent emitted a hidden-identity label whose masked id does not
 * match the character bio's declared mask. Symptom of a roster / prompt
 * desync and is a real-data bug, not a recoverable warning.
 */
export class SpeakerLabelHiddenMaskMismatchError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly observedMaskedCharacterId: string,
    public readonly expectedMaskedCharacterId: string,
  ) {
    super(
      `speaker-label agent refused: bridge unit ${bridgeUnitId} masked id '${observedMaskedCharacterId}' does not match roster '${expectedMaskedCharacterId}'`,
    );
    this.name = "SpeakerLabelHiddenMaskMismatchError";
  }
}

// Re-export the wire enums so consumers can stay on one import path.
export type { SpeakerLabel, SpeakerLabelConfidence };
