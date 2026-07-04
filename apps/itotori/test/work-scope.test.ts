// itotori-multi-work-context-scope-model — tests.
//
// Proves the WORK is the context unit, DERIVED from the decoded game-select:
//   (1) Sweetie HD (ONE archive) carves into its TWO works FROM the decoded
//       game-select — the 2 select options → 2 distinct work subtrees, NOT a
//       hardcoded list (drop the game-select and there is no 2-work carve);
//   (2) each WorkScope builds its OWN structure-informed context from its own
//       decoded structure;
//   (3) the shared super-scope's glossary + characters are INHERITED by both
//       works AND a per-work OVERRIDE diverges (a fandisk term/character
//       differs from the base);
//   (4) a dual-work assertion: the 2 works are modelled DISTINCTLY yet share
//       the parent scope;
//   (5) determinism.

import { describe, expect, it } from "vitest";
import type { NarrativeStructure } from "../src/agents/structure-informed-context/index.js";
import {
  buildScopeGraph,
  buildWorkScopedContext,
  buildWorkScopedSliceContext,
  carveArchiveIntoWorks,
  resolveEffectiveScope,
  WorkCarveError,
  type ScopeCharacter,
  type ScopeGlossaryEntry,
  type SharedScope,
} from "../src/agents/work-scope/index.js";

const ARCHIVE = "sweetie-hd";

// The archive-level decode: the FIRST screen is the game-select. This mirrors
// the exact JSON shape `structure_export.rs` emits — a game-select scene whose
// two `select` options each dispatch (decoded `branchEntryScene`) into a
// DISTINCT work subtree: option 0 → the base game (root scene 100), option 1 →
// the fandisk (root scene 500). Text is invented; the SHAPE is the decode's.
const GAME_SELECT_DECODE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 10,
  sceneDispatchOrder: [10],
  scenes: [
    {
      sceneId: 10,
      nextScene: null,
      messages: [{ order: 0, speaker: null, text: "Select a story.", textSurface: null }],
      choices: [
        {
          optionIndex: 0,
          label: "Sweetie (original story)",
          branchEntryScene: 100,
          branchMessages: [
            { order: 0, speaker: "Rin", text: "Base-game opening.", textSurface: null },
          ],
        },
        {
          optionIndex: 1,
          label: "Sweetie After (fandisk)",
          branchEntryScene: 500,
          branchMessages: [
            { order: 0, speaker: "Rin", text: "Fandisk opening.", textSurface: null },
          ],
        },
      ],
    },
  ],
};

// The BASE game's own decoded structure (a separate structure_export rooted at
// the option-0 branchEntryScene = 100).
const BASE_WORK_STRUCTURE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 100,
  sceneDispatchOrder: [100, 101],
  scenes: [
    {
      sceneId: 100,
      nextScene: 101,
      messages: [
        { order: 0, speaker: "Rin", text: "Good morning!", textSurface: null },
        { order: 1, speaker: "Mei", text: "You're early.", textSurface: null },
      ],
      choices: [],
    },
    {
      sceneId: 101,
      nextScene: null,
      messages: [{ order: 0, speaker: "Rin", text: "Let's go.", textSurface: null }],
      choices: [],
    },
  ],
};

// The FANDISK's own decoded structure (rooted at option-1 branchEntryScene =
// 500). Same characters/world (shared), different scenes.
const FANDISK_WORK_STRUCTURE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 500,
  sceneDispatchOrder: [500],
  scenes: [
    {
      sceneId: 500,
      nextScene: null,
      messages: [
        { order: 0, speaker: "Rin", text: "It's been a while.", textSurface: null },
        { order: 1, speaker: "Sae", text: "A new face for the fandisk.", textSurface: null },
      ],
      choices: [],
    },
  ],
};

