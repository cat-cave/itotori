// ALPHA-003 — Alpha readiness cost and quality benchmark regression suite.
//
// Proves the composition (a) decides alpha pass/fail from the PUBLIC-fixture
// benchmark, (b) includes the raw-MTL baseline, (c) sources cost ONLY from the
// recomputed ledger and carries real token provenance (tokenCountSource) plus
// (model, provider) metadata, (d) records a private-local aggregate as
// supplementary ONLY (never gating, never leaking contents), and (e) renders a
// README-safe summary that carries no unverifiable claim and never leaks
// private contents.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  benchmarkSetReadModelFromSeedsFixture,
  benchmarkSetSelectionInputFromSetsFixture,
  buildPublicBenchmarkHarnessStages,
  loadBenchmarkStagesFixture,
  runBenchmarkHarnessCommand,
  type BenchmarkHarnessRunManifest,
  type BenchmarkStagesPublicFixture,
  type PublicBenchmarkHarnessFixtureInputs,
} from "../src/benchmark-harness/index.js";
import { composeExperimentBenchmarkReport } from "../src/experiment-report/index.js";
import {
  ALPHA_READINESS_REPORT_SCHEMA_VERSION,
  README_BANNED_CLAIM_TERMS,
  composeAlphaReadiness,
  renderReadmeSafeAlphaSummary,
  type AlphaReadinessComposeInput,
  type AlphaReadinessCostQualityArtifact,
} from "../src/alpha-readiness/index.js";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import {
  buildAlphaProviderProofSummary,
  runRecordedProviderProof,
} from "../src/provider-proof/index.js";
import type { AlphaProviderProofSummary } from "@itotori/localization-bridge-schema";

const repoRoot = new URL("../../../", import.meta.url);

function readRepoJson(repoRelativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(repoRelativePath, repoRoot), "utf8"));
}

const SEEDS_FIXTURE_PATH = "fixtures/catalog-benchmark-seeds/fixture.json";
const SETS_FIXTURE_PATH = "fixtures/catalog-benchmark-sets/fixture.json";
const STAGES_FIXTURE_PATH = "fixtures/benchmark-stages/public-fixture.json";
const EXPERIMENT_MANIFEST_FIXTURE_PATH =
  "fixtures/itotori-experiment-report/experiment-matrix-run-manifest.json";
const ROUTE_REPORT_FIXTURE_PATH = "fixtures/itotori-experiment-report/provider-route-report.json";

const BENCHMARK_DIR = "artifacts/test/alpha-readiness/benchmark";
const PROVIDER_PROOF_PATH = "artifacts/test/alpha-readiness/provider-proof/attachment.json";

function stagesFixture(): BenchmarkStagesPublicFixture {
  return loadBenchmarkStagesFixture(readRepoJson(STAGES_FIXTURE_PATH));
}

function publicFixtureInputs(
  overrides?: Partial<BenchmarkStagesPublicFixture>,
): PublicBenchmarkHarnessFixtureInputs {
  const readModel = benchmarkSetReadModelFromSeedsFixture(readRepoJson(SEEDS_FIXTURE_PATH));
  return {
    benchmarkSetReadModel: readModel,
    benchmarkSetSelectionInput: benchmarkSetSelectionInputFromSetsFixture(
      readRepoJson(SETS_FIXTURE_PATH),
      readModel.targetLanguage,
    ),
    stagesFixture: { ...stagesFixture(), ...overrides },
  };
}

/** Run the harness over the public fixtures and capture its artifacts. */
async function runHarness(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): Promise<{ manifest: BenchmarkHarnessRunManifest; writes: Map<string, unknown> }> {
  const writes = new Map<string, unknown>();
  const manifest = await runBenchmarkHarnessCommand({
    benchmarkRunId: "019ed026-0000-7000-8000-000000000001",
    benchmarkName: "alpha readiness public-fixture benchmark run",
    generatedAt: "2026-06-30T00:00:00.000Z",
    outputDir: BENCHMARK_DIR,
    stages: buildPublicBenchmarkHarnessStages(inputs),
    io: { writeJson: (path, value) => writes.set(path, value) },
  });
  return { manifest, writes };
}

function experimentComposition(): ReturnType<typeof composeExperimentBenchmarkReport> {
  const artifacts = new Map<string, unknown>([
    [EXPERIMENT_MANIFEST_FIXTURE_PATH, readRepoJson(EXPERIMENT_MANIFEST_FIXTURE_PATH)],
    [ROUTE_REPORT_FIXTURE_PATH, readRepoJson(ROUTE_REPORT_FIXTURE_PATH)],
  ]);
  return composeExperimentBenchmarkReport({
    experimentManifestRef: {
      artifactName: "experiment-matrix run manifest",
      artifactPath: EXPERIMENT_MANIFEST_FIXTURE_PATH,
    },
    providerRouteReportRef: {
      artifactName: "provider route report",
      artifactPath: ROUTE_REPORT_FIXTURE_PATH,
    },
    readArtifact: (ref) => {
      const value = artifacts.get(ref.artifactPath);
      if (value === undefined) {
        throw new Error(`ENOENT ${ref.artifactPath}`);
      }
      return value;
    },
    generatedAt: "2026-06-30T00:00:00.000Z",
  });
}

