import { assertProviderInvocationSupported } from "./capability-guard.js";
import { LocalProviderRunArtifactRecorder } from "./artifacts.js";
import { DEFAULT_COST_CAP_USD, OpenRouterModelProvider } from "./openrouter.js";
import type {
  ModelCapabilities,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderDescriptor,
  ProviderFamily,
  ProviderRunArtifactRecorder,
  ProviderRunRecord,
} from "./types.js";
import { createProviderRunId, localOnlyRoutingPosture } from "./types.js";

/**
 * ITOTORI-220 — fake-provider construction options. The model identifier
 * is an optional override that pins the provider's defaultModelId; the
 * value travels onto every invocation's requestedModelId. Falls back to
 * a fixed sentinel so test suites that do not care about identity stay
 * terse. Declared via `Partial<{...}>` rather than per-field optional
 * syntax so the type satisfies the project-wide invariant on the legacy
 * model-only field syntax.
 */
export type FakeModelProviderOptions = Partial<{
  providerName: string;
  modelId: string;
  generate: (request: ModelInvocationRequest) => string;
}>;

export class FakeModelProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly generate: (request: ModelInvocationRequest) => string;

  constructor(options: FakeModelProviderOptions = {}) {
    const modelId = options.modelId ?? "itotori-fake-draft-v0";
    this.descriptor = {
      family: "fake",
      endpointFamily: "chat-completions",
      providerName: options.providerName ?? "itotori-fixture",
      defaultModelId: modelId,
      capabilities: fakeModelCapabilities,
    };
    this.generate = options.generate ?? defaultFakeCompletion;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    assertProviderInvocationSupported({ descriptor: this.descriptor, request });
    const startedAt = new Date().toISOString();
    const content = this.generate(request);
    const completedAt = new Date().toISOString();
    const requestedModelId = request.modelId;
    const promptTokens = countApproximateTokens(
      request.messages.map((message) => message.content).join(" "),
    );
    const completionTokens = countApproximateTokens(content);
    const run: ProviderRunRecord = {
      runId: request.runId ?? createProviderRunId("fake"),
      taskKind: request.taskKind,
      startedAt,
      completedAt,
      latencyMs: 0,
      status: "succeeded",
      provider: {
        providerFamily: this.descriptor.family,
        endpointFamily: this.descriptor.endpointFamily,
        providerName: this.descriptor.providerName,
        requestedModelId,
        requestedProviderId: request.providerId,
        actualModelId: requestedModelId,
      },
      structuredOutputMode: request.structuredOutput?.mode ?? "none",
      retryCount: 0,
      errorClasses: [],
      fallbackUsed: false,
      fallbackPlan: request.fallbackModels ?? [requestedModelId],
      tokenUsage: {
        tokenCountSource: "deterministic_counter",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: {
        costKind: "zero",
        currency: "USD",
        amountUsd: "0",
        amountMicrosUsd: 0,
      },
      // ITOTORI-230 — fake providers never leave the process so the
      // canonical ZDR posture is trivially in force; record it
      // explicitly so the ledger row + telemetry have a uniform shape.
      routingPosture: localOnlyRoutingPosture(request.providerId),
      // ITOTORI-232 — fake providers never bill, so the captured
      // `usage` block carries no `cost` key. The partial-NULL CHECK on
      // the ledger exempts these rows; the typed sentinel here
      // documents WHY no billed-cost field exists.
      usageResponseJson: { _fake_no_billing: true },
      prompt: request.prompt,
    };
    if (request.preset) {
      run.providerPreset = request.preset;
    }
    return { content, toolCalls: [], finishReason: "stop", providerRun: run };
  }
}

export const fakeModelCapabilities: ModelCapabilities = {
  structuredOutputs: {
    jsonSchema: "supported",
    jsonObject: "supported",
    toolCallArguments: "supported",
    plainJsonExtraction: "supported",
    preferredModes: ["json_schema", "json_object", "tool_call_arguments", "plain_json"],
  },
  toolCalls: {
    support: "supported",
    parallelToolCalls: "unsupported",
    requiresSchemaPerRequest: false,
  },
  imageInput: {
    support: "unsupported",
  },
  routing: {
    providerRouting: "unsupported",
    modelFallbacks: "unsupported",
    presets: "unsupported",
    requireParameters: "unsupported",
    dataCollectionControl: "unsupported",
    zeroDataRetentionRouting: "unsupported",
  },
  notes: ["deterministic fake provider for CI and unit tests"],
};

function defaultFakeCompletion(request: ModelInvocationRequest): string {
  const sourceText = extractSourceText(request);
  if (sourceText === "こんにちは、{player}。") {
    return "Hello, {player}.";
  }
  return `[en-US] ${sourceText}`;
}

function extractSourceText(request: ModelInvocationRequest): string {
  const lastUserMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (typeof lastUserMessage?.content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(lastUserMessage.content) as { sourceText?: unknown };
    if (typeof parsed.sourceText === "string") {
      return parsed.sourceText;
    }
  } catch {
    return lastUserMessage.content;
  }
  return lastUserMessage.content;
}

