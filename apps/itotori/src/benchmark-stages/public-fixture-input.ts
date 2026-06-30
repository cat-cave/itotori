// ITOTORI-090/091/092 — Public-fixture ingredient projection.
//
// Projects the checked-in public benchmark-stages fixture JSON into the typed
// inputs each real stage consumes. The fixture carries only public-safe data
// (public unit ids/text, RECORDED provider runs + model-output ids, seeded
// oracle truth) — no private corpora, no live provider credentials, no raw
// prompts/responses. A malformed fixture surfaces as a thrown structured error
// rather than a silently empty run.

import type {
  BenchmarkCommandLineV02,
  BenchmarkInputRefV02,
  BenchmarkRunStatusV02,
  BenchmarkSeededDefectOracleV02,
  BenchmarkToolVersionV02,
  HumanEvaluationResultV02,
} from "@itotori/localization-bridge-schema";
import type { QaAgentRecordedRun } from "./qa-agent-evaluation.js";
import type { RawMtlCorpusUnit, RawMtlRecordedSystem } from "./raw-mtl-baseline.js";

export type BenchmarkStagesReportMeta = {
  benchmarkName: string;
  createdAt: string;
  status: BenchmarkRunStatusV02;
  sourceLocale: string;
  targetLocale: string;
  // ITOTORI-059 — locale branch the benchmark run belongs to (required so the
  // assembled report + cost ledger self-identify their branch).
  localeBranchId: string;
  engineProfile: string;
  gitCommit: string;
  deterministicSeed?: string;
  toolVersions: BenchmarkToolVersionV02[];
  commandLines: BenchmarkCommandLineV02[];
  knownBlindSpots: string[];
};

export type BenchmarkStagesPublicFixture = {
  reportMeta: BenchmarkStagesReportMeta;
  fixtureOrCorpusRefs: BenchmarkInputRefV02[];
  corpusTargetLocale: string;
  corpus: RawMtlCorpusUnit[];
  recordedSystems: RawMtlRecordedSystem[];
  deterministicQa: { startedAt: string; completedAt: string };
  qaAgents: QaAgentRecordedRun[];
  seededDefectOracle: BenchmarkSeededDefectOracleV02[];
  humanEvaluationResults: HumanEvaluationResultV02[];
};

export class BenchmarkStagesFixtureError extends Error {
  constructor(detail: string) {
    super(`benchmark-stages fixture invalid: ${detail}`);
    this.name = "BenchmarkStagesFixtureError";
  }
}

export function loadBenchmarkStagesFixture(raw: unknown): BenchmarkStagesPublicFixture {
  const record = asRecord(raw, "fixture");
  const fixture = {
    reportMeta: asRecord(record.reportMeta, "reportMeta"),
    fixtureOrCorpusRefs: asArray(record.fixtureOrCorpusRefs, "fixtureOrCorpusRefs"),
    corpusTargetLocale: asString(record.corpusTargetLocale, "corpusTargetLocale"),
    corpus: asArray(record.corpus, "corpus"),
    recordedSystems: asArray(record.recordedSystems, "recordedSystems"),
    deterministicQa: asRecord(record.deterministicQa, "deterministicQa"),
    qaAgents: asArray(record.qaAgents, "qaAgents"),
    seededDefectOracle: asArray(record.seededDefectOracle, "seededDefectOracle"),
    humanEvaluationResults: asArray(record.humanEvaluationResults, "humanEvaluationResults"),
  };
  return fixture as unknown as BenchmarkStagesPublicFixture;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BenchmarkStagesFixtureError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BenchmarkStagesFixtureError(`${label} must be an array`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BenchmarkStagesFixtureError(`${label} must be a non-empty string`);
  }
  return value;
}
