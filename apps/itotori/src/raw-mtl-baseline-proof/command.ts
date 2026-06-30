// ITOTORI-117 — raw-MTL degenerate baseline proof CLI command.
//
// Recorded mode (default, NO credentials) drives a deliberately-naive raw-MTL
// baseline through the ITOTORI-116 provider-proof harness over a public
// fixture; opt-in live mode runs ONE bounded real ZDR draft + QA call against
// the pre-authorized key, reading the REAL billed cost (the key is NEVER
// printed). Both modes emit the SAME `RawMtlBaselineProofArtifact` — the SAME
// ledger + quality-report schema as a structured Itotori draft — tagged
// `systemKind: "raw_mtl_baseline"`.
//
// The "naive" baseline is exercised through the SAME harness/provider path as
// the structured draft; only the prompt preset is degenerate (a literal
// machine translation with no glossary/context/QA rigor). The comparison
// anchors (the Itotori draft's LLM-QA + the deterministic-QA detector) are
// always the recorded public fixtures so the oracle compares like for like.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA,
  STRUCTURED_QA_FINDING_OUTPUT_TOOL_NAME,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_TOOL_NAME,
  parseStructuredQaFindingOutput,
  type ProviderProofRoleName,
  type ProviderProofSeededDefect,
  type QaFinding,
  type RawMtlBaselineProofArtifact,
} from "@itotori/localization-bridge-schema";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  openRouterApiKeyFromEnv,
  openRouterDefaultCapabilities,
  selectStructuredOutputRequest,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../providers/index.js";
import {
  PROVIDER_PROOF_LIVE_MAX_PRICE_USD,
  PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS,
  assertProviderProofFixture,
  readProviderProofFixture,
  recordedAttemptSource,
  runProviderProof,
  type ProviderProofAttemptSource,
  type ProviderProofFixture,
} from "../provider-proof/index.js";
import { buildRawMtlBaselineProofArtifact, type RawMtlBaselineComparisonInput } from "./proof.js";

export const RAW_MTL_BASELINE_LIVE_FLAG = "ITOTORI_RAW_MTL_BASELINE_LIVE";
export const RAW_MTL_BASELINE_MODEL_ENV = "ITOTORI_RAW_MTL_BASELINE_MODEL";
export const RAW_MTL_BASELINE_PROVIDER_ID_ENV = "ITOTORI_RAW_MTL_BASELINE_PROVIDER_ID";

const defaultBaselineFixtureUrl = new URL(
  "../../../../fixtures/provider-proof/recorded-raw-mtl-baseline-input.json",
  import.meta.url,
);

/**
 * The public baseline fixture is a provider-proof fixture (the naive draft +
 * QA recorded attempts) PLUS the deterministic-QA detector findings used as a
 * comparison anchor.
 */
export type RawMtlBaselineFixture = ProviderProofFixture & {
  deterministicBaselineQa: { findings: QaFinding[] };
};

export type RawMtlBaselineProofResult =
  | { status: "passed"; artifact: RawMtlBaselineProofArtifact }
  | {
      status: "skipped";
      mode: "live";
      reason: "missing_opt_in" | "missing_provider_credential";
    };

export type RawMtlBaselineProofCommandOptions = {
  mode?: "recorded" | "live";
  fixture?: RawMtlBaselineFixture;
  fixturePath?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  maxRepairAttempts?: number;
};

export class RawMtlBaselineFixtureError extends Error {
  constructor(detail: string) {
    super(`raw-mtl-baseline fixture invalid: ${detail}`);
    this.name = "RawMtlBaselineFixtureError";
  }
}

export function readRawMtlBaselineFixture(
  path = fileURLToPath(defaultBaselineFixtureUrl),
): RawMtlBaselineFixture {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertRawMtlBaselineFixture(value);
  return value;
}

export function assertRawMtlBaselineFixture(
  value: unknown,
): asserts value is RawMtlBaselineFixture {
  assertProviderProofFixture(value);
  const record = value as Record<string, unknown>;
  const deterministic = record.deterministicBaselineQa as { findings?: unknown } | undefined;
  if (typeof deterministic !== "object" || deterministic === null) {
    throw new RawMtlBaselineFixtureError("deterministicBaselineQa must be an object");
  }
  if (!Array.isArray(deterministic.findings)) {
    throw new RawMtlBaselineFixtureError("deterministicBaselineQa.findings must be an array");
  }
}

/**
 * Read the validated QA findings recorded for one role of a provider-proof
 * fixture (the LAST recorded attempt — the one a clean run accepts). Parsed
 * with the SHARED QA-finding schema validator.
 */
