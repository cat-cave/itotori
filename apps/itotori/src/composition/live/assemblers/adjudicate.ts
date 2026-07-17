// The adjudicate assembler — the deterministic projection of the THREADED
// contested verdicts into the blinded `Q6ReviewInput`.
//
// The two A/B positions the adjudicator weighs are two genuinely opposing review
// verdicts, and the bounded trigger is the driver's own precondition: adjudication
// fires ONLY for a genuine, high-impact, facts-settled contest (a spent bounded
// semantic repair after the deterministic + factual lanes settled). Part 1
// threads the contested verdicts to this seam; this module selects the strongest
// dissent + strongest affirmation, projects each into a blinded position (no
// author / model / reviewer identity), resolves each cited evidence id to its
// text, and runs the result through the role's own `parseQ6ReviewInput` (schema +
// blinding) as the oracle. A contest that is not genuinely two-sided, or whose
// evidence does not resolve, is a loud refusal — never a fabricated position.
//
// FLAG: the Q6 DISPATCH refs (`buildRefs`) + certified-judge `dispatch` are the
// live ZDR seam and are injected/carried through, not built here.

import type { Defect, ReviewVerdict } from "../../../contracts/index.js";
import {
  parseQ6ReviewInput,
  type Q6ContestedPosition,
  type Q6Dispatch,
  type Q6DispatchRefs,
  type Q6PositionLabel,
  type Q6ReviewInput,
} from "../../../roles/q6/index.js";
import type { AdjudicateDeps } from "../../deps.js";
import type { LaneVerdict } from "../../../workflow/index.js";
import { AssemblerError, type RunScopeConfig, type Sha256Hash } from "./substrate.js";

/** Resolve one cited evidence id to its grounding text (the same evidence the
 * reviewer cited). Production binds the context corpus; a proof binds a map. */
export type EvidenceTextResolver = (evidenceId: string) => string | null | undefined;

/** Resolve a unit's installed-bible rendering ids (the wiki-first basis the
 * adjudicator grounds against). */
export type BibleRenderingIdResolver = (unitId: string) => readonly string[];

const SEVERITY_RANK: Record<ReviewVerdict["severity"], number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** The strongest dissent (a FAIL) among the contested verdicts, ranked by
 * severity then review id. Null when no verdict dissents. */
function strongestFail(verdicts: readonly ReviewVerdict[]): ReviewVerdict | null {
  const fails = verdicts.filter((verdict) => verdict.verdict === "FAIL");
  if (fails.length === 0) return null;
  return [...fails].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    if (bySeverity !== 0) return bySeverity;
    return left.reviewId < right.reviewId ? -1 : left.reviewId > right.reviewId ? 1 : 0;
  })[0]!;
}

/** The strongest affirmation among the contested verdicts: a PASS if any, else a
 * CANNOT_ASSESS — the opposing side of the contest, by review id. */
function strongestAffirmation(verdicts: readonly ReviewVerdict[]): ReviewVerdict | null {
  const byReviewId = (a: ReviewVerdict, b: ReviewVerdict): number =>
    a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : 0;
  const passes = verdicts.filter((verdict) => verdict.verdict === "PASS").sort(byReviewId);
  if (passes.length > 0) return passes[0]!;
  const cannot = verdicts.filter((verdict) => verdict.verdict === "CANNOT_ASSESS").sort(byReviewId);
  return cannot[0] ?? null;
}

function claimSummaryFor(verdict: ReviewVerdict): string {
  if (verdict.verdict === "FAIL") return verdict.repairConstraint;
  if (verdict.verdict === "PASS") return "the current target is acceptable as translated";
  return "the current target cannot be assessed on the cited evidence";
}

/** Project one contested verdict into a blinded A/B position, resolving each
 * cited evidence id to its text. Fails loud on evidence that does not resolve. */
