// benchmark-contestant-harness (§6) — collect + provenance-anonymize the
// contestant set for blind scoring.
//
// Methodology §6 (docs/itotori-translation-benchmark-methodology.md). Per source
// unit, the benchmark collects FIVE contestants and hands them to the blind
// judge panel (§4) + the deterministic metric suite (§3):
//
//   - raw_mtl_baseline      — GENERATED fresh (a plain machine-translation
//                             prompt, no Itotori machinery), real `usage.cost`.
//                             The floor. (`makeRawMtlBaselineRunner`.)
//   - fan_edited_mtl        — from the corpus fan-TL tier (sourced privately) —
//                             accepted as an INPUT (not sourced yet).
//   - official_localization — from the corpus official-EN tier (sourced
//                             privately) — accepted as an INPUT.
//   - itotori_context_on    — full structure-informed-context pipeline.
//   - itotori_context_off   — the ABLATION: Itotori WITHOUT structure-informed
//                             context. The ON/OFF pair measures whether our core
//                             advantage actually helps, per dimension (§6.1).
//
// TWO invariants this module enforces IN CODE:
//
//   1. PROVENANCE ANONYMIZATION (§4.2 / §6.1). Every contestant is emitted with
//      its system identity STRIPPED. Judges (and every downstream consumer of the
//      blind bundle) see only opaque, salted handles `A/B/C/…`; nothing in the
//      blind bundle names or hints at which output is which system. The mapping
//      back to a real contestant kind lives ONLY in a separate de-anonymization
//      key, joined at scoring aggregation. Because each handle is a hash over a
//      SECRET per-run salt, the mapping is NOT recomputable from public data —
//      `assertContestantBundleBlind` proves this in code and in the tests.
//
//   2. PRO IS A BLIND CONTESTANT, NOT THE REFERENCE (§6.2). The official
//      localization is a peer contestant, anonymized identically. This module
//      never treats it as a gold reference; it is one handle among five.
//
// Cost is REAL (§11.1). The generative contestants (MTL baseline, Itotori
// on/off) read their per-unit billed cost + latency VERBATIM from the provider
// run their runner returns (`ProviderRunRecord.cost` — OpenRouter `usage.cost`,
// never approximated, `audit-no-hardcoded-cost`-clean). The fixed corpus tiers
// (fan-TL, official) have no runtime cost/latency and report N/A (null).

import { createHash } from "node:crypto";
import type { BenchmarkSystemKindV02 } from "@itotori/localization-bridge-schema";
import type { ContestantCandidate } from "./decoded-context-feed.js";
import type { MetricSystemInput, MetricUnit } from "./deterministic-metrics/types.js";
import { deterministicUuid7 } from "./ids.js";
import type {
  ModelInvocationRequest,
  ModelProvider,
  ProviderInputClassification,
  ProviderRunRecord,
} from "../providers/index.js";

// ---------------------------------------------------------------------------
// The §6 contestant vocabulary.
// ---------------------------------------------------------------------------

/** The five §6.1 contestants. This is a benchmark-facility concept distinct
 * from the schema's `BenchmarkSystemKindV02` cost-report vocabulary — it names
 * the CONTESTANTS the ablation compares, not the cost-report system tags. */
export const CONTESTANT_KINDS = [
  "raw_mtl_baseline",
  "fan_edited_mtl",
  "official_localization",
  "itotori_context_on",
  "itotori_context_off",
] as const;
export type ContestantKind = (typeof CONTESTANT_KINDS)[number];

/** Contestants GENERATED at run time (real provider call → real `usage.cost`). */
export const GENERATIVE_CONTESTANT_KINDS = [
  "raw_mtl_baseline",
  "itotori_context_on",
  "itotori_context_off",
] as const;
export type GenerativeContestantKind = (typeof GENERATIVE_CONTESTANT_KINDS)[number];

/** Contestants ACCEPTED as corpus inputs (the private fan-TL / official-EN tiers). */
export const CORPUS_INPUT_CONTESTANT_KINDS = ["fan_edited_mtl", "official_localization"] as const;
export type CorpusInputContestantKind = (typeof CORPUS_INPUT_CONTESTANT_KINDS)[number];

/** The Itotori ablation pair — the first-class on/off distinction (§6.1). */
export const ITOTORI_ABLATION_KINDS = ["itotori_context_on", "itotori_context_off"] as const;

