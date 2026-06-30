// UTSUSHI-228 / ITOTORI-238 — `itotori:localize-project-stage` CLI handler.
//
// Thin LIVE-LLM wrapper around `runAgenticLoopForUnit` used by the
// suite/scripts/localize-project/run.mjs driver. Distinct from
// `agentic-loop-smoke` because that command HARD-REFUSES live providers
// (it is a synthetic CI smoke). This command does the opposite: it
// hard-requires the live OpenRouter provider via OPENROUTER_API_KEY,
// loads the pair-policy from a JSON file (NO defaulting), and weaves
// the en-US sentinel into the prompt so the translated draft text the
// LLM emits is guaranteed to include the substring the patchback +
// replay-validate pipeline asserts on.
//
// Resilience model — OpenRouter-side fallback (post-ITOTORI-241):
//
//   This driver runs the SINGLE pair-policy primary pair for every
//   stage. It does NOT carry an app-level 429-failover / alternate-
//   chaining loop. On the wire the OpenRouter provider sends
//   `provider.order = [providerId]` + `provider.allow_fallbacks = true`
//   + `provider.zdr = true` + `provider.data_collection = deny`, so
//   OpenRouter ITSELF routes within the account ZDR allow-list when the
//   preferred provider returns HTTP 429 (UTSUSHI-231 / UTSUSHI-231 live
//   run: OR served DigitalOcean on a primary-provider miss and the run
//   completed). The served (model, providerId) pair is recorded
//   verbatim in each invocation's provider-run record
//   (`provider.upstreamProvider` / `provider.actualModelId`).
//
//   The superseded ITOTORI-238/239/240 approach (an EXPLICIT
//   `alternateProviders[]` chain advanced by a `failoverPredicate` on a
//   primary 429) was REMOVED — it was redundant with OR-side fallback
//   and could double-handle a 429 OR had already resolved. The
//   no-legacy rule means there is no dual failover: if EVERY ZDR-allow-
//   list provider is at quota, OpenRouter returns the terminal error and
//   the agentic loop surfaces it as a `ModelProviderError` (the natural
//   terminal). No app-level retry layered on top.
//
// Outputs three files:
//   1. <output>                       — the AgenticLoopBundle.v0 JSON
//   2. <translated-bundle-output>     — a translated v0.2 BridgeBundle
//                                       where every unit's
//                                       `target.text` is set to
//                                       `「{sentinel} {draftText}」` so
//                                       (a) the sentinel always
//                                       reaches the patched Seen.txt,
//                                       and (b) the leading SJIS
//                                       bracket lets the KAIFUU-191
//                                       lexer classify the bytes as a
//                                       Textout run.
//   3. <patch-report-output>          — a deterministic
//                                       `patch-report.json` shape
//                                       summarising which pair drove
//                                       the run (the single (modelId,
//                                       providerId) primary pair from
//                                       the pair-policy that the request
//                                       preferred; the actual served
//                                       upstream provider, which OR may
//                                       have fallen back to, lives in
//                                       the per-invocation provider-run
//                                       records), the bridge unit
//                                       count, and the sentinel
//                                       substring. The Rust patchback
//                                       crate does not emit a
//                                       per-file report today, so the
//                                       driver synthesises one here
//                                       to satisfy the UTSUSHI-228
//                                       artifact contract.
//
// The pair-policy file is REQUIRED. Missing OPENROUTER_API_KEY is a
// hard failure (no fallback to RecordedModelProvider — that violates
// the no-optionality rule called out in the audit-focus row).
//
// The command refuses if `ITOTORI_LIVE_PROVIDER` is set to a falsy
// value but `OPENROUTER_LIVE` is set, mirroring the smoke command's
// refusal pattern in reverse: the smoke command refuses live; this
// command refuses anything that isn't live.

