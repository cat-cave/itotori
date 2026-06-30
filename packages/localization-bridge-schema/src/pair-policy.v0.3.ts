// ITOTORI-238 — Pair-policy wire schema v0.3.
//
// Widens the v0.2 shape (single per-stage POSTURE: pair + zdr +
// fallbackModels + seed + maxPriceUsd) by adding two TOP-LEVEL fields
// that wire an EXPLICIT failover chain for the primary pair:
//
//   1. `alternateProviders` (default `[]`) — an ORDERED list of
//      fully-declared `(modelId, providerId)` pairs WITH per-pair
//      capabilitySheets that the localize-project driver may failover
//      to AT MOST ONCE per primary 429. Each entry is the complete
//      contract — modelId, providerId, capabilitySheet — so adopting an
//      alternate is a commit-visible change (no implicit provider
//      broadening, no auto-fallback).
//   2. `failoverPredicate` (default `"http_429_from_primary"`) — the
//      LITERAL string identifying WHICH failure condition on the
//      primary pair triggers the driver to advance to the next
//      alternate. The only accepted literal in v0.3 is
//      `"http_429_from_primary"`. Any other failure mode
//      (`provider_response_invalid`, `provider_http_error` with status
//      != 429, `capability_unsupported`, `cost_cap_exceeded`, etc.) MUST
//      surface immediately — silently swapping providers on an unknown
//      error is the failure mode the audit-focus call-out forbids.
//      (`pair_mismatch` is deliberately NOT in this list: that guard was
//      deleted when OpenRouter-side automatic fallback became the model —
//      provider identity is no longer a failure axis, so a served
//      provider other than the requested one is a valid serve, not an
//      error. See `apps/itotori/src/providers/types.ts` `ModelProviderError`,
//      whose code union no longer contains `pair_mismatch`.)
//
// The v0.2 path is DELETED in the same change (no-legacy-compat):
//   - `packages/localization-bridge-schema/src/pair-policy.v0.2.ts` is
//     removed.
//   - Files with `schemaVersion: "0.1"`, `"itotori.pair-policy.v0.1"`,
//     `"0.2"`, `"itotori.pair-policy.v0.2"`, or an absent
//     `schemaVersion` field are rejected with
//     `PairPolicyVersionMismatchError` at parse time. There is no v0.2
//     parsing path; files MUST be migrated to v0.3.
//
// Why this exists (load-bearing):
//
//   - UTSUSHI-231 alpha-validation reruns are STRUCTURALLY blocked
//     today by Fireworks-side HTTP 429 quota responses on the primary
//     pair `(deepseek/deepseek-v4-flash, fireworks)`. Three of six
//     attempts over the rerun window failed at the same status code
//     from the same upstream provider — i.e. a per-provider quota
//     issue, not a transient retry-this-call situation.
//   - The (modelId, providerId) pair rule (feedback_model_provider_pair
//     in user memory) FORBIDS treating providers as interchangeable.
//     Therefore the alternate is not a "fallback model" in OpenRouter's
//     routing block (which would let OR silently route to ANY ZDR
//     provider); it is an EXPLICIT, evidence-validated, fully-declared
//     pair that the driver advances to ONLY when the failover predicate
//     fires on the primary.
//   - The capabilitySheet per alternate mirrors the DEV_PAIR sheet shape
//     (see `apps/itotori/src/providers/dev-pair.ts`) so the orchestrator
//     can refuse adopting an alternate that doesn't meet the structured-
//     output bar for the QA + speaker-label stages. This is the
//     "evidence-validation" rule from feedback_no_optionality_evidence_
//     first in user memory: every alternate is declared with its own
//     capability axes, not lumped into a single "alternates have all
//     the same caps" assumption.
//
// What changes structurally:
//
//   - `PairPolicyV03` adds two top-level fields and inherits everything
//     else from the v0.2 shape (per-stage posture, top-level pair,
//     enUsSentinel, sceneId, optional openrouterPresetSlug).
//   - `PairPolicyV03Alternate` is the explicit, fully-declared shape:
//     `{ modelId, providerId, capabilitySheet }` where capabilitySheet
//     declares the structured-outputs / cost / context-window / image
//     axes per pair.
//   - `FailoverPredicate` is a closed sum type. Today the only inhabitant
//     is `"http_429_from_primary"`. A future v0.4 can widen it; today
//     the orchestrator refuses unknown literals at parse time.
//   - The per-stage StagePostureV03 shape is byte-identical to v0.2's
//     StagePostureV02 (pair + zdr + fallbackModels + seed + maxPriceUsd).
//     We re-declare the type so v0.3 callers don't carry a "v0.2"
//     identifier through their code.
//
// No-legacy-compat:
//
//   - The v0.2 file (pair-policy.v0.2.ts) is DELETED in this same change.
//   - The KNOWN_LEGACY_PAIR_POLICY_VERSIONS list explicitly enumerates
//     "0.1", "itotori.pair-policy.v0.1", "0.2", and
//     "itotori.pair-policy.v0.2" so the operator sees a precise
//     "rewrite to v0.3" diagnostic on any pre-v0.3 file in the tree.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const PAIR_POLICY_SCHEMA_VERSION = "itotori.pair-policy.v0.3" as const;
export type PairPolicySchemaVersion = typeof PAIR_POLICY_SCHEMA_VERSION;

