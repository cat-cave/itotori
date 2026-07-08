// itotori-multi-work-context-scope-model — public surface.
//
// The CONTEXT unit is the narrative WORK, not the archive/title. A title may
// bundle N works (Sweetie HD = base game + fandisk, disambiguated by the
// decoded game-select). This module:
//   * DERIVES the works from the decoded game-select (`carveArchiveIntoWorks`),
//   * resolves an OPERATOR work-manifest when the decode cannot root the works
//     (a `game-select-unresolved-options` archive — `resolveWorkManifest` /
//     `resolveWorkManifestToCarve`),
//   * models a scope GRAPH — a shared super-scope (brand/collection glossary +
//     characters) that per-WorkScopes INHERIT and may OVERRIDE
//     (`buildScopeGraph` / `resolveEffectiveScope`),
//   * makes structure-informed context building WORK-SCOPED
//     (`buildWorkScopedContext` / `buildWorkScopedSliceContext`).

export * from "./shapes.js";
export { carveArchiveIntoWorks, type CarveOptions } from "./carve.js";
export {
  buildScopeGraph,
  resolveEffectiveScope,
  requireWorkScope,
  type BuildScopeGraphInput,
  type WorkScopeSeed,
} from "./scope.js";
export {
  buildWorkScopedContext,
  buildWorkScopedSliceContext,
  type WorkScopedContext,
  type WorkScopedSliceContext,
} from "./context.js";
export {
  WORK_MANIFEST_SCHEMA_VERSION,
  parseWorkManifest,
  resolveWorkManifest,
  resolveWorkManifestToCarve,
  WorkManifestError,
  type ManifestWork,
  type ResolveWorkManifestOptions,
  type ResolvedManifestWork,
  type ResolvedWorkManifest,
  type WorkEntryPoint,
  type WorkManifest,
  type WorkManifestEntryValidation,
} from "./manifest.js";
