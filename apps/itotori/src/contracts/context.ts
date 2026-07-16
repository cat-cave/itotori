import { SURFACE_KINDS } from "@itotori/localization-bridge-schema";
import { z } from "zod";
import {
  AcceptedHeadSchema,
  ColorRgbSchema,
  ContextScopeValueSchema,
  EncryptedPayloadRefSchema,
  EntityRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  LanguageTagSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  RevisionRefSchema,
  RoleIdSchema,
  RouteScopeSchema,
  Sha256Schema,
  ShortTextSchema,
  ToolNameSchema,
  VisibilitySchema,
} from "./shared.js";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "itotori.context-snapshot.v1" as const;
export const LOCALIZATION_SNAPSHOT_SCHEMA_VERSION = "itotori.localization-snapshot.v1" as const;
export const CONVERSATION_EVENT_SCHEMA_VERSION = "itotori.conversation-event.v1" as const;
export const FACT_SCHEMA_VERSION = "itotori.fact.v1" as const;

const SourceUnitHashSchema = z
  .object({
    unitId: IdentifierSchema,
    sourceHash: Sha256Schema,
  })
  .strict();

const RevealHorizonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }).strict(),
  z
    .object({
      kind: z.literal("through-play-order"),
      playOrderIndex: NonNegativeIntegerSchema,
    })
    .strict(),
]);

export const ContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_SNAPSHOT_SCHEMA_VERSION),
    snapshotId: Sha256Schema,
    contentHash: Sha256Schema,
    sourceLanguage: LanguageTagSchema,
    decode: RevisionRefSchema,
    structure: RevisionRefSchema,
    routeGraph: RevisionRefSchema,
    glossary: RevisionRefSchema,
    style: RevisionRefSchema,
    humanCorrections: RevisionRefSchema,
    externalSources: RevisionRefSchema.nullable(),
    sourceUnits: z.array(SourceUnitHashSchema).min(1).max(1_000_000),
    revealHorizon: RevealHorizonSchema,
    contextScope: ContextScopeValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshotId !== value.contentHash) {
      context.addIssue({ code: "custom", message: "snapshot ID must equal its content hash" });
    }
    const unitIds = new Set(value.sourceUnits.map((unit) => unit.unitId));
    if (unitIds.size !== value.sourceUnits.length) {
      context.addIssue({ code: "custom", message: "source unit IDs must be unique" });
    }
    if ((value.contextScope === "external-augmented") !== (value.externalSources !== null)) {
      context.addIssue({
        code: "custom",
        message: "external-augmented scope requires an external source revision",
      });
    }
  });

export const LocalizationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(LOCALIZATION_SNAPSHOT_SCHEMA_VERSION),
    snapshotId: Sha256Schema,
    contentHash: Sha256Schema,
    contextSnapshot: z.object({ id: Sha256Schema, hash: Sha256Schema }).strict(),
    targetLanguage: LanguageTagSchema,
    localeBranchId: IdentifierSchema,
    acceptedBibleHead: AcceptedHeadSchema.nullable(),
    acceptedTargetOutputHead: AcceptedHeadSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshotId !== value.contentHash) {
      context.addIssue({ code: "custom", message: "snapshot ID must equal its content hash" });
    }
    if (value.contextSnapshot.id !== value.contextSnapshot.hash) {
      context.addIssue({ code: "custom", message: "context snapshot ID must equal its hash" });
    }
  });

export const ConversationEventKindSchema = z.enum([
  "instruction",
  "input",
  "assistant",
  "tool",
  "artifact",
  "defects",
]);

const ConversationEventBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("instruction"),
      instructionVersion: z.string().min(1).max(128),
      contentHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("input"),
      inputType: z.enum(["prompt", "human", "artifact-projection"]),
      contentHash: Sha256Schema,
      artifactIds: z.array(IdentifierSchema).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assistant"),
      responseType: z.enum(["text", "tool-calls", "terminal", "refusal"]),
      contentHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool"),
      tool: ToolNameSchema,
      toolCallId: IdentifierSchema,
      resultHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      artifactType: z.enum(["wiki-object", "localized-rendering", "draft", "accepted-output"]),
      artifactId: IdentifierSchema,
      artifactHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("defects"),
      defectBundleId: IdentifierSchema,
      defectBundleHash: Sha256Schema,
    })
    .strict(),
]);

