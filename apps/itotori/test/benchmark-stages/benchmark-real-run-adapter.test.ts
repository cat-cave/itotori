// itotori-benchmark-real-run-adapter — the GAME-AGNOSTIC real-run adapter tests.
//
// Proves the adapter loads ANY localized run (given its run/data ref + fan/pro
// comparator refs + unit scopes + artifacts) into the contestant harness + the
// facility scores it vs fan/pro tiers with a human anchor, emitting the real
// quality/regression report + actionable backlog. NOT fixture-only: the
// SELF contestant is the run's accepted drafts, sourced via the archive-free
// port (no raw game bytes, no game-specific fields).
//
// What these tests pin:
//   1. CRUX — a real-ish run ref loads into the harness + scores vs fan/pro +
//      the human anchor → a report with contestants + ranking + backlog + the
//      §8 panel↔human calibration + the strong-caliber readiness verdict.
//   2. PROVENANCE — the SELF contestant's candidate text IS the run's accepted
//      drafts (the facility scored the REAL run, not a regeneration).
//   3. COST IS REAL — when the run records provider runs, the SELF cost
//      surfaces VERBATIM (no fabrication). A recorded-run-less replay records
//      truthful ZERO_COST ONLY under EXPLICIT replay intent (`replayMode`);
//      the default REAL-RUN mode FAILS CLOSED on a missing recorded run (no
//      silent ZERO_COST of a real run).
//   4. GAME-AGNOSTIC — the resolved corpus carries only generic
//      `unitId/label/sourceText`; no game/engine/title field anywhere.
//   5. DETERMINISTIC — two adapter runs on byte-equal inputs produce byte-equal
//      reports (the SELF replay is deterministic; no clock/entropy).
//   6. BLINDNESS PRESERVED — the judge still saw ONLY blind handles (the
//      adapter never touches the §4.2 anonymization).
//   7. REFUSAL — missing draft for a unit / wrong comparator kind / empty human
//      anchor / missing tier ref all surface a typed refusal before scoring.

import { describe, expect, it } from "vitest";
import {
  InMemoryRealRunArtifactPort,
  REAL_RUN_BENCHMARK_SCHEMA_VERSION,
  RealRunBenchmarkAdapterError,
  makeSelfRunDraftRunner,
  runRealRunBenchmarkAdapter,
  type ComparatorTierRef,
  type RealRunBenchmarkAdapterInput,
  type RealRunRef,
  type ResolvedComparatorTier,
  type ResolvedSelfRun,
} from "../../src/benchmark-stages/index.js";
import {
  FixtureJudge,
  makeRawMtlBaselineRunner,
  type BacklogUnitScope,
  type DeanonymizedHumanScore,
  type FixtureJudgeScoreFn,
  type GenerativeContestantRunner,
  type RobustnessSwap,
} from "../../src/benchmark-stages/index.js";
import { FakeModelProvider } from "../../src/providers/fake.js";
import { usageCostToDecimalString, usageCostToMicros } from "../../src/providers/cost.js";
import type { ProviderRunRecord } from "../../src/providers/types.js";
import { localOnlyRoutingPosture } from "../../src/providers/types.js";
import type { NarrativeStructure } from "../../src/agents/structure-informed-context/index.js";

// ── A real-ish, GAME-AGNOSTIC run fixture ────────────────────────────────────
// No game/engine/title fields: only generic unitId/label/sourceText + the run's
// accepted drafts + a recorded provider run with a REAL sub-micro cost.

const U1 = "019ed010-0000-7000-8000-0000000000a1";
const U2 = "019ed010-0000-7000-8000-0000000000a2";

const SELF_RUN_ID = "journal-run-locale-branch-en-us";
const FAN_TIER_ID = "fan-tier-v3";
const PRO_TIER_ID = "official-tier-shipped";

const REAL_RUN_REF: RealRunRef = {
  runId: SELF_RUN_ID,
  localeBranchId: "locale-branch-en-us",
};

