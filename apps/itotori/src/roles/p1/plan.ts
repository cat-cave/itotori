// Whole-scene vs overlapping-chunk PLANNING for the P1 localizer.
//
// The localizer realizes a COMPLETE scene. When the scene's measured source
// size fits the caller's context budget it is drafted in one whole-scene call;
// only when the measured size EXCEEDS the budget is the scene split into LARGE
// OVERLAPPING CHUNKS. In chunk mode each chunk carries a non-overlap CORE plus
// leading/trailing OVERLAP context; the cores PARTITION the scene exactly (they
// cover every unit once, in play order, and are pairwise disjoint), so only the
// non-overlap cores ever finalize and no unit can be double-finalized. The
// overlap regions are context only — they are never part of a chunk's core.
//
// Everything here is a pure, deterministic reduction of the ordered source
// skeletons. Nothing calls a model; nothing re-infers structure the decode owns.

import type { UnitFact } from "../../contracts/index.js";

/** A single source skeleton the localizer must realize, normalized from a decode
 * UnitFact. `bytes` is the measured UTF-8 size of the masking skeleton. */
export interface SkeletonUnit {
  readonly unitId: string;
  readonly sceneId: string;
  readonly playOrderIndex: number;
  readonly sourceHash: string;
  readonly sourceSkeleton: string;
  readonly protectedPlaceholders: readonly {
    readonly placeholderId: string;
    readonly kind: "control-markup" | "variable" | "ruby";
    readonly sourceText: string;
  }[];
  readonly bytes: number;
}

const PLACEHOLDER_TOKEN = /\{\{([^{}]+)\}\}/gu;

/**
 * Sanity-check that the placeholder manifest describes the skeleton: the masked
 * {{id}} tokens in the skeleton are exactly the manifest placeholder ids — one to
 * one, no repeat, no unmanifested token, no unused entry. This is what PROTECTS
 * THE BYTE-LEVEL PATCH: finalize preserves exactly these placeholders in the
 * target, so a manifest that disagrees with the skeleton would let a dropped
 * variable slip through the patch. Returns a failure detail, or null when sound.
 */
function checkPlaceholderManifest(
  sourceSkeleton: string,
  protectedPlaceholders: readonly { readonly placeholderId: string }[],
): string | null {
  const manifest = new Set<string>();
  for (const placeholder of protectedPlaceholders) {
    if (manifest.has(placeholder.placeholderId)) {
      return `declares a duplicate placeholder ${placeholder.placeholderId}`;
    }
    manifest.add(placeholder.placeholderId);
  }
  const seen = new Set<string>();
  for (const match of sourceSkeleton.matchAll(PLACEHOLDER_TOKEN)) {
    const id = match[1]!;
    if (!manifest.has(id)) return `skeleton names an unmanifested placeholder ${id}`;
    if (seen.has(id)) return `skeleton repeats placeholder ${id}`;
    seen.add(id);
  }
  if (seen.size !== manifest.size) return "a manifest placeholder is absent from the skeleton";
  return null;
}

/**
 * Sanity-check a normalized source unit. Source facts come from the trusted
 * decode snapshot, so this is not an adversarial proof — just a cheap guard that
 * the placeholder manifest genuinely describes the skeleton, so the finalize
 * placeholder-preservation check has an accurate manifest to protect the patch.
 */
function verifySourceUnit(unit: SkeletonUnit): void {
  const detail = checkPlaceholderManifest(unit.sourceSkeleton, unit.protectedPlaceholders);
  if (detail !== null) {
    throw new PlanError("malformed-source-skeleton", `unit ${unit.unitId} ${detail}`);
  }
}

export interface NormalizedScene {
  readonly sceneId: string;
  readonly units: readonly SkeletonUnit[];
}

export interface WholeSceneSegment {
  readonly mode: "whole-scene";
  readonly sceneId: string;
  /** Every unit in the scene, in play order. All finalize. */
  readonly unitIds: readonly string[];
}

export interface ChunkSegment {
  readonly mode: "overlapping-chunk";
  readonly sceneId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  /** The non-overlap core — the ONLY units this chunk finalizes. */
  readonly coreUnitIds: readonly string[];
  /** Context units (prior/next cores). Never finalized by this chunk. */
  readonly overlapUnitIds: readonly string[];
  /** Everything the model reads for this chunk, in play order (overlap + core). */
  readonly promptUnitIds: readonly string[];
}