export const ConversationEventSchema = z
  .object({
    schemaVersion: z.literal(CONVERSATION_EVENT_SCHEMA_VERSION),
    eventId: Sha256Schema,
    parentEventIds: z.array(Sha256Schema).max(32),
    kind: ConversationEventKindSchema,
    snapshot: z
      .object({
        kind: z.enum(["context", "localization"]),
        snapshotId: Sha256Schema,
      })
      .strict(),
    role: z.union([RoleIdSchema, z.literal("application"), z.literal("human")]),
    body: ConversationEventBodySchema,
    bodyEncrypted: EncryptedPayloadRefSchema,
    memoKey: Sha256Schema.optional(),
    accepted: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentEventIds.includes(value.eventId)) {
      context.addIssue({ code: "custom", message: "an event cannot parent itself" });
    }
    if (value.kind !== value.body.kind) {
      context.addIssue({ code: "custom", message: "event kind must match its body" });
    }
  });

export const SpeakerTruthSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("known"),
      rawName: ShortTextSchema,
      resolvedDisplayName: ShortTextSchema,
      revealSafeLabel: ShortTextSchema,
      canonicalCharacterId: IdentifierSchema,
      color: ColorRgbSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("parser-unknown"),
      rawName: ShortTextSchema.nullable(),
      revealSafeLabel: ShortTextSchema,
      color: ColorRgbSchema.nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("reader-unknown"),
      rawName: ShortTextSchema,
      revealSafeLabel: ShortTextSchema,
      color: ColorRgbSchema.nullable(),
    })
    .strict(),
]);

const ProtectedPlaceholderSchema = z
  .object({
    placeholderId: IdentifierSchema,
    kind: z.enum(["control-markup", "variable", "ruby"]),
    sourceText: ShortTextSchema,
  })
  .strict();

const ChoiceContextSchema = z
  .object({
    choiceId: IdentifierSchema,
    optionIndex: NonNegativeIntegerSchema,
    branchTargetSceneId: IdentifierSchema.nullable(),
  })
  .strict();

export const UnitFactValueSchema = z
  .object({
    kind: z.literal("unit"),
    unitId: IdentifierSchema,
    bridgeUnitId: IdentifierSchema,
    sceneId: IdentifierSchema,
    playOrderIndex: NonNegativeIntegerSchema,
    sourceHash: Sha256Schema,
    sourceSurface: NonEmptyTextSchema,
    sourceSkeleton: NonEmptyTextSchema,
    surfaceKind: z.enum(SURFACE_KINDS),
    speaker: SpeakerTruthSchema.nullable(),
    choiceContext: ChoiceContextSchema.nullable(),
    protectedPlaceholders: z.array(ProtectedPlaceholderSchema).max(256),
    sourceAssetRef: IdentifierSchema,
    byteOffset: NonNegativeIntegerSchema,
    byteLength: PositiveIntegerSchema,
    rawByteHandle: IdentifierSchema,
    routeScopes: z.array(RouteScopeSchema).min(1).max(128),
  })
  .strict();

export const SceneFactValueSchema = z
  .object({
    kind: z.literal("scene"),
    sceneId: IdentifierSchema,
    playOrderIndex: NonNegativeIntegerSchema,
    unitIds: z.array(IdentifierSchema).max(100_000),
    speakerCharacterIds: z.array(IdentifierSchema).max(10_000),
    choiceIds: z.array(IdentifierSchema).max(10_000),
    predecessorSceneIds: z.array(IdentifierSchema).max(10_000),
    successorSceneIds: z.array(IdentifierSchema).max(10_000),
    routeScopes: z.array(RouteScopeSchema).min(1).max(128),
  })
  .strict();

export const RouteNodeFactValueSchema = z
  .object({
    kind: z.literal("route-node"),
    nodeId: IdentifierSchema,
    nodeKind: z.enum(["scene", "choice"]),
    sceneId: IdentifierSchema,
    playOrderIndex: NonNegativeIntegerSchema,
    predecessors: z.array(IdentifierSchema).max(10_000),
    successors: z.array(IdentifierSchema).max(10_000),
    reachable: z.boolean(),
    routeScopes: z.array(RouteScopeSchema).min(1).max(128),
  })
  .strict();

export const RouteEdgeFactValueSchema = z
  .object({
    kind: z.literal("route-edge"),
    edgeId: IdentifierSchema,
    fromNodeId: IdentifierSchema,
    toNodeId: IdentifierSchema.nullable(),
    edgeKind: z.enum(["dispatch", "choice"]),
    optionIndex: NonNegativeIntegerSchema.nullable(),
    evidenceId: IdentifierSchema,
    completeness: z.enum(["complete", "partial", "unresolved"]),
  })
  .strict();

