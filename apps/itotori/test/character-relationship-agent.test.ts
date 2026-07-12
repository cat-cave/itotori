import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  buildPrompt,
  CHARACTER_RELATIONSHIP_KINDS,
  CharacterRelationshipEmptyInputError,
  CharacterRelationshipInvalidKindError,
  CharacterRelationshipLocaleMismatchError,
  CharacterRelationshipParseError,
  CharacterRelationshipUncitedEdgeError,
  CharacterRelationshipUnknownCharacterError,
  CharacterRelationshipUnknownCitationError,
  computeRoster,
  generateCharacterRelationships,
  generateCharacterRelationshipsBatch,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  type BridgeUnitForCharacter,
  type CharacterRelationshipInput,
  type CharacterRelationshipModelProfile,
  type CuratedCharacterRef,
} from "../src/agents/character-relationship/index.js";
import type { GlossaryRef } from "../src/batch-planner/shapes.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";

const fixedNow = (): Date => new Date("2026-06-23T12:00:00Z");

function fakeModelProfile(): CharacterRelationshipModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-character-relationship-v0",
    // ITOTORI-220 — required (modelId, providerId) pair.
    providerId: "fake-fixture",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): BridgeUnitForCharacter[] {
  return [
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "hash-a-1",
      speaker: "勇者",
      addressees: ["王様"],
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王様はうなずいた。",
      sourceHash: "hash-a-2",
      speaker: "王様",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "勇者と王女は古くからの友人だ。",
      sourceHash: "hash-a-3",
      speaker: "narrator",
      addressees: ["勇者", "王女"],
    },
  ];
}

function curatedFixture(): CuratedCharacterRef[] {
  return [
    { characterId: "勇者", displayName: "勇者ハル" },
    { characterId: "王様", displayName: "王" },
    { characterId: "王女", displayName: "王女ミラ" },
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
  ];
}

function inputFixture(): CharacterRelationshipInput {
  return {
    projectId: "019ed018-0000-7000-8000-000000000001",
    localeBranchId: "019ed018-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed018-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    units: unitsFixture(),
    curatedCharacters: curatedFixture(),
    glossaryExcerpt: glossaryFixture(),
    modelProfile: fakeModelProfile(),
    now: fixedNow,
  };
}

const successPackJson = JSON.stringify({
  bios: [
    {
      characterId: "勇者",
      bioText: "物語の主人公。王様と王女に深く関わる。",
      citedUnitIds: [
        "019ed018-0000-7000-8000-000000000a01",
        "019ed018-0000-7000-8000-000000000a03",
      ],
    },
    {
      characterId: "王様",
      bioText: "この国の統治者。勇者を信頼している。",
      citedUnitIds: [
        "019ed018-0000-7000-8000-000000000a01",
        "019ed018-0000-7000-8000-000000000a02",
      ],
    },
    {
      characterId: "王女",
      bioText: "勇者の古くからの友人。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
    },
  ],
  relationships: [
    {
      fromCharacterId: "勇者",
      toCharacterId: "王様",
      kind: "Allegiance",
      direction: "FromAToB",
      descriptor: "勇者は王様に仕える",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
    },
    {
      fromCharacterId: "勇者",
      toCharacterId: "王女",
      kind: "Friendship",
      direction: "Symmetric",
      descriptor: "幼馴染",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
    },
  ],
});

describe("character-relationship prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    expect(a).toEqual(b);
    expect(promptHash(a)).toEqual(promptHash(b));
  });

  it("orders units by sourceUnitKey regardless of input order", () => {
    const base = inputFixture();
    const reversed: CharacterRelationshipInput = {
      ...base,
      units: [...base.units].reverse(),
    };
    expect(promptHash(buildPrompt(base))).toEqual(promptHash(buildPrompt(reversed)));
  });

  it("includes every curated character verbatim in the prompt", () => {
    const input = inputFixture();
    const rendered = buildPrompt(input);
    for (const ref of input.curatedCharacters) {
      expect(rendered.userText).toContain(ref.characterId);
    }
  });

  it("includes every glossary term verbatim in the prompt", () => {
    const input = inputFixture();
    const rendered = buildPrompt(input);
    for (const term of input.glossaryExcerpt) {
      expect(rendered.userText).toContain(term.termKey);
      expect(rendered.userText).toContain(term.preferredSourceForm);
    }
  });

  it("declares the closed kind enum in the schema portion of the prompt", () => {
    const rendered = buildPrompt(inputFixture());
    for (const kind of CHARACTER_RELATIONSHIP_KINDS) {
      expect(rendered.userText).toContain(kind);
    }
  });

  it("includes the prior pack block when supplied", () => {
    const input: CharacterRelationshipInput = {
      ...inputFixture(),
      priorPack: {
        bios: [{ characterId: "勇者", bioText: "previous bio" }],
        relationships: [
          {
            fromCharacterId: "勇者",
            toCharacterId: "王様",
            kind: "Allegiance",
            descriptor: "previous descriptor",
          },
        ],
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      },
    };
    const rendered = buildPrompt(input);
    expect(rendered.userText).toContain("previous bio");
    expect(rendered.userText).toContain("Prior pack");
  });
});

describe("computeRoster", () => {
  it("unions curator-promoted ids with observed speakers and addressees", () => {
    const roster = computeRoster(inputFixture());
    expect(roster.has("勇者")).toBe(true);
    expect(roster.has("王様")).toBe(true);
    expect(roster.has("王女")).toBe(true);
    expect(roster.has("narrator")).toBe(true); // observed as speaker
  });

  it("does not invent characters", () => {
    const roster = computeRoster(inputFixture());
    expect(roster.has("勇者の弟")).toBe(false);
  });
});

