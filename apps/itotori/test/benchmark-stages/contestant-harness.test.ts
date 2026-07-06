// benchmark-contestant-harness (§6) — synthetic-contestant tests.
//
// Proves, on synthetic fixtures with a FAKE provider (NO real LLM calls):
//   - all five §6 contestants are collected per source unit;
//   - every contestant is provenance-anonymized — no system identity is
//     recoverable from the blind bundle (the marquee test);
//   - the Itotori context-ON / context-OFF ABLATION is first-class + distinct;
//   - the MTL baseline generation path is wired (real provider call → cost read
//     VERBATIM from the provider run, never approximated — fake = zero here);
//   - the outputs are shaped for the deterministic metrics + the judge panel
//     (the blind candidates feed `buildDecodedContextFeed` directly).

import { describe, expect, it } from "vitest";
import {
  ContestantBlindingError,
  ContestantHarnessError,
  GENERATIVE_CONTESTANT_KINDS,
  assertContestantBundleBlind,
  buildDecodedContextFeed,
  deanonymizeCandidate,
  deanonymizeSystem,
  makeRawMtlBaselineRunner,
  runContestantHarness,
  type AnonymizedContestantBundle,
  type ContestantCorpusUnit,
  type ContestantHarnessInput,
  type GenerativeContestantRunner,
  type GeneratedContestantOutput,
} from "../../src/benchmark-stages/index.js";
import { FakeModelProvider } from "../../src/providers/fake.js";
import type { NarrativeStructure } from "../../src/agents/structure-informed-context/index.js";

const U1 = "019ed010-0000-7000-8000-0000000000b1";
const U2 = "019ed010-0000-7000-8000-0000000000b2";

function corpus(): ContestantCorpusUnit[] {
  return [
    { unitId: U1, label: "script/prologue#line-001", sourceText: "おはよう、りん。" },
    { unitId: U2, label: "script/prologue#line-002", sourceText: "朝の光が差し込む。" },
  ];
}

/** A tagged fake-provider runner — distinct output per contestant so the
 * ablation on/off pair is verifiably different. Cost comes from the fake run
 * (zero) — the harness reads it verbatim; no fabricated cost literal here. */
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

function baseInput(saltOverride?: string): ContestantHarnessInput {
  return {
    targetLocale: "en-US",
    corpus: corpus(),
    generativeRunners: {
      raw_mtl_baseline: taggedRunner("mtl"),
      itotori_context_on: taggedRunner("ion"),
      itotori_context_off: taggedRunner("ioff"),
    },
    corpusContestants: {
      fan_edited_mtl: [
        { unitId: U1, targetText: "Morning, Rin." },
        { unitId: U2, targetText: "Morning light streams in." },
      ],
      official_localization: [
        { unitId: U1, targetText: "Good morning, Rin." },
        { unitId: U2, targetText: "The morning light pours in." },
      ],
    },
    anonymizationSalt: saltOverride ?? "run-secret-salt-2026-07-05",
  };
}

describe("runContestantHarness — collects the §6 contestant set", () => {
  it("collects all five contestants per source unit", async () => {
    const result = await runContestantHarness(baseInput());
    // 5 contestants × 2 units.
    expect(result.anonymizedBundle.candidates).toHaveLength(10);
    for (const unitId of [U1, U2]) {
      const forUnit = result.anonymizedBundle.candidates.filter((c) => c.unitId === unitId);
      expect(forUnit).toHaveLength(5);
      // distinct opaque handles per unit.
      expect(new Set(forUnit.map((c) => c.contestantId)).size).toBe(5);
    }
    // Every contestant kind is present in the (private) key.
    const kinds = new Set(result.deanonymizationKey.systems.map((s) => s.contestantKind));
    expect(kinds).toEqual(
      new Set([
        "raw_mtl_baseline",
        "fan_edited_mtl",
        "official_localization",
        "itotori_context_on",
        "itotori_context_off",
      ]),
    );
  });

  it("keeps the Itotori context-ON / context-OFF ablation first-class + distinct", async () => {
    const result = await runContestantHarness(baseInput());
    const on = result.deanonymizationKey.systems.find(
      (s) => s.contestantKind === "itotori_context_on",
    );
    const off = result.deanonymizationKey.systems.find(
      (s) => s.contestantKind === "itotori_context_off",
    );
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    // Distinct systems with distinct handles.
    expect(on!.systemHandle).not.toBe(off!.systemHandle);

    // And their rendered texts differ per unit (a real ablation signal).
    const onHandleU1 = result.deanonymizationKey.candidates.find(
      (c) => c.contestantKind === "itotori_context_on" && c.unitId === U1,
    )!.candidateHandle;
    const offHandleU1 = result.deanonymizationKey.candidates.find(
      (c) => c.contestantKind === "itotori_context_off" && c.unitId === U1,
    )!.candidateHandle;
    const onText = result.anonymizedBundle.candidates.find(
      (c) => c.contestantId === onHandleU1,
    )!.candidateText;
    const offText = result.anonymizedBundle.candidates.find(
      (c) => c.contestantId === offHandleU1,
    )!.candidateText;
    expect(onText).not.toBe(offText);
  });
});

