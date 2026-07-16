import { IdentifierSchema, Sha256Schema } from "../contracts/shared.js";
import { z } from "zod";
import {
  NARRATIVE_STRUCTURE_V1,
  NARRATIVE_STRUCTURE_V2,
  NarrativeStructureParseError,
  NarrativeStructureVersionError,
  type NarrativeChoice,
  type NarrativeMessage,
  type NarrativeScene,
  type NarrativeStructure,
  type NarrativeStructureVersion,
  type SelectionControlSignal,
} from "./types.js";

const SceneIdSchema = z.number().int();
const SelectionControlSchema = z.enum(["button-object", "text-window", "none"]);
const EdgeResolutionSchema = z.enum(["resolved", "unknown", "unresolved"]);
const EvidenceTierSchema = z.enum(["E0", "E1", "E2", "E3"]);
const RgbSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
const SourceAssetSchema = z
  .object({ assetId: IdentifierSchema, assetKey: IdentifierSchema })
  .strict();
const BridgeRefSchema = z
  .object({
    bridgeUnitId: IdentifierSchema,
    sourceUnitKey: IdentifierSchema,
    runtimeObjectId: z.string().min(1).optional(),
  })
  .strict();
const RevealOrderSchema = z
  .object({
    sceneOrder: z.number().int().nonnegative(),
    itemOrder: z.number().int().nonnegative(),
  })
  .strict();

const MessageV1Schema = z
  .object({
    order: z.number().int().nonnegative(),
    speaker: z.string().nullable(),
    text: z.string(),
    textSurface: z.string().nullable(),
  })
  .strict();

const MessageV2Schema = z
  .object({
    order: z.number().int().nonnegative(),
    speaker: z.string().nullable(),
    characterId: IdentifierSchema.nullable(),
    text: z.string(),
    textSurface: z.string().nullable(),
    playOrder: z.number().int().nonnegative().optional(),
    revealOrder: RevealOrderSchema.nullable().optional(),
    lineId: z.string().min(1).optional(),
    evidenceTier: EvidenceTierSchema.optional(),
    color: RgbSchema.nullable().optional(),
    bridgeDeclaredColor: RgbSchema.nullable().optional(),
    sourceAsset: SourceAssetSchema.optional(),
    byteOffsetInScene: z.number().int().nonnegative().nullable().optional(),
    byteLength: z.number().int().nonnegative().nullable().optional(),
    rawByteHandle: z.string().min(1).nullable().optional(),
    bodyShiftJisHex: z.string().nullable().optional(),
    bridgeRef: BridgeRefSchema.nullable().optional(),
    linkageStatus: z.enum(["bridge_linked", "runtime_only"]).optional(),
    runtimeOnlyReason: z.string().min(1).optional(),
    routeMembership: z.array(IdentifierSchema).optional(),
  })
  .strict();

const ChoiceV1Schema = z
  .object({
    optionIndex: z.number().int().nonnegative(),
    label: z.string(),
    branchEntryScene: SceneIdSchema.nullable().optional().default(null),
    branchMessages: z.array(MessageV1Schema),
  })
  .strict();

const ChoiceV2Schema = z
  .object({
    optionIndex: z.number().int().nonnegative(),
    label: z.string(),
    branchEntryScene: SceneIdSchema.nullable().optional(),
    branchTargetSceneId: SceneIdSchema.nullable(),
    choiceId: IdentifierSchema.optional(),
    choiceGroupId: IdentifierSchema.optional(),
    edgeId: IdentifierSchema.optional(),
    edgeResolution: EdgeResolutionSchema.optional(),
    unresolvedEdgeDiagnostic: z.string().nullable().optional(),
    bridgeRef: BridgeRefSchema.nullable().optional(),
    // Authoritative source coordinates for a bridge-linked (translatable)
    // choice option, so the localization join can prove the choice binding on
    // asset + byte range. A `runtime_only` choice (a displayed runtime prompt
    // option with no static BridgeUnit) carries no bridgeRef and is skipped.
    sourceAsset: SourceAssetSchema.optional(),
    byteOffsetInScene: z.number().int().nonnegative().nullable().optional(),
    byteLength: z.number().int().nonnegative().nullable().optional(),
    linkageStatus: z.enum(["bridge_linked", "runtime_only"]).optional(),
    runtimeOnlyReason: z.string().min(1).optional(),
    branchMessages: z.array(MessageV2Schema),
  })
  .strict()
  .superRefine((choice, context) => {
    if (
      choice.branchEntryScene !== undefined &&
      choice.branchEntryScene !== choice.branchTargetSceneId
    ) {
      context.addIssue({
        code: "custom",
        message: "branchEntryScene must equal branchTargetSceneId when both are present",
      });
    }
  });

