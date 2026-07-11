// itotori-multi-work-context-scope-model — shapes.
//
// The CONTEXT unit is the narrative WORK, NOT the archive/title. One title /
// archive may bundle MULTIPLE works: Sweetie HD is a single archive that holds
// TWO works — an HD remaster of the original Sweetie AND its fandisk — which is
// exactly why the FIRST screen is a game-select. The game-select (the drivable
// `select_objbtn` the decode makes work) IS the archive→works carve; routes
// subdivide a work further.
//
// So scopes form a GRAPH, not a per-archive tree:
//
//     shared Scope (brand / collection)         ← parent, inheritable
//        ⊃ WorkScope (per work)                 ← the context unit
//             ⊃ route / arc                      (subdivides a work; future)
//
// with archive/title kept as METADATA that maps to works (1-title→N-works).
// The works are DERIVED from the decoded game-select (see `carve.ts`), never
// a hardcoded list. A WorkScope INHERITS the shared scope's glossary +
// characters and may OVERRIDE them (a fandisk may deliberately diverge).

import type { NarrativeStructure } from "../structure-informed-context/index.js";

// ---------------------------------------------------------------------------
// The archive→works carve (derived from the decoded game-select).
// ---------------------------------------------------------------------------

/**
 * How the carve identified the game-select whose options are the works. The
 * decode does NOT semantically label "this select carves the archive"; the
 * derivation reads it off the decoded structure (position + option branches),
 * so this records the honest signal used.
 */
export type WorkCarveDerivation = {
  /**
   * `game-select-option-branches` — the archive carved on the button-object
   * game-select; each of its ≥2 enumerable option branches is a work.
   * `game-select-unresolved-options` — a button-object game-select IDENTIFIES
   * the archive as multi-work, but its option branches are not enumerable on
   * the select scene (Sweetie HD scene 2: a title MENU whose goto_case($store)
   * branches dispatch to menu/config scenes + a store-relative New-Game routine,
   * not to enumerable per-work story roots); rooting the works needs
   * upstream/operator context the decode does not provide.
   * `upstream-title-boot-context` — the game-select itself did not enumerate
   * per-work options, but the decoded upstream title/boot dispatch graph did:
   * following its goto_on / dispatch fanout reached distinct narrative root
   * scenes, so the carve rooted works from those real decoded roots.
   * `operator-manifest` — a typed work-manifest supplied entry-point metadata
   * and the resolver validated it against the decoded archive before bridging
   * it into the carve model.
   * `operator-entry-scene-override` — the operator supplied the base (and/or
   * fandisk) entry scene(s) directly via `CarveOptions.entryScenes`, so the
   * carve rooted the works DETERMINISTICALLY from those entry scenes without
   * going through the decoded game-select (the escape hatch for the
   * `game-select-unresolved-options` case). A whole-archive localize run can
   * target base-only (one entry scene) or base+fandisk (two) via this override.
   * `single-work-no-game-select` — no button-object game-select present AND no
   * operator entry-scene override, the whole archive is ONE work (any text-window
   * selects are in-story branches).
   */
  signal:
    | "game-select-option-branches"
    | "game-select-unresolved-options"
    | "upstream-title-boot-context"
    | "operator-manifest"
    | "operator-entry-scene-override"
    | "single-work-no-game-select";
  /** The scene whose select carves the archive (the game-select), or null. */
  gameSelectScene: number | null;
  /** How that scene was picked as the game-select. */
  gameSelectSelectedBy: "provided" | "button-object-select" | "none";
  /**
   * The decoded `selectionControl` marker of the picked game-select scene —
   * the HARDENED identification signal. `button-object` is the archive
   * game-select (`select_objbtn`); a `text-window` select is never picked as
   * the archive boundary. `none` when no game-select was found.
   */
  selectionControl: "button-object" | "text-window" | "none";
  /**
   * What names the works. The decode gives the option LABELS (the
   * `choice:<idx>` text) — a naming signal when non-empty — but NOT a
   * semantic "base game" vs "fandisk". `option-label` = labels present;
   * `provided` = caller supplied names; `unknown` = neither (needs another
   * signal, e.g. Gameexe title metadata or scene-id-range heuristics).
   */
  namingSignal: "option-label" | "provided" | "unknown";
  /** Free-text honest boundary note for operators. */
  notes: string;
};

/** One work carved out of the archive by a game-select option. */
export type CarvedWork = {
  /** Deterministic id: `${archiveRef}#work:${gameSelectScene}:${optionIndex}`. */
  workId: string;
  /** The game-select option index that selects this work. */
  optionIndex: number;
  /** The decoded option label (naming signal; may be empty). */
  optionLabel: string;
  /**
   * The scene this option DISPATCHES INTO (the decoded `branchEntryScene` /
   * goto_on target) — the ROOT of this work's scene subtree, or null when the
   * decode did not resolve a cross-scene dispatch for the option.
   */
  branchEntryScene: number | null;
  /** Non-choice message count in the option's immediate branch (a magnitude signal). */
  branchMessageCount: number;
  /** Distinct speakers seen in the option's immediate branch, first-appearance order. */
  branchSpeakers: string[];
};

