// itotori-multi-work-context-scope-model — the archive→works carve.
//
// DERIVES the narrative works FROM the decoded game-select — never a hardcoded
// list. The game-select is the archive's opening ≥2-option `select` (Sweetie
// HD: the base-game vs fandisk pick, decoded as the drivable `select_objbtn`).
// Each option is a WORK; the option's decoded `branchEntryScene` (the
// `goto_on($store)` / `jump` target the branch-following walk followed) is the
// ROOT of that work's scene subtree.
//
// Honest boundary (reported in `WorkCarveDerivation`):
//   * What the decode GIVES: the game-select scene, its option COUNT, each
//     option's LABEL, and each option's dispatch target (`branchEntryScene`).
//     That is enough to carve the archive into N disjoint works and root a
//     per-work structure export — deterministically, from bytes.
//   * What it does NOT give: a SEMANTIC "this is the base game / that is the
//     fandisk". Naming rides on the option labels when present; otherwise it
//     needs another signal (Gameexe title metadata, scene-id ranges, operator
//     input). The carve records which naming signal it used.

import type { NarrativeMessage, NarrativeStructure } from "../structure-informed-context/index.js";
import {
  WorkCarveError,
  type CarvedWork,
  type WorkCarve,
  type WorkCarveDerivation,
} from "./shapes.js";

/** A scene qualifies as a game-select when its `select` offers ≥2 options. */
const MIN_GAME_SELECT_OPTIONS = 2;

export type CarveOptions = {
  /** Archive/title metadata id (packaging). Defaults to `archive`. */
  archiveRef?: string;
  /**
   * Force a specific scene as the game-select (overrides auto-detection).
   * Use when the operator knows the carve scene (e.g. from Gameexe).
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

/**
 * Pick the game-select scene from the decoded structure. Preference order:
 *   1. an explicit `gameSelectScene` override;
 *   2. the entry scene, when it offers ≥2 options (the archive's FIRST screen —
 *      Sweetie HD's game-select sits here);
 *   3. the first scene in dispatch order with ≥2 options.
 * Returns null when no scene offers a multi-option select (a single-work
 * archive).
 */
function pickGameSelectScene(
  structure: NarrativeStructure,
  override: number | undefined,
): { sceneId: number | null; how: WorkCarveDerivation["gameSelectSelectedBy"] } {
  if (override !== undefined) {
    const scene = structure.scenes.find((s) => s.sceneId === override);
    if (scene === undefined) {
      throw new WorkCarveError(`gameSelectScene ${override} not present in the decoded structure`);
    }
    if (scene.choices.length < MIN_GAME_SELECT_OPTIONS) {
      throw new WorkCarveError(
        `gameSelectScene ${override} offers ${scene.choices.length} option(s); a game-select needs ≥${MIN_GAME_SELECT_OPTIONS}`,
      );
    }
    return { sceneId: override, how: "provided" };
  }

  const entry = structure.scenes.find((s) => s.sceneId === structure.entryScene);
  if (entry !== undefined && entry.choices.length >= MIN_GAME_SELECT_OPTIONS) {
    return { sceneId: entry.sceneId, how: "entry-scene-select" };
  }

  // First scene in dispatch order (falling back to scene declaration order)
  // that offers a multi-option select.
  const orderedIds =
    structure.sceneDispatchOrder.length > 0
      ? structure.sceneDispatchOrder
      : structure.scenes.map((s) => s.sceneId);
  const byId = new Map(structure.scenes.map((s) => [s.sceneId, s] as const));
  for (const id of orderedIds) {
    const scene = byId.get(id);
    if (scene !== undefined && scene.choices.length >= MIN_GAME_SELECT_OPTIONS) {
      return { sceneId: scene.sceneId, how: "first-scene-with-choices" };
    }
  }

  return { sceneId: null, how: "none" };
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
  const { sceneId: gameSelectScene, how } = pickGameSelectScene(structure, options.gameSelectScene);

  // No game-select: the whole archive is ONE work.
  if (gameSelectScene === null) {
    const branchSpeakers = distinctSpeakers(structure.scenes.flatMap((s) => s.messages));
    const branchMessageCount = structure.scenes.reduce((n, s) => n + s.messages.length, 0);
    return {
      archiveRef,
      works: [
        {
          workId: `${archiveRef}#work:single`,
          optionIndex: 0,
          optionLabel: "",
          branchEntryScene: structure.entryScene,
          branchMessageCount,
          branchSpeakers,
        },
      ],
      derivation: {
        signal: "single-work-no-game-select",
        gameSelectScene: null,
        gameSelectSelectedBy: "none",
        namingSignal: "unknown",
        notes:
          "No ≥2-option select at/near the entry scene: the decode shows a single narrative work spanning the whole archive (no archive→works carve).",
      },
    };
  }

  const scene = structure.scenes.find((s) => s.sceneId === gameSelectScene);
  // pickGameSelectScene guarantees presence + ≥2 options.
  if (scene === undefined) {
    throw new WorkCarveError(`game-select scene ${gameSelectScene} vanished`);
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
      namingSignal,
      notes: `${rootNote} ${nameNote}`,
    },
  };
}
