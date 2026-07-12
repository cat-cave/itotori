// ITOTORI-099 — Guarded experiment matrix runner.
//
// Runs a validated {@link ExperimentMatrixConfig} cell-by-cell, fixture-
// by-fixture, and emits a deterministic provenance manifest. The runner
// owns three hard guarantees the ITOTORI-099 acceptance + PROJECT LAW
// require:
//
//   1. GUARD BEFORE EVERY INVOCATION. The ONLY path to `provider.invoke`
//      runs (a) `CapabilityGuard.lookup(modelId, providerId)` — the
//      per-PAIR capability lookup, a miss is a typed failure — and then
//      (b) `assertProviderInvocationSupported({ capabilities, ... })`
//      using the PAIR's measured capabilities (NOT the replay harness's
//      permissive descriptor). A rejection short-circuits before
//      `invoke` is ever called and is recorded as a structured finding.
//      There is no second code path that reaches a provider.
//
//   2. DETERMINISTIC, NETWORK-FREE REPLAY. Every provenance id (runId,
//      ledgerId) is derived by SHA-256 from the config + cell + fixture,
//      and `generatedAt` is a caller input. In recorded mode the
//      RecordedModelProvider replays in-memory bytes with epoch-0
//      timestamps, so two runs over the same inputs produce byte-equal
//      manifests with no creds and no network.
//
//   3. COST/TOKENS ONLY FROM REAL RECORDED ARTIFACTS. The cost summary is
//      summed from each replayed `ProviderRunRecord.cost` (the bundle's
//      captured `usage.cost`, mirrored verbatim). The runner fabricates
//      no cost; micros→USD is a /1e6 derivation only.
//
// Failures are STRUCTURED FINDINGS, never silent skips: a capability
// guard miss, an unsupported-capability rejection, or a missing recorded
// fixture each produce a finding that names the cell + fixture + error,
// and flip the manifest to `status: "failed"`.

import { createHash } from "node:crypto";
import { executeModelInvocation } from "../orchestrator/invocation-supervisor.js";
import {
  assertProviderInvocationSupported,
  CapabilityGuard,
} from "../providers/capability-guard.js";
import { RecordedBundleMissingError } from "../providers/recorded.js";
import {
  type JsonObject,
  type ModelInvocationRequest,
  type ModelMessage,
  type ModelProvider,
  type ModelTool,
  type ModelToolChoice,
  type OpenRouterRoutingPosture,
  type ProviderCost,
  type ProviderInputClassification,
  type StructuredOutputMode,
  type StructuredOutputRequest,
  type TokenUsage,
} from "../providers/types.js";
import {
  assertExperimentMatrixConfig,
  experimentInvocationCount,
  type ExperimentMatrixCell,
  type ExperimentMatrixConfig,
  type ExperimentModelProviderPair,
} from "./config.js";

export const EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION =
  "itotori.experiment_matrix_run_manifest.v0.1" as const;
export const EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION =
  "itotori.experiment_invocation_artifact.v0.1" as const;

/**
 * Body of a fixture corpus entry the runner turns into a request. The
 * messages + structured-output / tool shape come from the fixture; the
 * runner supplies the PAIR, prompt preset, classification, and a
 * deterministic runId from the cell. The resolver NEVER returns prompt
 * text the artifact will surface — the artifact carries only hashes / ids
 * (see redaction below).
 */
export type ExperimentFixtureContent = {
  messages: readonly ModelMessage[];
  structuredOutput?: StructuredOutputRequest;
  tools?: readonly ModelTool[];
  toolChoice?: ModelToolChoice;
  maxPriceUsd?: number;
};

/**
 * Thrown by a fixture resolver when a declared `fixtureCorpusId` has no
 * corpus. Surfaces as a `missing_fixture` finding rather than a silent
 * skip — a missing fixture FAILS visibly (PROJECT LAW).
 */
export class ExperimentFixtureMissingError extends Error {
  constructor(
    public readonly fixtureCorpusId: string,
    public readonly cellId: string,
  ) {
    super(
      `ExperimentFixtureMissingError: cell '${cellId}' references fixtureCorpusId '${fixtureCorpusId}' but no corpus was resolved`,
    );
    this.name = "ExperimentFixtureMissingError";
  }
}

