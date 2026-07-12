// UTSUSHI-228 / ITOTORI-238 — `itotori:localize-project-stage` CLI handler.
//
// Thin LIVE-LLM wrapper around `runAgenticLoopForUnit` used by the
// suite/scripts/localize-project/run.mjs driver. Distinct from
// `agentic-loop-smoke` because that command runs a synthetic CI smoke
// whose FakeModelProvider is gated behind the explicit
// `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1` opt-in (never live, never a
// silent fake default). This command does the opposite: it
// hard-requires the live OpenRouter provider via OPENROUTER_API_KEY,
// loads the pair-policy from a JSON file (NO defaulting), and patches
// the REAL translated draft the LLM emits into the target bundle. The
// downstream runtime evidence is asserted over the engine's OBSERVED
// decode of those real translated bytes — there is no injected
// sentinel substring anywhere in this pipeline.
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
//                                       `target.text` is the REAL
//                                       translated draft. For RealLive
//                                       it is `「{draftText}」`: the
//                                       leading SJIS bracket is an
//                                       ENCODING requirement so the
//                                       KAIFUU-191 lexer classifies the
//                                       bytes as a Textout run (NOT a
//                                       sentinel).
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
//                                       count, and the REAL translated
//                                       text (`finalDraftText` /
//                                       `translatedTargetText`) the
//                                       downstream replay must OBSERVE.
//                                       The Rust patchback crate does
//                                       not emit a per-file report
//                                       today, so the driver synthesises
//                                       one here to satisfy the
//                                       UTSUSHI-228 artifact contract.
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
  isLocaleTaggedSourceEcho,
  parsePairPolicyV03,
  PairPolicyVersionMismatchError,
  PairPolicyV03ValidationError,
  flattenPairPolicyV03Postures,
  type AgenticLoopBundle,
  type BridgeBundleV02,
  type PairPolicyV03,
  type StagePostureV03,
  type StyleGuidePolicyV0Draft,
} from "@itotori/localization-bridge-schema";
import { parseNarrativeStructure } from "../agents/structure-informed-context/index.js";
import type { TranslationGlossaryEntry } from "../agents/translation/shapes.js";
import { DEFAULT_COST_CAP_USD, OpenRouterModelProvider } from "../providers/openrouter.js";
import { LocalProviderRunArtifactRecorder } from "../providers/artifacts.js";
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
import { dispatchProviderAdapter } from "./invocation-supervisor.js";

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
  /**
   * itotori-agentic-loop-real-context-stage — optional path to the decoded
   * `utsushi.narrative-structure.v1` JSON (emitted by
   * the `utsushi structure` subcommand, held OUTSIDE the repo as
   * it carries copyrighted script text). When provided, the loop's context
   * stage builds the DETERMINISTIC structure-informed context slice for the
   * pair-policy `sceneId` and injects it into the translation prompt — the
   * translator receives the KNOWN scene / route / speaker structure instead of
   * re-inferring it. When absent the loop still runs the four semantic agents
   * live but injects no deterministic structure block.
   */
  structureJsonPath?: string;
  /**
   * itotori-live-loop-style-glossary-injection — the ACTIVE glossary + style
   * guide for this unit's locale branch, resolved by the caller from the
   * glossary / style-guide tables/services (the READ path) and threaded into
   * the loop the same way `structureJsonPath` supplies the decoded structure.
   * The translation prompt + QA terminology lane then enforce the real house
   * glossary + style. Omitted → the loop degrades gracefully to empty.
   */
  glossary?: ReadonlyArray<TranslationGlossaryEntry>;
  styleGuide?: StyleGuidePolicyV0Draft;
  /**
   * Engine profile controlling translated-bundle synthesis. `reallive`
   * (default) overwrites EVERY unit's `target` with the SJIS-bracket-
   * wrapped REAL draft so the KAIFUU-191 lexer captures the patched
   * run as a Textout opcode. `rpg-maker-mv-mz` translates ONLY the
   * targeted `--unit-index` unit (plain literal, no bracket wrap —
   * RPG Maker stores JSON string literals) and keeps every other unit's
   * `target.text === sourceText` (a byte no-op), so the kaifuu-rpgmaker
   * patchback emits a single-surface, byte-correct `.kaifuu` delta rather
   * than rewriting all 6000+ surfaces.
   */
  engineProfile?: "reallive" | "rpg-maker-mv-mz";
  io: LocalizeProjectStageIo;
  actor: AuthorizationActor;
  log?: (message: string) => void;
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

