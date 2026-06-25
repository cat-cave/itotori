// ITOTORI-017 — Recorded-provider replay integration test for the
// speaker-label seam.
//
// Builds a stub recorded bundle keyed on the deterministic promptHash and
// asserts:
//   1. The agent successfully replays the bundle into a typed
//      SpeakerLabelInvocationResult that carries the expected labels AND
//      the recordedArtifactId of the bundle.
//   2. Same input + same bundle → same `labels` byte-equal across two
//      consecutive invocations (full reproducibility — the byte-for-byte
//      contract the orchestrator relies on for hidden-identity audits).
//   3. A bundle miss (wrong promptHash) is surfaced as a
//      RecordedBundleMissingError rather than a silent fallback.

import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  type SpeakerLabel,
  type SpeakerLabelOutput,
} from "@itotori/localization-bridge-schema";
import {
  RecordedBundleMissingError,
  RecordedModelProvider,
  recordedBundleKey,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import {
  buildSpeakerLabelPrompt,
  SpeakerLabelAgent,
  speakerLabelPromptHash,
  type CharacterBio,
  type SpeakerLabelBridgeUnit,
  type SpeakerLabelInvocationInput,
  type SpeakerLabelModelProfile,
} from "../src/agents/speaker-label/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-23T12:00:00Z");

function modelProfile(): SpeakerLabelModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-speaker-label-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsForRecordedTest(): SpeakerLabelBridgeUnit[] {
  return [
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "「我こそが勇者だ」",
      sourceHash: "src-hash-1",
      parserSpeakerHint: "勇者",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "「……」",
      sourceHash: "src-hash-2",
      parserSpeakerHint: "????",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "夜風が城門を揺らした。",
      sourceHash: "src-hash-3",
    },
  ];
}

function rosterForRecordedTest(): CharacterBio[] {
  return [
    {
      characterId: "char-yusha",
      displayName: "勇者",
      bioLocale: "ja-JP",
      bioText: "Protagonist.",
      hiddenFromReader: false,
    },
    {
      characterId: "char-maou",
      displayName: "魔王",
      bioLocale: "ja-JP",
      bioText: "Antagonist; identity withheld.",
      hiddenFromReader: true,
      maskedCharacterId: "masked-shadow-001",
      maskedDisplayName: "??? (cloaked figure)",
    },
  ];
}

function recordedInputFixture(): SpeakerLabelInvocationInput {
  return {
    projectId: "019ed079-0000-7000-8000-000000000001",
    localeBranchId: "019ed079-0000-7000-8000-000000000002",
    sourceLocale: "ja-JP",
    bridgeUnits: unitsForRecordedTest(),
    knownCharacters: rosterForRecordedTest(),
    existingSpeakerLabels: new Map(),
    promptTemplateVersion: "itotori-speaker-label-agent-v1",
    modelMetadata: modelProfile(),
    now: FIXED_NOW,
  };
}

function recordedLabelsFor(input: SpeakerLabelInvocationInput): SpeakerLabel[] {
  return [
    {
      bridgeUnitId: input.bridgeUnits[0]!.bridgeUnitId,
      speakerId: { kind: "named", characterId: "char-yusha", displayName: "勇者" },
      confidence: "high",
      evidenceRefs: ["parser-hint"],
      agentRationale: "Parser hint names the hero directly.",
    },
    {
      bridgeUnitId: input.bridgeUnits[1]!.bridgeUnitId,
      speakerId: {
        kind: "unknown_to_reader",
        maskedCharacterId: "masked-shadow-001",
        maskedDisplayName: "??? (cloaked figure)",
        internalCharacterId: "char-maou",
      },
      confidence: "medium",
      evidenceRefs: ["scene-summary:scene-001"],
      agentRationale: "Cloaked figure; identity withheld for the reader.",
    },
    {
      bridgeUnitId: input.bridgeUnits[2]!.bridgeUnitId,
      speakerId: { kind: "narration" },
      confidence: "high",
      evidenceRefs: ["scene-summary:scene-001"],
      agentRationale: "Scene descriptor with no spoken voice.",
    },
  ];
}

