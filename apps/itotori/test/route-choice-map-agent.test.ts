import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  buildPrompt,
  ChoiceOptionOutOfOrderError,
  ChoiceUncitedError,
  computeChoiceKeySet,
  computeRouteKeySet,
  generateRouteChoiceMap,
  generateRouteChoiceMaps,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  ROUTE_CHOICE_KINDS,
  RouteChoiceMapInvalidKindError,
  RouteChoiceMapParseError,
  RouteMapEmptyInputError,
  RouteMapLocaleMismatchError,
  RouteUncitedError,
  UnknownRouteError,
  type BridgeUnitForRouteMap,
  type CuratedRouteRef,
  type RouteChoiceMapInput,
  type RouteChoiceMapModelProfile,
} from "../src/agents/route-choice-map/index.js";

const fixedNow = (): Date => new Date("2026-06-23T12:00:00Z");

function fakeModelProfile(): RouteChoiceMapModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-route-choice-map-v0",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsFixture(): BridgeUnitForRouteMap[] {
  return [
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "hash-a-1",
      speaker: "勇者",
      routeKey: "true-route",
      sceneKey: "scene-intro",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王様はうなずいた。",
      sourceHash: "hash-a-2",
      speaker: "王様",
      routeKey: "true-route",
      sceneKey: "scene-intro",
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.002.line.001",
      sourceText: "どちらの道を行きますか？",
      sourceHash: "hash-a-3",
      speaker: "narrator",
      routeKey: "true-route",
      sceneKey: "scene-choice",
      choiceContext: {
        choiceKey: "choice-fork-1",
      },
    },
    {
      bridgeUnitId: "019ed018-0000-7000-8000-000000000a04",
      sourceUnitKey: "scene.003.line.001",
      sourceText: "王女と再会した。",
      sourceHash: "hash-a-4",
      routeKey: "princess-route",
      sceneKey: "scene-princess",
    },
  ];
}

function curatedFixture(): CuratedRouteRef[] {
  return [
    { routeKey: "true-route", routeTitle: "真ルート" },
    { routeKey: "princess-route", routeTitle: "王女ルート" },
  ];
}

function inputFixture(): RouteChoiceMapInput {
  return {
    projectId: "019ed018-0000-7000-8000-000000000001",
    localeBranchId: "019ed018-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed018-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    units: unitsFixture(),
    curatedRoutes: curatedFixture(),
    modelProfile: fakeModelProfile(),
    now: fixedNow,
  };
}