// Known prior-version literals; the parser rejects each with
// `PairPolicyVersionMismatchError`. We enumerate them explicitly so a
// future v0.4 bump can land an equally precise mismatch diagnostic.
export const KNOWN_LEGACY_PAIR_POLICY_VERSIONS: ReadonlyArray<string> = [
  "0.1",
  "itotori.pair-policy.v0.1",
  "0.2",
  "itotori.pair-policy.v0.2",
];

// ---------------------------------------------------------------------------
// Failover predicate
// ---------------------------------------------------------------------------

/**
 * The literal identifying WHICH failure condition on the primary pair
 * causes the driver to advance to the next alternate. Closed sum type
 * — the only accepted inhabitant in v0.3 is `"http_429_from_primary"`.
 *
 * Why this is a string literal and not a structured object: making the
 * predicate a hard-coded literal at the policy file boundary keeps the
 * failover decision auditable. An operator reviewing a pair-policy can
 * see at a glance "this file will failover ON THIS condition AND NO
 * OTHER". Widening to a structured predicate would invite silent
 * generalisation ("also failover on 5xx", "also failover on
 * provider_response_invalid"), which is exactly the silent-provider-
 * swap failure mode the audit-focus call-out forbids.
 */
export const FAILOVER_PREDICATES = ["http_429_from_primary"] as const;
export type FailoverPredicate = (typeof FAILOVER_PREDICATES)[number];

export const DEFAULT_FAILOVER_PREDICATE: FailoverPredicate = "http_429_from_primary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pinned (modelId, providerId) pair. Byte-equal to the v0.2 leaf pair.
 */
export type PairPolicyV03Pair = {
  modelId: string;
  providerId: string;
};

/**
 * Lightweight capability sheet declared per alternate. Mirrors the
 * `DevPairCapabilities` summary in `apps/itotori/src/providers/dev-
 * pair.ts` so the orchestrator can refuse an alternate that doesn't
 * support the structured-output / context-window axes the QA stages
 * require.
 *
 * Every field is REQUIRED at the alternate-provider declaration site
 * — the parser fills NOTHING in. The forcing function: adding an
 * alternate without a fully-declared capability sheet is a parse
 * error, not a default-filled "best guess".
 */
export type PairPolicyV03AlternateCapabilitySheet = {
  /**
   * Does the (modelId, providerId) pair support OpenAI-style
   * `response_format: { type: "json_schema" }` with `strict: true`?
   * Evidence-validation rule: this field MUST be true for an alternate
   * to be added to a policy that runs the structured QA stages. If a
   * candidate provider returned HTTP 404/422 on the json_schema probe
   * in the evidence file, declare `false` here and the parser refuses
   * the alternate at parse time (the orchestrator's QA stages would
   * fail anyway; this fails earlier).
   */
  supportsStructuredOutputJsonSchema: boolean;
  /**
   * Does the pair support OpenAI-style tool / function calls?
   */
  supportsToolUse: boolean;
  /**
   * The pair's context window (in tokens) per the OpenRouter catalog
   * row. Used by the cost-cap divisor; an alternate with a smaller
   * window than the primary MUST be flagged so the orchestrator can
   * trim long prompts before invoking it.
   */
  contextWindowTokens: number;
  /**
   * Maximum output tokens per the catalog row. Same rationale.
   */
  maxOutputTokens: number;
  /**
   * Free-form note pointing at the evidence file that validated this
   * pair. Required so an auditor reading the preset can trace back to
   * the toy call that validated it. The parser refuses an empty string.
   */
  evidenceRef: string;
};