import type { AuthorizationActor } from "@itotori/db";
import {
  assertAgenticLoopBundle,
  parsePairPolicyV03,
  PairPolicyVersionMismatchError,
  PairPolicyV03ValidationError,
  flattenPairPolicyV03Postures,
  type AgenticLoopBundle,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type PairPolicyV03,
  type StagePostureV03,
} from "@itotori/localization-bridge-schema";
import { DEFAULT_COST_CAP_USD, OpenRouterModelProvider } from "../providers/openrouter.js";
import { LocalProviderRunArtifactRecorder } from "../providers/artifacts.js";
import { FakeModelProvider } from "../providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
  ProviderRunArtifactRecorder,
} from "../providers/types.js";
import {
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "./agentic-loop.js";

export type LocalizeProjectStageIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type LocalizeProjectStageArgs = {
  bridgePath: string;
  pairPolicyPath: string;
  /** Where to write the AgenticLoopBundle.v0 JSON. */
  outputPath: string;
  /** Where to write the synthesised translated v0.2 BridgeBundle JSON. */
  translatedBundleOutputPath: string;
  /** Where to write the deterministic patch-report.json. */
  patchReportOutputPath: string;
  /**
   * Unit index inside the bridge bundle to translate. Alpha closer
   * runs against scene-1, unit 0 (the first dialogue unit) by default.
   */
  unitIndex?: number;
  io: LocalizeProjectStageIo;
  actor: AuthorizationActor;
  log?: (message: string) => void;
  /**
   * Test-only escape hatch: when set to "fake", the command builds a
   * deterministic FakeModelProvider whose translation output ALWAYS
   * contains the sentinel substring. Refused at runtime unless the
   * caller also sets `ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1` — keeps
   * a stray flag from silently downgrading the recipe to fake. The
   * production driver never sets this.
   */
  providerKind?: "live" | "fake";
  /**
   * Maximum repair attempts the loop is allowed. Defaults to 1.
   */
  maxRepairAttempts?: number;
  /**
   * Per-process USD cap for the OpenRouter provider. Defaults to
   * $0.50 — well above one scene-1 unit's translation cost (~$0.003
   * at the DEV_PAIR rates) but tight enough to refuse a runaway loop.
   */
  costCapUsd?: number;
  /**
   * Optional directory where live OpenRouter provider-run artifacts are
   * persisted as one `provider-run.json` per invocation. The suite
   * driver sets this to its run directory so acceptance can audit the
   * request routing/ZDR/cost posture after the run.
   */
  providerRunArtifactDirectory?: string;
  /**
   * ITOTORI-238 — test-only seam. When provided, the test factory
   * REPLACES `liveOpenRouterFactory` so a test can inject a primary
   * provider that throws a typed `provider_http_error` (status 429)
   * and per-alternate factories that succeed. The production driver
   * never passes this; the failover code path runs against real
   * OpenRouter providers.
   */
  liveFactoryOverride?: (
    pair: PairPolicyV03["pair"],
    options: { artifactRecorder: ProviderRunArtifactRecorder | undefined },
  ) => AgenticLoopProviderFactory;
};

export class LocalizeProjectMissingApiKeyError extends Error {
  constructor(envVarName: string) {
    super(
      `localize-project-stage refused: env var ${envVarName} must be set (the no-fallback rule forbids downgrading to the recorded provider when the live path is requested)`,
    );
    this.name = "LocalizeProjectMissingApiKeyError";
  }
}

export class LocalizeProjectPairPolicyError extends Error {
  constructor(detail: string) {
    super(`localize-project-stage refused: pair-policy ${detail}`);
    this.name = "LocalizeProjectPairPolicyError";
  }
}

export class LocalizeProjectRefusedFakeError extends Error {
  constructor() {
    super(
      "localize-project-stage refused: --provider-kind fake requires ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1 to be set; the production recipe must run live",
    );
    this.name = "LocalizeProjectRefusedFakeError";
  }
}

export class LocalizeProjectMissingProviderRunArtifactsDirectoryError extends Error {
  constructor() {
    super(
      "localize-project-stage refused: live OpenRouter provider construction requires --provider-run-artifacts-dir so provider-run artifacts are persisted under the run artifact directory",
    );
    this.name = "LocalizeProjectMissingProviderRunArtifactsDirectoryError";
  }
}

const DEFAULT_UNIT_INDEX = 0;

// Re-export so the test surface and any external integrators get the
// version-mismatch error from the same place they used to import the
// command-level error.
export { PairPolicyVersionMismatchError };

/**
 * ITOTORI-234 — Parse + validate a raw JSON value as a v0.3 pair-policy
 * tailored for the localize-project alpha closer.
 *
 * Required shape (matches `PairPolicyV03` in
 * `@itotori/localization-bridge-schema/pair-policy.v0.3`):
 *
 * ```json
 * {
 *   "schemaVersion": "itotori.pair-policy.v0.3",
 *   "policyId": "localize-project-alpha-1",
 *   "pair": { "modelId": "...", "providerId": "..." },
 *   "enUsSentinel": "STELLA-ALPHA-EN-US-SENTINEL",
 *   "sceneId": 1,
 *   "openrouterPresetSlug": "optional",
 *   "stages": { ...per-stage StagePostureV03 leaves... }
 * }
 * ```
 *
 * There is no app-level alternate/failover plumbing: OpenRouter-side
 * fallback (provider.order + allow_fallbacks within the ZDR allow-list)
 * is the resilience mechanism, so the policy declares the SINGLE primary
 * pair only.
 *
 * Every leaf's `pair` MUST byte-equal the top-level `pair` field
 * (single-game alpha invariant — only one pair drives this recipe;
 * the per-stage breakout is preserved so the orchestrator's required
 * PairPolicy shape lines up without us having to fork either side).
 *
 * If `openrouterPresetSlug` is set, the OpenRouter-side preset
 * (configured at the OR dashboard) handles routing AT REQUEST TIME.
 * Per docs/openrouter-integration.md §3, explicit per-stage fields
 * (zdr / fallbackModels / seed) OVERRIDE the preset's equivalents.
 *
 * Throws `PairPolicyVersionMismatchError` for v0.1 / v0.2 / absent-
 * schemaVersion inputs (the schema bump is the forcing function;
 * there is no v0.2 parsing path). Throws
 * `LocalizeProjectPairPolicyError` for anything else (missing
 * field, byte-equal pair mismatch).
 */
export function parseLocalizeProjectPairPolicy(value: unknown): {
  policyId: string;
  pair: { modelId: string; providerId: string };
  enUsSentinel: string;
  sceneId: number;
  openrouterPresetSlug?: string;
  pairPolicy: PairPolicy;
  /**
   * Raw parsed v0.3 policy. Surfaced so the dry-run printer + driver
   * can iterate every leaf's posture (zdr + seed) verbatim.
   */
  policyV03: PairPolicyV03;
} {
  let parsed: PairPolicyV03;
  try {
    parsed = parsePairPolicyV03(value, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: process.env.OPENROUTER_ZDR_DOWNGRADE,
    });
  } catch (error) {
    if (error instanceof PairPolicyVersionMismatchError) {
      // Bubble the version-mismatch verbatim so callers can branch on it
      // (the acceptance-criterion #2 test asserts on the typed class).
      throw error;
    }
    if (error instanceof PairPolicyV03ValidationError) {
      throw new LocalizeProjectPairPolicyError(error.message);
    }
    throw error;
  }
  assertEveryLeafMatches(parsed);
  const out: {
    policyId: string;
    pair: { modelId: string; providerId: string };
    enUsSentinel: string;
    sceneId: number;
    openrouterPresetSlug?: string;
    pairPolicy: PairPolicy;
    policyV03: PairPolicyV03;
  } = {
    policyId: parsed.policyId,
    pair: { modelId: parsed.pair.modelId, providerId: parsed.pair.providerId },
    enUsSentinel: parsed.enUsSentinel,
    sceneId: parsed.sceneId,
    pairPolicy: parsed.stages,
    policyV03: parsed,
  };
  if (parsed.openrouterPresetSlug !== undefined) {
    out.openrouterPresetSlug = parsed.openrouterPresetSlug;
  }
  return out;
}

