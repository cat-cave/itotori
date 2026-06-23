import type {
  BridgeUnit,
  LocalizationUnitV02,
  RouteContextV02,
} from "@itotori/localization-bridge-schema";

/**
 * Engine-neutral view of a bridge unit's scene/route metadata that the
 * planner reads. v0.1 BridgeUnit and v0.2 LocalizationUnitV02 are both
 * projected through {@link projectPlannerUnit} before any pass runs.
 */
export type PlannerUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceHash: string;
  occurrenceId: string;
  sourceLocale: string;
  sourceText: string;
  /** Raw speaker key from BridgeUnit.speaker or SpeakerContextV02.displayName. */
  speaker?: string | undefined;
  textSurface: string;
  surfaceKind?: string | undefined;
  policyAction?: string | undefined;
  sceneId?: string | undefined;
  sceneKey?: string | undefined;
  routeId?: string | undefined;
  routeKey?: string | undefined;
};

export function projectBridgeUnit(unit: BridgeUnit): PlannerUnit {
  return {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceHash: unit.sourceHash,
    occurrenceId: unit.occurrenceId,
    sourceLocale: unit.sourceLocale,
    sourceText: unit.sourceText,
    speaker: unit.speaker,
    textSurface: unit.textSurface,
  };
}

export function projectLocalizationUnitV02(unit: LocalizationUnitV02): PlannerUnit {
  const route: RouteContextV02 | undefined = unit.context.route;
  const speaker = projectSpeakerV02(unit.speaker);
  return {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceHash: unit.sourceHash,
    occurrenceId: unit.occurrenceId,
    sourceLocale: unit.sourceLocale,
    sourceText: unit.sourceText,
    speaker,
    textSurface: inferTextSurface(unit),
    surfaceKind: unit.surfaceKind,
    policyAction: unit.policy?.policyAction,
    sceneId: route?.sceneId ?? route?.sceneKey,
    sceneKey: route?.sceneKey,
    routeId: route?.routeId ?? route?.routeKey,
    routeKey: route?.routeKey,
  };
}

function projectSpeakerV02(speaker: LocalizationUnitV02["speaker"]): string | undefined {
  if (!speaker) {
    return undefined;
  }
  if (speaker.knowledgeState === "known") {
    return speaker.displayName;
  }
  if (speaker.knowledgeState === "reader_unknown") {
    return speaker.displayName;
  }
  if (speaker.knowledgeState === "parser_unknown") {
    return speaker.rawSpeakerText;
  }
  return undefined;
}

function inferTextSurface(unit: LocalizationUnitV02): string {
  // v0.2 splits surfaceKind into a richer taxonomy; for planner inputs we
  // collapse dialogue-adjacent kinds to "dialogue" and everything else to
  // "system" so style-rule category matching mirrors v0.1 semantics.
  const dialogueKinds = new Set(["dialogue", "monologue", "narration", "choice_prompt"]);
  if (dialogueKinds.has(unit.surfaceKind)) {
    return "dialogue";
  }
  return "system";
}

/**
 * Canonical ordering: routeId, sceneId, sourceUnitKey, occurrenceId. Stable
 * across calls and matches what extractors emit.
 */
export function canonicalOrder(units: PlannerUnit[]): PlannerUnit[] {
  return [...units].sort((a, b) => {
    const route = (a.routeId ?? "").localeCompare(b.routeId ?? "");
    if (route !== 0) {
      return route;
    }
    const scene = (a.sceneId ?? "").localeCompare(b.sceneId ?? "");
    if (scene !== 0) {
      return scene;
    }
    const key = a.sourceUnitKey.localeCompare(b.sourceUnitKey);
    if (key !== 0) {
      return key;
    }
    return a.occurrenceId.localeCompare(b.occurrenceId);
  });
}

export type SceneGroup = {
  /** Either the sceneId, "route:<routeId>", "key-prefix:<prefix>", or "ungrouped". */
  groupKey: string;
  sceneId?: string | undefined;
  routeId?: string | undefined;
  /** Set when the planner had to fall back to sourceUnitKey-prefix grouping. */
  sourceUnitKeyPrefix?: string | undefined;
  units: PlannerUnit[];
};

/**
 * Group bridge units by scene/route boundary. Breakpoints:
 *   1. sceneId change (primary)
 *   2. routeId change when no sceneId is present (secondary)
 *   3. textSurface dialogue <-> system transition (tertiary)
 * Units lacking any scene/route signal are grouped by sourceUnitKey prefix
 * (everything before the last "." in the key), which matches the
 * convention KAIFUU adapters emit for engines without explicit markers.
 */
export function groupBySceneBoundary(units: PlannerUnit[]): SceneGroup[] {
  const ordered = canonicalOrder(units);
  const groups: SceneGroup[] = [];
  let current: SceneGroup | undefined;
  let lastTextSurface: string | undefined;

  for (const unit of ordered) {
    const sceneId = unit.sceneId;
    const routeId = unit.routeId;
    const prefix = sourceUnitKeyPrefix(unit.sourceUnitKey);
    let groupKey: string;
    let group: SceneGroup;
    if (sceneId !== undefined) {
      groupKey = `scene:${sceneId}`;
      group = { groupKey, sceneId, routeId, units: [] };
    } else if (routeId !== undefined) {
      groupKey = `route:${routeId}`;
      group = { groupKey, routeId, units: [] };
    } else {
      groupKey = `key-prefix:${prefix}`;
      group = { groupKey, sourceUnitKeyPrefix: prefix, units: [] };
    }

    const surfaceChanged =
      current !== undefined &&
      lastTextSurface !== undefined &&
      lastTextSurface !== unit.textSurface;

    if (current === undefined || current.groupKey !== groupKey || surfaceChanged) {
      if (current && surfaceChanged && current.groupKey === groupKey) {
        // surface transition splits inside the same scene/route group; tag the
        // resulting two groups with a stable suffix so consumers see the break.
        current = { ...group, groupKey: `${groupKey}#surface:${unit.textSurface}` };
      } else {
        current = group;
      }
      groups.push(current);
    }
    current.units.push(unit);
    lastTextSurface = unit.textSurface;
  }

  return groups;
}

/** Everything before the last "." in the source unit key, or the whole key. */
export function sourceUnitKeyPrefix(sourceUnitKey: string): string {
  const dot = sourceUnitKey.lastIndexOf(".");
  if (dot <= 0) {
    return sourceUnitKey;
  }
  return sourceUnitKey.slice(0, dot);
}