// The shared super-scope (brand/collection level): glossary + characters both
// works inherit. `Rin` and the world term `Hoshimi Academy` are shared.
const SHARED_GLOSSARY: ScopeGlossaryEntry[] = [
  { sourceForm: "星見学園", targetForm: "Hoshimi Academy", policyAction: "localize" },
  { sourceForm: "せんぱい", targetForm: "senpai", policyAction: "romanize" },
];
const SHARED_CHARACTERS: ScopeCharacter[] = [
  {
    characterId: "rin",
    displayName: "Rin",
    voiceNote: "spirited childhood friend, casual register",
  },
  { characterId: "mei", displayName: "Mei", voiceNote: "quiet honor student, formal register" },
];
function sharedScope(): SharedScope {
  return {
    scopeId: "scope:sweetie-brand",
    kind: "shared",
    label: "Sweetie (brand)",
    glossary: SHARED_GLOSSARY.map((e) => ({ ...e })),
    characters: SHARED_CHARACTERS.map((c) => ({ ...c })),
  };
}

describe("carveArchiveIntoWorks (derive works FROM the decoded game-select)", () => {
  it("carves Sweetie HD's ONE archive into its TWO works from the game-select options", () => {
    const carve = carveArchiveIntoWorks(GAME_SELECT_DECODE, { archiveRef: ARCHIVE });
    expect(carve.works).toHaveLength(2);
    // The works are the game-select OPTIONS — not a hardcoded list.
    expect(carve.derivation.signal).toBe("game-select-option-branches");
    expect(carve.derivation.gameSelectScene).toBe(10);
    expect(carve.derivation.gameSelectSelectedBy).toBe("entry-scene-select");
    // Each option dispatches into a DISTINCT work subtree (decoded roots).
    expect(carve.works.map((w) => w.branchEntryScene)).toEqual([100, 500]);
    expect(carve.works[0]?.optionLabel).toContain("original");
    expect(carve.works[1]?.optionLabel).toContain("fandisk");
    // Naming rides on the decoded option labels (the honest signal).
    expect(carve.derivation.namingSignal).toBe("option-label");
  });

  it("is NOT hardcoded: with no game-select the same archive is ONE work", () => {
    // Drop the game-select scene's choices → no ≥2-option select anywhere.
    const noSelect: NarrativeStructure = {
      ...GAME_SELECT_DECODE,
      scenes: [{ ...GAME_SELECT_DECODE.scenes[0]!, choices: [] }],
    };
    const carve = carveArchiveIntoWorks(noSelect, { archiveRef: ARCHIVE });
    expect(carve.works).toHaveLength(1);
    expect(carve.derivation.signal).toBe("single-work-no-game-select");
  });

  it("rejects a carve whose options collide on the same work root (not disjoint)", () => {
    const colliding: NarrativeStructure = {
      ...GAME_SELECT_DECODE,
      scenes: [
        {
          ...GAME_SELECT_DECODE.scenes[0]!,
          choices: GAME_SELECT_DECODE.scenes[0]!.choices.map((c) => ({
            ...c,
            branchEntryScene: 100,
          })),
        },
      ],
    };
    expect(() => carveArchiveIntoWorks(colliding, { archiveRef: ARCHIVE })).toThrow(WorkCarveError);
  });

  it("reports the honest boundary when the decode gives no option labels", () => {
    const unlabeled: NarrativeStructure = {
      ...GAME_SELECT_DECODE,
      scenes: [
        {
          ...GAME_SELECT_DECODE.scenes[0]!,
          choices: GAME_SELECT_DECODE.scenes[0]!.choices.map((c) => ({ ...c, label: "" })),
        },
      ],
    };
    const carve = carveArchiveIntoWorks(unlabeled, { archiveRef: ARCHIVE });
    expect(carve.derivation.namingSignal).toBe("unknown");
    expect(carve.derivation.notes).toContain("another signal");
  });

  it("is deterministic (same decode → identical carve)", () => {
    const a = carveArchiveIntoWorks(GAME_SELECT_DECODE, { archiveRef: ARCHIVE });
    const b = carveArchiveIntoWorks(GAME_SELECT_DECODE, { archiveRef: ARCHIVE });
    expect(a).toEqual(b);
  });
});

