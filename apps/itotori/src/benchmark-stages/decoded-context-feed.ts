// benchmark-decoded-context-feed — the fair, anti-circular judge context feed.
//
// Methodology §5 (docs/itotori-translation-benchmark-methodology.md). The blind
// judge panel scores each source unit's contestant candidates informed by the
// DETERMINISTIC Kaifuu/Utsushi-decoded GROUND TRUTH for that unit — speaker,
// scene, branch position, source line, position in the dispatch graph. Two
// boundaries are enforced here IN CODE:
//
//   1. EQUAL CONTEXT — the identical decoded-ground-truth context is attached to
//      EVERY contestant's candidate for a given unit. No contestant is judged
//      with richer context than another. (One `DecodedGroundTruthContext` per
//      unit, shared by every candidate — see `buildDecodedContextFeed`.)
//
//   2. NO ITOTORI-INTERPRETIVE LEAKAGE (anti-circularity) — the judge feed is
//      decoded GROUND TRUTH ONLY. It MUST NOT carry any artifact produced by
//      prompt-facing derived context (scene descriptions, character notes,
//      route narration, glossaries,
//      style notes). Feeding the judge Itotori's own interpretation would let
//      Itotori grade itself against its own read of the script — circular and
//      self-favorable.
//
// The boundary is between DECODE (allowed: the `NarrativeStructure` emitted by
// the deterministic decode) and INTERPRETATION (forbidden in the judge feed:
// any prompt-facing projection). It is drawn by
// PRODUCER, not by determinism: even though Itotori's summaries are themselves
// deterministic reductions, §5 forbids anything produced by the context-building
// stage from entering the judge feed.
//
// IMPORTANT (§5 nuance): this boundary governs the JUDGE feed ONLY. Itotori-the-
// CONTESTANT still legitimately drafts with its full interpretive context — that
// ON/OFF ablation (§6) is exactly what the benchmark measures. Nothing in this
// module touches the contestant/drafting path; it only assembles judge inputs.

import type {
  NarrativeChoice,
  NarrativeMessage,
  NarrativeScene,
  NarrativeStructure,
} from "../structure/index.js";

/** Raised when the decoded-context feed inputs are missing or inconsistent. */
export class DecodedContextFeedError extends Error {
  constructor(detail: string) {
    super(`decoded-context-feed refused: ${detail}`);
    this.name = "DecodedContextFeedError";
  }
}

// ---------------------------------------------------------------------------
// Locating a benchmark source unit inside the decoded structure.
// ---------------------------------------------------------------------------

/**
 * Locator binding one benchmark source unit to its decoded message. A unit is
 * one decoded play-order message: the scene it plays in, its order within that
 * scene's stream, and — when it sits inside a choice branch rather than the
 * scene's main stream — the option index of that branch.
 */
export type DecodedContextUnitRef = {
  /** UUID7 bridge-unit id (the benchmark corpus unit). */
  unitId: string;
  /** RealLive scene id the unit plays in. */
  sceneId: number;
  /** 0-based `order` of the message within its stream (main or branch). */
  messageOrder: number;
  /**
   * When the unit sits inside a `select {}` branch, the option index of that
   * branch; null/omitted for a main-stream (non-branch) line.
   */
  branchOptionIndex?: number | null;
};

// ---------------------------------------------------------------------------
// The judge feed shape — DECODED GROUND TRUTH ONLY.
// ---------------------------------------------------------------------------

/** The unit's decoded scene position (from the scene-dispatch graph). */
export type DecodedScenePosition = {
  sceneId: number;
  /** 1-based index in `sceneDispatchOrder`, or null when the scene is absent. */
  dispatchPosition: number | null;
  /** Total distinct scenes the play-loop crossed (denominator for the above). */
  dispatchOrderLength: number;
  /** The real cross-scene dispatch successor edge (`nextScene`), or null. */
  nextScene: number | null;
};