function isGenerativeKind(kind: ContestantKind): kind is GenerativeContestantKind {
  return (GENERATIVE_CONTESTANT_KINDS as readonly string[]).includes(kind);
}

/**
 * The blind metric-input `systemKind` tag. The blind bundle must not reveal a
 * contestant's real identity, so every metric-input system carries this single
 * neutral tag; the metrics distinguish systems by the opaque `systemId`
 * (the salted system handle), and the real kind is recovered ONLY via the
 * de-anonymization key at scoring aggregation.
 */
export const BLIND_METRIC_SYSTEM_KIND: BenchmarkSystemKindV02 = "deterministic_fixture";

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

/** A source unit every contestant renders. Fixture-safe (public in tests). */
export type ContestantCorpusUnit = {
  /** UUID7 bridge-unit id. */
  unitId: string;
  /** Human-readable locator, e.g. `script/prologue#line-001`. */
  label: string;
  /** Decoded source text (ground truth, JP). */
  sourceText: string;
};

/** What a generative runner returns for one unit: the rendered target + the
 * REAL provider run it came from (the sole source of cost + latency). */
export type GeneratedContestantOutput = {
  targetText: string;
  providerRun: ProviderRunRecord;
};

/**
 * Produces one generative contestant's output for a unit. On the LIVE path this
 * is a real ZDR provider call (see `makeRawMtlBaselineRunner` for the MTL
 * baseline; the Itotori on/off runners wrap the real draft path with its
 * structure-informed context ON vs OFF). On the TEST path it is a fixture that
 * returns canned text + a zero-cost fake provider run — NO real LLM calls.
 */
export type GenerativeContestantRunner = (
  unit: ContestantCorpusUnit,
) => Promise<GeneratedContestantOutput>;

/** One corpus-input contestant's rendered target for a unit (fan / official). */
export type CorpusContestantUnitOutput = {
  unitId: string;
  targetText: string;
};

export type ContestantHarnessInput = {
  /** Target locale carried over from the benchmark set manifest. */
  targetLocale: string;
  /** The source units every contestant renders. */
  corpus: ContestantCorpusUnit[];
  /**
   * The three GENERATIVE contestants' runners. Every generative kind MUST have a
   * runner — the ablation (itotori on + off) is first-class and non-optional.
   */
  generativeRunners: Record<GenerativeContestantKind, GenerativeContestantRunner>;
  /**
   * The two CORPUS-INPUT contestants (fan-edited MTL, official localization),
   * accepted as inputs because the private corpus tiers are not sourced yet.
   * Each must cover every corpus unit exactly once.
   */
  corpusContestants: Record<CorpusInputContestantKind, CorpusContestantUnitOutput[]>;
  /**
   * SECRET per-run anonymization salt. Every handle is a hash over this salt, so
   * the handle→kind mapping is NOT recomputable from public data (the blind
   * bundle never carries the salt). Held by the harness operator; NOT emitted.
   */
  anonymizationSalt: string;
  /** Optional per-unit engine box metrics threaded into the metric inputs. */
  boxMetricsByUnit?: Record<string, MetricUnit["boxMetrics"]>;
};

// ---------------------------------------------------------------------------
// Outputs — the BLIND bundle + the PRIVATE de-anonymization key.
// ---------------------------------------------------------------------------

/**
 * The BLIND bundle. Safe to hand to the judge panel (§4) and the deterministic
 * metric suite (§3): it carries opaque handles ONLY, no provenance. A downstream
 * consumer cannot infer which output is which system from this bundle alone.
 */
export type AnonymizedContestantBundle = {
  targetLocale: string;
  /**
   * Per-unit anonymized candidates — the exact `ContestantCandidate` shape the
   * decoded-context-feed / judge panel consumes. `contestantId` is a salted,
   * per-unit opaque handle; order within a unit is salt-derived (not kind-
   * ordered) so position never leaks identity.
   */
  candidates: ContestantCandidate[];
  /**
   * Per-contestant deterministic-metric inputs. `systemId` is the salted system
   * handle; `systemKind` is the neutral blind tag (`BLIND_METRIC_SYSTEM_KIND`).
   */
  metricInputs: MetricSystemInput[];
};

