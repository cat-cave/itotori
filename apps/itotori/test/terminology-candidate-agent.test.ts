import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import { InMemoryContextArtifactRepository } from "../src/orchestrator/context-brain.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  buildConflictIndex,
  buildPrompt,
  generateTerminologyCandidates,
  generateTerminologyCandidatesBatch,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  runGenerateTerminologyCandidatesCli,
  type TerminologyCandidateCliDependencies,
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
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
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

function glossaryLookup(glossary: Map<string, string>, counter?: { count: number }) {
  return async (input: { projectId: string; surfaceForm: string }): Promise<string | null> => {
    expect(input.projectId).toBe(inputFixture().projectId);
    if (counter !== undefined) {
      counter.count += 1;
    }
    return glossary.get(input.surfaceForm) ?? null;
  };
}

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

  it("correctively retries a semantically invalid citation before accepting the pack", async () => {
    const input = inputFixture();
    const requests: ModelInvocationRequest[] = [];
    const invalidPack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "ハル",
          rationale: "主人公の固有名。",
          citedUnitIds: ["unknown-bridge-unit"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        requests.push(request);
        return requests.length === 1 ? invalidPack : successPackJson;
      },
    });
    const lookupCalls = { count: 0 };

    const output = await generateTerminologyCandidates(input, {
      provider,
      lookupExistingGlossaryTerm: glossaryLookup(new Map(), lookupCalls),
    });

    expect(output.candidates).toHaveLength(4);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "previous response failed with semantic_invalid",
    );
    expect(requests[1]?.messages.at(-1)?.content).toContain("unknown-bridge-unit");
    // Glossary/TOCTOU checks run only for the four candidates in the
    // accepted pack, never for the rejected model response.
    expect(lookupCalls.count).toBe(4);
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

  it("ITOTORI-220: providerId is propagated through to the ModelProvider call", async () => {
    const input = {
      ...inputFixture(),
      modelProfile: { ...fakeModelProfile(), providerId: "fake-fixture-pair-test" },
    };
    let observedProviderId: string | undefined;
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        observedProviderId = request.providerId;
        return successPackJson;
      },
    });
    await generateTerminologyCandidates(input, { provider });
    expect(observedProviderId).toBe("fake-fixture-pair-test");
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

  it("FILTERS (does not reject) a candidate that already exists in the supplied glossary", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "勇者", // already in the existing glossary → legitimate dedup
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
    // A glossary conflict is a legitimate dedup, NOT a failure: the conflicting
    // candidate is filtered (recorded in `deduped`), the call still resolves.
    const output = await generateTerminologyCandidates(input, { provider });
    expect(output.candidates).toHaveLength(0);
    expect(output.deduped).toEqual([
      { surfaceForm: "勇者", terminologyTermId: "019ed018-0000-7000-8000-000000000g01" },
    ]);
    // Telemetry is preserved even when everything deduped.
    expect(output.providerRun.runId.length).toBeGreaterThan(0);
  });

  it("ITOTORI-150: authoritative glossary lookup FILTERS the duplicate at pre-persist (no input-glossary conflict, no async round trip)", async () => {
    // Empty input glossary: the conflictIndex path finds NOTHING, so this
    // proves the authoritative glossary lookup is what fires — closing the TOCTOU
    // window (a curator inserted the term mid-run) synchronously at pre-persist
    // as a legitimate dedup filter rather than an asynchronous downstream reject.
    const input: TerminologyCandidateInput = { ...inputFixture(), existingGlossary: [] };
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "ハル", // appears in unit a01's text; NOT in input glossary
          rationale: "主人公の固有名。",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    const glossary = new Map([["ハル", "019ed018-0000-7000-8000-000000000t01"]]);
    const output = await generateTerminologyCandidates(input, {
      provider,
      lookupExistingGlossaryTerm: glossaryLookup(glossary),
    });
    expect(output.candidates).toHaveLength(0);
    expect(output.deduped).toEqual([
      { surfaceForm: "ハル", terminologyTermId: "019ed018-0000-7000-8000-000000000t01" },
    ]);
  });

  it("ITOTORI-150 (prod path): runGenerateTerminologyCandidatesCli forwards the authoritative glossary lookup", async () => {
    // Drive the PRODUCTION cli caller (which BUILDS the options internally) —
    // NOT the direct-options path above. Empty input glossary + a curator-inserted
    // glossary term proves cli.ts forwards `deps.lookupExistingGlossaryTerm`
    // into the agent options on the real caller path, closing the TOCTOU window
    // without reviving the retired terminology-candidate repository.
    const pack = JSON.stringify({
      candidates: [
        {
          kind: "ProperNoun",
          surfaceForm: "ハル", // appears in unit a01; NOT in the input glossary
          rationale: "主人公の固有名。",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: fakeModelProfile().modelId,
      generate: () => pack,
    });
    const glossary = new Map([["ハル", "019ed018-0000-7000-8000-000000000t01"]]);
    const deps: TerminologyCandidateCliDependencies = {
      actor: { userId: "test-user" },
      contextArtifactRepository: new InMemoryContextArtifactRepository(),
      provider,
      lookupExistingGlossaryTerm: glossaryLookup(glossary),
      // Empty existing glossary: only the authoritative lookup can catch the
      // conflict — so a throw here PROVES the repository wiring fired in prod.
      loadInputContext: async () => ({ units: unitsFixture(), existingGlossary: [] }),
    };
    const result = await runGenerateTerminologyCandidatesCli(
      {
        projectId: "019ed018-0000-7000-8000-000000000001",
        localeBranchId: "019ed018-0000-7000-8000-000000000002",
        sourceLocale: "ja-JP",
        sourceRevisionId: "019ed018-0000-7000-8000-000000000003",
        modelProfile: fakeModelProfile(),
        includeStale: true, // skip the skip-fresh load; the dup is filtered pre-persist
      },
      deps,
    );
    // The authoritative lookup filtered the sole (duplicate) candidate, so the
    // cli persists nothing — proving the repository wiring fired in prod (the
    // candidate would otherwise be valid) without throwing.
    expect(result.generatedCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
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

  it("filter-not-drop: a duplicate is filtered while the valid candidates in the SAME pack are kept, telemetry preserved", async () => {
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
    // successPackJson proposes ハル (now a glossary duplicate) + ミラ / 先輩 / 魔王城
    // (all valid). The ONE duplicate is filtered; the THREE valid candidates are
    // kept — the whole pack is NOT thrown away.
    const output = await generateTerminologyCandidates(input, { provider });
    expect(output.candidates.map((candidate) => candidate.surfaceForm).sort()).toEqual(
      ["ミラ", "先輩", "魔王城"].sort(),
    );
    expect(output.candidates.map((candidate) => candidate.surfaceForm)).not.toContain("ハル");
    expect(output.deduped).toEqual([{ surfaceForm: "ハル", terminologyTermId: "term-1" }]);
    // Telemetry / cost of the (successful) provider call is preserved.
    expect(output.providerRun.runId.length).toBeGreaterThan(0);
  });

  it("a MECHANICAL failure (unparseable model output) PROPAGATES — it is never masked as a glossary dedup", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "terminology-candidate-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "{ this is not valid terminology JSON",
    });
    // A malformed pack is a mechanical failure: it throws a typed parse error
    // (which rides the supervisor's retry/ceiling), NOT a silent proceed and
    // NOT anything catchable as a glossary conflict.
    await expect(generateTerminologyCandidates(input, { provider })).rejects.toBeInstanceOf(
      TerminologyCandidateParseError,
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