const successPackJson = JSON.stringify({
  routes: [
    {
      routeKey: "true-route",
      routeTitle: "真ルート",
      routeSummary: "主人公と王様の物語の中核。",
      citedUnitIds: [
        "019ed018-0000-7000-8000-000000000a01",
        "019ed018-0000-7000-8000-000000000a02",
      ],
    },
    {
      routeKey: "princess-route",
      routeTitle: "王女ルート",
      routeSummary: "王女と再会する分岐ルート。",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
    },
  ],
  choices: [
    {
      choiceKey: "choice-fork-1",
      kind: "RouteBranch",
      fromRouteKey: "true-route",
      promptSummary: "どちらの道を行きますか",
      citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
      options: [
        {
          optionIndex: 0,
          optionLabel: "真の道を進む",
          targetRouteKey: "true-route",
          targetUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
        {
          optionIndex: 1,
          optionLabel: "王女を追う",
          targetRouteKey: "princess-route",
          targetUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
    },
  ],
});

describe("route-choice-map prompt template", () => {
  it("is byte-stable across calls (same input -> same hash)", () => {
    const input = inputFixture();
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    expect(a).toEqual(b);
    expect(promptHash(a)).toEqual(promptHash(b));
  });

  it("orders units by sourceUnitKey regardless of input order", () => {
    const base = inputFixture();
    const reversed: RouteChoiceMapInput = {
      ...base,
      units: [...base.units].reverse(),
    };
    expect(promptHash(buildPrompt(base))).toEqual(promptHash(buildPrompt(reversed)));
  });

  it("includes every curated route in the prompt", () => {
    const input = inputFixture();
    const rendered = buildPrompt(input);
    for (const ref of input.curatedRoutes) {
      expect(rendered.userText).toContain(ref.routeKey);
    }
  });

  it("declares the closed kind enum in the schema portion of the prompt", () => {
    const rendered = buildPrompt(inputFixture());
    for (const kind of ROUTE_CHOICE_KINDS) {
      expect(rendered.userText).toContain(kind);
    }
  });

  it("includes the prior map block when supplied", () => {
    const input: RouteChoiceMapInput = {
      ...inputFixture(),
      priorMap: {
        routes: [
          {
            routeKey: "true-route",
            routeTitle: "previous title",
            routeSummary: "previous summary",
          },
        ],
        choices: [],
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      },
    };
    const rendered = buildPrompt(input);
    expect(rendered.userText).toContain("previous summary");
    expect(rendered.userText).toContain("Prior map");
  });
});

describe("computeRouteKeySet / computeChoiceKeySet", () => {
  it("unions curator-declared routes with observed planner routeKeys", () => {
    const keys = computeRouteKeySet(inputFixture());
    expect(keys.has("true-route")).toBe(true);
    expect(keys.has("princess-route")).toBe(true);
  });

  it("collects every observed choiceKey", () => {
    const keys = computeChoiceKeySet(inputFixture());
    expect(keys.has("choice-fork-1")).toBe(true);
  });

  it("does not invent route keys outside the input", () => {
    const keys = computeRouteKeySet(inputFixture());
    expect(keys.has("phantom-route")).toBe(false);
  });
});

describe("generateRouteChoiceMap", () => {
  it("returns Fresh routes + Fresh choices with citations index-aligned to input units", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const output = await generateRouteChoiceMap(input, { provider });
    expect(output.routes).toHaveLength(2);
    expect(output.choices).toHaveLength(1);
    for (const route of output.routes) {
      expect(route.status).toBe("Fresh");
      expect(route.mapLocale).toBe("ja-JP");
      expect(route.citedUnitIds.length).toBeGreaterThan(0);
      expect(route.citedUnitHashes.length).toBe(route.citedUnitIds.length);
      expect(route.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION_V1);
      expect(route.generatedAt).toBe("2026-06-23T12:00:00.000Z");
      expect(route.promptHash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const choice of output.choices) {
      expect(choice.status).toBe("Fresh");
      expect(choice.mapLocale).toBe("ja-JP");
      expect(choice.citedUnitIds.length).toBeGreaterThan(0);
      expect(choice.citedUnitHashes.length).toBe(choice.citedUnitIds.length);
      expect(ROUTE_CHOICE_KINDS as ReadonlyArray<string>).toContain(choice.kind);
      expect(choice.options.length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < choice.options.length; i += 1) {
        expect(choice.options[i]?.optionIndex).toBe(i);
      }
    }
  });

  it("is byte-stable across two invocations (same prompt hash)", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const a = await generateRouteChoiceMap(input, { provider });
    const b = await generateRouteChoiceMap(input, { provider });
    const hashes = new Set<string>();
    for (const r of [...a.routes, ...b.routes]) {
      hashes.add(r.promptHash);
    }
    for (const c of [...a.choices, ...b.choices]) {
      hashes.add(c.promptHash);
    }
    expect(hashes.size).toBe(1);
  });

  it("rejects empty input", async () => {
    const input: RouteChoiceMapInput = { ...inputFixture(), units: [] };
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      RouteMapEmptyInputError,
    );
  });

  it("rejects empty source locale", async () => {
    const input: RouteChoiceMapInput = { ...inputFixture(), sourceLocale: "" };
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      RouteMapLocaleMismatchError,
    );
  });

  it("rejects a route with no citations (RouteUncitedError)", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      routes: [
        {
          routeKey: "true-route",
          routeTitle: "真ルート",
          routeSummary: "x",
          citedUnitIds: [],
        },
        {
          routeKey: "princess-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
      choices: [],
    });
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      RouteUncitedError,
    );
  });

  it("rejects a choice prompt with no citations (ChoiceUncitedError)", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      routes: [
        {
          routeKey: "true-route",
          routeTitle: "真ルート",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
        {
          routeKey: "princess-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
      choices: [
        {
          choiceKey: "choice-fork-1",
          kind: "RouteBranch",
          promptSummary: "x",
          citedUnitIds: [],
          options: [
            {
              optionIndex: 0,
              optionLabel: "x",
              targetUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
            },
          ],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      ChoiceUncitedError,
    );
  });

  it("rejects an unknown targetRouteKey (UnknownRouteError)", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      routes: [
        {
          routeKey: "true-route",
          routeTitle: "真ルート",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
        {
          routeKey: "princess-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
      choices: [
        {
          choiceKey: "choice-fork-1",
          kind: "RouteBranch",
          promptSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
          options: [
            {
              optionIndex: 0,
              optionLabel: "x",
              targetRouteKey: "missing-route",
              targetUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
            },
          ],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      UnknownRouteError,
    );
  });

  it("rejects an invalid closed-enum kind", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      routes: [
        {
          routeKey: "true-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
        {
          routeKey: "princess-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
      choices: [
        {
          choiceKey: "choice-fork-1",
          kind: "DialogueChoice",
          promptSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
          options: [
            {
              optionIndex: 0,
              optionLabel: "x",
              targetUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
            },
          ],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      RouteChoiceMapInvalidKindError,
    );
  });

  it("rejects option list with out-of-order indices (ChoiceOptionOutOfOrderError)", async () => {
    const input = inputFixture();
    const pack = JSON.stringify({
      routes: [
        {
          routeKey: "true-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
        },
        {
          routeKey: "princess-route",
          routeTitle: "x",
          routeSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a04"],
        },
      ],
      choices: [
        {
          choiceKey: "choice-fork-1",
          kind: "RouteBranch",
          promptSummary: "x",
          citedUnitIds: ["019ed018-0000-7000-8000-000000000a03"],
          options: [
            {
              optionIndex: 1, // wrong: should be 0
              optionLabel: "x",
              targetRouteKey: "true-route",
              targetUnitIds: ["019ed018-0000-7000-8000-000000000a01"],
            },
          ],
        },
      ],
    });
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => pack,
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      ChoiceOptionOutOfOrderError,
    );
  });

  it("rejects non-JSON provider output", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => "not-json",
    });
    await expect(generateRouteChoiceMap(input, { provider })).rejects.toBeInstanceOf(
      RouteChoiceMapParseError,
    );
  });

  it("emits source-locale map locale, not target", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const output = await generateRouteChoiceMap(input, { provider });
    for (const route of output.routes) {
      expect(route.mapLocale).toBe("ja-JP");
    }
    for (const choice of output.choices) {
      expect(choice.mapLocale).toBe("ja-JP");
    }
  });
});

describe("generateRouteChoiceMaps batch", () => {
  it("sequences inputs and returns one output per input", async () => {
    const input = inputFixture();
    const provider = new FakeModelProvider({
      providerName: "route-choice-map-fake",
      modelId: input.modelProfile.modelId,
      generate: () => successPackJson,
    });
    const results = await generateRouteChoiceMaps([input, input], { provider });
    expect(results).toHaveLength(2);
    expect(results[0]?.routes.length).toBe(2);
    expect(results[1]?.routes.length).toBe(2);
  });
});