export type LocalizationSegment = WholeSceneSegment | ChunkSegment;

export interface LocalizationPlan {
  readonly sceneId: string;
  readonly mode: "whole-scene" | "overlapping-chunks";
  readonly segments: readonly LocalizationSegment[];
  readonly measuredBytes: number;
  readonly budgetBytes: number;
}

export interface PlanOptions {
  /** The measured context budget, in UTF-8 skeleton bytes. */
  readonly budgetBytes: number;
  /** Units of leading/trailing overlap context per interior chunk boundary. */
  readonly overlapUnits: number;
}

export type PlanFailureCode =
  | "empty-scene"
  | "mixed-scene"
  | "duplicate-unit"
  | "invalid-budget"
  | "malformed-source-skeleton"
  | "unit-exceeds-context-budget";

/** A loud, typed refusal from the planner. A genuine gap (a single unit larger
 * than the whole context budget) is surfaced, never silently chunked away. */
export class PlanError extends Error {
  constructor(
    readonly code: PlanFailureCode,
    detail: string,
  ) {
    super(`p1 plan ${code}: ${detail}`);
    this.name = "PlanError";
  }
}

/** Normalize a scene's decode unit facts into ordered source skeletons. Fails
 * loud on an empty scene, a cross-scene mix, or a duplicate unit id. */
export function normalizeScene(units: readonly UnitFact[]): NormalizedScene {
  if (units.length === 0) throw new PlanError("empty-scene", "a scene needs at least one unit");
  const sceneId = String(units[0]!.value.sceneId);
  const seen = new Set<string>();
  const normalized: SkeletonUnit[] = [];
  for (const fact of units) {
    const value = fact.value;
    if (String(value.sceneId) !== sceneId) {
      throw new PlanError("mixed-scene", `unit ${value.unitId} is not in scene ${sceneId}`);
    }
    if (seen.has(value.unitId)) {
      throw new PlanError("duplicate-unit", `unit ${value.unitId} appears twice`);
    }
    seen.add(value.unitId);
    const unit: SkeletonUnit = {
      unitId: value.unitId,
      sceneId,
      playOrderIndex: value.playOrderIndex,
      sourceHash: value.sourceHash,
      sourceSkeleton: value.sourceSkeleton,
      protectedPlaceholders: value.protectedPlaceholders.map((placeholder) => ({
        placeholderId: placeholder.placeholderId,
        kind: placeholder.kind,
        sourceText: placeholder.sourceText,
      })),
      bytes: Buffer.byteLength(value.sourceSkeleton, "utf8"),
    };
    // Cheap sanity guard so the manifest that protects the patch is accurate.
    verifySourceUnit(unit);
    normalized.push(unit);
  }
  normalized.sort((a, b) => a.playOrderIndex - b.playOrderIndex || (a.unitId < b.unitId ? -1 : 1));
  return { sceneId, units: normalized };
}

/** Plan the localization of one complete scene: whole-scene when the measured
 * source fits the budget, else overlapping chunks whose cores partition the
 * scene exactly. */
export function planSceneLocalization(
  scene: NormalizedScene,
  options: PlanOptions,
): LocalizationPlan {
  if (!Number.isInteger(options.budgetBytes) || options.budgetBytes < 1) {
    throw new PlanError("invalid-budget", "budgetBytes must be a positive integer");
  }
  if (!Number.isInteger(options.overlapUnits) || options.overlapUnits < 0) {
    throw new PlanError("invalid-budget", "overlapUnits must be a non-negative integer");
  }
  const units = scene.units;
  const measuredBytes = units.reduce((sum, unit) => sum + unit.bytes, 0);
  const maxUnitBytes = units.reduce((max, unit) => Math.max(max, unit.bytes), 0);
  if (maxUnitBytes > options.budgetBytes) {
    throw new PlanError(
      "unit-exceeds-context-budget",
      `a single unit measures ${maxUnitBytes} bytes, above the ${options.budgetBytes}-byte budget`,
    );
  }

  if (measuredBytes <= options.budgetBytes) {
    return {
      sceneId: scene.sceneId,
      mode: "whole-scene",
      segments: [
        { mode: "whole-scene", sceneId: scene.sceneId, unitIds: units.map((unit) => unit.unitId) },
      ],
      measuredBytes,
      budgetBytes: options.budgetBytes,
    };
  }

  const cores = partitionCores(units, options);
  const segments: ChunkSegment[] = cores.map((core, chunkIndex) =>
    buildChunkSegment(scene.sceneId, units, core, chunkIndex, cores.length, options),
  );
  return {
    sceneId: scene.sceneId,
    mode: "overlapping-chunks",
    segments,
    measuredBytes,
    budgetBytes: options.budgetBytes,
  };
}