/** Per-candidate provenance — one row per (unit, contestant). PRIVATE. */
export type ContestantCandidateProvenance = {
  unitId: string;
  /** == the blind `ContestantCandidate.contestantId`. */
  candidateHandle: string;
  systemHandle: string;
  contestantKind: ContestantKind;
  /** Real per-unit billed cost (micros) — null for corpus-input (N/A §11.1). */
  costMicrosUsd: number | null;
  /** Real per-unit billed cost (full-precision decimal USD) — null for corpus. */
  costAmountUsd: string | null;
  /** Real per-unit latency — null for corpus-input (N/A §11.1). */
  latencyMs: number | null;
  /** The provider-run id this candidate came from — null for corpus-input. */
  providerRunId: string | null;
};

/** Per-contestant-system provenance — one row per contestant kind. PRIVATE. */
export type ContestantSystemProvenance = {
  systemHandle: string;
  contestantKind: ContestantKind;
  isGenerative: boolean;
  /** Sum of real per-unit billed cost — null for corpus-input (N/A §11.1). */
  totalCostMicrosUsd: number | null;
  /** Sum of real per-unit latency — null for corpus-input (N/A §11.1). */
  totalLatencyMs: number | null;
  providerRunIds: string[];
};

/**
 * The PRIVATE de-anonymization key. Held for SCORING AGGREGATION ONLY — never
 * handed to the judge panel. It is the sole artifact that maps an opaque handle
 * back to a real contestant kind; without it, the blind bundle is un-de-
 * anonymizable (the salted handles are not invertible from public data).
 */
export type ContestantDeanonymizationKey = {
  systems: ContestantSystemProvenance[];
  candidates: ContestantCandidateProvenance[];
};

export type ContestantHarnessResult = {
  targetLocale: string;
  anonymizedBundle: AnonymizedContestantBundle;
  deanonymizationKey: ContestantDeanonymizationKey;
  /** The real provider-run records for the generative contestants (cost ledger). */
  providerRuns: ProviderRunRecord[];
};

/** Raised when the contestant-harness inputs are missing or inconsistent. */
export class ContestantHarnessError extends Error {
  constructor(detail: string) {
    super(`benchmark-contestant-harness refused: ${detail}`);
    this.name = "ContestantHarnessError";
  }
}

/** Raised when a blind bundle is found to leak a contestant's provenance. */
export class ContestantBlindingError extends Error {
  constructor(detail: string) {
    super(`benchmark-contestant-harness blinding violated: ${detail}`);
    this.name = "ContestantBlindingError";
  }
}

// ---------------------------------------------------------------------------
// Salted handle derivation — the anonymization primitive.
// ---------------------------------------------------------------------------

const SYSTEM_HANDLE_NS = "itotori.benchmark.contestant-system-handle.v1";
const CANDIDATE_HANDLE_NS = "itotori.benchmark.contestant-candidate-handle.v1";

/**
 * The salt is hashed (never carried verbatim) before entering a handle seed, so
 * even a handle-derivation reader cannot lift the raw salt out of the code path.
 */
function saltDigest(salt: string): string {
  return createHash("sha256").update(`benchmark-contestant-salt ${salt}`).digest("hex");
}

/** Opaque per-run system handle for a contestant kind (stable across units). */
function systemHandle(saltHash: string, kind: ContestantKind): string {
  return deterministicUuid7(SYSTEM_HANDLE_NS, saltHash, kind);
}

/** Opaque per-run, PER-UNIT candidate handle. Per-unit so a judge cannot
 * correlate "handle X is always the best" across many units (§4.2). */
function candidateHandle(saltHash: string, unitId: string, kind: ContestantKind): string {
  return deterministicUuid7(CANDIDATE_HANDLE_NS, saltHash, unitId, kind);
}

// ---------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------

/**
 * Collect the five §6 contestants per source unit, provenance-anonymize them for
 * blind scoring, and emit (a) the blind bundle for the judge panel + metrics and
 * (b) the private de-anonymization key for scoring aggregation.
 */
