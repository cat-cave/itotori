// ITOTORI-116 — provider-proof harness core (mode-agnostic).
//
// Proves the Itotori provider path for the draft + QA roles with IDENTICAL
// strict-JSON + shared-schema validation in BOTH recorded mode (no creds)
// and opt-in live mode. Hard rules mirrored from the node acceptance:
//
//   - reject-before-record: a draft/QA response must pass the SHARED schema
//     validator (`parseStructuredTranslationDraftOutput` /
//     `parseStructuredQaFindingOutput`) BEFORE any ledger row or accepted
//     artifact is produced. A schema-invalid response yields a structured
//     finding ({ path, rule, detail }) and NO ledger row.
//   - bounded repair: at most `PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS` repairs
//     after the initial attempt (hard-ceiling enforced). Every attempt —
//     accepted OR skipped — records fallback metadata (provider, model,
//     route, structured-output mode, retry state + reason, real token + cost
//     + latency, ZDR).
//   - (model, provider) pair + cost + tokens come ONLY from the real call:
//     `assertReportedTokenUsage` + `assertBilledCost` gate every accepted
//     row, so a provider that omits a real count or real cost fails loudly.
//   - the token/cost/latency ledger reconciles against the ITOTORI-100 route
//     report (`reconcileRouteCost` + `assertRouteReportReconciled`) keyed on
//     the provider proof id → served route.
//   - the emitted bundle is sanitized: hashes + counts + structured labels
//     only, never a raw prompt/response/key.

