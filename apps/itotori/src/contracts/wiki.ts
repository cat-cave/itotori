import { z } from "zod";
import {
  AdaptationNoteBodySchema,
  CharacterBackgroundBodySchema,
  CharacterBioBodySchema,
  CharacterRouteArcBodySchema,
  LocalizedBodySchema,
  RouteArcBodySchema,
  SceneSummaryBodySchema,
  SpeakerHypothesisBodySchema,
  StorySoFarBodySchema,
  StyleContractBodySchema,
  TermRulingBodySchema,
  TranslationBodySchema,
  VoiceProfileBodySchema,
} from "./wiki-bodies.js";
import {
  ContextScopeValueSchema,
  EntityRefSchema,
  IdentifierSchema,
  LanguageTagSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  RoleIdSchema,
  RouteScopeSchema,
  RunModeValueSchema,
  Sha256Schema,
  ShortTextSchema,
  SubjectIdSchema,
} from "./shared.js";

export const WIKI_OBJECT_SCHEMA_VERSION = "itotori.wiki-object.v1" as const;
export const LOCALIZED_RENDERING_SCHEMA_VERSION = "itotori.localized-rendering.v1" as const;

export const WikiObjectKindSchema = z.enum([
  "style-contract",
  "term-ruling",
  "scene-summary",
  "story-so-far",
  "route-arc",
  "voice-profile",
  "adaptation-note",
  "character-bio",
  "character-background",
  "character-route-arc",
  "speaker-hypothesis",
  "translation",
]);

const SourceWikiObjectKindSchema = WikiObjectKindSchema.exclude(["translation"]);

export const CitationSchema = z
  .object({
    evidenceId: IdentifierSchema,
    evidenceHash: Sha256Schema,
    snapshotId: Sha256Schema,
    subject: EntityRefSchema,
    role: z.enum(["establishes", "supports", "contradicts", "first-mention", "reveal"]),
    quotedSpan: ShortTextSchema.nullish(),
    playOrderIndex: NonNegativeIntegerSchema,
  })
  .strict();

export const ClaimKindSchema = z.enum([
  "bio",
  "relationship",
  "arc",
  "voice",
  "beat",
  "subtext",
  "callback",
  "foreshadow",
  "term",
  "adaptation",
  "speaker-hypothesis",
  "style",
  "story-so-far",
  "background",
]);

export const ClaimSchema = z
  .object({
    claimId: IdentifierSchema,
    statement: NonEmptyTextSchema,
    scope: RouteScopeSchema,
    kind: ClaimKindSchema,
    confidence: z.enum(["low", "medium", "high"]),
    citations: z.array(CitationSchema).min(1).max(1_024),
    supersedesClaimId: IdentifierSchema.nullish(),
  })
  .strict();

const MediaDimensionsSchema = z
  .object({
    width: PositiveIntegerSchema,
    height: PositiveIntegerSchema,
  })
  .strict();

// Utsushi runtime artifacts are portable, managed references rather than
// service URLs. The artifact server is a resolution boundary and may move;
// this immutable URI is the stable value a WikiObject stores. Keep this in
// lockstep with `utsushi_core::validate_runtime_artifact_uri`.
export const UTSUSHI_RUNTIME_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime/";

export const UtsushiArtifactUriSchema = z.string().superRefine((value, context) => {
  if (
    !value.startsWith(UTSUSHI_RUNTIME_ARTIFACT_URI_ROOT) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "artifact URI must be a portable Utsushi runtime artifact URI",
    });
    return;
  }

  const relative = value.slice(UTSUSHI_RUNTIME_ARTIFACT_URI_ROOT.length);
  const segments = relative.split("/");
  if (
    segments.length < 3 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    context.addIssue({
      code: "custom",
      message: "artifact URI must contain managed run, kind, and filename segments",
    });
  }
});

const MediaAccessSchema = z
  .object({
    redaction: z.enum(["default-redacted", "clear"]),
    permission: z.enum(["public", "project-member", "restricted"]),
  })
  .strict();

