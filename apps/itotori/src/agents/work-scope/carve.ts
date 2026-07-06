// itotori-multi-work-context-scope-model — the archive→works carve.
//
// DERIVES the narrative works FROM the decoded game-select — never a hardcoded
// list. The game-select is the archive's opening GRAPHICAL button-object
// select (Sweetie HD: the base-game vs fandisk pick, decoded as the
// `select_objbtn` (0,2,4) / `objbtn_init` (0,2,20) SelectionControl marker).
// Each option is a WORK; the option's decoded `branchEntryScene` (the
// `goto_on($store)` / `jump` target the branch-following walk followed) is the
// ROOT of that work's scene subtree.
//
// HARDENED game-select identification (real Sweetie HD validation): the carve
// no longer identifies the game-select by POSITION + option-COUNT alone (a
// deep in-story ≥2-option branch could be mistaken). It keys on the decoded
// `selectionControl` marker — the archive game-select is a `button-object`
// select (a `select_objbtn` graphical pick), whereas the mid-story dialogue
// yes/no branches are `text-window` `select_w` blocks. A `text-window` select
// is NEVER carved as the archive boundary, so a mid-story branch cannot be
// mis-carved into a spurious "work".
//
// Honest boundary (reported in `WorkCarveDerivation`):
//   * What the decode GIVES: the button-object game-select scene, and — WHEN
//     its options are enumerable on the select scene — each option's LABEL and
//     dispatch target (`branchEntryScene`), enough to carve N disjoint works.
//   * What it does NOT always give: the REAL Sweetie HD first-screen
//     `select_objbtn` (scene 2) is the TITLE MENU, not a clean base-vs-fandisk
//     story fork. Its `goto_case($store)` dispatch (opcode (0,1,4), 6 targets)
//     routes to 6 INTRA-scene labels whose non-loop branches `jump`/`farcall`
//     cross-scene to MENU/config scenes (scene 3 = config/gallery, scene 10 =
//     the extra sub-menu) and the New-Game routine (farcall scene 9996,
//     op (0,1,18)) — NOT to two disjoint story roots. The New-Game path
//     (scene 9996) FAILS TO DECODE in BOTH kaifuu (`MalformedExpression`
//     @~offset 271) and utsushi (`MalformedElement` @~259), so the story entry
//     the New-Game button leads into is unreachable statically; and even were
//     it decodable, the base-vs-fandisk pick is store-relative RUNTIME menu
//     state (which objbtn button was pressed), not a static 2-way branch.
//     Gameexe.ini carries NO per-work entry-scene list either (option (a)).
//     The carve therefore still IDENTIFIES the game-select (button-object
//     marker) but reports `game-select-unresolved-options` — the archive is
//     known-multi-work, but the works CANNOT be rooted from the decode: the
//     split needs the undecodable New-Game routine + runtime title-menu state.
//     (Traced 2026-07-04 with the `boot_dispatch_scan` example over the real
//     Seen.txt; scene-ids/opcode-ids only, no copyrighted text.)
//   * It never gives a SEMANTIC "this is the base game / that is the fandisk".
//     Naming rides on the option labels when present; otherwise it needs
//     another signal (Gameexe title metadata, scene-id ranges, operator input).

import type {
  NarrativeMessage,
  NarrativeStructure,
  SelectionControlSignal,
} from "../structure-informed-context/index.js";
import {
  WorkCarveError,
  type CarvedWork,
  type WorkCarve,
  type WorkCarveDerivation,
} from "./shapes.js";

/** A game-select's options are enumerable into works only with ≥2 branches. */
const MIN_GAME_SELECT_OPTIONS = 2;

export type CarveOptions = {
  /** Archive/title metadata id (packaging). Defaults to `archive`. */
  archiveRef?: string;
  /**
   * Force a specific scene as the game-select (overrides auto-detection).
   * Use when the operator knows the carve scene (e.g. from Gameexe or the
   * button-object game-select the headless decode cannot cross into).
   */
  gameSelectScene?: number;
};

