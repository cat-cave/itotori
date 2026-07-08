// itotori-bmk-cockpit-read-model — the BENCHMARK COCKPIT read-model.
//
// The benchmark facility (`apps/itotori/src/benchmark-stages/benchmark-facility.ts`)
// computes the contestants + the §8 panel↔human anchor + the §10 actionable
// improvement backlog for a single run. This module composes the durable
// cockpit READ-MODEL the dashboard / /api surface serializes: the SCORED
// contestants (mapping the benchmark vocabulary `official | self |
// self_nocontext | fan | mtl` onto the facility's five
// `ContestantKind` slots) + the §8 panel↔human anchor (the external
// calibration the §10 framing calls the human anchor) + a §10.2 numeric
// CONFIDENCE derived from the anchor's overall agreement + the §10
// actionable backlog (the ranked failure modes the §10 framing calls the
// cockpit's PRIMARY output — a diagnostic instrument telling us where to
// improve, NOT a leaderboard).
//
// The benchmark facility owns NO scoring of its own; it composes the §4
// blind judge panel + §3 deterministic metric suite + §8 panel↔human
// anchor + §10 actionable backlog stages. The read-model parses the
// persisted body verbatim (the same body the facility assembled) and
// projects it through the cockpit vocabulary for the wire.
//
// GAME-AGNOSTIC: the read-model carries only generic `unitId/label/sourceText`
// + facility-shaped identifiers (`contestantKind` ∈ {official_localization,
// itotori_context_on, itotori_context_off, fan_edited_mtl, raw_mtl_baseline}).
// NO title / engine / work-specific field anywhere.

import type {
  AuthorizationActor,
  BenchmarkRunRecord,
  ItotoriBenchmarkRunRepositoryPort,
} from "@itotori/db";
import type {
  BenchmarkImprovementBacklog,
  ContestantKind,
  ContestantRankEntry,
  ContestantRanking,
  PanelHumanCalibrationReport,
} from "./benchmark-stages/index.js";
import { REAL_RUN_BENCHMARK_SCHEMA_VERSION } from "./benchmark-stages/index.js";

export const BMK_COCKPIT_SCHEMA_VERSION = "itotori.bmk-cockpit.v0.1" as const;

/**
 * The benchmark COCKPIT contestant vocabulary — the §10 framing's named
 * roles. Each maps to exactly one of the facility's five
 * `ContestantKind`s. The mapping is FROZEN (no string keys at the wire that
 * drift from the facility).
 */
export type BmkCockpitContestantRole =
  | "official"
  | "self"
  | "self_nocontext"
  | "fan"
  | "mtl";

export const BMK_COCKPIT_CONTESTANT_ROLES = [
  "official",
  "self",
  "self_nocontext",
  "fan",
  "mtl",
] as const satisfies readonly BmkCockpitContestantRole[];

/** A single scored contestant on the cockpit — projected from the facility. */
export type BmkCockpitContestant = {
  /** The §10 framing's named role. */
  role: BmkCockpitContestantRole;
  /** The facility's `ContestantKind` this role projects onto (provenance). */
  contestantKind: ContestantKind;
  /**
   * Aggregate 0..1 standing (the §9 facility ranking primitive). `null` only
   * when the run scored zero items for this contestant.
   */
  aggregateScore: number | null;
  /** 0-based rank; 0 = best. Ties broken by contestant id (stable). */
  rank: number | null;
  /** Mean §4 judge score (0..4, higher better) across retained items. */
  judgeMean: number | null;
  /** Mean §3 deterministic metric score (0..1, higher better). */
  metricMean: number | null;
  /** The fraction of source units this contestant had a score for (0..1). */
  coverage: number | null;
};

/** The composed human anchor surfaced on the cockpit (§8). */
export type BmkCockpitHumanAnchor = {
  raters: string[];
  judgeIds: string[];
  /** Per-dimension calibration samples (only dimensions compared). */
  byDimensionCount: number;
  /** Count of dimensions where the panel diverges from humans past threshold. */
  divergentDimensionCount: number;
  /** Overall agreement rollup. `null` whenever itemsCompared is null. */
  overall: {
    itemsCompared: number;
    normalizedAgreement: number | null;
    signedMeanDiff: number | null;
    pearson: number | null;
  };
};