export type ExperimentFixtureResolver = (input: {
  fixtureCorpusId: string;
  cell: ExperimentMatrixCell;
}) => ExperimentFixtureContent;

export type ExperimentProviderResolver = (cell: ExperimentMatrixCell) => ModelProvider;

export type ExperimentArtifactRedaction = {
  /**
   * `redacted` for any non-public classification (private_corpus /
   * confidential / secret); `public_unredacted` for synthetic_public /
   * public. Either way the artifact carries NO raw prompt/response text
   * or API keys by construction — the status documents whether the
   * underlying corpus is private so downstream renderers (ITOTORI-100)
   * keep it out of public fixtures.
   */
  status: "redacted" | "public_unredacted";
  redactedFields: string[];
  reason: string;
};

/**
 * A single provenance record for one (cell, fixtureCorpusId) replay.
 * Shaped for downstream attachment: ITOTORI-100 reconciles
 * `providerRun.cost` / `tokenUsage` / `usageResponseJson` against the
 * provider ledger keyed by `ledgerId` + `runId`; ITOTORI-039 names this
 * artifact and proves composition from `recordedBundleId`.
 */
export type ExperimentInvocationArtifact = {
  schemaVersion: typeof EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION;
  experimentId: string;
  cellId: string;
  fixtureCorpusId: string;
  pair: ExperimentModelProviderPair;
  promptPreset: { presetId: string; templateVersion: string; promptHash: string };
  policyVersion: string;
  targetLocale: string;
  inputClassification: ProviderInputClassification;
  /** Provenance ids — consumable by ITOTORI-039 / ITOTORI-100. */
  runId: string;
  ledgerId: string;
  recordedBundleId: string | null;
  /** The guard ran and PASSED before invocation (failures never reach here). */
  guard: { ran: true; outcome: "passed" };
  providerRun: {
    status: "succeeded" | "failed" | "partial" | "skipped";
    requestedModelId: string;
    actualModelId: string;
    requestedProviderId: string;
    upstreamProvider: string | null;
    providerFamily: string;
    structuredOutputMode: StructuredOutputMode | "none";
    retryCount: number;
    fallbackUsed: boolean;
    fallbackPlan: string[];
    cost: ProviderCost;
    tokenUsage: TokenUsage;
    routingPosture: OpenRouterRoutingPosture;
    usageResponseJson: JsonObject;
  };
  redaction: ExperimentArtifactRedaction;
};

export type ExperimentRunFindingKind =
  | "capability_guard_miss"
  | "capability_unsupported"
  | "missing_fixture"
  | "recorded_bundle_missing"
  | "provider_error";

/**
 * Structured failure for one (cell, fixtureCorpusId). Names the run id +
 * field-ish detail so ITOTORI-039 ("fail with diagnostics naming the
 * missing artifact") and ITOTORI-100 ("fail with diagnostics naming the
 * run id and field") can attach. Never a silent skip.
 */
export type ExperimentRunFinding = {
  kind: ExperimentRunFindingKind;
  cellId: string;
  fixtureCorpusId: string;
  pair: ExperimentModelProviderPair;
  runId: string;
  errorName: string;
  message: string;
};

export type ExperimentCostSummary = {
  currency: "USD";
  /** Sum of every successful artifact's captured `cost.amountMicrosUsd`. */
  totalMicrosUsd: number;
  /** Derived from micros (/1e6) — informational; per-artifact amountUsd is authoritative. */
  totalUsd: string;
  billedInvocationCount: number;
  zeroCostInvocationCount: number;
};

export type ExperimentMatrixRunManifest = {
  schemaVersion: typeof EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION;
  experimentId: string;
  /** SHA-256 of the canonical validated config — pins which config produced this run. */
  configHash: string;
  mode: "recorded" | "live";
  generatedAt: string;
  status: "succeeded" | "failed";
  plannedInvocationCount: number;
  artifacts: ExperimentInvocationArtifact[];
  findings: ExperimentRunFinding[];
  costSummary: ExperimentCostSummary;
};