describe("generateCharacterRelationships", () => {
  it("returns Fresh bios + Fresh relationships with citations index-aligned to input units", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const output = await generateCharacterRelationships(input, { provider });

    expect(output.bios).toHaveLength(3);
    expect(output.relationships).toHaveLength(2);
    for (const bio of output.bios) {
      expect(bio.status).toBe("Fresh");
      expect(bio.bioLocale).toBe("ja-JP");
      expect(bio.citedUnitIds.length).toBeGreaterThan(0);
      expect(bio.citedUnitHashes.length).toBe(bio.citedUnitIds.length);
      expect(bio.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION_V1);
      expect(bio.generatedAt).toBe("2026-06-23T12:00:00.000Z");
      expect(bio.promptHash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const rel of output.relationships) {
      expect(rel.status).toBe("Fresh");
      expect(rel.descriptorLocale).toBe("ja-JP");
      expect(rel.citedUnitIds.length).toBeGreaterThan(0);
      expect(rel.citedUnitHashes.length).toBe(rel.citedUnitIds.length);
      expect(CHARACTER_RELATIONSHIP_KINDS as ReadonlyArray<string>).toContain(rel.kind);
    }
  });

  it("correctively retries malformed structured output before accepting the pack", async () => {
    const input = inputFixture();
    const requests: ModelInvocationRequest[] = [];
    const invalidPack = JSON.stringify({ bios: "not-an-array", relationships: [] });
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        requests.push(request);
        return requests.length === 1 ? invalidPack : successPackJson;
      },
    });

    const output = await generateCharacterRelationships(input, { provider });

    expect(output.bios).toHaveLength(3);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-2)?.content).toBe(invalidPack);
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "previous response failed with schema_invalid",
    );
  });

  it("ITOTORI-220: providerId is propagated through to the ModelProvider call", async () => {
    const input = {
      ...inputFixture(),
      modelProfile: { ...fakeModelProfile(), providerId: "fake-fixture-pair-test" },
    };
    let observedProviderId: string | undefined;
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: (request) => {
        observedProviderId = request.providerId;
        return successPackJson;
      },
    });
    await generateCharacterRelationships(input, { provider });
    expect(observedProviderId).toBe("fake-fixture-pair-test");
  });

  it("is byte-stable across two invocations (same prompt hash)", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const a = await generateCharacterRelationships(input, { provider });
    const b = await generateCharacterRelationships(input, { provider });
    // The prompt hash is computed from the rendered prompt only — it does
    // NOT depend on the provider output, so two calls with the same input
    // must produce identical prompt hashes across every record.
    const promptHashes = new Set<string>();
    for (const bio of [...a.bios, ...b.bios]) {
      promptHashes.add(bio.promptHash);
    }
    for (const rel of [...a.relationships, ...b.relationships]) {
      promptHashes.add(rel.promptHash);
    }
    expect(promptHashes.size).toBe(1);
  });

  it("refuses empty input with CharacterRelationshipEmptyInputError", async () => {
    const input: CharacterRelationshipInput = {
      ...inputFixture(),
      units: [],
      curatedCharacters: [],
    };
    const provider = new FakeModelProvider();
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipEmptyInputError,
    );
  });

  it("refuses empty sourceLocale (defends target-language drift)", async () => {
    const input: CharacterRelationshipInput = {
      ...inputFixture(),
      sourceLocale: "",
    };
    const provider = new FakeModelProvider();
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipLocaleMismatchError,
    );
  });

  it("rejects a relationship with no citations (CharacterRelationshipUncitedEdgeError)", async () => {
    const uncitedPack = JSON.stringify({
      bios: [
        {
          characterId: "勇者",
          bioText: "bio",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
      relationships: [
        {
          fromCharacterId: "勇者",
          toCharacterId: "王様",
          kind: "Allegiance",
          direction: "FromAToB",
          descriptor: "desc",
          citedUnitIds: [],
        },
      ],
    });
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => uncitedPack,
    });
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipUncitedEdgeError,
    );
  });

  it("rejects a bio for a character not in the roster (CharacterRelationshipUnknownCharacterError)", async () => {
    const ghostPack = JSON.stringify({
      bios: [
        {
          characterId: "GhostCharacter",
          bioText: "bio",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
      relationships: [],
    });
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => ghostPack,
    });
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipUnknownCharacterError,
    );
  });

  it("rejects a citation to a unit not in input.units", async () => {
    const badCitationPack = JSON.stringify({
      bios: [
        {
          characterId: "勇者",
          bioText: "bio",
          citedUnitIds: ["019ed018-0000-7000-8000-ffffffffffff"],
        },
      ],
      relationships: [],
    });
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => badCitationPack,
    });
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipUnknownCitationError,
    );
  });

  it("rejects an invalid kind value", async () => {
    const invalidKindPack = JSON.stringify({
      bios: [],
      relationships: [
        {
          fromCharacterId: "勇者",
          toCharacterId: "王様",
          kind: "TotallyBogus",
          direction: "Symmetric",
          descriptor: "desc",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
      ],
    });
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => invalidKindPack,
    });
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipInvalidKindError,
    );
  });

  it("rejects unparseable provider output", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "not-json",
    });
    await expect(generateCharacterRelationships(input, { provider })).rejects.toBeInstanceOf(
      CharacterRelationshipParseError,
    );
  });

  it("sequences batches via generateCharacterRelationshipsBatch", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "character-relationship-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const results = await generateCharacterRelationshipsBatch([input, input], { provider });
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.bios.length).toBeGreaterThan(0);
    }
  });

  it("emits no live provider construction at import time (live opt-in only)", () => {
    expect(process.env.ITOTORI_LIVE_PROVIDER ?? "").toBe("");
  });
});
