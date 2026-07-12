import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  projectStyleGuideConversationToPolicyDraft,
  validateStyleGuideConversationTranscript,
  STYLE_GUIDE_CITATION_SOURCE_KINDS,
  STYLE_GUIDE_CONVERSATION_ROLES,
  STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION,
  STYLE_GUIDE_EXAMPLE_PRIVACY,
  STYLE_GUIDE_POLICY_SECTIONS,
  STYLE_GUIDE_PROPOSAL_DECISIONS,
  STYLE_GUIDE_PROPOSAL_OPERATIONS,
  STYLE_GUIDE_REDACTION_STATUSES,
  type StyleGuideConversationDiagnostic,
  type StyleGuideConversationTranscript,
  type StyleGuideProjectedVersionDraft,
} from "@itotori/localization-bridge-schema";
import { assertRegistrySchemaValue, type RegistrySchemaDescriptor } from "./agents/index.js";
import { executeModelInvocation } from "./orchestrator/invocation-supervisor.js";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  openRouterApiKeyFromEnv,
  openRouterDefaultCapabilities,
  selectStructuredOutputRequest,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ProviderLiveRunOptions,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
  type ProviderRunRecord,
} from "./providers/index.js";

export const STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION =
  "itotori.style-guide-provider-smoke.v0" as const;
export const STYLE_GUIDE_SUGGESTION_TOOL_NAME = "emit_style_guide_suggestion";
export const STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG = "ITOTORI_STYLE_GUIDE_LIVE_PROVIDER_SMOKE";
export const STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV = "ITOTORI_STYLE_GUIDE_PROVIDER_MODEL";
/**
 * ITOTORI-220 — env var for the explicit providerId the smoke must pin.
 * Falls back to the deepseek default when not set, matching the default
 * model.
 */
export const STYLE_GUIDE_LIVE_PROVIDER_ID_ENV = "ITOTORI_STYLE_GUIDE_PROVIDER_ID";

export type StyleGuideProviderSmokeFixture = {
  schemaVersion: typeof STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION;
  fixtureId: string;
  providerResult: {
    finishReason: string;
    contentJson: unknown;
  };
  providerRun: ProviderRunRecord;
  expected: {
    acceptedProposalIds: string[];
    ruleIds: string[];
  };
};

export type ParsedStyleGuideSuggestion = {
  transcript: StyleGuideConversationTranscript;
  projectedVersion: StyleGuideProjectedVersionDraft;
  diagnostics: StyleGuideConversationDiagnostic[];
};

export type StyleGuideProviderSmokeResult =
  | {
      status: "passed";
      mode: "recorded" | "live";
      fixtureId: string;
      parsed: ParsedStyleGuideSuggestion;
      providerRun: ProviderRunRecord;
      artifacts: ProviderRunArtifact[];
      /**
       * ITOTORI-132 — the live invocation's adapterMetadata, carried on the
       * passed live result so a caller can prove the OR-side fallback chain
       * (`openrouterRouting.attempt` / `summary`) was recorded. Absent on
       * recorded-mode passes (replay carries no adapterMetadata).
       */
      adapterMetadata?: JsonObject;
    }
  | {
      status: "skipped";
      mode: "live";
      reason: "missing_opt_in" | "missing_provider_credential";
    };

export type StyleGuideProviderSmokeOptions = {
  fixture?: StyleGuideProviderSmokeFixture;
  fixturePath?: string;
  env?: Record<string, string | undefined>;
  mode?: "recorded" | "live";
  fetch?: typeof fetch;
  live?: ProviderLiveRunOptions;
  /**
   * ITOTORI-132 — fallback model ids to append to the style-guide smoke
   * request's `fallbackModels`. When non-empty the request sends OpenRouter a
   * multi-entry `models` plan (`[primary, ...fallbackModels]`) so an opted-in
   * live run can exercise a real OR-side fallback. A mocked live smoke passes
   * these to prove the smoke ledger records a coherent `fallbackPlan` +
   * `fallbackChain` when OpenRouter serves a non-primary entry. Defaults to
   * `[]` (single-model plan, no fallback) — the deterministic recorded-mode
   * shape that needs no live provider access.
   */
  fallbackModels?: string[];
};

