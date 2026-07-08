// itotori-structure-informed-context-building — shapes.
//
// The full-stack synergy: the Kaifuu/Utsushi decode DETERMINISTICALLY
// recovers the narrative STRUCTURE of a RealLive title — the scene-dispatch
// graph, the choice/branch subsystem, the `#NAMAE` speaker decode, and the
// per-scene play-order message stream. The itotori context-building stage
// CONSUMES that KNOWN structure (it does NOT re-infer structure from the
// prose) to build three structurally-grounded context artifacts —
// per-scene summaries, a route/branch map, and character-arc tracking —
// which are injected into the translate stage.
//
// `NarrativeStructure` is the exact JSON shape emitted by the Rust exporter
// `utsushi-reallive/examples/structure_export.rs`
// (schemaVersion `utsushi.narrative-structure.v1`). Every field below is a
// verbatim decode observation, NOT an LLM guess.

/** One play-order message, read from `TextLine` (speaker + text + surface). */
export type NarrativeMessage = {
  /** 0-based position in the scene's single-pass play order. */
  order: number;
  /** Resolved `#NAMAE`/`【…】` speaker display name, or null for narration. */
  speaker: string | null;
  /** UTF-8 decoded body (speaker prefix already stripped by the decode). */
  text: string;
  /** Engine surface label, e.g. `choice:0` for a `select {}` option line. */
  textSurface: string | null;
};

/** One `select {}` option and the branch (message stream) it leads into. */
export type NarrativeChoice = {
  /** The option index the branch-following walk drove (`HeadlessChoicePolicy::Fixed`). */
  optionIndex: number;
  /** The option's display label (the `choice:<idx>`-tagged play-order line). */
  label: string;
  /**
   * The scene this option DISPATCHES INTO — the branch-following walk's
   * `first_cross_scene` (the real `goto_on($store)` / `jump` target), or null
   * when the branch stays within the select's own scene. For the archive's
   * opening game-select (Sweetie HD: base-game vs fandisk) this is the ROOT
   * of the work the option selects — the decode signal the work-scope carve
   * reads to root a per-WORK narrative structure (NOT a hardcoded work list).
   *
   * Optional in the parse for backward compatibility with pre-enrichment
   * exporter JSON (absent → null); the enriched `structure_export.rs` always
   * emits it.
   */
  branchEntryScene: number | null;
  /** The messages that acting on this option leads into (choice lines filtered out). */
  branchMessages: NarrativeMessage[];
};

/**
 * The scene's decoded `module_sel` SelectionControl signal — the REAL-bytes
 * marker (from `structure_export.rs`, statically decoded per scene) of WHAT
 * KIND of select the scene carries:
 *   - `button-object`: a GRAPHICAL button-object select (`select_objbtn`
 *     (0,2,4) / `objbtn_init` (0,2,20) — Sweetie HD's base-vs-fandisk
 *     game-select + the route / clothing picks). This is the archive-carve
 *     game-select marker.
 *   - `text-window`: a plain text `select`/`select_w` option block (the
 *     in-story dialogue yes/no branches — NOT an archive boundary).
 *   - `none`: no select in the scene.
 * Optional in the parse for backward compatibility with pre-enrichment
 * exporter JSON (absent → `none`).
 */
export type SelectionControlSignal = "button-object" | "text-window" | "none";

/** One scene of the decoded playthrough. */
export type NarrativeScene = {
  /** RealLive scene id. */
  sceneId: number;
  /** The scene's decoded SelectionControl signal (button-object vs text-window). */
  selectionControl: SelectionControlSignal;
  /**
   * The first cross-scene dispatch target this scene's branch-following walk
   * followed (a real `jump`/`farcall`/entrypoint resolution), or null when
   * play stayed within the scene. This IS the scene-dispatch graph edge.
   */
  nextScene: number | null;
  /** The scene's play-order message stream (single pass, no doubling). */
  messages: NarrativeMessage[];
  /** The scene's choice prompt(s) + per-option branch streams. */
  choices: NarrativeChoice[];
};

