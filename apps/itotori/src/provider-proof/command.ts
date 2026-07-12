// ITOTORI-116 — provider-proof CLI command (recorded default + opt-in live).
//
// Recorded mode runs with NO credentials over the public fixture; live mode
// is gated behind an explicit opt-in flag + an exported OpenRouter key + the
// account-wide ZDR assertion (the privacy gate). Live mode is BOUND tightly:
// one draft call + one QA call against the pre-authorized ZDR key, each with
// a per-request USD cap, reading the REAL billed cost from `usage.cost`. The
// key is NEVER printed.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA,
  STRUCTURED_QA_FINDING_OUTPUT_TOOL_NAME,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_TOOL_NAME,
  type ProviderProofBundle,
  type ProviderProofRoleName,
  type ProviderProofSeededDefect,
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
import { executeModelInvocation } from "../orchestrator/invocation-supervisor.js";
import {
  assertProviderProofFixture,
  recordedAttemptSource,
  runProviderProof,
  PROVIDER_PROOF_MAX_REPAIR_ATTEMPTS,
  type ProviderProofAttemptSource,
  type ProviderProofFixture,
} from "./harness.js";

export const PROVIDER_PROOF_LIVE_FLAG = "ITOTORI_PROVIDER_PROOF_LIVE";
export const PROVIDER_PROOF_MODEL_ENV = "ITOTORI_PROVIDER_PROOF_MODEL";
export const PROVIDER_PROOF_PROVIDER_ID_ENV = "ITOTORI_PROVIDER_PROOF_PROVIDER_ID";
/** Tight per-request USD cap for each live proof call (1 draft + 1 QA). */
export const PROVIDER_PROOF_LIVE_MAX_PRICE_USD = 0.02;

const defaultFixtureUrl = new URL(
  "../../../../fixtures/provider-proof/recorded-proof-input.json",
  import.meta.url,
);

export type ProviderProofResult =
  | { status: "passed"; bundle: ProviderProofBundle }
  | { status: "skipped"; mode: "live"; reason: "missing_opt_in" | "missing_provider_credential" };

export type ProviderProofCommandOptions = {
  mode?: "recorded" | "live";
  fixture?: ProviderProofFixture;
  fixturePath?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  maxRepairAttempts?: number;
};

export function readProviderProofFixture(
  path = fileURLToPath(defaultFixtureUrl),
): ProviderProofFixture {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertProviderProofFixture(value);
  return value;
}

export async function runProviderProofCommand(
  options: ProviderProofCommandOptions = {},
): Promise<ProviderProofResult> {
  const mode = options.mode ?? "recorded";
  if (mode === "recorded") {
    return runRecordedProviderProof(options);
  }
  return runLiveProviderProof(options);
}

export async function runRecordedProviderProof(
  options: ProviderProofCommandOptions = {},
): Promise<ProviderProofResult> {
  const fixture = options.fixture ?? readProviderProofFixture(options.fixturePath);
  assertProviderProofFixture(fixture);
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
  return { status: "passed", bundle };
}

export async function runLiveProviderProof(
  options: ProviderProofCommandOptions = {},
): Promise<ProviderProofResult> {
  const env = options.env ?? process.env;
  if (env[PROVIDER_PROOF_LIVE_FLAG] !== "1") {
    return { status: "skipped", mode: "live", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", mode: "live", reason: "missing_provider_credential" };
  }
  // The privacy gate: account-wide ZDR must be asserted before any live byte.
  assertOpenRouterZdrAccount(env);

  const fixture = options.fixture ?? readProviderProofFixture(options.fixturePath);
  assertProviderProofFixture(fixture);
  const modelId = env[PROVIDER_PROOF_MODEL_ENV] ?? "deepseek/deepseek-v4-flash";
  const providerId = env[PROVIDER_PROOF_PROVIDER_ID_ENV] ?? "fireworks";
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
    const request = providerProofLiveRequest({
      role,
      modelId,
      providerId,
      capabilities,
      attemptIndex,
      fixture,
    });
    const result = await executeModelInvocation(provider, request);
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
  return { status: "passed", bundle };
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

function providerProofLiveRequest(args: {
  role: ProviderProofRoleName;
  modelId: string;
  providerId: string;
  capabilities: ModelCapabilities;
  attemptIndex: number;
  fixture: ProviderProofFixture;
}): ModelInvocationRequest {
  const isDraft = args.role === "draft";
  const schema = (isDraft
    ? STRUCTURED_TRANSLATION_DRAFT_OUTPUT_JSON_SCHEMA
    : STRUCTURED_QA_FINDING_OUTPUT_JSON_SCHEMA) as unknown as JsonObject;
  const structuredOutputName = isDraft
    ? STRUCTURED_TRANSLATION_DRAFT_OUTPUT_TOOL_NAME
    : STRUCTURED_QA_FINDING_OUTPUT_TOOL_NAME;
  const promptHash = `sha256:${createHash("sha256")
    .update(`provider-proof:${args.role}:${args.attemptIndex}:${args.fixture.fixtureId}`)
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
        draftText: "Bonjour, voyageur. La porte est maintenant ouverte.",
      };
  return {
    taskKind: isDraft ? "draft_translation" : "llm_qa",
    modelId: args.modelId,
    providerId: args.providerId,
    inputClassification: "synthetic_public",
    messages: [
      {
        role: "system",
        content: isDraft
          ? "Return ONLY a valid StructuredTranslationDraftOutput JSON object for the synthetic public unit. Use schemaVersion 'itotori.structured-translation-draft-output.v1'. Echo the given bridgeUnitId, sourceLocale, targetLocale."
          : "Return ONLY a valid StructuredQaFindingOutput JSON object for the synthetic public draft. Use schemaVersion 'itotori.structured-qa-finding-output.v1'. Emit an empty findings array if the draft is clean.",
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
      presetId: `itotori-provider-proof-${args.role}`,
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
export function providerProofSummary(bundle: ProviderProofBundle): JsonObject {
  return {
    proofId: bundle.proofId,
    mode: bundle.mode,
    fixtureId: bundle.fixtureId,
    maxRepairAttempts: bundle.maxRepairAttempts,
    zdr: bundle.zdr,
    roles: bundle.roles.map((role) => ({
      role: role.role,
      terminalStatus: role.terminalStatus,
      attemptCount: role.attempts.length,
      acceptedProviderProofId: role.acceptedProviderProofId,
    })),
    ledgerRows: bundle.ledger.length,
    ledgerCostUsd: bundle.ledger.map((row) => ({
      providerProofId: row.providerProofId,
      servedRoute: `${row.servedProvider}::${row.servedModel}`,
      costUsd: row.costAmount,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      latencyMs: row.latencyMs,
    })),
    qaOracle: bundle.qaOracle,
  } as JsonObject;
}