function assertEveryLeafMatches(policy: PairPolicyV03): void {
  const expected = policy.pair;
  for (const { leafPath, posture } of flattenPairPolicyV03Postures(policy)) {
    if (
      posture.pair.modelId !== expected.modelId ||
      posture.pair.providerId !== expected.providerId
    ) {
      throw new LocalizeProjectPairPolicyError(
        `stages.${leafPath}.pair (modelId=${posture.pair.modelId}, providerId=${posture.pair.providerId}) does not byte-equal the top-level pair (modelId=${expected.modelId}, providerId=${expected.providerId}); the single-game alpha invariant forbids mixed pairs in this policy`,
      );
    }
  }
}

export async function runLocalizeProjectStageCommand(
  args: LocalizeProjectStageArgs,
): Promise<AgenticLoopBundle> {
  const log = args.log ?? (() => {});

  const rawBridge = args.io.readJson(args.bridgePath);
  const bridge = assertBridgeBundleV02Shape(rawBridge);
  if (bridge.units.length === 0) {
    throw new Error("localize-project-stage refused: bridge has zero units");
  }
  const unitIndex = args.unitIndex ?? DEFAULT_UNIT_INDEX;
  if (unitIndex < 0 || unitIndex >= bridge.units.length) {
    throw new Error(
      `localize-project-stage refused: --unit-index ${unitIndex} out of range; bridge has ${bridge.units.length} unit(s)`,
    );
  }
  const unit = bridge.units[unitIndex];
  if (unit === undefined) {
    throw new Error("localize-project-stage refused: bridge unit lookup returned undefined");
  }

  const rawPolicy = args.io.readJson(args.pairPolicyPath);
  const { policyId, pair, enUsSentinel, sceneId, pairPolicy } =
    parseLocalizeProjectPairPolicy(rawPolicy);
  log(
    `localize-project-stage: pair=(${pair.modelId}, ${pair.providerId}) sentinel=${enUsSentinel} (OpenRouter-side fallback handles 429s within the ZDR allow-list)`,
  );

  const providerKind = args.providerKind ?? "live";
  if (providerKind === "fake" && process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER !== "1") {
    throw new LocalizeProjectRefusedFakeError();
  }
  if (
    providerKind === "live" &&
    args.providerRunArtifactDirectory === undefined &&
    args.liveFactoryOverride === undefined
  ) {
    throw new LocalizeProjectMissingProviderRunArtifactsDirectoryError();
  }
  const artifactRecorder =
    providerKind === "live" && args.providerRunArtifactDirectory !== undefined
      ? new LocalProviderRunArtifactRecorder(args.providerRunArtifactDirectory)
      : undefined;

  const policy: AgenticLoopPolicy = {
    projectId: bridge.bridgeId,
    localeBranchId: `branch:${unit.sourceRevision.revisionId}`,
    sourceLocale: bridge.sourceLocale,
    targetLocale: "en-US",
    maxRepairAttempts: args.maxRepairAttempts ?? 1,
    now: deterministicNow(),
  };

  const input: AgenticLoopUnitInput = {
    unit,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: args.actor,
  };

  // Single primary-pair run. OpenRouter-side fallback is the resilience
  // mechanism: on the wire the provider sends `provider.order =
  // [providerId]` + `allow_fallbacks = true` + `zdr = true`, so OR routes
  // within the account ZDR allow-list when the preferred upstream returns
  // HTTP 429 and records whichever provider actually served (UTSUSHI-231
  // live run completed when OR served DigitalOcean on a Fireworks miss).
  // There is NO app-level alternate-chaining loop: if EVERY ZDR-allow-list
  // provider is at quota, OR returns the terminal error and
  // `runAgenticLoopForUnit` surfaces it verbatim as a `ModelProviderError`.
  const factory: AgenticLoopProviderFactory =
    providerKind === "fake"
      ? sentinelFakeFactory(unit, policy, enUsSentinel)
      : args.liveFactoryOverride !== undefined
        ? withStagePostureInjectionFactory(
            args.liveFactoryOverride(pair, { artifactRecorder }),
            enUsSentinel,
          )
        : liveOpenRouterFactory({
            enUsSentinel,
            costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
            artifactRecorder,
          });

  const bundle = await runAgenticLoopForUnit(input, pairPolicy, policy, factory);
  assertAgenticLoopBundle(bundle);

  args.io.writeJson(args.outputPath, bundle);
  log(`localize-project-stage: wrote ${args.outputPath}`);

  // Synthesise the translated bridge bundle: clone the source JSON,
  // overwrite each unit's `target` block with the sentinel-wrapped
  // draft text. We wrap with the SJIS bracket pair so the KAIFUU-191
  // lexer captures the run as a Textout opcode rather than silently
  // dropping the ASCII bytes as `Unknown`.
  const draftText = bundle.finalDraft.draftText ?? `[en-US] ${unit.sourceText}`;
  const translatedBridge = synthesiseTranslatedBridge(rawBridge, draftText, enUsSentinel);
  args.io.writeJson(args.translatedBundleOutputPath, translatedBridge);
  log(`localize-project-stage: wrote ${args.translatedBundleOutputPath}`);

  // Synthesise the patch-report.json. The kaifuu-reallive bundle-
  // driven patchback writes the patched Seen.txt in place but does
  // NOT emit a per-run report; the driver shoulders that artifact so
  // the UTSUSHI-228 artifact contract is satisfied.
  //
  // The `pair` field carries the SINGLE primary pair the request
  // preferred (`provider.order[0]`). The actual served upstream
  // provider — which OpenRouter may have fallen back to within the ZDR
  // allow-list on a 429 — is recorded per-invocation in the provider-run
  // records (`provider.upstreamProvider` / `provider.actualModelId`), not
  // re-summarised here.
  const patchReport = {
    schemaVersion: "itotori.localize-project.patch-report.v0",
    policyId,
    pair,
    enUsSentinel,
    sceneId,
    bridgeUnitId: unit.bridgeUnitId,
    unitCount: bridge.units.length,
    finalDraftTextLength: draftText.length,
    translatedTargetText: wrapWithSentinel(draftText, enUsSentinel),
  };
  args.io.writeJson(args.patchReportOutputPath, patchReport);
  log(`localize-project-stage: wrote ${args.patchReportOutputPath}`);

  return bundle;
}