/**
 * The composed confidence value the cockpit surfaces. The §10 framing gives the
 * benchmark ONE signal outside the LLM pipeline loop (§8 = the human anchor);
 * the confidence on the cockpit is the panel↔human correlation / agreement
 * rollup, normalized 0..1, with `null` whenever the anchor lacks enough
 * signal to be honest (a degenerate Pearson is null, never a fabricated 0).
 */
export type BmkCockpitConfidence = {
  /** 0..1 (or null). The overall Pearson correlation panel↔human, when ≥2 items. */
  pearson: number | null;
  /** 0..1 (or null). The overall `1 − mean|Δ|/4` agreement rollup. */
  normalizedAgreement: number | null;
  /**
   * The headline confidence surfaced on the cockpit, normalized 0..1:
   * prefer Pearson when available (a stronger signal); fall back to
   * `normalizedAgreement`; `null` when neither is honest (defensive: a
   * fabricated zero would let a divergent panel self-report confidence).
   */
  value: number | null;
  /** The candidate behind `value` so a reviewer can audit. */
  basis: "pearson" | "agreement" | "none";
};

/** The composed cockpit read-model — every run surfaces ONE of these. */
export type BmkCockpitReadModel = {
  schemaVersion: typeof BMK_COCKPIT_SCHEMA_VERSION;
  generatedAt: string;
  projectId: string;
  localeBranchId: string | null;
  runId: string;
  targetLocale: string;
  /** Run kind — `real_run` / `fixture` / `replay`. */
  kind: BenchmarkRunRecord["kind"];
  /** Run status — terminal `succeeded`/`failed`/`partial`. */
  status: BenchmarkRunRecord["status"];
  unitsScored: number;
  recordedAt: string;
  /** The 5 SCORED contestants, projected onto the cockpit vocabulary. */
  contestants: BmkCockpitContestant[];
  /** The ranked order (best → worst) of the 5 contestant roles. */
  rankedRoles: BmkCockpitContestantRole[];
  /** The §8 external-anchor read on the cockpit. */
  humanAnchor: BmkCockpitHumanAnchor;
  /** The headline confidence derived from the anchor. */
  confidence: BmkCockpitConfidence;
  /** The §10 actionable improvement backlog — the cockpit's PRIMARY output. */
  actionableBacklog: BenchmarkImprovementBacklog;
  /** A defensive cap on the actionable backlog count surfaced for UIs. */
  actionableBacklogSize: number;
};

/**
 * A paged run-history view — a reviewer can page backward through past
 * benchmark cockpit runs to confirm the actionable backlog is shrinking.
 */
export type BmkCockpitRunHistoryRow = {
  runId: string;
  projectId: string;
  localeBranchId: string | null;
  targetLocale: string;
  kind: BenchmarkRunRecord["kind"];
  status: BenchmarkRunRecord["status"];
  unitsScored: number;
  recordedAt: string;
  /** The ranked-best role on this run (a quick headline). */
  bestRole: BmkCockpitContestantRole | null;
  /** The §10 actionable backlog size on this run (a quick headline). */
  actionableBacklogSize: number;
  /** The headline confidence on this run (defensive — same null rule). */
  confidence: number | null;
};

export type BmkCockpitRunHistoryPage = {
  filter: { projectId: string; localeBranchId: string | null };
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  rows: BmkCockpitRunHistoryRow[];
};

export type ComposeBmkCockpitReadModelInput = {
  actor: AuthorizationActor;
  repository: ItotoriBenchmarkRunRepositoryPort;
  projectId: string;
  /** When present, restricts the read-model to ONE benchmark run. */
  runId?: string;
  /** Restrict the latest-run read to a specific branch (omit = project-wide). */
  localeBranchId?: string | null;
  generatedAt?: Date;
};

export type LoadBmkCockpitRunHistoryInput = {
  actor: AuthorizationActor;
  repository: ItotoriBenchmarkRunRepositoryPort;
  projectId: string;
  localeBranchId?: string | null;
  limit?: number;
  offset?: number;
};

