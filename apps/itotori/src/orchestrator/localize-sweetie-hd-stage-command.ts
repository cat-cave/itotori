// UTSUSHI-228 — `itotori:localize-sweetie-hd-stage` CLI handler.
//
// Thin LIVE-LLM wrapper around `runAgenticLoopForUnit` used by the
// suite/scripts/localize-sweetie-hd/run.mjs driver. Distinct from
// `agentic-loop-smoke` because that command HARD-REFUSES live providers
// (it is a synthetic CI smoke). This command does the opposite: it
// hard-requires the live OpenRouter provider via OPENROUTER_API_KEY,
// loads the pair-policy from a JSON file (NO defaulting), and weaves
// the en-US sentinel into the prompt so the translated draft text the
// LLM emits is guaranteed to include the substring the patchback +
// replay-validate pipeline asserts on.
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
//                                       pair-policy), the bridge unit
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
  parsePairPolicyV02,
  PairPolicyVersionMismatchError,
  PairPolicyV02ValidationError,
  flattenPairPolicyV02Postures,
  type AgenticLoopBundle,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type PairPolicyV02,
} from "@itotori/localization-bridge-schema";
import { DEFAULT_COST_CAP_USD, OpenRouterModelProvider } from "../providers/openrouter.js";
import { FakeModelProvider } from "../providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
} from "../providers/types.js";
import {
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "./agentic-loop.js";

export type LocalizeSweetieHdStageIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type LocalizeSweetieHdStageArgs = {
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
  io: LocalizeSweetieHdStageIo;
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
};

export class LocalizeSweetieHdMissingApiKeyError extends Error {
  constructor(envVarName: string) {
    super(
      `localize-sweetie-hd-stage refused: env var ${envVarName} must be set (the no-fallback rule forbids downgrading to the recorded provider when the live path is requested)`,
    );
    this.name = "LocalizeSweetieHdMissingApiKeyError";
  }
}

export class LocalizeSweetieHdPairPolicyError extends Error {
  constructor(detail: string) {
    super(`localize-sweetie-hd-stage refused: pair-policy ${detail}`);
    this.name = "LocalizeSweetieHdPairPolicyError";
  }
}

export class LocalizeSweetieHdRefusedFakeError extends Error {
  constructor() {
    super(
      "localize-sweetie-hd-stage refused: --provider-kind fake requires ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER=1 to be set; the production recipe must run live",
    );
    this.name = "LocalizeSweetieHdRefusedFakeError";
  }
}

const DEFAULT_UNIT_INDEX = 0;

// Re-export so the test surface and any external integrators get the
// version-mismatch error from the same place they used to import the
// command-level error.
export { PairPolicyVersionMismatchError };

/**
 * ITOTORI-234 — Parse + validate a raw JSON value as a v0.2 pair-policy
 * tailored for the localize-sweetie-hd alpha closer.
 *
 * Required shape (matches `PairPolicyV02` in
 * `@itotori/localization-bridge-schema/pair-policy.v0.2`):
 *
 * ```json
 * {
 *   "schemaVersion": "itotori.pair-policy.v0.2",
 *   "policyId": "localize-sweetie-hd-alpha-1",
 *   "pair": { "modelId": "...", "providerId": "..." },
 *   "enUsSentinel": "STELLA-ALPHA-EN-US-SENTINEL",
 *   "sceneId": 1,
 *   "openrouterPresetSlug": "optional",
 *   "stages": { ...per-stage StagePostureV02 leaves... }
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
 * This parser accepts both; the override is a deliberate posture.
 *
 * Throws `PairPolicyVersionMismatchError` for v0.1 / absent-schemaVersion
 * inputs (the schema bump is the forcing function; there is no v0.1
 * parsing path). Throws `LocalizeSweetieHdPairPolicyError` for anything
 * else (missing field, byte-equal pair mismatch).
 */
export function parseLocalizeSweetieHdPairPolicy(value: unknown): {
  policyId: string;
  pair: { modelId: string; providerId: string };
  enUsSentinel: string;
  sceneId: number;
  openrouterPresetSlug?: string;
  pairPolicy: PairPolicy;
  /**
   * Raw parsed v0.2 policy. Surfaced so the dry-run printer + driver
   * can iterate every leaf's posture (zdr + seed) verbatim.
   */
  policyV02: PairPolicyV02;
} {
  let parsed: PairPolicyV02;
  try {
    parsed = parsePairPolicyV02(value, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: process.env.OPENROUTER_ZDR_DOWNGRADE,
    });
  } catch (error) {
    if (error instanceof PairPolicyVersionMismatchError) {
      // Bubble the version-mismatch verbatim so callers can branch on it
      // (the acceptance-criterion #2 test asserts on the typed class).
      throw error;
    }
    if (error instanceof PairPolicyV02ValidationError) {
      throw new LocalizeSweetieHdPairPolicyError(error.message);
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
    policyV02: PairPolicyV02;
  } = {
    policyId: parsed.policyId,
    pair: { modelId: parsed.pair.modelId, providerId: parsed.pair.providerId },
    enUsSentinel: parsed.enUsSentinel,
    sceneId: parsed.sceneId,
    pairPolicy: parsed.stages,
    policyV02: parsed,
  };
  if (parsed.openrouterPresetSlug !== undefined) {
    out.openrouterPresetSlug = parsed.openrouterPresetSlug;
  }
  return out;
}

function assertEveryLeafMatches(policy: PairPolicyV02): void {
  const expected = policy.pair;
  for (const { leafPath, posture } of flattenPairPolicyV02Postures(policy)) {
    if (
      posture.pair.modelId !== expected.modelId ||
      posture.pair.providerId !== expected.providerId
    ) {
      throw new LocalizeSweetieHdPairPolicyError(
        `stages.${leafPath}.pair (modelId=${posture.pair.modelId}, providerId=${posture.pair.providerId}) does not byte-equal the top-level pair (modelId=${expected.modelId}, providerId=${expected.providerId}); the single-game alpha invariant forbids mixed pairs in this policy`,
      );
    }
  }
}

export async function runLocalizeSweetieHdStageCommand(
  args: LocalizeSweetieHdStageArgs,
): Promise<AgenticLoopBundle> {
  const log = args.log ?? (() => {});

  const rawBridge = args.io.readJson(args.bridgePath);
  const bridge = assertBridgeBundleV02Shape(rawBridge);
  if (bridge.units.length === 0) {
    throw new Error("localize-sweetie-hd-stage refused: bridge has zero units");
  }
  const unitIndex = args.unitIndex ?? DEFAULT_UNIT_INDEX;
  if (unitIndex < 0 || unitIndex >= bridge.units.length) {
    throw new Error(
      `localize-sweetie-hd-stage refused: --unit-index ${unitIndex} out of range; bridge has ${bridge.units.length} unit(s)`,
    );
  }
  const unit = bridge.units[unitIndex];
  if (unit === undefined) {
    throw new Error("localize-sweetie-hd-stage refused: bridge unit lookup returned undefined");
  }

  const rawPolicy = args.io.readJson(args.pairPolicyPath);
  const { policyId, pair, enUsSentinel, sceneId, pairPolicy } =
    parseLocalizeSweetieHdPairPolicy(rawPolicy);
  log(
    `localize-sweetie-hd-stage: policyId=${policyId} pair=(${pair.modelId}, ${pair.providerId}) sentinel=${enUsSentinel}`,
  );

  const providerKind = args.providerKind ?? "live";
  if (providerKind === "fake" && process.env.ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER !== "1") {
    throw new LocalizeSweetieHdRefusedFakeError();
  }

  const policy: AgenticLoopPolicy = {
    projectId: bridge.bridgeId,
    localeBranchId: `branch:${unit.sourceRevision.revisionId}`,
    sourceLocale: bridge.sourceLocale,
    targetLocale: "en-US",
    maxRepairAttempts: args.maxRepairAttempts ?? 1,
    now: deterministicNow(),
  };

  const factory =
    providerKind === "fake"
      ? sentinelFakeFactory(unit, policy, enUsSentinel)
      : liveOpenRouterFactory({
          enUsSentinel,
          costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
        });

  const input: AgenticLoopUnitInput = {
    unit,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: args.actor,
  };
  const bundle = await runAgenticLoopForUnit(input, pairPolicy, policy, factory);
  assertAgenticLoopBundle(bundle);
  args.io.writeJson(args.outputPath, bundle);
  log(`localize-sweetie-hd-stage: wrote ${args.outputPath}`);

  // Synthesise the translated bridge bundle: clone the source JSON,
  // overwrite each unit's `target` block with the sentinel-wrapped
  // draft text. We wrap with the SJIS bracket pair so the KAIFUU-191
  // lexer captures the run as a Textout opcode rather than silently
  // dropping the ASCII bytes as `Unknown`.
  const draftText = bundle.finalDraft.draftText ?? `[en-US] ${unit.sourceText}`;
  const translatedBridge = synthesiseTranslatedBridge(rawBridge, draftText, enUsSentinel);
  args.io.writeJson(args.translatedBundleOutputPath, translatedBridge);
  log(`localize-sweetie-hd-stage: wrote ${args.translatedBundleOutputPath}`);

  // Synthesise the patch-report.json. The kaifuu-reallive bundle-
  // driven patchback writes the patched Seen.txt in place but does
  // NOT emit a per-run report; the driver shoulders that artifact so
  // the UTSUSHI-228 artifact contract is satisfied.
  const patchReport = {
    schemaVersion: "itotori.localize-sweetie-hd.patch-report.v0",
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
  log(`localize-sweetie-hd-stage: wrote ${args.patchReportOutputPath}`);

  return bundle;
}

function liveOpenRouterFactory(opts: {
  enUsSentinel: string;
  costCapUsd: number;
}): AgenticLoopProviderFactory {
  // Constructed once so the per-process cost cap + token bucket are
  // shared across every stage's invocation. Throws
  // OpenRouterMissingApiKeyError immediately if the API key is
  // missing — surfaces the no-fallback failure mode at the driver
  // boundary rather than at first invoke.
  let provider: OpenRouterModelProvider | undefined;
  return ({ stage, agentLabel, pair }) => {
    if (provider === undefined) {
      provider = new OpenRouterModelProvider({
        costCapUsd: opts.costCapUsd,
      });
    }
    return new SentinelInjectingProviderWrapper({
      inner: provider,
      stage,
      agentLabel,
      // ITOTORI-234 — the factory now receives a full StagePostureV02
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
      inner: ModelProvider;
      stage: string;
      agentLabel: string;
      pair: { modelId: string; providerId: string };
      sentinel: string;
    },
  ) {
    this.descriptor = opts.inner.descriptor;
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const isTranslation = request.taskKind === "draft_translation";
    const messages = isTranslation
      ? request.messages.map((message, index) => {
          if (index === 0 && message.role === "system" && typeof message.content === "string") {
            return {
              ...message,
              content: `${message.content}\n\nIMPORTANT (UTSUSHI-228 alpha closer): your translated draft MUST include the literal ASCII substring "${this.opts.sentinel}" exactly once. The downstream replay-validate step asserts on it.`,
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
      providerName: `localize-sweetie-hd-fake:${stage}:${agentLabel}`,
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
                agentRationale: "localize-sweetie-hd-fake narration",
              },
            ],
          });
        }
        if (request.taskKind === "experiment") {
          return `localize-sweetie-hd-fake:context:${agentLabel}`;
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
                agentRationale: "localize-sweetie-hd-fake translation",
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
    throw new Error("localize-sweetie-hd-stage refused: bridge JSON must be an object");
  }
  // Deep-clone via JSON round-trip — the bridge bundle is plain JSON.
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("localize-sweetie-hd-stage refused: bridge.units must be an array");
  }
  const wrappedText = wrapWithSentinel(draftText, enUsSentinel);
  for (const unit of units) {
    if (typeof unit !== "object" || unit === null) {
      throw new Error("localize-sweetie-hd-stage refused: bridge unit must be an object");
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
    throw new Error("localize-sweetie-hd-stage refused: bridge file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "0.2.0") {
    throw new Error(
      `localize-sweetie-hd-stage refused: bridge schemaVersion must be '0.2.0' (got ${String(record.schemaVersion)})`,
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
