// ITOTORI-099 — Experiment matrix runner: deterministic provenance suite.
//
// Proves the four acceptance pillars:
//   1. Matrix configs declare the (model, provider) PAIR + prompt preset +
//      policy version + target locale + fixture corpus ids; the validator
//      rejects a model-only cell and an unbounded scope.
//   2. Provider capability guards run BEFORE every recorded invocation — a
//      guard rejection short-circuits before `provider.invoke` is reached
//      (proven with a spy provider whose invoke must never be called).
//   3. Recorded replay mode produces DETERMINISTIC artifacts with no
//      network + no credentials (two runs are byte-equal).
//   4. Artifacts carry ledger ids, run ids, fixture ids, and redaction
//      status — the provenance ITOTORI-039 / ITOTORI-100 attach to — and
//      cost is sourced only from the replayed (real captured) bundle cost.

import { describe, expect, it } from "vitest";
import { CapabilityGuard, modelProviderPairKey } from "../src/providers/capability-guard.js";
import { DEV_PAIR, getModelCapabilities } from "../src/providers/dev-pair.js";
import {
  RECORDED_PROVIDER_BUNDLE_SCHEMA_VERSION,
  RecordedModelProvider,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import type {
  ModelCapabilities,
  ModelInvocationResult,
  ModelProvider,
  ProviderCost,
} from "../src/providers/types.js";
import {
  EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION,
  EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION,
  ExperimentMatrixConfigError,
  assertExperimentMatrixConfig,
  assertExperimentRunSucceeded,
  experimentLedgerId,
  experimentRunId,
  runExperimentMatrix,
  type ExperimentFixtureContent,
  type ExperimentMatrixCell,
  type ExperimentMatrixConfig,
} from "../src/experiment-matrix/index.js";

// A stable sha256:<64hex> prompt-preset hash literal for fixtures.
const PROMPT_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

// Captured cost stand-ins. These literals live under `test/` — the
// hardcoded-cost audit (scripts/audit-no-hardcoded-cost.mjs) exempts the
// test tree precisely so a fixture can carry a real captured spend amount;
// the runner SOURCES cost only from this replayed bundle, never a literal.
const BILLED_COST: ProviderCost = {
  costKind: "billed",
  currency: "USD",
  amountUsd: "0.00000602",
  amountMicrosUsd: 6, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
};
const ZERO: ProviderCost = {
  costKind: "zero",
  currency: "USD",
  amountUsd: "0",
  amountMicrosUsd: 0,
};

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
    experimentId: "itotori-099-experiment",
    bounds: { maxCells: 8, maxInvocations: 32 },
    cells: [cell()],
    ...overrides,
  };
}

/** A guard pre-loaded with the real DEV_PAIR measured capability sheet. */
function devPairGuard(): CapabilityGuard {
  const guard = new CapabilityGuard();
  guard.register(DEV_PAIR.modelId, DEV_PAIR.providerId, getModelCapabilities(DEV_PAIR));
  return guard;
}

/**
 * Build a RecordedModelProvider that replays one captured response per
 * (cell, fixtureCorpusId), keyed on the runner's deterministic run id. No
 * network, no credentials — pure in-memory replay.
 */
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
      // genaudit2-01 — real captured counts ride on every recorded response
      // regardless of cost (a cached/zero-cost call still reports tokens).
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
      usageResponseJson:
        cost.costKind === "zero"
          ? { _synthetic_zero_cost: true }
          : { prompt_tokens: 4, completion_tokens: 4, cost: Number(cost.amountUsd) },
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
  // Key replays on the deterministic run id (the runner stamps it onto the
  // request) so each (cell, fixture) replays its own captured response.
  return new RecordedModelProvider({ bundle, bundleKey: (request) => request.runId ?? "" });
}

const PUBLIC_FIXTURE: ExperimentFixtureContent = {
  messages: [{ role: "user", content: "Translate: こんにちは" }],
};

function publicFixtureResolver(): ExperimentFixtureContent {
  return PUBLIC_FIXTURE;
}

describe("ITOTORI-099 — experiment matrix config schema", () => {
  it("accepts a well-formed config", () => {
    expect(() => assertExperimentMatrixConfig(config())).not.toThrow();
  });

  it("rejects a model-only cell (the PAIR law)", () => {
    const bad = config({
      cells: [cell({ pair: { modelId: DEV_PAIR.modelId, providerId: "" } })],
    });
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(ExperimentMatrixConfigError);
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(/pair\.providerId/u);
  });

  it("rejects an unbounded experiment scope (more cells than bounds.maxCells)", () => {
    const cells = Array.from({ length: 3 }, (_, i) => cell({ cellId: `cell-${i}` }));
    const bad = config({ bounds: { maxCells: 2, maxInvocations: 32 }, cells });
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(/unbounded experiment scope/u);
  });

  it("rejects an unbounded invocation scope (more invocations than bounds.maxInvocations)", () => {
    const bad = config({
      bounds: { maxCells: 8, maxInvocations: 1 },
      cells: [cell({ fixtureCorpusIds: ["a", "b", "c"] })],
    });
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(/maxInvocations/u);
  });

  it("rejects a malformed prompt hash", () => {
    const bad = config({
      cells: [
        cell({ promptPreset: { presetId: "p", templateVersion: "1", promptHash: "nothex" } }),
      ],
    });
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(/promptHash/u);
  });

  it("rejects duplicate cell ids", () => {
    const bad = config({ cells: [cell(), cell()] });
    expect(() => assertExperimentMatrixConfig(bad)).toThrow(/duplicate cellId/u);
  });
});