function bundleFor(
  input: SpeakerLabelInvocationInput,
  labels: SpeakerLabel[],
): RecordedProviderBundle {
  const rendered = buildSpeakerLabelPrompt(input);
  // ITOTORI-220 — key by the pair-aware default bundle key.
  const bundleKey = recordedBundleKey({
    modelId: input.modelMetadata.modelId,
    providerId: input.modelMetadata.providerId,
    promptHash: `sha256:${speakerLabelPromptHash(rendered)}`,
    inputClassification: "private_corpus",
  });
  const output: SpeakerLabelOutput = {
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels,
  };
  return {
    bundleId: "speaker-label-bundle-fixture-001",
    capturedProviderFamily: "openrouter",
    capturedProviderName: "openrouter:speaker-label-judge",
    capturedRequestedModelId: input.modelMetadata.modelId,
    capturedProviderId: input.modelMetadata.providerId,
    capturedActualModelId: "openrouter:claude-opus-fixture",
    responses: {
      [bundleKey]: {
        content: JSON.stringify(output),
        finishReason: "stop",
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 1024,
          completionTokens: 512,
          totalTokens: 1536,
        },
      },
    },
  };
}

describe("SpeakerLabelAgent + RecordedModelProvider integration", () => {
  it("REPRODUCIBILITY: same input + same bundle yields byte-equal labels across two invocations", async () => {
    const input = recordedInputFixture();
    const labels = recordedLabelsFor(input);
    const bundle = bundleFor(input, labels);
    const provider = new RecordedModelProvider({ bundle });
    const agent = new SpeakerLabelAgent({ provider });

    const first = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    const second = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);

    expect(JSON.stringify(first.labels)).toEqual(JSON.stringify(second.labels));
    expect(first.labels).toEqual(labels);
    expect(first.recordedArtifactId).toBe(bundle.bundleId);
    expect(second.recordedArtifactId).toBe(bundle.bundleId);
    expect(first.promptHashUsed).toEqual(second.promptHashUsed);
    expect(first.modelMetadata.providerIdentity.providerName).toBe(bundle.capturedProviderName);
    expect(first.modelMetadata.providerIdentity.providerFamily).toBe(bundle.capturedProviderFamily);
    expect(first.modelMetadata.providerIdentity.actualModelId).toBe(bundle.capturedActualModelId);
    expect(first.tokensIn).toBe(1024);
    expect(first.tokensOut).toBe(512);
  });

  it("REPRODUCIBILITY: hidden-identity invariant survives bundle replay (internalCharacterId is preserved on the internal surface but the masked id round-trips)", async () => {
    const input = recordedInputFixture();
    const labels = recordedLabelsFor(input);
    const bundle = bundleFor(input, labels);
    const provider = new RecordedModelProvider({ bundle });
    const agent = new SpeakerLabelAgent({ provider });

    const result = await agent.invokeSpeakerLabel(FIXED_ACTOR, input);
    const hidden = result.labels.find((label) => label.speakerId.kind === "unknown_to_reader");
    expect(hidden).toBeDefined();
    if (hidden && hidden.speakerId.kind === "unknown_to_reader") {
      expect(hidden.speakerId.maskedCharacterId).toBe("masked-shadow-001");
      expect(hidden.speakerId.internalCharacterId).toBe("char-maou");
    }
  });

  it("surfaces a bundle miss as RecordedBundleMissingError (no silent fallback)", async () => {
    const input = recordedInputFixture();
    const labels = recordedLabelsFor(input);
    const bundle: RecordedProviderBundle = {
      bundleId: "speaker-label-bundle-fixture-miss",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:speaker-label-judge",
      capturedRequestedModelId: input.modelMetadata.modelId,
      capturedProviderId: input.modelMetadata.providerId,
      capturedActualModelId: "openrouter:claude-opus-fixture",
      responses: {
        ["sha256:wrong-key-no-match"]: {
          content: JSON.stringify({
            schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
            labels,
          }),
          finishReason: "stop",
        },
      },
    };
    const provider = new RecordedModelProvider({ bundle });
    const agent = new SpeakerLabelAgent({ provider });
    const error = await agent.invokeSpeakerLabel(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordedBundleMissingError);
    if (error instanceof RecordedBundleMissingError) {
      expect(error.bundleId).toBe("speaker-label-bundle-fixture-miss");
    }
  });
});