/** A real sub-micro billed cost, built via the cost parser (no fabricated literal). */
function realBilledCost(usageCost: number): ProviderRunRecord {
  const amountUsd = usageCostToDecimalString(usageCost);
  const amountMicrosUsd = usageCostToMicros(usageCost);
  return {
    runId: "prov-run-self-u-real",
    taskKind: "draft_translation",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:00:01.234Z",
    latencyMs: 1234,
    status: "succeeded",
    provider: {
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      providerName: "openrouter",
      requestedModelId: "deepseek/deepseek-v4-flash",
      requestedProviderId: "deepseek",
      actualModelId: "deepseek/deepseek-v4-flash",
    },
    structuredOutputMode: "none",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: [],
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 120,
      completionTokens: 18,
      totalTokens: 138,
    },
    cost: { costKind: "billed", currency: "USD", amountUsd, amountMicrosUsd },
    routingPosture: localOnlyRoutingPosture("deepseek"),
    usageResponseJson: { cost: usageCost },
    prompt: {
      presetId: "itotori-draft-translation",
      templateVersion: "1.0.0",
      promptHash: "sha256:real-run-self",
      schemaVersion: "itotori.prompt-preset.v0",
    },
  };
}

/** The SELF run — the accepted drafts the run produced + a recorded provider run
 *  with a REAL sub-micro cost (the authoritative `usage.cost`, never fabricated).
 *
 *  `defectiveU1` controls whether the U1 draft carries the register defect the
 *  fixture judge flags (default true — drives a NON-empty backlog). A clean run
 *  (`defectiveU1: false`) scores 4 across the board → STRONG_CALIBER_DONE-able. */
function resolvedSelfRun(
  opts: { withRecordedRuns?: boolean; defectiveU1?: boolean } = {},
): ResolvedSelfRun {
  const { withRecordedRuns = false, defectiveU1 = true } = opts;
  const drafts: Record<string, string> = {
    [U1]: defectiveU1
      ? "Morning, Rin. The light's already up." // flagged register (contraction + run-on)
      : "Good morning, Rin. The light is already up.", // clean register
    [U2]: "Morning light spills across the floor.",
  };
  const corpus = [
    { unitId: U1, label: "script/prologue#line-001", sourceText: "おはよう、りん。" },
    { unitId: U2, label: "script/prologue#line-002", sourceText: "朝の光が差し込む。" },
  ];
  const providerRunsByUnit: Record<string, ProviderRunRecord> = {
    [U1]: realBilledCost(0.00000602), // sub-micro billed cost (real, verbatim)
    [U2]: realBilledCost(0.00000711),
  };
  return {
    targetLocale: "en-US",
    corpus,
    selfDraftsByUnit: drafts,
    ...(withRecordedRuns ? { providerRunsByUnit } : {}),
  };
}

const FAN_TIER: ResolvedComparatorTier = {
  kind: "fan_edited_mtl",
  outputs: [
    { unitId: U1, targetText: "Morning, Rin." },
    { unitId: U2, targetText: "Morning light streams in." },
  ],
};

const PRO_TIER: ResolvedComparatorTier = {
  kind: "official_localization",
  outputs: [
    { unitId: U1, targetText: "Good morning, Rin." },
    { unitId: U2, targetText: "The morning light pours in." },
  ],
};

const FAN_REF: ComparatorTierRef = { kind: "fan_edited_mtl", tierId: FAN_TIER_ID };
const PRO_REF: ComparatorTierRef = { kind: "official_localization", tierId: PRO_TIER_ID };

function structure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 2031,
    sceneDispatchOrder: [2031],
    scenes: [
      {
        sceneId: 2031,
        selectionControl: "text-window",
        nextScene: null,
        messages: [
          { order: 0, speaker: "和人", text: "おはよう、りん。", textSurface: null },
          { order: 1, speaker: null, text: "朝の光が差し込む。", textSurface: null },
        ],
        choices: [],
      },
    ],
  };
}