export async function runContestantHarness(
  input: ContestantHarnessInput,
): Promise<ContestantHarnessResult> {
  if (input.anonymizationSalt.length === 0) {
    throw new ContestantHarnessError("anonymizationSalt must be a non-empty secret");
  }
  if (input.corpus.length === 0) {
    throw new ContestantHarnessError("benchmark set manifest selected zero source units");
  }

  const corpusById = new Map<string, ContestantCorpusUnit>();
  for (const unit of input.corpus) {
    if (corpusById.has(unit.unitId)) {
      throw new ContestantHarnessError(`duplicate corpus unitId '${unit.unitId}'`);
    }
    corpusById.set(unit.unitId, unit);
  }

  // Every generative contestant MUST have a runner (the ablation is non-optional).
  for (const kind of GENERATIVE_CONTESTANT_KINDS) {
    if (typeof input.generativeRunners[kind] !== "function") {
      throw new ContestantHarnessError(`missing generative runner for contestant '${kind}'`);
    }
  }
  // Every corpus-input contestant MUST cover every unit exactly once.
  const corpusTargetsByKind = new Map<CorpusInputContestantKind, Map<string, string>>();
  for (const kind of CORPUS_INPUT_CONTESTANT_KINDS) {
    const outputs = input.corpusContestants[kind];
    if (!Array.isArray(outputs)) {
      throw new ContestantHarnessError(`missing corpus-input contestant '${kind}'`);
    }
    const byUnit = new Map<string, string>();
    for (const output of outputs) {
      if (!corpusById.has(output.unitId)) {
        throw new ContestantHarnessError(
          `corpus-input contestant '${kind}' references unknown source unit '${output.unitId}'`,
        );
      }
      if (byUnit.has(output.unitId)) {
        throw new ContestantHarnessError(
          `corpus-input contestant '${kind}' has duplicate output for unit '${output.unitId}'`,
        );
      }
      byUnit.set(output.unitId, output.targetText);
    }
    for (const unit of input.corpus) {
      if (!byUnit.has(unit.unitId)) {
        throw new ContestantHarnessError(
          `corpus-input contestant '${kind}' is missing unit '${unit.unitId}'`,
        );
      }
    }
    corpusTargetsByKind.set(kind, byUnit);
  }

  const saltHash = saltDigest(input.anonymizationSalt);

  // Accumulators.
  const candidateProvenance: ContestantCandidateProvenance[] = [];
  const providerRuns: ProviderRunRecord[] = [];
  // system handle → per-kind metric units (blind).
  const metricUnitsByKind = new Map<ContestantKind, MetricUnit[]>();
  // unit → its anonymized candidates (accumulated then order-normalized).
  const candidatesByUnit = new Map<string, ContestantCandidate[]>();
  for (const unit of input.corpus) {
    candidatesByUnit.set(unit.unitId, []);
  }
  for (const kind of CONTESTANT_KINDS) {
    metricUnitsByKind.set(kind, []);
  }

  const record = (
    kind: ContestantKind,
    unit: ContestantCorpusUnit,
    targetText: string,
    run: ProviderRunRecord | null,
  ): void => {
    const handle = candidateHandle(saltHash, unit.unitId, kind);
    const sysHandle = systemHandle(saltHash, kind);
    candidatesByUnit.get(unit.unitId)!.push({
      contestantId: handle,
      unitId: unit.unitId,
      candidateText: targetText,
    });
    const boxMetrics = input.boxMetricsByUnit?.[unit.unitId];
    const metricUnit: MetricUnit = {
      unitId: unit.unitId,
      label: unit.label,
      sourceText: unit.sourceText,
      targetText,
    };
    if (boxMetrics !== undefined) {
      metricUnit.boxMetrics = boxMetrics;
    }
    metricUnitsByKind.get(kind)!.push(metricUnit);
    candidateProvenance.push({
      unitId: unit.unitId,
      candidateHandle: handle,
      systemHandle: sysHandle,
      contestantKind: kind,
      costMicrosUsd: run === null ? null : run.cost.amountMicrosUsd,
      costAmountUsd: run === null ? null : run.cost.amountUsd,
      latencyMs: run === null ? null : run.latencyMs,
      providerRunId: run === null ? null : run.runId,
    });
    if (run !== null) {
      providerRuns.push(run);
    }
  };

  // Generative contestants — real provider calls (fixtures on the test path).
  // Sequential so a bounded live run stays within the per-run cost cap.
  for (const kind of GENERATIVE_CONTESTANT_KINDS) {
    const runner = input.generativeRunners[kind];
    for (const unit of input.corpus) {
      const output = await runner(unit);
      record(kind, unit, output.targetText, output.providerRun);
    }
  }

  // Corpus-input contestants — no runtime cost/latency (N/A §11.1).
  for (const kind of CORPUS_INPUT_CONTESTANT_KINDS) {
    const byUnit = corpusTargetsByKind.get(kind)!;
    for (const unit of input.corpus) {
      record(kind, unit, byUnit.get(unit.unitId)!, null);
    }
  }

  // Order-randomize candidates within each unit by their opaque, salt-derived
  // handle (§4.2 order randomization). Sorting by the handle is deterministic
  // and reproducible, yet the order depends on the SECRET salt, so position
  // reveals nothing about which candidate is which system.
  const orderedCandidates: ContestantCandidate[] = [];
  for (const unit of input.corpus) {
    const list = candidatesByUnit.get(unit.unitId)!;
    list.sort((a, b) =>
      a.contestantId < b.contestantId ? -1 : a.contestantId > b.contestantId ? 1 : 0,
    );
    orderedCandidates.push(...list);
  }

  // Blind metric inputs — one system per contestant kind, opaque systemId +
  // neutral blind systemKind.
  const metricInputs: MetricSystemInput[] = CONTESTANT_KINDS.map((kind) => ({
    systemId: systemHandle(saltHash, kind),
    systemKind: BLIND_METRIC_SYSTEM_KIND,
    units: metricUnitsByKind.get(kind)!,
  }));

  // System-level provenance (cost/latency roll-up).
  const systemProvenance: ContestantSystemProvenance[] = CONTESTANT_KINDS.map((kind) => {
    const rows = candidateProvenance.filter((row) => row.contestantKind === kind);
    const generative = isGenerativeKind(kind);
    return {
      systemHandle: systemHandle(saltHash, kind),
      contestantKind: kind,
      isGenerative: generative,
      totalCostMicrosUsd: generative
        ? rows.reduce((sum, row) => sum + (row.costMicrosUsd ?? 0), 0)
        : null,
      totalLatencyMs: generative ? rows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) : null,
      providerRunIds: rows
        .map((row) => row.providerRunId)
        .filter((id): id is string => id !== null),
    };
  });

  const anonymizedBundle: AnonymizedContestantBundle = {
    targetLocale: input.targetLocale,
    candidates: orderedCandidates,
    metricInputs,
  };

  // Fail-closed: the bundle we emit must carry no recoverable provenance.
  assertContestantBundleBlind(anonymizedBundle, {
    deanonymizationKey: { systems: systemProvenance, candidates: candidateProvenance },
  });

  return {
    targetLocale: input.targetLocale,
    anonymizedBundle,
    deanonymizationKey: { systems: systemProvenance, candidates: candidateProvenance },
    providerRuns,
  };
}