function liveOpenRouterFactory(opts: {
  enUsSentinel: string;
  costCapUsd: number;
  artifactRecorder: ProviderRunArtifactRecorder | undefined;
}): AgenticLoopProviderFactory {
  // Constructed once so the per-process cost cap + token bucket are
  // shared across every stage's invocation. Throws
  // OpenRouterMissingApiKeyError immediately if the API key is
  // missing — surfaces the no-fallback failure mode at the driver
  // boundary rather than at first invoke.
  let provider: OpenRouterModelProvider | undefined;
  return ({ stage, agentLabel, pair }) => {
    if (provider === undefined) {
      if (opts.artifactRecorder === undefined) {
        throw new LocalizeProjectMissingProviderRunArtifactsDirectoryError();
      }
      provider = new OpenRouterModelProvider({
        costCapUsd: opts.costCapUsd,
        artifactRecorder: opts.artifactRecorder,
      });
    }
    return new SentinelInjectingProviderWrapper({
      inner: provider,
      stage,
      agentLabel,
      // ITOTORI-234 — the factory now receives a full StagePostureV03
      // (pair + zdr + fallbackModels + seed + maxPriceUsd). The wrapper
      // preserves the full posture so maxPriceUsd reaches the
      // OpenRouter request as provider.max_price and remains locally
      // enforceable after the provider reports usage.cost.
      pair,
      sentinel: opts.enUsSentinel,
    });
  };
}