function countApproximateTokens(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * itotori-semantic-agent-clis-no-fake-context-on-real-path — shared
 * provider-resolution policy for the semantic-agent CLIs (scene-summary,
 * route-choice-map, character-relationship, terminology-candidate).
 *
 * Strict-proof rule: FAKES BELONG ONLY IN TESTS. These CLIs feed their
 * output into REAL translation-context DB artifacts, so on a real path they
 * must NEVER silently produce (or fall back to) fake-derived context.
 *
 * - The `fake` family is reachable ONLY behind an EXPLICIT test/dev opt-in
 *   (`ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1`); without it the CLI refuses
 *   LOUDLY with a typed error rather than fabricating context.
 * - The live provider family (`openrouter`) is WIRED to the real, ZDR-gated
 *   OpenRouter provider — the SAME `OpenRouterModelProvider` the translation
 *   path uses. Its (modelId, providerId) routing is config-driven: the pair
 *   travels on each request from the agent's `modelProfile` (never hard-coded
 *   here). The account-wide ZDR assertion + the missing-API-key refusal fire
 *   inside that provider's constructor (fail-closed), and cost is recorded
 *   from the real `usage.cost` on every call.
 * - Any other non-fake family (`recorded` / `local-openai-compatible`) needs
 *   explicit per-call config (a recorded bundle / a base URL) that this
 *   resolver does not carry, so it refuses LOUDLY with a typed error rather
 *   than substituting a fake.
 */

/** Env opt-in that makes the fake semantic-agent provider reachable. */
export const ALLOW_FAKE_SEMANTIC_AGENT_ENV = "ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT";

/**
 * Thrown when a semantic-agent CLI is asked for the `fake` provider family
 * without the explicit test/dev opt-in. The fake provider is test-only; a
 * production run must never silently receive one.
 */
export class SemanticAgentFakeProviderNotAllowedError extends Error {
  readonly agentName: string;
  constructor(agentName: string) {
    super(
      `semantic-agent '${agentName}' refused to construct a FakeModelProvider: ` +
        `the fake provider is test-only and must never feed fake context into real DB artifacts. ` +
        `Set ${ALLOW_FAKE_SEMANTIC_AGENT_ENV}=1 to opt in for tests/dev, or run with a real provider family.`,
    );
    this.name = "SemanticAgentFakeProviderNotAllowedError";
    this.agentName = agentName;
  }
}

/**
 * Thrown when a semantic-agent CLI is asked for a non-fake provider family
 * that this resolver does not wire (`recorded` / `local-openai-compatible`).
 * Those families need per-call config (a recorded bundle / a base URL) that
 * `resolveSemanticAgentProvider` does not carry; the live semantic-agent path
 * is the ZDR OpenRouter provider. The CLI refuses loudly rather than falling
 * back to a fake, so a real run can only produce real context or a typed
 * error — never fake-derived context.
 */
export class SemanticAgentUnsupportedLiveFamilyError extends Error {
  readonly agentName: string;
  readonly family: ProviderFamily;
  constructor(agentName: string, family: ProviderFamily) {
    super(
      `semantic-agent '${agentName}' has no wired live provider for family '${family}': ` +
        `the live semantic-agent path is the ZDR OpenRouter provider ('openrouter'). ` +
        `The '${family}' family needs explicit per-call config (a recorded bundle / a base URL) ` +
        `that this resolver does not carry, so it refuses rather than substituting a fake.`,
    );
    this.name = "SemanticAgentUnsupportedLiveFamilyError";
    this.agentName = agentName;
    this.family = family;
  }
}

/**
 * Live-path construction knobs for the ZDR OpenRouter semantic-agent provider.
 * All optional: production defaults mirror the translation path (the shared
 * per-process `DEFAULT_COST_CAP_USD` cap + a `LocalProviderRunArtifactRecorder`
 * writing to its default directory). The (modelId, providerId) routing is NOT
 * here — it is config-driven, travelling on each request from the agent's
 * `modelProfile`. Tests inject a scratch `artifactRecorder` + `env`.
 */
export type SemanticAgentLiveProviderOptions = {
  costCapUsd?: number;
  artifactRecorder?: ProviderRunArtifactRecorder;
  env?: Readonly<Record<string, string | undefined>>;
  providerName?: string;
};

/**
 * Resolve the model provider for a semantic-agent CLI.
 *
 * - `fake` is gated behind the explicit `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1`
 *   test/dev opt-in.
 * - `openrouter` is the LIVE path: it builds the real, ZDR-gated
 *   `OpenRouterModelProvider` (the same one the translation path uses). The
 *   account-wide ZDR assertion + the missing-key refusal fire in that
 *   provider's constructor (fail-closed); cost is recorded from the real
 *   `usage.cost`; and the (modelId, providerId) pair is config-driven per
 *   request via the agent's `modelProfile`.
 * - every other non-fake family loud-refuses with a typed error.
 */
export function resolveSemanticAgentProvider(options: {
  agentName: string;
  family: ProviderFamily;
  fakeProviderName: string;
  live?: SemanticAgentLiveProviderOptions;
}): ModelProvider {
  const { agentName, family, fakeProviderName } = options;
  if (family === "fake") {
    if (process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV] !== "1") {
      throw new SemanticAgentFakeProviderNotAllowedError(agentName);
    }
    return new FakeModelProvider({ providerName: fakeProviderName });
  }
  if (family === "openrouter") {
    const live = options.live ?? {};
    // Mirror the translation path (see localize-project-stage-command.ts
    // `liveOpenRouterFactory`): construct the real OpenRouterModelProvider,
    // which asserts the account-wide ZDR posture and refuses on a missing
    // API key in its constructor, routes the request's (modelId, providerId)
    // pair with `provider.zdr=true`, and records real `usage.cost`.
    return new OpenRouterModelProvider({
      costCapUsd: live.costCapUsd ?? DEFAULT_COST_CAP_USD,
      artifactRecorder: live.artifactRecorder ?? new LocalProviderRunArtifactRecorder(),
      ...(live.env !== undefined ? { env: live.env } : {}),
      ...(live.providerName !== undefined ? { providerName: live.providerName } : {}),
    });
  }
  throw new SemanticAgentUnsupportedLiveFamilyError(agentName, family);
}
