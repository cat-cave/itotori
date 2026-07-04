// itotori-structure-informed-context-building — injection.
//
// Turns the structurally-grounded artifacts into the `StructuredContextInjection`
// the translate stage renders into its prompt for a slice drawn from one
// scene. The block carries: (1) that scene's summary, (2) its position in the
// route/branch map (predecessors / successors / choice-gating), and (3) the
// character arcs of the speakers present in the slice.
//
// This is the seam that CONSUMES the decoded structure at translate time — a
// line no longer arrives context-free; it arrives with its known scene, its
// known branch position, and its speaker's known arc.

import type {
  CharacterArc,
  NarrativeStructure,
  RouteBranchMap,
  SceneSummaryArtifact,
  StructureContextArtifacts,
  StructuredContextInjection,
} from "./shapes.js";

export class StructuredContextSceneNotFoundError extends Error {
  constructor(public readonly sceneId: number) {
    super(`structure-informed context: scene ${sceneId} not present in the decoded structure`);
    this.name = "StructuredContextSceneNotFoundError";
  }
}

/** Render the route-map position of `sceneId`: predecessors, successors, gating. */
function renderRoutePosition(map: RouteBranchMap, sceneId: number): string {
  const predecessors = map.edges
    .filter((e) => e.kind === "dispatch" && e.to === String(sceneId))
    .map((e) => e.fromScene);
  const successor = map.edges.find((e) => e.kind === "dispatch" && e.fromScene === sceneId)?.to;
  const choiceEdges = map.edges.filter((e) => e.kind === "choice" && e.fromScene === sceneId);

  const parts: string[] = [];
  const dispatchIndex = map.dispatchOrder.indexOf(sceneId);
  if (dispatchIndex >= 0) {
    parts.push(
      `position ${dispatchIndex + 1} of ${map.dispatchOrder.length} in the dispatch order ` +
        `[${map.dispatchOrder.join(" -> ")}]`,
    );
  }
  parts.push(
    predecessors.length > 0
      ? `reached from scene ${predecessors.join(", ")}`
      : `entry scene (no in-graph predecessor)`,
  );
  parts.push(successor !== undefined ? `dispatches to scene ${successor}` : `no onward dispatch`);
  if (choiceEdges.length > 0) {
    const branchDesc = choiceEdges
      .map(
        (e) =>
          `option ${e.choiceIndex} ("${e.choiceLabel}") -> ${e.branchMessageCount ?? 0}-message branch`,
      )
      .join("; ");
    parts.push(`branches on a player choice: ${branchDesc}`);
  }
  return `Scene ${sceneId} route position: ${parts.join("; ")}.`;
}

/** Character arcs for the speakers present in a scene, in first-appearance order. */
function renderCharacterArcs(
  summary: SceneSummaryArtifact,
  arcs: ReadonlyArray<CharacterArc>,
): string {
  if (summary.speakers.length === 0) {
    return "No named speakers in this scene (narration only).";
  }
  const byName = new Map(arcs.map((a) => [a.speaker, a] as const));
  const lines = summary.speakers.map((speaker) => {
    const arc = byName.get(speaker);
    if (arc === undefined) {
      return `- ${speaker}: (no cross-scene arc recorded)`;
    }
    return `- ${arc.summaryText}`;
  });
  return `Speaker arcs in this scene:\n${lines.join("\n")}`;
}

/**
 * Build the `StructuredContextInjection` for a translate-stage slice drawn
 * from `sceneId`. Pure reduction of the pre-built artifacts — deterministic.
 */
export function buildSliceStructuredContext(
  artifacts: StructureContextArtifacts,
  sceneId: number,
): StructuredContextInjection {
  const summary = artifacts.sceneSummaries.find((s) => s.sceneId === sceneId);
  if (summary === undefined) {
    throw new StructuredContextSceneNotFoundError(sceneId);
  }
  const sceneSummaryText = summary.summaryText;
  const routePositionText = renderRoutePosition(artifacts.routeBranchMap, sceneId);
  const characterArcsText = renderCharacterArcs(summary, artifacts.characterArcs);

  const artifactRefs: string[] = [summary.artifactRef, artifacts.routeBranchMap.artifactRef];
  const byName = new Map(artifacts.characterArcs.map((a) => [a.speaker, a] as const));
  for (const speaker of summary.speakers) {
    const arc = byName.get(speaker);
    if (arc !== undefined) {
      artifactRefs.push(arc.artifactRef);
    }
  }

  return {
    sceneId,
    sceneSummaryText,
    routePositionText,
    characterArcsText,
    artifactRefs,
  };
}

/**
 * Convenience: build all artifacts from a decoded structure and produce the
 * slice injection for `sceneId` in one call.
 */
export function structuredContextForScene(
  structure: NarrativeStructure,
  artifacts: StructureContextArtifacts,
  sceneId: number,
): StructuredContextInjection {
  void structure;
  return buildSliceStructuredContext(artifacts, sceneId);
}
