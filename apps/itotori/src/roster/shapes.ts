// The three — and only three — executable reasoning profile SHAPES.
//
// An LLM does exactly three things in this house: it ANALYZES (narrative
// analyst), it WRITES (localizer), and it JUDGES (independent reviewer). There
// is no fourth shape and there are no per-persona classes. Every specialist in
// the roster is a CASTING of one of these three shapes — the same metal, poured
// into a different mold by instructions, tool grant, granularity, and chaining
// position. A shape is immutable DATA: a strict input schema, a strict output
// schema, a default reasoning/limits posture, and a pure semantic validator
// that checks meaning the schema cannot (e.g. a reviewer's CANNOT_ASSESS can
// never stand in for a pass). Asking for a shape that is not one of these three
// throws — the roster cannot execute a shape it does not own.

import { z } from "zod";

import {
  CallLimitsSchema,
  ClaimKindSchema,
  EntityRefSchema,
  IdentifierSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  ReasoningPolicySchema,
  RouteScopeSchema,
  Sha256Schema,
  ShortTextSchema,
} from "../contracts/index.js";

export const PROFILE_SHAPES = ["analyst", "localizer", "reviewer"] as const;
export type ProfileShape = (typeof PROFILE_SHAPES)[number];
export const ProfileShapeSchema = z.enum(PROFILE_SHAPES);

/** A pure semantic finding. Non-empty means the output is semantically invalid
 * even if it parsed against the strict schema. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ReasoningPolicy = z.infer<typeof ReasoningPolicySchema>;
export type CallLimits = z.infer<typeof CallLimitsSchema>;

/** The immutable contract every casting of a shape inherits. */
export interface ShapeContract {
  readonly shape: ProfileShape;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly reasoning: ReasoningPolicy;
  readonly limits: CallLimits;
  readonly validate: (output: unknown) => readonly ValidationIssue[];
  /** The call-tier profiles this shape may be bound to in the certified config. */
  readonly callProfiles: readonly ("draft" | "reasoning" | "reviewer" | "judge")[];
}

// ── analyst ────────────────────────────────────────────────────────────────
// In: a compact deterministic manifest (subject + scope + seed fact ids).
// Out: SemanticClaim[] — hypotheses that may guide, never override, decode facts.

const AnalystInputSchema = z
  .object({
    snapshotId: Sha256Schema,
    subject: EntityRefSchema,
    scope: RouteScopeSchema,
    seedFactIds: z.array(IdentifierSchema).max(100_000),
  })
  .strict();

const SemanticClaimSchema = z
  .object({
    claimId: IdentifierSchema,
    claim: NonEmptyTextSchema,
    kind: ClaimKindSchema,
    evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
    confidence: z.enum(["low", "medium", "high"]),
    scope: RouteScopeSchema,
  })
  .strict();

const AnalystOutputSchema = z
  .object({
    snapshotId: Sha256Schema,
    claims: z.array(SemanticClaimSchema).min(1).max(10_000),
  })
  .strict();

function analystValidate(output: unknown): readonly ValidationIssue[] {
  const parsed = AnalystOutputSchema.safeParse(output);
  if (!parsed.success) return [{ path: "output", message: "analyst output is not schema-valid" }];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const [index, claim] of parsed.data.claims.entries()) {
    if (seen.has(claim.claimId)) {
      issues.push({ path: `claims[${index}].claimId`, message: "duplicate claim id" });
    }
    seen.add(claim.claimId);
    // A claim is a HYPOTHESIS; it earns its keep only if it cites evidence.
    if (claim.evidenceIds.length === 0) {
      issues.push({ path: `claims[${index}].evidenceIds`, message: "claim cites no evidence" });
    }
    if (claim.claim.trim().length === 0) {
      issues.push({ path: `claims[${index}].claim`, message: "claim statement is blank" });
    }
  }
  return issues;
}

// ── localizer ──────────────────────────────────────────────────────────────
// In: a scene-scoped, token-budgeted batch of adjacent source units.
// Out: a DraftBatch whose valid units finalize independently (stable ids,
// exact source hash, preserved protected placeholders, typed uncertainty).

const LocalizerInputSchema = z
  .object({
    snapshotId: Sha256Schema,
    sceneId: IdentifierSchema,
    scope: RouteScopeSchema,
    unitIds: z.array(IdentifierSchema).min(1).max(4_096),
  })
  .strict();

const DraftSchema = z
  .object({
    unitId: IdentifierSchema,
    sourceHash: Sha256Schema,
    targetSkeleton: z.string().max(32_768),
    evidenceIds: z.array(IdentifierSchema).max(1_024),
    uncertainty: z
      .array(z.enum(["referent", "term", "speaker", "voice", "culture", "none"]))
      .min(1)
      .max(6),
  })
  .strict();

const LocalizerOutputSchema = z
  .object({
    snapshotId: Sha256Schema,
    drafts: z.array(DraftSchema).min(1).max(4_096),
  })
  .strict();

function localizerValidate(output: unknown): readonly ValidationIssue[] {
  const parsed = LocalizerOutputSchema.safeParse(output);
  if (!parsed.success) return [{ path: "output", message: "localizer output is not schema-valid" }];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const [index, draft] of parsed.data.drafts.entries()) {
    if (seen.has(draft.unitId)) {
      issues.push({ path: `drafts[${index}].unitId`, message: "duplicate unit id in batch" });
    }
    seen.add(draft.unitId);
    // "none" is a total absence of uncertainty; it cannot coexist with a flag.
    if (draft.uncertainty.includes("none") && draft.uncertainty.length > 1) {
      issues.push({
        path: `drafts[${index}].uncertainty`,
        message: "'none' cannot combine with an uncertainty flag",
      });
    }
  }
  return issues;
}