export class BmkCockpitReadModelError extends Error {
  constructor(detail: string) {
    super(`bmk-cockpit-read-model refused: ${detail}`);
    this.name = "BmkCockpitReadModelError";
  }
}

const ROLE_TO_KIND: Readonly<Record<BmkCockpitContestantRole, ContestantKind>> = {
  official: "official_localization",
  self: "itotori_context_on",
  self_nocontext: "itotori_context_off",
  fan: "fan_edited_mtl",
  mtl: "raw_mtl_baseline",
};

const KIND_TO_ROLE: Readonly<Record<ContestantKind, BmkCockpitContestantRole>> = {
  official_localization: "official",
  itotori_context_on: "self",
  itotori_context_off: "self_nocontext",
  fan_edited_mtl: "fan",
  raw_mtl_baseline: "mtl",
};

/**
 * The composer's READ-MODEL ENTRY — when `runId` is omitted it loads the
 * latest benchmark run for the project (optionally scoped to a locale branch).
 * The repository has already gated the read on `catalog.read`; this composer
 * only re-projects the persisted body onto the cockpit vocabulary, never
 * re-scores or re-judges.
 */
export async function composeBmkCockpitReadModel(
  input: ComposeBmkCockpitReadModelInput,
): Promise<BmkCockpitReadModel> {
  const run =
    input.runId !== undefined
      ? await input.repository.loadRun(input.actor, input.runId)
      : await input.repository.loadLatestRunForProject(input.actor, input.projectId, {
          ...(input.localeBranchId !== undefined ? { localeBranchId: input.localeBranchId } : {}),
        });
  if (run === undefined) {
    throw new BmkCockpitReadModelError(
      `no benchmark runway found for projectId='${input.projectId}'${
        input.runId !== undefined ? ` runId='${input.runId}'` : ""
      }`,
    );
  }
  if (run.projectId !== input.projectId) {
    throw new BmkCockpitReadModelError(
      `benchmark run '${run.runId}' belongs to projectId '${run.projectId}', not the requested projectId '${input.projectId}'`,
    );
  }
  return projectBmkCockpitReadModel(run, input.generatedAt);
}

/**
 * A paged run-history view over the cockpit. Pages raw rows into a compact
 * row shape so the dashboard can render "latest run / past N runs" tiles
 * without re-parsing the full report body for every row.
 */
