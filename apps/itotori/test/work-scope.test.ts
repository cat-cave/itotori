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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  NarrativeScene,
  NarrativeStructure,
  SelectionControlSignal,
} from "../src/agents/structure-informed-context/index.js";
import {
  buildScopeGraph,
  buildWorkScopedContext,
  buildWorkScopedSliceContext,
  carveArchiveIntoWorks,
  resolveEffectiveScope,
  WorkCarveError,
  type CarveWorkEntryOverride,
  type ScopeCharacter,
  type ScopeGlossaryEntry,
  type SharedScope,
} from "../src/agents/work-scope/index.js";

const ARCHIVE = "sweetie-hd";

// The archive-level decode: the FIRST screen is the game-select. This mirrors
// the exact JSON shape `structure_export.rs` emits — a `button-object`
// game-select (the real Sweetie HD marker: a `select_objbtn` graphical pick)
// whose two options each dispatch (decoded `branchEntryScene`) into a DISTINCT
// work subtree: option 0 → the base game (root scene 100), option 1 → the
// fandisk (root scene 500). Text is invented; the SHAPE + the `button-object`
// SelectionControl marker are the decode's. (This is the ENUMERABLE game-select
// case — a gallery/menu-style objbtn select carrying inline option branches;
// the real first-screen game-select — scene 2 — is the UNRESOLVED case, see the
// real-bytes test below.)
const GAME_SELECT_DECODE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 10,
  sceneDispatchOrder: [10],
  scenes: [
    {
      sceneId: 10,
      selectionControl: "button-object",
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
      selectionControl: "none",
      nextScene: 101,
      messages: [
        { order: 0, speaker: "Rin", text: "Good morning!", textSurface: null },
        { order: 1, speaker: "Mei", text: "You're early.", textSurface: null },
      ],
      choices: [],
    },
    {
      sceneId: 101,
      selectionControl: "none",
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
      selectionControl: "none",
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
    // HARDENED: the game-select is identified by the button-object marker, NOT
    // by position + option-count.
    expect(carve.derivation.gameSelectSelectedBy).toBe("button-object-select");
    expect(carve.derivation.selectionControl).toBe("button-object");
    // Each option dispatches into a DISTINCT work subtree (decoded roots).
    expect(carve.works.map((w) => w.branchEntryScene)).toEqual([100, 500]);
    expect(carve.works[0]?.optionLabel).toContain("original");
    expect(carve.works[1]?.optionLabel).toContain("fandisk");
    // Naming rides on the decoded option labels (the honest signal).
    expect(carve.derivation.namingSignal).toBe("option-label");
  });

  it("is NOT hardcoded: with no button-object select the same archive is ONE work", () => {
    // Drop the game-select marker AND its choices → no button-object select.
    const noSelect: NarrativeStructure = {
      ...GAME_SELECT_DECODE,
      scenes: [{ ...GAME_SELECT_DECODE.scenes[0]!, selectionControl: "none", choices: [] }],
    };
    const carve = carveArchiveIntoWorks(noSelect, { archiveRef: ARCHIVE });
    expect(carve.works).toHaveLength(1);
    expect(carve.derivation.signal).toBe("single-work-no-game-select");
  });

  it("HARDENED: a mid-story TEXT-window select is NOT mis-carved as the archive boundary", () => {
    // A structure whose EARLIEST ≥2-option select is an in-story dialogue
    // yes/no branch (a `text-window` `select_w`, exactly the real Sweetie HD
    // scenes 1018 / 4004 / 6001 / 6011 / 6013 / 8003) — the old position +
    // option-count heuristic would mistake it for the game-select and carve a
    // spurious 2-work split. The hardened button-object signal does NOT: the
    // archive stays ONE work, the branch is left to route-level subdivision.
    const midStoryTextSelect: NarrativeStructure = {
      schemaVersion: "utsushi.narrative-structure.v1",
      entryScene: 6011,
      sceneDispatchOrder: [6011],
      scenes: [
        {
          sceneId: 6011,
          selectionControl: "text-window",
          nextScene: null,
          messages: [{ order: 0, speaker: "Rin", text: "Which do you pick?", textSurface: null }],
          choices: [
            {
              optionIndex: 0,
              label: "Yes",
              branchEntryScene: 6012,
              branchMessages: [{ order: 0, speaker: "Rin", text: "Ok.", textSurface: null }],
            },
            {
              optionIndex: 1,
              label: "No",
              branchEntryScene: 6013,
              branchMessages: [{ order: 0, speaker: "Rin", text: "Fine.", textSurface: null }],
            },
          ],
        },
      ],
    };
    const carve = carveArchiveIntoWorks(midStoryTextSelect, { archiveRef: ARCHIVE });
    expect(carve.works).toHaveLength(1);
    expect(carve.derivation.signal).toBe("single-work-no-game-select");
    expect(carve.derivation.gameSelectScene).toBeNull();
    expect(carve.derivation.selectionControl).toBe("none");
  });

  it("identifies a button-object game-select even when its options are NOT enumerable", () => {
    // The REAL Sweetie HD first-screen game-select (scene 2): a `select_objbtn`
    // that is the TITLE MENU. Its goto_case($store) branches dispatch to
    // menu/config scenes + the store-relative New-Game routine (traced with the
    // boot_dispatch_scan example), NOT to two enumerable per-work story roots,
    // so the select scene carries NO inline option block. The carve still
    // IDENTIFIES it (button-object marker) but reports the works are
    // unresolved — honest, not a synthetic 2-work fabrication.
    const upstreamGameSelect: NarrativeStructure = {
      schemaVersion: "utsushi.narrative-structure.v1",
      entryScene: 2,
      sceneDispatchOrder: [2],
      scenes: [
        {
          sceneId: 2,
          selectionControl: "button-object",
          nextScene: null,
          messages: [],
          choices: [],
        },
      ],
    };
    const carve = carveArchiveIntoWorks(upstreamGameSelect, { archiveRef: ARCHIVE });
    expect(carve.derivation.signal).toBe("game-select-unresolved-options");
    expect(carve.derivation.gameSelectScene).toBe(2);
    expect(carve.derivation.gameSelectSelectedBy).toBe("button-object-select");
    expect(carve.derivation.selectionControl).toBe("button-object");
    expect(carve.derivation.notes).toContain("title MENU");
    expect(carve.derivation.notes).toContain("New-Game routine");
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

// ---------------------------------------------------------------------------
// OPERATOR entry-scene override — the deterministic escape hatch for the
// `game-select-unresolved-options` case (the real Sweetie HD scene-2 title
// MENU). The operator pins the base (and/or fandisk) entry scene(s) in config
// and carve roots the works DETERMINISTICALLY from them, bypassing the
// unresolvable game-select. A whole-game localize run targets base-only (one
// entry scene) or base+fandisk (two) via this config field.
//
// The fixture mirrors the REAL Sweetie HD unresolved shape: scene 2 is a
// `button-object` TITLE MENU whose options are NOT enumerable on the select
// scene (the carve reports `game-select-unresolved-options` without the
// override), while the base root (scene 100) and fandisk root (scene 500) ARE
// present in the decode — the operator pins them and carve roots from there.
// Scene ids + opcode-shape only; NO game bytes.
const UNRESOLVED_TITLE_MENU_ARCHIVE: NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1",
  entryScene: 2,
  sceneDispatchOrder: [2, 3, 100, 101, 500],
  scenes: [
    {
      sceneId: 2,
      selectionControl: "button-object",
      nextScene: 3,
      messages: [],
      choices: [],
    },
    { sceneId: 3, selectionControl: "none", nextScene: null, messages: [], choices: [] },
    {
      sceneId: 100,
      selectionControl: "none",
      nextScene: 101,
      messages: [
        { order: 0, speaker: "Rin", text: "Base-game opening.", textSurface: null },
        { order: 1, speaker: "Mei", text: "You're early.", textSurface: null },
      ],
      choices: [],
    },
    {
      sceneId: 101,
      selectionControl: "none",
      nextScene: null,
      messages: [{ order: 0, speaker: "Rin", text: "Let's go.", textSurface: null }],
      choices: [],
    },
    {
      sceneId: 500,
      selectionControl: "none",
      nextScene: null,
      messages: [
        { order: 0, speaker: "Rin", text: "It's been a while.", textSurface: null },
        { order: 1, speaker: "Sae", text: "A fandisk-only face.", textSurface: null },
      ],
      choices: [],
    },
  ],
};

describe("carveArchiveIntoWorks — OPERATOR entry-scene override (game-select-unresolved escape hatch)", () => {
  it("WITHOUT the override, the title-menu game-select reports the honest unresolved ambiguity", () => {
    // The real Sweetie HD boundary: scene 2 is a button-object title MENU with
    // no enumerable options → the carve CANNOT root the works from the decode.
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, { archiveRef: ARCHIVE });
    expect(carve.derivation.signal).toBe("game-select-unresolved-options");
    expect(carve.derivation.gameSelectScene).toBe(2);
    expect(carve.works).toHaveLength(1);
    expect(carve.derivation.notes).toContain("title MENU");
  });

  it("WITH the override, carve deterministically roots the base + fandisk works from the entry scenes", () => {
    const entryScenes: CarveWorkEntryOverride[] = [
      { scene: 100, label: "Sweetie (base story)", workSlug: "base" },
      { scene: 500, label: "Sweetie After (fandisk)", workSlug: "fandisk" },
    ];
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      entryScenes,
    });
    expect(carve.derivation.signal).toBe("operator-entry-scene-override");
    // Deterministic base + fandisk scope, in declaration order.
    expect(carve.works).toHaveLength(2);
    expect(carve.works.map((w) => w.branchEntryScene)).toEqual([100, 500]);
    expect(carve.works.map((w) => w.optionIndex)).toEqual([0, 1]);
    // Stable operator-supplied workIds (slug-suffixed) for scope-graph seeding.
    expect(carve.works.map((w) => w.workId)).toEqual([
      "sweetie-hd#work:entry:base",
      "sweetie-hd#work:entry:fandisk",
    ]);
    // Labels rode through → the operator naming signal.
    expect(carve.works[0]!.optionLabel).toContain("base");
    expect(carve.works[1]!.optionLabel).toContain("fandisk");
    expect(carve.derivation.namingSignal).toBe("provided");
    expect(carve.derivation.gameSelectScene).toBeNull();
    expect(carve.derivation.selectionControl).toBe("none");
    // Each work's magnitude + speakers reduced from its rooted scene.
    expect(carve.works[0]!.branchMessageCount).toBe(2);
    expect(carve.works[0]!.branchSpeakers).toEqual(["Rin", "Mei"]);
    expect(carve.works[1]!.branchSpeakers).toEqual(["Rin", "Sae"]);
  });

  it("targets BASE-ONLY via config (one entry scene → one work)", () => {
    // A whole-game localize run can scope to base-only by supplying just the
    // base entry scene — the fandisk is excluded from the work-set.
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      entryScenes: [{ scene: 100, label: "base", workSlug: "base" }],
    });
    expect(carve.derivation.signal).toBe("operator-entry-scene-override");
    expect(carve.works).toHaveLength(1);
    expect(carve.works[0]!.branchEntryScene).toBe(100);
    expect(carve.works[0]!.workId).toBe("sweetie-hd#work:entry:base");
  });

  it("targets FANDISK-ONLY via config (the other single entry scene)", () => {
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      entryScenes: [{ scene: 500, label: "fandisk", workSlug: "fandisk" }],
    });
    expect(carve.works).toHaveLength(1);
    expect(carve.works[0]!.branchEntryScene).toBe(500);
  });

  it("the override TAKES PRECEDENCE over the gameSelectScene override (roots win)", () => {
    // Even with a gameSelectScene pinned, the entryScenes override is the more
    // direct rooting and wins — the game-select is moot once roots are supplied.
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      gameSelectScene: 2,
      entryScenes: [
        { scene: 100, workSlug: "base" },
        { scene: 500, workSlug: "fandisk" },
      ],
    });
    expect(carve.derivation.signal).toBe("operator-entry-scene-override");
    expect(carve.derivation.gameSelectScene).toBeNull();
    expect(carve.works.map((w) => w.branchEntryScene)).toEqual([100, 500]);
  });

  it("reports namingSignal=unknown when the override carries no labels", () => {
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      entryScenes: [{ scene: 100 }, { scene: 500 }],
    });
    expect(carve.derivation.namingSignal).toBe("unknown");
    // workIds fall back to the entry scene id when no slug is supplied.
    expect(carve.works.map((w) => w.workId)).toEqual([
      "sweetie-hd#work:entry:100",
      "sweetie-hd#work:entry:500",
    ]);
  });

  it("REJECTS an entry scene NOT present in the decode (honest validation)", () => {
    expect(() =>
      carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
        archiveRef: ARCHIVE,
        entryScenes: [{ scene: 4242 }],
      }),
    ).toThrow(WorkCarveError);
  });

  it("REJECTS two works rooted at the SAME scene (not disjoint)", () => {
    expect(() =>
      carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
        archiveRef: ARCHIVE,
        entryScenes: [{ scene: 100 }, { scene: 100 }],
      }),
    ).toThrow(WorkCarveError);
  });

  it("REJECTS a duplicate workSlug", () => {
    expect(() =>
      carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
        archiveRef: ARCHIVE,
        entryScenes: [
          { scene: 100, workSlug: "x" },
          { scene: 500, workSlug: "x" },
        ],
      }),
    ).toThrow(WorkCarveError);
  });

  it("is deterministic (same override + decode → identical carve)", () => {
    const opts = {
      archiveRef: ARCHIVE,
      entryScenes: [
        { scene: 100, label: "base", workSlug: "base" },
        { scene: 500, label: "fandisk", workSlug: "fandisk" },
      ],
    } as const;
    const a = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, opts);
    const b = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, opts);
    expect(a).toEqual(b);
  });

  it("the override-rooted carve flows into the scope graph identically to a decoded carve", () => {
    // The override produces a WorkCarve the scope-graph builder consumes the
    // SAME way as a decoded game-select carve — per-work seeds key off the
    // stable operator workIds.
    const carve = carveArchiveIntoWorks(UNRESOLVED_TITLE_MENU_ARCHIVE, {
      archiveRef: ARCHIVE,
      entryScenes: [
        { scene: 100, label: "base", workSlug: "base" },
        { scene: 500, label: "fandisk", workSlug: "fandisk" },
      ],
    });
    const graph = buildScopeGraph({
      shared: sharedScope(),
      carve,
      perWork: {
        "sweetie-hd#work:entry:base": { structure: BASE_WORK_STRUCTURE },
        "sweetie-hd#work:entry:fandisk": { structure: FANDISK_WORK_STRUCTURE },
      },
    });
    expect(graph.titleToWorks[ARCHIVE]).toEqual([
      "sweetie-hd#work:entry:base",
      "sweetie-hd#work:entry:fandisk",
    ]);
    // Both works inherit the shared scope's brand character.
    const baseEff = resolveEffectiveScope(graph, "sweetie-hd#work:entry:base");
    expect(baseEff.characters.find((c) => c.characterId === "rin")?.provenance).toBe("inherited");
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

// ---------------------------------------------------------------------------
// REAL Sweetie HD bytes — the hardened game-select signal validated on the
// actual decode (not synthetic-shaped structures).
//
// Gated on `ITOTORI_MWCARVE_SCAN_CSV` = the path to the CSV emitted by
//   cargo run -p utsushi-reallive --example game_select_scan -- <Seen.txt>
// over the real Sweetie HD bytes (held OUTSIDE the repo — the CSV carries only
// scene ids + per-scene `module_sel` opcode COUNTS, never copyrighted text).
// When unset the test prints a visible skip note and returns (no silent pass).
//
// Columns: scene,parse_ok,objbtn_init,select_objbtn,objbtn_cancel,choice_blocks,goto_on_if
//
// It maps each real scene's decoded sel-family counts to the SAME
// `selectionControl` signal `structure_export.rs` emits (button-object iff any
// objbtn/select_objbtn/cancel op; else text-window iff any text Choice block;
// else none), then proves:
//   * the real first-screen game-select (scene 2) decodes to `button-object`
//     — the archive-carve marker the hardened signal keys on;
//   * the real mid-story dialogue branches (1018 / 4004 / 6001 / 6011 / 6013 /
//     8003) decode to `text-window` — and are NOT mis-carved as the archive
//     boundary;
//   * every one of those scenes parsed (parse_ok=1) — the decode recognised
//     the sel family (0-unknown on the load-bearing scenes).
type ScanRow = {
  scene: number;
  parseOk: boolean;
  objbtnInit: number;
  selectObjbtn: number;
  objbtnCancel: number;
  choiceBlocks: number;
};

function parseScanCsv(text: string): Map<number, ScanRow> {
  const rows = new Map<number, ScanRow>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("scene,")) {
      continue;
    }
    const cols = trimmed.split(",").map((c) => Number(c));
    if (cols.length < 7 || cols.some((n) => Number.isNaN(n))) {
      continue;
    }
    const [scene, parseOk, objbtnInit, selectObjbtn, objbtnCancel, choiceBlocks] = cols as number[];
    rows.set(scene!, {
      scene: scene!,
      parseOk: parseOk === 1,
      objbtnInit: objbtnInit!,
      selectObjbtn: selectObjbtn!,
      objbtnCancel: objbtnCancel!,
      choiceBlocks: choiceBlocks!,
    });
  }
  return rows;
}

