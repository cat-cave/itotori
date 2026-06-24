import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  buildConflictIndex,
  buildPrompt,
  ExistingGlossaryConflictError,
  generateTerminologyCandidates,
  generateTerminologyCandidatesBatch,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  TERMINOLOGY_CANDIDATE_KINDS,
  TerminologyCandidateEmptyInputError,
  TerminologyCandidateInvalidKindError,
  TerminologyCandidateLocaleMismatchError,
  TerminologyCandidateNotInUnitsError,
  TerminologyCandidateParseError,
  TerminologyCandidateUncitedError,
  TerminologyCandidateUnknownCitationError,
  type BridgeUnitForTerminology,
  type ExistingGlossaryEntry,
  type TerminologyCandidateInput,
  type TerminologyCandidateModelProfile,
} from "../src/agents/terminology-candidate/index.js";

const fixedNow = (): Date => new Date("2026-06-23T12:00:00Z");

function fakeModelProfile(): TerminologyCandidateModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-terminology-candidate-v0",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): BridgeUnitForTerminology[] {
  return [
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者ハルは王様に挨拶した。",
      sourceHash: "hash-a-1",
      speaker: "勇者",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王女ミラは沙友里先輩を呼んだ。",
      sourceHash: "hash-a-2",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "魔王城の入口に到着した。",
      sourceHash: "hash-a-3",
    },
  ];
}

function existingGlossaryFixture(): ExistingGlossaryEntry[] {
  return [
    {
      terminologyTermId: "019ed018-0000-7000-8000-000000000g01",
      preferredSourceForm: "勇者",
      aliases: ["勇者"],
      kind: "ProperNoun",
    },
  ];
}

function inputFixture(): TerminologyCandidateInput {
  return {
    projectId: "019ed018-0000-7000-8000-000000000001",
    localeBranchId: "019ed018-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed018-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    units: unitsFixture(),
    existingGlossary: existingGlossaryFixture(),
    modelProfile: fakeModelProfile(),
    now: fixedNow,
  };
}

const successPackJson = JSON.stringify({
  candidates: [
    {
      kind: "ProperNoun",
      surfaceForm: "ハル",
      rationale: "主人公の固有名。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
    },
    {
      kind: "ProperNoun",
      surfaceForm: "ミラ",
      rationale: "王女の固有名。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a02"],
    },
    {
      kind: "TitleOrHonorific",
      surfaceForm: "先輩",
      rationale: "学校上下関係の敬称。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a02"],
    },
    {
      kind: "WrittenSign",
      surfaceForm: "魔王城",
      rationale: "場所名・看板。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
    },
  ],
});

describe("terminology-candidate prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    expect(a).toEqual(b);
    expect(promptHash(a)).toEqual(promptHash(b));
  });

  it("orders units by sourceUnitKey regardless of input order", () => {
    const base = inputFixture();
    const reversed: TerminologyCandidateInput = {
      ...base,
      units: [...base.units].reverse(),
    };
    expect(promptHash(buildPrompt(base))).toEqual(promptHash(buildPrompt(reversed)));
  });

  it("includes every existing glossary preferredSourceForm in the prompt", () => {
    const input = inputFixture();
    const rendered = buildPrompt(input);
    for (const entry of input.existingGlossary) {
      expect(rendered.userText).toContain(entry.preferredSourceForm);
    }
  });

  it("declares the closed kind enum in the schema portion of the prompt", () => {
    const rendered = buildPrompt(inputFixture());
    for (const kind of TERMINOLOGY_CANDIDATE_KINDS) {
      expect(rendered.userText).toContain(kind);
    }
  });
});

describe("buildConflictIndex", () => {
  it("maps every preferredSourceForm and alias to the owning term id", () => {
    const index = buildConflictIndex([
      {
        terminologyTermId: "term-1",
        preferredSourceForm: "勇者",
        aliases: ["勇者", "ハル"],
      },
    ]);
    expect(index.get("勇者")).toBe("term-1");
    expect(index.get("ハル")).toBe("term-1");
  });

  it("returns undefined for unknown surface forms", () => {
    const index = buildConflictIndex([]);
    expect(index.get("anything")).toBeUndefined();
  });
});