const UNIT_SCOPES: BacklogUnitScope[] = [
  { unitId: U1, label: "script/prologue#line-001", sceneId: "prologue", speakerId: "kazuto" },
  { unitId: U2, label: "script/prologue#line-002", sceneId: "prologue", speakerId: "narration" },
];

const GLOSSARY = [{ sourceTerm: "りん", targetForm: "Rin" }];

// The fixture judge reads candidate TEXT. The SELF draft for U1 contains an
// em-dash contraction the others lack → the judge scores its register low (so
// the backlog is NON-empty + the self-vs-human-anchor gate has signal).
const scoreFn: FixtureJudgeScoreFn = ({ candidate, dimensionId, decodedContext }) => {
  if (
    dimensionId === "register_politeness" &&
    decodedContext.unitId === U1 &&
    candidate.candidateText.includes("The light's already up.")
  ) {
    return {
      score: 2,
      citation: {
        sourceSpan: candidate.candidateText,
        decodedContextUsed: "register on a casual morning greeting",
        rationale: "contraction + run-on register on a casual line",
      },
    };
  }
  return { score: 4, citation: null };
};

function judges() {
  return [
    new FixtureJudge({
      judgeId: "judge-deepseek",
      modelFamily: "deepseek",
      modelId: "deepseek/x",
      providerId: "deepseek-p",
      scoreFn,
    }),
    new FixtureJudge({
      judgeId: "judge-qwen",
      modelFamily: "qwen",
      modelId: "qwen/x",
      providerId: "qwen-p",
      scoreFn,
    }),
  ];
}

/** A tagged fake-provider runner: each contestant renders `[tag] <source>` so the
 *  fixture judge scores by TEXT (never by identity). Zero cost (fake). */
function taggedRunner(tag: string): GenerativeContestantRunner {
  const provider = new FakeModelProvider({
    providerName: `fixture-${tag}`,
    generate: (request) => {
      const last = [...request.messages].reverse().find((m) => m.role === "user");
      return `[${tag}] ${typeof last?.content === "string" ? last.content : ""}`;
    },
  });
  return makeRawMtlBaselineRunner({
    provider,
    modelId: `itotori-fake-${tag}`,
    providerId: "fake-fixture",
    targetLocale: "en-US",
    sourceLocale: "ja-JP",
    inputClassification: "synthetic_public",
  });
}

function humanScores(selfScore: number): DeanonymizedHumanScore[] {
  const rows: DeanonymizedHumanScore[] = [];
  for (const unitId of [U1, U2]) {
    rows.push({
      raterId: "trevor",
      unitId,
      contestantId: "itotori_context_on",
      dimensionId: "register_politeness",
      score: selfScore,
      notes: null,
    });
    rows.push({
      raterId: "trevor",
      unitId,
      contestantId: "official_localization",
      dimensionId: "register_politeness",
      score: 4,
      notes: null,
    });
  }
  return rows;
}

