// immutable fact snapshot — the deterministic pre-pass output.
//
// A content-hashed materialization of every fact the LLM layer is allowed to
// read, derived ENTIRELY from an authoritative decode (NarrativeStructure) plus
// the Bridge v0.2 bundle (BridgeBundleV02). Nothing here is inferred by a
// model: speaker/color identity, protected skeletons, patch/runtime refs, and
// source hashes are CITED verbatim from the bridge; ordering, topology,
// reachability, and occurrence counts are computed mechanically from the decode.
// Repeated builds over the same bytes are byte-identical (see
// {@link FactSnapshot.snapshotId}) and dispatch zero model calls.

import type {
  ByteRangeV02,
  PatchRefV02,
  PreserveModeV02,
  RuntimeExpectationV02,
  SpanKindV02,
  SpeakerContextV02,
  SurfaceKindV02,
} from "@itotori/localization-bridge-schema";

export const FACT_SNAPSHOT_SCHEMA_VERSION = "itotori.fact-snapshot.v1" as const;

/** Whether a materialized unit is a narrated/spoken line or a choice option. */
export type FactLinkKind = "line" | "choice";

/** Route scope a fact applies under, mirroring the ContextSnapshot snapshot
 * fact scope so materialized facts commit into it without re-derivation. */
export type FactRouteScope =
  | { kind: "global" }
  | { kind: "route"; routeId: string }
  | { kind: "route-set"; routeIds: readonly string[] };

/** One protected span, copied verbatim from the bridge unit (never re-parsed
 * from prose): its authoritative kind, preserve mode, raw bytes, and range. */
export type ProtectedSpanFact = {
  spanKind: SpanKindV02;
  preserveMode: PreserveModeV02;
  raw: string;
  startByte: number;
  endByte: number;
};

/** The deterministic protected skeleton of a unit: its ordered protected spans
 * (masking template) plus the unit's committed source hash. Built from the
 * bridge unit's decoded spans, so the model never sees a re-parsed skeleton. */
export type ProtectedSkeletonFact = {
  sourceHash: string;
  spans: readonly ProtectedSpanFact[];
};

/** Play/reveal coordinates carried verbatim from the decode for one unit. */
export type PlayRevealFact = {
  playOrderIndex: number;
  revealSceneOrder: number | null;
  revealItemOrder: number | null;
};

/** One ordered translatable unit. Speaker/color/patch/runtime are CITED from
 * the bridge; everything else is a mechanical decode fact. */
export type OrderedUnitFact = {
  factId: string;
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: string;
  linkKind: FactLinkKind;
  surfaceKind: SurfaceKindV02;
  sourceHash: string;
  byteRange: ByteRangeV02 | null;
  routeScope: FactRouteScope;
  playReveal: PlayRevealFact;
  /** Verbatim Bridge speaker identity (+ text color): cited, never
   * recomputed. `null` when the unit carries no speaker context. */
  speaker: SpeakerContextV02 | null;
  protectedSkeleton: ProtectedSkeletonFact;
  patchRef: PatchRefV02;
  runtimeExpectation: RuntimeExpectationV02;
};

/** A per-scene fact card: decode counts + reachability, never model prose. */
export type SceneFactCard = {
  factId: string;
  sceneId: string;
  playOrderIndex: number | null;
  revealOrder: number | null;
  messageCount: number;
  choiceCount: number;
  unitCount: number;
  characterIds: readonly string[];
  dispatchTargetSceneIds: readonly string[];
  choiceTargetSceneIds: readonly string[];
  reachable: boolean;
};

/** One scene-to-scene edge of the decoded route/choice topology. */
export type RouteEdgeFact = {
  fromSceneId: string;
  toSceneId: string;
  kind: "dispatch" | "choice";
  choiceIndex: number | null;
};

/** Exact route/choice topology plus reachability from the entry scene. */
export type RouteTopologyFact = {
  entryScene: string;
  sceneDispatchOrder: readonly string[];
  edges: readonly RouteEdgeFact[];
  reachableSceneIds: readonly string[];
  unreachableSceneIds: readonly string[];
  reachableUnitKeys: readonly string[];
};

/** Character occurrence/count fact, keyed by canonical decode character id. */
export type CharacterOccurrenceFact = {
  factId: string;
  characterId: string;
  totalLines: number;
  firstSceneId: string;
  lastSceneId: string;
  sceneIds: readonly string[];
  linesByScene: ReadonlyArray<{ sceneId: string; lineCount: number }>;
};

/** A terminology/alias occurrence: a glossary term's byte-derived occurrences
 * across unit source texts (mechanical substring count, not attribution). */
export type TerminologyOccurrenceFact = {
  factId: string;
  termKey: string;
  policyAction: string;
  aliases: readonly string[];
  occurrenceCount: number;
  occurrenceUnitKeys: readonly string[];
};

/** A choice-label occurrence roll-up (every choice_label unit in stable order). */
export type ChoiceLabelOccurrenceFact = {
  totalCount: number;
  unitKeys: readonly string[];
};

/** A deterministic glossary conflict: two policy records disagree on the ruling
 * for one term key, or one source form maps to two distinct term keys. */
export type GlossaryConflictFact = {
  factId: string;
  kind: "policy_action_conflict" | "source_form_collision";
  termKey: string;
  detail: string;
};

/** Immutable source-identity anchor for the whole materialization. */
export type FactSnapshotSource = {
  bridgeId: string;
  sourceBundleHash: string;
  entryScene: string;
  structureSchemaVersion: string;
};

/** The materialized, content-hashed fact set. `snapshotId` === `contentHash`;
 * two builds over identical decode+bridge inputs produce identical bytes. */
export type FactSnapshot = {
  schemaVersion: typeof FACT_SNAPSHOT_SCHEMA_VERSION;
  source: FactSnapshotSource;
  orderedUnits: readonly OrderedUnitFact[];
  scenes: readonly SceneFactCard[];
  routeTopology: RouteTopologyFact;
  characters: readonly CharacterOccurrenceFact[];
  terminology: readonly TerminologyOccurrenceFact[];
  choiceLabels: ChoiceLabelOccurrenceFact;
  glossaryConflicts: readonly GlossaryConflictFact[];
  contentHash: `sha256:${string}`;
  snapshotId: `sha256:${string}`;
};

/** A materialization refused because its inputs are not internally consistent
 * (the join already fails loud on hash/range/dangling drift; this covers the
 * few invariants the pre-pass itself owns, e.g. a missing play-order anchor). */
export class FactSnapshotError extends Error {
  constructor(detail: string) {
    super(`fact snapshot invalid: ${detail}`);
    this.name = "FactSnapshotError";
  }
}