// ---------------------------------------------------------------------------
// De-anonymization — the scoring-aggregation join (needs the PRIVATE key).
// ---------------------------------------------------------------------------

/**
 * Resolve a blind candidate handle back to its real contestant kind. This is
 * the ONLY supported de-anonymization path and it REQUIRES the private key — a
 * judge holding only the blind bundle cannot perform this join (the handle is a
 * salted hash; the mapping lives solely in the key). Used at scoring
 * aggregation to attribute judge scores + metric scores to a contestant.
 */
export function deanonymizeCandidate(
  key: ContestantDeanonymizationKey,
  candidateHandleValue: string,
): { contestantKind: ContestantKind; unitId: string; systemHandle: string } {
  const row = key.candidates.find((c) => c.candidateHandle === candidateHandleValue);
  if (row === undefined) {
    throw new ContestantHarnessError(
      `candidate handle '${candidateHandleValue}' is not present in the de-anonymization key`,
    );
  }
  return { contestantKind: row.contestantKind, unitId: row.unitId, systemHandle: row.systemHandle };
}

/** Resolve a blind metric-input `systemId` (system handle) back to its kind. */
export function deanonymizeSystem(
  key: ContestantDeanonymizationKey,
  systemHandleValue: string,
): ContestantKind {
  const row = key.systems.find((s) => s.systemHandle === systemHandleValue);
  if (row === undefined) {
    throw new ContestantHarnessError(
      `system handle '${systemHandleValue}' is not present in the de-anonymization key`,
    );
  }
  return row.contestantKind;
}

// ---------------------------------------------------------------------------
// The blinding asserter — proves no provenance is recoverable from the bundle.
// ---------------------------------------------------------------------------

/**
 * Tokens that would betray a contestant's identity if they appeared in an
 * IDENTITY-bearing position (a handle, an object key). Deliberately NOT scanned
 * over the free-text content (`candidateText` / `sourceText` / `targetText`): a
 * real translation may legitimately contain words like "official" or "baseline"
 * — that is the content being judged, not a provenance label.
 */