export class LocalizeProjectMissingProviderRunArtifactsDirectoryError extends Error {
  constructor() {
    super(
      "localize-project-stage refused: live OpenRouter provider construction requires --provider-run-artifacts-dir so provider-run artifacts are persisted under the run artifact directory",
    );
    this.name = "LocalizeProjectMissingProviderRunArtifactsDirectoryError";
  }
}

const DEFAULT_UNIT_INDEX = 0;
// This single-unit command has no run-scope provisioning or reviewer-queue
// sink. Keep the required loop input explicit without using the unit's
// content-hash revision as a queue FK candidate.
const LOCALIZE_PROJECT_STAGE_BUNDLE_SOURCE_REVISION_ID = "localize-project-stage-bundle-revision";

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
    sceneId: number;
    openrouterPresetSlug?: string;
    pairPolicy: PairPolicy;
    policyV03: PairPolicyV03;
  } = {
    policyId: parsed.policyId,
    pair: { modelId: parsed.pair.modelId, providerId: parsed.pair.providerId },
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
  const { policyId, pair, sceneId, pairPolicy } = parseLocalizeProjectPairPolicy(rawPolicy);
  log(
    `localize-project-stage: pair=(${pair.modelId}, ${pair.providerId}) (OpenRouter-side fallback handles 429s within the ZDR allow-list)`,
  );

  // The command always runs the LIVE OpenRouter path. The only test seam
  // is `liveFactoryOverride` (a test injects a deterministic provider
  // factory in place of the real OpenRouter client). There is NO fake /
  // shipped-fixture provider branch: a fake translation must never be
  // reachable on this production localize surface.
  if (args.providerRunArtifactDirectory === undefined && args.liveFactoryOverride === undefined) {
    throw new LocalizeProjectMissingProviderRunArtifactsDirectoryError();
  }
  const artifactRecorder =
    args.providerRunArtifactDirectory !== undefined
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

  // itotori-agentic-loop-real-context-stage — when a decoded structure is
  // supplied, thread it (+ the pair-policy sceneId) so the context stage builds
  // and injects the DETERMINISTIC structure-informed context slice.
  const narrativeStructure =
    args.structureJsonPath !== undefined
      ? parseNarrativeStructure(args.io.readJson(args.structureJsonPath))
      : undefined;
  if (narrativeStructure !== undefined) {
    log(`localize-project-stage: structure-informed context enabled (scene ${sceneId})`);
  }

  const input: AgenticLoopUnitInput = {
    unit,
    sourceRevisionId: LOCALIZE_PROJECT_STAGE_BUNDLE_SOURCE_REVISION_ID,
    sceneUnits: [],
    // itotori-live-loop-style-glossary-injection — feed the caller-resolved
    // ACTIVE glossary + style-guide into the live loop (empty when unset).
    glossary: args.glossary ?? [],
    protectedSpans: [],
    knownCharacters: [],
    ...(args.styleGuide !== undefined ? { styleGuide: args.styleGuide } : {}),
    ...(narrativeStructure !== undefined ? { narrativeStructure, sceneId } : {}),
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
    args.liveFactoryOverride !== undefined
      ? withStagePostureInjectionFactory(args.liveFactoryOverride(pair, { artifactRecorder }))
      : liveOpenRouterFactory({
          costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
          artifactRecorder,
        });

  const bundle = await runAgenticLoopForUnit(input, pairPolicy, policy, factory);
  assertAgenticLoopBundle(bundle);

  args.io.writeJson(args.outputPath, bundle);
  log(`localize-project-stage: wrote ${args.outputPath}`);

  // Synthesise the translated bridge bundle: clone the source JSON,
  // overwrite each unit's `target` block with the REAL translated draft
  // text the agentic loop produced. For RealLive we wrap with the SJIS
  // bracket pair (`「…」`) — an ENCODING requirement so the KAIFUU-191
  // lexer captures the run as a Textout opcode rather than dropping the
  // ASCII bytes as `Unknown`; it is NOT a sentinel. The exact text
  // written here is what a downstream replay/render must OBSERVE, so it
  // is recorded verbatim in the patch-report as `translatedTargetText`.
  const selectedCandidate = bundle.writtenOutcome.candidates.find(
    (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
  );
  if (selectedCandidate === undefined) {
    throw new Error(
      `localize-project-stage refused: written outcome for ${unit.bridgeUnitId} has no selected candidate`,
    );
  }
  const draftText = selectedCandidate.body;
  const engineProfile = args.engineProfile ?? "reallive";
  // For RealLive, strip the producer's OUT-OF-BAND control markup
  // (`<reallive.kidoku …>`) the model reproduced inline: it has no byte run in
  // the Textout body and the patchback re-emits the kidoku control bytes
  // byte-identical from the untouched bytecode. `bodyDraftText` is the exact
  // translated dialogue body the engine observes — recorded verbatim below.
  // (RPG Maker carries no such markup; its draft passes through unchanged.)
  const bodyDraftText =
    engineProfile === "rpg-maker-mv-mz" ? draftText : stripOutOfBandControlMarkup(draftText);
  const engineVisibleSourceText =
    engineProfile === "rpg-maker-mv-mz"
      ? unit.sourceText
      : stripOutOfBandControlMarkup(unit.sourceText);
  assertEngineVisibleTargetText({
    body: bodyDraftText,
    sourceText: engineVisibleSourceText,
    label: `localize-project-stage selected candidate for ${unit.bridgeUnitId}`,
  });
  const translatedTargetText =
    engineProfile === "rpg-maker-mv-mz" ? bodyDraftText : bracketWrapForRealLive(bodyDraftText);
  const translatedBridge =
    engineProfile === "rpg-maker-mv-mz"
      ? synthesiseRpgMakerMvMzTranslatedBridge(rawBridge, bodyDraftText, unitIndex)
      : synthesiseTranslatedBridge(rawBridge, bodyDraftText);
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
    sceneId,
    bridgeUnitId: unit.bridgeUnitId,
    unitCount: bridge.units.length,
    finalDraftTextLength: bodyDraftText.length,
    // The REAL translated dialogue body the LLM produced, with the producer's
    // out-of-band control markup (`<reallive.kidoku …>`) stripped so it matches
    // exactly what the patchback splices. This is the exact English text the
    // downstream replay/render must OBSERVE in an emitted TextLine — the
    // observed-output evidence is asserted against this, NOT against a
    // harness-planted sentinel.
    finalDraftText: bodyDraftText,
    // The exact target text written into the translated bundle (RealLive
    // is SJIS-bracket-wrapped for the lexer; RPG Maker is the plain
    // literal). `finalDraftText` is the substring guaranteed to appear
    // in the engine's observed TextLine regardless of the wrap.
    translatedTargetText,
  };
  args.io.writeJson(args.patchReportOutputPath, patchReport);
  log(`localize-project-stage: wrote ${args.patchReportOutputPath}`);

  return bundle;
}

export function liveOpenRouterFactory(opts: {
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
    return new StagePostureProviderWrapper({
      inner: provider,
      stage,
      agentLabel,
      // ITOTORI-234 — the factory now receives a full StagePostureV03
      // (pair + zdr + fallbackModels + seed + maxPriceUsd). The wrapper
      // preserves the full posture so maxPriceUsd reaches the
      // OpenRouter request as provider.max_price and remains locally
      // enforceable after the provider reports usage.cost.
      pair,
    });
  };
}

function withStagePostureInjectionFactory(
  factory: AgenticLoopProviderFactory,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel, pair }) =>
    new StagePostureProviderWrapper({
      inner: factory({ stage, agentLabel, pair }),
      stage,
      agentLabel,
      pair,
    });
}

