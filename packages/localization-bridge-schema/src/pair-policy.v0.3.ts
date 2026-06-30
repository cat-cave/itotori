// Pair-policy wire schema v0.3.
//
// A v0.3 policy declares the SINGLE (modelId, providerId) pair that
// drives every stage of the agentic loop, plus a per-stage posture
// (pair + zdr + fallbackModels + seed + maxPriceUsd) for each leaf and
// the top-level enUsSentinel / sceneId / optional openrouterPresetSlug.
//
// Resilience is OpenRouter-side, NOT in this schema. On the wire the
// OpenRouter provider sends `provider.order = [providerId]` +
// `allow_fallbacks = true` + `zdr = true`, so OpenRouter routes within
// the account ZDR allow-list when the preferred upstream returns HTTP
// 429 and records whichever provider actually served (ITOTORI-241 /
// UTSUSHI-231 live run). There is therefore NO app-level alternate-
// chaining: the superseded ITOTORI-238/239/240 `alternateProviders[]` +
// `failoverPredicate` machinery was REMOVED (no-legacy — it was
// redundant with, and could double-handle, an OR-resolved 429). If
// every ZDR-allow-list provider is at quota, OR returns the terminal
// error and the caller surfaces it as a `ModelProviderError`.
//
// No-legacy-compat (version gate, unchanged):
//   - Files with `schemaVersion: "0.1"`, `"itotori.pair-policy.v0.1"`,
//     `"0.2"`, `"itotori.pair-policy.v0.2"`, or an absent
//     `schemaVersion` field are rejected with
//     `PairPolicyVersionMismatchError` at parse time. Files MUST be
//     migrated to the v0.3 shape.

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
 * Full v0.3 pair-policy. A single primary pair drives every stage;
 * OpenRouter-side fallback (provider.order + allow_fallbacks within the
 * ZDR allow-list) is the resilience mechanism, so there is no app-level
 * alternate/failover plumbing in the schema.
 */
export type PairPolicyV03 = {
  schemaVersion: PairPolicySchemaVersion;
  policyId: string;
  enUsSentinel: string;
  sceneId: number;
  openrouterPresetSlug?: string;
  pair: PairPolicyV03Pair;
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
      }, expected='${expected}'. v0.1 and v0.2 files are no longer accepted (no-legacy-compat); rewrite the file to the v0.3 shape.`,
    );
    this.name = "PairPolicyVersionMismatchError";
  }
}

/**
 * Raised on every other structural failure (missing field, wrong
 * type, malformed leaf, zdr downgrade not approved by env, etc.).
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
 * in.
 *
 * Throws:
 *   - `PairPolicyVersionMismatchError` if `schemaVersion` is a known
 *     legacy literal or absent.
 *   - `PairPolicyV03ValidationError` on any other structural failure.
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