async function recordedProviderProofSummary(): Promise<AlphaProviderProofSummary> {
  const result = await runRecordedProviderProof();
  if (result.status !== "passed") {
    throw new Error("recorded provider-proof should pass");
  }
  return buildAlphaProviderProofSummary(result.bundle);
}

async function composeInput(
  overrides?: Partial<BenchmarkStagesPublicFixture>,
  inputOverrides?: Partial<AlphaReadinessComposeInput>,
): Promise<AlphaReadinessComposeInput> {
  const { manifest, writes } = await runHarness(publicFixtureInputs(overrides));
  const costQualityArtifact = writes.get(
    `${BENCHMARK_DIR}/cost-quality-report.json`,
  ) as AlphaReadinessCostQualityArtifact;
  return {
    runManifest: manifest,
    costQualityArtifact,
    experimentComposition: experimentComposition(),
    providerProofArtifactPath: PROVIDER_PROOF_PATH,
    providerProofSummary: await recordedProviderProofSummary(),
    generatedAt: "2026-06-30T00:00:00.000Z",
    ...inputOverrides,
  };
}

describe("alpha readiness — public-fixture composition", () => {
  it("passes every gate and links the benchmark + provider-proof artifacts", async () => {
    const report = composeAlphaReadiness(await composeInput());

    expect(report.schemaVersion).toBe(ALPHA_READINESS_REPORT_SCHEMA_VERSION);
    expect(report.decision).toBe("pass");
    expect(report.decidedBy).toBe("public_fixture_benchmark");
    expect(report.failedGateIds).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.gates.every((gate) => gate.status === "pass")).toBe(true);
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "benchmark-run-succeeded",
      "mtl-baseline-included",
      "cost-ledger-attributed",
      "quality-evidence-present",
      "provider-proof-reconciled",
      "provider-proof-bundle-consumed",
    ]);

    // ALPHA-008 — the real-call provider-proof bundle is consumed as evidence:
    // structured output accepted for both roles, all served routes ZDR-enforced.
    expect(report.providerProofBundle).not.toBeNull();
    expect(report.providerProofBundle?.mode).toBe("recorded");
    expect(report.providerProofBundle?.zdr.allLedgerRoutesZdr).toBe(true);
    expect(
      report.providerProofBundle?.structuredOutputSupport.every((entry) => entry.accepted),
    ).toBe(true);

    // Links resolve to the harness-named report artifacts + the provider proof.
    expect(report.links.benchmarkSeedSelection.artifactPath).toBe(
      `${BENCHMARK_DIR}/benchmark-set-selection.json`,
    );
    expect(report.links.benchmarkSeedSelection.artifactHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.links.qualityReport.artifactPath).toBe(
      `${BENCHMARK_DIR}/cost-quality-report.json`,
    );
    expect(report.links.providerProof.artifactPath).toBe(PROVIDER_PROOF_PATH);
    expect(report.links.benchmarkRunManifest.artifactPath).toBe(
      `${BENCHMARK_DIR}/run-manifest.json`,
    );
  });

  it("includes the raw-MTL baseline", async () => {
    const report = composeAlphaReadiness(await composeInput());
    expect(report.mtlBaseline.included).toBe(true);
    expect(report.mtlBaseline.systems.some((s) => s.systemKind === "raw_mtl_baseline")).toBe(true);
  });

  it("sources cost ONLY from the recomputed ledger with token provenance + (model, provider) metadata", async () => {
    const input = await composeInput();
    const report = composeAlphaReadiness(input);

    // The cost total equals the validated report's recomputed ledger total
    // (micros) and its USD restatement is exactly /1e6.
    const ledgerMicros = input.costQualityArtifact.report.costLedger.reportTotalMicrosUsd;
    expect(report.cost.source).toBe("benchmark_cost_ledger");
    expect(report.cost.reportTotalMicrosUsd).toBe(ledgerMicros);
    expect(report.cost.reportTotalUsd).toBe(ledgerMicros / 1e6);
    expect(report.cost.includesUnknownCost).toBe(false);

    // Every per-run row carries the (model, provider) identity AND the real
    // token-count provenance restated verbatim from the validated record.
    expect(report.cost.perProviderRun.length).toBeGreaterThan(0);
    const records = input.costQualityArtifact.report.providerModelCostRecords;
    for (const row of report.cost.perProviderRun) {
      const source = records.find((r) => r.providerRunId === row.providerRunId);
      expect(source).toBeDefined();
      expect(row.providerName).toBe(source?.provider.providerName);
      expect(row.requestedModelId).toBe(source?.provider.requestedModelId);
      expect(row.actualModelId).toBe(source?.provider.actualModelId);
      expect(row.tokenCountSource).toBe(source?.tokenUsage.tokenCountSource);
      expect(["provider_reported", "deterministic_counter", "unknown"]).toContain(
        row.tokenCountSource,
      );
      if (row.amountMicrosUsd !== null) {
        expect(row.amountUsd).toBe(row.amountMicrosUsd / 1e6);
      }
    }

    // The provider-proof cross-check is restated verbatim (no recomputation).
    expect(report.cost.providerProofReconciliation).not.toBeNull();
  });

  it("records a private-local aggregate as SUPPLEMENTARY only (never gating, hash-only)", async () => {
    const withPrivate = composeAlphaReadiness(
      await composeInput(undefined, {
        privateLocalAggregate: { label: "oshioki-local", sha256: "sha256:deadbeef" },
      }),
    );
    expect(withPrivate.decision).toBe("pass");
    expect(withPrivate.supplementaryPrivateLocal.provided).toBe(true);
    expect(withPrivate.supplementaryPrivateLocal.gatesDecision).toBe(false);
    expect(withPrivate.supplementaryPrivateLocal.aggregateSha256).toBe("sha256:deadbeef");

    // The decision is byte-identical with and without the private aggregate:
    // supplementary evidence never changes the gates.
    const withoutPrivate = composeAlphaReadiness(await composeInput());
    expect(withPrivate.gates).toEqual(withoutPrivate.gates);
    expect(withPrivate.decision).toBe(withoutPrivate.decision);
  });
});