export const CharacterOccurrenceFactValueSchema = z
  .object({
    kind: z.literal("character-occurrence"),
    characterId: IdentifierSchema,
    decodedLabel: ShortTextSchema,
    revealStatus: z.enum(["revealed", "reader-unknown"]),
    sceneIds: z.array(IdentifierSchema).min(1).max(100_000),
    unitIds: z.array(IdentifierSchema).min(1).max(1_000_000),
    linesByScene: z
      .array(
        z
          .object({
            sceneId: IdentifierSchema,
            lineCount: PositiveIntegerSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    totalLines: PositiveIntegerSchema,
    firstSceneId: IdentifierSchema,
    lastSceneId: IdentifierSchema,
  })
  .strict();

const GlossaryFormSchema = z
  .object({
    language: LanguageTagSchema,
    form: ShortTextSchema,
    status: z.enum(["preferred", "allowed", "forbidden"]),
  })
  .strict();

export const GlossaryFactValueSchema = z
  .object({
    kind: z.literal("glossary-entry"),
    termId: IdentifierSchema,
    sourceForm: ShortTextSchema,
    aliases: z.array(ShortTextSchema).max(256),
    forms: z.array(GlossaryFormSchema).max(256),
    scope: RouteScopeSchema,
    occurrenceUnitIds: z.array(IdentifierSchema).max(1_000_000),
    conflictsWithTermIds: z.array(IdentifierSchema).max(10_000),
    revision: RevisionRefSchema,
  })
  .strict();

export const AcceptedOutputFactValueSchema = z
  .object({
    kind: z.literal("accepted-output"),
    outputId: IdentifierSchema,
    subject: EntityRefSchema,
    stage: z.enum(["source-wiki", "localized-bible", "translation", "review", "final"]),
    outputHash: Sha256Schema,
    acceptedAt: IsoDateTimeSchema,
  })
  .strict();

export const HumanNoteFactValueSchema = z
  .object({
    kind: z.literal("human-note"),
    noteId: IdentifierSchema,
    excerpt: NonEmptyTextSchema,
    revision: RevisionRefSchema,
    scope: RouteScopeSchema,
  })
  .strict();

const FactBaseShape = {
  schemaVersion: z.literal(FACT_SCHEMA_VERSION),
  factId: IdentifierSchema,
  snapshotId: Sha256Schema,
  hash: Sha256Schema,
  visibility: VisibilitySchema,
} as const;

export const UnitFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("decode"), value: UnitFactValueSchema })
  .strict();

export const SceneFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("decode"), value: SceneFactValueSchema })
  .strict();

export const RouteNodeFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("decode"), value: RouteNodeFactValueSchema })
  .strict();

export const RouteEdgeFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("decode"), value: RouteEdgeFactValueSchema })
  .strict();

export const CharacterOccurrenceFactSchema = z
  .object({
    ...FactBaseShape,
    source: z.literal("decode"),
    value: CharacterOccurrenceFactValueSchema,
  })
  .strict();

export const GlossaryFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("glossary"), value: GlossaryFactValueSchema })
  .strict();

export const AcceptedOutputFactSchema = z
  .object({
    ...FactBaseShape,
    source: z.literal("accepted-output"),
    value: AcceptedOutputFactValueSchema,
  })
  .strict();

export const HumanNoteFactSchema = z
  .object({ ...FactBaseShape, source: z.literal("human-note"), value: HumanNoteFactValueSchema })
  .strict();

export const FactSchema = z.union([
  UnitFactSchema,
  SceneFactSchema,
  RouteNodeFactSchema,
  RouteEdgeFactSchema,
  CharacterOccurrenceFactSchema,
  GlossaryFactSchema,
  AcceptedOutputFactSchema,
  HumanNoteFactSchema,
]);

export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type LocalizationSnapshot = z.infer<typeof LocalizationSnapshotSchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type UnitFact = z.infer<typeof UnitFactSchema>;
export type UnitFactValue = z.infer<typeof UnitFactValueSchema>;
export type SceneFact = z.infer<typeof SceneFactSchema>;
export type RouteNodeFact = z.infer<typeof RouteNodeFactSchema>;
export type RouteEdgeFact = z.infer<typeof RouteEdgeFactSchema>;
export type CharacterOccurrenceFact = z.infer<typeof CharacterOccurrenceFactSchema>;
export type GlossaryFact = z.infer<typeof GlossaryFactSchema>;
export type GlossaryFactValue = z.infer<typeof GlossaryFactValueSchema>;
export type HumanNoteFact = z.infer<typeof HumanNoteFactSchema>;
export type HumanNoteFactValue = z.infer<typeof HumanNoteFactValueSchema>;
export type SpeakerTruth = z.infer<typeof SpeakerTruthSchema>;