describe("scope graph — shared super-scope inherited + per-work override", () => {
  function graphWithFandiskOverrides() {
    const carve = carveArchiveIntoWorks(GAME_SELECT_DECODE, { archiveRef: ARCHIVE });
    const [baseWork, fandiskWork] = carve.works;
    return buildScopeGraph({
      shared: sharedScope(),
      carve,
      perWork: {
        [baseWork!.workId]: { structure: BASE_WORK_STRUCTURE },
        [fandiskWork!.workId]: {
          structure: FANDISK_WORK_STRUCTURE,
          // The fandisk DIVERGES: it renames a world term AND adds a character
          // AND re-voices Rin (an older Rin in the after-story).
          glossaryOverrides: [
            {
              sourceForm: "星見学園",
              targetForm: "Hoshimi Academy (Alumni)",
              policyAction: "localize",
            },
          ],
          characterOverrides: [
            {
              characterId: "rin",
              displayName: "Rin",
              voiceNote: "older, softer register (after-story)",
            },
            { characterId: "sae", displayName: "Sae", voiceNote: "fandisk-only heroine" },
          ],
        },
      },
    });
  }

  it("maps 1 title → N works (packaging metadata) and pins the inheritance edge", () => {
    const graph = graphWithFandiskOverrides();
    expect(graph.titleToWorks[ARCHIVE]).toHaveLength(2);
    for (const work of graph.works) {
      expect(work.parentScopeId).toBe(graph.shared.scopeId);
    }
  });

  it("the BASE work inherits the shared glossary + characters unchanged", () => {
    const graph = graphWithFandiskOverrides();
    const baseWorkId = graph.titleToWorks[ARCHIVE]![0]!;
    const eff = resolveEffectiveScope(graph, baseWorkId);
    // Every shared member flows through as `inherited`.
    const academy = eff.glossary.find((g) => g.sourceForm === "星見学園");
    expect(academy?.targetForm).toBe("Hoshimi Academy");
    expect(academy?.provenance).toBe("inherited");
    const rin = eff.characters.find((c) => c.characterId === "rin");
    expect(rin?.voiceNote).toContain("spirited");
    expect(rin?.provenance).toBe("inherited");
  });

  it("the FANDISK work OVERRIDES a shared term + a character and ADDS a new one", () => {
    const graph = graphWithFandiskOverrides();
    const fandiskWorkId = graph.titleToWorks[ARCHIVE]![1]!;
    const eff = resolveEffectiveScope(graph, fandiskWorkId);

    // Overridden world term (same source form, divergent target).
    const academy = eff.glossary.find((g) => g.sourceForm === "星見学園");
    expect(academy?.targetForm).toBe("Hoshimi Academy (Alumni)");
    expect(academy?.provenance).toBe("override");
    // The non-overridden shared term is still inherited.
    const senpai = eff.glossary.find((g) => g.sourceForm === "せんぱい");
    expect(senpai?.provenance).toBe("inherited");

    // Overridden character (re-voiced Rin).
    const rin = eff.characters.find((c) => c.characterId === "rin");
    expect(rin?.voiceNote).toContain("after-story");
    expect(rin?.provenance).toBe("override");
    // Added fandisk-only character.
    const sae = eff.characters.find((c) => c.characterId === "sae");
    expect(sae?.provenance).toBe("override");
    expect(sae?.voiceNote).toContain("fandisk-only");
    // Mei stays inherited (untouched by the fandisk).
    expect(eff.characters.find((c) => c.characterId === "mei")?.provenance).toBe("inherited");
  });
});

