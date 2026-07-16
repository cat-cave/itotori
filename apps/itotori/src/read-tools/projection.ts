// Project immutable snapshot facts into the strict contract fact shapes.
//
// Decode facts (units, route nodes/edges, character occurrences) are projected
// from the fact snapshot + its bound bridge units; nothing is re-inferred. The
// reveal-safe speaker projection is STRUCTURAL: a concealed / reader-unknown
// speaker maps to the `reader-unknown` truth, which carries no character id, so
// identity beyond the reveal horizon cannot leak through the type. Each fact's
// `snapshotId` is the trust-root id and its `hash` content-addresses its value.

import { llmSha256, type LlmJsonValue } from "@itotori/db";
import type { LocalizationUnitV02, SpeakerContextV02 } from "@itotori/localization-bridge-schema";

import {
  FACT_SCHEMA_VERSION,
  type CharacterOccurrenceFact,
  type GlossaryFactValue,
  type RouteEdgeFact,
  type RouteNodeFact,
  type RouteScope,
  type SpeakerTruth,
  type UnitFact,
} from "../contracts/index.js";
import type {
  CharacterOccurrenceFact as SnapshotCharacterFact,
  FactRouteScope,
  OrderedUnitFact,
  RouteTopologyFact,
  SceneFactCard,
} from "../prepass/index.js";

import { ReadToolError } from "./access.js";

type Visibility = {
  routeScope: RouteScope;
  fromPlayOrder: number;
  throughPlayOrder: number | null;
};

function routeScopeOf(scope: FactRouteScope): RouteScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

function hashValue(value: LlmJsonValue): `sha256:${string}` {
  return llmSha256(value);
}

const SPAN_KIND_TO_PLACEHOLDER = {
  control_markup: "control-markup",
  variable_placeholder: "variable",
  ruby_annotation: "ruby",
} as const;

/** Build the masking skeleton + ordered placeholders from a unit's protected
 * spans, slicing the source text by UTF-8 byte offsets (spans are unit-relative). */
function skeletonOf(unit: OrderedUnitFact, sourceText: string) {
  const buffer = Buffer.from(sourceText, "utf8");
  const spans = [...unit.protectedSkeleton.spans].sort(
    (a, b) => a.startByte - b.startByte || a.endByte - b.endByte,
  );
  let skeleton = "";
  let cursor = 0;
  const placeholders = spans.map((span, index) => {
    skeleton += buffer.subarray(cursor, span.startByte).toString("utf8");
    const placeholderId = `ph:${index}`;
    skeleton += `{{${placeholderId}}}`;
    cursor = span.endByte;
    return {
      placeholderId,
      kind: SPAN_KIND_TO_PLACEHOLDER[span.spanKind],
      sourceText: span.raw,
    };
  });
  skeleton += buffer.subarray(cursor).toString("utf8");
  return { skeleton, placeholders };
}

/** Reveal-safe speaker: a concealed / reader-unknown speaker never exposes the
 * canonical character id (the `reader-unknown` truth has no such field). */
function projectSpeaker(speaker: SpeakerContextV02 | null): SpeakerTruth | null {
  if (speaker === null || speaker.knowledgeState === "not_applicable") return null;
  if (speaker.knowledgeState === "parser_unknown") {
    return {
      status: "parser-unknown",
      rawName: speaker.rawSpeakerText ?? null,
      revealSafeLabel: speaker.rawSpeakerText ?? "unknown speaker",
      color: null,
    };
  }
  if (speaker.knowledgeState === "reader_unknown" || speaker.revealState === "concealed") {
    const label = "readerLabel" in speaker ? speaker.readerLabel : speaker.displayName;
    return {
      status: "reader-unknown",
      rawName: label,
      revealSafeLabel: label,
      color: speaker.textColor ? colorOf(speaker.textColor) : null,
    };
  }
  if (!speaker.textColor) {
    throw new ReadToolError("snapshot-integrity", "a known speaker is missing its text color");
  }
  return {
    status: "known",
    rawName: speaker.displayName,
    resolvedDisplayName: speaker.displayName,
    revealSafeLabel: speaker.displayName,
    canonicalCharacterId: speaker.canonicalNameRef ?? speaker.speakerId,
    color: colorOf(speaker.textColor),
  };
}

function colorOf(tuple: readonly [number, number, number]) {
  return { red: tuple[0], green: tuple[1], blue: tuple[2] };
}

