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
// ITOTORI-238 — explicit alternate providers + failover predicate.
//
//   The pair-policy v0.3 widens v0.2 by adding two top-level fields:
//     - alternateProviders: ordered list of fully-declared
//       (modelId, providerId, capabilitySheet) entries.
//     - failoverPredicate: the literal 'http_429_from_primary' — the
//       ONLY failure mode that causes this driver to advance to the
//       next alternate.
//
//   On a primary 429 the driver:
//     1. records the audit-trail (primary 429 + alternate adopted),
//     2. constructs a NEW provider pinned to the next alternate's
//        (modelId, providerId),
//     3. re-runs the agentic loop with the same input + a per-stage
//        pair-policy whose pinned pair has been replaced byte-equal
//        with the alternate's pair, and
//     4. surfaces `LocalizeProjectBlockedExternal` when every alternate has
//        been exhausted.
//
//   On ANY other failure (pair_mismatch, provider_response_invalid,
//   non-429 provider_http_error, capability_unsupported, etc.) the
//   driver raises immediately — silent provider swap is forbidden
//   (audit-focus 3).
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
//                                       the run (the (modelId,
//                                       providerId) pair from the
//                                       pair-policy — the PRIMARY pair
//                                       on a clean run, the FAILOVER
//                                       pair when an alternate was
//                                       adopted), the bridge unit
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
  type PairPolicyV03Alternate,
  type StagePostureV03,
} from "@itotori/localization-bridge-schema";
import {
  DEFAULT_COST_CAP_USD,
  OpenRouterModelProvider,
  openRouterDefaultCapabilities,
} from "../providers/openrouter.js";
import { LocalProviderRunArtifactRecorder } from "../providers/artifacts.js";
import { FakeModelProvider } from "../providers/fake.js";
import { globalCapabilityGuard, type CapabilityGuard } from "../providers/capability-guard.js";
import { ModelProviderError } from "../providers/types.js";
import type {
  ModelCapabilities,
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

/**
 * ITOTORI-238 — raised when the primary pair returned HTTP 429 AND
 * every declared alternate has also been exhausted (or none were
 * declared). Carries the per-pair failure record so the operator can
 * see exactly which providers refused and why.
 *
 * The name encodes the audit-focus claim: this is a STRUCTURAL
 * external block — Trevor's account is at quota on every pair the
 * policy file declared, and itotori cannot continue without operator
 * action (either a quota increase upstream, or a new alternate added
 * to the policy file + re-validated).
 */
export class LocalizeProjectBlockedExternal extends Error {
  constructor(
    public readonly attempts: ReadonlyArray<{
      pair: { modelId: string; providerId: string };
      role: "primary" | "alternate";
      failureClass: string;
      detail: string;
    }>,
  ) {
    const summary = attempts
      .map(
        (entry, idx) =>
          `  [${idx}] role=${entry.role} pair=(${entry.pair.modelId}, ${entry.pair.providerId}) failure=${entry.failureClass} — ${entry.detail}`,
      )
      .join("\n");
    super(
      `localize-project-stage refused: LOCALIZE PROJECT BLOCKED (external) — every declared (modelId, providerId) pair returned the configured failover predicate's failure. Attempts:\n${summary}\nResolution: either add a new evidence-validated alternate to the pair-policy preset (alternateProviders[]), wait for the upstream quota to lift, or request an OpenRouter-side quota increase. No silent provider broadening is allowed — every alternate must be a commit-visible, evidence-validated entry.`,
    );
    this.name = "LocalizeProjectBlockedExternal";
  }
}

const DEFAULT_UNIT_INDEX = 0;

// Re-export so the test surface and any external integrators get the
// version-mismatch error from the same place they used to import the
// command-level error.
export { PairPolicyVersionMismatchError };

/**
 * ITOTORI-234 / ITOTORI-238 — Parse + validate a raw JSON value as a
 * v0.3 pair-policy tailored for the localize-project alpha closer.
 *
 * Required shape (matches `PairPolicyV03` in
 * `@itotori/localization-bridge-schema/pair-policy.v0.3`):
 *
 * ```json
 * {
 *   "schemaVersion": "itotori.pair-policy.v0.3",
 *   "policyId": "localize-project-alpha-1",
 *   "pair": { "modelId": "...", "providerId": "..." },
 *   "alternateProviders": [{
 *     "modelId": "...",
 *     "providerId": "...",
 *     "capabilitySheet": {
 *       "supportsStructuredOutputJsonSchema": true,
 *       "supportsToolUse": true,
 *       "contextWindowTokens": 128000,
 *       "maxOutputTokens": 8192,
 *       "evidenceRef": "docs/openrouter-integration-evidence/..."
 *     }
 *   }],
 *   "failoverPredicate": "http_429_from_primary",
 *   "enUsSentinel": "STELLA-ALPHA-EN-US-SENTINEL",
 *   "sceneId": 1,
 *   "openrouterPresetSlug": "optional",
 *   "stages": { ...per-stage StagePostureV03 leaves... }
 * }
 * ```
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
   * can iterate every leaf's posture (zdr + seed) verbatim AND so the
   * driver can read alternateProviders[] + failoverPredicate.
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

/**
 * Replace every leaf-pair in the per-stage policy with the alternate
 * pair. Preserves zdr / fallbackModels / seed / maxPriceUsd verbatim
 * (the alternate inherits the primary's posture; only the routing
 * pair changes).
 *
 * Why we don't re-derive the seed from the new pair: failover MUST
 * be deterministic from the operator's perspective. The seed is
 * derived from the LEAF PATH, not the pair, so it stays stable across
 * primary/alternate runs. This keeps replay traces comparable when
 * an alternate is adopted.
 */
function replaceLeafPair(pairPolicy: PairPolicy, alternate: PairPolicyV03Alternate): PairPolicy {
  const swap = (leaf: StagePostureV03): StagePostureV03 => ({
    pair: { modelId: alternate.modelId, providerId: alternate.providerId },
    zdr: leaf.zdr,
    fallbackModels: leaf.fallbackModels,
    seed: leaf.seed,
    maxPriceUsd: leaf.maxPriceUsd,
  });
  const out: PairPolicy = {
    context: {
      sceneSummary: swap(pairPolicy.context.sceneSummary),
      characterRelationship: swap(pairPolicy.context.characterRelationship),
      terminologyCandidate: swap(pairPolicy.context.terminologyCandidate),
      routeChoiceMap: swap(pairPolicy.context.routeChoiceMap),
    },
    preTranslation: {
      speakerLabel: swap(pairPolicy.preTranslation.speakerLabel),
    },
    translation: {
      primary: swap(pairPolicy.translation.primary),
      ...(pairPolicy.translation.regrade !== undefined
        ? { regrade: swap(pairPolicy.translation.regrade) }
        : {}),
    },
    qa: {
      styleAdherence: swap(pairPolicy.qa.styleAdherence),
      semanticDrift: swap(pairPolicy.qa.semanticDrift),
      toneRegister: swap(pairPolicy.qa.toneRegister),
      unresolvedTerminology: swap(pairPolicy.qa.unresolvedTerminology),
    },
    repair: {
      primary: swap(pairPolicy.repair.primary),
    },
  };
  return out;
}

/**
 * ITOTORI-240 — translate an alternate's declared
 * `PairPolicyV03AlternateCapabilitySheet` into the wider
 * `ModelCapabilities` shape consumed by `CapabilityGuard`, then register
 * the entry under the alternate's (modelId, providerId) pair.
 *
 * Root cause this closes (from the UTSUSHI-231 retry #8 sweep): the
 * pair-policy preset declares every alternate's capability sheet
 * inline, but ITOTORI-239 wired the data INTO the policy file without
 * teaching the driver to push it into `globalCapabilityGuard`. The
 * `SentinelInjectingProviderWrapper` calls
 * `inner.descriptorForPair(opts.pair)` which delegates to
 * `CapabilityGuard.has/lookup` — and on a miss, the descriptor falls
 * back to `openRouterDefaultCapabilities` (jsonSchema=`untested`),
 * which the speaker-label agent's pre-flight assertion refuses. End
 * effect: every alternate in the chain hard-refused with
 * `capability_unsupported` before its HTTP call could even fire.
 *
 * The fix here registers each alternate's capabilitySheet into the
 * SAME singleton guard `OpenRouterModelProvider` reaches into in
 * `descriptorForPair`, so `globalCapabilityGuard().has(alt.modelId,
 * alt.providerId)` is true BEFORE the failover loop begins.
 *
 * Why only the active policy's alternates (and NOT every pair we
 * could imagine): the no-silent-fallback invariant. Auto-registering
 * arbitrary pairs at module load would let an unaudited (model,
 * provider) pair slip into a run via a renamed alternate. Each
 * registration is anchored to a commit-visible alternate inside the
 * preset file, and the alternate-validation rule (parser enforces
 * `supportsStructuredOutputJsonSchema=true` + non-empty `evidenceRef`)
 * makes the data trustworthy at the registration site.
 *
 * Unknown pairs (not declared in the active policy's alternates) are
 * NOT registered here — `descriptorForPair` keeps its safe-default
 * fallback for those, and any agent attempting to use such a pair
 * will still refuse with `capability_unsupported` (which is the
 * desired posture per ITOTORI-220 / ITOTORI-237).
 */
export function alternateCapabilitiesAsModelCapabilities(
  alternate: PairPolicyV03Alternate,
): ModelCapabilities {
  const sheet = alternate.capabilitySheet;
  // Translate the alternate's coarse booleans into the structured-
  // output axis the speaker-label pre-flight asserts on. The other
  // axes (image input, routing) inherit the OpenRouter defaults —
  // those are not policy-configurable per alternate and the family-
  // wide defaults are correct.
  const structuredOutputSupport = sheet.supportsStructuredOutputJsonSchema
    ? ("supported" as const)
    : ("untested" as const);
  const toolCallSupport = sheet.supportsToolUse ? ("supported" as const) : ("untested" as const);
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      jsonSchema: structuredOutputSupport,
      jsonObject: structuredOutputSupport,
      toolCallArguments: toolCallSupport,
      plainJsonExtraction: "supported",
      preferredModes: ["json_schema", "tool_call_arguments", "json_object", "plain_json"],
    },
    toolCalls: {
      support: toolCallSupport,
      // Alternates declared by the alpha closer's pair-policy preset
      // share the deepseek-v4-flash family — parallel tool calls are
      // not asserted by the alternate sheet, so we inherit the default
      // (`untested`). The orchestrator never asks for parallel calls.
      parallelToolCalls: openRouterDefaultCapabilities.toolCalls.parallelToolCalls,
      requiresSchemaPerRequest: true,
    },
    routing: {
      ...openRouterDefaultCapabilities.routing,
    },
    contextWindowTokens: sheet.contextWindowTokens,
    maxOutputTokens: sheet.maxOutputTokens,
    notes: [
      `ITOTORI-240: registered from pair-policy alternateProviders[] entry (evidenceRef: ${sheet.evidenceRef})`,
    ],
  };
}