describe("runContestantHarness — provenance anonymization (§4.2 / §6.1)", () => {
  it("emits a blind bundle from which NO system identity is recoverable", async () => {
    const result = await runContestantHarness(baseInput());
    const { anonymizedBundle: bundle, deanonymizationKey: key } = result;

    // (1) The in-code blinding asserter passes on the emitted bundle.
    expect(() => assertContestantBundleBlind(bundle, { deanonymizationKey: key })).not.toThrow();

    // (2) The bundle structurally carries NO identity field. Every candidate id
    //     and metric systemId is an opaque UUID7 handle; there is no
    //     contestantKind / systemName / displayName / provenance anywhere.
    const identityFields = ["contestantKind", "systemName", "displayName", "provenance", "kind"];
    const serialized = JSON.stringify(bundle);
    for (const field of identityFields) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    // Every metric input carries the neutral blind systemKind (not the real one).
    for (const system of bundle.metricInputs) {
      expect(system.systemKind).toBe("deterministic_fixture");
    }

    // (3) The mapping handle→kind is ONLY available via the private key. A
    //     consumer holding just the bundle has no join: prove the handles are
    //     salt-dependent (so not recomputable from public inputs) by re-running
    //     the SAME corpus under a DIFFERENT secret salt — every handle changes.
    const other = await runContestantHarness(baseInput("a-completely-different-salt"));
    const handlesA = new Set(bundle.candidates.map((c) => c.contestantId));
    for (const c of other.anonymizedBundle.candidates) {
      expect(handlesA.has(c.contestantId)).toBe(false);
    }

    // (4) De-anonymization REQUIRES the key and round-trips correctly.
    for (const candidate of bundle.candidates) {
      const resolved = deanonymizeCandidate(key, candidate.contestantId);
      const expectedRow = key.candidates.find(
        (row) => row.candidateHandle === candidate.contestantId,
      )!;
      expect(resolved.contestantKind).toBe(expectedRow.contestantKind);
      expect(resolved.unitId).toBe(candidate.unitId);
    }
    for (const system of bundle.metricInputs) {
      expect(deanonymizeSystem(key, system.systemId)).toBeDefined();
    }
  });

  it("randomizes contestant order within a unit (position never tracks identity)", async () => {
    const result = await runContestantHarness(baseInput());
    const key = result.deanonymizationKey;
    // The per-unit candidate order is by opaque salt-derived handle, so the
    // contestant-kind sequence within a unit is NOT the input order.
    const u1Order = result.anonymizedBundle.candidates
      .filter((c) => c.unitId === U1)
      .map((c) => deanonymizeCandidate(key, c.contestantId).contestantKind);
    const inputOrder = [
      "raw_mtl_baseline",
      "itotori_context_on",
      "itotori_context_off",
      "fan_edited_mtl",
      "official_localization",
    ];
    // Same members, but generally a different sequence (salt-shuffled).
    expect(new Set(u1Order)).toEqual(new Set(inputOrder));
    expect(u1Order.join(",")).not.toBe(inputOrder.join(","));
  });

  it("throws when a bundle leaks provenance", async () => {
    const result = await runContestantHarness(baseInput());
    // (a) a candidate id that is not an opaque handle.
    const leakyHandle: AnonymizedContestantBundle = {
      ...result.anonymizedBundle,
      candidates: [
        { contestantId: "official_localization-U1", unitId: U1, candidateText: "x" },
        ...result.anonymizedBundle.candidates.slice(1),
      ],
    };
    expect(() => assertContestantBundleBlind(leakyHandle)).toThrow(ContestantBlindingError);

    // (b) an identity-bearing field grafted onto a candidate.
    const leakyField: AnonymizedContestantBundle = {
      ...result.anonymizedBundle,
      candidates: [
        {
          ...result.anonymizedBundle.candidates[0],
          contestantKind: "official_localization",
        } as never,
        ...result.anonymizedBundle.candidates.slice(1),
      ],
    };
    expect(() => assertContestantBundleBlind(leakyField)).toThrow(/identity-bearing field/);

    // (c) a non-neutral metric systemKind.
    const leakyKind: AnonymizedContestantBundle = {
      ...result.anonymizedBundle,
      metricInputs: [
        { ...result.anonymizedBundle.metricInputs[0], systemKind: "itotori_draft" },
        ...result.anonymizedBundle.metricInputs.slice(1),
      ],
    };
    expect(() => assertContestantBundleBlind(leakyKind)).toThrow(/non-neutral systemKind/);
  });
});

