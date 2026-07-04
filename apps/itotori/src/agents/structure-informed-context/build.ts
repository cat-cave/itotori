// itotori-structure-informed-context-building — deterministic builders.
//
// CONSUMES the decoded `NarrativeStructure` (from the Kaifuu/Utsushi decode)
// and reduces it into the three context artifacts. Every function here is a
// PURE, deterministic reduction of the decode — no LLM call, no re-inference
// of structure from the prose. The scene-graph, choice-map, speakers, and
// message stream are READ from the structure, never guessed.

import {
  NarrativeStructureParseError,
  type CharacterArc,
  type NarrativeMessage,
  type NarrativeScene,
  type NarrativeStructure,
  type RouteBranchEdge,
  type RouteBranchMap,
  type SceneSummaryArtifact,
  type StructureContextArtifacts,
} from "./shapes.js";

/**
 * Validate + narrow an untyped JSON value (as parsed from the Rust
 * exporter's stdout) into a `NarrativeStructure`. Throws
 * `NarrativeStructureParseError` on any shape violation — never a silent
 * coerce, so a decode drift surfaces loudly rather than producing a
 * degenerate artifact.
 */
export function parseNarrativeStructure(value: unknown): NarrativeStructure {
  if (typeof value !== "object" || value === null) {
    throw new NarrativeStructureParseError("root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "utsushi.narrative-structure.v1") {
    throw new NarrativeStructureParseError(
      `unexpected schemaVersion ${String(record.schemaVersion)}`,
    );
  }
  if (typeof record.entryScene !== "number") {
    throw new NarrativeStructureParseError("entryScene must be a number");
  }
  if (
    !Array.isArray(record.sceneDispatchOrder) ||
    !record.sceneDispatchOrder.every((s) => typeof s === "number")
  ) {
    throw new NarrativeStructureParseError("sceneDispatchOrder must be a number[]");
  }
  if (!Array.isArray(record.scenes)) {
    throw new NarrativeStructureParseError("scenes must be an array");
  }
  const scenes = record.scenes.map((scene, index) => parseScene(scene, index));
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: record.entryScene,
    sceneDispatchOrder: record.sceneDispatchOrder as number[],
    scenes,
  };
}