export async function loadBmkCockpitRunHistory(
  input: LoadBmkCockpitRunHistoryInput,
): Promise<BmkCockpitRunHistoryPage> {
  const limit = clampBmkHistoryLimit(input.limit ?? 25);
  const offset = input.offset ?? 0;
  if (offset < 0) {
    throw new BmkCockpitReadModelError(`offset must be a non-negative integer; got ${offset}`);
  }
  // Page one row past the requested limit to detect a next page deterministically.
  const rows = await input.repository.loadRunsForProject(input.actor, input.projectId, {
    ...(input.localeBranchId !== undefined ? { localeBranchId: input.localeBranchId } : {}),
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit).map(rowToRunHistoryRow);
  return {
    filter: { projectId: input.projectId, localeBranchId: input.localeBranchId ?? null },
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
    rows: pageRows,
  };
}

/**
 * The internal projector — parses a persisted row's `reportBody` and projects
 * it through the cockpit vocabulary. PURE: a function of the persisted body,
 * so two computes over byte-equal rows produce byte-equal cockpit read-models.
 */
export function projectBmkCockpitReadModel(
  run: BenchmarkRunRecord,
  generatedAt: Date = new Date(),
): BmkCockpitReadModel {
  const body = parseRunBody(run);
  const contestants: BmkCockpitContestant[] = BMK_COCKPIT_CONTESTANT_ROLES.map((role) =>
    projectContestant(role, body.ranking),
  );
  const rankedRoles = orderRoles(body.ranking);
  const humanAnchor = projectHumanAnchor(body.panelHumanCalibration);
  const confidence = deriveConfidence(body.panelHumanCalibration);
  return {
    schemaVersion: BMK_COCKPIT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    projectId: run.projectId,
    localeBranchId: run.localeBranchId,
    runId: run.runId,
    targetLocale: run.targetLocale,
    kind: run.kind,
    status: run.status,
    unitsScored: run.unitsScored,
    recordedAt: run.recordedAt.toISOString(),
    contestants,
    rankedRoles,
    humanAnchor,
    confidence,
    actionableBacklog: body.backlog,
    actionableBacklogSize: body.backlog.items.length,
  };
}

function rowToRunHistoryRow(run: BenchmarkRunRecord): BmkCockpitRunHistoryRow {
  const body = parseRunBody(run);
  const rankedRoles = orderRoles(body.ranking);
  const confidence = deriveConfidence(body.panelHumanCalibration);
  return {
    runId: run.runId,
    projectId: run.projectId,
    localeBranchId: run.localeBranchId,
    targetLocale: run.targetLocale,
    kind: run.kind,
    status: run.status,
    unitsScored: run.unitsScored,
    recordedAt: run.recordedAt.toISOString(),
    bestRole: rankedRoles[0] ?? null,
    actionableBacklogSize: body.backlog.items.length,
    confidence: confidence.value,
  };
}

/**
 * Parse the persisted `reportBody` into the typed shapes the cockpit
 * composes on. The body is written by the benchmark facility — the schema
 * version is pinned so a future drift fails closed at read time.
 */
function parseRunBody(run: BenchmarkRunRecord): ParsedRunBody {
  if (run.schemaVersion !== REAL_RUN_BENCHMARK_SCHEMA_VERSION) {
    throw new BmkCockpitReadModelError(
      `benchmark run '${run.runId}' schemaVersion '${run.schemaVersion}' is not the current '${REAL_RUN_BENCHMARK_SCHEMA_VERSION}' (refusing to compose a cockpit read-model from an unknown body)`,
    );
  }
  const body = run.reportBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BmkCockpitReadModelError(
      `benchmark run '${run.runId}' reportBody is not an object (got ${typeof body})`,
    );
  }
  // Re-parse the typed shapes — a missing field surfaces a typed refusal so a
  // partial body can never silently degrade the cockpit.
  const ranking = readRanking(body["ranking"]);
  const panelHumanCalibration = readPanelHumanCalibration(body["panelHumanCalibration"]);
  const backlog = readActionableBacklog(body["backlog"]);
  return { ranking, panelHumanCalibration, backlog };
}

type ParsedRunBody = {
  ranking: ContestantRanking;
  panelHumanCalibration: PanelHumanCalibrationReport;
  backlog: BenchmarkImprovementBacklog;
};

function readRanking(value: unknown): ContestantRanking {
  if (typeof value !== "object" || value === null) {
    throw new BmkCockpitReadModelError("ranking missing from reportBody");
  }
  const r = value as Record<string, unknown>;
  const entriesRaw = r["entries"];
  const orderRaw = r["order"];
  if (!Array.isArray(entriesRaw) || !Array.isArray(orderRaw)) {
    throw new BmkCockpitReadModelError("ranking.entries / ranking.order are not arrays");
  }
  const entries: ContestantRankEntry[] = entriesRaw.map((e) => {
    if (typeof e !== "object" || e === null) {
      throw new BmkCockpitReadModelError("ranking.entries contains a non-object");
    }
    const er = e as Record<string, unknown>;
    if (
      typeof er["contestantId"] !== "string" ||
      typeof er["aggregateScore"] !== "number" ||
      typeof er["rank"] !== "number"
    ) {
      throw new BmkCockpitReadModelError(
        `ranking.entries has a malformed row: ${JSON.stringify(er)}`,
      );
    }
    return {
      contestantId: er["contestantId"],
      judgeMean: typeof er["judgeMean"] === "number" ? (er["judgeMean"] as number) : null,
      metricMean: typeof er["metricMean"] === "number" ? (er["metricMean"] as number) : null,
      aggregateScore: er["aggregateScore"],
      rank: er["rank"],
    };
  });
  const order = orderRaw.filter((id): id is string => typeof id === "string");
  return { entries, order };
}

