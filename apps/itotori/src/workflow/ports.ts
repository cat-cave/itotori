// The workflow's injected seams — the ports the deterministic driver composes.
//
// The driver SEQUENCES/GATES/ROUTES/FINALIZES; the roles and the substrate
// produce the content. Each port is the boundary to one already-built piece:
// the real wiring adapts the named entrypoint, and an offline proof passes a
// deterministic fake that returns recorded outputs. The driver never reaches
// inside a role or the store — it calls these seams.
//
//   - BibleReadinessPort  → localized-wiki ground-truth `resolveUnitBibleGroundTruth`
//                           (a missing required entry throws → not ready).
//   - DraftPort           → roles/p1 `localizeScene` (whole-scene OR chunked).
//   - GateEvaluationPort  → gates `evaluateDeterministicGates`.
//   - ReviewPort          → roles/q1..q5 `runQxReview` (per lane).
//   - RepairPort          → roles/p2 `editLine` + roles/p3 `repairSemanticDefects`.
//   - AdjudicatePort      → roles/q6 `runQ6Adjudication` (bounded to one).
//   - PatchbackPort       → patchback `buildNativePatchback`.
//   - WorkflowArtifactStore → the CAS / memo / attempt-lineage substrate
//                           (accepted-output heads + `LlmCallMemoStore` + the
//                           physical-attempt ledger).

import type { Defect } from "../contracts/index.js";
import type { DeterministicGate } from "../gates/contract-types.js";
import type {
  DraftMode,
  DraftedScene,
  LaneVerdict,
  ReviewLane,
  UnitStage,
  WorkflowScene,
} from "./types.js";

/** The readiness + bible-resolution answer for one unit. `ready:false` blocks
 * drafting and names the missing entries; `ready:true` carries the rendering ids
 * the draft must cite. */
export type UnitReadiness =
  | { readonly ready: true; readonly bibleRenderingIds: readonly string[] }
  | { readonly ready: false; readonly missing: readonly string[] };

/** Resolve whether the source wiki + localized bible are ready for a unit, and
 * the rendering ids to cite. The real adapter composes the ground-truth
 * resolver; a `MissingBibleEntryError` maps to `ready:false`. */
export interface BibleReadinessPort {
  resolve(unitId: string): Promise<UnitReadiness>;
}

/** Draft a whole scene through P1. `mode` is the realization path the driver
 * selected (whole-scene vs overlapping-chunk); the port honours it so both real
 * paths are exercised. */
export interface DraftPort {
  draftScene(input: {
    readonly scene: WorkflowScene;
    readonly mode: DraftMode;
    readonly bibleRenderingIdsByUnit: ReadonlyMap<string, readonly string[]>;
  }): Promise<DraftedScene>;
}

/** The deterministic-gate outcome for a drafted scene: the fired defects (origin
 * `deterministic`) plus the gates that actually RAN — the join needs the latter
 * to know which reviewer findings a passing fact may dominate. */
export interface GateReport {
  readonly defects: readonly Defect[];
  readonly evaluatedGates: readonly DeterministicGate[];
}

/** Run the deterministic gates over one drafted scene. Zero model calls. */
export interface GateEvaluationPort {
  evaluate(scene: DraftedScene): Promise<GateReport>;
}

/** Run ONE review lane over the units the risk router selected for it. Returns
 * the lane's verdicts. The driver decides which lane runs on which units; the
 * port only executes the selected lane. */
export interface ReviewPort {
  review(input: {
    readonly lane: ReviewLane;
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
  }): Promise<readonly LaneVerdict[]>;
}

/** The route a correction took, and which unit ids its change touched. A
 * semantic repair that spends its one bounded attempt routes to adjudication. */
export type CorrectionOutcome =
  | { readonly route: "repair"; readonly changedUnitIds: readonly string[] }
  | { readonly route: "adjudication"; readonly contestedUnitIds: readonly string[] };

/** Apply a correction to the implicated units. `lineEdit` is the P2 minor-repair
 * author continuation; `semanticRepair` is the P3 bounded fresh grounded fork
 * (one repair per defect, else it routes to adjudication).
 *
 * Both carry the run-scoped `scene` — the drafted scene under repair. The P2/P3
 * role inputs are the CURRENT DRAFT plus the defects, not the defects alone: the
 * line editor continues the accepted draft and the semantic fork re-grounds the
 * failing candidate. The driver already holds the `DraftedScene`, so it threads
 * it explicitly (rather than a hidden shared context) to keep the seam a pure,
 * deterministic `(scene, unitIds, defects) → input` projection. */
export interface RepairPort {
  lineEdit(input: {
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
    readonly defects: readonly Defect[];
  }): Promise<CorrectionOutcome>;
  semanticRepair(input: {
    readonly scene: DraftedScene;
    readonly unitIds: readonly string[];
    readonly defects: readonly Defect[];
    /** Defect ids already repaired once — a second attempt routes out. */
    readonly repairedDefectLedger: ReadonlySet<string>;
  }): Promise<CorrectionOutcome>;
}