/** Greedily partition the ordered units into consecutive core windows that each
 * fit the core budget. Every window holds at least one unit, so the cores cover
 * every unit exactly once, in order. */
function partitionCores(
  units: readonly SkeletonUnit[],
  options: PlanOptions,
): readonly (readonly [number, number])[] {
  // Reserve headroom for the widest possible overlap so a chunk's prompt fits
  // the full budget; never shrink the core budget below the widest single unit.
  const widths = units.map((unit) => unit.bytes).sort((a, b) => b - a);
  const reserve = widths.slice(0, 2 * options.overlapUnits).reduce((sum, width) => sum + width, 0);
  const maxUnitBytes = widths[0] ?? 0;
  const coreBudget = Math.max(maxUnitBytes, options.budgetBytes - reserve);

  const cores: (readonly [number, number])[] = [];
  let index = 0;
  while (index < units.length) {
    const start = index;
    let bytes = 0;
    while (index < units.length) {
      const next = units[index]!.bytes;
      if (index > start && bytes + next > coreBudget) break;
      bytes += next;
      index += 1;
    }
    cores.push([start, index]);
  }
  return cores;
}

/** Build one chunk segment: its core, its trimmed overlap context, and the
 * ordered prompt window. Overlap is trimmed farthest-first until the prompt fits
 * the budget; the core alone always fits, so trimming terminates. */
function buildChunkSegment(
  sceneId: string,
  units: readonly SkeletonUnit[],
  core: readonly [number, number],
  chunkIndex: number,
  chunkCount: number,
  options: PlanOptions,
): ChunkSegment {
  const [start, end] = core;
  const coreUnits = units.slice(start, end);
  const coreBytes = coreUnits.reduce((sum, unit) => sum + unit.bytes, 0);

  const leading = units.slice(Math.max(0, start - options.overlapUnits), start);
  const trailing = units.slice(end, Math.min(units.length, end + options.overlapUnits));
  // Distance from the core boundary — the farthest overlap unit is dropped first.
  const context = [
    ...leading.map((unit, offset) => ({ unit, distance: leading.length - offset })),
    ...trailing.map((unit, offset) => ({ unit, distance: offset + 1 })),
  ];
  let overlapBytes = context.reduce((sum, entry) => sum + entry.unit.bytes, 0);
  const dropped = new Set<string>();
  const byFarthest = [...context].sort((a, b) => b.distance - a.distance);
  for (const entry of byFarthest) {
    if (coreBytes + overlapBytes <= options.budgetBytes) break;
    dropped.add(entry.unit.unitId);
    overlapBytes -= entry.unit.bytes;
  }
  const overlapIds = new Set(
    context.filter((entry) => !dropped.has(entry.unit.unitId)).map((entry) => entry.unit.unitId),
  );
  const coreIds = new Set(coreUnits.map((unit) => unit.unitId));

  // The prompt window is the contiguous slice [start-overlap, end+overlap),
  // filtered to the kept overlap plus the core — preserving play order.
  const promptUnits = units
    .slice(
      Math.max(0, start - options.overlapUnits),
      Math.min(units.length, end + options.overlapUnits),
    )
    .filter((unit) => coreIds.has(unit.unitId) || overlapIds.has(unit.unitId));

  return {
    mode: "overlapping-chunk",
    sceneId,
    chunkIndex,
    chunkCount,
    coreUnitIds: coreUnits.map((unit) => unit.unitId),
    overlapUnitIds: [...leading, ...trailing]
      .filter((unit) => overlapIds.has(unit.unitId))
      .map((unit) => unit.unitId),
    promptUnitIds: promptUnits.map((unit) => unit.unitId),
  };
}