/** The SAME mapping `structure_export.rs::selection_control_signal` applies. */
function signalOf(row: ScanRow): SelectionControlSignal {
  if (row.objbtnInit + row.selectObjbtn + row.objbtnCancel > 0) {
    return "button-object";
  }
  if (row.choiceBlocks > 0) {
    return "text-window";
  }
  return "none";
}

function realScene(sceneId: number, signal: SelectionControlSignal): NarrativeScene {
  return { sceneId, selectionControl: signal, nextScene: null, messages: [], choices: [] };
}

describe("REAL Sweetie HD — hardened game-select signal on the actual decode", () => {
  const csvPath = process.env.ITOTORI_MWCARVE_SCAN_CSV;
  const enabled = typeof csvPath === "string" && csvPath.length > 0;

  it("carves on the real button-object game-select; a mid-story text-select is NOT mis-carved", () => {
    if (!enabled) {
      // eslint-disable-next-line no-console
      console.warn(
        "[mwcarve] skipping real Sweetie HD validation — set ITOTORI_MWCARVE_SCAN_CSV=<path to " +
          "game_select_scan CSV over the real Seen.txt> to run it",
      );
      return;
    }
    const rows = parseScanCsv(readFileSync(csvPath, "utf8"));

    // (1) The real first-screen game-select (scene 2) is a button-object
    // `select_objbtn` — the archive-carve marker.
    const gameSelect = rows.get(2);
    expect(gameSelect, "scene 2 present in the real scan").toBeDefined();
    expect(gameSelect!.parseOk).toBe(true);
    expect(gameSelect!.selectObjbtn).toBeGreaterThanOrEqual(1);
    expect(signalOf(gameSelect!)).toBe("button-object");

    // (2) The real mid-story dialogue branches are plain text-window selects
    // (a text Choice block, NO objbtn setup) — exactly what a position+count
    // heuristic would mis-carve.
    const midStoryTextScenes = [1018, 4004, 6001, 6011, 6013, 8003];
    for (const id of midStoryTextScenes) {
      const row = rows.get(id);
      expect(row, `mid-story scene ${id} present`).toBeDefined();
      expect(row!.parseOk, `scene ${id} decoded (0-unknown)`).toBe(true);
      expect(row!.selectObjbtn + row!.objbtnInit + row!.objbtnCancel).toBe(0);
      expect(row!.choiceBlocks).toBeGreaterThanOrEqual(1);
      expect(signalOf(row!)).toBe("text-window");
    }

    // (3) Feed the REAL decoded signals through the carve.
    //   (a) The button-object game-select (scene 2) IS identified — it is the
    //       title MENU whose goto_case($store) branches dispatch to menu/config
    //       scenes + a store-relative New-Game routine (which does not decode),
    //       not to two per-work story roots, so the works are unresolved (the
    //       honest real boundary), NOT a synthetic 2-work fabrication.
    const gameSelectStructure: NarrativeStructure = {
      schemaVersion: "utsushi.narrative-structure.v1",
      entryScene: 2,
      sceneDispatchOrder: [2],
      scenes: [realScene(2, signalOf(gameSelect!))],
    };
    const gsCarve = carveArchiveIntoWorks(gameSelectStructure, { archiveRef: ARCHIVE });
    expect(gsCarve.derivation.selectionControl).toBe("button-object");
    expect(gsCarve.derivation.gameSelectScene).toBe(2);
    expect(gsCarve.derivation.gameSelectSelectedBy).toBe("button-object-select");
    expect(gsCarve.derivation.signal).toBe("game-select-unresolved-options");

    //   (b) A structure of ONLY the real mid-story text-window branches carves
    //       to a SINGLE work — the mid-story branch is NOT the archive boundary.
    const midStoryStructure: NarrativeStructure = {
      schemaVersion: "utsushi.narrative-structure.v1",
      entryScene: midStoryTextScenes[0]!,
      sceneDispatchOrder: midStoryTextScenes,
      scenes: midStoryTextScenes.map((id) => realScene(id, signalOf(rows.get(id)!))),
    };
    const msCarve = carveArchiveIntoWorks(midStoryStructure, { archiveRef: ARCHIVE });
    expect(msCarve.works).toHaveLength(1);
    expect(msCarve.derivation.signal).toBe("single-work-no-game-select");
    expect(msCarve.derivation.gameSelectScene).toBeNull();
  });
});
