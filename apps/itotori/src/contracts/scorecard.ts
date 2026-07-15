import { z } from "zod";
import { AcceptedOutputSchema } from "./accepted.js";
import { PhysicalStepMemoSchema } from "./calls.js";
import {
  IdentifierSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./shared.js";

export const ACCEPTANCE_EVIDENCE_BUNDLE_SCHEMA_VERSION =
  "itotori.acceptance-evidence-bundle.v1" as const;
export const ACCEPTANCE_SCORE_RESULT_SCHEMA_VERSION = "itotori.acceptance-score-result.v1" as const;

export const AcceptanceDimensionIdSchema = z.enum([
  "completion",
  "cold-lineage-physical-attempts",
  "zdr",
  "sys1-durability",
  "strict-grounding",
  "bible-consistency",
  "patch-coverage",
  "translated-byte-replay",
  "zero-call-deterministic-replay",
]);

export const AcceptanceAttemptStageSchema = z.enum([
  "source-wiki",
  "localized-bible",
  "draft",
  "review",
  "correction",
  "retry",
  "repair",
  "build-lqa",
  "feedback-enhancement",
]);

const PhysicalStepEvidenceSchema = z
  .object({
    stage: AcceptanceAttemptStageSchema,
    memo: PhysicalStepMemoSchema,
  })
  .strict();

const ZdrAttestationSchema = z
  .object({
    attestationHash: Sha256Schema,
    verified: z.boolean(),
  })
  .strict();

const ZdrWireProofSchema = z
  .object({
    memoKey: Sha256Schema,
    routerAttemptOrdinal: PositiveIntegerSchema,
    requestHash: Sha256Schema,
    servedModel: IdentifierSchema,
    servedProvider: IdentifierSchema,
    generationId: IdentifierSchema,
    policyProofHash: Sha256Schema,
    zdrRoutingProofHash: Sha256Schema,
    requestPolicyVerified: z.boolean(),
    servedPairVerified: z.boolean(),
    metadataCaptured: z.boolean(),
    cacheDisabled: z.boolean(),
    noPlugins: z.boolean(),
  })
  .strict();

const RestartProofSchema = z
  .object({
    kind: z.enum(["unit-restart", "pipeline-restart"]),
    faultProofHash: Sha256Schema,
    acceptedMemoKeysBefore: z.array(Sha256Schema).max(100_000),
    acceptedMemoKeysAfter: z.array(Sha256Schema).max(100_000),
    acceptedOutputHashesBefore: z.array(Sha256Schema).max(100_000),
    acceptedOutputHashesAfter: z.array(Sha256Schema).max(100_000),
    redispatchedMemoKeys: z.array(Sha256Schema).max(100_000),
    discardedAcceptedOutputHashes: z.array(Sha256Schema).max(100_000),
  })
  .strict();

const CitationCheckSchema = z
  .object({
    outputId: IdentifierSchema,
    evidenceId: IdentifierSchema,
    evidenceHash: Sha256Schema,
    snapshotId: IdentifierSchema,
    exists: z.boolean(),
    visibleInSnapshot: z.boolean(),
    scopeMatches: z.boolean(),
    hashMatches: z.boolean(),
  })
  .strict();

const BibleConsistencyReceiptSchema = z
  .object({
    unitId: IdentifierSchema,
    outputId: IdentifierSchema,
    bibleRenderingIds: z.array(IdentifierSchema).min(1).max(1_024),
    bibleHeadHash: Sha256Schema,
    consistent: z.boolean(),
  })
  .strict();

const PatchCoverageReceiptSchema = z
  .object({
    unitId: IdentifierSchema,
    outputId: IdentifierSchema,
    sourceHash: Sha256Schema,
    targetHash: Sha256Schema,
    covered: z.boolean(),
    protectedSpansPassed: z.boolean(),
    shiftJisPassed: z.boolean(),
  })
  .strict();

const TranslatedByteReplayReceiptSchema = z
  .object({
    unitId: IdentifierSchema,
    acceptedTargetHash: Sha256Schema,
    observedTargetHash: Sha256Schema,
    fromPatchedTargetBytes: z.boolean(),
    replayPassed: z.boolean(),
  })
  .strict();

const ReplayArtifactStateSchema = z
  .object({
    wikiHash: Sha256Schema,
    bibleHash: Sha256Schema,
    acceptedOutputsHash: Sha256Schema,
    patchHash: Sha256Schema,
    replayArtifactHash: Sha256Schema,
  })
  .strict();

export const AcceptanceEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_EVIDENCE_BUNDLE_SCHEMA_VERSION),
    runId: IdentifierSchema,
    scorecardDefinitionHash: Sha256Schema,
    humanCalibrationLabelsHash: Sha256Schema,
    corpusManifestHash: Sha256Schema,
    completion: z.object({ acceptedOutputs: z.array(AcceptedOutputSchema).max(100_000) }).strict(),
    efficiency: z
      .object({
        lineage: z.enum(["cold", "warm"]),
        attempts: z.array(PhysicalStepEvidenceSchema).max(100_000),
      })
      .strict(),
    zdr: z
      .object({
        account: ZdrAttestationSchema,
        guardrail: ZdrAttestationSchema,
        wireProofs: z.array(ZdrWireProofSchema).max(300_000),
      })
      .strict(),
    sys1: z.object({ restartProofs: z.array(RestartProofSchema).max(1_024) }).strict(),
    grounding: z
      .object({
        strictTerminalSchemas: z.boolean(),
        noRawJsonSalvage: z.boolean(),
        citationChecks: z.array(CitationCheckSchema).max(1_000_000),
      })
      .strict(),
    bibleConsistency: z
      .object({ receipts: z.array(BibleConsistencyReceiptSchema).max(100_000) })
      .strict(),
    patchCoverage: z
      .object({
        patchHash: Sha256Schema,
        partial: z.boolean(),
        receipts: z.array(PatchCoverageReceiptSchema).max(100_000),
      })
      .strict(),
    translatedByteReplay: z
      .object({
        patchHash: Sha256Schema,
        sourceBytesHash: Sha256Schema,
        patchedBytesHash: Sha256Schema,
        replayArtifactHash: Sha256Schema,
        receipts: z.array(TranslatedByteReplayReceiptSchema).max(100_000),
      })
      .strict(),
    zeroCallReplay: z
      .object({
        replayRunId: IdentifierSchema,
        newPhysicalAttempts: NonNegativeIntegerSchema,
        before: ReplayArtifactStateSchema,
        after: ReplayArtifactStateSchema,
      })
      .strict(),
  })
  .strict();

