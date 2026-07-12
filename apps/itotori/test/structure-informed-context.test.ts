// itotori-structure-informed-context-building — tests.
//
// Proves: (1) the structure extraction produces the scene-graph + choice-map
// + speakers + message-stream FROM THE DECODE (a synthetic NarrativeStructure
// fixture that mirrors the exact JSON shape the Rust exporter emits — the
// artifacts are read from it, never re-inferred from prose); (2) the three
// context artifacts are built from that structure; (3) the translate stage's
// prompt receives the injected context and is byte-identical to the baseline
// when the context is absent.

import { describe, expect, it } from "vitest";
import {
  buildCharacterArcs,
  buildRouteBranchMap,
  buildSceneSummaries,
  buildSliceStructuredContext,
  buildStructureContextArtifacts,
  NarrativeStructureParseError,
  parseNarrativeStructure,
  StructuredContextSceneNotFoundError,
  type NarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";
import { buildTranslationPrompt } from "../src/agents/translation/prompt-template.js";
import { TRANSLATION_PROMPT_TEMPLATE_VERSION_V1 } from "../src/agents/translation/shapes.js";
import type { TranslationInvocationInput } from "../src/agents/translation/shapes.js";

// A synthetic decode fixture. Its SHAPE is exactly what
// `utsushi structure` emits for a real Sweetie
// playthrough (two scenes, a real cross-scene dispatch edge, `#NAMAE`
// speakers, and a 2-option choice per scene) — but the text is invented, so
// no copyrighted bytes live in the repo. The builders consume this KNOWN
// structure; they do not parse the prose to recover it.
const SYNTHETIC_STRUCTURE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 6010,
  sceneDispatchOrder: [6010, 6011],
  scenes: [
    {
      sceneId: 6010,
      nextScene: 6011,
      dispatchFanoutScenes: [7000],
      messages: [
        { order: 0, speaker: "Aoi", text: "Morning already?", textSurface: null },
        { order: 1, speaker: null, text: "The room was still dim.", textSurface: null },
        { order: 2, speaker: "Mari", text: "You're late.", textSurface: null },
        { order: 3, speaker: "Aoi", text: "Sorry.", textSurface: null },
      ],
      choices: [
        {
          optionIndex: 0,
          label: "Apologize",
          branchEntryScene: null,
          branchMessages: [
            { order: 0, speaker: "Mari", text: "Fine, hurry up.", textSurface: null },
          ],
        },
        {
          optionIndex: 1,
          label: "Stay quiet",
          branchEntryScene: null,
          branchMessages: [
            { order: 0, speaker: "Mari", text: "...Whatever.", textSurface: null },
            { order: 1, speaker: "Aoi", text: "...", textSurface: null },
          ],
        },
      ],
    },
    {
      sceneId: 6011,
      nextScene: null,
      messages: [
        { order: 0, speaker: "Mari", text: "So about earlier.", textSurface: null },
        { order: 1, speaker: "Aoi", text: "Yeah?", textSurface: null },
      ],
      choices: [],
    },
  ],
};

function untyped(value: NarrativeStructure): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("parseNarrativeStructure (consumes the decode JSON, validates shape)", () => {
  it("accepts the exporter's shape and round-trips it", () => {
    const parsed = parseNarrativeStructure(untyped(SYNTHETIC_STRUCTURE));
    expect(parsed.entryScene).toBe(6010);
    expect(parsed.sceneDispatchOrder).toEqual([6010, 6011]);
    expect(parsed.scenes).toHaveLength(2);
    // The scene-graph edge is READ, not inferred.
    expect(parsed.scenes[0]?.nextScene).toBe(6011);
    // Raw dispatch fanout is READ separately from choice text.
    expect(parsed.scenes[0]?.dispatchFanoutScenes).toEqual([7000]);
    // The speaker decode is READ from the messages.
    expect(parsed.scenes[0]?.messages[0]?.speaker).toBe("Aoi");
    // The choice/branch subsystem is READ.
    expect(parsed.scenes[0]?.choices).toHaveLength(2);
    expect(parsed.scenes[0]?.choices[1]?.branchMessages).toHaveLength(2);
  });

  it("rejects a wrong schemaVersion loudly (no silent coerce)", () => {
    const bad = { ...untyped(SYNTHETIC_STRUCTURE), schemaVersion: "nope" } as unknown;
    expect(() => parseNarrativeStructure(bad)).toThrow(NarrativeStructureParseError);
  });

  it("rejects a scene with a non-numeric sceneId", () => {
    const broken = untyped(SYNTHETIC_STRUCTURE);
    const scenes = broken.scenes as Array<{ sceneId: unknown }>;
    scenes[0]!.sceneId = "x";
    expect(() => parseNarrativeStructure(broken)).toThrow(NarrativeStructureParseError);
  });
});

describe("buildSceneSummaries (from the message STREAM)", () => {
  it("reduces each scene's stream into speaker presence, counts, gating, successor", () => {
    const summaries = buildSceneSummaries(SYNTHETIC_STRUCTURE);
    expect(summaries).toHaveLength(2);
    const scene6010 = summaries.find((s) => s.sceneId === 6010);
    expect(scene6010).toBeDefined();
    expect(scene6010?.messageCount).toBe(4);
    // Distinct speakers in first-appearance order (narration skipped).
    expect(scene6010?.speakers).toEqual(["Aoi", "Mari"]);
    expect(scene6010?.openingSpeaker).toBe("Aoi");
    expect(scene6010?.hasChoices).toBe(true);
    expect(scene6010?.choiceCount).toBe(2);
    expect(scene6010?.nextScene).toBe(6011);
    expect(scene6010?.artifactRef).toBe("scene-summary:6010");
    // Summary names counts + labels only (no script prose leaks).
    expect(scene6010?.summaryText).toContain("4 play-order messages");
    expect(scene6010?.summaryText).toContain("dispatches to scene 6011");
  });
});