/** The unit's decoded branch position (from the choice subsystem), if any. */
export type DecodedBranchPosition = {
  /** The option index the branch-following walk drove. */
  optionIndex: number;
  /** The option's decoded display label. */
  label: string;
  /** The scene the option dispatches INTO, or null (branch stays in-scene). */
  branchEntryScene: number | null;
};

/**
 * The per-unit context fed to the judge panel — deterministic decoded GROUND
 * TRUTH ONLY. Every field is a verbatim decode observation (speaker / scene /
 * branch / source line / dispatch position). This type is CLOSED: it carries no
 * field sourced from Itotori's context-building stage. The compile-time
 * boundary `_JudgeFeedIsGroundTruthOnly` below (and the runtime
 * `assertJudgeFeedGroundTruthOnly`) enforce that this stays true.
 */
export type DecodedGroundTruthContext = {
  unitId: string;
  /** Resolved `#NAMAE`/`【…】` speaker display name, or null for narration. */
  speaker: string | null;
  /** The decoded source line (`NarrativeMessage.text`) — the untranslated body. */
  sourceLine: string;
  /** Engine surface label, e.g. `choice:0`, or null. */
  textSurface: string | null;
  /** The unit's position in the scene-dispatch graph. */
  scene: DecodedScenePosition;
  /** The unit's branch position, or null when it is a main-stream line. */
  branch: DecodedBranchPosition | null;
};

/** One anonymized contestant candidate for a unit (blinded per §4.2). */
export type ContestantCandidate = {
  /** Provenance-anonymized contestant id (never the real system name). */
  contestantId: string;
  unitId: string;
  /** The candidate translation being judged. */
  candidateText: string;
};

/**
 * One unit's judge input: the SINGLE decoded-ground-truth context (boundary #1
 * — identical for every candidate) plus the anonymized candidate set. The judge
 * scores each candidate against this shared context.
 */
export type JudgeUnitInput = {
  unitId: string;
  decodedContext: DecodedGroundTruthContext;
  candidates: ContestantCandidate[];
};

// ---------------------------------------------------------------------------
// The anti-circularity boundary — typed (compile-time) + runtime.
// ---------------------------------------------------------------------------

/**
 * Keys produced by prompt-facing derived context. None may appear in the judge
 * feed, alongside glossary/style-note artifacts.
 */
export type InterpretiveContextKey =
  | "sceneSummaryText"
  | "routePositionText"
  | "characterArcsText"
  | "sceneSummaries"
  | "routeBranchMap"
  | "characterArcs"
  | "summaryText"
  | "artifactRef"
  | "artifactRefs"
  | "glossary"
  | "styleNotes";

/** true iff `T` carries none of the interpretive keys. */
type HasNoInterpretiveKeys<T> = keyof T & InterpretiveContextKey extends never ? true : false;

type AssertTrue<T extends true> = T;

/**
 * COMPILE-TIME anti-circularity boundary. If `DecodedGroundTruthContext` ever
 * gains a field sourced from Itotori's interpretive stage (any
 * `InterpretiveContextKey`), `HasNoInterpretiveKeys` resolves to `false`,
 * `AssertTrue<false>` fails `false extends true`, and `tsc --noEmit` breaks the
 * build. This is the typed boundary a reviewer/test can point at.
 */
export type _JudgeFeedIsGroundTruthOnly = AssertTrue<
  HasNoInterpretiveKeys<DecodedGroundTruthContext>
>;

/**
 * Artifact-ref markers Itotori's context-building stage stamps onto its
 * interpretive artifacts (`scene-summary:<id>`, `character-arc:<name>`,
 * `route-branch-map`). No serialized judge input may contain one — a runtime
 * tripwire complementing the compile-time key boundary.
 */
export const INTERPRETIVE_ARTIFACT_MARKERS: readonly string[] = [
  "scene-summary:",
  "character-arc:",
  "route-branch-map",
];

