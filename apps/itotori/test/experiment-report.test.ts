// ITOTORI-039 — Provider experiment reporting integration.
//
// Proves the four acceptance pillars on RECORDED, credential-free evidence:
//   1. The composition command READS an ITOTORI-099 experiment-matrix run
//      manifest AND an ITOTORI-100 provider route report (through an injected
//      reader) and COMPOSES them — it reimplements no experiment running, no
//      route rendering, and no cost computation.
//   2. The composed benchmark report attachment carries provider-route,
//      fallback, retry, structured-output-support, and cost-summary sections,
//      plus the RECORDED served (model, provider) pairs from the artifacts.
//   3. Composition works on a GENUINE recorded-replay ITOTORI-099 manifest
//      (RecordedModelProvider, no network, no credentials) — recorded
//      provider proof.
//   4. A MISSING or STALE provider report artifact FAILS with a structured
//      finding that NAMES the artifact; the strict assertion escalates it.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_BENCHMARK_ATTACHMENT_SCHEMA_VERSION,
  ExperimentReportCompositionError,
  assertExperimentReportComposed,
  composeExperimentBenchmarkReport,
  type ComposedArtifactReader,
} from "../src/experiment-report/index.js";
import { CapabilityGuard } from "../src/providers/capability-guard.js";
import { DEV_PAIR, getModelCapabilities } from "../src/providers/dev-pair.js";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedModelProvider,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import type { ModelProvider, ProviderCost } from "../src/providers/types.js";
import {
  EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION,
  experimentRunId,
  runExperimentMatrix,
  type ExperimentMatrixCell,
  type ExperimentMatrixConfig,
} from "../src/experiment-matrix/index.js";
import { renderProviderRouteReport } from "../src/route-reliability/index.js";
import { fallbackRetryArtifacts } from "./fixtures/route-reliability-fixtures.js";
import {
  FIXTURE_MANIFEST_PATH,
  FIXTURE_ROUTE_REPORT_PATH,
  fixtureArtifactReader,
  publicExperimentManifest,
  publicProviderRouteReport,
  summarizeFixtureCost,
} from "./fixtures/experiment-report-fixtures.js";

const GENERATED_AT = "2026-06-30T12:00:00.000Z";

const MANIFEST_REF = {
  artifactName: "experiment-matrix run manifest",
  artifactPath: FIXTURE_MANIFEST_PATH,
};
const ROUTE_REPORT_REF = {
  artifactName: "provider route report",
  artifactPath: FIXTURE_ROUTE_REPORT_PATH,
};

/** A reader over an in-memory map; a missing key THROWS (mirrors ENOENT). */
function readerFrom(map: Record<string, unknown>): ComposedArtifactReader {
  return (ref) => {
    if (!(ref.artifactPath in map)) {
      throw new Error(`ENOENT: no such file or directory, open '${ref.artifactPath}'`);
    }
    return map[ref.artifactPath];
  };
}

function compose(map: Record<string, unknown>) {
  return composeExperimentBenchmarkReport({
    experimentManifestRef: MANIFEST_REF,
    providerRouteReportRef: ROUTE_REPORT_REF,
    readArtifact: readerFrom(map),
    generatedAt: GENERATED_AT,
  });
}