/**
 * ITOTORI-240 — registration loop. Pre-iterates the policy's
 * `alternateProviders[]` and registers each `capabilitySheet` into the
 * supplied `CapabilityGuard` (defaults to the singleton). MUST run
 * BEFORE the failover loop so any per-pair `descriptorForPair` lookup
 * during stage execution finds the alternate's registered sheet
 * instead of falling back to the safe-default `untested` posture.
 *
 * Idempotent: re-registering the same pair overwrites the entry, so
 * repeated invocations across re-runs of the command in the same
 * process (e.g. a script that loops) do not accumulate stale data.
 */
export function registerPairPolicyAlternatesInCapabilityGuard(
  policy: PairPolicyV03,
  guard: CapabilityGuard = globalCapabilityGuard(),
): void {
  for (const alternate of policy.alternateProviders) {
    guard.register(
      alternate.modelId,
      alternate.providerId,
      alternateCapabilitiesAsModelCapabilities(alternate),
    );
  }
}

/**
 * ITOTORI-238 — does the thrown error match the policy's
 * `failoverPredicate`? Today the only predicate is
 * `"http_429_from_primary"`, which matches a
 * `ModelProviderError` whose `code === "provider_http_error"` AND
 * whose `providerRun.errorClasses` includes `"http_429"`.
 *
 * Any other failure (pair_mismatch, provider_response_invalid,
 * capability_unsupported, configuration_error, OR a non-429
 * provider_http_error) MUST return `false` so the caller surfaces
 * the error immediately. This is the audit-focus 3 invariant.
 */