const AvailableMediaSchema = z
  .object({
    status: z.literal("available"),
    artifactUri: UtsushiArtifactUriSchema,
    contentHash: Sha256Schema,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    dimensions: MediaDimensionsSchema,
    access: MediaAccessSchema,
  })
  .strict();

const UnavailableMediaSchema = z
  .object({
    status: z.literal("unavailable"),
    expectedContentHash: Sha256Schema,
    reason: z.enum(["missing", "hash-mismatch", "unauthorized-reveal"]),
  })
  .strict();

const MediaAvailabilitySchema = z.discriminatedUnion("status", [
  AvailableMediaSchema,
  UnavailableMediaSchema,
]);

export const MediaRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("portrait"),
      mediaId: IdentifierSchema,
      characterId: SubjectIdSchema,
      availability: MediaAvailabilitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("screenshot"),
      mediaId: IdentifierSchema,
      sceneId: IdentifierSchema,
      unitId: IdentifierSchema.nullish(),
      availability: MediaAvailabilitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cg"),
      mediaId: IdentifierSchema,
      assetId: IdentifierSchema,
      availability: MediaAvailabilitySchema,
    })
    .strict(),
]);

const HumanEditOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replace-text"),
      fieldPath: z.array(IdentifierSchema).min(1).max(32),
      before: z.string().max(32_768),
      after: z.string().max(32_768),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-integer"),
      fieldPath: z.array(IdentifierSchema).min(1).max(32),
      before: z.number().int(),
      after: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-field"),
      fieldPath: z.array(IdentifierSchema).min(1).max(32),
      priorValueHash: Sha256Schema,
    })
    .strict(),
]);

export const HumanInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("edit"),
      inputId: IdentifierSchema,
      operations: z.array(HumanEditOperationSchema).min(1).max(256),
      note: ShortTextSchema.nullish(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("feedback"),
      inputId: IdentifierSchema,
      text: NonEmptyTextSchema,
      targetClaimId: IdentifierSchema.nullish(),
      targetFieldPath: z.array(IdentifierSchema).min(1).max(32).nullish(),
    })
    .strict(),
]);

const WikiProvenanceBaseShape = {
  authorMemoKey: Sha256Schema.nullish(),
  authorRoleId: RoleIdSchema.nullish(),
  editedBy: z.enum(["human", "enhancement", "agent"]).nullish(),
  basisVersion: PositiveIntegerSchema.nullish(),
  humanInput: HumanInputSchema.nullish(),
  contextSnapshotId: Sha256Schema,
  contextScope: ContextScopeValueSchema,
  runMode: RunModeValueSchema,
} as const;

const SourceWikiProvenanceSchema = z
  .object({
    ...WikiProvenanceBaseShape,
    snapshotKind: z.literal("context"),
  })
  .strict();

const TranslationWikiProvenanceSchema = z
  .object({
    ...WikiProvenanceBaseShape,
    snapshotKind: z.literal("localization"),
    localizationSnapshotId: Sha256Schema,
  })
  .strict();

export const DependencyRefSchema = z
  .object({
    upstreamObjectId: IdentifierSchema,
    upstreamVersion: PositiveIntegerSchema,
    claimId: IdentifierSchema.nullable(),
    fieldPath: z.array(IdentifierSchema).max(32),
    renderingId: IdentifierSchema.nullable(),
    scope: RouteScopeSchema,
    fromPlayOrder: NonNegativeIntegerSchema.nullable(),
    throughPlayOrder: NonNegativeIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.claimId === null && value.fieldPath.length === 0 && value.renderingId === null) {
      context.addIssue({ code: "custom", message: "a dependency must identify consumed content" });
    }
    if (
      value.fromPlayOrder !== null &&
      value.throughPlayOrder !== null &&
      value.throughPlayOrder < value.fromPlayOrder
    ) {
      context.addIssue({ code: "custom", message: "dependency play-order range is reversed" });
    }
  });

const WikiObjectBaseShape = {
  schemaVersion: z.literal(WIKI_OBJECT_SCHEMA_VERSION),
  objectId: IdentifierSchema,
  version: PositiveIntegerSchema,
  supersedesVersion: PositiveIntegerSchema.nullish(),
  lang: LanguageTagSchema,
  subject: EntityRefSchema,
  scope: RouteScopeSchema,
  claims: z.array(ClaimSchema).max(10_000),
  media: z.array(MediaRefSchema).max(10_000),
  dependencies: z.array(DependencyRefSchema).max(100_000),
  provisional: z.boolean(),
} as const;

