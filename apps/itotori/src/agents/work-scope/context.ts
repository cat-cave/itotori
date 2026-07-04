// itotori-multi-work-context-scope-model — WORK-SCOPED context building.
//
// The structure-informed context (scene summaries + route/branch map +
// character arcs) is built PER WORK, from that work's OWN decoded structure
// (rooted at its game-select `branchEntryScene`) — NOT from the whole archive.
// Alongside it, each work inherits the shared super-scope's glossary +
// characters (with per-work overrides) as its EFFECTIVE scope. So Sweetie HD's
// base game and fandisk are two WorkScopes that SHARE a parent (same
// characters / world → shared glossary) yet each carry their own
// structurally-grounded context.

import {
  buildSliceStructuredContext,
  buildStructureContextArtifacts,
  type StructureContextArtifacts,
  type StructuredContextInjection,
} from "../structure-informed-context/index.js";
import { resolveEffectiveScope, requireWorkScope } from "./scope.js";
import { ScopeGraphError, type EffectiveScope, type ScopeGraph } from "./shapes.js";

/**
 * The context a single WORK translates under:
 *   * `artifacts` — the work's OWN structure-informed context (built from the
 *     work's decoded structure, not the archive's);
 *   * `effectiveScope` — the shared glossary + characters INHERITED by the
 *     work, with its per-work overrides applied.
 */
export type WorkScopedContext = {
  workId: string;
  archiveRef: string;
  label: string;
  artifacts: StructureContextArtifacts;
  effectiveScope: EffectiveScope;
};

/**
 * Build the WORK-SCOPED context for `workId`: reduce the work's own decoded
 * structure into the three context artifacts and resolve its effective
 * (inherited + overridden) scope. Requires the work scope to carry its
 * `structure` (its per-work `structure_export`).
 */
export function buildWorkScopedContext(graph: ScopeGraph, workId: string): WorkScopedContext {
  const work = requireWorkScope(graph, workId);
  if (work.structure === undefined) {
    throw new ScopeGraphError(
      `work ${workId} has no decoded structure: run its per-work structure_export (rooted at its branchEntryScene) before building work-scoped context`,
    );
  }
  const artifacts = buildStructureContextArtifacts(work.structure);
  const effectiveScope = resolveEffectiveScope(graph, workId);
  return {
    workId,
    archiveRef: work.archiveRef,
    label: work.label,
    artifacts,
    effectiveScope,
  };
}

/**
 * The per-slice context handed to ONE translate-stage invocation drawn from a
 * scene of a work: the work's scene/route/character injection PLUS the work's
 * effective glossary + character context. This is the seam where a line
 * arrives WORK-SCOPED — its known scene position AND its work's inherited
 * (or overridden) terminology.
 */
export type WorkScopedSliceContext = {
  workId: string;
  sceneId: number;
  structured: StructuredContextInjection;
  effectiveScope: EffectiveScope;
};

/** Build the work-scoped slice context for `sceneId` within a work. */
export function buildWorkScopedSliceContext(
  context: WorkScopedContext,
  sceneId: number,
): WorkScopedSliceContext {
  const structured = buildSliceStructuredContext(context.artifacts, sceneId);
  return {
    workId: context.workId,
    sceneId,
    structured,
    effectiveScope: context.effectiveScope,
  };
}