/**
 * Fully-declared alternate provider. The orchestrator advances to the
 * NEXT alternate (in declared order) on each failover-predicate hit.
 * Once all alternates are exhausted the orchestrator raises
 * `AlphaRerunBlockedExternal` and surfaces the failure to the operator.
 */
export type PairPolicyV03Alternate = {
  modelId: string;
  providerId: string;
  capabilitySheet: PairPolicyV03AlternateCapabilitySheet;
};

/**
 * One stage / agent's resolved posture. Byte-identical to the v0.2
 * shape; carried here so v0.3 callers don't import the v0.2 type name.
 */
export type StagePostureV03 = {
  pair: PairPolicyV03Pair;
  zdr: boolean;
  fallbackModels: string[];
  seed: number;
  /**
   * Per-stage maximum USD charge for one invocation. OpenRouter-backed
   * callers translate this to `provider.max_price.request` and also
   * enforce it locally after invocation by comparing the provider's
   * reported `usage.cost` to this cap.
   */
  maxPriceUsd: number;
};

/**
 * Per-stage tree of postures. Identical leaf layout to v0.2.
 */
export type PairPolicyV03Stages = {
  context: {
    sceneSummary: StagePostureV03;
    characterRelationship: StagePostureV03;
    terminologyCandidate: StagePostureV03;
    routeChoiceMap: StagePostureV03;
  };
  preTranslation: {
    speakerLabel: StagePostureV03;
  };
  translation: {
    primary: StagePostureV03;
    regrade?: StagePostureV03;
  };
  qa: {
    styleAdherence: StagePostureV03;
    semanticDrift: StagePostureV03;
    toneRegister: StagePostureV03;
    unresolvedTerminology: StagePostureV03;
  };
  repair: {
    primary: StagePostureV03;
  };
};

/**
 * Full v0.3 pair-policy. Top-level adds `alternateProviders` and
 * `failoverPredicate`; everything else is preserved from v0.2.
 */
export type PairPolicyV03 = {
  schemaVersion: PairPolicySchemaVersion;
  policyId: string;
  enUsSentinel: string;
  sceneId: number;
  openrouterPresetSlug?: string;
  pair: PairPolicyV03Pair;
  /**
   * ORDERED list of alternate providers. Default `[]`. Each entry is a
   * fully-declared `(modelId, providerId, capabilitySheet)` — no
   * defaulting, no implicit broadening. Adopting an alternate is a
   * commit-visible change.
   */
  alternateProviders: ReadonlyArray<PairPolicyV03Alternate>;
  /**
   * The failover-predicate literal. Default
   * `"http_429_from_primary"`. The localize-project driver
   * advances to the next alternate ONLY when this predicate matches
   * the failure on the primary pair; any other failure surfaces
   * immediately.
   */
  failoverPredicate: FailoverPredicate;
  stages: PairPolicyV03Stages;
};

// ---------------------------------------------------------------------------
// Stage-name enumeration (byte-equal to v0.2)
// ---------------------------------------------------------------------------

export const PAIR_POLICY_V03_STAGE_LEAF_PATHS = [
  "context.sceneSummary",
  "context.characterRelationship",
  "context.terminologyCandidate",
  "context.routeChoiceMap",
  "preTranslation.speakerLabel",
  "translation.primary",
  "qa.styleAdherence",
  "qa.semanticDrift",
  "qa.toneRegister",
  "qa.unresolvedTerminology",
  "repair.primary",
] as const;

export type PairPolicyV03StageLeafPath = (typeof PAIR_POLICY_V03_STAGE_LEAF_PATHS)[number];

export const PAIR_POLICY_V03_OPTIONAL_STAGE_LEAF_PATHS = ["translation.regrade"] as const;

// ---------------------------------------------------------------------------
// Default derivation
// ---------------------------------------------------------------------------

/**
 * Deterministic seed derivation: `sha256(stagePath)[:8]` parsed as a
 * 32-bit unsigned integer. Identical to v0.2.
 */