function toPosition(
  label: Q6PositionLabel,
  verdict: ReviewVerdict,
  resolveEvidence: EvidenceTextResolver,
): Q6ContestedPosition {
  const evidence = verdict.evidenceIds.map((evidenceId) => {
    const text = resolveEvidence(evidenceId);
    if (text === null || text === undefined || text.length === 0) {
      throw new AssemblerError(
        "unresolved-evidence",
        `contested position ${label} cites evidence ${evidenceId} with no resolvable text`,
      );
    }
    return { evidenceId, text };
  });
  if (evidence.length === 0) {
    throw new AssemblerError(
      "position-without-evidence",
      `contested position ${label} cites no evidence`,
    );
  }
  return {
    label,
    claimSummary: claimSummaryFor(verdict),
    verdict: verdict.verdict,
    severity: verdict.severity,
    category: verdict.category,
    span: verdict.span,
    evidence,
    repairConstraint: verdict.repairConstraint,
  };
}

/** Build the blinded `Q6ReviewInput` for one contested unit from the threaded
 * verdicts. The two positions are the strongest dissent + strongest affirmation;
 * the trigger is the driver's genuine-contest precondition. */
export function buildQ6ReviewInput(input: {
  readonly unitId: string;
  readonly contested: readonly LaneVerdict[];
  readonly resolveEvidence: EvidenceTextResolver;
  readonly resolveBibleRenderingIds: BibleRenderingIdResolver;
  readonly config: RunScopeConfig;
}): Q6ReviewInput {
  const verdicts = input.contested
    .map((laneVerdict) => laneVerdict.verdict)
    .filter((verdict) => verdict.unitId === input.unitId);
  if (verdicts.length < 2) {
    throw new AssemblerError(
      "no-contest",
      `unit ${input.unitId} has ${verdicts.length} contested verdict(s); Q6 needs two opposing sides`,
    );
  }
  const dissent = strongestFail(verdicts);
  const affirmation = strongestAffirmation(verdicts);
  if (dissent === null || affirmation === null) {
    throw new AssemblerError(
      "one-sided-contest",
      `unit ${input.unitId} has no genuine dissent/affirmation split to adjudicate`,
    );
  }
  const raw = {
    unitId: input.unitId,
    localizationSnapshotId: input.config.localizationSnapshotId as Sha256Hash,
    bibleRenderingIds: [...input.resolveBibleRenderingIds(input.unitId)],
    // The driver only adjudicates a genuine, high-impact contest after the
    // deterministic + factual lanes have settled — its documented precondition.
    trigger: { subjectiveConflict: true, impact: "high" as const, factsSettled: true },
    positions: [
      toPosition("A", dissent, input.resolveEvidence),
      toPosition("B", affirmation, input.resolveEvidence),
    ],
  };
  // The role's own parse asserts blinding (no identity keys) + strict schema.
  return parseQ6ReviewInput(raw);
}

/** Build the adjudication seam. `buildInput` is the deterministic projection;
 * `buildRefs` + `dispatch` are the injected live ZDR certified-judge seam. */
export function createAdjudicateDeps(input: {
  readonly config: RunScopeConfig;
  readonly resolveEvidence: EvidenceTextResolver;
  readonly resolveBibleRenderingIds: BibleRenderingIdResolver;
  readonly buildRefs: (portInput: { readonly unitId: string }) => Q6DispatchRefs;
  readonly dispatch: Q6Dispatch;
}): AdjudicateDeps {
  return {
    buildInput: (portInput: {
      readonly unitId: string;
      readonly defects: readonly Defect[];
      readonly contested: readonly LaneVerdict[];
    }) =>
      buildQ6ReviewInput({
        unitId: portInput.unitId,
        contested: portInput.contested,
        resolveEvidence: input.resolveEvidence,
        resolveBibleRenderingIds: input.resolveBibleRenderingIds,
        config: input.config,
      }),
    buildRefs: input.buildRefs,
    dispatch: input.dispatch,
  };
}
