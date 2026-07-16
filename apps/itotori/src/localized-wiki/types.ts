// The per-target localized-Wiki (bible) orchestration — shared types.
//
// This module is the DETERMINISTIC control flow that turns the source-language
// Wiki (built upstream by the source-Wiki orchestration) into the MANDATORY
// per-target-language bible BEFORE any production line is drafted. It runs under
// a LOCALIZER-profile posture and produces LocalizedRenderings for names, term
// rulings, style, voice, scene/route/character arcs, and cultural notes.
//
// The orchestrator owns only the CONTROL FLOW and holds it to a strict bar:
//   - the name/term DECISIONS (L-Term / L-Name) run FIRST, before every other
//     rendering and before any production line;
//   - a Q3/Q2-style reviewer gate validates those decisions;
//   - the agreed canonical TARGET forms install into the deterministic gates;
//   - production and pilot MUST build the whole bible — there is no bypass.
// The rendering CONTENT is best-effort model output produced by the localizer
// runner; this node SELECTS, ORDERS, PERSISTS, and GATES it — it re-proves no
// translation. A rendering is accepted only if it is on-target, target-language,
// kind-matched, and stamped with the run's localization snapshot and run mode.

import type {
  LocalizedRendering,
  RouteScope,
  RunModeValue,
  WikiObject,
} from "../contracts/index.js";

/** The three postures a bible build may run under. Production and pilot MUST
 * build the full bible; only the explicit ablation posture may bypass it. */
export type LocalizationPosture = "production" | "pilot" | "ablation";

/** The two decision classes that carry a canonical TARGET FORM and therefore
 * install into the deterministic gates. Both run in the FIRST phase. L-Name is a
 * ruling for a proper-noun (character) subject; L-Term is a glossary-term ruling. */
export type DecisionClass = "L-Name" | "L-Term";

/** The two bible tiers, in the order they MUST execute: the canonical-form
 * DECISIONS first, then every DESCRIPTIVE rendering. */
export type BibleTier = "decision" | "descriptive";

/** A content-addressable rendering key: (source-kind, source-object, scope,
 * target-language). Two renderings with the same key localize the same source
 * artifact into the same language, so the ledger dedupes on it and the recovery
 * query diffs plan-expected keys against ledger-existing keys. */
export type RenderingKey = string;

/** The identity a localized rendering MUST carry: the source object it localizes,
 * its kind, the route scope, and the target language. The runner fills the
 * localized body; the orchestrator owns the identity so acceptance is exact. */
export interface LocalizedTarget {
  readonly sourceObjectKind: Exclude<WikiObject["kind"], "translation">;
  readonly sourceObjectId: string;
  readonly sourceObjectVersion: number;
  readonly scope: RouteScope;
  readonly targetLanguage: string;
  readonly key: RenderingKey;
}

/** One indivisible unit of localization work: localize one source object into the
 * target language. A decision step also carries its decision class. */
export interface BibleStep {
  readonly stepId: string;
  readonly tier: BibleTier;
  readonly decisionClass: DecisionClass | null;
  readonly sourceObject: WikiObject;
  readonly target: LocalizedTarget;
}

/** One tier's phase: the tier and its steps. The DECISION phase is always level
 * 0 and the DESCRIPTIVE phase level 1 — the descriptive phase never starts until
 * the decisions are reviewed and their canonical forms installed. */
export interface BiblePhase {
  readonly level: number;
  readonly tier: BibleTier;
  readonly steps: readonly BibleStep[];
}

/** The whole deterministic bible plan: the target language, the posture, and the
 * two tier-ordered phases. */
export interface LocalizedWikiPlan {
  readonly targetLanguage: string;
  readonly posture: LocalizationPosture;
  readonly phases: readonly BiblePhase[];
}

/** The run stamp every accepted rendering must carry. */
export interface RenderingStamp {
  readonly targetLanguage: string;
  readonly localizationSnapshotId: string;
  readonly runMode: RunModeValue;
}

/** The input the orchestrator hands the localizer runner for one step. */
export interface RenderStepInput {
  readonly tier: BibleTier;
  readonly decisionClass: DecisionClass | null;
  readonly sourceObject: WikiObject;
  readonly target: LocalizedTarget;
  readonly stamp: RenderingStamp;
}

/** The localizer runner boundary. In production this is an adapter over the
 * localizer-shape role dispatching the certified model through the sole ZDR seam;
 * in the offline proofs it is a recorded responder. It returns the best-effort
 * candidate renderings for one step; the orchestrator accepts them. */
export type LocalizerRunner = (input: RenderStepInput) => Promise<readonly LocalizedRendering[]>;

/** A reviewer-shape output candidate for one decision under one rubric — the
 * exact `{ snapshotId, verdicts: [...] }` shape the roster reviewer validator
 * judges. The reviewer produces it best-effort; the deterministic gate decides
 * whether it may install (only a clean PASS may). */
export type DecisionReviewerOutput = unknown;

/** The input the decision reviewer sees for one rubric over one decision. */
export interface ReviewDecisionInput {
  readonly reviewerRole: "Q2" | "Q3";
  readonly decisionClass: DecisionClass;
  readonly sourceObject: WikiObject;
  readonly rendering: LocalizedRendering;
  readonly stamp: RenderingStamp;
}

/** The decision reviewer boundary — best-effort, injected. Returns a reviewer-
 * shape output for the requested rubric. */
export type DecisionReviewer = (input: ReviewDecisionInput) => Promise<DecisionReviewerOutput>;

/** The rendering ledger — the durable record of which renderings exist.
 * `existingKeys` is the missing-rendering query (its complement against the plan
 * is the work to do); `record` persists the accepted renderings. */
export interface BibleRenderingLedger {
  existingKeys(): Promise<ReadonlySet<RenderingKey>>;
  record(renderings: readonly LocalizedRendering[]): Promise<void>;
}