const SceneV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    selectionControl: SelectionControlSchema.optional().default("none"),
    nextScene: SceneIdSchema.nullable(),
    dispatchFanoutScenes: z.array(SceneIdSchema).optional().default([]),
    messages: z.array(MessageV1Schema),
    choices: z.array(ChoiceV1Schema),
  })
  .strict();

const SceneV2Schema = z
  .object({
    sceneId: SceneIdSchema,
    selectionControl: SelectionControlSchema,
    nextScene: SceneIdSchema.nullable(),
    dispatchFanoutScenes: z.array(SceneIdSchema).optional().default([]),
    messages: z.array(MessageV2Schema),
    choices: z.array(ChoiceV2Schema),
    sceneRef: IdentifierSchema.optional(),
    units: z
      .array(
        z
          .object({
            unitId: IdentifierSchema,
            bridgeRef: BridgeRefSchema,
            surfaceKind: IdentifierSchema,
            sourceText: z.string(),
            characterId: IdentifierSchema.nullable(),
            evidenceTier: EvidenceTierSchema.nullable(),
            color: RgbSchema.nullable(),
            bridgeDeclaredColor: RgbSchema.nullable().optional(),
            sourceAsset: SourceAssetSchema,
            byteOffsetInScene: z.number().int().nonnegative(),
            byteLength: z.number().int().nonnegative(),
            rawByteHandle: z.string().min(1),
            choiceId: IdentifierSchema.nullable(),
            playOrder: z.number().int().nonnegative().nullable(),
            revealOrder: RevealOrderSchema.nullable(),
            observedLineIds: z.array(z.string().min(1)),
            routeMembership: z.array(IdentifierSchema),
          })
          .strict(),
      )
      .optional(),
    playOrder: z.number().int().nonnegative().optional(),
    revealOrder: z.number().int().nonnegative().nullable().optional(),
    observationMode: z.enum(["entry_reached", "cold_seeded"]).optional(),
    predecessors: z.array(SceneIdSchema).optional(),
    successors: z.array(SceneIdSchema).optional(),
    reachable: z.boolean().optional(),
    routeMembership: z.array(IdentifierSchema).optional(),
  })
  .strict();

const EdgeSchema = z
  .object({
    edgeId: IdentifierSchema,
    kind: z.enum(["dispatch", "choice"]),
    fromSceneId: SceneIdSchema,
    toSceneId: SceneIdSchema.nullable(),
    resolution: EdgeResolutionSchema,
    diagnostic: z.string().nullable(),
    choiceId: IdentifierSchema.nullable(),
    optionIndex: z.number().int().nonnegative().nullable(),
  })
  .strict();

const RouteSchema = z
  .object({
    routeId: IdentifierSchema,
    entrySceneId: SceneIdSchema,
    viaEdgeId: IdentifierSchema.nullable(),
    sceneIds: z.array(SceneIdSchema),
  })
  .strict();

const CoverageSchema = z
  .object({
    archiveSceneCount: z.number().int().nonnegative(),
    decodedSceneCount: z.number().int().nonnegative(),
    loadedSceneCount: z.number().int().nonnegative(),
    bridgeAssetCount: z.number().int().nonnegative(),
    emittedSceneCount: z.number().int().nonnegative(),
    archiveUnitCount: z.number().int().nonnegative(),
    emittedUnitCount: z.number().int().nonnegative(),
    observedUnitCount: z.number().int().nonnegative(),
    archiveEdgeCount: z.number().int().nonnegative(),
    emittedEdgeCount: z.number().int().nonnegative(),
    unresolvedEdgeCount: z.number().int().nonnegative(),
    truncationStatus: z.literal("complete"),
    truncated: z.literal(false),
    complete: z.literal(true),
  })
  .strict();

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function validateStructure(
  value: {
    entryScene: number;
    sceneDispatchOrder: number[];
    scenes: Array<{
      sceneId: number;
      messages: Array<{ order: number }>;
      choices: Array<{ optionIndex: number; choiceId?: string | undefined }>;
    }>;
  },
  context: z.RefinementCtx,
): void {
  const sceneIds = value.scenes.map((scene) => scene.sceneId);
  if (!unique(sceneIds)) {
    context.addIssue({ code: "custom", message: "scene IDs must be unique" });
  }
  if (!unique(value.sceneDispatchOrder)) {
    context.addIssue({ code: "custom", message: "sceneDispatchOrder must not repeat a scene" });
  }
  if (!sceneIds.includes(value.entryScene)) {
    context.addIssue({ code: "custom", message: "entryScene must be present in scenes" });
  }
  if (value.sceneDispatchOrder.some((sceneId) => !sceneIds.includes(sceneId))) {
    context.addIssue({ code: "custom", message: "sceneDispatchOrder must reference known scenes" });
  }
  for (const scene of value.scenes) {
    if (!unique(scene.messages.map((message) => message.order))) {
      context.addIssue({
        code: "custom",
        message: `scene ${scene.sceneId} repeats a message order`,
      });
    }
    if (!unique(scene.choices.map((choice) => choice.choiceId ?? `option:${choice.optionIndex}`))) {
      context.addIssue({
        code: "custom",
        message: `scene ${scene.sceneId} repeats a choice index`,
      });
    }
  }
}