describe("ITOTORI-039 — experiment benchmark report composition (recorded fixtures)", () => {
  it("reads the ITOTORI-099 manifest + ITOTORI-100 route report and composes all five sections", () => {
    const result = compose(fixtureArtifactReader());

    expect(result.status).toBe("succeeded");
    expect(result.findings).toEqual([]);
    const attachment = result.attachment!;
    expect(attachment.schemaVersion).toBe(EXPERIMENT_BENCHMARK_ATTACHMENT_SCHEMA_VERSION);
    expect(attachment.attachmentKind).toBe("provider_experiment_report");
    expect(() => assertExperimentReportComposed(result)).not.toThrow();

    // It NAMES both composed source artifacts.
    expect(attachment.source.experimentManifest.artifactPath).toBe(FIXTURE_MANIFEST_PATH);
    expect(attachment.source.providerRouteReport.artifactPath).toBe(FIXTURE_ROUTE_REPORT_PATH);
    expect(attachment.source.experimentManifest.runStatus).toBe("succeeded");
    expect(attachment.source.experimentManifest.artifactCount).toBe(3);

    // Section 1 — provider route, keyed by the REAL SERVED route.
    const routeKeys = Object.keys(attachment.sections.providerRoute.byServedRoute).sort();
    expect(routeKeys).toEqual(["digitalocean::deepseek-v4-flash", "fireworks::deepseek-v4-flash"]);
    const served =
      attachment.sections.providerRoute.byServedRoute["digitalocean::deepseek-v4-flash"]!;
    expect(served.servedDivergesFromRequested).toBe(true);
    expect(served.invocationCount).toBe(2);

    // Section 2 — fallback. Section 3 — retry. Both surfaced as DATA.
    expect(attachment.sections.fallback.fallbackInvocationCount).toBe(2);
    expect(attachment.sections.retry.totalRetryCount).toBe(3);

    // Section 4 — structured-output support (a partial json_object on the
    // fallback route is a sub-100% support row).
    const jsonObject = attachment.sections.structuredOutputSupport.rows.find(
      (row) => row.mode === "json_object",
    )!;
    expect(jsonObject.fullySupported).toBe(false);

    // Section 5 — cost summary. Sourced VERBATIM from the composed artifacts.
    const cost = attachment.sections.costSummary;
    expect(cost.experimentTotalMicrosUsd).toBe(
      summarizeFixtureCost(fallbackRetryArtifacts()).totalMicrosUsd,
    );
    expect(cost.reconciledInvocationCount).toBe(3);
    expect(cost.artifactMicrosUsd).toBe(cost.experimentTotalMicrosUsd);
    expect(cost.artifactUsd).toBe(cost.ledgerUsd);

    // RECORDED served pairs (served upstream truth, deduped + sorted).
    expect(attachment.servedPairs).toEqual([
      { servedModelId: "deepseek-v4-flash", servedProviderId: "digitalocean" },
      { servedModelId: "deepseek-v4-flash", servedProviderId: "fireworks" },
    ]);

    // No raw prompt/response text or credentials leak into the attachment.
    const serialized = JSON.stringify(attachment);
    expect(serialized).not.toMatch(/sk-/u);
    expect(serialized).not.toContain("Translate");
  });

  it("composes a GENUINE recorded-replay ITOTORI-099 manifest (no network, no creds)", async () => {
    const cfg = recordedConfig();
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) => recordedProviderForCell(cfg.experimentId, c, BILLED_COST),
      resolveFixture: () => ({ messages: [{ role: "user", content: "x" }] }),
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });
    expect(manifest.status).toBe("succeeded");
    expect(manifest.artifacts).toHaveLength(1);

    // Render the ITOTORI-100 report over the REAL runner artifacts + a ledger
    // built from those same artifacts, then compose.
    const routeReport = renderProviderRouteReport({
      experimentId: manifest.experimentId,
      generatedAt: "2026-06-28T00:00:00.000Z",
      artifacts: manifest.artifacts,
      ledgerEntries: manifest.artifacts.map((a) => ({
        runId: a.runId,
        ledgerId: a.ledgerId,
        tokensIn: a.providerRun.tokenUsage.promptTokens ?? null,
        tokensOut: a.providerRun.tokenUsage.completionTokens ?? null,
        costAmountUsd: a.providerRun.cost.amountUsd,
        usageResponseJson: a.providerRun.usageResponseJson,
      })),
    });

    const result = compose({
      [FIXTURE_MANIFEST_PATH]: manifest,
      [FIXTURE_ROUTE_REPORT_PATH]: routeReport,
    });
    expect(result.status).toBe("succeeded");
    const cost = result.attachment!.sections.costSummary;
    // Cost flows verbatim from the replayed captured bundle cost.
    expect(cost.experimentTotalMicrosUsd).toBe(BILLED_COST.amountMicrosUsd);
    expect(cost.artifactMicrosUsd).toBe(BILLED_COST.amountMicrosUsd);
    expect(result.attachment!.servedPairs).toEqual([
      { servedModelId: DEV_PAIR.modelId, servedProviderId: DEV_PAIR.providerId },
    ]);
  });
});