function withStagePostureInjectionFactory(
  factory: AgenticLoopProviderFactory,
  enUsSentinel: string,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel, pair }) =>
    new SentinelInjectingProviderWrapper({
      inner: factory({ stage, agentLabel, pair }),
      stage,
      agentLabel,
      pair,
      sentinel: enUsSentinel,
    });
}

/**
 * Provider wrapper that augments every translation request with an
 * instruction to embed the sentinel substring in the translated
 * draft. Other stage requests pass through unmodified. The wrapper
 * never modifies the provider response — the synthesis step
 * (`wrapWithSentinel` below) is what ultimately guarantees the
 * sentinel reaches the patched bytes, but the prompt augmentation
 * gives the LLM a chance to ALSO produce it (so the translated
 * draftText that lands in the agentic-loop-bundle carries the
 * sentinel in the model's own words, not just in our wrapper).
 */
class SentinelInjectingProviderWrapper implements ModelProvider {
  readonly descriptor: ModelProvider["descriptor"];
  constructor(
    private readonly opts: {
      inner: ModelProvider;
      stage: string;
      agentLabel: string;
      pair: StagePostureV03;
      sentinel: string;
    },
  ) {
    // ITOTORI-237 — surface the per-pair capability sheet to agents
    // reading `provider.descriptor.capabilities` directly (e.g. the
    // speaker-label pre-flight check). The wrapper knows the
    // (modelId, providerId) at construction, so the descriptor is
    // pair-specific from the moment the agent receives it. Unknown
    // pairs fall back to the safe defaults inside `descriptorForPair`.
    this.descriptor = descriptorForStagePair(opts.inner, opts.pair.pair);
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const isTranslation = request.taskKind === "draft_translation";
    const messages = isTranslation
      ? request.messages.map((message, index) => {
          if (index === 0 && message.role === "system" && typeof message.content === "string") {
            return {
              ...message,
              content: `${message.content}\n\nIMPORTANT (localize-project-stage): your translated draft MUST include the literal ASCII substring "${this.opts.sentinel}" exactly once. The downstream replay-validate step asserts on it.`,
            };
          }
          return message;
        })
      : request.messages;
    return this.opts.inner.invoke({
      ...request,
      messages,
      maxPriceUsd: this.opts.pair.maxPriceUsd,
    });
  }
}

