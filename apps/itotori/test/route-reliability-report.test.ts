// ITOTORI-100 — Provider route reliability + cost report renderer.
//
// Proves the four acceptance pillars on REAL ITOTORI-099 artifacts +
// localization-journal physical-attempt data:
//   1. Reliability / fallback / retry / structured-output aggregate BY THE
//      REAL SERVED (provider, model) route — the served upstream truth, not
//      the requested pin (OR-side fallback is DATA, never an error).
//   2. Cost summaries RECONCILE artifacts against durable journal attempts by
//      a three-way cross-check (artifact usage.cost == journal cost ==
//      journal usage.cost), token counts included — not a restatement.
//   3. A missing ledger field FAILS with a structured finding NAMING the
//      run id and the field; the strict assertion escalates it.
//   4. Public fixtures only — no prompt/response text or API keys.

import type { LocalizationJournalAttemptRecord } from "@itotori/db";
import { describe, expect, it } from "vitest";
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
  type ExperimentInvocationArtifact,
  type ExperimentMatrixCell,
  type ExperimentMatrixConfig,
} from "../src/experiment-matrix/index.js";
import {
  CostAggregateDivergenceError,
  PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
  RouteReportReconciliationError,
  assertCostAggregateReconciled,
  assertRouteReportReconciled,
  ledgerRunIdFromProofId,
  microsToUsdDecimalString,
  providerLedgerEntryFromJournalAttempt,
  reconcileRouteCost,
  renderProviderRouteReport,
  renderRouteReliability,
  renderStructuredOutputSupport,
  servedRouteKey,
  usdDecimalStringToMicros,
  type ProviderLedgerEntry,
  type RouteCostReconciliationReport,
} from "../src/route-reliability/index.js";
import {
  artifact,
  fallbackRetryArtifacts,
  fallbackRetryLedger,
  ledgerFor,
} from "./fixtures/route-reliability-fixtures.js";

const GENERATED_AT = "2026-06-30T00:00:00.000Z";

function input(artifacts: ExperimentInvocationArtifact[]) {
  return { experimentId: "itotori-100-fixture", generatedAt: GENERATED_AT, artifacts };
}