function distinctSpeakers(messages: ReadonlyArray<NarrativeMessage>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const m of messages) {
    if (m.speaker !== null && !seen.has(m.speaker)) {
      seen.add(m.speaker);
      order.push(m.speaker);
    }
  }
  return order;
}

/** Scenes in dispatch order, falling back to declaration order. */
function orderedScenes(structure: NarrativeStructure): number[] {
  return structure.sceneDispatchOrder.length > 0
    ? structure.sceneDispatchOrder
    : structure.scenes.map((s) => s.sceneId);
}

/**
 * Pick the archive game-select scene from the decoded structure — HARDENED to
 * key on the `selectionControl` marker, NOT position + option-count.
 *
 * Preference order:
 *   1. an explicit `gameSelectScene` override (operator knows the scene — e.g.
 *      the button-object game-select the headless decode cannot cross into);
 *   2. the EARLIEST scene (dispatch order, else declaration order) whose
 *      `selectionControl === "button-object"` — a `select_objbtn` graphical
 *      pick. This IS the archive game-select marker (Sweetie HD: base-vs-
 *      fandisk). A mid-story `text-window` `select_w` dialogue branch is
 *      deliberately NOT eligible, so it can never be mis-carved as the archive
 *      boundary.
 * Returns null when no button-object select exists: the archive is a single
 * work (its `text-window` selects are IN-STORY branches, subdivided at
 * route level, not the archive carve).
 */
function pickGameSelectScene(
  structure: NarrativeStructure,
  override: number | undefined,
): {
  sceneId: number | null;
  how: WorkCarveDerivation["gameSelectSelectedBy"];
  selectionControl: SelectionControlSignal;
} {
  if (override !== undefined) {
    const scene = structure.scenes.find((s) => s.sceneId === override);
    if (scene === undefined) {
      throw new WorkCarveError(`gameSelectScene ${override} not present in the decoded structure`);
    }
    return { sceneId: override, how: "provided", selectionControl: scene.selectionControl };
  }

  const byId = new Map(structure.scenes.map((s) => [s.sceneId, s] as const));
  for (const id of orderedScenes(structure)) {
    const scene = byId.get(id);
    if (scene !== undefined && scene.selectionControl === "button-object") {
      return {
        sceneId: scene.sceneId,
        how: "button-object-select",
        selectionControl: "button-object",
      };
    }
  }

  return { sceneId: null, how: "none", selectionControl: "none" };
}

/**
 * Carve the archive into narrative WORKS from its decoded game-select.
 *
 * Deterministic: given the same decoded `NarrativeStructure` it always yields
 * the same works in the same order (game-select option order).
 */
