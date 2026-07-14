import { z } from "zod";
import { DeterministicGateSchema, DraftBasisSchema } from "./outputs.js";
import {
  ContextScopeValueSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  PositiveIntegerSchema,
  RunModeValueSchema,
  Sha256Schema,
} from "./shared.js";
import {
  LocalizedRenderingSchema,
  SourceWikiObjectSchema,
  TranslationWikiObjectSchema,
} from "./wiki.js";

export const ACCEPTED_OUTPUT_SCHEMA_VERSION = "itotori.accepted-output.v1" as const;

const ReleaseEligibilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shippable"),
      runMode: z.enum(["production", "pilot"]),
      contextScope: z.enum(["whole-game", "external-augmented"]),
      basis: z.literal("wiki-first"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact-only"),
      runMode: RunModeValueSchema,
      contextScope: ContextScopeValueSchema,
      reason: z.enum(["narrowed-context", "test-dev", "pure-mtl-ablation", "not-final"]),
    })
    .strict(),
]);

const GateReceiptSchema = z
  .object({
    gate: DeterministicGateSchema,
    evidenceHash: Sha256Schema,
    status: z.literal("PASS"),
  })
  .strict();

const AcceptedTranslationValueSchema = z
  .object({
    targetSkeleton: z.string().min(1).max(32_768),
    targetHash: Sha256Schema,
    translationObjectId: IdentifierSchema,
    translationObjectVersion: PositiveIntegerSchema,
    parentDraftBatchId: IdentifierSchema,
    basis: DraftBasisSchema,
    gateReceipts: z.array(GateReceiptSchema).min(1).max(32),
    reviewVerdictIds: z.array(IdentifierSchema).max(32),
  })
  .strict();

const AcceptedOutputBaseShape = {
  schemaVersion: z.literal(ACCEPTED_OUTPUT_SCHEMA_VERSION),
  outputId: IdentifierSchema,
  version: PositiveIntegerSchema,
  supersedesOutputId: IdentifierSchema.optional(),
  parentOutputIds: z.array(IdentifierSchema).max(1_024),
  memoKeys: z.array(Sha256Schema).max(1_024),
  evidenceIds: z.array(IdentifierSchema).max(10_000),
  acceptedAt: IsoDateTimeSchema,
  releaseEligibility: ReleaseEligibilitySchema,
} as const;

export const AcceptedOutputSchema = z
  .discriminatedUnion("subjectType", [
    z
      .object({
        ...AcceptedOutputBaseShape,
        subjectType: z.literal("unit"),
        subjectId: IdentifierSchema,
        localizationSnapshotId: IdentifierSchema,
        stage: z.enum(["draft", "repair", "final", "build-lqa"]),
        sourceHash: Sha256Schema,
        value: AcceptedTranslationValueSchema,
      })
      .strict(),
    z
      .object({
        ...AcceptedOutputBaseShape,
        subjectType: z.literal("wiki-object"),
        subjectId: IdentifierSchema,
        contextSnapshotId: IdentifierSchema,
        stage: z.literal("source-wiki"),
        value: SourceWikiObjectSchema,
      })
      .strict(),
    z
      .object({
        ...AcceptedOutputBaseShape,
        subjectType: z.literal("translation-object"),
        subjectId: IdentifierSchema,
        localizationSnapshotId: IdentifierSchema,
        stage: z.literal("translation"),
        sourceHash: Sha256Schema,
        value: TranslationWikiObjectSchema,
      })
      .strict(),
    z
      .object({
        ...AcceptedOutputBaseShape,
        subjectType: z.literal("localized-rendering"),
        subjectId: IdentifierSchema,
        localizationSnapshotId: IdentifierSchema,
        stage: z.literal("localized-bible"),
        value: LocalizedRenderingSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const eligibility = value.releaseEligibility;
    const narrowedContext = eligibility.contextScope.startsWith("narrowed:");
    if (narrowedContext && eligibility.runMode !== "test-dev") {
      context.addIssue({ code: "custom", message: "narrowed context requires test-dev mode" });
    }
    if (
      eligibility.kind === "artifact-only" &&
      eligibility.reason === "narrowed-context" &&
      !narrowedContext
    ) {
      context.addIssue({
        code: "custom",
        message: "narrowed-context disposition requires its scope",
      });
    }
    if (
      eligibility.kind === "artifact-only" &&
      eligibility.reason === "test-dev" &&
      eligibility.runMode !== "test-dev"
    ) {
      context.addIssue({ code: "custom", message: "test-dev disposition requires test-dev mode" });
    }

    if (value.subjectType === "unit") {
      const wikiFirst = value.value.basis.kind === "wiki-first";
      if (
        eligibility.kind === "shippable" &&
        (!wikiFirst || (value.stage !== "final" && value.stage !== "build-lqa"))
      ) {
        context.addIssue({
          code: "custom",
          message: "shippable units must be final wiki-first outputs",
        });
      }
      if (
        eligibility.kind === "artifact-only" &&
        eligibility.reason === "pure-mtl-ablation" &&
        wikiFirst
      ) {
        context.addIssue({
          code: "custom",
          message: "pure-MTL disposition requires its explicit basis",
        });
      }
      return;
    }

    if (eligibility.kind === "shippable") {
      context.addIssue({
        code: "custom",
        message: "intermediate artifacts are not independently shippable",
      });
    }

    if (value.subjectType === "translation-object") {
      const wikiFirst = value.value.body.draftBatch.drafts[0]?.basis.kind === "wiki-first";
      if (
        eligibility.kind === "artifact-only" &&
        eligibility.reason === "pure-mtl-ablation" &&
        wikiFirst
      ) {
        context.addIssue({
          code: "custom",
          message: "pure-MTL disposition requires its explicit basis",
        });
      }
      if (
        eligibility.runMode !== value.value.provenance.runMode ||
        eligibility.contextScope !== value.value.provenance.contextScope
      ) {
        context.addIssue({ code: "custom", message: "release provenance must match the artifact" });
      }
      return;
    }

    if (value.subjectType === "wiki-object") {
      if (
        eligibility.runMode !== value.value.provenance.runMode ||
        eligibility.contextScope !== value.value.provenance.contextScope
      ) {
        context.addIssue({ code: "custom", message: "release provenance must match the artifact" });
      }
      return;
    }

    if (eligibility.runMode !== value.value.provenance.runMode) {
      context.addIssue({ code: "custom", message: "release mode must match the artifact" });
    }
  });

export type AcceptedOutput = z.infer<typeof AcceptedOutputSchema>;
