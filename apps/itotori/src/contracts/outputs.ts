import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  ShortTextSchema,
  SourceSpanSchema,
} from "./shared.js";

export const DRAFT_BATCH_SCHEMA_VERSION = "itotori.draft-batch.v1" as const;
export const REVIEW_VERDICT_SCHEMA_VERSION = "itotori.review-verdict.v1" as const;
export const DEFECT_BUNDLE_SCHEMA_VERSION = "itotori.defect-bundle.v1" as const;

export const DraftUncertaintySchema = z.enum([
  "referent",
  "term",
  "speaker",
  "voice",
  "culture",
  "none",
]);

export const DraftBasisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("wiki-first"),
      bibleRenderingIds: z.array(IdentifierSchema).min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pure-mtl-ablation"),
      bibleRenderingIds: z.array(IdentifierSchema).length(0),
    })
    .strict(),
]);

const DraftUncertaintiesSchema = z
  .array(DraftUncertaintySchema)
  .min(1)
  .max(6)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({ code: "custom", message: "uncertainties must be unique" });
    }
    if (value.includes("none") && value.length !== 1) {
      context.addIssue({ code: "custom", message: "none cannot accompany an uncertainty" });
    }
  });

export const DraftSchema = z
  .object({
    unitId: IdentifierSchema,
    sourceHash: Sha256Schema,
    targetSkeleton: NonEmptyTextSchema,
    evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
    basis: DraftBasisSchema,
    uncertainty: DraftUncertaintiesSchema,
  })
  .strict();

const DraftBatchScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("whole-scene"),
      sceneId: IdentifierSchema,
      expectedUnitIds: z.array(IdentifierSchema).min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("overlapping-chunk"),
      sceneId: IdentifierSchema,
      chunkIndex: NonNegativeIntegerSchema,
      chunkCount: PositiveIntegerSchema,
      coreUnitIds: z.array(IdentifierSchema).min(1).max(100_000),
      overlapUnitIds: z.array(IdentifierSchema).max(100_000),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.chunkIndex >= value.chunkCount) {
        context.addIssue({ code: "custom", message: "chunkIndex must be below chunkCount" });
      }
      const overlap = new Set(value.overlapUnitIds);
      if (value.coreUnitIds.some((unitId) => overlap.has(unitId))) {
        context.addIssue({ code: "custom", message: "core and overlap units must be disjoint" });
      }
    }),
  z
    .object({
      kind: z.literal("repair-patch"),
      parentDraftBatchId: IdentifierSchema,
      defectBundleId: IdentifierSchema,
      repairMode: z.enum(["author-continuation", "fresh-grounded-fork"]),
      failedUnitIds: z.array(IdentifierSchema).min(1).max(100_000),
    })
    .strict(),
]);

export const DraftBatchSchema = z
  .object({
    schemaVersion: z.literal(DRAFT_BATCH_SCHEMA_VERSION),
    localizationSnapshotId: Sha256Schema,
    batchId: IdentifierSchema,
    scope: DraftBatchScopeSchema,
    drafts: z.array(DraftSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const draftIds = value.drafts.map((draft) => draft.unitId);
    if (new Set(draftIds).size !== draftIds.length) {
      context.addIssue({ code: "custom", message: "draft unit IDs must be unique" });
    }
    const expectedIds =
      value.scope.kind === "whole-scene"
        ? value.scope.expectedUnitIds
        : value.scope.kind === "overlapping-chunk"
          ? value.scope.coreUnitIds
          : value.scope.failedUnitIds;
    if (
      draftIds.length !== expectedIds.length ||
      draftIds.some((unitId, index) => unitId !== expectedIds[index])
    ) {
      context.addIssue({ code: "custom", message: "drafts must match expected unit order" });
    }
    const basisKinds = new Set(value.drafts.map((draft) => draft.basis.kind));
    if (basisKinds.size !== 1) {
      context.addIssue({ code: "custom", message: "a draft batch must have one context basis" });
    }
  });

export const ReviewRubricSchema = z.enum([
  "meaning",
  "voice",
  "terminology",
  "continuity",
  "build-lqa",
  "adjudication",
]);

const ReviewerRoleSchema = z.enum(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);

const ReviewBasisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("wiki-first"),
      bibleRenderingIds: z.array(IdentifierSchema).min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pure-mtl-ablation"),
      bibleRenderingIds: z.array(IdentifierSchema).length(0),
    })
    .strict(),
]);

export const ReviewCategorySchema = z.enum([
  "mistranslation",
  "omission",
  "addition",
  "referent",
  "register",
  "character-voice",
  "term-sense",
  "new-coinage",
  "callback",
  "foreshadow",
  "relationship",
  "route-arc",
  "onscreen-language",
  "subjective-conflict",
  "insufficient-evidence",
]);