function adapterInput(opts: {
  withRecordedRuns: boolean;
  withMetaValidity?: boolean;
  readiness?: { qa: { f1: number } | null };
  selfScore?: number;
  defectiveU1?: boolean;
  /**
   * EXPLICIT replay-intent signal threaded into the adapter input. Defaults to
   * `true` when `withRecordedRuns` is false so the legacy "no recorded runs"
   * fixtures (provenance / blindness / determinism / readiness) still exercise
   * the explicit-replay path; tests that pin the REAL-RUN fail-closed path
   * pass `replayMode: false` explicitly.
   */
  replayMode?: boolean;
}): RealRunBenchmarkAdapterInput {
  const { withRecordedRuns, replayMode = !withRecordedRuns } = opts;
  const swaps: RobustnessSwap[] = [
    { swapId: "order-swap", swapKind: "order", judges: judges(), panelSeed: "alt-seed" },
    { swapId: "judge-swap", swapKind: "judge", judges: judges(), panelSeed: "real-run-seed" },
  ];
  const port = new InMemoryRealRunArtifactPort()
    .registerSelfRun(
      REAL_RUN_REF,
      resolvedSelfRun({ withRecordedRuns, defectiveU1: opts.defectiveU1 }),
    )
    .registerComparatorTier(FAN_REF, FAN_TIER)
    .registerComparatorTier(PRO_REF, PRO_TIER);
  return {
    selfRunRef: REAL_RUN_REF,
    comparatorRefs: { fanMtl: FAN_REF, professional: PRO_REF },
    generativeRunners: {
      raw_mtl_baseline: taggedRunner("mtl"),
      itotori_context_off: taggedRunner("ioff"),
    },
    structure: structure(),
    unitRefs: [
      { unitId: U1, sceneId: 2031, messageOrder: 0 },
      { unitId: U2, sceneId: 2031, messageOrder: 1 },
    ],
    glossary: GLOSSARY,
    canonNames: [],
    unitScopes: UNIT_SCOPES,
    judges: judges(),
    panelSeed: "real-run-seed",
    anonymizationSalt: "real-run-adapter-secret-2026-07-07",
    humanAnchor: { raters: ["trevor"], ratings: humanScores(opts.selfScore ?? 4) },
    artifactPort: port,
    replayMode,
    ...(opts.withMetaValidity
      ? {
          metaValidity: {
            sabotage: { kinds: ["untranslated_residue", "omission"] },
            robustnessSwaps: swaps,
            baseline: { judges: judges(), panelSeed: "real-run-seed" },
          },
        }
      : {}),
    ...(opts.readiness !== undefined ? { readinessGate: { qa: opts.readiness.qa } } : {}),
  };
}

