// The whole-game source-Wiki orchestration — shared types.
//
// This module is the DETERMINISTIC control flow that drives the analyst roles to
// build the whole-game, SOURCE-LANGUAGE Wiki. It does not author narrative and
// does not re-prove a role's content: it SELECTS the analyst roster, SEQUENCES
// the work in dependency order, FANS the independent work out under a bounded
// concurrency limit, and PERSISTS each accepted object through the artifact
// ledger. The agent outputs are best-effort and produced by the role modules;
// the orchestrator owns only selection, ordering, concurrency, and recovery.
//
// Every emitted object is stamped whole-game / run-mode and is accepted only if
// it is source-language, cited, route-scoped, and on-target. Recovery is a
// missing-artifact query: a step whose target artifacts already exist is never
// rerun.

import type {
  ContextScopeValue,
  EntityRef,
  RoleId,
  RouteScope,
  RunModeValue,
  WikiObject,
} from "../contracts/index.js";

/** The whole-game context scope every source-Wiki object is stamped with. */
export const WHOLE_GAME_CONTEXT_SCOPE = "whole-game" as const;

/** The context scope stamped into every object this orchestration accepts. */
export type WholeGameContextScope = typeof WHOLE_GAME_CONTEXT_SCOPE;

/** A content-addressable artifact key: (kind, subject, scope). Two objects with
 * the same key are the same target artifact, so the ledger dedupes on it and the
 * recovery query diffs plan-expected keys against ledger-existing keys. */
export type ArtifactKey = string;

/** One target artifact identity the orchestrator assigns to a work step: the
 * kind, subject, and route scope the accepted object MUST carry. The runner
 * fills the content; the orchestrator owns the identity so recovery is exact. */
export interface ArtifactTarget {
  readonly kind: string;
  readonly subject: EntityRef;
  readonly scope: RouteScope;
  readonly key: ArtifactKey;
}

/** One indivisible unit of analyst work. A step's targets are produced together
 * (e.g. A3 emits a scene-summary AND a story-so-far for one scene). Steps within
 * a work item run STRICTLY SERIALLY (the progressive fold); the prior step's
 * accepted objects are handed to the next as `priorObjects`. */
export interface WorkStep {
  readonly stepId: string;
  readonly role: RoleId;
  readonly subject: EntityRef;
  readonly scope: RouteScope;
  readonly targets: readonly ArtifactTarget[];
}

/** One INDEPENDENT work item — a route fold, a character, a pair, a term, a
 * unit. Independent items fan out under the bounded concurrency limit; the steps
 * inside one item are serial. A single-step item (all roles but A3) is just a
 * one-element chain. */
export interface WorkItem {
  readonly itemId: string;
  readonly role: RoleId;
  /** A stable grouping key for the fan-out lane this item belongs to (route id,
   * character id, …) — used only for observability of the concurrency proof. */
  readonly laneId: string;
  readonly steps: readonly WorkStep[];
}

/** One dependency-ordered phase: every role at the same topological level and
 * the independent work items to run in it. A later phase never starts until the
 * prior phase's artifacts exist, so A4/A9/A5 wait on A3/A7/A8 evidence. */
export interface Phase {
  readonly level: number;
  readonly roles: readonly RoleId[];
  readonly items: readonly WorkItem[];
}

/** The whole deterministic plan: the selected roster, the whole-game context
 * scope, and the dependency-ordered phases. */
export interface SourceWikiPlan {
  readonly roles: readonly RoleId[];
  readonly contextScope: WholeGameContextScope;
  readonly phases: readonly Phase[];
}

/** The input the orchestrator hands the role runner for one step: the assigned
 * targets, the run stamp to apply, and the accepted objects of the prior serial
 * step (empty for the first step of an item). */
export interface RunStepInput {
  readonly role: RoleId;
  readonly step: WorkStep;
  readonly sourceLanguage: string;
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  /** The prior serial step's accepted objects — the story-so-far the fold folds
   * forward. Empty for a first step or a single-step item. */
  readonly priorObjects: readonly WikiObject[];
}

/** The role runner boundary. In production this is an adapter over the merged
 * analyst role modules (A1-A10) dispatching the certified model through the sole
 * ZDR seam; in the offline proofs it is a recorded responder. It returns the
 * best-effort candidate objects for one step; the orchestrator accepts them. */
export type AnalystRunner = (input: RunStepInput) => Promise<readonly WikiObject[]>;

/** The artifact ledger — the durable record of which objects exist. `existingKeys`
 * is the missing-artifact query (its complement against the plan is the work to
 * do); `record` persists the accepted objects. A DB-backed adapter and an
 * in-memory adapter both satisfy it. */
export interface ArtifactLedger {
  existingKeys(): Promise<ReadonlySet<ArtifactKey>>;
  record(objects: readonly WikiObject[]): Promise<void>;
}