describe("WORK-SCOPED context building (per-work structure + shared scope)", () => {
  function fullGraph() {
    const carve = carveArchiveIntoWorks(GAME_SELECT_DECODE, { archiveRef: ARCHIVE });
    const [baseWork, fandiskWork] = carve.works;
    return {
      carve,
      graph: buildScopeGraph({
        shared: sharedScope(),
        carve,
        perWork: {
          [baseWork!.workId]: { structure: BASE_WORK_STRUCTURE },
          [fandiskWork!.workId]: {
            structure: FANDISK_WORK_STRUCTURE,
            characterOverrides: [
              { characterId: "sae", displayName: "Sae", voiceNote: "fandisk-only" },
            ],
          },
        },
      }),
    };
  }

  it("each WorkScope builds its OWN structure-informed context (distinct scene graphs)", () => {
    const { graph } = fullGraph();
    const [baseWorkId, fandiskWorkId] = graph.titleToWorks[ARCHIVE]!;

    const baseCtx = buildWorkScopedContext(graph, baseWorkId!);
    const fandiskCtx = buildWorkScopedContext(graph, fandiskWorkId!);

    // The base work's context is built from ITS scenes (100, 101).
    expect(baseCtx.artifacts.sceneSummaries.map((s) => s.sceneId)).toEqual([100, 101]);
    expect(baseCtx.artifacts.routeBranchMap.entryScene).toBe(100);
    // The fandisk work's context is built from ITS scene (500) — DISTINCT.
    expect(fandiskCtx.artifacts.sceneSummaries.map((s) => s.sceneId)).toEqual([500]);
    expect(fandiskCtx.artifacts.routeBranchMap.entryScene).toBe(500);
    // The two works do not share scenes (disjoint subtrees).
    const baseScenes = new Set(baseCtx.artifacts.sceneSummaries.map((s) => s.sceneId));
    for (const s of fandiskCtx.artifacts.sceneSummaries) {
      expect(baseScenes.has(s.sceneId)).toBe(false);
    }
  });

  it("dual-work assertion: 2 DISTINCT works that SHARE the parent scope's context", () => {
    const { graph } = fullGraph();
    const [baseWorkId, fandiskWorkId] = graph.titleToWorks[ARCHIVE]!;
    const baseCtx = buildWorkScopedContext(graph, baseWorkId!);
    const fandiskCtx = buildWorkScopedContext(graph, fandiskWorkId!);

    // DISTINCT: different work ids, different structure-informed context.
    expect(baseCtx.workId).not.toBe(fandiskCtx.workId);
    expect(baseCtx.artifacts.routeBranchMap.entryScene).not.toBe(
      fandiskCtx.artifacts.routeBranchMap.entryScene,
    );
    // SHARED: both inherit the same brand character `Rin` (same voice note in
    // the base; the fandisk here did not override Rin, only added Sae).
    const baseRin = baseCtx.effectiveScope.characters.find((c) => c.characterId === "rin");
    const fandiskRin = fandiskCtx.effectiveScope.characters.find((c) => c.characterId === "rin");
    expect(baseRin?.voiceNote).toBe(fandiskRin?.voiceNote);
    expect(baseRin?.provenance).toBe("inherited");
    expect(fandiskRin?.provenance).toBe("inherited");
    // Both inherit the shared world glossary term.
    expect(
      baseCtx.effectiveScope.glossary.find((g) => g.sourceForm === "星見学園")?.targetForm,
    ).toBe("Hoshimi Academy");
    expect(
      fandiskCtx.effectiveScope.glossary.find((g) => g.sourceForm === "星見学園")?.targetForm,
    ).toBe("Hoshimi Academy");
  });

  it("a work-scoped SLICE carries the scene injection + the work's effective scope", () => {
    const { graph } = fullGraph();
    const baseWorkId = graph.titleToWorks[ARCHIVE]![0]!;
    const ctx = buildWorkScopedContext(graph, baseWorkId);
    const slice = buildWorkScopedSliceContext(ctx, 100);
    expect(slice.sceneId).toBe(100);
    expect(slice.structured.sceneId).toBe(100);
    // The slice's terminology is the WORK's effective (inherited) scope.
    expect(slice.effectiveScope.characters.some((c) => c.characterId === "rin")).toBe(true);
  });

  it("is deterministic (same graph → identical work-scoped context)", () => {
    const { graph: g1 } = fullGraph();
    const { graph: g2 } = fullGraph();
    const id = g1.titleToWorks[ARCHIVE]![0]!;
    expect(buildWorkScopedContext(g1, id)).toEqual(buildWorkScopedContext(g2, id));
  });
});