/** The full archive→works carve. */
export type WorkCarve = {
  /** Archive/title metadata id (packaging, NOT the context unit). */
  archiveRef: string;
  /** The works, in game-select option order. */
  works: CarvedWork[];
  derivation: WorkCarveDerivation;
};

export class WorkCarveError extends Error {
  constructor(detail: string) {
    super(`work-scope carve: ${detail}`);
    this.name = "WorkCarveError";
  }
}

// ---------------------------------------------------------------------------
// The scope GRAPH: a shared parent scope + per-work scopes that inherit it.
// ---------------------------------------------------------------------------

export type ScopeGlossaryPolicyAction = "localize" | "romanize" | "do_not_translate";

/**
 * One glossary term at scope level. The shared scope carries the brand/world
 * canonical rendering; a WorkScope may OVERRIDE by `sourceForm` (same source
 * term, divergent target — a fandisk renders a term differently).
 */
export type ScopeGlossaryEntry = {
  /** Merge key: the source term as it appears in the script. */
  sourceForm: string;
  /** The canonical target rendering at this scope. */
  targetForm: string;
  policyAction?: ScopeGlossaryPolicyAction | undefined;
};

/**
 * One character at scope level. The shared scope carries the brand/world
 * canonical character (name + voice note); a WorkScope may OVERRIDE by
 * `characterId` (a fandisk may age-up a character, change a title, etc.).
 */
export type ScopeCharacter = {
  /** Merge key: stable character id (brand-scoped). */
  characterId: string;
  /** Canonical display name at this scope. */
  displayName: string;
  /** Optional voice / register note the translate stage should honour. */
  voiceNote?: string | undefined;
};

/**
 * The shared super-scope (brand / collection level): the glossary + character
 * store that MULTIPLE works inherit from and contribute back to. This is where
 * cross-work consistency lives (Sweetie HD base + fandisk share characters and
 * world → shared glossary).
 */
export type SharedScope = {
  scopeId: string;
  kind: "shared";
  /** Human label (e.g. brand or collection name). */
  label: string;
  glossary: ScopeGlossaryEntry[];
  characters: ScopeCharacter[];
};

/**
 * A per-work scope. Inherits its parent `SharedScope`'s glossary + characters
 * and may add/override its own. Holds the work's OWN decoded structure (its
 * scene subgraph) so its structure-informed context is built per work.
 */
export type WorkScope = {
  scopeId: string;
  kind: "work";
  /** The carved work this scope realises. */
  workId: string;
  /** Parent shared scope id (the inheritance edge). */
  parentScopeId: string;
  /** Archive/title this work is packaged in (metadata). */
  archiveRef: string;
  /** The game-select option index that selects this work. */
  optionIndex: number;
  /** Human label for the work (from the carve's naming signal). */
  label: string;
  /** Per-work glossary additions/overrides (override shared by `sourceForm`). */
  glossaryOverrides: ScopeGlossaryEntry[];
  /** Per-work character additions/overrides (override shared by `characterId`). */
  characterOverrides: ScopeCharacter[];
  /**
   * The work's OWN decoded narrative structure, rooted at its
   * `branchEntryScene`. Absent until the per-work `utsushi structure` export has run;
   * `buildWorkScopedContext` requires it.
   */
  structure?: NarrativeStructure | undefined;
};

/**
 * The scope GRAPH: one shared parent + N work scopes + the title→works
 * metadata map (1-title→N-works). Deterministic — no ordering ambiguity.
 */
export type ScopeGraph = {
  shared: SharedScope;
  works: WorkScope[];
  /** archiveRef → workIds it bundles (packaging metadata mapping to works). */
  titleToWorks: Record<string, string[]>;
};

export class ScopeGraphError extends Error {
  constructor(detail: string) {
    super(`work-scope graph: ${detail}`);
    this.name = "ScopeGraphError";
  }
}

// ---------------------------------------------------------------------------
// Resolved (inherited + overridden) scope.
// ---------------------------------------------------------------------------

export type ScopeMemberProvenance = "inherited" | "override";

/**
 * The effective glossary/characters a work translates under: the shared scope
 * MERGED with the work's overrides (override wins). Every member records its
 * provenance so the boundary (what came from the shared scope vs the work) is
 * auditable.
 */
export type EffectiveScope = {
  workId: string;
  glossary: Array<ScopeGlossaryEntry & { provenance: ScopeMemberProvenance }>;
  characters: Array<ScopeCharacter & { provenance: ScopeMemberProvenance }>;
};