const DimensionBaseShape = {
  status: z.enum(["PASS", "FAIL"]),
  evidenceHash: Sha256Schema,
} as const;

export const AcceptanceDimensionResultSchema = z.discriminatedUnion("dimension", [
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("completion"),
      requiredUnitCount: PositiveIntegerSchema,
      writtenUnitCount: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("cold-lineage-physical-attempts"),
      maximumPhysicalAttempts: PositiveIntegerSchema,
      physicalAttemptCount: NonNegativeIntegerSchema,
      coldLineage: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("zdr"),
      physicalCallCount: NonNegativeIntegerSchema,
      verifiedCallCount: NonNegativeIntegerSchema,
      accountVerified: z.boolean(),
      guardrailVerified: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("sys1-durability"),
      requiredRestartProofCount: PositiveIntegerSchema,
      passingRestartProofCount: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("strict-grounding"),
      citationCount: NonNegativeIntegerSchema,
      passingCitationCount: NonNegativeIntegerSchema,
      strictTerminalSchemas: z.boolean(),
      noRawJsonSalvage: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("bible-consistency"),
      requiredUnitCount: PositiveIntegerSchema,
      consistentUnitCount: NonNegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("patch-coverage"),
      requiredUnitCount: PositiveIntegerSchema,
      coveredUnitCount: NonNegativeIntegerSchema,
      patchHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("translated-byte-replay"),
      requiredUnitCount: PositiveIntegerSchema,
      replayedUnitCount: NonNegativeIntegerSchema,
      patchedBytesHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      ...DimensionBaseShape,
      dimension: z.literal("zero-call-deterministic-replay"),
      newPhysicalAttempts: NonNegativeIntegerSchema,
      identicalArtifacts: z.boolean(),
    })
    .strict(),
]);

export const AcceptanceScoreResultSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_SCORE_RESULT_SCHEMA_VERSION),
    runId: IdentifierSchema,
    scorecardDefinitionHash: Sha256Schema,
    humanCalibrationLabelsHash: Sha256Schema,
    corpusManifestHash: Sha256Schema,
    evidenceBundleHash: Sha256Schema,
    status: z.enum(["PASS", "FAIL"]),
    dimensions: z.array(AcceptanceDimensionResultSchema).length(9),
  })
  .strict()
  .superRefine((value, context) => {
    const dimensions = value.dimensions.map((result) => result.dimension);
    if (new Set(dimensions).size !== AcceptanceDimensionIdSchema.options.length) {
      context.addIssue({ code: "custom", message: "score result must contain every dimension" });
    }
    const expectedStatus = value.dimensions.every((result) => result.status === "PASS")
      ? "PASS"
      : "FAIL";
    if (value.status !== expectedStatus) {
      context.addIssue({ code: "custom", message: "overall score must match its dimensions" });
    }
  });

export type AcceptanceEvidenceBundle = z.infer<typeof AcceptanceEvidenceBundleSchema>;
export type AcceptanceDimensionResult = z.infer<typeof AcceptanceDimensionResultSchema>;
export type AcceptanceScoreResult = z.infer<typeof AcceptanceScoreResultSchema>;