export const NarrativeStructureV1Schema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_STRUCTURE_V1),
    entryScene: SceneIdSchema,
    sceneDispatchOrder: z.array(SceneIdSchema),
    scenes: z.array(SceneV1Schema),
  })
  .strict()
  .superRefine(validateStructure);

export const NarrativeStructureV2Schema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_STRUCTURE_V2),
    entryScene: SceneIdSchema,
    sceneDispatchOrder: z.array(SceneIdSchema),
    scenes: z.array(SceneV2Schema),
    bridgeId: IdentifierSchema.optional(),
    sourceBundleHash: Sha256Schema.optional(),
    coverage: CoverageSchema.optional(),
    routes: z.array(RouteSchema).optional(),
    edges: z.array(EdgeSchema).optional(),
  })
  .strict()
  .superRefine(validateStructure);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject exports a caller did not explicitly agree to consume. */
export function negotiateNarrativeStructureVersion(
  value: unknown,
  supportedVersions: readonly NarrativeStructureVersion[],
): NarrativeStructureVersion {
  if (!isRecord(value)) {
    throw new NarrativeStructureParseError("root must be an object");
  }
  if (typeof value.schemaVersion !== "string") {
    throw new NarrativeStructureVersionError("schemaVersion is required");
  }
  if (
    value.schemaVersion !== NARRATIVE_STRUCTURE_V1 &&
    value.schemaVersion !== NARRATIVE_STRUCTURE_V2
  ) {
    throw new NarrativeStructureVersionError(`unsupported export version '${value.schemaVersion}'`);
  }
  if (!supportedVersions.includes(value.schemaVersion)) {
    throw new NarrativeStructureVersionError(
      `consumer accepts [${supportedVersions.join(", ")}], export is '${value.schemaVersion}'`,
    );
  }
  return value.schemaVersion;
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.join(".") || "root";
      throw new NarrativeStructureParseError(`${path}: ${issue?.message ?? "invalid value"}`);
    }
    throw error;
  }
}

function normalizeMessage(message: {
  order: number;
  speaker: string | null;
  characterId?: string | null;
  text: string;
  textSurface: string | null;
}): NarrativeMessage {
  return {
    ...message,
    order: message.order,
    speaker: message.speaker,
    characterId: message.characterId ?? null,
    text: message.text,
    textSurface: message.textSurface,
  };
}

function normalizeScene(scene: {
  sceneId: number;
  selectionControl: SelectionControlSignal;
  nextScene: number | null;
  dispatchFanoutScenes: number[];
  messages: Array<{
    order: number;
    speaker: string | null;
    characterId?: string | null;
    text: string;
    textSurface: string | null;
  }>;
  choices: Array<{
    optionIndex: number;
    label: string;
    branchEntryScene?: number | null | undefined;
    branchTargetSceneId?: number | null;
    branchMessages: Array<{
      order: number;
      speaker: string | null;
      characterId?: string | null;
      text: string;
      textSurface: string | null;
    }>;
  }>;
}): NarrativeScene {
  const choices: NarrativeChoice[] = scene.choices.map((choice) => ({
    ...choice,
    optionIndex: choice.optionIndex,
    label: choice.label,
    branchEntryScene: choice.branchEntryScene ?? null,
    ...(choice.branchTargetSceneId !== undefined
      ? { branchTargetSceneId: choice.branchTargetSceneId }
      : {}),
    branchMessages: choice.branchMessages.map(normalizeMessage),
  }));
  return {
    ...scene,
    sceneId: scene.sceneId,
    selectionControl: scene.selectionControl,
    nextScene: scene.nextScene,
    dispatchFanoutScenes: [...scene.dispatchFanoutScenes],
    messages: scene.messages.map(normalizeMessage),
    choices,
  };
}

/** Parse one negotiated export into the normalized decode-side structure. */
export function parseNarrativeStructure(
  value: unknown,
  supportedVersions: readonly NarrativeStructureVersion[],
): NarrativeStructure {
  const version = negotiateNarrativeStructureVersion(value, supportedVersions);
  const parsed =
    version === NARRATIVE_STRUCTURE_V1
      ? parseSchema(NarrativeStructureV1Schema, value)
      : parseSchema(NarrativeStructureV2Schema, value);
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion,
    entryScene: parsed.entryScene,
    sceneDispatchOrder: [...parsed.sceneDispatchOrder],
    scenes: parsed.scenes.map(normalizeScene),
  };
}