export type ExperimentMatrixRunInput = {
  config: ExperimentMatrixConfig;
  /** Per-PAIR capability registry; `lookup` is the guard's first gate. */
  guard: CapabilityGuard;
  resolveProvider: ExperimentProviderResolver;
  resolveFixture: ExperimentFixtureResolver;
  /** Caller-supplied for determinism — the runner never reads the clock. */
  generatedAt: string;
  mode: "recorded" | "live";
  log?: (message: string) => void;
};

/**
 * Thrown by {@link assertExperimentRunSucceeded} when a manifest carries
 * any finding. Lets a strict caller (e.g. a CLI) escalate a failed run to
 * a non-zero exit so the failure stays visible at the process level.
 */
export class ExperimentMatrixRunFailedError extends Error {
  constructor(public readonly manifest: ExperimentMatrixRunManifest) {
    super(
      `experiment '${manifest.experimentId}' run FAILED with ${manifest.findings.length} finding(s): ${manifest.findings
        .map((finding) => `${finding.kind}@${finding.cellId}/${finding.fixtureCorpusId}`)
        .join(", ")}`,
    );
    this.name = "ExperimentMatrixRunFailedError";
  }
}

/**
 * Run the experiment matrix. Returns a manifest in EVERY case (including
 * failure): a guard rejection or missing fixture is reported as a
 * structured finding + `status: "failed"`, never by silently dropping the
 * invocation. The runner re-validates the config first so a malformed
 * config throws before any provider is touched.
 */