const defaultFixtureUrl = new URL(
  "../../../fixtures/itotori-style-guide/provider-smoke-suggestion.json",
  import.meta.url,
);

export async function runStyleGuideProviderSmoke(
  options: StyleGuideProviderSmokeOptions = {},
): Promise<StyleGuideProviderSmokeResult> {
  const mode = options.mode ?? "recorded";
  if (mode === "recorded") {
    return runRecordedStyleGuideProviderSmoke(
      options.fixture ?? readSmokeFixture(options.fixturePath),
    );
  }
  return runLiveStyleGuideProviderSmoke(options);
}

export function runRecordedStyleGuideProviderSmoke(
  fixture: StyleGuideProviderSmokeFixture,
): StyleGuideProviderSmokeResult {
  assertSmokeFixture(fixture);
  const result: ModelInvocationResult = {
    content: JSON.stringify(fixture.providerResult.contentJson),
    toolCalls: [],
    finishReason: fixture.providerResult.finishReason,
    providerRun: fixture.providerRun,
  };
  const parsed = parseStyleGuideSuggestionFromProviderResult(result);
  assertStyleGuideProviderSmokeLedger(fixture.providerRun);
  assertExpectedStyleGuideSuggestion(parsed, fixture.expected);
  return {
    status: "passed",
    mode: "recorded",
    fixtureId: fixture.fixtureId,
    parsed,
    providerRun: fixture.providerRun,
    artifacts: [],
  };
}

