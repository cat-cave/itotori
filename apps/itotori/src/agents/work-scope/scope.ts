// itotori-multi-work-context-scope-model — the scope graph + inheritance.
//
// Builds the scope GRAPH (a shared parent + per-work scopes) from a `WorkCarve`
// and resolves a work's EFFECTIVE scope by inheriting the shared glossary +
// characters and applying the work's own OVERRIDES. Inheritance is the default
// (cross-work consistency); override is per-work (a fandisk may diverge).

import type { NarrativeStructure } from "../structure-informed-context/index.js";
import {
  ScopeGraphError,
  type CarvedWork,
  type EffectiveScope,
  type ScopeCharacter,
  type ScopeGlossaryEntry,
  type ScopeGraph,
  type SharedScope,
  type WorkCarve,
  type WorkScope,
} from "./shapes.js";

export type WorkScopeSeed = {
  /** Per-work glossary additions/overrides (override shared by `sourceForm`). */
  glossaryOverrides?: ScopeGlossaryEntry[];
  /** Per-work character additions/overrides (override shared by `characterId`). */
  characterOverrides?: ScopeCharacter[];
  /** The work's OWN decoded structure (rooted at its `branchEntryScene`). */
  structure?: NarrativeStructure;
  /** Optional explicit label (else derived from the carve). */
  label?: string;
};

export type BuildScopeGraphInput = {
  /** The shared super-scope (brand/collection) all works inherit. */
  shared: SharedScope;
  /** The archive→works carve the graph realises. */
  carve: WorkCarve;
  /** Per-work seed data keyed by `workId` (overrides + per-work structure). */
  perWork?: Record<string, WorkScopeSeed>;
};

function workLabel(work: CarvedWork, seedLabel: string | undefined): string {
  if (seedLabel !== undefined && seedLabel.length > 0) {
    return seedLabel;
  }
  if (work.optionLabel.length > 0) {
    return work.optionLabel;
  }
  return `work ${work.optionIndex}`;
}

/**
 * Build the scope graph: one shared parent + a WorkScope per carved work, each
 * with the inheritance edge to the shared scope and the title→works metadata
 * map. Deterministic — works stay in carve (option) order.
 */
export function buildScopeGraph(input: BuildScopeGraphInput): ScopeGraph {
  const { shared, carve } = input;
  const perWork = input.perWork ?? {};

  if (carve.works.length === 0) {
    throw new ScopeGraphError(`carve for archive ${carve.archiveRef} has no works`);
  }

  const works: WorkScope[] = carve.works.map((work) => {
    const seed = perWork[work.workId] ?? {};
    return {
      scopeId: `scope:${work.workId}`,
      kind: "work",
      workId: work.workId,
      parentScopeId: shared.scopeId,
      archiveRef: carve.archiveRef,
      optionIndex: work.optionIndex,
      label: workLabel(work, seed.label),
      glossaryOverrides: seed.glossaryOverrides ?? [],
      characterOverrides: seed.characterOverrides ?? [],
      structure: seed.structure,
    };
  });

  const titleToWorks: Record<string, string[]> = {
    [carve.archiveRef]: works.map((w) => w.workId),
  };

  return { shared, works, titleToWorks };
}

/** Look up a work scope by id, or throw. */
export function requireWorkScope(graph: ScopeGraph, workId: string): WorkScope {
  const scope = graph.works.find((w) => w.workId === workId);
  if (scope === undefined) {
    throw new ScopeGraphError(`no work scope ${workId} in the graph`);
  }
  return scope;
}

/**
 * Resolve the EFFECTIVE scope a work translates under: the shared glossary +
 * characters MERGED with the work's overrides. Override wins (by `sourceForm`
 * for glossary, `characterId` for characters); every member records whether it
 * was `inherited` from the shared scope or supplied as a work `override`.
 *
 * Deterministic ordering: shared members first (in shared order), then
 * work-only additions (in override order); an override that REPLACES a shared
 * member keeps the shared member's position but takes the work's value +
 * `override` provenance.
 */
export function resolveEffectiveScope(graph: ScopeGraph, workId: string): EffectiveScope {
  const work = requireWorkScope(graph, workId);
  const { shared } = graph;

  // --- glossary (key: sourceForm) ---
  const glossaryOverrideByForm = new Map(
    work.glossaryOverrides.map((e) => [e.sourceForm, e] as const),
  );
  const glossary: EffectiveScope["glossary"] = [];
  const emittedForms = new Set<string>();
  for (const base of shared.glossary) {
    const override = glossaryOverrideByForm.get(base.sourceForm);
    if (override !== undefined) {
      glossary.push({ ...override, provenance: "override" });
    } else {
      glossary.push({ ...base, provenance: "inherited" });
    }
    emittedForms.add(base.sourceForm);
  }
  for (const override of work.glossaryOverrides) {
    if (!emittedForms.has(override.sourceForm)) {
      glossary.push({ ...override, provenance: "override" });
      emittedForms.add(override.sourceForm);
    }
  }

  // --- characters (key: characterId) ---
  const charOverrideById = new Map(work.characterOverrides.map((c) => [c.characterId, c] as const));
  const characters: EffectiveScope["characters"] = [];
  const emittedIds = new Set<string>();
  for (const base of shared.characters) {
    const override = charOverrideById.get(base.characterId);
    if (override !== undefined) {
      characters.push({ ...override, provenance: "override" });
    } else {
      characters.push({ ...base, provenance: "inherited" });
    }
    emittedIds.add(base.characterId);
  }
  for (const override of work.characterOverrides) {
    if (!emittedIds.has(override.characterId)) {
      characters.push({ ...override, provenance: "override" });
      emittedIds.add(override.characterId);
    }
  }

  return { workId, glossary, characters };
}