export async function runExperimentMatrix(
  input: ExperimentMatrixRunInput,
): Promise<ExperimentMatrixRunManifest> {
  const log = input.log ?? (() => {});
  assertExperimentMatrixConfig(input.config);
  const config = input.config;

  const artifacts: ExperimentInvocationArtifact[] = [];
  const findings: ExperimentRunFinding[] = [];

  for (const cell of config.cells) {
    for (const fixtureCorpusId of cell.fixtureCorpusIds) {
      const runId = experimentRunId(config.experimentId, cell, fixtureCorpusId);
      const ledgerId = experimentLedgerId(config.experimentId, cell, fixtureCorpusId);

      // ── Resolve the fixture corpus. A miss is a visible finding. ──────
      let fixture: ExperimentFixtureContent;
      try {
        fixture = input.resolveFixture({ fixtureCorpusId, cell });
      } catch (error) {
        findings.push(finding("missing_fixture", cell, fixtureCorpusId, runId, error));
        log(`experiment-matrix: cell '${cell.cellId}' fixture '${fixtureCorpusId}' MISSING`);
        continue;
      }

      const request = buildRequest(cell, fixture, runId);
      const provider = input.resolveProvider(cell);

      // ── GUARD #1: per-PAIR capability lookup (a miss is fatal). ───────
      // Reading `provider.descriptor` does NOT invoke the provider; the
      // network/replay call is `provider.invoke` further below, which is
      // unreachable until both guards pass.
      let capabilities;
      try {
        capabilities = input.guard.lookup(cell.pair.modelId, cell.pair.providerId);
      } catch (error) {
        findings.push(finding("capability_guard_miss", cell, fixtureCorpusId, runId, error));
        log(`experiment-matrix: cell '${cell.cellId}' capability guard MISS for pair`);
        continue;
      }

      // ── GUARD #2: per-request capability assertion against the PAIR's
      // measured sheet (NOT the permissive replay descriptor). Catches a
      // cell that requests a structured-output mode the pair cannot route. ─
      try {
        assertProviderInvocationSupported({
          descriptor: provider.descriptor,
          request,
          capabilities,
        });
      } catch (error) {
        findings.push(finding("capability_unsupported", cell, fixtureCorpusId, runId, error));
        log(`experiment-matrix: cell '${cell.cellId}' capability UNSUPPORTED — invoke skipped`);
        continue;
      }

      // ── Invocation. Only reached after BOTH guards passed. ────────────
      let result;
      try {
        result = await executeModelInvocation(provider, request);
      } catch (error) {
        const kind: ExperimentRunFindingKind =
          error instanceof RecordedBundleMissingError
            ? "recorded_bundle_missing"
            : "provider_error";
        findings.push(finding(kind, cell, fixtureCorpusId, runId, error));
        log(`experiment-matrix: cell '${cell.cellId}' invoke FAILED — ${describeError(error)}`);
        continue;
      }

      const run = result.providerRun;
      artifacts.push({
        schemaVersion: EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
        experimentId: config.experimentId,
        cellId: cell.cellId,
        fixtureCorpusId,
        pair: { modelId: cell.pair.modelId, providerId: cell.pair.providerId },
        promptPreset: {
          presetId: cell.promptPreset.presetId,
          templateVersion: cell.promptPreset.templateVersion,
          promptHash: cell.promptPreset.promptHash,
        },
        policyVersion: cell.policyVersion,
        targetLocale: cell.targetLocale,
        inputClassification: cell.inputClassification,
        runId: run.runId,
        ledgerId,
        recordedBundleId: recordedBundleIdOf(provider),
        guard: { ran: true, outcome: "passed" },
        providerRun: {
          status: run.status,
          requestedModelId: run.provider.requestedModelId,
          actualModelId: run.provider.actualModelId,
          requestedProviderId: run.provider.requestedProviderId,
          upstreamProvider: run.provider.upstreamProvider ?? null,
          providerFamily: run.provider.providerFamily,
          structuredOutputMode: run.structuredOutputMode,
          retryCount: run.retryCount,
          fallbackUsed: run.fallbackUsed,
          fallbackPlan: run.fallbackPlan,
          cost: run.cost,
          tokenUsage: run.tokenUsage,
          routingPosture: run.routingPosture,
          usageResponseJson: run.usageResponseJson,
        },
        redaction: redactionFor(cell.inputClassification),
      });
      log(
        `experiment-matrix: cell '${cell.cellId}' fixture '${fixtureCorpusId}' → run ${run.runId}`,
      );
    }
  }

  const manifest: ExperimentMatrixRunManifest = {
    schemaVersion: EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION,
    experimentId: config.experimentId,
    configHash: canonicalConfigHash(config),
    mode: input.mode,
    generatedAt: input.generatedAt,
    status: findings.length === 0 ? "succeeded" : "failed",
    plannedInvocationCount: experimentInvocationCount(config),
    artifacts,
    findings,
    costSummary: summarizeCost(artifacts),
  };
  log(
    `experiment-matrix: experiment '${config.experimentId}' status=${manifest.status} artifacts=${artifacts.length} findings=${findings.length}`,
  );
  return manifest;
}

