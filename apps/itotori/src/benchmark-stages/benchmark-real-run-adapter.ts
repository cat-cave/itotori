// itotori-benchmark-real-run-adapter — the GAME-AGNOSTIC adapter that loads a
// REAL localized run (any project) into the contestant harness + drives the
// benchmark facility, so the facility scores a REAL run vs fan/pro tiers with
// a human anchor — emitting the real quality/regression report + actionable
// backlog. NOT fixture-only: the shipped benchmark path was fixture-only; this
// node generalizes it over run/data refs for ANY project.
//
// What this node OWNS:
//   1. The archive-free BOUNDARY (`RealRunArtifactPort`). The adapter operates
//      over RUN REFS / ARTIFACTS only — it never reads raw game bytes (no
//      archive unpack, no script decode, no asset extraction). Production wires
//      a DB-backed port (the journal / draft / patch-export tables); tests
//      wire {@link InMemoryRealRunArtifactPort}. The port resolves a run/data
//      ref into the per-unit accepted drafts + the source corpus the run
//      covered, and a comparator-tier ref into the fan/pro tier text. Both are
//      project-agnostic shapes — no game / engine / title field anywhere.
//   2. The SELF contestant wiring. The localized run being scored IS the
//      `itotori_context_on` contestant: its per-unit accepted drafts (the real
//      output of the run) become that contestant's candidate text. The runner
//      this adapter builds reads the run's draft per unit (NO regeneration —
//      the run already produced it). Its per-unit cost is the run's RECORDED
//      provider run when the port surfaces one (REAL `usage.cost`, never
//      approximated). A deterministic zero-cost REPLAY artifact is recorded
//      ONLY under EXPLICIT replay intent (the caller declares `replayMode`):
//      the cost already happened on the run, and re-scoring an artifact bills
//      nothing (truthful zero, the canonical ZERO_COST shape —
//      audit-no-hardcoded-cost clean). In the default REAL-RUN mode the adapter
//      FAILS CLOSED if ANY scored unit lacks its recorded provider run — it
//      never silently ZERO_COSTs a real run (cost must be REAL/recorded, never
//      assumed/hardcoded).
//   3. The COMPOSITION. The adapter threads the resolved run + comparators +
//      decoded structure + glossary + human anchor into {@link runBenchmarkFacility}
//      (which owns every scoring stage — it fans out into the contestant
//      harness → blind judge panel + deterministic metric suite → scoring
//      aggregation → actionable backlog + ranking + cost/latency + optional
//      meta-validity). It then builds the §8 panel↔human calibration report
//      from the de-anonymized human anchor and — when the caller asks — folds
//      every signal into the `StrongCaliberReadinessGate` verdict (the gate
//      this report feeds).
//
// The adapter owns NO scoring of its own. It is pure plumbing: refs → resolved
// artifacts → contestant-harness input → facility result → real-run report.
// Deterministic: a pure function of its inputs + port (the port is the only
// I/O seam, and a DB-backed port resolves refs deterministically).
//
// Project-law invariants respected:
//   - GAME-AGNOSTIC: no field references a specific work. The run ref is an
//     opaque id; the corpus carries only generic `unitId/label/sourceText`;
//     the comparators carry only `kind + per-unit target text`.
//   - NO RAW GAME BYTES: the port boundary guarantees the adapter never touches
//     archives; it consumes run artifacts (drafts / journal / patch-export
//     outputs) the orchestrator already produced.
//   - COST IS REAL: the SELF contestant's cost is the run's recorded provider
//     run when present (read VERBATIM, never approximated). A recorded-run-less
//     replay records truthful ZERO_COST ONLY under EXPLICIT replay intent
//     (`replayMode`); the default REAL-RUN mode FAILS CLOSED on a missing
//     recorded run (no silent ZERO_COST). No fabricated or hardcoded billed cost.
//   - BLINDNESS PRESERVED: the adapter never touches the §4.2 anonymization —
//     it feeds the harness, and the harness anonymizes (the judge still sees
//     only opaque salted handles; de-anon happens at scoring aggregation).