describe("ITOTORI-100 — route reliability (keyed by REAL SERVED provider, model)", () => {
  it("aggregates success / failure / retry / fallback by the served route, not the requested pin", () => {
    const artifacts = fallbackRetryArtifacts();
    const report = renderRouteReliability(input(artifacts));

    expect(report.schemaVersion).toBe(PROVIDER_ROUTE_REPORT_SCHEMA_VERSION);
    // Two served routes: fireworks (1 clean) and digitalocean (2 served via
    // fallback — "DigitalOcean" + "digitalocean" canonicalize to one bucket).
    const keys = Object.keys(report.byServedRoute).sort();
    expect(keys).toEqual(["digitalocean::deepseek-v4-flash", "fireworks::deepseek-v4-flash"]);

    const served = report.byServedRoute["digitalocean::deepseek-v4-flash"]!;
    expect(served.invocationCount).toBe(2);
    expect(served.succeededCount).toBe(1);
    expect(served.partialCount).toBe(1);
    // The requested pair pinned fireworks but the route SERVED digitalocean —
    // the report records the divergence rather than pinning it away.
    expect(served.requestedPairs).toEqual(["deepseek-v4-flash:fireworks"]);
    expect(served.servedDivergesFromRequested).toBe(true);
    // Fallback + retry are surfaced as DATA.
    expect(served.fallbackInvocationCount).toBe(2);
    expect(served.retriedInvocationCount).toBe(2);
    expect(served.totalRetryCount).toBe(3);
    expect(served.fallbackPlans).toEqual(["deepseek-v4-flash>deepseek-v4-flash-backup"]);
    expect(served.zdrEnforcedCount).toBe(2);

    const clean = report.byServedRoute["fireworks::deepseek-v4-flash"]!;
    expect(clean.servedDivergesFromRequested).toBe(false);
    expect(clean.fallbackInvocationCount).toBe(0);
    expect(clean.totalRetryCount).toBe(0);

    expect(report.totals.invocationCount).toBe(3);
    expect(report.totals.fallbackInvocationCount).toBe(2);
    expect(report.totals.totalRetryCount).toBe(3);
  });

  it("is deterministic — two renders are byte-equal", () => {
    const a = renderRouteReliability(input(fallbackRetryArtifacts()));
    const b = renderRouteReliability(input(fallbackRetryArtifacts()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("ITOTORI-100 — structured-output support report", () => {
  it("reports per-(served route, mode) support rate; a partial serve is sub-100%", () => {
    const report = renderStructuredOutputSupport(input(fallbackRetryArtifacts()));
    expect(report.section).toBe("structured_output_support");

    const jsonSchemaOnDo = report.rows.find(
      (r) => r.servedProvider === "digitalocean" && r.mode === "json_schema",
    )!;
    expect(jsonSchemaOnDo.requestedCount).toBe(1);
    expect(jsonSchemaOnDo.succeededCount).toBe(1);
    expect(jsonSchemaOnDo.fullySupported).toBe(true);

    // json_object on digitalocean landed only a PARTIAL → not fully supported.
    const jsonObjectOnDo = report.rows.find(
      (r) => r.servedProvider === "digitalocean" && r.mode === "json_object",
    )!;
    expect(jsonObjectOnDo.requestedCount).toBe(1);
    expect(jsonObjectOnDo.succeededCount).toBe(0);
    expect(jsonObjectOnDo.supportRate).toBe(0);
    expect(jsonObjectOnDo.fullySupported).toBe(false);
  });
});

describe("ITOTORI-100 — cost reconciliation (cross-check, not restate)", () => {
  it("reconciles artifact cost + tokens against the provider ledger three ways", () => {
    const artifacts = fallbackRetryArtifacts();
    const report = reconcileRouteCost({
      ...input(artifacts),
      ledgerEntries: fallbackRetryLedger(),
    });

    expect(report.findings).toHaveLength(0);
    expect(report.reconciledInvocationCount).toBe(3);
    // Artifact micros (verbatim) and ledger micros (×1e6 of the real
    // persisted decimal) must AGREE — that equality IS the reconciliation.
    expect(report.artifactMicrosUsd).toBe(report.ledgerMicrosUsd);
    expect(report.artifactMicrosUsd).toBe(6 + 15 + 0);
    expect(report.artifactUsd).toBe(report.ledgerUsd);

    const served = report.byServedRoute["digitalocean::deepseek-v4-flash"]!;
    expect(served.artifactMicrosUsd).toBe(15);
    expect(served.ledgerMicrosUsd).toBe(15);
    expect(served.billedInvocationCount).toBe(1);
    expect(served.zeroCostInvocationCount).toBe(1);
  });

  it("FAILS with a finding naming the run id + field when a ledger cost field is missing", () => {
    const art = artifact({ cellId: "missing-cost" });
    const ledger: ProviderLedgerEntry = { ...ledgerFor(art), costAmountUsd: null };
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });

    const finding = report.findings.find((f) => f.kind === "missing_ledger_field")!;
    expect(finding.runId).toBe(art.runId);
    expect(finding.field).toBe("costAmountUsd");
    expect(finding.message).toContain(art.runId);
    expect(finding.message).toContain("costAmountUsd");
    // The missing-field run is NOT counted as reconciled.
    expect(report.reconciledInvocationCount).toBe(0);
    expect(() => assertRouteReportReconciled(report)).toThrow(RouteReportReconciliationError);
    expect(() => assertRouteReportReconciled(report)).toThrow(art.runId);
  });

  it("names each missing field independently (tokensIn / tokensOut / usage.cost)", () => {
    const art = artifact({
      cellId: "missing-many",
      cost: {
        costKind: "billed",
        currency: "USD",
        amountUsd: "0.00000602", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        amountMicrosUsd: 6, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      } as ProviderCost,
    });
    const ledger: ProviderLedgerEntry = {
      ...ledgerFor(art),
      tokensIn: null,
      tokensOut: null,
      usageResponseJson: {}, // billed run but no usage.cost → missing field
    };
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    const fields = report.findings
      .filter((f) => f.kind === "missing_ledger_field")
      .map((f) => f.field)
      .sort();
    expect(fields).toEqual(["tokensIn", "tokensOut", "usageResponseJson.cost"]);
    for (const f of report.findings) expect(f.runId).toBe(art.runId);
  });

  it("flags a cost mismatch (cross-check catches a ledger that disagrees with the artifact)", () => {
    const art = artifact({
      cellId: "cost-drift",
      cost: { costKind: "billed", currency: "USD", amountUsd: "0.00000602", amountMicrosUsd: 6 }, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
    });
    const ledger: ProviderLedgerEntry = { ...ledgerFor(art), costAmountUsd: "0.00009999" };
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    const finding = report.findings.find((f) => f.kind === "cost_mismatch")!;
    expect(finding.field).toBe("costAmountUsd");
    expect(finding.runId).toBe(art.runId);
  });

  it("flags a token mismatch naming the field", () => {
    const art = artifact({ cellId: "tok-drift" });
    const ledger: ProviderLedgerEntry = { ...ledgerFor(art), tokensOut: 999 };
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    const finding = report.findings.find((f) => f.kind === "token_mismatch")!;
    expect(finding.field).toBe("tokensOut");
    expect(finding.runId).toBe(art.runId);
  });

  it("flags a ledger entry missing entirely for a run id", () => {
    const art = artifact({ cellId: "no-ledger" });
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [] });
    const finding = report.findings.find((f) => f.kind === "ledger_entry_missing")!;
    expect(finding.runId).toBe(art.runId);
    expect(finding.field).toBeNull();
  });

  it("flags a ledger id mismatch when the ledger carries an experiment ledger id", () => {
    const art = artifact({ cellId: "ledger-id-drift" });
    const ledger: ProviderLedgerEntry = { ...ledgerFor(art), ledgerId: "ledger:WRONG" };
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    expect(report.findings.some((f) => f.kind === "ledger_id_mismatch")).toBe(true);
  });

  it("COST CORRECTNESS: the headline aggregate traces to the authoritative decimal, not the rounded amountMicrosUsd mirror", () => {
    // A real sub-micro cost the rounded `amountMicrosUsd` mirror rounds UP
    // (`0.0000005` → 1 micro, round-half-up on the 7th digit) while the
    // authoritative-decimal ledger side TRUNCATES (→ 0 micros). Before the
    // fix the artifact aggregate consumed the mirror and drifted a micro
    // above the ledger while still "reconciling" on the decimal — a silent
    // divergence. The aggregate must now equal the authoritative decimal.
    const art = artifact({
      cellId: "sub-micro-drift",
      // amountMicrosUsd: 1 is the ROUNDED mirror — it must NOT feed the aggregate.
      cost: {
        costKind: "billed",
        currency: "USD",
        amountUsd: "0.0000005", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        amountMicrosUsd: 1, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      } as ProviderCost,
    });
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledgerFor(art)] });

    expect(report.findings).toHaveLength(0);
    expect(report.reconciledInvocationCount).toBe(1);
    // Authoritative decimal micros (truncated → 0), NOT the rounded mirror (1).
    expect(report.artifactMicrosUsd).toBe(0);
    expect(report.artifactMicrosUsd).toBe(report.ledgerMicrosUsd);
    // reconcileRouteCost enforces the equality internally; it did not throw.
    expect(() => assertCostAggregateReconciled(report)).not.toThrow();
  });

  it("ENFORCES artifact-vs-ledger equality — a rounded-drift divergence is CAUGHT, not silently accumulated", () => {
    const art = artifact({ cellId: "drift-guard" });
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledgerFor(art)] });
    // A matching artifact+ledger report passes the enforcement.
    expect(() => assertCostAggregateReconciled(report)).not.toThrow();
    expect(report.artifactMicrosUsd).toBe(report.ledgerMicrosUsd);

    // Simulate the OLD rounded-mirror behaviour: the HEADLINE artifact micros
    // drift a micro above the authoritative ledger micros. Exact-integer
    // (not fuzzy) enforcement MUST catch it.
    const divergentTotal: RouteCostReconciliationReport = {
      ...report,
      artifactMicrosUsd: report.ledgerMicrosUsd + 1,
    };
    expect(() => assertCostAggregateReconciled(divergentTotal)).toThrow(
      CostAggregateDivergenceError,
    );
    expect(() => assertCostAggregateReconciled(divergentTotal)).toThrow(/headline total/);

    // A PER-ROUTE drift is caught too (the guard checks every served route).
    const routeKey = Object.keys(report.byServedRoute)[0]!;
    const row = report.byServedRoute[routeKey]!;
    const divergentRow: RouteCostReconciliationReport = {
      ...report,
      byServedRoute: {
        ...report.byServedRoute,
        [routeKey]: { ...row, artifactMicrosUsd: row.artifactMicrosUsd + 1 },
      },
    };
    expect(() => assertCostAggregateReconciled(divergentRow)).toThrow(CostAggregateDivergenceError);
    expect(() => assertCostAggregateReconciled(divergentRow)).toThrow(routeKey);
  });
});