const ReviewBaseShape = {
  schemaVersion: z.literal(REVIEW_VERDICT_SCHEMA_VERSION),
  reviewId: IdentifierSchema,
  localizationSnapshotId: Sha256Schema,
  roleId: ReviewerRoleSchema,
  rubric: ReviewRubricSchema,
  unitId: IdentifierSchema,
  basis: ReviewBasisSchema,
} as const;

export const ReviewVerdictSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      ...ReviewBaseShape,
      verdict: z.literal("PASS"),
      severity: z.literal("none"),
      span: z.null(),
      category: z.null(),
      evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
      repairConstraint: z.null(),
    })
    .strict(),
  z
    .object({
      ...ReviewBaseShape,
      verdict: z.literal("FAIL"),
      severity: z.enum(["minor", "major", "critical"]),
      span: SourceSpanSchema,
      category: ReviewCategorySchema.exclude(["insufficient-evidence"]),
      evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
      repairConstraint: ShortTextSchema,
    })
    .strict(),
  z
    .object({
      ...ReviewBaseShape,
      verdict: z.literal("CANNOT_ASSESS"),
      severity: z.literal("none"),
      span: SourceSpanSchema.nullable(),
      category: z.literal("insufficient-evidence"),
      evidenceIds: z.array(IdentifierSchema).max(1_024),
      repairConstraint: z.null(),
      requestedEvidence: z.array(ShortTextSchema).min(1).max(32),
    })
    .strict(),
]);

export const DeterministicDefectCategorySchema = z.enum([
  "protected-span",
  "unit-cardinality",
  "unit-order",
  "source-hash",
  "glossary-exact",
  "encoding",
  "byte-limit",
  "markup",
  "control-sequence",
  "punctuation",
  "evidence",
  "scope",
  "patch-coverage",
  "render",
  "ocr",
]);

export const ReviewerDefectCategorySchema = z.enum([
  "meaning",
  "voice",
  "terminology",
  "continuity",
  "build-lqa",
]);

export const DeterministicGateSchema = z.enum([
  "protected-spans",
  "cardinality-order-hash",
  "glossary-exact",
  "shift-jis",
  "byte-box",
  "markup-controls",
  "evidence-scope",
  "patch-coverage",
  "render-ocr",
]);

export const ReviewLaneSchema = z.enum(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);

const DefectBaseShape = {
  defectId: IdentifierSchema,
  unitId: IdentifierSchema,
  severity: z.enum(["minor", "major", "critical"]),
  span: SourceSpanSchema.nullable(),
  evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
  basisFactIds: z.array(IdentifierSchema).max(1_024),
  repairConstraint: ShortTextSchema,
  implicatedGates: z.array(DeterministicGateSchema).max(10),
  implicatedReviewLanes: z.array(ReviewLaneSchema).max(6),
} as const;

export const DefectSchema = z.discriminatedUnion("origin", [
  z
    .object({
      ...DefectBaseShape,
      origin: z.literal("deterministic"),
      category: DeterministicDefectCategorySchema,
      gate: DeterministicGateSchema,
    })
    .strict(),
  z
    .object({
      ...DefectBaseShape,
      origin: z.literal("reviewer"),
      category: ReviewerDefectCategorySchema,
      reviewId: IdentifierSchema,
      reviewLane: ReviewLaneSchema,
    })
    .strict(),
]);

const FactDominanceRecordSchema = z
  .object({
    winningFactId: IdentifierSchema,
    suppressedReviewId: IdentifierSchema,
    category: ReviewerDefectCategorySchema,
    reason: NonEmptyTextSchema,
  })
  .strict();

export const DefectBundleSchema = z
  .object({
    schemaVersion: z.literal(DEFECT_BUNDLE_SCHEMA_VERSION),
    bundleId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    draftBatchId: IdentifierSchema,
    defects: z.array(DefectSchema).max(100_000),
    factDominance: z.array(FactDominanceRecordSchema).max(100_000),
    resolution: z.enum(["none", "repair", "adjudication", "human-escalation"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.defects.length === 0) !== (value.resolution === "none")) {
      context.addIssue({
        code: "custom",
        message: "only an empty defect bundle may have no resolution work",
      });
    }
  });

export type Draft = z.infer<typeof DraftSchema>;
export type DraftBatch = z.infer<typeof DraftBatchSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type Defect = z.infer<typeof DefectSchema>;
export type DefectBundle = z.infer<typeof DefectBundleSchema>;
export type DefectCategory =
  | z.infer<typeof DeterministicDefectCategorySchema>
  | z.infer<typeof ReviewerDefectCategorySchema>;