/** Project one ordered unit fact into the strict contract UnitFact. */
export function projectUnitFact(
  unit: OrderedUnitFact,
  bundleUnit: LocalizationUnitV02,
  snapshotId: string,
): UnitFact {
  if (unit.byteRange === null) {
    throw new ReadToolError("snapshot-integrity", `unit ${unit.factId} has no byte range`);
  }
  if (bundleUnit.sourceText.length === 0) {
    throw new ReadToolError("snapshot-integrity", `unit ${unit.factId} has no source surface`);
  }
  const { skeleton, placeholders } = skeletonOf(unit, bundleUnit.sourceText);
  const scope = routeScopeOf(unit.routeScope);
  const value = {
    kind: "unit" as const,
    unitId: unit.factId,
    bridgeUnitId: unit.bridgeUnitId,
    sceneId: String(unit.sceneId),
    playOrderIndex: unit.playReveal.playOrderIndex,
    sourceHash: unit.sourceHash,
    sourceSurface: bundleUnit.sourceText,
    sourceSkeleton: skeleton,
    surfaceKind: unit.surfaceKind,
    speaker: projectSpeaker(unit.speaker),
    choiceContext: null,
    protectedPlaceholders: placeholders,
    sourceAssetRef: bundleUnit.sourceAssetRef.assetId,
    byteOffset: unit.byteRange.startByte,
    byteLength: unit.byteRange.endByte - unit.byteRange.startByte,
    rawByteHandle: unit.bridgeUnitId,
    routeScopes: [scope],
  };
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    factId: unit.factId,
    snapshotId,
    hash: hashValue(value),
    visibility: unitVisibility(unit, scope),
    source: "decode",
    value,
  };
}

function unitVisibility(unit: OrderedUnitFact, scope: RouteScope): Visibility {
  return {
    routeScope: scope,
    fromPlayOrder: unit.playReveal.playOrderIndex,
    throughPlayOrder: null,
  };
}

/** Node id for a scene in the route graph. */
export function routeNodeId(sceneId: number): string {
  return `route-node:${sceneId}`;
}

/** Project one scene card into a route-graph node fact. */
export function projectRouteNodeFact(
  scene: SceneFactCard,
  topology: RouteTopologyFact,
  snapshotId: string,
): RouteNodeFact {
  const predecessors = topology.edges
    .filter((edge) => edge.toSceneId === scene.sceneId)
    .map((edge) => routeNodeId(edge.fromSceneId));
  const successors = topology.edges
    .filter((edge) => edge.fromSceneId === scene.sceneId)
    .map((edge) => routeNodeId(edge.toSceneId));
  const value = {
    kind: "route-node" as const,
    nodeId: routeNodeId(scene.sceneId),
    nodeKind: "scene" as const,
    sceneId: String(scene.sceneId),
    playOrderIndex: scene.playOrderIndex ?? 0,
    predecessors: dedupeSorted(predecessors),
    successors: dedupeSorted(successors),
    reachable: scene.reachable,
    routeScopes: [{ kind: "global" as const }],
  };
  return decodeFact(value, `scene:${scene.sceneId}`, snapshotId, scene.playOrderIndex ?? 0);
}

/** Project one topology edge into a route-graph edge fact. */
export function projectRouteEdgeFact(
  edge: RouteTopologyFact["edges"][number],
  snapshotId: string,
): RouteEdgeFact {
  const edgeId = `route-edge:${edge.fromSceneId}:${edge.toSceneId}:${edge.kind}:${edge.choiceIndex ?? "d"}`;
  const value = {
    kind: "route-edge" as const,
    edgeId,
    fromNodeId: routeNodeId(edge.fromSceneId),
    toNodeId: routeNodeId(edge.toSceneId),
    edgeKind: edge.kind,
    optionIndex: edge.choiceIndex,
    evidenceId: edgeId,
    completeness: "complete" as const,
  };
  return decodeFact(value, edgeId, snapshotId, 0);
}

function decodeFact<V extends LlmJsonValue>(
  value: V,
  factId: string,
  snapshotId: string,
  fromPlayOrder: number,
) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    factId,
    snapshotId,
    hash: hashValue(value),
    visibility: {
      routeScope: { kind: "global" as const },
      fromPlayOrder,
      throughPlayOrder: null,
    },
    source: "decode" as const,
    value,
  };
}

export interface CharacterProfile {
  decodedLabel: string;
  revealStatus: "revealed" | "reader-unknown";
  unitIds: readonly string[];
}

/** Project a snapshot character occurrence + its bound profile into the strict
 * CharacterOccurrenceFact. */
export function projectCharacterOccurrenceFact(
  fact: SnapshotCharacterFact,
  profile: CharacterProfile,
  snapshotId: string,
): CharacterOccurrenceFact {
  const value = {
    kind: "character-occurrence" as const,
    characterId: fact.characterId,
    decodedLabel: profile.decodedLabel,
    revealStatus: profile.revealStatus,
    sceneIds: fact.sceneIds.map(String),
    unitIds: [...profile.unitIds],
    linesByScene: fact.linesByScene.map((line) => ({
      sceneId: String(line.sceneId),
      lineCount: line.lineCount,
    })),
    totalLines: fact.totalLines,
    firstSceneId: String(fact.firstSceneId),
    lastSceneId: String(fact.lastSceneId),
  };
  return decodeFact(value, fact.factId, snapshotId, 0);
}

function dedupeSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Content-address hash for an injected glossary/reference value bound to the
 * snapshot (used to seal its `hash` field before it enters a result). */
export function sealGlossaryValue(value: GlossaryFactValue): `sha256:${string}` {
  return hashValue(value);
}
