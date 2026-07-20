// The artifact-driven localization workflow — value types.
//
// This module holds DATA SHAPES only: the work items the driver sequences, the
// stages it finalizes into the content-addressed store, and the typed errors it
// raises. It composes the already-built contracts (drafts, verdicts, defect
// bundles) and the resolved run policy; it never re-implements a role output.
//
// The driver is DETERMINISTIC control flow over BEST-EFFORT role outputs: the
// shapes here describe the sequencing/gating/routing/finalizing, not the content
// a role produces. A role output that appears here (a Draft, a ReviewVerdict) is
// carried through verbatim — the driver proves ordering and routing, never the
// translation quality.

import { ReviewLaneSchema } from "../contracts/index.js";
import type { UnitBibleBinding } from "../localized-wiki/ground-truth/index.js";
import type { z } from "zod";
import type { Draft, DraftBatch, ReviewVerdict } from "../contracts/index.js";

/** One review lane — a member of the closed reviewer set (Q1…Q6). Derived from
 * the contract schema so the workflow shares the single source of truth. */
export type ReviewLane = z.infer<typeof ReviewLaneSchema>;

/** The lane values, in canonical order. */
export const REVIEW_LANE_VALUES: readonly ReviewLane[] = Object.freeze([
  ...ReviewLaneSchema.options,
]);

/** The per-unit CAS finalize stages — the mutable heads the store advances,
 * mirroring the accepted-output `stage` enum. `draft` → `repair` → `final`, with
 * `build-lqa` for the downstream on-screen pass. */
export type UnitStage = "draft" | "repair" | "final" | "build-lqa";

/** One source unit the workflow localizes — the minimal decode-derived identity
 * the control flow needs. The heavy fact snapshot lives behind the readiness /
 * draft ports; the driver sequences on this identity alone. */
export interface WorkflowUnit {
  readonly unitId: string;
  readonly sourceHash: `sha256:${string}`;
  /** The decode-declared text surface. Output scope filters this write target;
   * it never changes the whole-game context the run reads. */
  readonly surfaceKind?: string;
  /** The speaker whose voice bible + accepted history a voice review needs, or
   * null for an unattributed line. */
  readonly speakerId: string | null;
  /** The route this unit is bound to, or null for a global-scope unit. */
  readonly routeId: string | null;
  /** True the first time a speaker/term appears — a decode-derived risk signal
   * that raises the unit's review stratum. */
  readonly firstAppearance: boolean;
}

/** One complete scene — an ordered, coherence-dependent chain of units. Units in
 * a scene share the author thread and MUST be drafted serially; distinct scenes
 * are independent and run in parallel (see the durability schedule). */
export interface WorkflowScene {
  readonly sceneId: string;
  readonly units: readonly WorkflowUnit[];
}

/** A unit's realized draft — the P1 output plus the deterministic gate defects
 * that ran on it and the reviews that judged it. Carried through the pipeline as
 * the subject the join/repair/finalize steps route on. */
export interface DraftedUnit {
  readonly unitId: string;
  readonly draft: Draft;
  readonly bibleRenderingIds: readonly string[];
  /** Retains the exact installed entries and the dependencies P1 cited. */
  readonly bibleBinding?: UnitBibleBinding;
}

/** How a scene was drafted — the two P1 realization paths. `whole-scene` fits the
 * whole scene in one window; `overlapping-chunk` splits a scene too large for the
 * measured budget into overlapping chunks. Both are real paths the driver picks
 * between; neither is a fallback. */
export type DraftMode = "whole-scene" | "overlapping-chunk";

/** A drafted scene — the batch(es), the drafted units, and which path produced
 * them. */
export interface DraftedScene {
  readonly sceneId: string;
  readonly mode: DraftMode;
  readonly batches: readonly DraftBatch[];
  readonly units: readonly DraftedUnit[];
}

/** A reviewer verdict tagged with the lane that produced it — the raw finding
 * stream the deterministic join folds. */
export interface LaneVerdict {
  readonly lane: ReviewLane;
  readonly verdict: ReviewVerdict;
}

/** A blocked unit — its required bible entries are not installed, so the driver
 * refuses to draft it. The missing entry ids are surfaced, never silently
 * skipped. */
export class WorkflowReadinessError extends Error {
  constructor(
    readonly unitId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `unit ${unitId} is not ready: ${missing.length} required bible entr${
        missing.length === 1 ? "y is" : "ies are"
      } not installed (${missing.join(", ")})`,
    );
    this.name = "WorkflowReadinessError";
  }
}

/** A sequencing invariant the driver itself owns was violated — a stage reached
 * out of order, a contest raised without a genuine trigger, an adjudication
 * asked to fire twice. These are control-flow bugs, not role-output faults. */
export class WorkflowSequenceError extends Error {
  constructor(detail: string) {
    super(`workflow sequence violated: ${detail}`);
    this.name = "WorkflowSequenceError";
  }
}