export function deriveDefaultSeed(stagePath: string): number {
  const hex = createHash("sha256").update(stagePath).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

/**
 * Per-stage USD cap default: `defaultCostCapUsd / stageCount`. Identical
 * to v0.2.
 */
export function deriveDefaultMaxPriceUsd(defaultCostCapUsd: number, stageCount: number): number {
  if (stageCount <= 0) {
    throw new Error(
      `pair-policy.v0.3: stageCount must be > 0 to derive a default maxPriceUsd (got ${stageCount})`,
    );
  }
  if (defaultCostCapUsd < 0) {
    throw new Error(`pair-policy.v0.3: defaultCostCapUsd must be >= 0 (got ${defaultCostCapUsd})`);
  }
  return defaultCostCapUsd / stageCount;
}

/**
 * Parse the `OPENROUTER_ZDR_DOWNGRADE` env-var value into the set of
 * stage paths the operator has approved for a `zdr: false` posture.
 * Identical to v0.2.
 */
export function parseZdrDowngradeEnv(value: string | undefined): Set<string> {
  const set = new Set<string>();
  if (value === undefined || value.length === 0) return set;
  for (const piece of value.split(/[,\s]+/u)) {
    const trimmed = piece.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a file's `schemaVersion` field is a known legacy literal
 * (including any v0.1 or v0.2 inhabitant) or absent. The error carries
 * the observed value + the expected value.
 */
export class PairPolicyVersionMismatchError extends Error {
  constructor(
    public readonly observed: string | undefined,
    public readonly expected: PairPolicySchemaVersion,
  ) {
    super(
      `pair-policy refused: schemaVersion mismatch — observed=${
        observed === undefined ? "<absent>" : `'${observed}'`
      }, expected='${expected}'. v0.1 and v0.2 files are no longer accepted (no-legacy-compat); rewrite the file to the v0.3 shape (add alternateProviders[] and failoverPredicate).`,
    );
    this.name = "PairPolicyVersionMismatchError";
  }
}

/**
 * Raised on every other structural failure (missing field, wrong
 * type, malformed leaf, malformed alternate, zdr downgrade not
 * approved by env, unknown failover predicate, etc.).
 */
export class PairPolicyV03ValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail: string,
  ) {
    super(`pair-policy.v0.3 refused at ${path}: ${detail}`);
    this.name = "PairPolicyV03ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type PairPolicyV03ParseOptions = {
  defaultCostCapUsd: number;
  zdrDowngradeEnv: string | undefined;
};

/**
 * Parse a raw JSON value as a v0.3 pair-policy. Returns a fully
 * resolved `PairPolicyV03` — every stage leaf has its defaults filled
 * in; the top-level `alternateProviders` is filled to `[]` if absent;
 * `failoverPredicate` defaults to `"http_429_from_primary"`.
 *
 * Throws:
 *   - `PairPolicyVersionMismatchError` if `schemaVersion` is a known
 *     legacy literal or absent.
 *   - `PairPolicyV03ValidationError` on any other structural failure
 *     (including: an alternate whose capabilitySheet declares
 *     `supportsStructuredOutputJsonSchema: false`, since the QA
 *     stages of the alpha closer mandate structured outputs).
 */
export function parsePairPolicyV03(
  value: unknown,
  options: PairPolicyV03ParseOptions,
): PairPolicyV03 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairPolicyV03ValidationError("", "must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  // -- schemaVersion gate (no-legacy-compat) --
  const observedVersionRaw = record.schemaVersion;
  const observedVersion = typeof observedVersionRaw === "string" ? observedVersionRaw : undefined;
  if (observedVersion !== PAIR_POLICY_SCHEMA_VERSION) {
    throw new PairPolicyVersionMismatchError(observedVersion, PAIR_POLICY_SCHEMA_VERSION);
  }

  const policyId = expectNonEmptyString(record, "policyId");
  const enUsSentinel = expectNonEmptyString(record, "enUsSentinel");
  const sceneId = expectNonNegativeInteger(record, "sceneId");
  const pair = expectPair(record, "pair");
  const openrouterPresetSlug = expectOptionalNonEmptyString(record, "openrouterPresetSlug");

  // -- alternateProviders (default []) --
  const alternateProviders = parseAlternateProviders(record.alternateProviders, pair);

  // -- failoverPredicate (default 'http_429_from_primary') --
  let failoverPredicate: FailoverPredicate = DEFAULT_FAILOVER_PREDICATE;
  if ("failoverPredicate" in record) {
    const raw = record.failoverPredicate;
    if (typeof raw !== "string") {
      throw new PairPolicyV03ValidationError("failoverPredicate", "must be a string when present");
    }
    if (!(FAILOVER_PREDICATES as ReadonlyArray<string>).includes(raw)) {
      throw new PairPolicyV03ValidationError(
        "failoverPredicate",
        `unknown failover predicate '${raw}'; the only accepted v0.3 literal is '${DEFAULT_FAILOVER_PREDICATE}'`,
      );
    }
    failoverPredicate = raw as FailoverPredicate;
  }

  const stagesRaw = record.stages;
  if (typeof stagesRaw !== "object" || stagesRaw === null || Array.isArray(stagesRaw)) {
    throw new PairPolicyV03ValidationError("stages", "must be a JSON object");
  }

  const stageCount = PAIR_POLICY_V03_STAGE_LEAF_PATHS.length;
  const zdrDowngrades = parseZdrDowngradeEnv(options.zdrDowngradeEnv);
  const defaultMaxPriceUsd = deriveDefaultMaxPriceUsd(options.defaultCostCapUsd, stageCount);

  function parseLeaf(
    parentPath: string,
    leafName: string,
    parent: Record<string, unknown>,
  ): StagePostureV03 {
    const leafPath = `${parentPath}.${leafName}`;
    const leafRaw = parent[leafName];
    if (typeof leafRaw !== "object" || leafRaw === null || Array.isArray(leafRaw)) {
      throw new PairPolicyV03ValidationError(`stages.${leafPath}`, "must be a JSON object");
    }
    const leaf = leafRaw as Record<string, unknown>;
    const leafPair = expectPair(leaf, "pair", `stages.${leafPath}`);

    let zdr = true;
    if ("zdr" in leaf) {
      if (typeof leaf.zdr !== "boolean") {
        throw new PairPolicyV03ValidationError(
          `stages.${leafPath}.zdr`,
          "must be a boolean when present",
        );
      }
      zdr = leaf.zdr;
    }
    if (zdr === false && !zdrDowngrades.has(leafPath)) {
      throw new PairPolicyV03ValidationError(
        `stages.${leafPath}.zdr`,
        `set to false without OPENROUTER_ZDR_DOWNGRADE='${leafPath}' (or a list containing '${leafPath}'); operator-level posture downgrade required`,
      );
    }

    let fallbackModels: string[] = [];
    if ("fallbackModels" in leaf) {
      const rawList = leaf.fallbackModels;
      if (!Array.isArray(rawList)) {
        throw new PairPolicyV03ValidationError(
          `stages.${leafPath}.fallbackModels`,
          "must be an array of strings when present",
        );
      }
      fallbackModels = rawList.map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new PairPolicyV03ValidationError(
            `stages.${leafPath}.fallbackModels[${index}]`,
            "each entry must be a non-empty string",
          );
        }
        return entry;
      });
    }

    let seed = deriveDefaultSeed(leafPath);
    if ("seed" in leaf) {
      const rawSeed = leaf.seed;
      if (typeof rawSeed !== "number" || !Number.isInteger(rawSeed) || rawSeed < 0) {
        throw new PairPolicyV03ValidationError(
          `stages.${leafPath}.seed`,
          "must be a non-negative integer when present",
        );
      }
      seed = rawSeed;
    }

    let maxPriceUsd = defaultMaxPriceUsd;
    if ("maxPriceUsd" in leaf) {
      const rawCap = leaf.maxPriceUsd;
      if (typeof rawCap !== "number" || !Number.isFinite(rawCap) || rawCap < 0) {
        throw new PairPolicyV03ValidationError(
          `stages.${leafPath}.maxPriceUsd`,
          "must be a non-negative finite number when present",
        );
      }
      maxPriceUsd = rawCap;
    }

    return { pair: leafPair, zdr, fallbackModels, seed, maxPriceUsd };
  }

  function expectStageGroup(name: string): Record<string, unknown> {
    const raw = (stagesRaw as Record<string, unknown>)[name];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PairPolicyV03ValidationError(`stages.${name}`, "must be a JSON object");
    }
    return raw as Record<string, unknown>;
  }

  const contextGroup = expectStageGroup("context");
  const preTranslationGroup = expectStageGroup("preTranslation");
  const translationGroup = expectStageGroup("translation");
  const qaGroup = expectStageGroup("qa");
  const repairGroup = expectStageGroup("repair");

  const stages: PairPolicyV03Stages = {
    context: {
      sceneSummary: parseLeaf("context", "sceneSummary", contextGroup),
      characterRelationship: parseLeaf("context", "characterRelationship", contextGroup),
      terminologyCandidate: parseLeaf("context", "terminologyCandidate", contextGroup),
      routeChoiceMap: parseLeaf("context", "routeChoiceMap", contextGroup),
    },
    preTranslation: {
      speakerLabel: parseLeaf("preTranslation", "speakerLabel", preTranslationGroup),
    },
    translation: {
      primary: parseLeaf("translation", "primary", translationGroup),
      ...("regrade" in translationGroup
        ? { regrade: parseLeaf("translation", "regrade", translationGroup) }
        : {}),
    },
    qa: {
      styleAdherence: parseLeaf("qa", "styleAdherence", qaGroup),
      semanticDrift: parseLeaf("qa", "semanticDrift", qaGroup),
      toneRegister: parseLeaf("qa", "toneRegister", qaGroup),
      unresolvedTerminology: parseLeaf("qa", "unresolvedTerminology", qaGroup),
    },
    repair: {
      primary: parseLeaf("repair", "primary", repairGroup),
    },
  };

  const parsed: PairPolicyV03 = {
    schemaVersion: PAIR_POLICY_SCHEMA_VERSION,
    policyId,
    enUsSentinel,
    sceneId,
    pair,
    alternateProviders,
    failoverPredicate,
    stages,
  };
  if (openrouterPresetSlug !== undefined) {
    parsed.openrouterPresetSlug = openrouterPresetSlug;
  }
  return parsed;
}