/** The full decoded narrative structure for a bounded playthrough slice. */
export type NarrativeStructure = {
  schemaVersion: "utsushi.narrative-structure.v1";
  entryScene: number;
  /**
   * The distinct scene ids in dispatch order: the order the play-loop first
   * reaches each scene, walking the scene-dispatch graph from `entryScene`
   * (fallthrough successor, then choice branches), first-visit wins — NOT
   * archive slot order. Any archive scenes never reached from the entry are
   * appended afterward in slot order (unreachable ≠ dropped) so this stays a
   * complete listing of every scene.
   */
  sceneDispatchOrder: number[];
  scenes: NarrativeScene[];
};

// ---------------------------------------------------------------------------
// The three structurally-grounded context artifacts.
// ---------------------------------------------------------------------------

/**
 * (a) Per-scene summary — built from the message STREAM (speaker presence,
 * line counts, opening line, choice-gating, dispatch successor). Every field
 * is a deterministic reduction of the decode; nothing is model-generated.
 */
export type SceneSummaryArtifact = {
  /** Stable citation ref, e.g. `scene-summary:6010`. */
  artifactRef: string;
  sceneId: number;
  /** Non-choice message count. */
  messageCount: number;
  /** Distinct speakers, in first-appearance (play) order. */
  speakers: string[];
  /** The first speaking (non-narration) speaker, or null. */
  openingSpeaker: string | null;
  hasChoices: boolean;
  choiceCount: number;
  /** The scene-dispatch successor (from `nextScene`), or null. */
  nextScene: number | null;
  /** A deterministic, human-legible one-line summary. */
  summaryText: string;
};

export type RouteBranchEdgeKind = "dispatch" | "choice";

/** One directed edge of the route/branch map. */
export type RouteBranchEdge = {
  fromScene: number;
  /** Target scene for a `dispatch` edge; the branch node id for a `choice`. */
  to: string;
  kind: RouteBranchEdgeKind;
  /** Present for `choice` edges. */
  choiceIndex?: number;
  choiceLabel?: string;
  /** Branch message count (choice edges only). */
  branchMessageCount?: number;
};

/**
 * (b) Route/branch map — built from the scene-dispatch graph + the choice
 * graph (which choice leads where). `dispatch` edges are the real
 * cross-scene `jump`/`farcall` targets; `choice` edges name each option's
 * branch node so a translator knows a line sits behind choice K.
 */
export type RouteBranchMap = {
  artifactRef: string;
  entryScene: number;
  dispatchOrder: number[];
  edges: RouteBranchEdge[];
};

/**
 * (c) Character-arc tracking — built from speaker presence across the
 * dispatch order: which scenes a speaker appears in, their line count per
 * scene, and their first/last scene. Structural, not inferred.
 */
export type CharacterArc = {
  /** Stable citation ref, e.g. `character-arc:和人`. */
  artifactRef: string;
  speaker: string;
  /** Scene ids the speaker appears in, in dispatch order. */
  scenesPresent: number[];
  totalLines: number;
  /** Per-scene line count, keyed by scene id (stringified). */
  linesByScene: Record<string, number>;
  firstScene: number;
  lastScene: number;
  summaryText: string;
};

/** The full artifact bundle built from one `NarrativeStructure`. */
export type StructureContextArtifacts = {
  sceneSummaries: SceneSummaryArtifact[];
  routeBranchMap: RouteBranchMap;
  characterArcs: CharacterArc[];
};

/**
 * The context payload injected into ONE translate-stage invocation for a
 * slice drawn from a single scene: that scene's summary, its position in the
 * route/branch map, and the character arcs of the speakers present. Rendered
 * into the translation prompt by the translate stage.
 */
export type StructuredContextInjection = {
  sceneId: number;
  sceneSummaryText: string;
  routePositionText: string;
  characterArcsText: string;
  /** The artifact refs this block draws on (citable via `citationRefs`). */
  artifactRefs: string[];
};

export class NarrativeStructureParseError extends Error {
  constructor(detail: string) {
    super(`narrative structure invalid: ${detail}`);
    this.name = "NarrativeStructureParseError";
  }
}