describe("alpha readiness — failure stays visible", () => {
  it("fails the benchmark-run gate when the harness run failed", async () => {
    const input = await composeInput();
    const failedManifest: BenchmarkHarnessRunManifest = {
      ...input.runManifest,
      status: "failed",
      failedStageId: "raw-mtl-baseline",
    };
    const report = composeAlphaReadiness({ ...input, runManifest: failedManifest });
    expect(report.decision).toBe("fail");
    expect(report.failedGateIds).toContain("benchmark-run-succeeded");
    expect(report.findings.some((f) => f.gateId === "benchmark-run-succeeded")).toBe(true);
  });

  it("fails the MTL-baseline gate when no raw_mtl_baseline system is compared", async () => {
    // The end-to-end harness fails its raw-mtl stage when the baseline system is
    // absent, so to ISOLATE the MTL gate we doctor the rendered baseline of an
    // otherwise-passing run to drop the raw_mtl_baseline entry.
    const input = await composeInput();
    const doctored: AlphaReadinessComposeInput = {
      ...input,
      costQualityArtifact: {
        report: input.costQualityArtifact.report,
        rendered: {
          ...input.costQualityArtifact.rendered,
          quality: {
            ...input.costQualityArtifact.rendered.quality,
            rawMtlBaseline: input.costQualityArtifact.rendered.quality.rawMtlBaseline.filter(
              (system) => system.systemKind !== "raw_mtl_baseline",
            ),
          },
        },
      },
    };
    const report = composeAlphaReadiness(doctored);
    expect(report.decision).toBe("fail");
    expect(report.failedGateIds).toContain("mtl-baseline-included");
  });

  it("fails the provider-proof gate when the experiment composition failed", async () => {
    const input = await composeInput();
    const failedComposition = {
      status: "failed" as const,
      attachment: null,
      findings: [
        {
          kind: "missing_artifact" as const,
          artifactName: "provider route report",
          artifactPath: ROUTE_REPORT_FIXTURE_PATH,
          field: null,
          message: "missing",
        },
      ],
    };
    const report = composeAlphaReadiness({ ...input, experimentComposition: failedComposition });
    expect(report.decision).toBe("fail");
    expect(report.failedGateIds).toContain("provider-proof-reconciled");
    expect(report.findings.some((f) => f.kind === "experiment_composition_failed")).toBe(true);
    expect(report.providerProof).toBeNull();
    expect(report.cost.providerProofReconciliation).toBeNull();
  });

  it("fails the provider-proof-bundle gate when no real-call bundle is supplied", async () => {
    const input = await composeInput();
    const report = composeAlphaReadiness({ ...input, providerProofSummary: null });
    expect(report.decision).toBe("fail");
    expect(report.failedGateIds).toContain("provider-proof-bundle-consumed");
    expect(report.providerProofBundle).toBeNull();
    expect(report.findings.some((f) => f.kind === "provider_proof_bundle_missing")).toBe(true);
  });
});