/**
 * Flatten a parsed v0.3 policy's stage tree into an ordered list of
 * `(leafPath, posture)` tuples. Order matches
 * `PAIR_POLICY_V03_STAGE_LEAF_PATHS`.
 */
export function flattenPairPolicyV03Postures(
  policy: PairPolicyV03,
): ReadonlyArray<{ leafPath: string; posture: StagePostureV03 }> {
  const out: Array<{ leafPath: string; posture: StagePostureV03 }> = [
    { leafPath: "context.sceneSummary", posture: policy.stages.context.sceneSummary },
    {
      leafPath: "context.characterRelationship",
      posture: policy.stages.context.characterRelationship,
    },
    {
      leafPath: "context.terminologyCandidate",
      posture: policy.stages.context.terminologyCandidate,
    },
    { leafPath: "context.routeChoiceMap", posture: policy.stages.context.routeChoiceMap },
    { leafPath: "preTranslation.speakerLabel", posture: policy.stages.preTranslation.speakerLabel },
    { leafPath: "translation.primary", posture: policy.stages.translation.primary },
  ];
  if (policy.stages.translation.regrade !== undefined) {
    out.push({ leafPath: "translation.regrade", posture: policy.stages.translation.regrade });
  }
  out.push(
    { leafPath: "qa.styleAdherence", posture: policy.stages.qa.styleAdherence },
    { leafPath: "qa.semanticDrift", posture: policy.stages.qa.semanticDrift },
    { leafPath: "qa.toneRegister", posture: policy.stages.qa.toneRegister },
    { leafPath: "qa.unresolvedTerminology", posture: policy.stages.qa.unresolvedTerminology },
    { leafPath: "repair.primary", posture: policy.stages.repair.primary },
  );
  return out;
}