import type { BenchmarkQualityRubric } from "@itotori/localization-bridge-schema";
import type {
  BacklogSignalScore,
  BacklogUnitScope,
  BenchmarkImprovementBacklog,
} from "./actionable-backlog.js";
import {
  runBenchmarkFacility,
  type AggregatedScoring,
  type BenchmarkFacilityInput,
  type BenchmarkFacilityResult,
} from "./benchmark-facility.js";
import type { BlindJudgeAdapter } from "./blind-judge-panel.js";
import type {
  ContestantRanking,
  MetaValidityThresholds,
  RobustnessSwap,
  SabotageConfig,
} from "./meta-validity-harness.js";
import type { DecodedContextUnitRef } from "./decoded-context-feed.js";
import type { CanonTerm, DeterministicMetricConfig } from "./deterministic-metrics/index.js";
import type { BackTranslator } from "./back-translate-live.js";
import type {
  ContestantCorpusUnit,
  CorpusContestantUnitOutput,
  CorpusInputContestantKind,
  GeneratedContestantOutput,
  GenerativeContestantRunner,
} from "./contestant-harness.js";
import type { CostLatencyDimensions } from "./cost-latency-dims.js";
import type { PromptPresetReference, ProviderRunRecord } from "../providers/types.js";
import { ZERO_COST } from "../providers/cost.js";
import { localOnlyRoutingPosture } from "../providers/types.js";
import {
  buildPanelHumanCalibrationReport,
  type DeanonymizedHumanScore,
  type PanelHumanCalibrationReport,
} from "./human-calibration-anchor.js";
import {
  decideStrongCaliberReadiness,
  type StrongCaliberReadinessQaSignal,
  type StrongCaliberReadinessThresholds,
  type StrongCaliberReadinessVerdict,
} from "./strong-caliber-readiness-gate.js";
import type { NarrativeStructure } from "../structure/index.js";
import { deterministicUuid7 } from "./ids.js";

export class RealRunBenchmarkAdapterError extends Error {
  constructor(detail: string) {
    super(`benchmark-real-run-adapter refused: ${detail}`);
    this.name = "RealRunBenchmarkAdapterError";
  }
}

// ---------------------------------------------------------------------------
// 1. The archive-free BOUNDARY — refs the port resolves into run artifacts.
// ---------------------------------------------------------------------------

/**
 * A ref to a REAL localized run's accepted drafts (the SELF contestant). Opaque
 * id(s) the {@link RealRunArtifactPort} resolves; game-agnostic. The adapter
 * never touches raw game bytes — it consumes the run artifacts the orchestrator
 * already produced (drafts / journal records / patch-export written units).
 */
export type RealRunRef = {
  /** Opaque run id (e.g. a journal-run id / patch-export report id). */
  runId: string;
  /** Optional locale-branch ref the port may thread with the journal run. */
  localeBranchId?: string;
};

/**
 * A ref to a comparator TIER — the fan-edited-MTL or the official-localization
 * rendering of the same source units. Resolved by the port into per-unit target
 * text. Game-agnostic: the kind is the benchmark-contestant provenance role,
 * never a game/engine/title.
 */
export type ComparatorTierRef = {
  kind: CorpusInputContestantKind;
  /** Opaque tier id the port resolves (e.g. a corpus-version id). */
  tierId: string;
};

/**
 * The resolved SELF run — what the port produces for a {@link RealRunRef}. The
 * accepted drafts the run produced + the source corpus it covered + the run's
 * RECORDED provider runs (when the port surfaces them — REAL cost, verbatim).
 *
 * Project-agnostic: only generic `unitId/label/sourceText` + the per-unit
 * accepted draft text. NO game / engine / title field anywhere.
 */
export type ResolvedSelfRun = {
  targetLocale: string;
  /** The source units the run covered (one row per in-scope unit). */
  corpus: ContestantCorpusUnit[];
  /** The run's accepted draft, keyed by `bridgeUnitId` (the SELF output). */
  selfDraftsByUnit: Record<string, string>;
  /**
   * The run's RECORDED provider runs, keyed by `bridgeUnitId`, when the port
   * surfaces them. Each carries the authoritative REAL `usage.cost` the run
   * billed (read VERBATIM, never approximated). When absent for a unit the
   * adapter records a deterministic zero-cost REPLAY artifact ONLY under
   * EXPLICIT replay intent (`replayMode` on the adapter input) — the cost
   * already happened on the run, and re-scoring an artifact bills nothing
   * (truthful zero). In the default REAL-RUN mode a missing recorded run for
   * any scored unit FAILS CLOSED (no silent ZERO_COST of a real run).
   */
  providerRunsByUnit?: Record<string, ProviderRunRecord>;
};