describe("runContestantHarness — cost wiring (§11.1) + metrics/judge shape", () => {
  it("reads generative cost/latency VERBATIM from the provider run; corpus = N/A", async () => {
    const result = await runContestantHarness(baseInput());

    // One provider run per generative contestant × unit (3 kinds × 2 units).
    expect(result.providerRuns).toHaveLength(GENERATIVE_CONTESTANT_KINDS.length * 2);

    for (const system of result.deanonymizationKey.systems) {
      if (system.isGenerative) {
        // Cost is the SUM of the real per-unit run costs — copied, not fabricated.
        const rows = result.deanonymizationKey.candidates.filter(
          (c) => c.contestantKind === system.contestantKind,
        );
        const summed = rows.reduce((acc, r) => acc + (r.costMicrosUsd ?? 0), 0);
        expect(system.totalCostMicrosUsd).toBe(summed);
        expect(system.providerRunIds.length).toBe(2);
        // Every row's cost came from a real provider run (a number, not null).
        for (const row of rows) {
          expect(typeof row.costMicrosUsd).toBe("number");
          expect(row.providerRunId).not.toBeNull();
        }
      } else {
        // Corpus tiers (fan/official) have no runtime cost/latency (§11.1).
        expect(system.totalCostMicrosUsd).toBeNull();
        expect(system.totalLatencyMs).toBeNull();
        expect(system.providerRunIds).toHaveLength(0);
      }
    }
  });

  it("emits outputs the deterministic metrics + judge panel consume", async () => {
    const result = await runContestantHarness(baseInput());

    // Metric inputs: one blind system per contestant, each covering every unit.
    expect(result.anonymizedBundle.metricInputs).toHaveLength(5);
    for (const system of result.anonymizedBundle.metricInputs) {
      expect(system.units.map((u) => u.unitId).sort()).toEqual([U1, U2].sort());
      for (const unit of system.units) {
        expect(unit.sourceText.length).toBeGreaterThan(0);
        expect(unit.targetText.length).toBeGreaterThan(0);
      }
    }

    // Judge panel: the blind candidates feed buildDecodedContextFeed directly.
    const structure: NarrativeStructure = {
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
    const feed = buildDecodedContextFeed({
      structure,
      unitRefs: [
        { unitId: U1, sceneId: 2031, messageOrder: 0 },
        { unitId: U2, sceneId: 2031, messageOrder: 1 },
      ],
      candidates: result.anonymizedBundle.candidates,
    });
    expect(feed).toHaveLength(2);
    for (const unit of feed) {
      expect(unit.candidates).toHaveLength(5);
    }
  });
});

describe("makeRawMtlBaselineRunner — the MTL generation path", () => {
  it("produces a translated unit + provider run from a provider call", async () => {
    const runner = taggedRunner("mtl");
    const out: GeneratedContestantOutput = await runner(corpus()[0]);
    expect(out.targetText).toContain("[mtl]");
    expect(out.providerRun.taskKind).toBe("draft_translation");
    expect(out.providerRun.cost.costKind).toBe("zero");
  });

  it("refuses empty provider content", async () => {
    const runner = makeRawMtlBaselineRunner({
      provider: new FakeModelProvider({ generate: () => "   " }),
      modelId: "itotori-fake",
      providerId: "fake-fixture",
      targetLocale: "en-US",
      sourceLocale: "ja-JP",
      inputClassification: "synthetic_public",
    });
    await expect(runner(corpus()[0])).rejects.toThrow(ContestantHarnessError);
  });
});

describe("runContestantHarness — structured refusals", () => {
  it("refuses an empty anonymization salt", async () => {
    await expect(runContestantHarness({ ...baseInput(), anonymizationSalt: "" })).rejects.toThrow(
      /non-empty secret/,
    );
  });

  it("refuses an empty corpus", async () => {
    await expect(runContestantHarness({ ...baseInput(), corpus: [] })).rejects.toThrow(
      /zero source units/,
    );
  });

  it("refuses a duplicate corpus unit", async () => {
    const input = baseInput();
    input.corpus = [...corpus(), corpus()[0]];
    await expect(runContestantHarness(input)).rejects.toThrow(/duplicate corpus unitId/);
  });

  it("refuses a corpus-input contestant missing a unit", async () => {
    const input = baseInput();
    input.corpusContestants.official_localization = [{ unitId: U1, targetText: "only one" }];
    await expect(runContestantHarness(input)).rejects.toThrow(/is missing unit/);
  });

  it("refuses a corpus-input contestant referencing an unknown unit", async () => {
    const input = baseInput();
    input.corpusContestants.fan_edited_mtl = [
      { unitId: U1, targetText: "a" },
      { unitId: U2, targetText: "b" },
      { unitId: "019ed010-0000-7000-8000-0000000000ff", targetText: "ghost" },
    ];
    await expect(runContestantHarness(input)).rejects.toThrow(/unknown source unit/);
  });

  it("refuses a missing generative runner", async () => {
    const input = baseInput();
    // Drop the ablation-off runner — the ablation is non-optional.
    delete (input.generativeRunners as Record<string, unknown>).itotori_context_off;
    await expect(runContestantHarness(input)).rejects.toThrow(/missing generative runner/);
  });
});