function descriptorForStagePair(
  provider: ModelProvider,
  pair: { modelId: string; providerId: string },
): ModelProvider["descriptor"] {
  const candidate = provider as ModelProvider & {
    descriptorForPair?: (pair: {
      modelId: string;
      providerId: string;
    }) => ModelProvider["descriptor"];
  };
  if (typeof candidate.descriptorForPair === "function") {
    return candidate.descriptorForPair(pair);
  }
  return provider.descriptor;
}

/**
 * Deterministic fake provider used by the unit-test path (refused at
 * runtime unless `ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1`). Emits
 * structurally-correct stage payloads where the translation stage's
 * draft text always contains the sentinel substring.
 */
function sentinelFakeFactory(
  unit: LocalizationUnitV02,
  policy: AgenticLoopPolicy,
  sentinel: string,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `localize-project-fake:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return JSON.stringify({
            schemaVersion: "itotori.speaker-label-output.v1",
            labels: [
              {
                bridgeUnitId: unit.bridgeUnitId,
                speakerId: { kind: "narration" },
                confidence: "high",
                evidenceRefs: [],
                agentRationale: "localize-project-fake narration",
              },
            ],
          });
        }
        if (request.taskKind === "experiment") {
          return `localize-project-fake:context:${agentLabel}`;
        }
        if (request.taskKind === "draft_translation") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-translation-draft-output.v1",
            drafts: [
              {
                bridgeUnitId: unit.bridgeUnitId,
                sourceLocale: unit.sourceLocale,
                targetLocale: policy.targetLocale,
                // The sentinel is embedded verbatim so the unit test
                // can assert it lands in the final-draft draftText.
                draftText: `${sentinel} ${unit.sourceText}`,
                protectedSpanRefs: [],
                citationRefs: [],
                agentRationale: "localize-project-fake translation",
                confidenceFloor: "medium",
              },
            ],
          });
        }
        if (request.taskKind === "llm_qa") {
          return JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
        }
        return "";
      },
    });
}

/**
 * Build the v0.2 translated BridgeBundle JSON: clone the source
 * bridge, overwrite each unit's `target` block. We wrap the draft
 * with the SJIS bracket pair (`「…」`) because the KAIFUU-191 lexer
 * classifies ASCII-leading bytes as `Unknown` — without the bracket
 * the patched bytes would not surface as a Textout opcode at replay.
 */
function synthesiseTranslatedBridge(
  rawBridge: unknown,
  draftText: string,
  enUsSentinel: string,
): unknown {
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("localize-project-stage refused: bridge JSON must be an object");
  }
  // Deep-clone via JSON round-trip — the bridge bundle is plain JSON.
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("localize-project-stage refused: bridge.units must be an array");
  }
  const wrappedText = wrapWithSentinel(draftText, enUsSentinel);
  for (const unit of units) {
    if (typeof unit !== "object" || unit === null) {
      throw new Error("localize-project-stage refused: bridge unit must be an object");
    }
    (unit as Record<string, unknown>).target = {
      locale: "en-US",
      text: wrappedText,
    };
  }
  return clone;
}

function wrapWithSentinel(draftText: string, sentinel: string): string {
  // Always include the sentinel verbatim; if the LLM already produced
  // it (which the prompt requests), append it once more is fine — the
  // validator asserts substring presence, not uniqueness.
  return `「${sentinel} ${draftText}」`;
}

function assertBridgeBundleV02Shape(value: unknown): BridgeBundleV02 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("localize-project-stage refused: bridge file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "0.2.0") {
    throw new Error(
      `localize-project-stage refused: bridge schemaVersion must be '0.2.0' (got ${String(record.schemaVersion)})`,
    );
  }
  return value as BridgeBundleV02;
}

function deterministicNow(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}