/** The resolved comparator tier — per-unit target text for one provenance role. */
export type ResolvedComparatorTier = {
  kind: CorpusInputContestantKind;
  outputs: CorpusContestantUnitOutput[];
};

/**
 * The archive-free port. Production wires a DB-backed adapter (the journal
 * / draft / patch-export tables); tests wire
 * {@link InMemoryRealRunArtifactPort}. Two operations:
 *   - `loadSelfRun`        — resolve a run ref into its accepted drafts + corpus.
 *   - `loadComparatorTier` — resolve a tier ref into its per-unit target text.
 *
 * This is the ONLY I/O seam in the adapter. It guarantees the adapter never
 * touches raw game bytes: the port returns run artifacts the orchestrator
 * already produced, never archive contents.
 */
export interface RealRunArtifactPort {
  loadSelfRun(ref: RealRunRef): Promise<ResolvedSelfRun>;
  loadComparatorTier(ref: ComparatorTierRef): Promise<ResolvedComparatorTier>;
}

/**
 * In-memory {@link RealRunArtifactPort} for tests + offline replays. Holds the
 * resolved runs + comparator tiers keyed by their opaque ids and returns them
 * verbatim. Deterministic: two resolves of the same ref return the same data.
 */
export class InMemoryRealRunArtifactPort implements RealRunArtifactPort {
  private readonly selfRuns = new Map<string, ResolvedSelfRun>();
  private readonly tiers = new Map<string, ResolvedComparatorTier>();

  registerSelfRun(ref: RealRunRef, run: ResolvedSelfRun): this {
    this.selfRuns.set(ref.runId, run);
    return this;
  }

  registerComparatorTier(ref: ComparatorTierRef, tier: ResolvedComparatorTier): this {
    if (tier.kind !== ref.kind) {
      throw new RealRunBenchmarkAdapterError(
        `registered tier kind '${tier.kind}' does not match ref kind '${ref.kind}'`,
      );
    }
    this.tiers.set(`${ref.kind}:${ref.tierId}`, tier);
    return this;
  }

  async loadSelfRun(ref: RealRunRef): Promise<ResolvedSelfRun> {
    const run = this.selfRuns.get(ref.runId);
    if (run === undefined) {
      throw new RealRunBenchmarkAdapterError(`no self run registered for runId '${ref.runId}'`);
    }
    return run;
  }

  async loadComparatorTier(ref: ComparatorTierRef): Promise<ResolvedComparatorTier> {
    const tier = this.tiers.get(`${ref.kind}:${ref.tierId}`);
    if (tier === undefined) {
      throw new RealRunBenchmarkAdapterError(
        `no comparator tier registered for kind '${ref.kind}' tierId '${ref.tierId}'`,
      );
    }
    return tier;
  }
}

// ---------------------------------------------------------------------------
// 2. The adapter INPUT — game-agnostic run/comparator refs + artifacts.
// ---------------------------------------------------------------------------

/**
 * The floor + ablation generative contestants, supplied by the caller. The
 * SELF contestant (`itotori_context_on`) is sourced from the run ref; the floor
 * (`raw_mtl_baseline`) + the ablation (`itotori_context_off`) are NOT in the
 * run ref's scope, so the caller supplies them:
 *   - LIVE: real ZDR runners (the raw-MTL floor + the context-OFF ablation).
 *   - REPLAY: runners backed by recorded provider runs from prior runs.
 *   - TEST: fixture runners (a `FakeModelProvider` — zero cost, no LLM call).
 */
export type RealRunGenerativeRunners = {
  raw_mtl_baseline: GenerativeContestantRunner;
  itotori_context_off: GenerativeContestantRunner;
};

/**
 * The §8 human anchor — the ONE signal fully outside the LLM/pipeline loop. The
 * de-anonymized ratings keyed by real contestant KIND (the panel-side de-anon
 * already happened; the adapter never touches the blind handles), plus the
 * rater ids that backed it.
 */
export type RealRunHumanAnchor = {
  raters: string[];
  ratings: readonly DeanonymizedHumanScore[];
};