/** The adjudicator's binding disposition for one contested unit. Bounded to a
 * single dual-order adjudication; the driver never asks it to fire twice. */
export type AdjudicationDisposition = "finalize" | "repair" | "escalate";

export interface AdjudicatePort {
  adjudicate(input: {
    readonly unitId: string;
    readonly defects: readonly Defect[];
    /** The contested lane verdicts for THIS unit — the two blinded A/B positions
     * the adjudicator weighs live in the review verdicts, not in the defects. The
     * driver threads exactly the verdicts that judged the contested unit so the
     * seam can project the `Q6ReviewInput` positions + trigger deterministically. */
    readonly contested: readonly LaneVerdict[];
  }): Promise<{ readonly disposition: AdjudicationDisposition }>;
}

/** Export the finalized units to a patch, and run the downstream on-screen
 * (Build-LQA / Q5) review over the patched result. `buildLqaReview` observes the
 * PATCHED bytes through the render/OCR frame channel — it runs strictly after
 * `exportPatch`. */
export interface PatchbackPort {
  exportPatch(input: {
    readonly finalized: readonly FinalizedUnit[];
  }): Promise<{ readonly patchId: string }>;
  buildLqaReview(input: {
    readonly patchId: string;
    readonly unitIds: readonly string[];
  }): Promise<readonly LaneVerdict[]>;
}

/** A finalized unit head reference — the content-addressed identity the store
 * returns from a finalize / restart query. */
export interface UnitArtifactRef {
  readonly unitId: string;
  readonly stage: UnitStage;
  readonly contentHash: `sha256:${string}`;
  readonly version: number;
}

/** A unit whose `final` artifact has been finalized into the store — the input
 * to patchback. */
export interface FinalizedUnit {
  readonly unitId: string;
  readonly ref: UnitArtifactRef;
  readonly shippable: boolean;
}

/** The context handed to a memoized step's producer — the attempt ordinal of THIS
 * physical attempt (1-based). A silent retry is impossible: each producer call
 * carries a distinct, monotonically increasing ordinal recorded in the lineage. */
export interface AttemptContext {
  readonly memoKey: string;
  readonly ordinal: number;
}

/** The result of a memoized step: whether it was served from the durable store
 * (a restart hit → no re-production) and the produced value. */
export interface MemoStepResult<T> {
  readonly memoHit: boolean;
  readonly value: T;
}

/** One physical attempt recorded in the lineage — every attempt, including a
 * transient retry, is counted. */
export interface AttemptLineageEntry {
  readonly memoKey: string;
  readonly ordinal: number;
  readonly outcome: "completed" | "transient-retry" | "failed";
}

/** A transient failure a memoized step's producer may throw to request a
 * counted retry. Each retry appends an attempt to the lineage — never silent. */
export class TransientStepError extends Error {
  constructor(detail: string) {
    super(`transient physical step failure: ${detail}`);
    this.name = "TransientStepError";
  }
}

/** The content-addressed durability substrate the driver finalizes into and
 * queries on restart. The real adapter wires the accepted-output CAS heads, the
 * `LlmCallMemoStore` single-flight, and the physical-attempt ledger; a fake
 * models the same semantics in memory for an offline proof. */
export interface WorkflowArtifactStore {
  /** Restart query: the finalized head for a unit at a stage, or null if absent.
   * `null` IS the "must produce" signal — the driver enumerates the absent
   * artifacts and produces only those. */
  readUnitHead(unitId: string, stage: UnitStage): Promise<UnitArtifactRef | null>;
  /** Independent per-unit CAS finalize: advances ONLY this (unitId, stage) head.
   * One unit's finalize never blocks or couples another's. */
  finalizeUnit(input: {
    readonly unitId: string;
    readonly stage: UnitStage;
    readonly contentHash: `sha256:${string}`;
    readonly shippable: boolean;
  }): Promise<UnitArtifactRef>;
  /** Run a physical step under a memo key. A durable hit returns the cached value
   * WITHOUT invoking `produce` (restart skip). A miss invokes `produce`, counting
   * every physical attempt — a `TransientStepError` appends a counted retry. */
  runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>>;
  /** Every physical attempt in the lineage, in the order they occurred. */
  attemptLineage(): readonly AttemptLineageEntry[];
}

/** The full set of seams the driver composes. */
export interface WorkflowPorts {
  readonly readiness: BibleReadinessPort;
  readonly draft: DraftPort;
  readonly gates: GateEvaluationPort;
  readonly review: ReviewPort;
  readonly repair: RepairPort;
  readonly adjudicate: AdjudicatePort;
  readonly patchback: PatchbackPort;
  readonly store: WorkflowArtifactStore;
}