const PROVENANCE_GIVEAWAY_TOKENS: readonly string[] = [
  ...CONTESTANT_KINDS,
  "raw_mtl",
  "fan_edited",
  "fan-edited",
  "official_localization",
  "itotori",
  "ablation",
  "baseline",
  "displayname",
  "systemname",
  "contestantkind",
  "provenance",
];

/** deterministicUuid7 output shape — the only permitted handle form. */
const UUID7_HANDLE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Keys a blind `ContestantCandidate` may carry (nothing identity-bearing). */
const CANDIDATE_KEYS: ReadonlySet<string> = new Set(["contestantId", "unitId", "candidateText"]);
/** Keys a blind metric-input system may carry. */
const METRIC_SYSTEM_KEYS: ReadonlySet<string> = new Set(["systemId", "systemKind", "units"]);
/** Keys a blind `MetricUnit` may carry (the defined, identity-free metric shape). */
const METRIC_UNIT_KEYS: ReadonlySet<string> = new Set([
  "unitId",
  "label",
  "sourceText",
  "targetText",
  "protectedSpans",
  "decodedSpeaker",
  "attributedSpeaker",
  "sceneId",
  "speakerId",
  "boxMetrics",
  "choice",
  "backTranslation",
]);

function assertKeysWithin(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContestantBlindingError(`${label} carries identity-bearing field '${key}'`);
    }
  }
}

function assertOpaqueHandle(handle: string, label: string): void {
  if (!UUID7_HANDLE_RE.test(handle)) {
    throw new ContestantBlindingError(`${label} '${handle}' is not an opaque handle`);
  }
  const lowered = handle.toLowerCase();
  for (const token of PROVENANCE_GIVEAWAY_TOKENS) {
    if (lowered.includes(token.toLowerCase())) {
      throw new ContestantBlindingError(`${label} '${handle}' encodes provenance token '${token}'`);
    }
  }
}

export type AssertContestantBundleBlindOptions = {
  /**
   * When supplied, additionally proves the handles are opaque with respect to
   * the key: every blind candidate handle must resolve THROUGH the key (i.e. the
   * mapping cannot be recomputed without it — the key is the only join path).
   */
  deanonymizationKey?: ContestantDeanonymizationKey;
};

/**
 * Assert the blind bundle leaks no contestant provenance. Throws
 * `ContestantBlindingError` on any recoverable-identity signal:
 *   - a candidate id / metric system id that is not an OPAQUE handle (or that
 *     encodes a provenance token);
 *   - an identity-bearing object key anywhere in the bundle shape (a
 *     `contestantKind` / `displayName` / `provenance` field would fail here);
 *   - a `systemKind` other than the neutral blind tag on a metric input;
 *   - a metric-input `systemId` colliding with a candidate id (which would let a
 *     judge cluster per-unit candidates into cross-unit systems);
 *   - (with a key) a candidate handle that does NOT round-trip through the key.
 *
 * Free-text translation content is intentionally exempt from the token scan.
 * This is the in-code proof behind the §6.1 / §4.2 blinding requirement.
 */