function recordedQaFindings(fixture: ProviderProofFixture): QaFinding[] {
  const attempts = fixture.roles.qa.attempts;
  const last = attempts[attempts.length - 1];
  if (last === undefined) {
    throw new RawMtlBaselineFixtureError("fixture qa role has no recorded attempt");
  }
  return parseStructuredQaFindingOutput(last.content ?? "").findings;
}

/** Deterministic-QA detector findings validated with the SHARED QA schema. */
function deterministicQaFindings(fixture: RawMtlBaselineFixture): QaFinding[] {
  return parseStructuredQaFindingOutput(
    JSON.stringify({
      schemaVersion: "itotori.structured-qa-finding-output.v1",
      findings: fixture.deterministicBaselineQa.findings,
    }),
  ).findings;
}

/**
 * Build the comparison cells the oracle scores AGAINST the baseline: the
 * Itotori structured draft's LLM-QA (from the recorded provider-proof
 * fixture) and the deterministic-QA detector (from the baseline fixture).
 */
function comparisonAnchors(
  baselineFixture: RawMtlBaselineFixture,
): RawMtlBaselineComparisonInput[] {
  const draftReferenceFixture = readProviderProofFixture();
  return [
    {
      systemKind: "itotori_draft",
      detectorKind: "llm_qa",
      findings: recordedQaFindings(draftReferenceFixture),
    },
    {
      systemKind: "raw_mtl_baseline",
      detectorKind: "deterministic_qa",
      findings: deterministicQaFindings(baselineFixture),
    },
  ];
}

export async function runRawMtlBaselineProofCommand(
  options: RawMtlBaselineProofCommandOptions = {},
): Promise<RawMtlBaselineProofResult> {
  const mode = options.mode ?? "recorded";
  if (mode === "recorded") {
    return runRecordedRawMtlBaselineProof(options);
  }
  return runLiveRawMtlBaselineProof(options);
}

export async function runRecordedRawMtlBaselineProof(
  options: RawMtlBaselineProofCommandOptions = {},
): Promise<RawMtlBaselineProofResult> {
  const fixture = options.fixture ?? readRawMtlBaselineFixture(options.fixturePath);
  assertRawMtlBaselineFixture(fixture);
  const bundle = await runProviderProof({
    mode: "recorded",
    fixtureId: fixture.fixtureId,
    seededDefects: fixture.seededDefects,
    source: recordedAttemptSource(fixture),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    accountZdrAssertion: "recorded_fixture",
  });
  const artifact = buildRawMtlBaselineProofArtifact({
    baselineBundle: bundle,
    seededDefects: fixture.seededDefects,
    comparisons: comparisonAnchors(fixture),
  });
  return { status: "passed", artifact };
}

export async function runLiveRawMtlBaselineProof(
  options: RawMtlBaselineProofCommandOptions = {},
): Promise<RawMtlBaselineProofResult> {
  const env = options.env ?? process.env;
  if (env[RAW_MTL_BASELINE_LIVE_FLAG] !== "1") {
    return { status: "skipped", mode: "live", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", mode: "live", reason: "missing_provider_credential" };
  }
  // The privacy gate: account-wide ZDR must be asserted before any live byte.
  assertOpenRouterZdrAccount(env);

  const fixture = options.fixture ?? readRawMtlBaselineFixture(options.fixturePath);
  assertRawMtlBaselineFixture(fixture);
  const modelId = env[RAW_MTL_BASELINE_MODEL_ENV] ?? "deepseek/deepseek-v4-flash";
  const providerId = env[RAW_MTL_BASELINE_PROVIDER_ID_ENV] ?? "fireworks";
  const recorder = memoryRecorder();
  const capabilities = zdrStructuredCapabilities();
  const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
    modelId,
    apiKey,
    capabilities,
    routing: { zdr: true, dataCollection: "deny", allowFallbacks: true },
    live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
  };
  if (options.fetch !== undefined) {
    providerOptions.fetch = options.fetch;
  }
  const provider = new OpenRouterProvider(providerOptions);

  const source: ProviderProofAttemptSource = async (role, attemptIndex) => {
    const request = rawMtlBaselineLiveRequest({
      role,
      modelId,
      providerId,
      capabilities,
      attemptIndex,
      fixture,
    });
    const result = await provider.invoke(request);
    return { content: result.content, providerRun: result.providerRun };
  };

  const bundle = await runProviderProof({
    mode: "live",
    fixtureId: fixture.fixtureId,
    seededDefects: fixture.seededDefects,
    source,
    maxRepairAttempts: options.maxRepairAttempts ?? PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS,
    accountZdrAssertion: "asserted",
  });
  const artifact = buildRawMtlBaselineProofArtifact({
    baselineBundle: bundle,
    seededDefects: fixture.seededDefects,
    comparisons: comparisonAnchors(fixture),
  });
  return { status: "passed", artifact };
}

