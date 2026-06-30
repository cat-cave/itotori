// ITOTORI-090 — Raw MTL baseline benchmark stage.
//
// Consumes a benchmark set manifest target locale + RECORDED machine-translation
// outputs (public fixture; no live provider credentials) and produces the
// `raw_mtl_baseline` (and any other compared) system records, their
// provider-run cost records, and the per-unit baseline translated-text
// references that the deterministic-QA stage scores.
//
// The stage owns NO provider routing: every provider-run cost record is the
// RECORDED artifact verbatim (the harness only injects the systemId so a run
// is anchored to its compared system). Provenance — source unit ids, provider/
// model metadata, fixture-safe translated text references — is preserved, and a
// missing baseline system / dangling unit reference is raised as a structured
// failure rather than silently dropped.

import type {
  BenchmarkArtifactRefV02,
  BenchmarkComparedSystemV02,
  BenchmarkProviderRunV02,
  BenchmarkSystemKindV02,
} from "@itotori/localization-bridge-schema";

/** A source unit the baseline translates. Fixture-safe (public ids + text). */
export type RawMtlCorpusUnit = {
  /** UUID7 bridge-unit id. */
  unitId: string;
  /** Human-readable locator, e.g. `script/prologue#line-001`. */
  label: string;
  sourceText: string;
};

/** A recorded compared system: its metadata + recorded provider run + outputs. */
export type RawMtlRecordedSystem = {
  systemId: string;
  systemKind: BenchmarkSystemKindV02;
  displayName: string;
  generatedAt: string;
  promptPresetId: string;
  promptPresetVersion?: string;
  outputArtifactRef?: BenchmarkArtifactRefV02;
  /** Recorded provider-run cost record (systemId is injected by the stage). */
  providerRun: Omit<BenchmarkProviderRunV02, "systemId">;
  /** Recorded translated text per source unit. */
  translatedUnits: { unitId: string; targetText: string }[];
};

export type RawMtlBaselineInput = {
  /** Target locale carried over from the ITOTORI-089 benchmark set manifest. */
  targetLocale: string;
  /** Declared target locale of the recorded corpus (must match the manifest). */
  corpusTargetLocale: string;
  corpus: RawMtlCorpusUnit[];
  recordedSystems: RawMtlRecordedSystem[];
};

/** A single system's per-unit baseline output, consumed by deterministic QA. */
export type RawMtlBaselineSystemOutput = {
  systemId: string;
  systemKind: BenchmarkSystemKindV02;
  units: Array<{
    unitId: string;
    label: string;
    sourceText: string;
    targetText: string;
  }>;
};

export type RawMtlBaselineResult = {
  systems: BenchmarkComparedSystemV02[];
  providerRuns: BenchmarkProviderRunV02[];
  baselineOutputs: RawMtlBaselineSystemOutput[];
};

/** Raised when the recorded baseline inputs are missing or inconsistent. */
export class RawMtlBaselineError extends Error {
  constructor(detail: string) {
    super(`raw-mtl-baseline stage refused: ${detail}`);
    this.name = "RawMtlBaselineError";
  }
}

export function runRawMtlBaselineStage(input: RawMtlBaselineInput): RawMtlBaselineResult {
  if (input.corpusTargetLocale !== input.targetLocale) {
    throw new RawMtlBaselineError(
      `recorded corpus targetLocale '${input.corpusTargetLocale}' does not match benchmark set manifest targetLocale '${input.targetLocale}'`,
    );
  }
  if (input.corpus.length === 0) {
    throw new RawMtlBaselineError("benchmark set manifest selected zero source units");
  }
  const corpusById = new Map<string, RawMtlCorpusUnit>();
  for (const unit of input.corpus) {
    if (corpusById.has(unit.unitId)) {
      throw new RawMtlBaselineError(`duplicate corpus unitId '${unit.unitId}'`);
    }
    corpusById.set(unit.unitId, unit);
  }
  if (input.recordedSystems.length === 0) {
    throw new RawMtlBaselineError("no recorded systems to compare");
  }
  if (!input.recordedSystems.some((system) => system.systemKind === "raw_mtl_baseline")) {
    throw new RawMtlBaselineError(
      "recorded systems contain no compared system with systemKind 'raw_mtl_baseline'",
    );
  }

  const systems: BenchmarkComparedSystemV02[] = [];
  const providerRuns: BenchmarkProviderRunV02[] = [];
  const baselineOutputs: RawMtlBaselineSystemOutput[] = [];
  const seenSystemIds = new Set<string>();

  for (const recorded of input.recordedSystems) {
    if (seenSystemIds.has(recorded.systemId)) {
      throw new RawMtlBaselineError(`duplicate systemId '${recorded.systemId}'`);
    }
    seenSystemIds.add(recorded.systemId);
    if (recorded.translatedUnits.length === 0) {
      throw new RawMtlBaselineError(
        `recorded system '${recorded.systemId}' has no translated units`,
      );
    }

    const units: RawMtlBaselineSystemOutput["units"] = [];
    for (const translated of recorded.translatedUnits) {
      const corpusUnit = corpusById.get(translated.unitId);
      if (corpusUnit === undefined) {
        throw new RawMtlBaselineError(
          `recorded system '${recorded.systemId}' references unknown source unit '${translated.unitId}'`,
        );
      }
      units.push({
        unitId: corpusUnit.unitId,
        label: corpusUnit.label,
        sourceText: corpusUnit.sourceText,
        targetText: translated.targetText,
      });
    }

    const providerRun: BenchmarkProviderRunV02 = {
      ...recorded.providerRun,
      systemId: recorded.systemId,
    };
    providerRuns.push(providerRun);

    systems.push({
      systemId: recorded.systemId,
      systemKind: recorded.systemKind,
      displayName: recorded.displayName,
      generatedAt: recorded.generatedAt,
      providerRunIds: [providerRun.providerRunId],
      promptPresetId: recorded.promptPresetId,
      ...(recorded.promptPresetVersion !== undefined
        ? { promptPresetVersion: recorded.promptPresetVersion }
        : {}),
      ...(recorded.outputArtifactRef !== undefined
        ? { outputArtifactRef: recorded.outputArtifactRef }
        : {}),
    });

    baselineOutputs.push({
      systemId: recorded.systemId,
      systemKind: recorded.systemKind,
      units,
    });
  }

  return { systems, providerRuns, baselineOutputs };
}