function readPanelHumanCalibration(value: unknown): PanelHumanCalibrationReport {
  if (typeof value !== "object" || value === null) {
    throw new BmkCockpitReadModelError("panelHumanCalibration missing from reportBody");
  }
  return value as PanelHumanCalibrationReport;
}

function readActionableBacklog(value: unknown): BenchmarkImprovementBacklog {
  if (typeof value !== "object" || value === null) {
    throw new BmkCockpitReadModelError("backlog missing from reportBody");
  }
  return value as BenchmarkImprovementBacklog;
}

function projectContestant(
  role: BmkCockpitContestantRole,
  ranking: ContestantRanking,
): BmkCockpitContestant {
  const contestantKind = ROLE_TO_KIND[role];
  const entry = ranking.entries.find((row) => row.contestantId === contestantKind) ?? null;
  return {
    role,
    contestantKind,
    aggregateScore: entry?.aggregateScore ?? null,
    rank: entry?.rank ?? null,
    judgeMean: entry?.judgeMean ?? null,
    metricMean: entry?.metricMean ?? null,
    // TODO (post-MVP): derive per-contestant coverage from the facility's score
    // tables when the §9 ranking primitive surfaces one. Until then coverage
    // stays null and the dashboard renders an honest "no signal" state —
    // never a fabricated 0/1.
    coverage: null,
  };
}

function orderRoles(ranking: ContestantRanking): BmkCockpitContestantRole[] {
  const rankedKinds = ranking.order.filter((id): id is string => typeof id === "string");
  if (rankedKinds.length === 0) {
    // Defensive: when the ranking has no order, fall back to the canonical
    // §10 cockpit order so the dashboard always has a stable row sequence.
    return [...BMK_COCKPIT_CONTESTANT_ROLES];
  }
  const out: BmkCockpitContestantRole[] = [];
  for (const kind of rankedKinds) {
    const role = KIND_TO_ROLE[kind as ContestantKind];
    if (role !== undefined && !out.includes(role)) {
      out.push(role);
    }
  }
  // Append any remaining canonical roles so every contestant is always surfaced
  // (even when the ranking primitive was degenerate for one kind).
  for (const role of BMK_COCKPIT_CONTESTANT_ROLES) {
    if (!out.includes(role)) {
      out.push(role);
    }
  }
  return out;
}

function projectHumanAnchor(anchor: PanelHumanCalibrationReport): BmkCockpitHumanAnchor {
  return {
    raters: [...anchor.raters],
    judgeIds: [...anchor.judgeIds],
    byDimensionCount: anchor.byDimension.length,
    divergentDimensionCount: anchor.divergentDimensions.length,
    overall: {
      itemsCompared: anchor.overall.itemsCompared,
      normalizedAgreement: anchor.overall.normalizedAgreement,
      signedMeanDiff: anchor.overall.signedMeanDiff,
      pearson: anchor.overall.pearson,
    },
  };
}

function deriveConfidence(anchor: PanelHumanCalibrationReport): BmkCockpitConfidence {
  const pearson = anchor.overall.pearson;
  const agreement = anchor.overall.normalizedAgreement;
  // Prefer Pearson when present AND well-defined (a stronger signal); the
  // agreement rollup is the fallback. Both are clamped to [0,1] — neither is
  // ever a fabricated value when the underlying math produced a null.
  if (typeof pearson === "number" && Number.isFinite(pearson)) {
    const clamped = clamp01(pearson);
    return { pearson, normalizedAgreement: agreement, value: clamped, basis: "pearson" };
  }
  if (typeof agreement === "number" && Number.isFinite(agreement)) {
    const clamped = clamp01(agreement);
    return { pearson, normalizedAgreement: agreement, value: clamped, basis: "agreement" };
  }
  return { pearson, normalizedAgreement: agreement, value: null, basis: "none" };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampBmkHistoryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BmkCockpitReadModelError(`limit must be a positive integer; got ${limit}`);
  }
  return Math.min(limit, 200);
}