// ── reviewer ───────────────────────────────────────────────────────────────
// In: risk-selected units to judge against one non-overlapping rubric.
// Out: a strict verdict per unit. CANNOT_ASSESS can never masquerade as a pass:
// it must request evidence or escalate. A FAIL must localise the defect.

const ReviewSpanSchema = z
  .object({
    start: NonNegativeIntegerSchema,
    end: NonNegativeIntegerSchema,
  })
  .strict();

const ReviewerInputSchema = z
  .object({
    snapshotId: Sha256Schema,
    scope: RouteScopeSchema,
    unitIds: z.array(IdentifierSchema).min(1).max(4_096),
  })
  .strict();

const ReviewVerdictSchema = z
  .object({
    unitId: IdentifierSchema,
    verdict: z.enum(["PASS", "FAIL", "CANNOT_ASSESS"]),
    severity: z.enum(["none", "minor", "major", "critical"]),
    category: z.enum(["meaning", "voice", "terminology", "continuity", "visual", "adjudication"]),
    span: ReviewSpanSchema.nullable(),
    evidenceIds: z.array(IdentifierSchema).max(1_024),
    repairConstraint: ShortTextSchema.nullable(),
    evidenceRequest: ShortTextSchema.nullable(),
  })
  .strict();

const ReviewerOutputSchema = z
  .object({
    snapshotId: Sha256Schema,
    verdicts: z.array(ReviewVerdictSchema).min(1).max(4_096),
  })
  .strict();

function reviewerValidate(output: unknown): readonly ValidationIssue[] {
  const parsed = ReviewerOutputSchema.safeParse(output);
  if (!parsed.success) return [{ path: "output", message: "reviewer output is not schema-valid" }];
  const issues: ValidationIssue[] = [];
  for (const [index, verdict] of parsed.data.verdicts.entries()) {
    const at = `verdicts[${index}]`;
    if (verdict.verdict === "PASS") {
      if (verdict.severity !== "none") {
        issues.push({ path: `${at}.severity`, message: "a PASS carries no severity" });
      }
      if (verdict.span !== null) {
        issues.push({ path: `${at}.span`, message: "a PASS localises no defect" });
      }
    }
    if (verdict.verdict === "FAIL") {
      if (verdict.severity === "none") {
        issues.push({ path: `${at}.severity`, message: "a FAIL must carry a severity" });
      }
      if (verdict.repairConstraint === null) {
        issues.push({
          path: `${at}.repairConstraint`,
          message: "a FAIL must constrain the repair",
        });
      }
    }
    if (verdict.verdict === "CANNOT_ASSESS") {
      // The governing guarantee: CANNOT_ASSESS never silently becomes a pass.
      if (verdict.evidenceRequest === null) {
        issues.push({
          path: `${at}.evidenceRequest`,
          message: "CANNOT_ASSESS must request evidence or escalate — it never passes",
        });
      }
      if (verdict.severity !== "none") {
        issues.push({ path: `${at}.severity`, message: "CANNOT_ASSESS asserts no severity" });
      }
    }
  }
  return issues;
}

const DEEP_REASONING: ReasoningPolicy = { effort: "high" };
const NORMAL_REASONING: ReasoningPolicy = { effort: "medium" };

const ANALYST_LIMITS: CallLimits = {
  maxSteps: 4,
  maxToolCalls: 8,
  maxParallelTools: 4,
  maxOutputTokens: 16_384,
  timeoutClass: "deep",
};
const LOCALIZER_LIMITS: CallLimits = {
  maxSteps: 4,
  maxToolCalls: 8,
  maxParallelTools: 4,
  maxOutputTokens: 32_768,
  timeoutClass: "normal",
};
const REVIEWER_LIMITS: CallLimits = {
  maxSteps: 3,
  maxToolCalls: 6,
  maxParallelTools: 2,
  maxOutputTokens: 8_192,
  timeoutClass: "normal",
};

/** The exactly-three executable shapes, frozen as immutable data. A shape that
 * is absent here cannot be executed. */
export const EXECUTABLE_PROFILE_SHAPES: Readonly<Record<ProfileShape, ShapeContract>> =
  Object.freeze({
    analyst: Object.freeze({
      shape: "analyst",
      input: AnalystInputSchema,
      output: AnalystOutputSchema,
      reasoning: DEEP_REASONING,
      limits: ANALYST_LIMITS,
      validate: analystValidate,
      callProfiles: ["reasoning"] as const,
    }),
    localizer: Object.freeze({
      shape: "localizer",
      input: LocalizerInputSchema,
      output: LocalizerOutputSchema,
      reasoning: NORMAL_REASONING,
      limits: LOCALIZER_LIMITS,
      validate: localizerValidate,
      callProfiles: ["draft"] as const,
    }),
    reviewer: Object.freeze({
      shape: "reviewer",
      input: ReviewerInputSchema,
      output: ReviewerOutputSchema,
      reasoning: NORMAL_REASONING,
      limits: REVIEWER_LIMITS,
      validate: reviewerValidate,
      callProfiles: ["reviewer", "judge"] as const,
    }),
  });

/** Resolve a shape contract or throw. Only the three executable shapes exist;
 * anything else is a category error the roster refuses to construct. */
export function shapeContract(shape: string): ShapeContract {
  const parsed = ProfileShapeSchema.safeParse(shape);
  if (!parsed.success) {
    throw new Error(
      `profile shape '${shape}' is not executable: the only shapes are ${PROFILE_SHAPES.join(", ")}`,
    );
  }
  return EXECUTABLE_PROFILE_SHAPES[parsed.data];
}