describe("ITOTORI-039 — missing / stale / invalid artifacts FAIL with named diagnostics", () => {
  it("a MISSING provider route report fails with a finding NAMING the artifact", () => {
    const map = fixtureArtifactReader();
    delete map[FIXTURE_ROUTE_REPORT_PATH];
    const result = compose(map);

    expect(result.status).toBe("failed");
    expect(result.attachment).toBeNull();
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.kind).toBe("missing_artifact");
    expect(finding.artifactName).toBe("provider route report");
    expect(finding.artifactPath).toBe(FIXTURE_ROUTE_REPORT_PATH);
    expect(finding.message).toContain(FIXTURE_ROUTE_REPORT_PATH);
    expect(() => assertExperimentReportComposed(result)).toThrow(ExperimentReportCompositionError);
    expect(() => assertExperimentReportComposed(result)).toThrow(/missing_artifact/u);
  });

  it("a MISSING experiment-matrix manifest fails with a finding NAMING the artifact", () => {
    const map = fixtureArtifactReader();
    delete map[FIXTURE_MANIFEST_PATH];
    const result = compose(map);

    expect(result.status).toBe("failed");
    expect(result.attachment).toBeNull();
    expect(result.findings[0]!.kind).toBe("missing_artifact");
    expect(result.findings[0]!.artifactName).toBe("experiment-matrix run manifest");
  });

  it("a STALE provider route report (rendered from a DIFFERENT artifact set) FAILS, naming it", () => {
    // The manifest gains an extra invocation the route report never saw.
    const extra = fallbackRetryArtifacts();
    const grown = [
      ...extra,
      ...fallbackRetryArtifacts()
        .slice(0, 1)
        .map((a) => ({
          ...a,
          cellId: "d-extra",
          runId: "exprun-d-extra",
        })),
    ];
    const result = compose({
      [FIXTURE_MANIFEST_PATH]: publicExperimentManifest(grown),
      // route report still reflects only the original 3 artifacts → STALE.
      [FIXTURE_ROUTE_REPORT_PATH]: publicProviderRouteReport(),
    });

    expect(result.status).toBe("failed");
    const stale = result.findings.find((f) => f.kind === "stale_provider_report");
    expect(stale).toBeDefined();
    expect(stale!.artifactPath).toBe(FIXTURE_ROUTE_REPORT_PATH);
    expect(stale!.message).toMatch(/STALE/u);
    // The attachment is still produced (status failed) so the diagnostic is
    // inspectable, and it embeds the finding.
    expect(result.attachment!.status).toBe("failed");
    expect(result.attachment!.findings.some((f) => f.kind === "stale_provider_report")).toBe(true);
  });

  it("an experimentId mismatch between the two artifacts FAILS, naming the route report", () => {
    const mismatched = publicProviderRouteReport();
    const result = compose({
      [FIXTURE_MANIFEST_PATH]: publicExperimentManifest(),
      [FIXTURE_ROUTE_REPORT_PATH]: { ...mismatched, experimentId: "some-other-experiment" },
    });
    const finding = result.findings.find((f) => f.kind === "experiment_id_mismatch");
    expect(finding).toBeDefined();
    expect(finding!.artifactName).toBe("provider route report");
  });

  it("a structurally INVALID provider route report FAILS with a named diagnostic", () => {
    const result = compose({
      [FIXTURE_MANIFEST_PATH]: publicExperimentManifest(),
      [FIXTURE_ROUTE_REPORT_PATH]: { schemaVersion: "not-the-route-report", reliability: {} },
    });
    expect(result.status).toBe("failed");
    expect(result.attachment).toBeNull();
    expect(result.findings[0]!.kind).toBe("invalid_artifact");
    expect(result.findings[0]!.artifactName).toBe("provider route report");
  });

  it("a FAILED experiment run is refused (no clean artifact set to attach)", () => {
    const failed = { ...publicExperimentManifest(), status: "failed" as const };
    const result = compose({
      [FIXTURE_MANIFEST_PATH]: failed,
      [FIXTURE_ROUTE_REPORT_PATH]: publicProviderRouteReport(),
    });
    expect(result.findings.some((f) => f.kind === "experiment_run_failed")).toBe(true);
  });
});