describe("ITOTORI-099 — guarded experiment runner (recorded replay)", () => {
  it("runs a clean matrix and emits provenance artifacts", async () => {
    const cfg = config();
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) => recordedProviderForCell(cfg.experimentId, c, BILLED_COST),
      resolveFixture: publicFixtureResolver,
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });

    expect(manifest.schemaVersion).toBe(EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.findings).toHaveLength(0);
    expect(manifest.artifacts).toHaveLength(1);
    expect(() => assertExperimentRunSucceeded(manifest)).not.toThrow();

    const artifact = manifest.artifacts[0]!;
    // Acceptance: ledger id, run id, fixture id present + the PAIR pinned.
    expect(artifact.schemaVersion).toBe(EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.runId).toBe(experimentRunId(cfg.experimentId, cfg.cells[0]!, "corpus-pub-1"));
    expect(artifact.ledgerId).toBe(
      experimentLedgerId(cfg.experimentId, cfg.cells[0]!, "corpus-pub-1"),
    );
    expect(artifact.fixtureCorpusId).toBe("corpus-pub-1");
    expect(artifact.pair).toEqual({ modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId });
    expect(artifact.policyVersion).toBe("policy-2026-06-28");
    expect(artifact.targetLocale).toBe("en-US");
    expect(artifact.recordedBundleId).toBe("bundle-cell-dev-pair-en");
    expect(artifact.guard).toEqual({ ran: true, outcome: "passed" });
    // Redaction status present; a synthetic_public cell is public-unredacted.
    expect(artifact.redaction.status).toBe("public_unredacted");

    // Cost sourced verbatim from the replayed (real captured) bundle cost.
    expect(artifact.providerRun.cost).toEqual(BILLED_COST);
    expect(manifest.costSummary.totalMicrosUsd).toBe(6);
    expect(manifest.costSummary.totalUsd).toBe("0.000006");
    expect(manifest.costSummary.billedInvocationCount).toBe(1);
  });

  it("runs the per-PAIR capability guard BEFORE invocation — a guard miss never reaches invoke", async () => {
    let invokeCount = 0;
    const spyProvider: ModelProvider = {
      descriptor: {
        family: "recorded",
        endpointFamily: "recorded-fixture",
        providerName: "spy",
        defaultModelId: DEV_PAIR.modelId,
        capabilities: getModelCapabilities(DEV_PAIR),
      },
      invoke: async (): Promise<ModelInvocationResult> => {
        invokeCount += 1;
        throw new Error("spy provider invoke MUST NOT be called when the guard rejects");
      },
    };
    // Empty guard → the pair is unregistered → CapabilityGuardMissError.
    const manifest = await runExperimentMatrix({
      config: config(),
      guard: new CapabilityGuard(),
      resolveProvider: () => spyProvider,
      resolveFixture: publicFixtureResolver,
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });

    expect(invokeCount).toBe(0);
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.findings).toHaveLength(1);
    expect(manifest.findings[0]!.kind).toBe("capability_guard_miss");
    expect(manifest.findings[0]!.message).toContain(
      modelProviderPairKey(DEV_PAIR.modelId, DEV_PAIR.providerId).split("::")[1]!,
    );
    expect(() => assertExperimentRunSucceeded(manifest)).toThrow(/run FAILED/u);
  });

  it("GUARD #2 rejects an unsupported mode from the MEASURED sheet, NOT the permissive descriptor", async () => {
    // This LOCKS the "measured sheet, NOT the permissive descriptor"
    // invariant (runner.ts GUARD #2). The two capability sources are made
    // to DIFFER so the test can prove which one drove the decision:
    //
    //   • the MEASURED guard sheet (getModelCapabilities(DEV_PAIR)) marks
    //     json_schema UNSUPPORTED under ZDR — the real, measured fact;
    //   • the provider's DESCRIPTOR carries a PERMISSIVE sheet that (wrongly)
    //     advertises json_schema as SUPPORTED — the looser fallback the
    //     runner must NEVER consult.
    //
    // A json_schema fixture is rejected ONLY if the runner reads the measured
    // sheet. If it regressed to `descriptor.capabilities` (the permissive
    // path via `input.capabilities ?? input.descriptor.capabilities`),
    // json_schema would pass, `invoke` would be reached, and this test FAILS.
    // (Before this fix the descriptor also carried the measured sheet, so the
    // two paths were indistinguishable and the guard was vacuous.)
    const measured = getModelCapabilities(DEV_PAIR);
    expect(measured.structuredOutputs.jsonSchema).toBe("unsupported");
    const permissiveDescriptorCapabilities: ModelCapabilities = {
      ...measured,
      structuredOutputs: { ...measured.structuredOutputs, jsonSchema: "supported" },
    };
    let invokeCount = 0;
    const spyProvider: ModelProvider = {
      descriptor: {
        family: "recorded",
        endpointFamily: "recorded-fixture",
        providerName: "spy",
        defaultModelId: DEV_PAIR.modelId,
        capabilities: permissiveDescriptorCapabilities,
      },
      invoke: async (): Promise<ModelInvocationResult> => {
        invokeCount += 1;
        throw new Error("invoke must not run for a mode the MEASURED sheet marks unsupported");
      },
    };
    const jsonSchemaFixture: ExperimentFixtureContent = {
      messages: [{ role: "user", content: "x" }],
      structuredOutput: {
        mode: "json_schema",
        name: "out",
        schema: { type: "object" },
        strict: true,
      },
    };
    const manifest = await runExperimentMatrix({
      config: config(),
      guard: devPairGuard(),
      resolveProvider: () => spyProvider,
      resolveFixture: () => jsonSchemaFixture,
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });

    expect(invokeCount).toBe(0);
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.findings[0]!.kind).toBe("capability_unsupported");
    // The rejection names json_schema — proving the MEASURED (unsupported)
    // value drove it, not the descriptor's permissive (supported) one.
    expect(manifest.findings[0]!.message).toMatch(/json_schema/u);
  });

  it("records a missing fixture as a structured finding (never a silent skip)", async () => {
    const cfg = config();
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) => recordedProviderForCell(cfg.experimentId, c, BILLED_COST),
      resolveFixture: ({ fixtureCorpusId }) => {
        throw new Error(`no corpus for ${fixtureCorpusId}`);
      },
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });
    expect(manifest.status).toBe("failed");
    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.findings[0]!.kind).toBe("missing_fixture");
    expect(manifest.findings[0]!.fixtureCorpusId).toBe("corpus-pub-1");
  });

  it("produces DETERMINISTIC, byte-equal manifests across two runs (no network, no creds)", async () => {
    const cfg = config({
      cells: [
        cell({ cellId: "cell-a", fixtureCorpusIds: ["corpus-a1", "corpus-a2"] }),
        cell({ cellId: "cell-b", targetLocale: "ja-JP", fixtureCorpusIds: ["corpus-b1"] }),
      ],
    });
    const run = () =>
      runExperimentMatrix({
        config: cfg,
        guard: devPairGuard(),
        resolveProvider: (c) => recordedProviderForCell(cfg.experimentId, c, BILLED_COST),
        resolveFixture: publicFixtureResolver,
        generatedAt: "2026-06-28T00:00:00.000Z",
        mode: "recorded",
      });

    const first = await run();
    const second = await run();
    expect(first.artifacts).toHaveLength(3);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    // Config hash is stable + pins which config produced the run.
    expect(first.configHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.configHash).toBe(second.configHash);
  });

  it("redacts non-public corpora — the artifact carries no raw corpus text", async () => {
    const SECRET = "PRIVATE_CORPUS_SECRET_PHRASE_2099";
    const cfg = config({
      cells: [cell({ cellId: "cell-private", inputClassification: "private_corpus" })],
    });
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) => recordedProviderForCell(cfg.experimentId, c, ZERO),
      // The fixture content carries private text, but the artifact must not.
      resolveFixture: () => ({ messages: [{ role: "user", content: SECRET }] }),
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });

    expect(manifest.status).toBe("succeeded");
    const artifact = manifest.artifacts[0]!;
    expect(artifact.redaction.status).toBe("redacted");
    expect(artifact.redaction.redactedFields).toContain("private_corpus_text");
    // The serialized artifact NEVER contains the private corpus text.
    expect(JSON.stringify(artifact)).not.toContain(SECRET);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("cost summary aggregates only real captured bundle costs (mixed billed + zero)", async () => {
    const cfg = config({
      cells: [
        cell({ cellId: "cell-billed", fixtureCorpusIds: ["c1"] }),
        cell({ cellId: "cell-zero", fixtureCorpusIds: ["c2"] }),
      ],
    });
    const manifest = await runExperimentMatrix({
      config: cfg,
      guard: devPairGuard(),
      resolveProvider: (c) =>
        recordedProviderForCell(cfg.experimentId, c, c.cellId === "cell-zero" ? ZERO : BILLED_COST),
      resolveFixture: publicFixtureResolver,
      generatedAt: "2026-06-28T00:00:00.000Z",
      mode: "recorded",
    });
    expect(manifest.costSummary.totalMicrosUsd).toBe(6);
    expect(manifest.costSummary.billedInvocationCount).toBe(1);
    expect(manifest.costSummary.zeroCostInvocationCount).toBe(1);
  });
});