// ---------------------------------------------------------------------------
// Alternate-providers parser
// ---------------------------------------------------------------------------

function parseAlternateProviders(
  raw: unknown,
  primary: PairPolicyV03Pair,
): ReadonlyArray<PairPolicyV03Alternate> {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new PairPolicyV03ValidationError("alternateProviders", "must be an array when present");
  }
  const out: PairPolicyV03Alternate[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entryRaw = raw[i];
    const path = `alternateProviders[${i}]`;
    if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) {
      throw new PairPolicyV03ValidationError(path, "must be a JSON object");
    }
    const entry = entryRaw as Record<string, unknown>;
    const modelId = entry.modelId;
    const providerId = entry.providerId;
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new PairPolicyV03ValidationError(`${path}.modelId`, "must be a non-empty string");
    }
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new PairPolicyV03ValidationError(`${path}.providerId`, "must be a non-empty string");
    }
    // An alternate that re-declares the primary pair is meaningless —
    // failover to the same pair would loop on the same 429. Refuse it
    // at parse time so the operator sees the mistake immediately.
    if (modelId === primary.modelId && providerId === primary.providerId) {
      throw new PairPolicyV03ValidationError(
        path,
        `alternate (modelId='${modelId}', providerId='${providerId}') byte-equals the top-level pair; an alternate must declare a DIFFERENT pair`,
      );
    }
    // Refuse duplicate alternates. Two entries with the same pair would
    // make the failover order ambiguous.
    if (out.some((prev) => prev.modelId === modelId && prev.providerId === providerId)) {
      throw new PairPolicyV03ValidationError(
        path,
        `duplicate alternate (modelId='${modelId}', providerId='${providerId}') — each alternate must be unique`,
      );
    }
    const capabilitySheet = parseAlternateCapabilitySheet(entry.capabilitySheet, path);
    out.push({ modelId, providerId, capabilitySheet });
  }
  return out;
}

