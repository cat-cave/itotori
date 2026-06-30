// ITOTORI-100 — PUBLIC fixtures for the provider route reliability + cost
// report renderer. The "Fallback and retry summary fixture" deliverable.
//
// Every artifact here is `inputClassification: "synthetic_public"` →
// `redaction.status: "public_unredacted"`: there is NO raw prompt text, NO
// response text, and NO API key anywhere in these fixtures — only ids,
// hashes, counts, statuses, provider slugs, and verbatim cost/token
// numbers. Safe to ship in the public test tree (no live creds / private
// corpora). The cost literals below live under `test/` so the
// no-hardcoded-cost audit's cost-fixture exemption applies — they stand in
// for REAL captured spend the renderer only SUMS, never fabricates.

import type { ExperimentInvocationArtifact } from "../../src/experiment-matrix/runner.js";
import {
  EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
  type ExperimentMatrixRunManifest,
} from "../../src/experiment-matrix/runner.js";
import type { ProviderLedgerEntry } from "../../src/route-reliability/index.js";
import type {
  OpenRouterRoutingPosture,
  ProviderCost,
  StructuredOutputMode,
  TokenUsage,
} from "../../src/providers/types.js";

const PROMPT_HASH = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const ZDR_POSTURE: OpenRouterRoutingPosture = {
  order: ["openrouter-preferred"],
  allow_fallbacks: true,
  data_collection: "deny",
  zdr: true,
  require_parameters: true,
};

/** A billed captured cost (test-tree literal standing in for real spend). */
function billed(amountUsd: string, amountMicrosUsd: number): ProviderCost {
  return { costKind: "billed", currency: "USD", amountUsd, amountMicrosUsd };
}
const ZERO: ProviderCost = {
  costKind: "zero",
  currency: "USD",
  amountUsd: "0",
  amountMicrosUsd: 0,
};