function sourceWikiObjectVariant<const Kind extends string, Body extends z.ZodType>(
  kind: Kind,
  body: Body,
) {
  return z
    .object({
      ...WikiObjectBaseShape,
      kind: z.literal(kind),
      body,
      provenance: SourceWikiProvenanceSchema,
    })
    .strict();
}

export const SourceWikiObjectSchema = z.discriminatedUnion("kind", [
  sourceWikiObjectVariant("style-contract", StyleContractBodySchema),
  sourceWikiObjectVariant("term-ruling", TermRulingBodySchema),
  sourceWikiObjectVariant("scene-summary", SceneSummaryBodySchema),
  sourceWikiObjectVariant("story-so-far", StorySoFarBodySchema),
  sourceWikiObjectVariant("route-arc", RouteArcBodySchema),
  sourceWikiObjectVariant("voice-profile", VoiceProfileBodySchema),
  sourceWikiObjectVariant("adaptation-note", AdaptationNoteBodySchema),
  sourceWikiObjectVariant("character-bio", CharacterBioBodySchema),
  sourceWikiObjectVariant("character-background", CharacterBackgroundBodySchema),
  sourceWikiObjectVariant("character-route-arc", CharacterRouteArcBodySchema),
  sourceWikiObjectVariant("speaker-hypothesis", SpeakerHypothesisBodySchema),
]);

export const TranslationWikiObjectSchema = z
  .object({
    ...WikiObjectBaseShape,
    kind: z.literal("translation"),
    body: TranslationBodySchema,
    provenance: TranslationWikiProvenanceSchema,
  })
  .strict();

export const WikiObjectSchema = z.union([SourceWikiObjectSchema, TranslationWikiObjectSchema]);

const ClaimRenderingSchema = z
  .object({
    claimId: IdentifierSchema,
    text: NonEmptyTextSchema,
    canonicalForms: z.array(ShortTextSchema).max(256),
  })
  .strict();

const LocalizedRenderingProvenanceSchema = z
  .object({
    basisSourceVersion: PositiveIntegerSchema,
    authorMemoKey: Sha256Schema.nullish(),
    editedBy: z.enum(["human", "enhancement", "agent"]).nullish(),
    humanInput: HumanInputSchema.nullish(),
    localizationSnapshotId: Sha256Schema,
    runMode: RunModeValueSchema,
  })
  .strict();

export const LocalizedRenderingSchema = z
  .object({
    schemaVersion: z.literal(LOCALIZED_RENDERING_SCHEMA_VERSION),
    renderingId: IdentifierSchema,
    sourceObjectId: IdentifierSchema,
    sourceObjectKind: SourceWikiObjectKindSchema,
    targetLanguage: LanguageTagSchema,
    version: PositiveIntegerSchema,
    supersedesVersion: PositiveIntegerSchema.nullish(),
    scope: RouteScopeSchema,
    body: LocalizedBodySchema,
    claimRenderings: z.array(ClaimRenderingSchema).max(10_000),
    dependencies: z.array(DependencyRefSchema).max(100_000),
    provenance: LocalizedRenderingProvenanceSchema,
    provisional: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceObjectKind !== value.body.kind) {
      context.addIssue({ code: "custom", message: "localized body kind must match its source" });
    }
    const claimIds = value.claimRenderings.map((rendering) => rendering.claimId);
    if (new Set(claimIds).size !== claimIds.length) {
      context.addIssue({ code: "custom", message: "claim renderings must be unique" });
    }
  });

export type Citation = z.infer<typeof CitationSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type DependencyRef = z.infer<typeof DependencyRefSchema>;
export type MediaRef = z.infer<typeof MediaRefSchema>;
export type HumanInput = z.infer<typeof HumanInputSchema>;
export type WikiObject = z.infer<typeof WikiObjectSchema>;
export type LocalizedRendering = z.infer<typeof LocalizedRenderingSchema>;