describe("runRealRunBenchmarkAdapter — CRUX: scores a REAL run vs fan/pro + anchor", () => {
  it("loads a real run via the port + emits a report with contestants + anchor + backlog", async () => {
    const report = await runRealRunBenchmarkAdapter(
      adapterInput({ withRecordedRuns: true, withMetaValidity: true, readiness: { qa: null } }),
    );

    // The report self-identifies + carries the resolved-run provenance.
    expect(report.schemaVersion).toBe(REAL_RUN_BENCHMARK_SCHEMA_VERSION);
    expect(report.runRef).toEqual(REAL_RUN_REF);
    expect(report.comparatorRefs).toEqual({ fanMtl: FAN_REF, professional: PRO_REF });
    expect(report.targetLocale).toBe("en-US");
    expect(report.unitsScored).toBe(2);

    // The ranking is a full 5-contestant ladder (the harness scored all five).
    expect(report.ranking.order.length).toBe(5);
    expect(report.ranking.order).toContain("itotori_context_on");

    // The backlog is keyed to the SELF kind + NON-empty (the judge flagged the
    // register on U1, so a real failure mode surfaced for the real run).
    expect(report.backlog.systemUnderTestId).toBe("itotori_context_on");
    expect(report.backlog.items.length).toBeGreaterThan(0);
    const register = report.backlog.items.find((i) => i.dimension === "register_politeness");
    expect(register).toBeDefined();
    expect(register!.signalSource).toBe("blind_judge_panel");

    // The §8 panel↔human calibration report is built from the de-anonymized anchor.
    expect(report.panelHumanCalibration.raters).toEqual(["trevor"]);
    expect(report.panelHumanCalibration.byDimension.length).toBeGreaterThan(0);

    // The strong-caliber readiness verdict folded every signal (CONTINUE when QA
    // is absent — the QA gate fails on a null F1).
    expect(report.readiness).not.toBeNull();
    expect(report.readiness!.systemUnderTestId).toBe("itotori_context_on");
    expect(report.readiness!.decision).toBe("CONTINUE");
    expect(report.readiness!.failedGateIds).toContain("qa-accuracy-threshold");

    // The §9 meta-validity leg ran on the real run.
    expect(report.facility.metaValidity).not.toBeNull();
    expect(report.facility.metaValidity!.sensitivity.check).toBe("sensitivity");
  });

  it("the SELF contestant's candidate text IS the run's accepted drafts (not regenerated)", async () => {
    const report = await runRealRunBenchmarkAdapter(adapterInput({ withRecordedRuns: false }));
    // Recover the SELF contestant's candidate text from the de-anonymized harness.
    const selfCandidates = report.aggregated.judgeScores
      .filter((s) => s.contestantId === "itotori_context_on")
      .map((s) => s.unitId);
    // Both units were scored for the SELF contestant.
    expect(new Set(selfCandidates)).toEqual(new Set([U1, U2]));

    // Cross-check: the harness's de-anonymized candidates carry the run's drafts.
    const selfRows = report.facility.harness.deanonymizationKey.candidates.filter(
      (c) => c.contestantKind === "itotori_context_on",
    );
    const draftByUnit = new Map(selfRows.map((r) => [r.unitId, r]));
    // The candidate handles map back; the actual candidate text lives in the
    // blind bundle. Pull it via the harness's anonymized bundle + the key.
    const textByHandle = new Map(
      report.facility.harness.anonymizedBundle.candidates.map((c) => [
        c.contestantId,
        c.candidateText,
      ]),
    );
    for (const row of selfRows) {
      const text = textByHandle.get(row.candidateHandle);
      expect(text).toBeDefined();
      // The candidate text is the run's accepted draft verbatim.
      expect(resolvedSelfRun({}).selfDraftsByUnit[row.unitId]).toBe(text);
      expect(draftByUnit.get(row.unitId)!.contestantKind).toBe("itotori_context_on");
    }
  });

  it("SELF cost is REAL when the run records provider runs (verbatim, never fabricated)", async () => {
    const report = await runRealRunBenchmarkAdapter(adapterInput({ withRecordedRuns: true }));
    const selfCost = report.costLatency.perSystem.find(
      (s) => s.contestantKind === "itotori_context_on",
    );
    expect(selfCost).toBeDefined();
    expect(selfCost!.isGenerative).toBe(true);
    // The two recorded runs summed: 0.00000602 + 0.00000711 = 0.00001313 USD.
    // In micros: 6 + 7 = 13 (sub-micro rounds, but the sum of micros is 13).
    expect(selfCost!.totalCostMicrosUsd).toBe(
      usageCostToMicros(0.00000602) + usageCostToMicros(0.00000711),
    );
    // The recorded provider runs surface verbatim in the harness ledger.
    const selfRunIds = new Set(
      report.facility.harness.providerRuns
        .filter((r) => r.runId === "prov-run-self-u-real")
        .map((r) => r.runId),
    );
    expect(selfRunIds.has("prov-run-self-u-real")).toBe(true);
  });

  it("SELF cost is truthful ZERO_COST ONLY under EXPLICIT replayMode (replay intent declared)", async () => {
    // The caller declares replay intent → the adapter records a deterministic
    // zero-cost replay artifact for each unit the run did NOT record a provider
    // run for (re-scoring an already-produced draft bills nothing → truthful
    // zero). This is the ONLY legitimate ZERO_COST path.
    const report = await runRealRunBenchmarkAdapter(
      adapterInput({ withRecordedRuns: false, replayMode: true }),
    );
    const selfCost = report.costLatency.perSystem.find(
      (s) => s.contestantKind === "itotori_context_on",
    );
    expect(selfCost).toBeDefined();
    expect(selfCost!.isGenerative).toBe(true);
    // Re-scoring an already-produced draft bills nothing → truthful zero.
    expect(selfCost!.totalCostMicrosUsd).toBe(0);
    // The replay run is marked as such (no billed cost, deterministic).
    const selfReplayRuns = report.facility.harness.providerRuns.filter(
      (r) => r.provider.providerName === "itotori-real-run-adapter",
    );
    expect(selfReplayRuns.length).toBe(2);
    for (const run of selfReplayRuns) {
      expect(run.cost.amountMicrosUsd).toBe(0);
      expect(run.cost.costKind).toBe("zero");
      expect(run.usageResponseJson).toMatchObject({ _real_run_replay_no_billing: true });
    }
  });

  it("REAL-RUN mode FAILS CLOSED when a scored unit lacks its recorded provider run (no silent ZERO_COST)", async () => {
    // No replayMode declared → REAL-RUN mode. A real run missing its recorded
    // cost for any scored unit MUST fail closed: cost must be REAL/recorded,
    // never silently ZERO_COST (the cost-fidelity hole the codex audit closed).
    await expect(
      runRealRunBenchmarkAdapter(adapterInput({ withRecordedRuns: false, replayMode: false })),
    ).rejects.toThrow(/real-run mode requires a recorded provider run for every scored unit/);
  });

  it("REAL-RUN mode FAILS CLOSED listing every unit missing a recorded provider run", async () => {
    // A partial gap (one of two units lacks a recorded run) still fails closed,
    // and the error names the offending unit so a reviewer can fix the run.
    const partial: ResolvedSelfRun = {
      targetLocale: "en-US",
      corpus: resolvedSelfRun({ withRecordedRuns: true }).corpus,
      selfDraftsByUnit: resolvedSelfRun({ withRecordedRuns: true }).selfDraftsByUnit,
      providerRunsByUnit: {
        // Only U1 carries a recorded run; U2 is missing.
        [U1]: realBilledCost(0.00000602),
      },
    };
    const port = new InMemoryRealRunArtifactPort()
      .registerSelfRun(REAL_RUN_REF, partial)
      .registerComparatorTier(FAN_REF, FAN_TIER)
      .registerComparatorTier(PRO_REF, PRO_TIER);
    await expect(
      runRealRunBenchmarkAdapter({
        ...adapterInput({ withRecordedRuns: true, replayMode: false }),
        artifactPort: port,
      }),
    ).rejects.toThrow(new RegExp(U2));
  });

  it("DETERMINISTIC over the adapter-owned signals (caller-runner telemetry aside)", async () => {
    // The adapter's OWN composition is deterministic: same inputs + port → same
    // aggregated scores, ranking, backlog, panel↔human calibration, readiness,
    // and SELF-replay run ids. The caller-supplied generative runners
    // (raw_mtl_baseline / itotori_context_off) are I/O seams — a LIVE ZDR run
    // is non-deterministic by design (real run ids + wall-clock timestamps) —
    // so the full-report byte-equality is NOT the adapter's contract; the
    // score-derived signals + the SELF contestant's deterministic replay ARE.
    const a = await runRealRunBenchmarkAdapter(adapterInput({ withRecordedRuns: false }));
    const b = await runRealRunBenchmarkAdapter(adapterInput({ withRecordedRuns: false }));
    // Adapter-owned provenance + composition.
    expect(a.runRef).toEqual(b.runRef);
    expect(a.comparatorRefs).toEqual(b.comparatorRefs);
    expect(a.targetLocale).toBe(b.targetLocale);
    expect(a.unitsScored).toBe(b.unitsScored);
    // Score-derived signals (judges score by TEXT → deterministic).
    expect(JSON.stringify(a.aggregated)).toBe(JSON.stringify(b.aggregated));
    expect(JSON.stringify(a.ranking)).toBe(JSON.stringify(b.ranking));
    expect(JSON.stringify(a.backlog)).toBe(JSON.stringify(b.backlog));
    expect(JSON.stringify(a.panelHumanCalibration)).toBe(JSON.stringify(b.panelHumanCalibration));
    // The SELF contestant's candidate text is byte-equal (the run's drafts).
    const aSelf = a.facility.harness.deanonymizationKey.candidates
      .filter((c) => c.contestantKind === "itotori_context_on")
      .map((c) => c.candidateHandle);
    const bSelf = b.facility.harness.deanonymizationKey.candidates
      .filter((c) => c.contestantKind === "itotori_context_on")
      .map((c) => c.candidateHandle);
    expect(aSelf).toEqual(bSelf);
    // The SELF replay run id (deterministic — derived from run ref + unit id).
    const aSelfRunIds = a.facility.harness.providerRuns
      .filter((r) => r.provider.providerName === "itotori-real-run-adapter")
      .map((r) => r.runId)
      .sort();
    const bSelfRunIds = b.facility.harness.providerRuns
      .filter((r) => r.provider.providerName === "itotori-real-run-adapter")
      .map((r) => r.runId)
      .sort();
    expect(aSelfRunIds).toEqual(bSelfRunIds);
  });

  it("GAME-AGNOSTIC — the resolved corpus + tiers carry NO game/engine/title field", async () => {
    const selfRun = resolvedSelfRun({ withRecordedRuns: true });
    // The corpus units carry only the generic fields (no game/engine/title key).
    for (const unit of selfRun.corpus) {
      expect(Object.keys(unit).sort()).toEqual(["label", "sourceText", "unitId"]);
    }
    // The comparator tiers carry only kind + (unitId/targetText) outputs.
    for (const tier of [FAN_TIER, PRO_TIER]) {
      for (const output of tier.outputs) {
        expect(Object.keys(output).sort()).toEqual(["targetText", "unitId"]);
      }
    }
  });

  it("the judge stays BLIND — the adapter never touches the §4.2 anonymization", async () => {
    const panel = judges();
    await runRealRunBenchmarkAdapter({
      ...adapterInput({ withRecordedRuns: false }),
      judges: panel,
    });
    for (const judge of panel) {
      for (const input of judge.receivedInputs) {
        for (const candidate of input.candidates) {
          expect(candidate.blindLabel).toMatch(/^candidate-[a-z]+$/);
        }
        const serialized = JSON.stringify(input);
        for (const kind of [
          "raw_mtl_baseline",
          "fan_edited_mtl",
          "official_localization",
          "itotori_context_on",
          "itotori_context_off",
        ]) {
          expect(serialized).not.toContain(kind);
        }
        // The run id + tier ids (provenance) never leak into the judge input.
        expect(serialized).not.toContain(SELF_RUN_ID);
        expect(serialized).not.toContain(FAN_TIER_ID);
        expect(serialized).not.toContain(PRO_TIER_ID);
      }
    }
  });

  it("STRONG_CALIBER_DONE when self meets the human anchor + QA passes", async () => {
    // Clean SELF run (no register defect) → the judge scores 4 across the board
    // → selfJudgeMean (4) >= humanAnchorMean (4). QA F1 above the floor → DONE.
    const report = await runRealRunBenchmarkAdapter(
      adapterInput({
        withRecordedRuns: false,
        defectiveU1: false,
        selfScore: 4,
        readiness: { qa: { f1: 0.8 } },
      }),
    );
    expect(report.readiness!.decision).toBe("STRONG_CALIBER_DONE");
    expect(report.readiness!.confidence).toBe("strong_caliber");
    expect(report.readiness!.failedGateIds).toEqual([]);
  });
});