describe("buildRouteBranchMap (from the dispatch + choice graph)", () => {
  it("emits a dispatch edge per cross-scene target and a choice edge per option", () => {
    const map = buildRouteBranchMap(SYNTHETIC_STRUCTURE);
    expect(map.entryScene).toBe(6010);
    expect(map.dispatchOrder).toEqual([6010, 6011]);
    const dispatch = map.edges.filter((e) => e.kind === "dispatch");
    expect(dispatch).toEqual([
      { fromScene: 6010, to: "6011", kind: "dispatch" },
      { fromScene: 6010, to: "7000", kind: "dispatch" },
    ]);
    const choices = map.edges.filter((e) => e.kind === "choice");
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      fromScene: 6010,
      to: "6010#choice:0",
      choiceIndex: 0,
      choiceLabel: "Apologize",
      branchMessageCount: 1,
    });
    expect(choices[1]?.branchMessageCount).toBe(2);
  });
});

describe("buildCharacterArcs (speaker presence across scenes)", () => {
  it("tracks each speaker's scenes + per-scene line counts in dispatch order", () => {
    const arcs = buildCharacterArcs(SYNTHETIC_STRUCTURE);
    const aoi = arcs.find((a) => a.speaker === "Aoi");
    const mari = arcs.find((a) => a.speaker === "Mari");
    expect(aoi).toBeDefined();
    expect(mari).toBeDefined();
    // Aoi speaks in both scenes: 2 lines in 6010, 1 in 6011.
    expect(aoi?.scenesPresent).toEqual([6010, 6011]);
    expect(aoi?.linesByScene).toEqual({ "6010": 2, "6011": 1 });
    expect(aoi?.totalLines).toBe(3);
    expect(aoi?.firstScene).toBe(6010);
    expect(aoi?.lastScene).toBe(6011);
    expect(aoi?.artifactRef).toBe("character-arc:Aoi");
    // Mari: 1 in 6010, 1 in 6011.
    expect(mari?.linesByScene).toEqual({ "6010": 1, "6011": 1 });
  });
});

describe("buildSliceStructuredContext (injection payload)", () => {
  it("assembles scene summary + route position + speaker arcs + citable refs", () => {
    const artifacts = buildStructureContextArtifacts(SYNTHETIC_STRUCTURE);
    const ctx = buildSliceStructuredContext(artifacts, 6010);
    expect(ctx.sceneId).toBe(6010);
    expect(ctx.sceneSummaryText).toContain("Scene 6010");
    expect(ctx.routePositionText).toContain("dispatches to scene 6011");
    expect(ctx.routePositionText).toContain("branches on a player choice");
    // Both scene speakers' arcs are present in the block.
    expect(ctx.characterArcsText).toContain("Aoi");
    expect(ctx.characterArcsText).toContain("Mari");
    // Refs cover the scene summary, the map, and each speaker arc.
    expect(ctx.artifactRefs).toContain("scene-summary:6010");
    expect(ctx.artifactRefs).toContain("route-branch-map");
    expect(ctx.artifactRefs).toContain("character-arc:Aoi");
    expect(ctx.artifactRefs).toContain("character-arc:Mari");
  });

  it("throws when the requested scene is not in the decoded structure", () => {
    const artifacts = buildStructureContextArtifacts(SYNTHETIC_STRUCTURE);
    expect(() => buildSliceStructuredContext(artifacts, 9999)).toThrow(
      StructuredContextSceneNotFoundError,
    );
  });
});

describe("translate-stage injection (prompt wiring)", () => {
  const baseInput: TranslationInvocationInput = {
    draftJobId: "job-1",
    draftJobAttemptId: "attempt-1",
    projectId: "project-1",
    localeBranchId: "branch-1",
    sourceLocale: "ja",
    targetLocale: "en",
    sourceBridgeUnits: [
      {
        bridgeUnitId: "unit-1",
        sourceUnitKey: "6010:0",
        sourceText: "おはよう",
        sourceHash: "hash-1",
        speaker: "Aoi",
      },
    ],
    protectedSpansBySource: new Map(),
    glossary: [],
    styleGuide: [],
    modelProfile: {
      providerFamily: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      providerId: "fireworks",
      contextWindowTokens: 128_000,
    },
    promptTemplateVersion: TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  };

  it("renders the structure-informed context block when structuredContext is present", () => {
    const artifacts = buildStructureContextArtifacts(SYNTHETIC_STRUCTURE);
    const ctx = buildSliceStructuredContext(artifacts, 6010);
    const rendered = buildTranslationPrompt({
      ...baseInput,
      structuredContext: ctx,
      contextArtifacts: ctx.artifactRefs.map((ref) => ({
        contextArtifactId: ref,
        category: "scene_summary",
        title: ref,
        body: ctx.sceneSummaryText,
      })),
    });
    expect(rendered.userText).toContain("Structure-informed context");
    expect(rendered.userText).toContain("dispatches to scene 6011");
    expect(rendered.userText).toContain("character-arc:Aoi");
  });

  it("is byte-identical to the pre-feature baseline when structuredContext is absent", () => {
    const withoutField = buildTranslationPrompt(baseInput);
    const withUndefined = buildTranslationPrompt({ ...baseInput, structuredContext: undefined });
    expect(withUndefined.userText).toEqual(withoutField.userText);
    // The baseline prompt must NOT carry the injected block.
    expect(withoutField.userText).not.toContain("Structure-informed context");
  });
});
