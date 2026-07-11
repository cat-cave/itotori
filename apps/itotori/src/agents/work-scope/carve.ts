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
//     op (0,1,18)) — NOT to two disjoint story roots. Current decode evidence:
//     the New-Game routine (scene 9996) and every other menu/boot/system scene
//     in the archive decode to zero unknown opcodes in kaifuu, proven by the
//     `every_menu_boot_system_scene_decodes_to_zero_unknown` real-bytes pin.
//     When the decoded title/boot graph exposes a downstream fanout (for
//     example the New-Game routine's goto_on arms) whose branch targets are
//     distinct narrative roots, the carve follows that upstream context and
//     emits `upstream-title-boot-context`. If that evidence is absent, it still
//     reports `game-select-unresolved-options` rather than fabricating works.
//     Snapshot note: traced 2026-07-04 with the `boot_dispatch_scan` example
//     over the real Seen.txt; scene-ids/opcode-ids only, no copyrighted text.
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
// RealLive title/boot helpers are not safely identified by a broad high
// scene-id range: story routes can also dispatch through silent high-id scenes.
// Keep this deliberately explicit. The validated Sweetie HD New-Game routine
// is scene 9996, decoded by the staged structure export path. Other titles
// must supply additional real title/boot evidence through
// `titleBootContinuationScenes` instead of being inferred from id size.
const DEFAULT_TITLE_BOOT_CONTINUATION_SCENES = new Set<number>([9996]);

export type CarveOptions = {
  /** Archive/title metadata id (packaging). Defaults to `archive`. */
  archiveRef?: string;
  /**
   * Force a specific scene as the game-select (overrides auto-detection).
   * Use when the operator knows the carve scene (e.g. from Gameexe or the
   * button-object game-select the headless decode cannot cross into).
   */
  gameSelectScene?: number;
  /**
   * OPERATOR entry-scene override — the deterministic escape hatch for the
   * `game-select-unresolved-options` case. Roots the base (and/or fandisk)
   * works DIRECTLY from operator-supplied entry scenes, bypassing the decoded
   * game-select entirely. One work is carved per declared entry scene, in
   * declaration order; each entry scene is validated to be PRESENT in the
   * decode and the entry scenes must be DISTINCT (the disjoint-works
   * invariant).
   *
   * Whole-game targeting via config: supply ONE entry scene to target a
   * BASE-ONLY localize run, or TWO (base + fandisk) to target both. This is
   * the seam an unattended whole-game localize run consumes when the decoded
   * game-select is a title MENU that does not statically enumerate per-work
   * story roots.
   *
   * Takes precedence over `gameSelectScene` when both are supplied (the entry
   * scenes are the more direct rooting — the game-select is moot once the work
   * roots are pinned).
   *
   * Sweetie HD (Sukara/Oshioki) — how an operator finds the base + fandisk
   * entry scenes: all 198 populated scenes now decode (decode-100), but the
   * decode carries NO per-work entry-scene list (the game-select is a title
   * MENU and Gameexe.ini carries no per-work entry-scene list either), so
   * which decoded scene roots the base vs the fandisk is NOT statically
   * determinable. An operator resolves it OUTSIDE the decode and pins it here:
   *
   *   1. play the title to the New-Game branch point and record the scene id
   *      the base-game path and the fandisk path each dispatch into (the
   *      `farcall`/`jump` target the New-Game routine follows per branch), or
   *   2. read it off the game's own scenario layout / a community scene-id map,
   *      or
   *   3. derive it from the dispatch graph `utsushi structure` emits (the
   *      New-Game routine's `goto_case($store)` arms route to the base root and
   *      the fandisk root respectively — pick the two story-root scenes).
   *
   * The override is GAME-AGNOSTIC config/scoping logic: it carries only entry
   * scene METADATA (scene ids + optional labels/slugs), never game bytes.
   */
  entryScenes?: CarveWorkEntryOverride[];
  /**
   * Additional decoded title/boot continuation scene ids that are allowed to
   * fan out into work roots when the button-object title menu itself does not
   * enumerate per-work options.
   *
   * This is intentionally explicit. A high scene id alone is not evidence:
   * silent story-route dispatchers can also live in high ids and must remain
   * inside one unresolved/single work unless an operator/exporter supplies a
   * real title/boot signal.
   */
  titleBootContinuationScenes?: number[];
};