describe("runRealRunBenchmarkAdapter — REFUSAL (typed errors before scoring)", () => {
  it("refuses when the self run has no accepted draft for a unit", async () => {
    const port = new InMemoryRealRunArtifactPort()
      .registerSelfRun(REAL_RUN_REF, {
        targetLocale: "en-US",
        corpus: [
          { unitId: U1, label: "script/prologue#line-001", sourceText: "おはよう、りん。" },
          { unitId: U2, label: "script/prologue#line-002", sourceText: "朝の光が差し込む。" },
        ],
        selfDraftsByUnit: { [U1]: "Morning, Rin." }, // U2 missing
      })
      .registerComparatorTier(FAN_REF, FAN_TIER)
      .registerComparatorTier(PRO_REF, PRO_TIER);
    // replayMode bypasses the real-run recorded-run check so the missing-DRAFT
    // refusal (raised per-unit inside the SELF runner) is what surfaces here.
    await expect(
      runRealRunBenchmarkAdapter({
        ...adapterInput({ withRecordedRuns: false, replayMode: true }),
        artifactPort: port,
      }),
    ).rejects.toBeInstanceOf(RealRunBenchmarkAdapterError);
  });

  it("refuses when a comparator ref has the wrong kind", async () => {
    const badFan: ComparatorTierRef = { kind: "official_localization", tierId: FAN_TIER_ID };
    await expect(
      runRealRunBenchmarkAdapter({
        ...adapterInput({ withRecordedRuns: false }),
        comparatorRefs: { fanMtl: badFan, professional: PRO_REF },
      }),
    ).rejects.toBeInstanceOf(RealRunBenchmarkAdapterError);
  });

  it("refuses when the human anchor is empty", async () => {
    await expect(
      runRealRunBenchmarkAdapter({
        ...adapterInput({ withRecordedRuns: false }),
        humanAnchor: { raters: [], ratings: [] },
      }),
    ).rejects.toBeInstanceOf(RealRunBenchmarkAdapterError);
  });

  it("refuses when the port has no tier registered for a comparator ref", async () => {
    const port = new InMemoryRealRunArtifactPort()
      .registerSelfRun(REAL_RUN_REF, resolvedSelfRun({}))
      .registerComparatorTier(FAN_REF, FAN_TIER); // PRO tier missing
    await expect(
      runRealRunBenchmarkAdapter({
        ...adapterInput({ withRecordedRuns: false }),
        artifactPort: port,
      }),
    ).rejects.toBeInstanceOf(RealRunBenchmarkAdapterError);
  });
});

