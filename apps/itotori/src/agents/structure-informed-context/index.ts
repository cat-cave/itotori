// itotori-structure-informed-context-building — public surface.
//
// Consumes the Kaifuu/Utsushi decoded narrative structure (scene-dispatch
// graph + choice/branch subsystem + speakers + per-scene message stream) and
// builds three structurally-grounded context artifacts (scene summaries,
// route/branch map, character arcs) that the translate stage injects into its
// prompt.

export * from "./shapes.js";
export {
  parseNarrativeStructure,
  buildSceneSummaries,
  buildRouteBranchMap,
  buildCharacterArcs,
  buildStructureContextArtifacts,
} from "./build.js";
export {
  buildSliceStructuredContext,
  structuredContextForScene,
  StructuredContextSceneNotFoundError,
} from "./inject.js";