describe("ITOTORI-100 — localization-journal composition", () => {
  it("adapts a durable physical attempt and reconciles by provider-run id", () => {
    const art = artifact({ cellId: "journal-row" });
    const journalAttempt = journalAttemptWith(art, {});

    expect(ledgerRunIdFromProofId(`live:${art.runId}`)).toBe(art.runId);
    const ledger = providerLedgerEntryFromJournalAttempt(journalAttempt);
    expect(ledger.runId).toBe(art.runId);
    expect(ledger.ledgerId).toBe(""); // Journal attempt id is not an experiment ledger id.

    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    expect(report.findings).toHaveLength(0);
    expect(report.reconciledInvocationCount).toBe(1);
  });

  it("treats an empty journal cost as a missing field (named in the finding)", () => {
    const art = artifact({ cellId: "journal-empty-cost" });
    const ledger = providerLedgerEntryFromJournalAttempt(journalAttemptWith(art, { costUsd: "" }));
    const report = reconcileRouteCost({ ...input([art]), ledgerEntries: [ledger] });
    const finding = report.findings.find((f) => f.kind === "missing_ledger_field")!;
    expect(finding.field).toBe("costAmountUsd");
    expect(finding.runId).toBe(art.runId);
  });
});

describe("ITOTORI-100 — end-to-end off the real ITOTORI-099 runner", () => {
  it("renders + reconciles a manifest produced by runExperimentMatrix (served != requested)", async () => {
    const cfg = config();
    // The recorded bundle's capturedProviderId is the SERVED upstream; set it
    // to a DIFFERENT provider than the requested pin so the served-route
    // divergence is real, not synthesized.
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) =>
        recordedProviderForCell(cfg.experimentId, c, billedCost(), "served-upstream-x"),
      resolveFixture: () => ({ messages: [{ role: "user", content: "Translate: こんにちは" }] }),
      generatedAt: GENERATED_AT,
      mode: "recorded",
    });
    expect(manifest.status).toBe("succeeded");
    expect(manifest.artifacts).toHaveLength(1);

    const art = manifest.artifacts[0]!;
    // The served route keys on the captured upstream, not the requested pin.
    expect(servedRouteKey(art)).toBe(`served-upstream-x::${DEV_PAIR.modelId}`);

    // Build the provider ledger from the SAME run's verbatim facts and
    // reconcile — artifact and ledger originate from one captured response,
    // so the three-way cost cross-check holds by construction.
    const report = renderProviderRouteReport({
      experimentId: cfg.experimentId,
      generatedAt: GENERATED_AT,
      artifacts: manifest.artifacts,
      ledgerEntries: manifest.artifacts.map(ledgerFor),
    });
    expect(report.costReconciliation.findings).toHaveLength(0);
    expect(report.reliability.byServedRoute[servedRouteKey(art)]!.invocationCount).toBe(1);
    expect(() => assertRouteReportReconciled(report.costReconciliation)).not.toThrow();
  });
});