export function assertContestantBundleBlind(
  bundle: AnonymizedContestantBundle,
  options: AssertContestantBundleBlindOptions = {},
): void {
  assertKeysWithin(bundle, new Set(["targetLocale", "candidates", "metricInputs"]), "blind bundle");

  for (const candidate of bundle.candidates) {
    assertKeysWithin(candidate, CANDIDATE_KEYS, "blind candidate");
    assertOpaqueHandle(candidate.contestantId, "candidate id");
  }

  for (const system of bundle.metricInputs) {
    assertKeysWithin(system, METRIC_SYSTEM_KEYS, "metric input");
    assertOpaqueHandle(system.systemId, "metric input systemId");
    if (system.systemKind !== BLIND_METRIC_SYSTEM_KIND) {
      throw new ContestantBlindingError(
        `metric input carries non-neutral systemKind '${system.systemKind}' (would leak identity)`,
      );
    }
    for (const unit of system.units) {
      assertKeysWithin(unit, METRIC_UNIT_KEYS, "metric unit");
    }
  }

  // A judge scores per-unit candidates; the per-unit candidate ids must NOT
  // collide with the cross-unit metric-input systemIds (that join would let a
  // judge de-blind by clustering candidates into systems).
  const systemHandleSet = new Set(bundle.metricInputs.map((s) => s.systemId));
  for (const candidate of bundle.candidates) {
    if (systemHandleSet.has(candidate.contestantId)) {
      throw new ContestantBlindingError(
        `candidate id '${candidate.contestantId}' collides with a metric-input systemId (cross-unit de-blinding)`,
      );
    }
  }

  const key = options.deanonymizationKey;
  if (key !== undefined) {
    const known = new Set(key.candidates.map((c) => c.candidateHandle));
    for (const candidate of bundle.candidates) {
      if (!known.has(candidate.contestantId)) {
        throw new ContestantBlindingError(
          `candidate handle '${candidate.contestantId}' does not resolve through the de-anonymization key`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The raw-MTL baseline GENERATION path — real ZDR call + real `usage.cost`.
// ---------------------------------------------------------------------------

/** Live-path MTL cost cap default (a bounded single-unit translate). */
export const RAW_MTL_BASELINE_MAX_PRICE_USD = 0.01;

export type RawMtlBaselineRunnerOptions = {
  /**
   * The model provider. LIVE: a ZDR-configured `OpenRouterProvider` (its
   * constructor asserts account-wide ZDR + refuses a missing key; it records
   * real `usage.cost`). TEST: a `FakeModelProvider` (zero cost, no LLM call) —
   * this is how the harness tests exercise the generation path without a real
   * call. The runner NEVER approximates cost; it copies `providerRun.cost`.
   */
  provider: ModelProvider;
  /** The (modelId, providerId) pair — declared explicitly, never defaulted. */
  modelId: string;
  providerId: string;
  targetLocale: string;
  sourceLocale: string;
  /**
   * Input classification for the source text. `synthetic_public` for the public
   * test corpus; `private_corpus` on a real Kanon/owned-title run.
   */
  inputClassification: ProviderInputClassification;
  /** Per-call USD cap; mirrored to `provider.max_price` and enforced. */
  maxPriceUsd?: number;
};

/**
 * Build the raw-MTL baseline generative runner: a plain, degenerate machine
 * translation (NO glossary, NO context, NO QA — the §6.1 floor). It invokes the
 * provider once per unit and returns the rendered text plus the provider run —
 * the SOLE, un-approximated source of billed cost + latency. Passing a
 * `FakeModelProvider` yields a deterministic, zero-cost run for tests; passing a
 * ZDR `OpenRouterProvider` is the live real-`usage.cost` path.
 */
export function makeRawMtlBaselineRunner(
  options: RawMtlBaselineRunnerOptions,
): GenerativeContestantRunner {
  return async (unit: ContestantCorpusUnit): Promise<GeneratedContestantOutput> => {
    const promptHash = `sha256:${createHash("sha256")
      .update(`raw-mtl-baseline-contestant ${unit.unitId} ${unit.sourceText}`)
      .digest("hex")}`;
    const request: ModelInvocationRequest = {
      taskKind: "draft_translation",
      modelId: options.modelId,
      providerId: options.providerId,
      inputClassification: options.inputClassification,
      messages: [
        {
          role: "system",
          content:
            "You are a raw machine-translation baseline. Translate the source text literally, " +
            "word for word, with no glossary, context, or stylistic adaptation. " +
            `Translate from ${options.sourceLocale} to ${options.targetLocale}. ` +
            "Return ONLY the translated text, with no commentary, labels, or quotes.",
        },
        { role: "user", content: unit.sourceText },
      ],
      generation: { temperature: 0, maxOutputTokens: 1200 },
      maxPriceUsd: options.maxPriceUsd ?? RAW_MTL_BASELINE_MAX_PRICE_USD,
      prompt: {
        presetId: "itotori-benchmark-raw-mtl-baseline-contestant",
        templateVersion: "1.0.0",
        promptHash,
        schemaVersion: "itotori.prompt-preset.v0",
        configSnapshot: { unitId: unit.unitId, targetLocale: options.targetLocale },
      },
      fallbackModels: [],
    };
    const result = await options.provider.invoke(request);
    if (result.content === null || result.content.trim().length === 0) {
      throw new ContestantHarnessError(
        `raw-MTL baseline produced no content for unit '${unit.unitId}'`,
      );
    }
    return { targetText: result.content.trim(), providerRun: result.providerRun };
  };
}