/** Throw {@link ExperimentMatrixRunFailedError} if the manifest has any finding. */
export function assertExperimentRunSucceeded(manifest: ExperimentMatrixRunManifest): void {
  if (manifest.status !== "succeeded" || manifest.findings.length > 0) {
    throw new ExperimentMatrixRunFailedError(manifest);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Provenance + determinism helpers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic run id for one (experiment, cell, fixtureCorpusId). Pure
 * SHA-256 over the controlled axes — no clock, no randomness — so the same
 * matrix replays to byte-equal run ids. Exported so a recorded provider
 * can key its bundle by run id, and so ITOTORI-100 can recompute the join
 * key when reconciling an artifact against the provider ledger.
 */
export function experimentRunId(
  experimentId: string,
  cell: ExperimentMatrixCell,
  fixtureCorpusId: string,
): string {
  const digest = sha256Hex(
    [
      experimentId,
      cell.cellId,
      cell.pair.modelId,
      cell.pair.providerId,
      cell.promptPreset.promptHash,
      cell.policyVersion,
      cell.targetLocale,
      fixtureCorpusId,
    ].join(" "),
  );
  return `exprun-${digest.slice(0, 32)}`;
}

/** Deterministic ledger id for one (experiment, cell, fixtureCorpusId). */
export function experimentLedgerId(
  experimentId: string,
  cell: ExperimentMatrixCell,
  fixtureCorpusId: string,
): string {
  const runId = experimentRunId(experimentId, cell, fixtureCorpusId);
  return `ledger:${sha256Hex([experimentId, cell.cellId, fixtureCorpusId, runId].join(" "))}`;
}

function buildRequest(
  cell: ExperimentMatrixCell,
  fixture: ExperimentFixtureContent,
  runId: string,
): ModelInvocationRequest {
  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: cell.pair.modelId,
    providerId: cell.pair.providerId,
    messages: [...fixture.messages],
    inputClassification: cell.inputClassification,
    prompt: {
      presetId: cell.promptPreset.presetId,
      templateVersion: cell.promptPreset.templateVersion,
      promptHash: cell.promptPreset.promptHash,
    },
    runId,
  };
  if (fixture.structuredOutput !== undefined) {
    request.structuredOutput = fixture.structuredOutput;
  }
  if (fixture.tools !== undefined) {
    request.tools = [...fixture.tools];
  }
  if (fixture.toolChoice !== undefined) {
    request.toolChoice = fixture.toolChoice;
  }
  if (fixture.maxPriceUsd !== undefined) {
    request.maxPriceUsd = fixture.maxPriceUsd;
  }
  return request;
}

function redactionFor(classification: ProviderInputClassification): ExperimentArtifactRedaction {
  if (classification === "synthetic_public" || classification === "public") {
    return {
      status: "public_unredacted",
      redactedFields: [],
      reason: `inputClassification='${classification}' carries no private corpus text; the artifact already omits raw prompt/response bytes`,
    };
  }
  return {
    status: "redacted",
    redactedFields: ["prompt_text", "response_text", "private_corpus_text", "api_keys"],
    reason: `inputClassification='${classification}' is non-public; the artifact carries only hashes/ids/aggregate metrics, never raw text or credentials`,
  };
}

function recordedBundleIdOf(provider: ModelProvider): string | null {
  const candidate = provider as ModelProvider & { bundleId?: () => string };
  if (typeof candidate.bundleId === "function") {
    return candidate.bundleId();
  }
  return null;
}

function summarizeCost(artifacts: readonly ExperimentInvocationArtifact[]): ExperimentCostSummary {
  let totalMicrosUsd = 0;
  let billedInvocationCount = 0;
  let zeroCostInvocationCount = 0;
  for (const artifact of artifacts) {
    // Sourced VERBATIM from the replayed (real captured) cost — never a literal.
    totalMicrosUsd += artifact.providerRun.cost.amountMicrosUsd;
    if (artifact.providerRun.cost.costKind === "billed") {
      billedInvocationCount += 1;
    } else {
      zeroCostInvocationCount += 1;
    }
  }
  return {
    currency: "USD",
    totalMicrosUsd,
    totalUsd: microsToUsdDecimalString(totalMicrosUsd),
    billedInvocationCount,
    zeroCostInvocationCount,
  };
}

/** Exact micros→USD decimal string via integer division (no float rounding). */
function microsToUsdDecimalString(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = (micros % 1_000_000).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

function canonicalConfigHash(config: ExperimentMatrixConfig): string {
  return `sha256:${sha256Hex(stableStringify(config))}`;
}

/**
 * Canonical JSON serialization with RECURSIVELY sorted object keys. Unlike
 * `JSON.stringify` (which preserves key INSERTION order), this yields a
 * stable string for any two semantically-identical values regardless of how
 * their keys were ordered when the object was built — so `configHash` pins
 * config IDENTITY, not incidental construction order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(
  kind: ExperimentRunFindingKind,
  cell: ExperimentMatrixCell,
  fixtureCorpusId: string,
  runId: string,
  error: unknown,
): ExperimentRunFinding {
  return {
    kind,
    cellId: cell.cellId,
    fixtureCorpusId,
    pair: { modelId: cell.pair.modelId, providerId: cell.pair.providerId },
    runId,
    errorName: error instanceof Error ? error.name : "Error",
    message: describeError(error),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