/**
 * Optional §9 meta-validity leg. When supplied, the facility runs the full
 * self-validation (sensitivity + robustness + calibration) on the real run.
 * `humanScores` + the contestant kinds are filled by the adapter (from the
 * human anchor + the fixed contestant vocabulary); the caller supplies the
 * sabotage / robustness / baseline shape.
 */
export type RealRunMetaValidityConfig = {
  sabotage: SabotageConfig;
  robustnessSwaps: RobustnessSwap[];
  baseline: { judges: BlindJudgeAdapter[]; panelSeed: string };
  thresholds?: Partial<MetaValidityThresholds>;
};

/**
 * Optional strong-caliber readiness gate. When supplied, the adapter folds
 * every signal (ranking + human anchor + regression + QA + meta-validity) into
 * a {@link StrongCaliberReadinessVerdict} on the report. The QA signal is the
 * only field the adapter cannot source from the facility (the gate owns no QA
 * scoring); the caller threads it from the QA-agent stage when run.
 */
export type RealRunReadinessGateConfig = {
  qa?: StrongCaliberReadinessQaSignal | null;
  thresholds?: Partial<StrongCaliberReadinessThresholds>;
};

export type RealRunBenchmarkAdapterInput = {
  /** The run to score — its accepted drafts become the SELF contestant output. */
  selfRunRef: RealRunRef;
  /** The fan-edited-MTL + official-localization comparator refs. */
  comparatorRefs: {
    fanMtl: ComparatorTierRef;
    professional: ComparatorTierRef;
  };
  /** The floor + ablation generative contestants (SELF comes from the run). */
  generativeRunners: RealRunGenerativeRunners;
  /** The decoded narrative structure (§5 ground-truth-only judge context). */
  structure: NarrativeStructure;
  /** Per-unit locators binding corpus units to decoded messages (§5). */
  unitRefs: DecodedContextUnitRef[];
  /** §3 corpus glossary (canon term → target form). */
  glossary: CanonTerm[];
  /** §3 corpus canon-name list. */
  canonNames: CanonTerm[];
  /** Per-unit scene/speaker scope used to bucket failure modes (§10.1). */
  unitScopes: BacklogUnitScope[];
  /** The §4 judge panel (fixture judges in tests; ZDR adapters live). */
  judges: BlindJudgeAdapter[];
  /** §4.2 order-randomization seed. */
  panelSeed: string;
  /** SECRET per-run anonymization salt (feeds the §4.2 handle derivation). */
  anonymizationSalt: string;
  /** The §8 human anchor (de-anonymized ratings keyed by contestant KIND). */
  humanAnchor: RealRunHumanAnchor;
  /** The archive-free port that resolves the refs into run artifacts. */
  artifactPort: RealRunArtifactPort;
  /**
   * EXPLICIT replay-intent signal. When `true`, the adapter records a
   * deterministic ZERO_COST replay artifact for any scored unit the run did
   * NOT record a provider run for (the run already produced the draft;
   * re-scoring bills nothing — truthful zero, the canonical ZERO_COST shape).
   * When `false`/absent (the default REAL-RUN mode) the adapter FAILS CLOSED
   * with a typed error if ANY scored unit lacks its recorded provider run — it
   * never silently ZERO_COSTs a real run (itotori's invariant: cost must be
   * REAL/recorded, never assumed/hardcoded). ZERO_COST is legitimate ONLY
   * under this explicit declaration.
   */
  replayMode?: boolean;
  /** The prior run's per-signal scores (§10.3 regression telemetry). */
  priorRun?: { perSignalScores: BacklogSignalScore[] };
  /** Optional §3 metric threshold overrides. */
  metricConfig?: Partial<DeterministicMetricConfig>;
  /** Optional §3 back-translation tripwire producer (live ZDR round-trip). */
  backTranslator?: BackTranslator;
  /** Optional §2 rubric override (defaults to the frozen rubric). */
  rubric?: BenchmarkQualityRubric;
  /** Optional §9 meta-validity self-validation leg. */
  metaValidity?: RealRunMetaValidityConfig;
  /** Optional strong-caliber readiness gate (folds the report into a verdict). */
  readinessGate?: RealRunReadinessGateConfig;
  /** Cosmetic §3 metric-run timestamps (do not affect any score). */
  metricStartedAt?: string;
  metricCompletedAt?: string;
};