function tokens(promptTokens: number, completionTokens: number): TokenUsage {
  return {
    tokenCountSource: "provider_reported",
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export type ArtifactOverrides = {
  cellId?: string;
  fixtureCorpusId?: string;
  requestedModelId?: string;
  requestedProviderId?: string;
  /** The REAL served upstream provider (may differ from requested under OR fallback). */
  upstreamProvider?: string | null;
  actualModelId?: string;
  status?: "succeeded" | "failed" | "partial" | "skipped";
  structuredOutputMode?: StructuredOutputMode | "none";
  retryCount?: number;
  fallbackUsed?: boolean;
  fallbackPlan?: string[];
  cost?: ProviderCost;
  tokenUsage?: TokenUsage;
};

let runCounter = 0;

/**
 * Build a synthetic-public {@link ExperimentInvocationArtifact}. `runId` is
 * derived from a monotonically-increasing counter unless overridden, so
 * each fixture artifact has a distinct, deterministic join key.
 */
export function artifact(overrides: ArtifactOverrides = {}): ExperimentInvocationArtifact {
  runCounter += 1;
  const cellId = overrides.cellId ?? `cell-${runCounter}`;
  const requestedModelId = overrides.requestedModelId ?? "deepseek-v4-flash";
  const requestedProviderId = overrides.requestedProviderId ?? "fireworks";
  const upstreamProvider =
    overrides.upstreamProvider === undefined ? requestedProviderId : overrides.upstreamProvider;
  const actualModelId = overrides.actualModelId ?? requestedModelId;
  const cost = overrides.cost ?? billed("0.00000602", 6);
  const runId = `exprun-${cellId}`;
  const usageResponseJson =
    cost.costKind === "zero"
      ? { _synthetic_zero_cost: true }
      : {
          prompt_tokens: overrides.tokenUsage?.promptTokens ?? 12,
          completion_tokens: overrides.tokenUsage?.completionTokens ?? 8,
          cost: Number(cost.amountUsd),
        };
  return {
    schemaVersion: EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
    experimentId: "itotori-100-fixture",
    cellId,
    fixtureCorpusId: overrides.fixtureCorpusId ?? "corpus-pub-1",
    pair: { modelId: requestedModelId, providerId: requestedProviderId },
    promptPreset: { presetId: "preset", templateVersion: "1.0.0", promptHash: PROMPT_HASH },
    policyVersion: "policy-2026-06-28",
    targetLocale: "en-US",
    inputClassification: "synthetic_public",
    runId,
    ledgerId: `ledger:${runId}`,
    recordedBundleId: `bundle-${cellId}`,
    guard: { ran: true, outcome: "passed" },
    providerRun: {
      status: overrides.status ?? "succeeded",
      requestedModelId,
      actualModelId,
      requestedProviderId,
      upstreamProvider,
      providerFamily: "openrouter",
      structuredOutputMode: overrides.structuredOutputMode ?? "json_schema",
      retryCount: overrides.retryCount ?? 0,
      fallbackUsed: overrides.fallbackUsed ?? false,
      fallbackPlan: overrides.fallbackPlan ?? [],
      cost,
      tokenUsage: overrides.tokenUsage ?? tokens(12, 8),
      routingPosture: ZDR_POSTURE,
      usageResponseJson,
    },
    redaction: {
      status: "public_unredacted",
      redactedFields: [],
      reason: "synthetic_public carries no private corpus text",
    },
  };
}

/** A ledger entry reconciling an artifact (same runId, matching cost/tokens). */
export function ledgerFor(art: ExperimentInvocationArtifact): ProviderLedgerEntry {
  const run = art.providerRun;
  return {
    runId: art.runId,
    ledgerId: art.ledgerId,
    tokensIn: run.tokenUsage.promptTokens ?? null,
    tokensOut: run.tokenUsage.completionTokens ?? null,
    costAmountUsd: run.cost.amountUsd,
    usageResponseJson: run.usageResponseJson,
  };
}

/**
 * The "fallback + retry summary" fixture set: a single experiment whose
 * requested pair preferred `fireworks` but OR-side fallback served some
 * invocations through `digitalocean` (a different upstream — the served
 * truth the report keys on), with retries, fallback chains, a partial, and
 * a mix of structured-output modes + billed/zero cost. Returned as a frozen
 * snapshot so reuse across tests cannot mutate it.
 */
export function fallbackRetryArtifacts(): ExperimentInvocationArtifact[] {
  // reset the counter so the run ids are stable per call
  runCounter = 0;
  return [
    // Served by the PREFERRED provider, clean, json_schema, billed.
    artifact({
      cellId: "a-clean",
      requestedProviderId: "fireworks",
      upstreamProvider: "fireworks",
      structuredOutputMode: "json_schema",
      cost: billed("0.00000602", 6),
      tokenUsage: tokens(12, 8),
    }),
    // OR-side FALLBACK: requested fireworks, SERVED digitalocean. Retried
    // once before the fallback succeeded. fallbackUsed = true (DATA).
    artifact({
      cellId: "b-fallback",
      requestedProviderId: "fireworks",
      upstreamProvider: "DigitalOcean",
      structuredOutputMode: "json_schema",
      retryCount: 1,
      fallbackUsed: true,
      fallbackPlan: ["deepseek-v4-flash", "deepseek-v4-flash-backup"],
      cost: billed("0.00001500", 15),
      tokenUsage: tokens(20, 10),
    }),
    // Same served route (digitalocean), but the structured-output mode was
    // NOT honoured — status partial → sub-100% support for json_object.
    artifact({
      cellId: "c-partial-so",
      requestedProviderId: "fireworks",
      upstreamProvider: "digitalocean",
      actualModelId: "deepseek-v4-flash",
      status: "partial",
      structuredOutputMode: "json_object",
      retryCount: 2,
      fallbackUsed: true,
      fallbackPlan: ["deepseek-v4-flash", "deepseek-v4-flash-backup"],
      cost: ZERO,
      tokenUsage: tokens(20, 0),
    }),
  ];
}

/** Ledger entries reconciling {@link fallbackRetryArtifacts}. */
export function fallbackRetryLedger(): ProviderLedgerEntry[] {
  return fallbackRetryArtifacts().map(ledgerFor);
}

/**
 * Minimal recorded-replay manifest shape carrying the fixture artifacts, so
 * a test can prove the report renders straight off an
 * `ExperimentMatrixRunManifest.artifacts` array.
 */
export function fixtureManifest(): Pick<ExperimentMatrixRunManifest, "artifacts" | "experimentId"> {
  return { experimentId: "itotori-100-fixture", artifacts: fallbackRetryArtifacts() };
}