import { createHash } from "node:crypto";
import {
  PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION,
  QaResponseValidationError,
  TranslationDraftResponseValidationError,
  assertProviderProofBundle,
  parseStructuredQaFindingOutput,
  parseStructuredTranslationDraftOutput,
  type ProviderProofAttempt,
  type ProviderProofBundle,
  type ProviderProofLedgerRow,
  type ProviderProofMode,
  type ProviderProofRejection,
  type ProviderProofRole,
  type ProviderProofRoleName,
  type ProviderProofSeededDefect,
  type ProviderProofZdrPosture,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import {
  EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
  type ExperimentInvocationArtifact,
} from "../experiment-matrix/index.js";
import { assertBilledCost } from "../providers/cost.js";
import { assertReportedTokenUsage } from "../providers/token-accounting.js";
import type { ProviderRunRecord } from "../providers/types.js";
import { canonicalServedProviderId } from "../telemetry/provider-run-artifact-source.js";
import {
  assertRouteReportReconciled,
  ledgerRunIdFromProofId,
  reconcileRouteCost,
  type ProviderLedgerEntry,
} from "../route-reliability/index.js";
import { scoreQaAgainstOracle } from "./oracle.js";

/** Default repairs allowed AFTER the initial attempt (mirrors the agentic-loop default). */
export const PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS = 1;
/** Hard ceiling: a caller cannot request an unbounded repair loop. */
export const PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING = 3;

export class ProviderProofConfigurationError extends Error {
  constructor(detail: string) {
    super(`provider-proof refused: ${detail}`);
    this.name = "ProviderProofConfigurationError";
  }
}

export class ProviderProofFixtureError extends Error {
  constructor(detail: string) {
    super(`provider-proof fixture invalid: ${detail}`);
    this.name = "ProviderProofFixtureError";
  }
}

// ---------------------------------------------------------------------------
// Fixture wire shape (public, redistributable inputs)
// ---------------------------------------------------------------------------

export const PROVIDER_PROOF_FIXTURE_SCHEMA_VERSION = "itotori.provider-proof-fixture.v0" as const;

/** One recorded provider response for one attempt of one role. */
export type ProviderProofRecordedAttempt = {
  content: string | null;
  providerRun: ProviderRunRecord;
};

export type ProviderProofFixture = {
  schemaVersion: typeof PROVIDER_PROOF_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  sourceLocale: string;
  targetLocale: string;
  bridgeUnitId: string;
  seededDefects: ProviderProofSeededDefect[];
  roles: {
    draft: { attempts: ProviderProofRecordedAttempt[] };
    qa: { attempts: ProviderProofRecordedAttempt[] };
  };
};

// ---------------------------------------------------------------------------
// Attempt source — the only seam between recorded + live mode
// ---------------------------------------------------------------------------

export type ProviderProofRoleResult = {
  content: string | null;
  providerRun: ProviderRunRecord;
};

/**
 * Yields the provider result for the `attemptIndex`-th attempt of `role`.
 * Recorded mode pops the fixture's ordered attempts; live mode invokes the
 * OpenRouter provider once per attempt. The harness calls it up to the
 * bound and stops as soon as a response passes schema validation.
 */
export type ProviderProofAttemptSource = (
  role: ProviderProofRoleName,
  attemptIndex: number,
) => Promise<ProviderProofRoleResult>;

export type RunProviderProofArgs = {
  mode: ProviderProofMode;
  fixtureId: string;
  seededDefects: ProviderProofSeededDefect[];
  source: ProviderProofAttemptSource;
  /** Repairs allowed after the initial attempt. Defaults to the canonical bound. */
  maxRepairAttempts?: number;
  /** ZDR account posture: `asserted` (live, after assertOpenRouterZdrAccount) or `recorded_fixture`. */
  accountZdrAssertion: ProviderProofZdrPosture["accountAssertion"];
};

type ValidatedRoleOutput = {
  itemCount: number;
  findings: QaFinding[];
};

type AcceptedRole = {
  proofId: string;
  providerRun: ProviderRunRecord;
  tokensIn: number;
  tokensOut: number;
  tokenCountSource: string;
  costMicrosUsd: number;
  validated: ValidatedRoleOutput;
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function runProviderProof(args: RunProviderProofArgs): Promise<ProviderProofBundle> {
  const maxRepairAttempts = args.maxRepairAttempts ?? PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS;
  if (
    !Number.isInteger(maxRepairAttempts) ||
    maxRepairAttempts < 0 ||
    maxRepairAttempts > PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING
  ) {
    throw new ProviderProofConfigurationError(
      `maxRepairAttempts must be an integer in [0, ${PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS_CEILING}], got ${String(maxRepairAttempts)}`,
    );
  }

  const roleRecords: ProviderProofRole[] = [];
  const ledger: ProviderProofLedgerRow[] = [];
  const accepted: Partial<Record<ProviderProofRoleName, AcceptedRole>> = {};

  for (const role of ["draft", "qa"] as const) {
    const outcome = await runRole({
      role,
      mode: args.mode,
      source: args.source,
      maxRepairAttempts,
    });
    roleRecords.push(outcome.record);
    if (outcome.accepted !== undefined) {
      accepted[role] = outcome.accepted;
      ledger.push(ledgerRowFromAccepted(role, outcome.accepted));
    }
  }

  // ── route-report reconciliation (ITOTORI-100). Cross-check the ledger
  //    against an independently-built route report keyed on the proof id. A
  //    divergence throws RouteReportReconciliationError (fail-loud). ───────
  const artifacts = ledger.map((row, index) =>
    artifactFromAccepted(row, accepted[row.role]!, index),
  );
  const ledgerEntries: ProviderLedgerEntry[] = ledger.map((row, index) =>
    ledgerEntryFor(row, accepted[row.role]!, artifacts[index]!),
  );
  const reconciliation = reconcileRouteCost({
    experimentId: `provider-proof:${args.fixtureId}`,
    generatedAt: PROVIDER_PROOF_GENERATED_AT,
    artifacts,
    ledgerEntries,
  });
  assertRouteReportReconciled(reconciliation);

  // ── seeded QA oracle scoring ──────────────────────────────────────────
  const qaFindings = accepted.qa?.validated.findings ?? [];
  const qaOracle = scoreQaAgainstOracle(args.seededDefects, qaFindings);

  // ── ZDR posture: per-request zdr from the accepted calls' wire posture ──
  const perRequestZdr =
    Object.values(accepted).length > 0 &&
    Object.values(accepted).every(
      (a) => a !== undefined && a.providerRun.routingPosture.zdr === true,
    );

  const bundle: ProviderProofBundle = {
    schemaVersion: PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION,
    proofId: `provider-proof:${args.mode}:${args.fixtureId}`,
    mode: args.mode,
    fixtureId: args.fixtureId,
    maxRepairAttempts,
    zdr: { accountAssertion: args.accountZdrAssertion, perRequestZdr },
    roles: roleRecords,
    ledger,
    qaOracle,
  };
  // The bundle we emit is itself held to its strict shared contract.
  assertProviderProofBundle(bundle);
  return bundle;
}

/** Fixed clock for the route report — the harness never reads wall-clock time. */
const PROVIDER_PROOF_GENERATED_AT = "1970-01-01T00:00:00.000Z";

type RunRoleArgs = {
  role: ProviderProofRoleName;
  mode: ProviderProofMode;
  source: ProviderProofAttemptSource;
  maxRepairAttempts: number;
};

async function runRole(args: RunRoleArgs): Promise<{
  record: ProviderProofRole;
  accepted: AcceptedRole | undefined;
}> {
  const maxTotalAttempts = 1 + args.maxRepairAttempts;
  const attempts: ProviderProofAttempt[] = [];
  let priorRejection: ProviderProofRejection | null = null;

  for (let attemptIndex = 0; attemptIndex < maxTotalAttempts; attemptIndex += 1) {
    const result = await args.source(args.role, attemptIndex);
    const run = result.providerRun;
    const retryState = attemptIndex === 0 ? "initial" : "repair";
    const retryReason =
      attemptIndex === 0
        ? null
        : priorRejection !== null
          ? `schema_invalid:${priorRejection.rule}`
          : "repair";

    // Token + cost provenance come from the real call regardless of outcome.
    const usage = assertReportedTokenUsage(run.tokenUsage, run.runId);
    const costMicrosUsd = Number(assertBilledCost(run.cost));
    const providerProofId = `${args.mode === "live" ? "live" : "recorded"}:${run.runId}`;
    const servedProvider = canonicalServedProviderId(run.provider.upstreamProvider);
    const base = {
      attemptIndex,
      retryState,
      retryReason,
      providerProofId,
      requestedModelId: run.provider.requestedModelId,
      requestedProviderId: run.provider.requestedProviderId,
      servedModel: run.provider.actualModelId,
      servedProvider,
      requestedRoute: run.routingPosture.order.join(">"),
      servedRoute: `${servedProvider}::${run.provider.actualModelId}`,
      structuredOutputMode: run.structuredOutputMode,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokenCountSource: usage.tokenCountSource,
      costUsd: run.cost.amountUsd,
      costMicrosUsd,
      latencyMs: run.latencyMs,
      zdr: run.routingPosture.zdr,
      promptHash: run.prompt.promptHash,
    } satisfies Omit<ProviderProofAttempt, "outcome" | "rejection">;

    // reject-before-record: validate with the SHARED schema validator FIRST.
    let validated: ValidatedRoleOutput | undefined;
    let rejection: ProviderProofRejection | null = null;
    try {
      validated = validateRoleOutput(args.role, result.content);
    } catch (error) {
      rejection = toRejection(error);
    }

    if (validated !== undefined) {
      attempts.push({ ...base, outcome: "accepted", rejection: null });
      const acceptedOutputHash = sha256(result.content ?? "");
      return {
        record: {
          role: args.role,
          terminalStatus: "accepted",
          acceptedProviderProofId: providerProofId,
          acceptedOutputHash,
          acceptedItemCount: validated.itemCount,
          attempts,
        },
        accepted: {
          proofId: providerProofId,
          providerRun: run,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokenCountSource: usage.tokenCountSource,
          costMicrosUsd,
          validated,
        },
      };
    }

    attempts.push({ ...base, outcome: "rejected_schema_invalid", rejection });
    priorRejection = rejection;
  }

  // Repair budget exhausted — terminal rejection, NO ledger row accepted.
  return {
    record: {
      role: args.role,
      terminalStatus: "rejected_schema_invalid",
      acceptedProviderProofId: null,
      acceptedOutputHash: null,
      acceptedItemCount: null,
      attempts,
    },
    accepted: undefined,
  };
}

/**
 * The IDENTICAL schema validation used in recorded AND live mode: strict
 * JSON parse + the shared draft/QA schema validator. Throws the role's typed
 * validation error on any divergence (no silent repair).
 */
function validateRoleOutput(
  role: ProviderProofRoleName,
  content: string | null,
): ValidatedRoleOutput {
  const raw = content ?? "";
  if (role === "draft") {
    const parsed = parseStructuredTranslationDraftOutput(raw);
    return { itemCount: parsed.drafts.length, findings: [] };
  }
  const parsed = parseStructuredQaFindingOutput(raw);
  return { itemCount: parsed.findings.length, findings: parsed.findings };
}

function toRejection(error: unknown): ProviderProofRejection {
  if (
    error instanceof TranslationDraftResponseValidationError ||
    error instanceof QaResponseValidationError
  ) {
    return { path: error.path, rule: error.rule, detail: error.detail };
  }
  // Any non-validation error is a real bug — never swallow it as a rejection.
  throw error;
}

function ledgerRowFromAccepted(
  role: ProviderProofRoleName,
  accepted: AcceptedRole,
): ProviderProofLedgerRow {
  const run = accepted.providerRun;
  return {
    providerProofId: accepted.proofId,
    role,
    modelId: run.provider.requestedModelId,
    providerId: run.provider.requestedProviderId,
    servedProvider: canonicalServedProviderId(run.provider.upstreamProvider),
    servedModel: run.provider.actualModelId,
    tokensIn: accepted.tokensIn,
    tokensOut: accepted.tokensOut,
    tokenCountSource: accepted.tokenCountSource,
    costUnit: run.cost.currency.toLowerCase(),
    costAmount: run.cost.amountUsd,
    costMicrosUsd: accepted.costMicrosUsd,
    latencyMs: run.latencyMs,
    zdr: run.routingPosture.zdr,
    promptHash: run.prompt.promptHash,
  };
}

function artifactFromAccepted(
  row: ProviderProofLedgerRow,
  accepted: AcceptedRole,
  index: number,
): ExperimentInvocationArtifact {
  const run = accepted.providerRun;
  return {
    schemaVersion: EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
    experimentId: `provider-proof:${row.role}`,
    cellId: `provider-proof-cell-${index}`,
    fixtureCorpusId: `provider-proof-corpus-${row.role}`,
    pair: { modelId: run.provider.requestedModelId, providerId: run.provider.requestedProviderId },
    promptPreset: {
      presetId: run.prompt.presetId,
      templateVersion: run.prompt.templateVersion,
      promptHash: run.prompt.promptHash,
    },
    policyVersion: "provider-proof-v0",
    targetLocale: "en-US",
    inputClassification: "synthetic_public",
    runId: ledgerRunIdFromProofId(row.providerProofId),
    ledgerId: "",
    recordedBundleId: null,
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
    redaction: {
      status: "public_unredacted",
      redactedFields: [],
      reason: "synthetic public provider-proof fixture carries no private text",
    },
  };
}

function ledgerEntryFor(
  row: ProviderProofLedgerRow,
  accepted: AcceptedRole,
  artifact: ExperimentInvocationArtifact,
): ProviderLedgerEntry {
  return {
    runId: artifact.runId,
    ledgerId: "",
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costAmountUsd: row.costAmount.length > 0 ? row.costAmount : null,
    usageResponseJson: accepted.providerRun.usageResponseJson,
  };
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Recorded-mode attempt source
// ---------------------------------------------------------------------------

export function assertProviderProofFixture(value: unknown): asserts value is ProviderProofFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderProofFixtureError("fixture must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROVIDER_PROOF_FIXTURE_SCHEMA_VERSION) {
    throw new ProviderProofFixtureError(
      `schemaVersion must be '${PROVIDER_PROOF_FIXTURE_SCHEMA_VERSION}', got ${String(record.schemaVersion)}`,
    );
  }
  for (const field of ["fixtureId", "sourceLocale", "targetLocale", "bridgeUnitId"]) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new ProviderProofFixtureError(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(record.seededDefects)) {
    throw new ProviderProofFixtureError("seededDefects must be an array");
  }
  const roles = record.roles as Record<string, unknown> | undefined;
  if (typeof roles !== "object" || roles === null) {
    throw new ProviderProofFixtureError("roles must be an object");
  }
  for (const role of ["draft", "qa"] as const) {
    const entry = roles[role] as { attempts?: unknown } | undefined;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Array.isArray(entry.attempts) ||
      entry.attempts.length === 0
    ) {
      throw new ProviderProofFixtureError(`roles.${role}.attempts must be a non-empty array`);
    }
  }
}

/**
 * Recorded attempt source: replays the fixture's ordered per-role attempts.
 * Deterministic and credential-free. A request for an attempt index beyond
 * the recorded list is a fixture error, never a silent skip.
 */
export function recordedAttemptSource(fixture: ProviderProofFixture): ProviderProofAttemptSource {
  return async (role, attemptIndex) => {
    const attempts = fixture.roles[role].attempts;
    const attempt = attempts[attemptIndex];
    if (attempt === undefined) {
      throw new ProviderProofFixtureError(
        `role '${role}' has no recorded attempt at index ${attemptIndex} (recorded ${attempts.length})`,
      );
    }
    return { content: attempt.content, providerRun: attempt.providerRun };
  };
}
