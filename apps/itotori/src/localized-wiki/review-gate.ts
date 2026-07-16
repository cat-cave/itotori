// The Q3/Q2-style reviewer gate over the L-Term / L-Name decisions.
//
// A canonical target form may install ONLY after the reviewers validate it. The
// gate consumes the roster reviewer castings READ-ONLY: it runs the shared
// reviewer-shape validator (`specialistFor(role).validate`) — the law that a
// CANNOT_ASSESS can never masquerade as a pass — over each required rubric's
// output, and it installs a decision only on a CLEAN PASS. An L-Term decision is
// judged on TERMINOLOGY (Q3); an L-Name decision on TERMINOLOGY and VOICE
// consistency (Q3 + Q2). A FAIL, a CANNOT_ASSESS, a schema/law violation, or a
// missing rubric leaves the decision UNVALIDATED and it never installs.
//
// The reviewer CONTENT is best-effort model output supplied by the injected
// reviewer; this gate is the deterministic control that decides installation.

import { z } from "zod";
import { specialistFor, type ValidationIssue } from "../roster/index.js";
import type {
  DecisionClass,
  DecisionReviewer,
  DecisionReviewerOutput,
  ReviewDecisionInput,
  RenderingStamp,
} from "./types.js";
import type { LocalizedRendering, WikiObject } from "../contracts/index.js";

/** The rubrics each decision class must clear, in order. L-Term clears
 * terminology (Q3); L-Name clears terminology AND voice consistency (Q3 + Q2). */
export const DECISION_RUBRICS: Readonly<Record<DecisionClass, readonly ("Q2" | "Q3")[]>> =
  Object.freeze({
    "L-Term": Object.freeze(["Q3"] as const),
    "L-Name": Object.freeze(["Q3", "Q2"] as const),
  });

/** Read just the verdict values off a reviewer-shape output — enough to decide a
 * clean PASS. Extra fields are ignored; a shapeless output yields no verdict. */
const VerdictReadSchema = z.object({
  verdicts: z.array(z.object({ verdict: z.enum(["PASS", "FAIL", "CANNOT_ASSESS"]) })),
});

/** One rubric's outcome over one decision. */
export interface RubricOutcome {
  readonly reviewerRole: "Q2" | "Q3";
  readonly output: DecisionReviewerOutput;
  readonly issues: readonly ValidationIssue[];
  readonly verdict: "PASS" | "FAIL" | "CANNOT_ASSESS" | null;
  readonly clean: boolean;
}

/** The gate's decision over one L-Term / L-Name rendering. `validated` is true
 * only when EVERY required rubric returned a clean PASS. */
export interface DecisionReview {
  readonly decisionClass: DecisionClass;
  readonly rubrics: readonly RubricOutcome[];
  readonly validated: boolean;
}

/** Judge one rubric's output: a clean PASS requires the shared reviewer-shape law
 * to pass AND exactly one verdict of PASS. */
function judgeRubric(reviewerRole: "Q2" | "Q3", output: DecisionReviewerOutput): RubricOutcome {
  const issues = specialistFor(reviewerRole).validate(output);
  const parsed = VerdictReadSchema.safeParse(output);
  const verdict =
    parsed.success && parsed.data.verdicts.length === 1 ? parsed.data.verdicts[0]!.verdict : null;
  const clean = issues.length === 0 && verdict === "PASS";
  return { reviewerRole, output, issues, verdict, clean };
}

/**
 * Run the reviewer gate over one L-Term / L-Name decision. Every required rubric
 * is judged; the decision is validated only if all of them return a clean PASS.
 */
export async function reviewDecision(
  args: {
    readonly decisionClass: DecisionClass;
    readonly sourceObject: WikiObject;
    readonly rendering: LocalizedRendering;
    readonly stamp: RenderingStamp;
  },
  reviewer: DecisionReviewer,
): Promise<DecisionReview> {
  const rubrics: RubricOutcome[] = [];
  for (const reviewerRole of DECISION_RUBRICS[args.decisionClass]) {
    const input: ReviewDecisionInput = {
      reviewerRole,
      decisionClass: args.decisionClass,
      sourceObject: args.sourceObject,
      rendering: args.rendering,
      stamp: args.stamp,
    };
    const output = await reviewer(input);
    rubrics.push(judgeRubric(reviewerRole, output));
  }
  const validated = rubrics.length > 0 && rubrics.every((rubric) => rubric.clean);
  return { decisionClass: args.decisionClass, rubrics, validated };
}
