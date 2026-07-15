// itotori-multiwork-archive-manifest — the operator-supplied WORK-MANIFEST.
//
// MANY VN archives bundle MULTIPLE works (a base game + a fandisk / append
// disc) behind ONE game-select. The decode ALONE cannot always root the N
// works: the real Sweetie HD first-screen game-select (scene 2) is a
// `select_objbtn` TITLE MENU whose `goto_case($store)` branches dispatch to
// menu/config scenes + a store-relative New-Game routine. That routine now
// decodes cleanly, but the base-vs-fandisk split still depends on runtime menu
// state, so the carve reports `game-select-unresolved-options` (see `carve.ts`).
//
// This module is the GENERAL, GAME-AGNOSTIC operator escape hatch: a TYPED
// WORK-MANIFEST the operator supplies to root N works within a multi-work
// archive FROM ENTRY-POINT METADATA, plus a RESOLVER that validates every
// declared entry-point AGAINST the decoded archive (the entry-point scene
// exists and is REACHABLE from the archive entry) and rejects a manifest whose
// entry-point does not validate. It is the seam `carve.ts` defers to ("rooting
// them needs upstream/operator context — a per-work entry-scene list").
//
// Game-agnostic: the manifest carries entry-point METADATA (scene / offset /
// segment) — never game-specific bytes — and the validator reduces only the
// decoded `NarrativeStructure` (scene-presence + dispatch reachability).

import type { NarrativeStructure } from "../../structure/index.js";
import type { WorkCarve } from "./shapes.js";

/** Schema version of the operator work-manifest (`itotori.work-manifest.v1`). */
export const WORK_MANIFEST_SCHEMA_VERSION = "itotori.work-manifest.v1" as const;

/**
 * The entry-point metadata that roots ONE work within a multi-work archive.
 *
 * The primary key is `scene` — the RealLive scene id the work's narrative
 * subtree is rooted at (the operator analogue of a carved option's decoded
 * `branchEntryScene`). `offset` and `segment` are OPTIONAL finer-grained
 * pins (a RealLive gosub/label, a segment index inside a packed scene) the
 * validator carries through verbatim; they do not affect scene-level
 * reachability but let an operator disambiguate two works that share a
 * dispatch scene (e.g. a shared prologue scene that branches per-work).
 */
export type WorkEntryPoint = {
  /** The scene id that roots this work's subtree (must exist in the archive). */
  scene: number;
  /**
   * Optional finer pin: a byte / instruction offset within the scene's
   * decode (e.g. a gosub label). Carried through verbatim; not validated
   * against the decode (the decode does not expose per-offset reachability).
   */
  offset?: number;
  /**
   * Optional finer pin: a named segment / label within the scene (e.g. a
   * `goto_case` arm). Carried through verbatim; not validated against the
   * decode.
   */
  segment?: string;
};

/** One work declared in the operator work-manifest. */
export type ManifestWork = {
  /**
   * Stable operator-assigned work id (e.g. `"sweetie-hd#base"`,
   * `"sweetie-hd#fandisk"`). Must be unique within the manifest. This is the
   * key the rest of the work-scope model (`WorkScope.workId`,
   * `ScopeGraph.titleToWorks`) consumes.
   */
  workId: string;
  /** Optional human label (base game / fandisk / append name). */
  name?: string;
  /** The entry-point metadata rooting this work in the archive. */
  entryPoint: WorkEntryPoint;
};

/** The typed operator work-manifest. */
export type WorkManifest = {
  schemaVersion: typeof WORK_MANIFEST_SCHEMA_VERSION;
  /**
   * Archive / title ref this manifest roots works within (packaging metadata;
   * matches the `archiveRef` the carve / scope-graph use).
   */
  archiveRef: string;
  /** The N works (≥1). */
  works: ManifestWork[];
};

/**
 * The validation outcome for ONE work's entry-point against the decoded
 * archive. `reachable: true` means the entry-point scene is PRESENT in the
 * decode AND reachable from the archive entry scene via the dispatch graph
 * (nextScene / choice.branchEntryScene edges); `reachable: false` carries a
 * diagnostic `reason`. The evidence block records the structural signals the
 * validator reduced (never game bytes).
 */
export type WorkManifestEntryValidation = {
  workId: string;
  entryPoint: WorkEntryPoint;
  /** Whether the entry-point scene is present + reachable in the decode. */
  reachable: boolean;
  /**
   * `present` — the entry-point scene id exists in the decoded archive.
   * `reachable-from-entry` — present AND reachable from the archive entry
   * scene through the dispatch graph.
   * `missing` — the entry-point scene id is not in the decode.
   * `unreachable` — present in the decode but NOT reachable from the archive
   * entry scene (an orphan scene — a dangling manifest entry-point).
   */
  status: "reachable-from-entry" | "present" | "missing" | "unreachable";
  /**
   * The dispatch-chain length from the archive entry scene to the entry-point
   * scene (0 when the entry-point IS the entry scene). Undefined when not
   * reachable.
   */
  dispatchDepth?: number;
  /** Diagnostic reason when `reachable: false`. */
  reason?: string;
};