function parseScene(value: unknown, index: number): NarrativeScene {
  if (typeof value !== "object" || value === null) {
    throw new NarrativeStructureParseError(`scenes[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sceneId !== "number") {
    throw new NarrativeStructureParseError(`scenes[${index}].sceneId must be a number`);
  }
  if (record.nextScene !== null && typeof record.nextScene !== "number") {
    throw new NarrativeStructureParseError(`scenes[${index}].nextScene must be a number or null`);
  }
  if (!Array.isArray(record.messages)) {
    throw new NarrativeStructureParseError(`scenes[${index}].messages must be an array`);
  }
  if (!Array.isArray(record.choices)) {
    throw new NarrativeStructureParseError(`scenes[${index}].choices must be an array`);
  }
  // `selectionControl` is optional for backward compatibility with
  // pre-enrichment exporter JSON (absent → "none"); the enriched
  // `structure_export.rs` always emits it.
  if (
    record.selectionControl !== undefined &&
    record.selectionControl !== "button-object" &&
    record.selectionControl !== "text-window" &&
    record.selectionControl !== "none"
  ) {
    throw new NarrativeStructureParseError(
      `scenes[${index}].selectionControl must be "button-object" | "text-window" | "none"`,
    );
  }
  const messages = record.messages.map((m, i) =>
    parseMessage(m, `scenes[${index}].messages[${i}]`),
  );
  const choices = record.choices.map((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new NarrativeStructureParseError(`scenes[${index}].choices[${i}] must be an object`);
    }
    const cr = c as Record<string, unknown>;
    if (typeof cr.optionIndex !== "number") {
      throw new NarrativeStructureParseError(
        `scenes[${index}].choices[${i}].optionIndex must be a number`,
      );
    }
    if (typeof cr.label !== "string") {
      throw new NarrativeStructureParseError(
        `scenes[${index}].choices[${i}].label must be a string`,
      );
    }
    if (!Array.isArray(cr.branchMessages)) {
      throw new NarrativeStructureParseError(
        `scenes[${index}].choices[${i}].branchMessages must be an array`,
      );
    }
    // `branchEntryScene` is optional for backward compatibility with
    // pre-enrichment exporter JSON: absent → null; present must be number|null.
    if (
      cr.branchEntryScene !== undefined &&
      cr.branchEntryScene !== null &&
      typeof cr.branchEntryScene !== "number"
    ) {
      throw new NarrativeStructureParseError(
        `scenes[${index}].choices[${i}].branchEntryScene must be a number or null`,
      );
    }
    return {
      optionIndex: cr.optionIndex,
      label: cr.label,
      branchEntryScene: (cr.branchEntryScene as number | null | undefined) ?? null,
      branchMessages: cr.branchMessages.map((m, j) =>
        parseMessage(m, `scenes[${index}].choices[${i}].branchMessages[${j}]`),
      ),
    };
  });
  return {
    sceneId: record.sceneId,
    selectionControl:
      (record.selectionControl as "button-object" | "text-window" | "none" | undefined) ?? "none",
    nextScene: (record.nextScene as number | null) ?? null,
    messages,
    choices,
  };
}

function parseMessage(value: unknown, path: string): NarrativeMessage {
  if (typeof value !== "object" || value === null) {
    throw new NarrativeStructureParseError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.order !== "number") {
    throw new NarrativeStructureParseError(`${path}.order must be a number`);
  }
  if (record.speaker !== null && typeof record.speaker !== "string") {
    throw new NarrativeStructureParseError(`${path}.speaker must be a string or null`);
  }
  if (typeof record.text !== "string") {
    throw new NarrativeStructureParseError(`${path}.text must be a string`);
  }
  if (record.textSurface !== null && typeof record.textSurface !== "string") {
    throw new NarrativeStructureParseError(`${path}.textSurface must be a string or null`);
  }
  return {
    order: record.order,
    speaker: (record.speaker as string | null) ?? null,
    text: record.text,
    textSurface: (record.textSurface as string | null) ?? null,
  };
}

/** Distinct speakers in a message list, in first-appearance (play) order. */
function distinctSpeakers(messages: ReadonlyArray<NarrativeMessage>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const message of messages) {
    if (message.speaker !== null && !seen.has(message.speaker)) {
      seen.add(message.speaker);
      order.push(message.speaker);
    }
  }
  return order;
}

/**
 * (a) Per-SCENE summaries — from the message stream. Deterministic reduction:
 * speaker presence, message count, opening speaker, choice-gating, dispatch
 * successor. No prose is copied into the summaryText (it names counts +
 * speaker labels only), so the artifact is safe to cite without leaking the
 * script.
 */
export function buildSceneSummaries(structure: NarrativeStructure): SceneSummaryArtifact[] {
  return structure.scenes.map((scene) => {
    const speakers = distinctSpeakers(scene.messages);
    const openingSpeaker = scene.messages.find((m) => m.speaker !== null)?.speaker ?? null;
    const hasChoices = scene.choices.length > 0;
    const speakerPhrase =
      speakers.length === 0 ? "narration only" : `speakers ${speakers.join(", ")}`;
    const choicePhrase = hasChoices ? `; branches on a ${scene.choices.length}-option choice` : "";
    const nextPhrase = scene.nextScene !== null ? `; dispatches to scene ${scene.nextScene}` : "";
    const summaryText =
      `Scene ${scene.sceneId}: ${scene.messages.length} play-order messages, ` +
      `${speakerPhrase}${choicePhrase}${nextPhrase}.`;
    return {
      artifactRef: `scene-summary:${scene.sceneId}`,
      sceneId: scene.sceneId,
      messageCount: scene.messages.length,
      speakers,
      openingSpeaker,
      hasChoices,
      choiceCount: scene.choices.length,
      nextScene: scene.nextScene,
      summaryText,
    };
  });
}

/**
 * (b) Route/branch MAP — from the dispatch + choice graph. A `dispatch` edge
 * per real cross-scene `nextScene`; a `choice` edge per option naming its
 * branch node (`scene#choice:idx`) so a translator can see a line sits behind
 * choice K and how long that branch runs.
 */
export function buildRouteBranchMap(structure: NarrativeStructure): RouteBranchMap {
  const edges: RouteBranchEdge[] = [];
  for (const scene of structure.scenes) {
    if (scene.nextScene !== null) {
      edges.push({
        fromScene: scene.sceneId,
        to: String(scene.nextScene),
        kind: "dispatch",
      });
    }
    for (const choice of scene.choices) {
      edges.push({
        fromScene: scene.sceneId,
        to: `${scene.sceneId}#choice:${choice.optionIndex}`,
        kind: "choice",
        choiceIndex: choice.optionIndex,
        choiceLabel: choice.label,
        branchMessageCount: choice.branchMessages.length,
      });
    }
  }
  return {
    artifactRef: "route-branch-map",
    entryScene: structure.entryScene,
    dispatchOrder: [...structure.sceneDispatchOrder],
    edges,
  };
}

/**
 * (c) CHARACTER-ARC tracking — speaker presence + line counts across scenes,
 * in dispatch order. Reduces the message stream per speaker; nothing is
 * inferred about personality — only WHERE and HOW MUCH each speaker speaks.
 */
export function buildCharacterArcs(structure: NarrativeStructure): CharacterArc[] {
  // speaker -> sceneId -> count. Preserve first-appearance order of speakers.
  const speakerOrder: string[] = [];
  const bySpeaker = new Map<string, Map<number, number>>();
  // Scenes in dispatch order so arcs read in play order.
  const sceneById = new Map<number, NarrativeScene>();
  for (const scene of structure.scenes) {
    sceneById.set(scene.sceneId, scene);
  }
  const orderedSceneIds =
    structure.sceneDispatchOrder.length > 0
      ? structure.sceneDispatchOrder.filter((id) => sceneById.has(id))
      : structure.scenes.map((s) => s.sceneId);

  for (const sceneId of orderedSceneIds) {
    const scene = sceneById.get(sceneId);
    if (scene === undefined) {
      continue;
    }
    for (const message of scene.messages) {
      if (message.speaker === null) {
        continue;
      }
      let perScene = bySpeaker.get(message.speaker);
      if (perScene === undefined) {
        perScene = new Map<number, number>();
        bySpeaker.set(message.speaker, perScene);
        speakerOrder.push(message.speaker);
      }
      perScene.set(sceneId, (perScene.get(sceneId) ?? 0) + 1);
    }
  }

  return speakerOrder.map((speaker) => {
    const perScene = bySpeaker.get(speaker) ?? new Map<number, number>();
    const scenesPresent = orderedSceneIds.filter((id) => perScene.has(id));
    const linesByScene: Record<string, number> = {};
    let totalLines = 0;
    for (const sceneId of scenesPresent) {
      const count = perScene.get(sceneId) ?? 0;
      linesByScene[String(sceneId)] = count;
      totalLines += count;
    }
    const firstScene = scenesPresent[0] ?? -1;
    const lastScene = scenesPresent[scenesPresent.length - 1] ?? -1;
    const sceneBreakdown = scenesPresent
      .map((id) => `scene ${id}: ${linesByScene[String(id)]} lines`)
      .join(", ");
    const summaryText =
      `${speaker} speaks ${totalLines} lines across scenes ` +
      `${scenesPresent.join(", ")} (${sceneBreakdown}).`;
    return {
      artifactRef: `character-arc:${speaker}`,
      speaker,
      scenesPresent,
      totalLines,
      linesByScene,
      firstScene,
      lastScene,
      summaryText,
    };
  });
}

/** Build all three artifacts from one decoded structure. */
export function buildStructureContextArtifacts(
  structure: NarrativeStructure,
): StructureContextArtifacts {
  return {
    sceneSummaries: buildSceneSummaries(structure),
    routeBranchMap: buildRouteBranchMap(structure),
    characterArcs: buildCharacterArcs(structure),
  };
}