// ---------------------------------------------------------------------------
// 3. The adapter RESULT — the real quality/regression report + backlog.
// ---------------------------------------------------------------------------

export const REAL_RUN_BENCHMARK_SCHEMA_VERSION = "itotori.real-run-benchmark.v0.1" as const;

/**
 * The real-run benchmark report. The adapter composes the facility output with
 * the §8 panel↔human calibration report, the surfaced actionable backlog, and
 * (when requested) the strong-caliber readiness verdict — all on the same
 * reconciled contestant identity the facility aggregated. Provenance-safe: the
 * resolved refs are echoed back so a reviewer sees EXACTLY which run + tiers
 * were scored, and the units-scored count contextualizes the backlog.
 */
export type RealRunBenchmarkReport = {
  readonly schemaVersion: typeof REAL_RUN_BENCHMARK_SCHEMA_VERSION;
  /** The run ref that was resolved + scored (provenance of the SELF contestant). */
  readonly runRef: RealRunRef;
  /** The comparator refs that were resolved (provenance of fan/pro tiers). */
  readonly comparatorRefs: { fanMtl: ComparatorTierRef; professional: ComparatorTierRef };
  /** The target locale the run localized into. */
  readonly targetLocale: string;
  /** How many source units the facility scored. */
  readonly unitsScored: number;
  /** The full facility result (every stage joined on a consistent identity). */
  readonly facility: BenchmarkFacilityResult;
  /** Convenience views on the facility result (the real quality + backlog). */
  readonly aggregated: AggregatedScoring;
  readonly ranking: ContestantRanking;
  readonly costLatency: CostLatencyDimensions;
  readonly backlog: BenchmarkImprovementBacklog;
  /** §8 the panel↔human calibration report (the external-anchor read). */
  readonly panelHumanCalibration: PanelHumanCalibrationReport;
  /**
   * The strong-caliber readiness verdict — present only when the caller asked
   * the adapter to fold the report into the gate. This is the actionable
   * CONTINUE-vs-STRONG-CALIBER-DONE call the report feeds.
   */
  readonly readiness: StrongCaliberReadinessVerdict | null;
};

// ---------------------------------------------------------------------------
// 4. The SELF contestant runner — the run's accepted drafts as candidate text.
// ---------------------------------------------------------------------------

const SELF_RUN_PROVIDER_NAME = "itotori-real-run-adapter" as const;
const SELF_REPLAY_PROMPT_PRESET_ID = "itotori-benchmark-real-run-self-replay" as const;
const SELF_REPLAY_PROMPT_PRESET_VERSION = "1.0.0" as const;

/**
 * Build the SELF contestant runner: for each unit, return the run's ACCEPTED
 * DRAFT as the candidate text (NO regeneration — the run already produced it).
 *
 * Cost is REAL when the run recorded a provider run for the unit: it is read
 * VERBATIM from the recorded run (the authoritative `usage.cost`, never
 * approximated, audit-no-hardcoded-cost clean). When the run carries no
 * recorded provider run the behavior is gated on EXPLICIT replay intent:
 *   - `replayMode: true`  — record a deterministic zero-cost REPLAY artifact
 *     (re-scoring an already-produced draft bills nothing, so truthful zero,
 *     the canonical ZERO_COST shape, is the honest read).
 *   - `replayMode: false` / absent (REAL-RUN mode) — FAIL CLOSED with a typed
 *     {@link RealRunBenchmarkAdapterError}; the adapter never silently
 *     ZERO_COSTs a real run (cost must be REAL/recorded, never
 *     assumed/hardcoded).
 *
 * The replay run id is derived deterministically from the run ref + unit id,
 * so two replays of the same run produce byte-equal harness output.
 */
