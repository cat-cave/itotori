// ITOTORI-078 — Recorded-provider replay integration test for the QA seam.
//
// Builds a stub recorded bundle keyed on the deterministic promptHash and
// asserts that:
//   1. The QA agent successfully replays the bundle into a typed
//      QaInvocationResult that carries the expected findings AND the
//      recordedArtifactId of the bundle.
//   2. Same input + same bundle → same `findings` byte-equal across two
//      consecutive invocations (full reproducibility).
//   3. A bundle miss (wrong promptHash, etc.) is surfaced as a
//      RecordedBundleMissingError rather than silent fallback.

import { describe, expect, it } from "vitest";
import {
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedBundleMissingError,
  RecordedModelProvider,
  recordedBundleKey,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import { ZERO_COST } from "../src/providers/cost.js";
import {
  buildQaPrompt,
  makeStructuredQaFindingOutputFixture,
  QaAgent,
  qaPromptHash,
  representativeQaFindingsFixture,
  type QaBridgeUnit,
  type QaInvocationInput,
  type QaModelProfile,
} from "../src/agents/qa/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-23T12:00:00Z");

function modelProfile(): QaModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-qa-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsForRecordedTest(): QaBridgeUnit[] {
  return [
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "こんにちは、{player}。",
      sourceHash: "src-hash-1",
      draftText: "Hello, .",
      draftHash: "drf-hash-1",
      speaker: "narration",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "src-hash-2",
      draftText: "The warrior greeted the king.",
      draftHash: "drf-hash-2",
      speaker: "narration",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "魔王城の入口に到着した。",
      sourceHash: "src-hash-3",
      draftText: "They arrived at the demon castle entrance.",
      draftHash: "drf-hash-3",
      speaker: "narration",
    },
    {
      bridgeUnitId: "019ed079-0000-7000-8000-000000000a04",
      sourceUnitKey: "scene.001.line.004",
      sourceText: "彼は何かを言った。",
      sourceHash: "src-hash-4",
      draftText: "He said something.",
      draftHash: "drf-hash-4",
      speaker: "narration",
    },
  ];
}

function recordedInputFixture(): QaInvocationInput {
  return {
    draftJobId: "019ed079-0000-7000-8000-000000000d00",
    projectId: "019ed079-0000-7000-8000-000000000001",
    localeBranchId: "019ed079-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed079-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    units: unitsForRecordedTest(),
    glossary: [
      {
        termId: "019ed079-0000-7000-8000-00000000b001",
        preferredSourceForm: "勇者",
        preferredTargetForm: "hero",
        policyAction: "localize",
      },
    ],
    styleGuide: [
      {
        ruleId: "tone-001",
        section: "tone",
        guidance: "Use a formal register throughout the story.",
      },
    ],
    modelProfile: modelProfile(),
    qaPromptVersion: "itotori-qa-agent-v1",
    now: FIXED_NOW,
  };
}

function bundleFor(input: QaInvocationInput, findings: QaFinding[]): RecordedProviderBundle {
  const rendered = buildQaPrompt(input);
  // ITOTORI-220 — key by the pair-aware default bundle key.
  const bundleKey = recordedBundleKey({
    modelId: input.modelProfile.modelId,
    providerId: input.modelProfile.providerId,
    promptHash: `sha256:${qaPromptHash(rendered)}`,
    inputClassification: "private_corpus",
  });
  return {
    schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
    bundleId: "qa-bundle-fixture-001",
    capturedProviderFamily: "openrouter",
    capturedProviderName: "openrouter:qa-judge",
    capturedRequestedModelId: input.modelProfile.modelId,
    capturedProviderId: input.modelProfile.providerId,
    capturedActualModelId: "openrouter:claude-opus-fixture",
    responses: {
      [bundleKey]: {
        content: JSON.stringify(makeStructuredQaFindingOutputFixture(findings)),
        finishReason: "stop",
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 1024,
          completionTokens: 512,
          totalTokens: 1536,
        },
        // ITOTORI-228 — synthetic test bundle; the QA reproducibility
        // test asserts response shape, not cost-cap arithmetic. ZERO_COST
        // is structurally honest (no real charge was made).
        cost: ZERO_COST,
      },
    },
  };
}

describe("QaAgent + RecordedModelProvider integration", () => {
  it("REPRODUCIBILITY: same input + same bundle yields byte-equal findings across two invocations", async () => {
    const input = recordedInputFixture();
    // Adjust the representative fixture findings to cite units we actually
    // pass in — this is the recorded bundle's `findings` payload.
    const findings: QaFinding[] = representativeQaFindingsFixture().map((finding, index) => ({
      ...finding,
      bridgeUnitId: input.units[index]!.bridgeUnitId,
    }));
    const bundle = bundleFor(input, findings);
    const provider = new RecordedModelProvider({ bundle });
    const agent = new QaAgent({ provider });

    const first = await agent.invokeQa(FIXED_ACTOR, input);
    const second = await agent.invokeQa(FIXED_ACTOR, input);

    expect(JSON.stringify(first.findings)).toEqual(JSON.stringify(second.findings));
    expect(first.findings).toEqual(findings);
    expect(first.recordedArtifactId).toBe(bundle.bundleId);
    expect(second.recordedArtifactId).toBe(bundle.bundleId);
    // Prompt hash is byte-stable across the two invocations.
    expect(first.promptHashUsed).toEqual(second.promptHashUsed);
    // The recorded run preserves the captured provider identity.
    expect(first.modelMetadata.providerIdentity.providerName).toBe(bundle.capturedProviderName);
    expect(first.modelMetadata.providerIdentity.providerFamily).toBe(bundle.capturedProviderFamily);
    expect(first.modelMetadata.providerIdentity.actualModelId).toBe(bundle.capturedActualModelId);
    // Token usage from the captured payload flows through.
    expect(first.tokensIn).toBe(1024);
    expect(first.tokensOut).toBe(512);
    // Schema version of the parsed output matches the wire contract.
    // (Indirect: the agent only returns findings, so we round-trip through
    // makeStructuredQaFindingOutputFixture to assert the schemaVersion.)
    expect(makeStructuredQaFindingOutputFixture(first.findings).schemaVersion).toBe(
      STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    );
  });

  it("surfaces a bundle miss as RecordedBundleMissingError (no silent fallback)", async () => {
    const input = recordedInputFixture();
    // Intentionally key the bundle on a hash unrelated to the actual
    // prompt hash to force a miss.
    const findings: QaFinding[] = representativeQaFindingsFixture().map((finding, index) => ({
      ...finding,
      bridgeUnitId: input.units[index]!.bridgeUnitId,
    }));
    const bundle: RecordedProviderBundle = {
      schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
      bundleId: "qa-bundle-fixture-miss",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:qa-judge",
      capturedRequestedModelId: input.modelProfile.modelId,
      capturedProviderId: input.modelProfile.providerId,
      capturedActualModelId: "openrouter:claude-opus-fixture",
      responses: {
        ["sha256:wrong-key-no-match"]: {
          content: JSON.stringify(makeStructuredQaFindingOutputFixture(findings)),
          finishReason: "stop",
          // ITOTORI-228 — see note above; bundle-miss test, ZERO_COST.
          cost: ZERO_COST,
        },
      },
    };
    const provider = new RecordedModelProvider({ bundle });
    const agent = new QaAgent({ provider });
    const error = await agent.invokeQa(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordedBundleMissingError);
    if (error instanceof RecordedBundleMissingError) {
      expect(error.bundleId).toBe("qa-bundle-fixture-miss");
      expect(error.availableKeys).toEqual(["sha256:wrong-key-no-match"]);
    }
  });
});
