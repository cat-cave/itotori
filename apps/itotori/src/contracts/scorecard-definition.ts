import { z } from "zod";
import { ReviewCategorySchema, ReviewRubricSchema } from "./outputs.js";
import {
  HashRefSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./shared.js";

export const ACCEPTANCE_SCORECARD_DEFINITION_SCHEMA_VERSION =
  "itotori.acceptance-scorecard-definition.v1" as const;
export const HUMAN_CALIBRATION_LABEL_SET_SCHEMA_VERSION =
  "itotori.human-calibration-label-set.v1" as const;

export const ScorecardContentAddressSchema = z
  .object({
    algorithm: z.literal("sha256"),
    canonicalization: z.literal("json-key-sort-v1"),
    sha256: Sha256Schema,
  })
  .strict();

const RequiredRubricsSchema = z
  .array(ReviewRubricSchema.extract(["meaning", "voice", "terminology", "continuity"]))
  .length(4);

const CalibratedRubricSchema = ReviewRubricSchema.extract([
  "meaning",
  "voice",
  "terminology",
  "continuity",
  "build-lqa",
]);

export const AcceptanceScorecardDefinitionSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_SCORECARD_DEFINITION_SCHEMA_VERSION),
    contentAddress: ScorecardContentAddressSchema,
    corpus: z
      .object({
        manifestSha256: Sha256Schema,
        unitsProjectionSha256: Sha256Schema,
      })
      .strict(),
    dimensions: z
      .object({
        completion: z
          .object({
            requiredUnitCount: PositiveIntegerSchema,
            acceptedStages: z.array(z.enum(["final", "build-lqa"])).length(2),
            releaseEligibility: z.literal("shippable"),
            requireExactUnitAndSourceHashSet: z.literal(true),
          })
          .strict(),
        efficiency: z
          .object({
            lineage: z.literal("cold"),
            baselinePhysicalAttempts: PositiveIntegerSchema,
            reductionDivisor: PositiveIntegerSchema,
            maximumPhysicalAttempts: PositiveIntegerSchema,
          })
          .strict(),
        zdr: z
          .object({
            requireAccountAttestation: z.literal(true),
            requireGuardrailAttestation: z.literal(true),
            requirePerPhysicalCallWireProof: z.literal(true),
            requireRequestedAndServedPair: z.literal(true),
            requireGenerationId: z.literal(true),
            requireMetadata: z.literal(true),
            requireCacheDisabled: z.literal(true),
            requireNoPlugins: z.literal(true),
          })
          .strict(),
        sys1: z
          .object({
            requiredRestartKinds: z.array(z.enum(["unit-restart", "pipeline-restart"])).length(2),
            requireMemoMonotonicity: z.literal(true),
            requireAcceptedOutputMonotonicity: z.literal(true),
            maximumRedispatchedMemoizedCalls: z.literal(0),
            maximumDiscardedAcceptedOutputs: z.literal(0),
          })
          .strict(),
        grounding: z
          .object({
            requireStrictTerminalSchemas: z.literal(true),
            rawJsonSalvageAllowed: z.literal(false),
            requireEvidenceExistence: z.literal(true),
            requireSnapshotVisibility: z.literal(true),
            requireScopeMatch: z.literal(true),
            requireHashMatch: z.literal(true),
          })
          .strict(),
        bibleConsistency: z
          .object({
            requireEveryUnit: z.literal(true),
            requirePinnedRenderingIds: z.literal(true),
            requirePinnedBibleHead: z.literal(true),
          })
          .strict(),
        patchCoverage: z
          .object({
            requiredUnitCount: PositiveIntegerSchema,
            allowPartialPatch: z.literal(false),
            requireProtectedSpanPass: z.literal(true),
            requireShiftJisPass: z.literal(true),
          })
          .strict(),
        translatedByteReplay: z
          .object({
            requiredUnitCount: PositiveIntegerSchema,
            requirePatchedTargetBytes: z.literal(true),
            allowSourceByteReplay: z.literal(false),
            requireAcceptedTargetHashMatch: z.literal(true),
          })
          .strict(),
        zeroCallReplay: z
          .object({
            maximumNewPhysicalAttempts: z.literal(0),
            identicalArtifacts: z
              .array(z.enum(["wiki", "bible", "accepted-outputs", "patch", "replay"]))
              .length(5),
          })
          .strict(),
      })
      .strict(),
    humanCalibration: z
      .object({
        labelsSha256: Sha256Schema,
        requiredRubrics: RequiredRubricsSchema,
        minimumHighRiskLabels: PositiveIntegerSchema,
        minimumRepresentativeCleanUnits: PositiveIntegerSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const efficiency = value.dimensions.efficiency;
    if (
      Math.floor(efficiency.baselinePhysicalAttempts / efficiency.reductionDivisor) !==
      efficiency.maximumPhysicalAttempts
    ) {
      context.addIssue({ code: "custom", message: "efficiency ceiling must derive from baseline" });
    }
    if (
      value.dimensions.completion.requiredUnitCount !==
        value.dimensions.patchCoverage.requiredUnitCount ||
      value.dimensions.completion.requiredUnitCount !==
        value.dimensions.translatedByteReplay.requiredUnitCount
    ) {
      context.addIssue({ code: "custom", message: "unit requirements must agree" });
    }
    if (new Set(value.humanCalibration.requiredRubrics).size !== 4) {
      context.addIssue({ code: "custom", message: "calibration rubrics must be unique" });
    }
    if (
      new Set(value.dimensions.completion.acceptedStages).size !== 2 ||
      new Set(value.dimensions.sys1.requiredRestartKinds).size !== 2 ||
      new Set(value.dimensions.zeroCallReplay.identicalArtifacts).size !== 5
    ) {
      context.addIssue({ code: "custom", message: "scorecard requirements must be unique" });
    }
  });

const HumanExpectedVerdictSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      verdict: z.literal("PASS"),
      severity: z.literal("none"),
      category: z.null(),
    })
    .strict(),
  z
    .object({
      verdict: z.literal("FAIL"),
      severity: z.enum(["minor", "major", "critical"]),
      category: ReviewCategorySchema.exclude(["insufficient-evidence"]),
    })
    .strict(),
]);

export const HumanCalibrationLabelSchema = z
  .object({
    labelId: z.string().min(1).max(256),
    unit: HashRefSchema,
    candidate: HashRefSchema,
    rubric: CalibratedRubricSchema,
    stratum: z.enum(["high-risk", "representative-clean"]),
    expected: HumanExpectedVerdictSchema,
    adjudication: z
      .object({
        kind: z.literal("human"),
        raterCount: PositiveIntegerSchema,
        dissentCount: NonNegativeIntegerSchema,
        blindToCandidateProvenance: z.literal(true),
      })
      .strict(),
    basis: z.enum([
      "meaning-preservation",
      "speaker-voice-history",
      "localized-terminology-ruling",
      "route-continuity",
      "clean-reference",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.stratum === "representative-clean" && value.expected.verdict !== "PASS") {
      context.addIssue({ code: "custom", message: "clean labels must pass" });
    }
    if (value.adjudication.dissentCount * 2 >= value.adjudication.raterCount) {
      context.addIssue({ code: "custom", message: "human adjudication requires a majority" });
    }
    if (value.expected.verdict === "PASS") return;
    const allowed = {
      meaning: ["mistranslation", "omission", "addition", "referent", "register"],
      voice: ["register", "character-voice"],
      terminology: ["term-sense", "new-coinage"],
      continuity: ["callback", "foreshadow", "relationship", "route-arc"],
      "build-lqa": ["onscreen-language"],
    }[value.rubric];
    if (!allowed.includes(value.expected.category)) {
      context.addIssue({ code: "custom", message: "label category is outside its rubric" });
    }
  });

export const HumanCalibrationLabelSetSchema = z
  .object({
    schemaVersion: z.literal(HUMAN_CALIBRATION_LABEL_SET_SCHEMA_VERSION),
    contentAddress: ScorecardContentAddressSchema,
    corpusManifestSha256: Sha256Schema,
    policy: z
      .object({
        usage: z.literal("reviewer-calibration-and-release-audit-only"),
        modelTuningAllowed: z.literal(false),
        candidateProvenanceBlind: z.literal(true),
      })
      .strict(),
    labels: z.array(HumanCalibrationLabelSchema).min(1).max(10_000),
  })
  .strict();

export type AcceptanceScorecardDefinition = z.infer<typeof AcceptanceScorecardDefinitionSchema>;
export type HumanCalibrationLabel = z.infer<typeof HumanCalibrationLabelSchema>;
export type HumanCalibrationLabelSet = z.infer<typeof HumanCalibrationLabelSetSchema>;
