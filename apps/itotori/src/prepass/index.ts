// deterministic fact-snapshot pre-pass — public surface.
export { buildFactSnapshot, serializeFactSnapshot } from "./build.js";
export { contextSnapshotFactsFrom, factMaterializationRef } from "./context-facts.js";
export { indexNarrativePositions, type NarrativePosition } from "./positions.js";
export {
  FACT_SNAPSHOT_SCHEMA_VERSION,
  FactSnapshotError,
  type CharacterOccurrenceFact,
  type ChoiceLabelOccurrenceFact,
  type FactLinkKind,
  type FactRouteScope,
  type FactSnapshot,
  type FactSnapshotSource,
  type GlossaryConflictFact,
  type OrderedUnitFact,
  type PlayRevealFact,
  type ProtectedSkeletonFact,
  type ProtectedSpanFact,
  type RouteEdgeFact,
  type RouteTopologyFact,
  type SceneFactCard,
  type TerminologyOccurrenceFact,
} from "./types.js";