export function makeSelfRunDraftRunner(
  selfRun: ResolvedSelfRun,
  ref: RealRunRef,
  options?: { replayMode?: boolean },
): GenerativeContestantRunner {
  const replayMode = options?.replayMode === true;
  const drafts = new Map(Object.entries(selfRun.selfDraftsByUnit));
  const recordedRuns = new Map(Object.entries(selfRun.providerRunsByUnit ?? {}));
  return async (unit: ContestantCorpusUnit): Promise<GeneratedContestantOutput> => {
    const targetText = drafts.get(unit.unitId);
    if (targetText === undefined) {
      throw new RealRunBenchmarkAdapterError(
        `self run '${ref.runId}' has no accepted draft for unit '${unit.unitId}'`,
      );
    }
    const recorded = recordedRuns.get(unit.unitId);
    if (recorded !== undefined) {
      return { targetText, providerRun: recorded };
    }
    if (!replayMode) {
      throw new RealRunBenchmarkAdapterError(
        `real-run mode requires a recorded provider run for every scored unit; run '${ref.runId}' has none for unit '${unit.unitId}' (declare replayMode for an explicit zero-cost replay of an already-produced draft)`,
      );
    }
    return { targetText, providerRun: deterministicSelfReplayRun(ref, unit, targetText) };
  };
}

/**
 * Build a deterministic zero-cost REPLAY provider run for a self-run unit that
 * has no recorded provider run. Re-scoring an already-produced draft bills
 * nothing, so the truthful cost is the canonical ZERO_COST shape. The run id +
 * fields are derived deterministically from the run ref + unit id, so two
 * replays of the same run produce byte-equal harness output (no clock, no
 * entropy). Marks itself a replay via the `prompt.presetId` + `usageResponseJson`
 * sentinel so a reviewer sees WHY no billed cost exists.
 *
 * Invoked ONLY under EXPLICIT replay intent ({@link makeSelfRunDraftRunner}
 * `replayMode: true`). In the default REAL-RUN mode a missing recorded run
 * FAILS CLOSED before this function can ever be reached — ZERO_COST is never
 * applied to a real run silently.
 */