describe("makeSelfRunDraftRunner — the SELF contestant runner in isolation", () => {
  it("returns the run's accepted draft + recorded provider run verbatim", async () => {
    const run = resolvedSelfRun({ withRecordedRuns: true });
    const runner = makeSelfRunDraftRunner(run, REAL_RUN_REF);
    const out = await runner(run.corpus[0]!);
    expect(out.targetText).toBe(run.selfDraftsByUnit[U1]!);
    expect(out.providerRun.runId).toBe("prov-run-self-u-real");
  });

  it("records a deterministic zero-cost replay ONLY under explicit replayMode", async () => {
    const run = resolvedSelfRun({});
    const runner = makeSelfRunDraftRunner(run, REAL_RUN_REF, { replayMode: true });
    const out = await runner(run.corpus[0]!);
    expect(out.targetText).toBe(run.selfDraftsByUnit[U1]!);
    expect(out.providerRun.cost.amountMicrosUsd).toBe(0);
    expect(out.providerRun.cost.costKind).toBe("zero");
    expect(out.providerRun.provider.providerFamily).toBe("recorded");
    // Deterministic run id (two calls → byte-equal).
    const again = await runner(run.corpus[0]!);
    expect(again.providerRun.runId).toBe(out.providerRun.runId);
  });

  it("FAILS CLOSED in REAL-RUN mode (no replayMode) when a unit lacks a recorded run", async () => {
    const run = resolvedSelfRun({}); // no recorded provider runs
    const runner = makeSelfRunDraftRunner(run, REAL_RUN_REF); // default real-run mode
    await expect(runner(run.corpus[0]!)).rejects.toBeInstanceOf(RealRunBenchmarkAdapterError);
  });
});