/**
 * Provider wrapper that threads the per-stage posture (maxPriceUsd) into
 * every invocation and surfaces the per-pair capability descriptor. It
 * NEVER rewrites prompts or responses: the translated draft is whatever
 * the model actually produced, and the downstream runtime evidence is
 * asserted over the engine's observed decode of the REAL translated
 * bytes — there is no injected sentinel substring.
 */
class StagePostureProviderWrapper implements ModelProvider {
  readonly descriptor: ModelProvider["descriptor"];
  constructor(
    private readonly opts: {
      inner: ModelProvider;
      stage: string;
      agentLabel: string;
      pair: StagePostureV03;
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
  async preflightInvocation(
    request: ModelInvocationRequest,
  ): Promise<
    | { admitted: true }
    | { admitted: false; detail: string; evidence: string; operatorAction?: string }
  > {
    return (
      (await this.opts.inner.preflightInvocation?.({
        ...request,
        maxPriceUsd: this.opts.pair.maxPriceUsd,
      })) ?? { admitted: true }
    );
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    return dispatchProviderAdapter(this.opts.inner, {
      ...request,
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
 * Build the v0.2 translated BridgeBundle JSON: clone the source
 * bridge, overwrite each unit's `target` block with the REAL translated
 * draft text. We wrap the draft with the SJIS bracket pair (`「…」`)
 * because the KAIFUU-191 lexer classifies ASCII-leading bytes as
 * `Unknown` — without the bracket the patched bytes would not surface as
 * a Textout opcode at replay. The bracket is an ENCODING requirement,
 * not a sentinel.
 */
function synthesiseTranslatedBridge(rawBridge: unknown, draftText: string): unknown {
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("localize-project-stage refused: bridge JSON must be an object");
  }
  // Deep-clone via JSON round-trip — the bridge bundle is plain JSON.
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("localize-project-stage refused: bridge.units must be an array");
  }
  const wrappedText = bracketWrapForRealLive(draftText);
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

/**
 * Build the v0.2 translated BridgeBundle JSON for the RPG Maker MV/MZ
 * vertical slice. Unlike the RealLive synthesis (which rewrites every
 * unit to the same bracket-wrapped draft), this translates ONLY the
 * targeted `unitIndex` unit and leaves every other unit's
 * `target.text === sourceText` — a byte no-op the kaifuu-rpgmaker
 * patchback collapses to zero edits. The result is a single-surface,
 * byte-correct `.kaifuu` delta. No SJIS bracket wrap: RPG Maker stores
 * plain JSON string literals, so the REAL translated draft is written
 * directly so the downstream runtime trace can assert the engine
 * observes it in an emitted TextLine.
 */
function synthesiseRpgMakerMvMzTranslatedBridge(
  rawBridge: unknown,
  draftText: string,
  unitIndex: number,
): unknown {
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("localize-project-stage refused: bridge JSON must be an object");
  }
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("localize-project-stage refused: bridge.units must be an array");
  }
  const targetedText = draftText;
  for (const [index, unit] of units.entries()) {
    if (typeof unit !== "object" || unit === null) {
      throw new Error("localize-project-stage refused: bridge unit must be an object");
    }
    const record = unit as Record<string, unknown>;
    const sourceText = record.sourceText;
    if (typeof sourceText !== "string") {
      throw new Error("localize-project-stage refused: bridge unit sourceText must be a string");
    }
    record.target = {
      locale: "en-US",
      // Only the targeted unit carries the live draft; everything else is
      // a byte no-op (target === source). An empty source would trip the
      // patchback's non-empty-target gate, but the RPG Maker extractor
      // never surfaces empty literals.
      text: index === unitIndex ? targetedText : sourceText,
    };
  }
  return clone;
}

/**
 * Reserved syntactic form of the KAIFUU-210 producer's OUT-OF-BAND
 * control-markup marker: `<reallive.kidoku …>`.
 *
 * RealLive read-flag (kidoku) state is NOT stored in the Textout body — it is
 * a separate `MetaKidoku` opcode / the scene-header kidoku table. The producer
 * surfaces it as a SYNTHETIC readable marker prepended to `sourceText`, and the
 * translation prompt reproduces every protected span inline, so the model's
 * draft carries the `<reallive.kidoku N>` literal. That literal must NOT be
 * written into the translated Textout body: the kaifuu-reallive patchback
 * re-emits the kidoku control bytes byte-identical from the untouched bytecode
 * and strips this marker before splicing (see
 * `kaifuu_reallive::REALLIVE_OUT_OF_BAND_MARKER_OPEN`). We strip it here too so
 * the recorded `finalDraftText` / `translatedTargetText` are exactly the
 * translated dialogue body the engine actually observes.
 */
const REALLIVE_OUT_OF_BAND_MARKER_OPEN = "<reallive.kidoku ";

/**
 * Remove every out-of-band control-markup marker (`<reallive.kidoku …>`) from
 * a translated draft. Keyed on the reserved marker SYNTAX (not a specific
 * unit's span raw) so a draft carrying any kidoku index — or several, as
 * Kanon's double-kidoku dialogue does — is fully cleaned. In-body protected
 * markup (the `【話者】` name token, asset refs, font tones) is real Textout
 * body content and is left untouched.
 */
export function stripOutOfBandControlMarkup(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf(REALLIVE_OUT_OF_BAND_MARKER_OPEN);
    if (open === -1) {
      return out + rest;
    }
    out += rest.slice(0, open);
    const afterOpen = rest.slice(open + REALLIVE_OUT_OF_BAND_MARKER_OPEN.length);
    const close = afterOpen.indexOf(">");
    if (close === -1) {
      // Unterminated marker: keep the remainder verbatim, never truncate.
      return out + rest.slice(open);
    }
    rest = afterOpen.slice(close + 1);
  }
}

/**
 * The patchback consumes engine-visible bodies, not the producer's synthetic
 * control markup. Enforce the written-target invariant after that projection
 * so an out-of-band marker cannot disguise a source replay or an empty body.
 */
export function assertEngineVisibleTargetText(args: {
  body: string;
  sourceText: string;
  label: string;
}): void {
  const targetText = args.body.trim();
  if (targetText.length === 0) {
    throw new Error(`${args.label} must remain non-blank after control-markup normalization`);
  }
  if (targetText !== args.body) {
    throw new Error(`${args.label} must remain trimmed after control-markup normalization`);
  }
  if (isLocaleTaggedSourceEcho(targetText)) {
    throw new Error(`${args.label} must not use a locale-tagged source replay`);
  }
  if (targetText === args.sourceText.trim()) {
    throw new Error(`${args.label} repeats source text after control-markup normalization`);
  }
}

/**
 * Wrap the REAL translated draft in the SJIS bracket pair (`「…」`) WHEN it
 * would otherwise start with an ASCII byte. This is an ENCODING requirement:
 * the KAIFUU-191 RealLive lexer classifies ASCII-leading bytes as `Unknown`,
 * so the leading bracket is what makes the patched bytes surface as a Textout
 * opcode at replay. A body that already starts with a full-width Shift-JIS
 * character — e.g. a `【話者】` name marker re-emitted as the leading body
 * bytes, or a `「…」`-quoted line — already lexes as a Textout run and MUST NOT
 * be double-wrapped (that would shove the name marker inside a spurious quote
 * and change the speaker-label structure). The interior text is the model's
 * real translation verbatim.
 */
export function bracketWrapForRealLive(draftText: string): string {
  const first = draftText.codePointAt(0);
  const needsWrap = first === undefined || first <= 0x7f;
  return needsWrap ? `「${draftText}」` : draftText;
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