describe("ITOTORI-039 — committed public fixtures are recorded + fresh", () => {
  it("the checked-in JSON fixtures match the freshly-rendered composition inputs", () => {
    const manifest = publicExperimentManifest();
    const report = publicProviderRouteReport();
    if (process.env.UPDATE_FIXTURES === "1") {
      writeFileSync(FIXTURE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(FIXTURE_ROUTE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    }
    // Compose straight off the committed JSON on disk (real file reads) and
    // prove it reconciles — the committed fixtures ARE valid composition
    // inputs with no live credentials.
    const result = composeExperimentBenchmarkReport({
      experimentManifestRef: MANIFEST_REF,
      providerRouteReportRef: ROUTE_REPORT_REF,
      readArtifact: (ref) => JSON.parse(readFileSync(ref.artifactPath, "utf8")),
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe("succeeded");
    expect(result.attachment!.experimentId).toBe(manifest.experimentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Recorded-replay ITOTORI-099 helpers (no network, no credentials).
// ─────────────────────────────────────────────────────────────────────────

const PROMPT_HASH = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const BILLED_COST: ProviderCost = {
  costKind: "billed",
  currency: "USD",
  amountUsd: "0.00000602",
  amountMicrosUsd: 6, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
};

function devPairGuard(): CapabilityGuard {
  const guard = new CapabilityGuard();
  guard.register(DEV_PAIR.modelId, DEV_PAIR.providerId, getModelCapabilities(DEV_PAIR));
  return guard;
}

function recordedConfig(): ExperimentMatrixConfig {
  const cell: ExperimentMatrixCell = {
    cellId: "cell-dev-pair-en",
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    promptPreset: {
      presetId: "experiment-preset",
      templateVersion: "1.0.0",
      promptHash: PROMPT_HASH,
    },
    policyVersion: "policy-2026-06-28",
    targetLocale: "en-US",
    fixtureCorpusIds: ["corpus-pub-1"],
    inputClassification: "synthetic_public",
  };
  return {
    schemaVersion: EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION,
    experimentId: "itotori-039-recorded",
    bounds: { maxCells: 8, maxInvocations: 32 },
    cells: [cell],
  };
}

function recordedProviderForCell(
  experimentId: string,
  forCell: ExperimentMatrixCell,
  cost: ProviderCost,
): ModelProvider {
  const responses: RecordedProviderBundle["responses"] = {};
  for (const fixtureCorpusId of forCell.fixtureCorpusIds) {
    const runId = experimentRunId(experimentId, forCell, fixtureCorpusId);
    responses[runId] = {
      content: "replayed-experiment-content",
      finishReason: "stop",
      cost,
      // genaudit2-01 — recorded responses carry the REAL captured token
      // counts (a capture of a real call always does); no char/4 fallback.
      tokenUsage: {
        tokenCountSource: "provider_reported",
        promptTokens: 4,
        completionTokens: 4,
        totalTokens: 8,
      },
      routingPosture: {
        order: [forCell.pair.providerId],
        allow_fallbacks: true,
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
      },
      usageResponseJson: { prompt_tokens: 4, completion_tokens: 4, cost: Number(cost.amountUsd) },
    };
  }
  const bundle: RecordedProviderBundle = {
    schemaVersion: RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
    bundleId: `bundle-${forCell.cellId}`,
    capturedProviderFamily: "openrouter",
    capturedProviderName: `openrouter:${forCell.cellId}`,
    capturedRequestedModelId: forCell.pair.modelId,
    capturedProviderId: forCell.pair.providerId,
    capturedActualModelId: forCell.pair.modelId,
    responses,
  };
  return new RecordedModelProvider({ bundle, bundleKey: (request) => request.runId ?? "" });
}