describe("generateTerminologyCandidates", () => {
  it("returns Fresh candidates with citations index-aligned to input units", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const output = await generateTerminologyCandidates(input, { provider });
    expect(output.candidates).toHaveLength(4);
    for (const candidate of output.candidates) {
      expect(candidate.status).toBe("Fresh");
      expect(candidate.surfaceLocale).toBe("ja-JP");
      expect(candidate.citedUnitIds.length).toBeGreaterThan(0);
      expect(candidate.citedUnitHashes.length).toBe(candidate.citedUnitIds.length);
      expect(candidate.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION_V1);
      expect(candidate.generatedAt).toBe("2026-06-23T12:00:00.000Z");
      expect(candidate.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(TERMINOLOGY_CANDIDATE_KINDS as ReadonlyArray<string>).toContain(candidate.kind);
    }
  });

  it("is byte-stable across two invocations (same prompt hash)", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const a = await generateTerminologyCandidates(input, { provider });
    const b = await generateTerminologyCandidates(input, { provider });
    const hashes = new Set<string>();
    for (const c of [...a.candidates, ...b.candidates]) {
      hashes.add(c.promptHash);
    }
    expect(hashes.size).toBe(1);
  });

  it("rejects empty input", async () => {
    const input: TerminologyCandidateInput = { ...inputFixture(), units: [] };
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateEmptyInputError,
    );
  });

  it("rejects empty source locale", async () => {
    const input: TerminologyCandidateInput = { ...inputFixture(), sourceLocale: "" };
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateLocaleMismatchError,
    );
  });

  it("rejects a candidate that already exists in the supplied glossary", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "勇者", // conflicts with existing glossary
          rationale: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      ExistingGlossaryConflictError,
    );
  });

  it("rejects a candidate with empty citation list (TerminologyCandidateUncitedError)", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "ハル",
          rationale: "x",
          citedUnitIds: [],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateUncitedError,
    );
  });

  it("rejects an unknown cited bridge unit id", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "ハル",
          rationale: "x",
          citedUnitIds: ["unknown-bridge-unit"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateUnknownCitationError,
    );
  });

  it("rejects a hallucinated surface form not appearing in any cited unit", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "存在しない名前", // not in any cited unit's text
          rationale: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateNotInUnitsError,
    );
  });

  it("rejects an invalid closed-enum kind", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "Nickname", // not in the closed enum
          surfaceForm: "ハル",
          rationale: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateInvalidKindError,
    );
  });

  it("rejects non-JSON provider output", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "not-json",
    });
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateParseError,
    );
  });

  it("emits source-locale surface locale, not target", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const output = await generateTerminologyCandidates(input, { provider });
    for (const candidate of output.candidates) {
      expect(candidate.surfaceLocale).toBe("ja-JP");
    }
  });

  it("conflict-index property: if a surface form is in existingGlossary, the agent never emits it", async () => {
    const input: TerminologyCandidateInput = {
      ...inputFixture(),
      existingGlossary: [
        {
          terminologyTermId: "term-1",
          preferredSourceForm: "ハル",
          aliases: ["ハル"],
        },
        ...existingGlossaryFixture(),
      ],
    };
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    // The successPackJson contains "ハル" which now conflicts.
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      ExistingGlossaryConflictError,
    );
  });
});

describe("generateTerminologyCandidatesBatch", () => {
  it("sequences inputs and returns one output per input", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const results = await generateTerminologyCandidatesBatch([input, input], { provider });
    expect(results).toHaveLength(2);
    expect(results[0]?.candidates.length).toBe(4);
    expect(results[1]?.candidates.length).toBe(4);
  });
});
