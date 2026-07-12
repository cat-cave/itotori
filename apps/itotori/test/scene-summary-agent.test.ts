import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  buildPrompt,
  generateSceneSummaries,
  generateSceneSummary,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  SceneSummaryEmptyInputError,
  SceneSummaryLocaleMismatchError,
  type BridgeUnitForSummary,
  type SceneSummaryInput,
  type SceneSummaryModelProfile,
} from "../src/agents/scene-summary/index.js";
import type { GlossaryRef } from "../src/batch-planner/shapes.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const fixedNow = (): Date => new Date("2026-06-23T12:00:00Z");

function fakeModelProfile(): SceneSummaryModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-scene-summary-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 256,
  };
}

function unitsFixture(): BridgeUnitForSummary[] {
  return [
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "hash-a-1",
      speaker: "勇者",
      occurrenceId: "occ-1",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王様はうなずいた。",
      sourceHash: "hash-a-2",
      speaker: "王様",
      occurrenceId: "occ-2",
    },
  ];
}

function glossaryFixture(): GlossaryRef[] {
  return [
    {
      termId: "term-yusha",
      termKey: "yusha",
      preferredSourceForm: "勇者",
      preferredTargetForm: "hero",
      hitBridgeUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
    },
    {
      termId: "term-osama",
      termKey: "osama",
      preferredSourceForm: "王様",
      preferredTargetForm: "king",
      hitBridgeUnitIds: ["019ed018-0000-7000-8000-000000000a02"],
    },
  ];
}

function inputFixture(): SceneSummaryInput {
  return {
    projectId: "019ed018-0000-7000-8000-000000000001",
    localeBranchId: "019ed018-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed018-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    sceneId: "scene-001",
    units: unitsFixture(),
    glossaryExcerpt: glossaryFixture(),
    modelProfile: fakeModelProfile(),
    now: fixedNow,
    sceneSummaryId: "019ed018-0000-7000-8000-000000000a00",
  };
}

describe("scene-summary prompt template", () => {
  it("is byte-stable across calls (same input -> same bytes -> same hash)", () => {
    const input = inputFixture();
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    expect(a).toEqual(b);
    expect(promptHash(a)).toEqual(promptHash(b));
  });

  it("orders units by sourceUnitKey + occurrenceId regardless of input order", () => {
    const base = inputFixture();
    const reversed: SceneSummaryInput = {
      ...base,
      units: [...base.units].reverse(),
    };
    expect(promptHash(buildPrompt(base))).toEqual(promptHash(buildPrompt(reversed)));
  });

  it("includes every glossary term verbatim", () => {
    const input = inputFixture();
    const rendered = buildPrompt(input);
    for (const term of input.glossaryExcerpt) {
      expect(rendered.userText).toContain(term.preferredSourceForm);
      expect(rendered.userText).toContain(term.termKey);
    }
  });

  it("includes prior summary block when supplied", () => {
    const input: SceneSummaryInput = {
      ...inputFixture(),
      priorSummary: {
        summaryText: "previously, the hero met the king.",
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      },
    };
    const rendered = buildPrompt(input);
    expect(rendered.userText).toContain("previously, the hero met the king.");
    expect(rendered.userText).toContain("Prior summary (extend, do not repeat):");
  });
});

describe("generateSceneSummary", () => {
  it("returns a Fresh summary with citations index-aligned to input units", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "勇者が王様に挨拶し、王様はうなずいた。",
    });
    const { summary } = await generateSceneSummary(input, { provider });

    expect(summary.status).toBe("Fresh");
    expect(summary.summaryLocale).toBe("ja-JP");
    expect(summary.summaryText).toBe("勇者が王様に挨拶し、王様はうなずいた。");
    expect(summary.citedUnitIds).toEqual(input.units.map((unit) => unit.bridgeUnitId));
    expect(summary.citedUnitHashes).toEqual(input.units.map((unit) => unit.sourceHash));
    expect(summary.citedUnitIds.length).toBe(input.units.length);
    expect(summary.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION_V1);
    expect(summary.id).toBe(input.sceneSummaryId);
    expect(summary.generatedAt).toBe("2026-06-23T12:00:00.000Z");
    expect(summary.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("correctively retries an empty response before accepting the summary", async () => {
    const input = inputFixture();
    const requests: ModelInvocationRequest[] = [];
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        requests.push(request);
        return requests.length === 1 ? "" : "Corrected scene summary.";
      },
    });

    const output = await generateSceneSummary(input, { provider });

    expect(output.summary.summaryText).toBe("Corrected scene summary.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain("previous response failed with empty");
  });

  it("is deterministic byte-for-byte across two invocations", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "summary",
    });
    const a = await generateSceneSummary(input, { provider });
    const b = await generateSceneSummary(input, { provider });
    expect(a.summary.summaryText).toBe(b.summary.summaryText);
    expect(a.summary.promptHash).toBe(b.summary.promptHash);
    expect(a.summary.citedUnitIds).toEqual(b.summary.citedUnitIds);
    expect(a.summary.citedUnitHashes).toEqual(b.summary.citedUnitHashes);
    expect(a.summary.inputTokenEstimate).toBe(b.summary.inputTokenEstimate);
  });

  it("ITOTORI-220: providerId is propagated through to the ModelProvider call", async () => {
    const input: SceneSummaryInput = {
      ...inputFixture(),
      modelProfile: { ...fakeModelProfile(), providerId: "fake-fixture-pair-test" },
    };
    let observedProviderId: string | undefined;
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        observedProviderId = request.providerId;
        return "ok";
      },
    });
    await generateSceneSummary(input, { provider });
    expect(observedProviderId).toBe("fake-fixture-pair-test");
  });

  it("refuses empty input", async () => {
    const input: SceneSummaryInput = { ...inputFixture(), units: [] };
    const provider = new FakeModelProvider();
    await expect(generateSceneSummary(input, { provider })).rejects.toBeInstanceOf(
      SceneSummaryEmptyInputError,
    );
  });

  it("refuses empty sourceLocale (defends target-language drift)", async () => {
    const input: SceneSummaryInput = { ...inputFixture(), sourceLocale: "" };
    const provider = new FakeModelProvider();
    await expect(generateSceneSummary(input, { provider })).rejects.toBeInstanceOf(
      SceneSummaryLocaleMismatchError,
    );
  });

  it("sequences batches via generateSceneSummaries", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "scene-summary-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "summary",
    });
    const results = await generateSceneSummaries(
      [
        input,
        {
          ...input,
          sceneId: "scene-002",
          sceneSummaryId: "019ed018-0000-7000-8000-000000000a10",
        },
      ],
      { provider },
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.summary.sceneId)).toEqual(["scene-001", "scene-002"]);
  });

  it("emits no live provider construction at import time (live opt-in only)", () => {
    expect(process.env.ITOTORI_LIVE_PROVIDER ?? "").toBe("");
  });
});