describe("alpha readiness — README-safe summary", () => {
  it("renders facts only: no banned claim term and no leaked private contents", async () => {
    const report = composeAlphaReadiness(
      await composeInput(undefined, {
        privateLocalAggregate: { label: "oshioki-local", sha256: "sha256:cafef00d" },
      }),
    );
    const summary = renderReadmeSafeAlphaSummary(report);
    const lower = summary.toLowerCase();
    for (const term of README_BANNED_CLAIM_TERMS) {
      expect(lower).not.toContain(term);
    }
    // The summary states the decision + the provenance disclaimer.
    expect(summary).toContain("Decision: **pass**");
    expect(lower).toContain("derived from checked-in public fixtures");
    // Private-local evidence: presence + hash only, contents never shown.
    expect(summary).toContain("sha256:cafef00d");
    expect(summary).toContain("contents not shown");
    // The MTL baseline + linked artifacts are cited.
    expect(summary).toContain("Raw MTL baseline included");
    expect(summary).toContain(`${BENCHMARK_DIR}/benchmark-set-selection.json`);
    // ALPHA-008 — the real-call provider-proof bundle section is rendered.
    expect(summary).toContain("Provider proof bundle (real-call evidence)");
    expect(summary).toContain("structured-output mode");
  });
});

describe("alpha readiness — CLI dispatch", () => {
  function cliDependencies(io: {
    readJson(p: string): unknown;
    writeJson(p: string, v: unknown): void;
    writeText(p: string, c: string): void;
  }) {
    return {
      io,
      migrateDatabase: async () => {},
      withServices: async <T>(
        _callback: (services: ItotoriCliServices) => Promise<T>,
      ): Promise<T> => {
        throw new Error("alpha-readiness-run must not require database services");
      },
    };
  }

  it("runs the public-fixture command and writes all four deliverables (decision pass)", async () => {
    const jsonWrites = new Map<string, unknown>();
    const textWrites = new Map<string, string>();
    const io = {
      readJson: (path: string) => readRepoJson(path),
      writeJson: (path: string, value: unknown) => jsonWrites.set(path, value),
      writeText: (path: string, contents: string) => textWrites.set(path, contents),
    };
    await runItotoriCliCommand(
      ["alpha-readiness-run", "--output-dir", "artifacts/test/cli-alpha-readiness"],
      cliDependencies(io),
    );
    const report = jsonWrites.get(
      "artifacts/test/cli-alpha-readiness/alpha-readiness-report.json",
    ) as {
      decision: string;
      schemaVersion: string;
    };
    expect(report.decision).toBe("pass");
    expect(report.schemaVersion).toBe(ALPHA_READINESS_REPORT_SCHEMA_VERSION);
    expect(jsonWrites.has("artifacts/test/cli-alpha-readiness/cost-report.json")).toBe(true);
    expect(jsonWrites.has("artifacts/test/cli-alpha-readiness/quality-report.json")).toBe(true);
    expect(jsonWrites.has("artifacts/test/cli-alpha-readiness/benchmark/run-manifest.json")).toBe(
      true,
    );
    expect(
      jsonWrites.has("artifacts/test/cli-alpha-readiness/provider-proof/attachment.json"),
    ).toBe(true);
    expect(textWrites.has("artifacts/test/cli-alpha-readiness/README-summary.md")).toBe(true);
    // ALPHA-008 — the sanitized provider-proof bundle deliverables.
    expect(
      jsonWrites.has("artifacts/test/cli-alpha-readiness/provider-proof-bundle/summary.json"),
    ).toBe(true);
    expect(
      textWrites.has("artifacts/test/cli-alpha-readiness/provider-proof-bundle/README.md"),
    ).toBe(true);
  });

  it("escalates a failed benchmark run to a thrown error", async () => {
    const io = {
      readJson: (path: string) => {
        if (path.includes("benchmark-stages")) {
          const fixture = structuredClone(readRepoJson(STAGES_FIXTURE_PATH)) as {
            recordedSystems: { systemKind: string }[];
          };
          fixture.recordedSystems = fixture.recordedSystems.filter(
            (system) => system.systemKind !== "raw_mtl_baseline",
          );
          return fixture;
        }
        return readRepoJson(path);
      },
      writeJson: () => {},
      writeText: () => {},
    };
    await expect(
      runItotoriCliCommand(
        ["alpha-readiness-run", "--output-dir", "artifacts/test/cli-alpha-readiness-fail"],
        cliDependencies(io),
      ),
    ).rejects.toThrow(/alpha-readiness benchmark run failed at stage 'raw-mtl-baseline'/u);
  });
});
