import { IdentifierSchema } from "../contracts/shared.js";
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
  })
  .strict();

function unique(values: readonly number[]): boolean {
  return new Set(values).size === values.length;
}

function validateStructure(
  value: {
    entryScene: number;
    sceneDispatchOrder: number[];
    scenes: Array<{
      sceneId: number;
      messages: Array<{ order: number }>;
      choices: Array<{ optionIndex: number }>;
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
    if (!unique(scene.choices.map((choice) => choice.optionIndex))) {
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
    optionIndex: choice.optionIndex,
    label: choice.label,
    branchEntryScene: choice.branchEntryScene ?? null,
    ...(choice.branchTargetSceneId !== undefined
      ? { branchTargetSceneId: choice.branchTargetSceneId }
      : {}),
    branchMessages: choice.branchMessages.map(normalizeMessage),
  }));
  return {
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
    schemaVersion: parsed.schemaVersion,
    entryScene: parsed.entryScene,
    sceneDispatchOrder: [...parsed.sceneDispatchOrder],
    scenes: parsed.scenes.map(normalizeScene),
  };
}