describe("ITOTORI-100 — public fixtures carry no prompt / response / key text", () => {
  it("the rendered report serializes without any private text or credential", () => {
    const artifacts = fallbackRetryArtifacts();
    const report = renderProviderRouteReport({
      ...input(artifacts),
      ledgerEntries: fallbackRetryLedger(),
    });
    const serialized = JSON.stringify(report);
    // No raw prompt/response text, no API key shapes leak into the report.
    expect(serialized).not.toMatch(/こんにちは/u);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/u);
    expect(serialized).not.toMatch(/Bearer\s/u);
    // Every artifact stayed public-unredacted (synthetic_public).
    for (const a of artifacts) expect(a.redaction.status).toBe("public_unredacted");
  });
});

describe("ITOTORI-100 — micros <-> USD helpers (the only cost arithmetic)", () => {
  it("round-trips sub-micro and whole-dollar decimals", () => {
    expect(microsToUsdDecimalString(6)).toBe("0.000006");
    expect(microsToUsdDecimalString(15)).toBe("0.000015");
    expect(microsToUsdDecimalString(1_000_000)).toBe("1");
    expect(usdDecimalStringToMicros("0.000006")).toBe(6);
    expect(usdDecimalStringToMicros("1")).toBe(1_000_000);
    expect(usdDecimalStringToMicros("0.00001500")).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers for the end-to-end runner test (mirrors experiment-matrix.test.ts).
// ─────────────────────────────────────────────────────────────────────────

function billedCost(): ProviderCost {
  return { costKind: "billed", currency: "USD", amountUsd: "0.00000602", amountMicrosUsd: 6 }; // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
}

function journalAttemptWith(
  art: ExperimentInvocationArtifact,
  overrides: Partial<LocalizationJournalAttemptRecord>,
): LocalizationJournalAttemptRecord {
  return {
    attemptId: art.runId,
    runId: "journal-run-1",
    bridgeUnitId: "bridge-unit-1",
    stage: "translation",
    agentLabel: "translation-primary",
    logicalCallId: "logical-call-1",
    attemptIndex: 1,
    requestedModelId: art.providerRun.requestedModelId,
    requestedProviderId: art.providerRun.requestedProviderId,
    modelId: art.providerRun.actualModelId,
    providerId: art.providerRun.upstreamProvider ?? art.providerRun.requestedProviderId,
    providerRunId: art.runId,
    tokensIn: art.providerRun.tokenUsage.promptTokens ?? null,
    tokensOut: art.providerRun.tokenUsage.completionTokens ?? null,
    tokenCountSource: art.providerRun.tokenUsage.tokenCountSource,
    costUsd: art.providerRun.cost.amountUsd,
    costKind: art.providerRun.cost.costKind,
    usageResponseJson: art.providerRun.usageResponseJson,
    cacheReadTokens: art.providerRun.tokenUsage.cacheReadTokens ?? null,
    cacheWriteTokens: art.providerRun.tokenUsage.cacheWriteTokens ?? null,
    cacheDiscountMicrosUsd: art.providerRun.cost.cacheDiscountMicrosUsd ?? null,
    fallbackUsed: art.providerRun.fallbackUsed,
    fallbackPlan: [...art.providerRun.fallbackPlan],
    zdr: art.providerRun.routingPosture.zdr,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${art.runId}`,
    errorClasses: [],
    startedAt: new Date(0),
    completedAt: new Date(0),
    createdAt: new Date(0),
    ...overrides,
  };
}

const PROMPT_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function cell(overrides: Partial<ExperimentMatrixCell> = {}): ExperimentMatrixCell {
  return {
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
    ...overrides,
  };
}

function config(overrides: Partial<ExperimentMatrixConfig> = {}): ExperimentMatrixConfig {
  return {
    schemaVersion: EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION,
    experimentId: "itotori-100-e2e",
    bounds: { maxCells: 8, maxInvocations: 32 },
    cells: [cell()],
    ...overrides,
  };
}

function devPairGuard(): CapabilityGuard {
  const guard = new CapabilityGuard();
  guard.register(DEV_PAIR.modelId, DEV_PAIR.providerId, getModelCapabilities(DEV_PAIR));
  return guard;
}

function recordedProviderForCell(
  experimentId: string,
  forCell: ExperimentMatrixCell,
  cost: ProviderCost,
  servedProviderId: string,
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
    // The SERVED upstream — deliberately different from the requested pin.
    capturedProviderId: servedProviderId,
    capturedActualModelId: forCell.pair.modelId,
    responses,
  };
  return new RecordedModelProvider({ bundle, bundleKey: (request) => request.runId ?? "" });
}