/**
 * One operator-supplied work entry scene — the deterministic rooting unit for
 * the `entryScenes` override. The scene MUST exist in the decoded archive; the
 * carve validates presence (and distinctness across the declared set).
 */
export type CarveWorkEntryOverride = {
  /** The scene id that roots this work's subtree (must exist in the decode). */
  scene: number;
  /** Optional operator label (e.g. "base game", "fandisk") — a naming signal. */
  label?: string;
  /**
   * Optional stable slug for the workId (e.g. "base", "fandisk"). When absent
   * the workId suffix is `entry:<scene>`. Stable across runs so scope-graph
   * seeds can key off it. Must be unique within the override set.
   */
  workSlug?: string;
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
 * Root the works DETERMINISTICALLY from the operator-supplied entry-scene
 * override — the escape hatch for the `game-select-unresolved-options` case.
 *
 * Validates every declared entry scene is PRESENT in the decode and that the
 * entry scenes (and work slugs) are DISTINCT — the disjoint-works invariant
 * the decoded game-select path also enforces. Emits the
 * `operator-entry-scene-override` derivation signal.
 */
function carveFromOperatorEntryScenes(
  structure: NarrativeStructure,
  overrides: CarveWorkEntryOverride[],
  archiveRef: string,
): WorkCarve {
  if (overrides.length === 0) {
    throw new WorkCarveError("entryScenes override must declare at least one entry scene");
  }
  const sceneById = new Map(structure.scenes.map((s) => [s.sceneId, s] as const));
  const seenScenes = new Set<number>();
  const seenSlugs = new Set<string>();
  const works: CarvedWork[] = overrides.map((entry, index) => {
    const scene = sceneById.get(entry.scene);
    if (scene === undefined) {
      throw new WorkCarveError(
        `entryScenes[${index}].scene ${entry.scene} is not present in the decoded archive`,
      );
    }
    if (seenScenes.has(entry.scene)) {
      throw new WorkCarveError(
        `entryScenes[${index}].scene ${entry.scene} duplicates an earlier entry scene ` +
          `(works must root DISTINCT subtrees)`,
      );
    }
    seenScenes.add(entry.scene);
    const slug = entry.workSlug;
    if (slug !== undefined) {
      if (slug.length === 0) {
        throw new WorkCarveError(`entryScenes[${index}].workSlug must be a non-empty string`);
      }
      if (seenSlugs.has(slug)) {
        throw new WorkCarveError(
          `entryScenes[${index}].workSlug "${slug}" duplicates an earlier entry's slug`,
        );
      }
      seenSlugs.add(slug);
    }
    return {
      workId: `${archiveRef}#work:entry:${slug ?? entry.scene}`,
      optionIndex: index,
      optionLabel: entry.label ?? "",
      branchEntryScene: entry.scene,
      branchMessageCount: scene.messages.length,
      branchSpeakers: distinctSpeakers(scene.messages),
    };
  });

  const labelsPresent = works.every((w) => w.optionLabel.length > 0);
  const namingSignal: WorkCarveDerivation["namingSignal"] = labelsPresent ? "provided" : "unknown";
  const nameNote =
    namingSignal === "provided"
      ? "Works are named from the operator-supplied entry-scene labels (the operator naming signal)."
      : "No operator labels supplied: works are named by entry scene only (supply `label` for a base/fandisk naming signal).";

  return {
    archiveRef,
    works,
    derivation: {
      signal: "operator-entry-scene-override",
      gameSelectScene: null,
      gameSelectSelectedBy: "none",
      selectionControl: "none",
      namingSignal,
      notes:
        `Operator entry-scene override rooted ${String(works.length)} work(s) ` +
        `deterministically from declared entry scene(s) (${works
          .map((w) => String(w.branchEntryScene))
          .join(", ")}), bypassing the decoded game-select. ` +
        `Each entry scene was validated present in the decode and the entry scenes are distinct. ` +
        `${nameNote}`,
    },
  };
}

function sceneById(
  structure: NarrativeStructure,
): Map<number, NarrativeStructure["scenes"][number]> {
  return new Map(structure.scenes.map((s) => [s.sceneId, s] as const));
}

function pushDistinct(targets: number[], target: number | null, currentScene: number): void {
  if (target !== null && target !== currentScene && !targets.includes(target)) {
    targets.push(target);
  }
}

function dispatchTargets(scene: NarrativeStructure["scenes"][number]): number[] {
  const targets: number[] = [];
  pushDistinct(targets, scene.nextScene, scene.sceneId);
  for (const target of scene.dispatchFanoutScenes ?? []) {
    pushDistinct(targets, target, scene.sceneId);
  }
  const choices = [...scene.choices].sort((a, b) => a.optionIndex - b.optionIndex);
  for (const choice of choices) {
    pushDistinct(targets, choice.branchEntryScene, scene.sceneId);
  }
  return targets;
}

function reachesNarrativeContent(
  rootScene: number,
  scenes: Map<number, NarrativeStructure["scenes"][number]>,
): boolean {
  const seen = new Set<number>();
  const queue: number[] = [rootScene];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const scene = scenes.get(current);
    if (scene === undefined) continue;
    if (scene.messages.length > 0) {
      return true;
    }
    for (const target of dispatchTargets(scene)) {
      if (!seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return false;
}

function isPureDispatchScene(scene: NarrativeStructure["scenes"][number]): boolean {
  return scene.messages.length === 0 && scene.choices.length === 0;
}

function hasRawDispatchFanout(scene: NarrativeStructure["scenes"][number]): boolean {
  return (scene.dispatchFanoutScenes ?? []).some((target) => target !== scene.sceneId);
}

function titleBootContinuationScenes(extra: ReadonlyArray<number> | undefined): Set<number> {
  const scenes = new Set(DEFAULT_TITLE_BOOT_CONTINUATION_SCENES);
  for (const scene of extra ?? []) {
    scenes.add(scene);
  }
  return scenes;
}

function isSystemLikeTitleBootContinuation(
  scene: NarrativeStructure["scenes"][number],
  allowedContinuationScenes: ReadonlySet<number>,
): boolean {
  return (
    isPureDispatchScene(scene) &&
    hasRawDispatchFanout(scene) &&
    scene.selectionControl === "none" &&
    allowedContinuationScenes.has(scene.sceneId)
  );
}

function hasUpstreamTitleBootFanoutEvidence(scene: NarrativeStructure["scenes"][number]): boolean {
  return (
    scene.selectionControl === "button-object" &&
    hasRawDispatchFanout(scene) &&
    dispatchTargets(scene).length >= 3
  );
}

function resolveFromUpstreamTitleBootContext(
  structure: NarrativeStructure,
  archiveRef: string,
  gameSelectScene: number,
  gameSelectSelectedBy: WorkCarveDerivation["gameSelectSelectedBy"],
  selectionControl: SelectionControlSignal,
  allowedContinuationScenes: ReadonlySet<number>,
): WorkCarve | null {
  const scenes = sceneById(structure);
  const start = scenes.get(gameSelectScene);
  if (start === undefined) {
    return null;
  }
  if (
    structure.entryScene !== gameSelectScene ||
    start.selectionControl !== "button-object" ||
    !hasUpstreamTitleBootFanoutEvidence(start)
  ) {
    return null;
  }

  const visited = new Set<number>();
  const queue: number[] = [gameSelectScene];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const scene = scenes.get(current);
    if (scene === undefined) continue;

    const stillInTitleBootContext =
      current === gameSelectScene ||
      isSystemLikeTitleBootContinuation(scene, allowedContinuationScenes);
    if (!stillInTitleBootContext) {
      continue;
    }

    const roots = dispatchTargets(scene).filter(
      (target) => scenes.has(target) && reachesNarrativeContent(target, scenes),
    );
    const distinctRoots = [...new Set(roots)];
    if (distinctRoots.length >= MIN_GAME_SELECT_OPTIONS) {
      const works: CarvedWork[] = distinctRoots.map((root, index) => {
        const rootScene = scenes.get(root)!;
        return {
          workId: `${archiveRef}#work:upstream:${root}`,
          optionIndex: index,
          optionLabel: "",
          branchEntryScene: root,
          branchMessageCount: rootScene.messages.length,
          branchSpeakers: distinctSpeakers(rootScene.messages),
        };
      });
      return {
        archiveRef,
        works,
        derivation: {
          signal: "upstream-title-boot-context",
          gameSelectScene,
          gameSelectSelectedBy,
          selectionControl,
          namingSignal: "unknown",
          notes:
            `The button-object game-select (scene ${gameSelectScene}) did not enumerate per-work options, ` +
            `so the carve followed the decoded upstream title/boot dispatch graph. Scene ${current} ` +
            `fans out to distinct narrative root scene(s) (${distinctRoots.join(", ")}); each root is ` +
            `present in the decode and reaches narrative messages. Work naming remains unknown because ` +
            `the title/boot dispatch supplies roots, not semantic base/fandisk labels.`,
        },
      };
    }

    if (distinctRoots.length !== 1) {
      continue;
    }
    const onlyRoot = distinctRoots[0];
    if (onlyRoot === undefined) {
      continue;
    }
    const onlyRootScene = scenes.get(onlyRoot);
    if (
      onlyRootScene !== undefined &&
      isSystemLikeTitleBootContinuation(onlyRootScene, allowedContinuationScenes) &&
      !visited.has(onlyRoot)
    ) {
      queue.push(onlyRoot);
    }
  }

  return null;
}

function choicesResolveDistinctRoots(scene: NarrativeStructure["scenes"][number]): boolean {
  const roots = scene.choices.map((choice) => choice.branchEntryScene);
  if (roots.length < MIN_GAME_SELECT_OPTIONS || roots.some((root) => root === null)) {
    return false;
  }
  return new Set(roots).size === roots.length;
}

function resolvedChoiceRoots(
  scene: NarrativeStructure["scenes"][number],
): { allResolved: false; roots: number[] } | { allResolved: true; roots: number[] } {
  const roots: number[] = [];
  for (const choice of scene.choices) {
    if (choice.branchEntryScene === null) {
      return { allResolved: false, roots };
    }
    roots.push(choice.branchEntryScene);
  }
  return { allResolved: true, roots };
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
  const allowedContinuationScenes = titleBootContinuationScenes(
    options.titleBootContinuationScenes,
  );

  // OPERATOR entry-scene override takes precedence: when the operator pins the
  // base (and/or fandisk) entry scene(s), carve roots the works directly from
  // them — the decoded game-select is moot once the work roots are supplied.
  if (options.entryScenes !== undefined && options.entryScenes.length > 0) {
    return carveFromOperatorEntryScenes(structure, options.entryScenes, archiveRef);
  }

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
  // not enumerable into distinct rooted works (Sweetie HD scene 2: a
  // `select_objbtn` title MENU whose goto_case($store) branches dispatch to
  // menu/config scenes + a store-relative New-Game routine, not to enumerable
  // per-work story roots). Button labels with null branch roots are not enough
  // evidence to carve works; try the upstream title/boot graph, then report the
  // typed unresolved boundary rather than fabricating unrooted works.
  const choiceRoots = resolvedChoiceRoots(scene);
  if (
    scene.choices.length >= MIN_GAME_SELECT_OPTIONS &&
    choiceRoots.allResolved &&
    new Set(choiceRoots.roots).size !== choiceRoots.roots.length
  ) {
    throw new WorkCarveError(
      `game-select options do not root DISTINCT works: branchEntryScenes ${choiceRoots.roots.join(", ")} collide`,
    );
  }

  if (!choicesResolveDistinctRoots(scene)) {
    const upstreamCarve = resolveFromUpstreamTitleBootContext(
      structure,
      archiveRef,
      gameSelectScene,
      how,
      selectionControl,
      allowedContinuationScenes,
    );
    if (upstreamCarve !== null) {
      return upstreamCarve;
    }
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
          `${scene.choices.length} option label(s) without ${MIN_GAME_SELECT_OPTIONS} distinct resolved branch root(s): the select is a title MENU whose branches dispatch (goto_case on $store) to menu/config scenes and/or a store-relative New-Game routine, NOT to enumerable per-work story roots. The works cannot be rooted from the decode alone; rooting them needs upstream/operator context (a per-work entry-scene list) — which the decode does not provide because the split is runtime menu state, even though the New-Game routine itself now decodes cleanly.`,
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