function parseAlternateCapabilitySheet(
  raw: unknown,
  parentPath: string,
): PairPolicyV03AlternateCapabilitySheet {
  const path = `${parentPath}.capabilitySheet`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PairPolicyV03ValidationError(path, "must be a JSON object");
  }
  const sheet = raw as Record<string, unknown>;

  const requireBool = (key: keyof PairPolicyV03AlternateCapabilitySheet): boolean => {
    const v = sheet[key];
    if (typeof v !== "boolean") {
      throw new PairPolicyV03ValidationError(`${path}.${String(key)}`, "must be a boolean");
    }
    return v;
  };
  const requirePositiveInt = (key: keyof PairPolicyV03AlternateCapabilitySheet): number => {
    const v = sheet[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new PairPolicyV03ValidationError(
        `${path}.${String(key)}`,
        "must be a positive integer",
      );
    }
    return v;
  };
  const requireNonEmpty = (key: keyof PairPolicyV03AlternateCapabilitySheet): string => {
    const v = sheet[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new PairPolicyV03ValidationError(
        `${path}.${String(key)}`,
        "must be a non-empty string",
      );
    }
    return v;
  };

  const supportsStructuredOutputJsonSchema = requireBool("supportsStructuredOutputJsonSchema");
  // Refuse adopting an alternate whose capability sheet declares
  // structured-outputs unsupported. The generic localization QA stages
  // (styleAdherence / semanticDrift / etc.) all use
  // response_format: { type: "json_schema" }; an alternate without
  // that axis would cause the QA stages to fail on adoption. Refusing
  // at parse time is the forcing function.
  if (!supportsStructuredOutputJsonSchema) {
    throw new PairPolicyV03ValidationError(
      `${path}.supportsStructuredOutputJsonSchema`,
      "alternate refused: the QA + speaker-label stages of the alpha closer require json_schema structured outputs; an alternate that does not declare 'supportsStructuredOutputJsonSchema: true' would fail at QA time anyway. Re-validate the alternate against an OpenRouter toy call and update the capability sheet, or drop the alternate from the policy.",
    );
  }
  const supportsToolUse = requireBool("supportsToolUse");
  const contextWindowTokens = requirePositiveInt("contextWindowTokens");
  const maxOutputTokens = requirePositiveInt("maxOutputTokens");
  const evidenceRef = requireNonEmpty("evidenceRef");

  return {
    supportsStructuredOutputJsonSchema,
    supportsToolUse,
    contextWindowTokens,
    maxOutputTokens,
    evidenceRef,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new PairPolicyV03ValidationError(key, "must be a string");
  }
  if (value.length === 0) {
    throw new PairPolicyV03ValidationError(key, "must be a non-empty string");
  }
  return value;
}

function expectOptionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new PairPolicyV03ValidationError(key, "must be a non-empty string when present");
  }
  return value;
}

function expectNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new PairPolicyV03ValidationError(key, "must be a finite integer");
  }
  if (value < 0) {
    throw new PairPolicyV03ValidationError(key, "must be a non-negative integer");
  }
  return value;
}

function expectPair(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): PairPolicyV03Pair {
  const value = record[key];
  const errPath = parentPath !== undefined ? `${parentPath}.${key}` : key;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairPolicyV03ValidationError(errPath, "must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const modelId = obj.modelId;
  const providerId = obj.providerId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new PairPolicyV03ValidationError(`${errPath}.modelId`, "must be a non-empty string");
  }
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new PairPolicyV03ValidationError(`${errPath}.providerId`, "must be a non-empty string");
  }
  return { modelId, providerId };
}