/** The only keys a `DecodedGroundTruthContext` may carry (runtime allow-list). */
const GROUND_TRUTH_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "unitId",
  "speaker",
  "sourceLine",
  "textSurface",
  "scene",
  "branch",
]);

const GROUND_TRUTH_SCENE_KEYS: ReadonlySet<string> = new Set([
  "sceneId",
  "dispatchPosition",
  "dispatchOrderLength",
  "nextScene",
]);

const GROUND_TRUTH_BRANCH_KEYS: ReadonlySet<string> = new Set([
  "optionIndex",
  "label",
  "branchEntryScene",
]);

/**
 * RUNTIME anti-circularity boundary. Asserts every judge input carries ONLY
 * decoded-ground-truth fields and that no serialized value smuggles an
 * Itotori-interpretive artifact marker. Throws `DecodedContextFeedError` on any
 * violation. A test asserts this passes for a real feed while the interpretive
 * artifacts for the SAME structure are absent from it.
 */
export function assertJudgeFeedGroundTruthOnly(feed: ReadonlyArray<JudgeUnitInput>): void {
  for (const unit of feed) {
    const context = unit.decodedContext;
    assertOnlyKeys(context, GROUND_TRUTH_CONTEXT_KEYS, `unit '${unit.unitId}' decodedContext`);
    assertOnlyKeys(context.scene, GROUND_TRUTH_SCENE_KEYS, `unit '${unit.unitId}' scene`);
    if (context.branch !== null) {
      assertOnlyKeys(context.branch, GROUND_TRUTH_BRANCH_KEYS, `unit '${unit.unitId}' branch`);
    }
    // Marker scan over the whole judge input (context + candidates), so a leak
    // hidden inside any string field is caught, not just top-level keys.
    const serialized = JSON.stringify(unit);
    for (const marker of INTERPRETIVE_ARTIFACT_MARKERS) {
      if (serialized.includes(marker)) {
        throw new DecodedContextFeedError(
          `unit '${unit.unitId}' judge input contains Itotori-interpretive artifact marker '${marker}'`,
        );
      }
    }
  }
}

function assertOnlyKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new DecodedContextFeedError(
        `${label} carries non-ground-truth field '${key}' (interpretive context may not enter the judge feed)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The feed builder — derives the judge context from the DECODE ONLY.
// ---------------------------------------------------------------------------

export type DecodedContextFeedInput = {
  /** The deterministic decoded structure — the SOLE narrative source. */
  structure: NarrativeStructure;
  /** Per-unit locators binding benchmark units to decoded messages. */
  unitRefs: DecodedContextUnitRef[];
  /** Anonymized contestant candidates, keyed to units by `unitId`. */
  candidates: ContestantCandidate[];
};

/**
 * Assemble the judge feed. The narrative source is `NarrativeStructure` — the
 * deterministic decode — and NOTHING ELSE: this signature has NO parameter of
 * type from prompt assembly, so derived context is structurally incapable of
 * entering the feed (the
 * typed boundary). Per unit, the decoded ground truth is resolved ONCE and
 * shared by every candidate (boundary #1 — equal context).
 */
export function buildDecodedContextFeed(input: DecodedContextFeedInput): JudgeUnitInput[] {
  const { structure } = input;
  if (input.unitRefs.length === 0) {
    throw new DecodedContextFeedError("no source units to build a judge feed for");
  }

  const sceneById = new Map<number, NarrativeScene>();
  for (const scene of structure.scenes) {
    sceneById.set(scene.sceneId, scene);
  }

  const candidatesByUnit = new Map<string, ContestantCandidate[]>();
  for (const candidate of input.candidates) {
    const list = candidatesByUnit.get(candidate.unitId);
    if (list === undefined) {
      candidatesByUnit.set(candidate.unitId, [candidate]);
    } else {
      list.push(candidate);
    }
  }

  const seenUnitIds = new Set<string>();
  const feed: JudgeUnitInput[] = [];

  for (const ref of input.unitRefs) {
    if (seenUnitIds.has(ref.unitId)) {
      throw new DecodedContextFeedError(`duplicate unit ref '${ref.unitId}'`);
    }
    seenUnitIds.add(ref.unitId);

    const decodedContext = resolveDecodedContext(structure, sceneById, ref);

    const candidates = candidatesByUnit.get(ref.unitId) ?? [];
    if (candidates.length === 0) {
      throw new DecodedContextFeedError(
        `unit '${ref.unitId}' has no contestant candidates to judge`,
      );
    }
    const contestantIds = new Set<string>();
    for (const candidate of candidates) {
      if (contestantIds.has(candidate.contestantId)) {
        throw new DecodedContextFeedError(
          `unit '${ref.unitId}' has duplicate contestant '${candidate.contestantId}'`,
        );
      }
      contestantIds.add(candidate.contestantId);
    }

    feed.push({ unitId: ref.unitId, decodedContext, candidates });
  }

  // The compile-time boundary already forbids interpretive keys on the type;
  // this runtime assertion additionally guards the built values (marker scan +
  // key allow-list) so a future refactor can't silently leak.
  assertJudgeFeedGroundTruthOnly(feed);
  return feed;
}

/**
 * The per-contestant view of a unit's judge input — proves boundary #1: the
 * `decodedContext` returned for every contestant on a unit is the SAME value.
 */
export function contestantJudgeContexts(
  unit: JudgeUnitInput,
): Array<{ contestantId: string; decodedContext: DecodedGroundTruthContext }> {
  return unit.candidates.map((candidate) => ({
    contestantId: candidate.contestantId,
    decodedContext: unit.decodedContext,
  }));
}

function resolveDecodedContext(
  structure: NarrativeStructure,
  sceneById: ReadonlyMap<number, NarrativeScene>,
  ref: DecodedContextUnitRef,
): DecodedGroundTruthContext {
  const scene = sceneById.get(ref.sceneId);
  if (scene === undefined) {
    throw new DecodedContextFeedError(
      `unit '${ref.unitId}' references scene ${ref.sceneId} not present in the decoded structure`,
    );
  }

  const branchOptionIndex = ref.branchOptionIndex ?? null;
  let message: NarrativeMessage | undefined;
  let branch: DecodedBranchPosition | null = null;

  if (branchOptionIndex === null) {
    message = scene.messages.find((m) => m.order === ref.messageOrder);
  } else {
    const choice: NarrativeChoice | undefined = scene.choices.find(
      (c) => c.optionIndex === branchOptionIndex,
    );
    if (choice === undefined) {
      throw new DecodedContextFeedError(
        `unit '${ref.unitId}' references branch option ${branchOptionIndex} not present in scene ${ref.sceneId}`,
      );
    }
    message = choice.branchMessages.find((m) => m.order === ref.messageOrder);
    branch = {
      optionIndex: choice.optionIndex,
      label: choice.label,
      branchEntryScene: choice.branchEntryScene,
    };
  }

  if (message === undefined) {
    const where = branchOptionIndex === null ? "main stream" : `branch option ${branchOptionIndex}`;
    throw new DecodedContextFeedError(
      `unit '${ref.unitId}' references message order ${ref.messageOrder} not present in scene ${ref.sceneId} ${where}`,
    );
  }

  const dispatchIndex = structure.sceneDispatchOrder.indexOf(ref.sceneId);
  return {
    unitId: ref.unitId,
    speaker: message.speaker,
    sourceLine: message.text,
    textSurface: message.textSurface,
    scene: {
      sceneId: scene.sceneId,
      dispatchPosition: dispatchIndex >= 0 ? dispatchIndex + 1 : null,
      dispatchOrderLength: structure.sceneDispatchOrder.length,
      nextScene: scene.nextScene,
    },
    branch,
  };
}