export async function runLiveStyleGuideProviderSmoke(
  options: StyleGuideProviderSmokeOptions = {},
): Promise<StyleGuideProviderSmokeResult> {
  const env = options.env ?? process.env;
  if (env[STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG] !== "1") {
    return { status: "skipped", mode: "live", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", mode: "live", reason: "missing_provider_credential" };
  }
  assertOpenRouterZdrAccount(env);

  const recorder = memoryRecorder();
  const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
    modelId: env[STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV] ?? "deepseek/deepseek-v4-flash",
    apiKey,
    capabilities: styleGuideLiveSmokeCapabilities(),
    routing: { allowFallbacks: true, dataCollection: "deny" },
    live: options.live ?? { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
  };
  if (options.fetch !== undefined) {
    providerOptions.fetch = options.fetch;
  }
  const provider = new OpenRouterProvider({
    ...providerOptions,
  });
  const providerId = env[STYLE_GUIDE_LIVE_PROVIDER_ID_ENV] ?? "deepseek";
  const request = styleGuideSuggestionRequest(
    provider.descriptor.defaultModelId,
    providerId,
    styleGuideLiveSmokeCapabilities(),
    options.fallbackModels ?? [],
  );
  const result = await executeModelInvocation(provider, request);
  const parsed = parseStyleGuideSuggestionFromProviderResult(result);
  assertStyleGuideProviderSmokeLedger(result.providerRun);
  return {
    status: "passed",
    mode: "live",
    fixtureId: "style-guide-live-provider-smoke",
    parsed,
    providerRun: result.providerRun,
    artifacts: recorder.artifacts,
    // ITOTORI-132 — surface the invocation's adapterMetadata (which carries
    // `openrouterRouting` with the OR-side fallback `attempt` / `summary`)
    // so a caller can prove the fallback chain was recorded without reaching
    // into the artifacts array. Recorded-mode smoke has no adapterMetadata
    // (replay), so this is live-only.
    ...(result.adapterMetadata !== undefined ? { adapterMetadata: result.adapterMetadata } : {}),
  };
}

export function parseStyleGuideSuggestionFromProviderResult(
  result: ModelInvocationResult,
): ParsedStyleGuideSuggestion {
  const value =
    result.providerRun.structuredOutputMode === "tool_call_arguments"
      ? parseToolCallSuggestion(result)
      : parseJsonContent(result.content);
  assertStyleGuideSuggestionStructuredOutput(value);
  const diagnostics = validateStyleGuideConversationTranscript(value);
  if (diagnostics.length > 0) {
    const first = diagnostics[0] ?? {
      turnId: "transcript",
      field: "$",
      rule: "style_guide_conversation.unknown",
      message: "style-guide suggestion failed validation",
    };
    throw new Error(
      `style-guide suggestion validation failed at ${first.field} (${first.rule}): ${first.message}`,
    );
  }
  return {
    transcript: value as StyleGuideConversationTranscript,
    projectedVersion: projectStyleGuideConversationToPolicyDraft(value),
    diagnostics,
  };
}

/**
 * ITOTORI-133 — the structured-output boundary check. Rejects a malformed
 * style-guide suggestion (missing required fields, non-object turn/proposal
 * items, wrong types) against the tightened canonical schema BEFORE the deep
 * transcript validator runs, so structurally malformed turns/proposals fail
 * early at the boundary instead of slipping through to semantic validation or
 * policy projection.
 */
export function assertStyleGuideSuggestionStructuredOutput(value: unknown): void {
  try {
    assertRegistrySchemaValue(
      styleGuideSuggestionSchemaDescriptor,
      value,
      "style-guide suggestion",
    );
  } catch (error) {
    throw new Error(
      `style-guide suggestion rejected at structured-output boundary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function styleGuideSuggestionRequest(
  modelId: string,
  providerId: string = "deepseek",
  // ITOTORI-241 — the smoke selects its structured mode from the active
  // pair's capability sheet rather than forcing json_schema. Under ZDR the
  // DEV_PAIR's providers don't advertise json_schema (HTTP 404), so the
  // selection resolves to json_object — the proven-routable mode. Callers
  // pass a sheet (the live runner uses styleGuideLiveSmokeCapabilities);
  // the default mirrors that ZDR-correct sheet.
  capabilities: ModelCapabilities = styleGuideLiveSmokeCapabilities(),
  // ITOTORI-132 — fallback model ids appended to the request's
  // `fallbackModels`. When non-empty the OR request body carries a
  // multi-entry `models` plan so an opted-in live run can fall back across
  // models; the smoke ledger then records the full `fallbackPlan` and the
  // served (actual) model. Defaults to `[]` (single-model, no fallback) so
  // the recorded-mode smoke stays deterministic.
  fallbackModels: string[] = [],
): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId,
    // ITOTORI-220 — defaults to the deepseek provider that matches the
    // built-in style-guide-smoke fixture; callers may override.
    providerId,
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-style-guide-smoke-v1",
      templateVersion: "1.0.0",
      promptHash: "sha256:6464646464646464646464646464646464646464646464646464646464646464",
      schemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: {
        fixtureId: "style-guide-live-provider-smoke",
        output: "style-guide conversation transcript",
      },
    },
    preset: {
      slug: "openrouter/itotori-style-guide-smoke",
      version: "2026-06-19",
      configHash: "sha256:6565656565656565656565656565656565656565656565656565656565656565",
      configSnapshot: {
        route: "style-guide-smoke",
        rawCapture: "disabled",
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Return only a valid JSON style-guide conversation transcript for the synthetic public Itotori fixture.",
      },
      {
        role: "user",
        content: JSON.stringify({
          projectId: "019ed064-0000-7000-8000-000000000001",
          localeBranchId: "019ed064-0000-7000-8000-000000000010",
          basePolicyVersionId: "019ed064-0000-7000-8000-000000000020",
          projectedStyleGuideVersionId: "019ed064-0000-7000-8000-000000000030",
          targetLocale: "en-US",
          requestedRules: ["tone", "protectedSpans"],
        }),
      },
    ],
    structuredOutput: selectStructuredOutputRequest(capabilities, {
      name: "itotori_style_guide_suggestion",
      schema: styleGuideSuggestionJsonSchema(),
      strict: true,
    }),
    generation: {
      temperature: 0,
      maxOutputTokens: 1600,
    },
    fallbackModels: [...fallbackModels],
  };
}

export function assertStyleGuideProviderSmokeLedger(run: ProviderRunRecord): void {
  const missing: string[] = [];
  if (!run.provider.providerFamily) {
    missing.push("provider.providerFamily");
  }
  if (!run.provider.providerName) {
    missing.push("provider.providerName");
  }
  if (!run.provider.requestedModelId || !run.provider.actualModelId) {
    missing.push("provider model identity");
  }
  if (run.fallbackPlan.length === 0) {
    missing.push("fallbackPlan");
  }
  if (!Number.isInteger(run.retryCount) || run.retryCount < 0) {
    missing.push("retryCount");
  }
  if (run.tokenUsage.tokenCountSource === "unknown" || run.tokenUsage.totalTokens === undefined) {
    missing.push("tokenUsage estimate");
  }
  // ITOTORI-225 — ProviderCost.amountMicrosUsd is non-optional and the
  // enum is `'billed' | 'zero'`; a missing real cost no longer has a
  // representation, so we only flag the case where the smoke run somehow
  // landed without a billed amount on a successful invocation.
  if (run.status === "succeeded" && run.cost.costKind !== "billed") {
    missing.push("billed cost");
  }
  // ITOTORI-227 — per-pair privacy axes were deleted. Privacy posture
  // is enforced account-wide (ZDR via assertOpenRouterZdrAccount) plus
  // per-request (`provider.zdr=true` for non-public input). The smoke
  // check no longer inspects per-pair axes; the ledger row is gated by
  // the account/posture assertion at process startup.
  if (missing.length > 0) {
    throw new Error(`style-guide provider smoke ledger missing ${missing.join(", ")}`);
  }
}

/**
 * ITOTORI-132 — expected shape of a successful fallback run driven through the
 * style-guide live smoke path. The primary (modelId, providerId) pair is what
 * the request asked for; the served pair is what OpenRouter actually routed to
 * after the primary failed. `fallbackModel` is the non-primary entry in the
 * request's `fallbackPlan` that OpenRouter served.
 */
export type StyleGuideProviderSmokeFallbackExpectation = {
  /** The requested (primary) model id — `request.modelId`. */
  requestedModelId: string;
  /** A non-primary model id the request asked OpenRouter to fall back to. */
  fallbackModel: string;
  /** The model id OpenRouter actually served (the fallback model). */
  servedModelId: string;
  /** The upstream provider that served the fallback model. */
  servedProviderId: string;
};

/**
 * ITOTORI-132 — prove the style-guide smoke ledger records a coherent
 * fallback chain for a successful fallback run.
 *
 * A fallback run is one where the primary (modelId, providerId) pair failed
 * transiently and OpenRouter served a different entry from the request's
 * `fallbackPlan`. The ledger must prove:
 *
 *   1. `fallbackPlan` — the planned models list — includes BOTH the primary
 *      and the fallback model (the plan that was on the wire).
 *   2. `fallbackUsed` is `true` (the chain was actually exercised).
 *   3. `requestedModelId` is the primary model (what the request pinned).
 *   4. `actualModelId` is the served (fallback) model, differing from the
 *      requested — the real served pair, per
 *      [[feedback_or_side_fallback_not_strict_pin]].
 *   5. `upstreamProvider` is the provider that served the fallback model.
 *   6. `retryCount` is a non-negative integer AND `>= 1` — a fallback implies
 *      at least one retry (OpenRouter's router `attempt` was `> 1`).
 *
 * This complements (does not replace) {@link assertStyleGuideProviderSmokeLedger},
 * which checks the structural ledger fields for every run. Call this only for a
 * run that actually fell back; a direct-serve run would (correctly) fail the
 * `fallbackUsed` / `retryCount` checks.
 */
export function assertStyleGuideProviderSmokeFallbackLedger(
  run: ProviderRunRecord,
  expected: StyleGuideProviderSmokeFallbackExpectation,
): void {
  const failures: string[] = [];
  if (!run.fallbackPlan.includes(expected.requestedModelId)) {
    failures.push(`fallbackPlan missing requested model '${expected.requestedModelId}'`);
  }
  if (!run.fallbackPlan.includes(expected.fallbackModel)) {
    failures.push(`fallbackPlan missing fallback model '${expected.fallbackModel}'`);
  }
  if (run.fallbackUsed !== true) {
    failures.push("fallbackUsed is not true");
  }
  if (run.provider.requestedModelId !== expected.requestedModelId) {
    failures.push(
      `requestedModelId '${run.provider.requestedModelId}' !== '${expected.requestedModelId}'`,
    );
  }
  if (run.provider.actualModelId !== expected.servedModelId) {
    failures.push(
      `actualModelId '${run.provider.actualModelId}' !== served '${expected.servedModelId}'`,
    );
  }
  if (run.provider.actualModelId === run.provider.requestedModelId) {
    failures.push("actualModelId equals requestedModelId (no model-level fallback recorded)");
  }
  if (run.provider.upstreamProvider !== expected.servedProviderId) {
    failures.push(
      `upstreamProvider '${run.provider.upstreamProvider ?? "<absent>"}' !== served '${expected.servedProviderId}'`,
    );
  }
  if (!Number.isInteger(run.retryCount) || run.retryCount < 0) {
    failures.push(`retryCount '${run.retryCount}' is not a non-negative integer`);
  } else if (run.retryCount < 1) {
    failures.push("retryCount is 0 but a fallback occurred (expected >= 1 retry)");
  }
  if (failures.length > 0) {
    throw new Error(
      `style-guide provider smoke fallback ledger incoherent: ${failures.join("; ")}`,
    );
  }
}

/**
 * ITOTORI-132 — fallback expectations for an opted-in live style-guide smoke
 * run.
 *
 * When the smoke request carries a non-empty `fallbackModels` list, the
 * request body sends OpenRouter a multi-entry `models` plan
 * (`[primary, ...fallbackModels]`) with `allow_fallbacks: true`. If the
 * primary provider (order[0]) transiently fails (e.g. 429), OpenRouter
 * advances to the next ZDR-allow-list provider and serves a fallback entry.
 * The smoke ledger then records:
 *
 *   - `fallbackPlan`: the full planned models list (`[primary, ...fallbacks]`).
 *   - `fallbackUsed: true`: the chain was exercised.
 *   - `provider.requestedModelId`: the primary model the request pinned.
 *   - `provider.actualModelId`: the model OpenRouter actually served (a
 *     non-primary entry) — the real served pair, recorded as the truth per
 *     [[feedback_or_side_fallback_not_strict_pin]] (no strict provider pin).
 *   - `provider.upstreamProvider`: the provider that served the fallback.
 *   - `retryCount`: derived from OpenRouter's 1-indexed router `attempt`
 *     (`attempt-1`), so a fallback reads as `>= 1` retry, coherent with
 *     `fallbackUsed`.
 *   - `adapterMetadata.openrouterRouting`: the OR-side fallback chain
 *     evidence (`attempt`, `summary`, `strategy`) mirrored verbatim from the
 *     response's `openrouter_metadata`, so the swap is auditable, not silent.
 *
 * Recorded-mode smoke (the default) sends a single-model plan with no
 * `fallbackModels`, so none of the above fallback fields engage — it stays
 * deterministic and needs no live provider access.
 */
export const STYLE_GUIDE_SMOKE_FALLBACK_EXPECTATIONS = {
  fallbackPlan: "full planned models list ([primary, ...fallbacks])",
  fallbackUsed: "true when the chain was exercised",
  requestedModelId: "the primary model the request pinned",
  actualModelId: "the model OpenRouter actually served (a non-primary entry)",
  upstreamProvider: "the provider that served the fallback model",
  retryCount: "OpenRouter router attempt - 1 (>= 1 when a fallback occurred)",
  openrouterRouting: "OR-side attempt / summary / strategy mirrored verbatim",
} as const;

export function readSmokeFixture(
  path = fileURLToPath(defaultFixtureUrl),
): StyleGuideProviderSmokeFixture {
  return JSON.parse(readFileSync(path, "utf8")) as StyleGuideProviderSmokeFixture;
}

function parseJsonContent(content: string | null): unknown {
  if (content === null || content.trim().length === 0) {
    throw new Error("style-guide suggestion content is empty");
  }
  return JSON.parse(content) as unknown;
}

function parseToolCallSuggestion(result: ModelInvocationResult): unknown {
  const toolCall = result.toolCalls.find((call) => call.name === STYLE_GUIDE_SUGGESTION_TOOL_NAME);
  if (!toolCall) {
    throw new Error(`style-guide suggestion tool call ${STYLE_GUIDE_SUGGESTION_TOOL_NAME} missing`);
  }
  return JSON.parse(toolCall.argumentsJson) as unknown;
}

function assertExpectedStyleGuideSuggestion(
  parsed: ParsedStyleGuideSuggestion,
  expected: StyleGuideProviderSmokeFixture["expected"],
): void {
  if (
    JSON.stringify(parsed.projectedVersion.acceptedProposalIds) !==
    JSON.stringify(expected.acceptedProposalIds)
  ) {
    throw new Error("style-guide suggestion accepted proposals did not match the recorded fixture");
  }
  const ruleIds = Object.values(parsed.projectedVersion.policy.sections)
    .flat()
    .map((rule) => rule.ruleId);
  for (const expectedRuleId of expected.ruleIds) {
    if (!ruleIds.includes(expectedRuleId)) {
      throw new Error(`style-guide suggestion missing expected rule ${expectedRuleId}`);
    }
  }
}

function assertSmokeFixture(value: StyleGuideProviderSmokeFixture): void {
  if (value.schemaVersion !== STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION) {
    throw new Error("style-guide provider smoke fixture schema version mismatch");
  }
}

function styleGuideLiveSmokeCapabilities(): ModelCapabilities {
  // ITOTORI-241 — json_schema is UNROUTABLE under ZDR for the DEV_PAIR
  // (HTTP 404 "No endpoints found that can handle the requested
  // parameters"); json_object is the proven-routable deterministic mode
  // (billed $0.00001708 in the live proof). The smoke's structured-mode
  // selection reads this sheet, so the live smoke no longer 404s.
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

function styleGuideSuggestionJsonSchema(): JsonObject {
  return styleGuideSuggestionSchemaDescriptor.jsonSchema;
}

/**
 * ITOTORI-133 — the canonical structured-output contract for a style-guide
 * conversation transcript. Turns and proposals carry TYPED item requirements
 * (required fields + property shapes) instead of bare arrays, so a malformed
 * turn/proposal is rejected at the structured-output boundary BEFORE the deep
 * transcript validator / policy projection ever run.
 *
 * This is a structural FLOOR (`additionalProperties: true`): it pins the
 * required shape of every turn/proposal item but leaves optional and
 * section-specific fields (e.g. edit `toneRegister`/`spanKind`/`preserveMode`,
 * example `publicText`) to the deep validator, which remains the privacy and
 * semantic ceiling. Enum values are spread from the canonical
 * `STYLE_GUIDE_*` constants so the schema cannot drift from the types.
 */
export const styleGuideSuggestionSchemaDescriptor: RegistrySchemaDescriptor = {
  schemaId: "itotori.style-guide-suggestion",
  schemaVersion: STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION,
  description:
    "Structured-output contract for a style-guide conversation transcript; " +
    "turns and proposals carry typed item requirements rejected at the boundary.",
  jsonSchema: {
    type: "object",
    required: [
      "schemaVersion",
      "transcriptId",
      "projectId",
      "localeBranchId",
      "targetLocale",
      "basePolicyVersionId",
      "projectedStyleGuideVersionId",
      "recordingMode",
      "turns",
      "proposals",
    ],
    additionalProperties: true,
    properties: {
      schemaVersion: { const: STYLE_GUIDE_CONVERSATION_SCHEMA_VERSION },
      transcriptId: { type: "string", minLength: 1 },
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      targetLocale: { type: "string", minLength: 1 },
      basePolicyVersionId: { type: "string", minLength: 1 },
      projectedStyleGuideVersionId: { type: "string", minLength: 1 },
      recordingMode: { type: "string", enum: ["public_fixture", "human_entered"] },
      turns: {
        type: "array",
        items: {
          type: "object",
          required: [
            "turnId",
            "role",
            "localeBranchId",
            "policyVersionId",
            "redaction",
            "proposalIds",
            "citations",
            "publicSummary",
          ],
          additionalProperties: true,
          properties: {
            turnId: { type: "string", minLength: 1 },
            role: { type: "string", enum: [...STYLE_GUIDE_CONVERSATION_ROLES] },
            localeBranchId: { type: "string", minLength: 1 },
            policyVersionId: { type: "string", minLength: 1 },
            redaction: {
              type: "object",
              required: ["status", "privateExampleRefs"],
              additionalProperties: true,
              properties: {
                status: { type: "string", enum: [...STYLE_GUIDE_REDACTION_STATUSES] },
                privateExampleRefs: { type: "array", items: { type: "string" } },
              },
            },
            proposalIds: { type: "array", items: { type: "string" } },
            citations: {
              type: "array",
              items: {
                type: "object",
                required: ["citationId", "sourceKind", "sourceRef", "excerptHash"],
                additionalProperties: true,
                properties: {
                  citationId: { type: "string", minLength: 1 },
                  sourceKind: {
                    type: "string",
                    enum: [...STYLE_GUIDE_CITATION_SOURCE_KINDS],
                  },
                  sourceRef: { type: "string", minLength: 1 },
                  excerptHash: { type: "string", minLength: 1 },
                },
              },
            },
            publicSummary: { type: "string", minLength: 1 },
          },
        },
      },
      proposals: {
        type: "array",
        items: {
          type: "object",
          required: [
            "proposalId",
            "turnId",
            "localeBranchId",
            "policyVersionId",
            "rationale",
            "citationIds",
            "examples",
            "edits",
            "decision",
          ],
          additionalProperties: true,
          properties: {
            proposalId: { type: "string", minLength: 1 },
            turnId: { type: "string", minLength: 1 },
            localeBranchId: { type: "string", minLength: 1 },
            policyVersionId: { type: "string", minLength: 1 },
            rationale: { type: "string", minLength: 1 },
            citationIds: { type: "array", items: { type: "string" } },
            examples: {
              type: "array",
              items: {
                type: "object",
                required: ["exampleId", "privacy", "redactionStatus", "excerptHash"],
                additionalProperties: true,
                properties: {
                  exampleId: { type: "string", minLength: 1 },
                  privacy: { type: "string", enum: [...STYLE_GUIDE_EXAMPLE_PRIVACY] },
                  redactionStatus: {
                    type: "string",
                    enum: [...STYLE_GUIDE_REDACTION_STATUSES],
                  },
                  excerptHash: { type: "string", minLength: 1 },
                },
              },
            },
            edits: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["operation", "section", "rule"],
                additionalProperties: true,
                properties: {
                  operation: {
                    type: "string",
                    enum: [...STYLE_GUIDE_PROPOSAL_OPERATIONS],
                  },
                  section: { type: "string", enum: [...STYLE_GUIDE_POLICY_SECTIONS] },
                  rule: {
                    type: "object",
                    required: ["ruleId", "guidance"],
                    additionalProperties: true,
                    properties: {
                      ruleId: { type: "string", minLength: 1 },
                      guidance: { type: "string", minLength: 1 },
                    },
                  },
                },
              },
            },
            decision: {
              type: "object",
              required: ["status", "decidedByTurnId", "rationale"],
              additionalProperties: true,
              properties: {
                status: { type: "string", enum: [...STYLE_GUIDE_PROPOSAL_DECISIONS] },
                decidedByTurnId: { type: "string", minLength: 1 },
                rationale: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
};

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const result = await runStyleGuideProviderSmoke({ mode: live ? "live" : "recorded" });
  const summary =
    result.status === "passed"
      ? {
          status: result.status,
          mode: result.mode,
          fixtureId: result.fixtureId,
          provider: result.providerRun.provider.providerName,
          model: result.providerRun.provider.actualModelId,
          acceptedProposalIds: result.parsed.projectedVersion.acceptedProposalIds,
        }
      : result;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