/**
 * ONE resolved work: the manifest declaration + its validation against the
 * archive + the resolved root scene id (the work's subtree root).
 */
export type ResolvedManifestWork = {
  workId: string;
  name?: string;
  entryPoint: WorkEntryPoint;
  /** The decoded scene id this work is rooted at (=== entryPoint.scene). */
  rootScene: number;
  validation: WorkManifestEntryValidation;
};

/** The full resolved work-manifest: N resolved works + a derivation block. */
export type ResolvedWorkManifest = {
  archiveRef: string;
  /** The N works, in manifest declaration order. */
  works: ResolvedManifestWork[];
  derivation: {
    /** How the works were rooted (`operator-manifest`). */
    rootedBy: "operator-manifest";
    /** Whether EVERY declared work's entry-point validated. */
    allEntryPointsReachable: boolean;
    /**
     * Honest boundary note: records the validation summary (how many of the
     * declared entry-points were reachable vs. rejected).
     */
    notes: string;
  };
};

/** Error raised when a work-manifest is malformed OR fails validation. */
export class WorkManifestError extends Error {
  constructor(detail: string) {
    super(`work-manifest: ${detail}`);
    this.name = "WorkManifestError";
  }
}

// ---------------------------------------------------------------------------
// Parse / validate the manifest SHAPE (conservative; mirrors parseNarrative).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertWorkManifestShape(value: unknown): asserts value is WorkManifest {
  if (!isObject(value)) {
    throw new WorkManifestError("root must be an object");
  }
  if (value.schemaVersion !== WORK_MANIFEST_SCHEMA_VERSION) {
    throw new WorkManifestError(
      `schemaVersion must be ${WORK_MANIFEST_SCHEMA_VERSION} (got ${String(value.schemaVersion)})`,
    );
  }
  if (typeof value.archiveRef !== "string" || value.archiveRef.length === 0) {
    throw new WorkManifestError("archiveRef must be a non-empty string");
  }
  if (!Array.isArray(value.works) || value.works.length === 0) {
    throw new WorkManifestError("works must be a non-empty array");
  }
  const seenIds = new Set<string>();
  const seenRoots = new Set<number>();
  for (const [index, raw] of value.works.entries()) {
    if (!isObject(raw)) {
      throw new WorkManifestError(`works[${index}] must be an object`);
    }
    if (typeof raw.workId !== "string" || raw.workId.length === 0) {
      throw new WorkManifestError(`works[${index}].workId must be a non-empty string`);
    }
    if (seenIds.has(raw.workId)) {
      throw new WorkManifestError(`works[${index}].workId duplicates ${raw.workId}`);
    }
    seenIds.add(raw.workId);
    if (raw.name !== undefined && typeof raw.name !== "string") {
      throw new WorkManifestError(`works[${index}].name must be a string when present`);
    }
    const ep = raw.entryPoint;
    if (!isObject(ep)) {
      throw new WorkManifestError(`works[${index}].entryPoint must be an object`);
    }
    if (typeof ep.scene !== "number" || !Number.isInteger(ep.scene)) {
      throw new WorkManifestError(`works[${index}].entryPoint.scene must be an integer scene id`);
    }
    // DISTINCT entry-point scenes are required for the works to root DISJOINT
    // subtrees (the same invariant `carveArchiveIntoWorks` enforces on the
    // decoded game-select option branches). An operator may still pin two
    // works at the same scene via `segment`/`offset`; that finer disambiguation
    // is carried verbatim and is out of scope for scene-level validation, so
    // we only reject a SAME-scene collision when no finer pin is present.
    const hasFinerPin =
      (typeof ep.offset === "number" && Number.isInteger(ep.offset)) ||
      (typeof ep.segment === "string" && ep.segment.length > 0);
    if (seenRoots.has(ep.scene) && !hasFinerPin) {
      throw new WorkManifestError(
        `works[${index}].entryPoint.scene ${ep.scene} duplicates an earlier work's root scene ` +
          `(supply a distinct offset/segment to disambiguate two works at one scene)`,
      );
    }
    seenRoots.add(ep.scene);
    if (ep.offset !== undefined) {
      if (typeof ep.offset !== "number" || !Number.isInteger(ep.offset) || ep.offset < 0) {
        throw new WorkManifestError(
          `works[${index}].entryPoint.offset must be a non-negative integer when present`,
        );
      }
    }
    if (ep.segment !== undefined) {
      if (typeof ep.segment !== "string" || ep.segment.length === 0) {
        throw new WorkManifestError(
          `works[${index}].entryPoint.segment must be a non-empty string when present`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reachability over the decoded dispatch graph.
// ---------------------------------------------------------------------------

type DispatchGraph = {
  /** scene id → set of scene ids reachable by ONE dispatch hop. */
  edges: Map<number, Set<number>>;
  entryScene: number;
  sceneIds: Set<number>;
  /** scene id → shortest dispatch depth from the entry scene (BFS). */
  depthFromEntry: Map<number, number>;
};

/**
 * Build the scene-dispatch graph from the decoded structure + a BFS depth map
 * from the archive entry scene. Edges are the union of `scene.nextScene`, raw
 * `dispatchFanoutScenes`, and every `choice.branchEntryScene` (the same
 * signals the carve reads). Self-loops are dropped; the entry scene has depth
 * 0.
 */
function buildDispatchGraph(structure: NarrativeStructure): DispatchGraph {
  const edges = new Map<number, Set<number>>();
  const sceneIds = new Set<number>();
  for (const scene of structure.scenes) {
    sceneIds.add(scene.sceneId);
    const out = edges.get(scene.sceneId) ?? new Set<number>();
    if (scene.nextScene !== null && scene.nextScene !== scene.sceneId) {
      out.add(scene.nextScene);
    }
    for (const target of scene.dispatchFanoutScenes ?? []) {
      if (target !== scene.sceneId) {
        out.add(target);
      }
    }
    for (const choice of scene.choices) {
      if (choice.branchEntryScene !== null && choice.branchEntryScene !== scene.sceneId) {
        out.add(choice.branchEntryScene);
      }
    }
    edges.set(scene.sceneId, out);
  }
  // Ensure every declared scene has an entry (even leaves).
  for (const id of sceneIds) {
    if (!edges.has(id)) edges.set(id, new Set<number>());
  }

  const depthFromEntry = new Map<number, number>();
  const entry = structure.entryScene;
  if (sceneIds.has(entry)) {
    depthFromEntry.set(entry, 0);
    const queue: number[] = [entry];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = depthFromEntry.get(current)!;
      for (const next of edges.get(current) ?? []) {
        if (!depthFromEntry.has(next)) {
          depthFromEntry.set(next, currentDepth + 1);
          queue.push(next);
        }
      }
    }
  }
  return { edges, entryScene: entry, sceneIds, depthFromEntry };
}

function validateEntryPoint(
  workId: string,
  entryPoint: WorkEntryPoint,
  graph: DispatchGraph,
): WorkManifestEntryValidation {
  const scene = entryPoint.scene;
  if (!graph.sceneIds.has(scene)) {
    return {
      workId,
      entryPoint,
      reachable: false,
      status: "missing",
      reason: `entry-point scene ${scene} is not present in the decoded archive`,
    };
  }
  const depth = graph.depthFromEntry.get(scene);
  if (depth === undefined) {
    return {
      workId,
      entryPoint,
      reachable: false,
      status: "unreachable",
      reason: `entry-point scene ${scene} is present but NOT reachable from the archive entry scene ${graph.entryScene}`,
    };
  }
  return {
    workId,
    entryPoint,
    reachable: true,
    status: depth === 0 ? "present" : "reachable-from-entry",
    dispatchDepth: depth,
  };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export type ResolveWorkManifestOptions = {
  /**
   * When `true` (the default), the resolver REJECTS — throws
   * `WorkManifestError` — if ANY declared entry-point does not validate
   * (missing or unreachable). When `false`, it returns a `ResolvedWorkManifest`
   * whose `works[]` carry `validation.reachable: false` for the rejected
   * entries and `derivation.allEntryPointsReachable: false` — useful for
   * surfacing partial-validation diagnostics without a thrown error.
   */
  rejectOnValidationFailure?: boolean;
};

/**
 * Parse + validate the SHAPE of an untyped work-manifest value (as parsed from
 * operator JSON). Throws `WorkManifestError` on any shape violation — never a
 * silent coerce.
 */
export function parseWorkManifest(value: unknown): WorkManifest {
  assertWorkManifestShape(value);
  return value;
}

/**
 * Resolve + VALIDATE an operator work-manifest against the decoded archive:
 * for every declared work, root it at its entry-point scene and validate that
 * scene is PRESENT in the decode AND REACHABLE from the archive entry scene
 * through the dispatch graph. Rejects (throws `WorkManifestError` by default,
 * or returns a partial-resolution result when
 * `rejectOnValidationFailure: false`) any manifest whose entry-point does not
 * validate.
 *
 * Game-agnostic: the validator reduces ONLY the decoded `NarrativeStructure`
 * (scene presence + dispatch reachability); it never reads game-specific bytes.
 */
export function resolveWorkManifest(
  manifest: WorkManifest,
  structure: NarrativeStructure,
  options: ResolveWorkManifestOptions = {},
): ResolvedWorkManifest {
  const { rejectOnValidationFailure = true } = options;
  // `manifest.archiveRef` is packaging metadata; the decoded
  // `NarrativeStructure` carries no archiveRef to cross-check against, so it
  // is preserved verbatim into the resolved manifest (below) and not validated
  // here. The structural contract is the entry-point scene reachability.
  const graph = buildDispatchGraph(structure);
  const resolvedWorks: ResolvedManifestWork[] = manifest.works.map((work) => {
    const validation = validateEntryPoint(work.workId, work.entryPoint, graph);
    const resolved: ResolvedManifestWork = {
      workId: work.workId,
      entryPoint: work.entryPoint,
      rootScene: work.entryPoint.scene,
      validation,
    };
    if (work.name !== undefined) {
      resolved.name = work.name;
    }
    return resolved;
  });

  const failed = resolvedWorks.filter((w) => !w.validation.reachable);
  const allReachable = failed.length === 0;

  if (rejectOnValidationFailure && !allReachable) {
    const detail = failed
      .map((w) => `${w.workId} (scene ${w.entryPoint.scene}): ${w.validation.reason}`)
      .join("; ");
    throw new WorkManifestError(
      `entry-point validation failed for archive ${manifest.archiveRef} — ${detail}`,
    );
  }

  const reachable = resolvedWorks.length - failed.length;
  const notes = allReachable
    ? `All ${String(resolvedWorks.length)} declared work entry-point(s) are present and reachable from the archive entry scene ${graph.entryScene}.`
    : `${String(reachable)}/${String(resolvedWorks.length)} declared work entry-point(s) reachable from the archive entry scene ${graph.entryScene}; ${String(failed.length)} rejected (${failed
        .map((w) => `${w.workId}:${w.validation.status}`)
        .join(", ")}).`;

  return {
    archiveRef: manifest.archiveRef,
    works: resolvedWorks,
    derivation: {
      rootedBy: "operator-manifest",
      allEntryPointsReachable: allReachable,
      notes,
    },
  };
}

/**
 * Resolve + validate an operator work-manifest AND bridge it into the
 * work-scope carve model: returns a `WorkCarve`-shaped result whose `works`
 * are the manifest-declared works (with `optionIndex` taken from manifest
 * declaration order), so the existing scope-graph builder can consume an
 * operator-manifest rooting identically to a decoded game-select rooting.
 *
 * Throws `WorkManifestError` (via `resolveWorkManifest`) when any entry-point
 * does not validate.
 */
export function resolveWorkManifestToCarve(
  manifest: WorkManifest,
  structure: NarrativeStructure,
  options: ResolveWorkManifestOptions = {},
): {
  resolved: ResolvedWorkManifest;
  /**
   * A `WorkCarve`-compatible view of the manifest rooting, so the scope-graph
   * builder can consume the operator manifest identically to a decoded carve.
   * `derivation.signal` is `operator-manifest` (the operator escape hatch the
   * carve defers to when the decoded game-select is unresolved).
   */
  carve: WorkCarve;
} {
  const resolved = resolveWorkManifest(manifest, structure, options);
  const sceneById = new Map(structure.scenes.map((s) => [s.sceneId, s] as const));
  const carveWorks = resolved.works.map((w, index) => {
    const scene = sceneById.get(w.rootScene);
    const speakers: string[] = [];
    if (scene !== undefined) {
      const seen = new Set<string>();
      for (const m of scene.messages) {
        if (m.speaker !== null && !seen.has(m.speaker)) {
          seen.add(m.speaker);
          speakers.push(m.speaker);
        }
      }
    }
    return {
      workId: w.workId,
      optionIndex: index,
      optionLabel: w.name ?? "",
      branchEntryScene: w.rootScene,
      branchMessageCount: scene?.messages.length ?? 0,
      branchSpeakers: speakers,
    };
  });
  const labelsPresent = carveWorks.every((w) => w.optionLabel.length > 0);
  return {
    resolved,
    carve: {
      archiveRef: resolved.archiveRef,
      works: carveWorks,
      derivation: {
        signal: "operator-manifest",
        gameSelectScene: null,
        gameSelectSelectedBy: "none",
        selectionControl: "none",
        namingSignal: labelsPresent ? "provided" : "unknown",
        notes:
          `Operator work-manifest rooted ${String(carveWorks.length)} work(s) ` +
          `from entry-point metadata (validated against the decoded archive). ` +
          resolved.derivation.notes,
      },
    },
  };
}