export function carveArchiveIntoWorks(
  structure: NarrativeStructure,
  options: CarveOptions = {},
): WorkCarve {
  const archiveRef = options.archiveRef ?? "archive";
  const {
    sceneId: gameSelectScene,
    how,
    selectionControl,
  } = pickGameSelectScene(structure, options.gameSelectScene);

  const wholeArchiveWork = (): CarvedWork => ({
    workId: `${archiveRef}#work:single`,
    optionIndex: 0,
    optionLabel: "",
    branchEntryScene: structure.entryScene,
    branchMessageCount: structure.scenes.reduce((n, s) => n + s.messages.length, 0),
    branchSpeakers: distinctSpeakers(structure.scenes.flatMap((s) => s.messages)),
  });

  // No button-object game-select: the whole archive is ONE work. Any
  // `text-window` (in-story) selects present are route-level branches, NOT the
  // archive carve — so a mid-story branch is never mis-carved as a work.
  if (gameSelectScene === null) {
    return {
      archiveRef,
      works: [wholeArchiveWork()],
      derivation: {
        signal: "single-work-no-game-select",
        gameSelectScene: null,
        gameSelectSelectedBy: "none",
        selectionControl: "none",
        namingSignal: "unknown",
        notes:
          "No button-object game-select in the decode: the archive is a single narrative work. Any text-window selects present are in-story (route-level) branches, not an archive→works boundary.",
      },
    };
  }

  const scene = structure.scenes.find((s) => s.sceneId === gameSelectScene);
  if (scene === undefined) {
    throw new WorkCarveError(`game-select scene ${gameSelectScene} vanished`);
  }

  // The button-object game-select is IDENTIFIED but its per-option branches are
  // not enumerable on the select scene (Sweetie HD scene 2: a `select_objbtn`
  // title MENU whose goto_case($store) branches dispatch to menu/config scenes
  // + a store-relative New-Game routine, not to enumerable per-work story roots
  // — the select scene carries no inline option block). The archive is KNOWN
  // multi-work, but the works cannot be rooted from the decode alone.
  if (scene.choices.length < MIN_GAME_SELECT_OPTIONS) {
    return {
      archiveRef,
      works: [wholeArchiveWork()],
      derivation: {
        signal: "game-select-unresolved-options",
        gameSelectScene,
        gameSelectSelectedBy: how,
        selectionControl,
        namingSignal: "unknown",
        notes:
          `A button-object game-select (scene ${gameSelectScene}) marks this archive as multi-work, but the select scene carries ` +
          `${scene.choices.length} enumerable option branch(es) (<${MIN_GAME_SELECT_OPTIONS}): the select is a title MENU whose branches dispatch (goto_case on $store) to menu/config scenes and/or a store-relative New-Game routine, NOT to enumerable per-work story roots. The works cannot be rooted from the decode alone; rooting them needs upstream/operator context (a per-work entry-scene list) — which the decode does not provide (the New-Game routine does not decode and the split is runtime menu state).`,
      },
    };
  }

  const works: CarvedWork[] = scene.choices.map((choice) => ({
    workId: `${archiveRef}#work:${gameSelectScene}:${choice.optionIndex}`,
    optionIndex: choice.optionIndex,
    optionLabel: choice.label,
    branchEntryScene: choice.branchEntryScene,
    branchMessageCount: choice.branchMessages.length,
    branchSpeakers: distinctSpeakers(choice.branchMessages),
  }));

  // Distinctness: the works must be disjoint. When the decode resolved
  // per-option dispatch targets, distinct `branchEntryScene`s prove the
  // options root DISTINCT work subtrees (Sweetie HD: base vs fandisk).
  const resolvedRoots = works.map((w) => w.branchEntryScene).filter((s): s is number => s !== null);
  const distinctRoots = new Set(resolvedRoots);
  if (resolvedRoots.length > 0 && distinctRoots.size !== resolvedRoots.length) {
    throw new WorkCarveError(
      `game-select options do not root DISTINCT works: branchEntryScenes ${resolvedRoots.join(", ")} collide`,
    );
  }

  const labelsPresent = works.every((w) => w.optionLabel.length > 0);
  const allRootsResolved = works.every((w) => w.branchEntryScene !== null);
  const namingSignal: WorkCarveDerivation["namingSignal"] = labelsPresent
    ? "option-label"
    : "unknown";

  const rootNote = allRootsResolved
    ? `Each option's decoded branchEntryScene (${resolvedRoots.join(", ")}) roots a DISTINCT work subtree.`
    : `Some options did not resolve a cross-scene dispatch target; those works fall back to the game-select's own branch stream (report which downstream — no per-work structure root).`;
  const nameNote =
    namingSignal === "option-label"
      ? "Works are named from the decoded option labels (a naming signal, not a semantic base-vs-fandisk classification)."
      : "The decode gives no option labels here: base-vs-fandisk naming needs another signal (Gameexe title metadata / scene-id range / operator input).";

  return {
    archiveRef,
    works,
    derivation: {
      signal: "game-select-option-branches",
      gameSelectScene,
      gameSelectSelectedBy: how,
      selectionControl,
      namingSignal,
      notes: `${rootNote} ${nameNote}`,
    },
  };
}