/** json_schema is UNROUTABLE under ZDR for the DEV_PAIR; json_object is the proven mode. */
function zdrStructuredCapabilities(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "unsupported",
      jsonObject: "supported",
      preferredModes: ["json_object"],
    },
  };
}

function rawMtlBaselineLiveRequest(args: {
  role: ProviderProofRoleName;
  modelId: string;
  providerId: string;
  capabilities: ModelCapabilities;
  attemptIndex: number;
  fixture: RawMtlBaselineFixture;
}): ModelInvocationRequest {
  const isDraft = args.role === "draft";
  const schema = (isDraft
    ? STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA
    : STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA) as unknown as JsonObject;
  const structuredOutputName = isDraft
    ? STRUCTURED_TRANSLATION_DRAFT_OUTPUT_TOOL_NAME
    : STRUCTURED_QA_FINDING_OUTPUT_TOOL_NAME;
  const promptHash = `sha256:${createHash("sha256")
    .update(`raw-mtl-baseline:${args.role}:${args.attemptIndex}:${args.fixture.fixtureId}`)
    .digest("hex")}`;
  const userPayload = isDraft
    ? {
        bridgeUnitId: args.fixture.bridgeUnitId,
        sourceLocale: args.fixture.sourceLocale,
        targetLocale: args.fixture.targetLocale,
        sourceText: "Hello, traveler. The gate is now open.",
      }
    : {
        bridgeUnitId: args.fixture.bridgeUnitId,
        sourceLocale: args.fixture.sourceLocale,
        targetLocale: args.fixture.targetLocale,
        sourceText: "Hello, traveler. The gate is now open.",
        draftText: "hello traveler the gate is open now",
      };
  return {
    taskKind: isDraft ? "draft_translation" : "llm_qa",
    modelId: args.modelId,
    providerId: args.providerId,
    inputClassification: "synthetic_public",
    messages: [
      {
        role: "system",
        // Deliberately-naive raw MTL: a literal machine translation with NO
        // glossary, context, or QA rigor (the degenerate baseline).
        content: isDraft
          ? "You are a raw machine-translation baseline. Translate the source literally, word for word, with no glossary, context, or stylistic adaptation. Return ONLY a valid StructuredTranslationDraftOutput JSON object using schemaVersion 'itotori.structured-translation-draft-output.v1'; echo the given bridgeUnitId, sourceLocale, targetLocale; set confidenceFloor to 'low'."
          : "Return ONLY a valid StructuredQaFindingOutput JSON object for the raw-MTL draft. Use schemaVersion 'itotori.structured-qa-finding-output.v1'. Emit an empty findings array if the draft is clean.",
      },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    structuredOutput: selectStructuredOutputRequest(args.capabilities, {
      name: structuredOutputName,
      schema,
      strict: true,
    }),
    generation: { temperature: 0, maxOutputTokens: 1200 },
    maxPriceUsd: PROVIDER_PROOF_LIVE_MAX_PRICE_USD,
    prompt: {
      presetId: `itotori-raw-mtl-baseline-${args.role}`,
      templateVersion: "1.0.0",
      promptHash,
      schemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: { fixtureId: args.fixture.fixtureId, role: args.role },
    },
    fallbackModels: [],
  };
}

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

/** A sanitized one-line summary safe to print (no raw prompts/responses/keys). */
export function rawMtlBaselineProofSummary(artifact: RawMtlBaselineProofArtifact): JsonObject {
  return {
    proofId: artifact.proofId,
    systemKind: artifact.systemKind,
    mode: artifact.mode,
    benchmark: {
      fixtureId: artifact.benchmark.fixtureId,
      ledgerRows: artifact.benchmark.ledger.length,
      servedRoutes: artifact.benchmark.servedRoutes,
      totalCostMicrosUsd: artifact.benchmark.totalCostMicrosUsd,
    },
    quality: {
      seededDefectCount: artifact.quality.seededDefectCount,
      comparisons: artifact.quality.comparisons.map((entry) => ({
        comparisonId: entry.comparisonId,
        systemKind: entry.systemKind,
        detectorKind: entry.detectorKind,
        precision: entry.oracle.precision,
        recall: entry.oracle.recall,
        f1: entry.oracle.f1,
        matchedSeededDefectIds: entry.oracle.matchedSeededDefectIds,
      })),
    },
  } as JsonObject;
}
