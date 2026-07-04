// itotori-multi-work-context-scope-model — public surface.
//
// The CONTEXT unit is the narrative WORK, not the archive/title. A title may
// bundle N works (Sweetie HD = base game + fandisk, disambiguated by the
// decoded game-select). This module:
//   * DERIVES the works from the decoded game-select (`carveArchiveIntoWorks`),
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