function deterministicSelfReplayRun(
  ref: RealRunRef,
  unit: ContestantCorpusUnit,
  targetText: string,
): ProviderRunRecord {
  const runId = deterministicUuid7(
    "itotori.benchmark.real-run-self-replay.v1",
    ref.runId,
    unit.unitId,
  );
  const prompt: PromptPresetReference = {
    presetId: SELF_REPLAY_PROMPT_PRESET_ID,
    templateVersion: SELF_REPLAY_PROMPT_PRESET_VERSION,
    promptHash: deterministicUuid7(
      "itotori.benchmark.real-run-self-replay.hash.v1",
      ref.runId,
      unit.unitId,
      targetText,
    ),
    schemaVersion: "itotori.prompt-preset.v0",
    configSnapshot: {
      runId: ref.runId,
      bridgeUnitId: unit.unitId,
      replay: true,
    },
  };
  return {
    runId,
    taskKind: "draft_translation",
    // A replay has no wall-clock; deterministic zeros carry the provenance.
    startedAt: "1970-01-01T00:00:00.000Z",
    completedAt: "1970-01-01T00:00:00.000Z",
    latencyMs: 0,
    status: "succeeded",
    provider: {
      // A replay is a RECORDED artifact (the draft was already produced by the
      // run); the typed family/endpoint reflect that truthfully.
      providerFamily: "recorded",
      endpointFamily: "recorded-fixture",
      providerName: SELF_RUN_PROVIDER_NAME,
      requestedModelId: "self-run-replay",
      requestedProviderId: SELF_RUN_PROVIDER_NAME,
      actualModelId: "self-run-replay",
    },
    structuredOutputMode: "none",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: [],
    tokenUsage: {
      tokenCountSource: "deterministic_counter",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    cost: ZERO_COST,
    routingPosture: localOnlyRoutingPosture(SELF_RUN_PROVIDER_NAME),
    usageResponseJson: { _real_run_replay_no_billing: true },
    prompt,
  };
}

// ---------------------------------------------------------------------------
// 5. The adapter — refs → facility → real-run report.
// ---------------------------------------------------------------------------

/**
 * Load a REAL localized run into the contestant harness + drive the benchmark
 * facility, so it scores the run vs fan/pro tiers with a human anchor —
 * emitting the real quality/regression report + actionable backlog. For ANY
 * project (game-agnostic); operates over run/data refs (NO raw game bytes).
 *
 * The flow:
 *   1. RESOLVE the run + comparator refs via the archive-free port.
 *   2. WIRE the SELF contestant (`itotori_context_on`) to the run's accepted
 *      drafts; the fan/pro tiers become the corpus-input contestants; the floor
 *      + ablation come from the caller-supplied runners.
 *   3. DRIVE {@link runBenchmarkFacility} (which owns every scoring stage).
 *   4. BUILD the §8 panel↔human calibration report from the de-anonymized
 *      anchor + the aggregated judge scores.
 *   5. Optionally FOLD every signal into the strong-caliber readiness gate.
 *
 * Deterministic: a pure function of its inputs + port. The only non-pure seam
 * is the port (a DB-backed port resolves refs deterministically) and the
 * caller-supplied generative runners (the raw-MTL floor + context-OFF ablation
 * — LIVE on a real run, fixtures in tests).
 */
export async function runRealRunBenchmarkAdapter(
  input: RealRunBenchmarkAdapterInput,
): Promise<RealRunBenchmarkReport> {
  // ── (0) Validate the game-agnostic refs + anchor BEFORE any I/O. ──────────
  if (input.anonymizationSalt.length === 0) {
    throw new RealRunBenchmarkAdapterError("anonymizationSalt must be a non-empty secret");
  }
  if (input.comparatorRefs.fanMtl.kind !== "fan_edited_mtl") {
    throw new RealRunBenchmarkAdapterError(
      `fanMtl comparator ref must be kind 'fan_edited_mtl', got '${input.comparatorRefs.fanMtl.kind}'`,
    );
  }
  if (input.comparatorRefs.professional.kind !== "official_localization") {
    throw new RealRunBenchmarkAdapterError(
      `professional comparator ref must be kind 'official_localization', got '${input.comparatorRefs.professional.kind}'`,
    );
  }
  if (input.humanAnchor.raters.length === 0 || input.humanAnchor.ratings.length === 0) {
    throw new RealRunBenchmarkAdapterError(
      "humanAnchor requires at least one rater + one de-anonymized rating (§8 anchor)",
    );
  }

  // ── (1) Resolve refs via the archive-free port. ───────────────────────────
  const selfRun = await input.artifactPort.loadSelfRun(input.selfRunRef);
  const fanMtl = await input.artifactPort.loadComparatorTier(input.comparatorRefs.fanMtl);
  const professional = await input.artifactPort.loadComparatorTier(
    input.comparatorRefs.professional,
  );

  if (fanMtl.kind !== "fan_edited_mtl") {
    throw new RealRunBenchmarkAdapterError(
      `resolved fanMtl tier is kind '${fanMtl.kind}', expected 'fan_edited_mtl'`,
    );
  }
  if (professional.kind !== "official_localization") {
    throw new RealRunBenchmarkAdapterError(
      `resolved professional tier is kind '${professional.kind}', expected 'official_localization'`,
    );
  }
  if (selfRun.corpus.length === 0) {
    throw new RealRunBenchmarkAdapterError(
      `self run '${input.selfRunRef.runId}' covered zero source units`,
    );
  }

  // ── (1b) FAIL CLOSED in REAL-RUN mode if any scored unit lacks its recorded
  //        provider run. ZERO_COST is legitimate ONLY under EXPLICIT replay
  //        intent; a real run must carry its REAL recorded cost (never silent
  //        ZERO_COST). The eager check surfaces the offending units in ONE
  //        clear error BEFORE any scoring work begins (the per-unit runner
  //        remains a defense-in-depth guard for the same condition).
  // ────────────────────────────────────────────────────────────────────────
  const replayMode = input.replayMode === true;
  if (!replayMode) {
    const recordedByUnit = selfRun.providerRunsByUnit ?? {};
    const missingUnits = selfRun.corpus
      .filter((unit) => recordedByUnit[unit.unitId] === undefined)
      .map((unit) => unit.unitId);
    if (missingUnits.length > 0) {
      throw new RealRunBenchmarkAdapterError(
        `real-run mode requires a recorded provider run for every scored unit (cost must be REAL/recorded, never silent ZERO_COST); run '${input.selfRunRef.runId}' is missing recorded provider runs for ${missingUnits.length} unit${missingUnits.length === 1 ? "" : "s"}: ${missingUnits.join(", ")} (declare replayMode for an explicit zero-cost replay of already-produced drafts)`,
      );
    }
  }

  // ── (2) Wire the SELF contestant + corpus contestants + generative runners. ──
  const selfRunner = makeSelfRunDraftRunner(selfRun, input.selfRunRef, { replayMode });

  const facilityInput: BenchmarkFacilityInput = {
    contestant: {
      targetLocale: selfRun.targetLocale,
      corpus: selfRun.corpus,
      generativeRunners: {
        raw_mtl_baseline: input.generativeRunners.raw_mtl_baseline,
        itotori_context_on: selfRunner,
        itotori_context_off: input.generativeRunners.itotori_context_off,
      },
      corpusContestants: {
        fan_edited_mtl: fanMtl.outputs,
        official_localization: professional.outputs,
      },
      anonymizationSalt: input.anonymizationSalt,
    },
    structure: input.structure,
    unitRefs: input.unitRefs,
    judges: input.judges,
    panelSeed: input.panelSeed,
    glossary: input.glossary,
    canonNames: input.canonNames,
    systemUnderTestKind: "itotori_context_on",
    fanMtlKind: "fan_edited_mtl",
    professionalKind: "official_localization",
    unitScopes: input.unitScopes,
    ...(input.priorRun !== undefined ? { priorRun: input.priorRun } : {}),
    ...(input.metricConfig !== undefined ? { metricConfig: input.metricConfig } : {}),
    ...(input.backTranslator !== undefined ? { backTranslator: input.backTranslator } : {}),
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.metricStartedAt !== undefined ? { metricStartedAt: input.metricStartedAt } : {}),
    ...(input.metricCompletedAt !== undefined
      ? { metricCompletedAt: input.metricCompletedAt }
      : {}),
    ...(input.metaValidity !== undefined
      ? {
          metaValidity: {
            itotoriKind: "itotori_context_on",
            fanMtlKind: "fan_edited_mtl",
            sabotage: input.metaValidity.sabotage,
            robustnessSwaps: input.metaValidity.robustnessSwaps,
            baseline: input.metaValidity.baseline,
            humanScores: [...input.humanAnchor.ratings],
            ...(input.metaValidity.thresholds !== undefined
              ? { thresholds: input.metaValidity.thresholds }
              : {}),
          },
        }
      : {}),
  };

  // ── (3) Drive the facility (it owns every scoring stage). ─────────────────
  const facility = await runBenchmarkFacility(facilityInput);

  // ── (4) §8 panel↔human calibration report. ────────────────────────────────
  const panelHumanCalibration = buildPanelHumanCalibrationReport({
    panelScores: facility.aggregated.judgeScores,
    humanScores: input.humanAnchor.ratings,
  });

  // ── (5) Strong-caliber readiness gate (optional). ─────────────────────────
  let readiness: StrongCaliberReadinessVerdict | null = null;
  if (input.readinessGate !== undefined) {
    readiness = decideStrongCaliberReadiness({
      systemUnderTestId: "itotori_context_on",
      ranking: facility.ranking,
      humanAnchor: panelHumanCalibration,
      humanRatings: input.humanAnchor.ratings,
      regression: { perDimensionRegression: facility.backlog.perDimensionRegression },
      qa: input.readinessGate.qa ?? null,
      ...(facility.metaValidity !== null ? { metaValidity: facility.metaValidity } : {}),
      ...(input.readinessGate.thresholds !== undefined
        ? { thresholds: input.readinessGate.thresholds }
        : {}),
    });
  }

  return {
    schemaVersion: REAL_RUN_BENCHMARK_SCHEMA_VERSION,
    runRef: input.selfRunRef,
    comparatorRefs: input.comparatorRefs,
    targetLocale: selfRun.targetLocale,
    unitsScored: selfRun.corpus.length,
    facility,
    aggregated: facility.aggregated,
    ranking: facility.ranking,
    costLatency: facility.costLatency,
    backlog: facility.backlog,
    panelHumanCalibration,
    readiness,
  };
}

// Re-export the facility + harness types the adapter surfaces, so a caller
// imports the whole real-run surface from this one module if they choose.
export type {
  AggregatedScoring,
  BenchmarkFacilityInput,
  BenchmarkFacilityResult,
} from "./benchmark-facility.js";
export type { ContestantHarnessResult } from "./contestant-harness.js";
export type { BlindJudgePanelResult } from "./blind-judge-panel.js";
export type { DeterministicMetricSuiteResult } from "./deterministic-metrics/index.js";
export type { JudgeUnitInput } from "./decoded-context-feed.js";