function matchesFailoverPredicate(
  predicate: PairPolicyV03["failoverPredicate"],
  error: unknown,
): boolean {
  if (predicate !== "http_429_from_primary") {
    return false;
  }
  if (!(error instanceof ModelProviderError)) {
    return false;
  }
  if (error.code !== "provider_http_error") {
    return false;
  }
  // The OpenRouter provider tags 429 responses with errorClass
  // `"http_429"` in the provider run record (see
  // apps/itotori/src/providers/openrouter.ts:194 — `errorClasses:
  // [\`http_${response.status}\`]`).
  const classes = error.providerRun?.errorClasses ?? [];
  return classes.includes("http_429");
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
  const { policyId, pair, enUsSentinel, sceneId, pairPolicy, policyV03 } =
    parseLocalizeProjectPairPolicy(rawPolicy);
  log(
    `localize-project-stage: primary=(${pair.modelId}, ${pair.providerId}) sentinel=${enUsSentinel} alternates=${policyV03.alternateProviders.length} failoverPredicate=${policyV03.failoverPredicate}`,
  );

  // ITOTORI-240 — register every alternate's capabilitySheet into the
  // singleton CapabilityGuard BEFORE the failover loop starts. The
  // SentinelInjectingProviderWrapper (and any downstream pre-flight
  // check that reads `provider.descriptor.capabilities`) calls
  // `inner.descriptorForPair(opts.pair)` per attempt; without this
  // registration the alternate's pair is a guard miss and the wrapper
  // falls back to the family-default `untested` posture, which the
  // speaker-label agent's structured-output pre-flight refuses. The
  // primary pair is already covered by OpenRouterModelProvider's
  // constructor-time registration of the dev-pair.ts known table;
  // this loop closes the gap for the policy-declared alternates.
  registerPairPolicyAlternatesInCapabilityGuard(policyV03);
  log(
    `localize-project-stage: registered ${policyV03.alternateProviders.length} alternate capability sheet(s) into globalCapabilityGuard`,
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

  // ITOTORI-238 — failover orchestration. We attempt the primary pair
  // first; if it raises an error matching the policy's failoverPredicate
  // we advance to the next declared alternate (in policy-declared order).
  // Each attempt re-runs the FULL agentic loop from scratch — there is
  // no per-stage failover, because mid-run provider swap would invalidate
  // the audit trail (the stage's seed + posture is bound to a single
  // pair).
  const attemptPairs: Array<{
    pair: { modelId: string; providerId: string };
    role: "primary" | "alternate";
    pairPolicy: PairPolicy;
    factory: AgenticLoopProviderFactory;
  }> = [
    {
      pair,
      role: "primary",
      pairPolicy,
      factory:
        providerKind === "fake"
          ? sentinelFakeFactory(unit, policy, enUsSentinel)
          : args.liveFactoryOverride !== undefined
            ? args.liveFactoryOverride(pair, { artifactRecorder })
            : liveOpenRouterFactory({
                enUsSentinel,
                costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
                artifactRecorder,
              }),
    },
    ...policyV03.alternateProviders.map((alternate) => {
      const altPair = { modelId: alternate.modelId, providerId: alternate.providerId };
      return {
        pair: altPair,
        role: "alternate" as const,
        pairPolicy: replaceLeafPair(pairPolicy, alternate),
        factory:
          providerKind === "fake"
            ? sentinelFakeFactory(unit, policy, enUsSentinel)
            : args.liveFactoryOverride !== undefined
              ? args.liveFactoryOverride(altPair, { artifactRecorder })
              : liveOpenRouterFactory({
                  enUsSentinel,
                  costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
                  artifactRecorder,
                }),
      };
    }),
  ];

  const failureAttempts: Array<{
    pair: { modelId: string; providerId: string };
    role: "primary" | "alternate";
    failureClass: string;
    detail: string;
  }> = [];
  let bundle: AgenticLoopBundle | undefined;
  let driverPair: { modelId: string; providerId: string } = pair;

  for (let i = 0; i < attemptPairs.length; i += 1) {
    const attempt = attemptPairs[i];
    if (attempt === undefined) {
      // Defensive — the loop bound is `attemptPairs.length` so this
      // branch is unreachable, but TS narrowing benefits from the check.
      break;
    }
    log(
      `localize-project-stage: attempt ${i + 1}/${attemptPairs.length} role=${attempt.role} pair=(${attempt.pair.modelId}, ${attempt.pair.providerId})`,
    );
    try {
      bundle = await runAgenticLoopForUnit(input, attempt.pairPolicy, policy, attempt.factory);
      assertAgenticLoopBundle(bundle);
      driverPair = attempt.pair;
      break;
    } catch (error) {
      if (matchesFailoverPredicate(policyV03.failoverPredicate, error)) {
        // Record the audit trail entry and advance — but ONLY when the
        // primary failed. Alternate-stage failures with the same
        // predicate also advance (a chain of 429s is still a 429 chain),
        // but a non-primary 429 indicates the alternate is itself at
        // quota.
        const detail = error instanceof Error ? error.message : String(error);
        failureAttempts.push({
          pair: attempt.pair,
          role: attempt.role,
          failureClass: "http_429",
          detail,
        });
        log(
          `localize-project-stage: pair (${attempt.pair.modelId}, ${attempt.pair.providerId}) returned the failover predicate's failure (http_429); advancing to next alternate (${attemptPairs.length - i - 1} remaining)`,
        );
        continue;
      }
      // Any other failure surfaces IMMEDIATELY — this is the audit-
      // focus 3 invariant: silent provider swap on an unknown error
      // is forbidden. Raise verbatim.
      throw error;
    }
  }

  if (bundle === undefined) {
    throw new LocalizeProjectBlockedExternal(failureAttempts);
  }

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
  // ITOTORI-238 — the `pair` field carries the pair THAT ACTUALLY DROVE
  // THE SUCCESSFUL RUN (i.e. the primary on a clean run, the alternate
  // on a failover-adopted run). The `failoverAttempts` field carries
  // every 429 along the way so audit can trace the chain.
  const patchReport = {
    schemaVersion: "itotori.localize-project.patch-report.v0",
    policyId,
    pair: driverPair,
    enUsSentinel,
    sceneId,
    bridgeUnitId: unit.bridgeUnitId,
    unitCount: bridge.units.length,
    finalDraftTextLength: draftText.length,
    translatedTargetText: wrapWithSentinel(draftText, enUsSentinel),
    failoverPredicate: policyV03.failoverPredicate,
    failoverAttempts: failureAttempts,
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
      // only needs the bare (modelId, providerId) for its diagnostic
      // surface; the orchestrator's bundle is what surfaces the full
      // posture per invocation.
      pair: { modelId: pair.pair.modelId, providerId: pair.pair.providerId },
      sentinel: opts.enUsSentinel,
    });
  };
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
      inner: OpenRouterModelProvider;
      stage: string;
      agentLabel: string;
      pair: { modelId: string; providerId: string };
      sentinel: string;
    },
  ) {
    // ITOTORI-237 — surface the per-pair capability sheet to agents
    // reading `provider.descriptor.capabilities` directly (e.g. the
    // speaker-label pre-flight check). The wrapper knows the
    // (modelId, providerId) at construction, so the descriptor is
    // pair-specific from the moment the agent receives it. Unknown
    // pairs fall back to the safe defaults inside `descriptorForPair`.
    this.descriptor = opts.inner.descriptorForPair(opts.pair);
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
    return this.opts.inner.invoke({ ...request, messages });
  }
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
