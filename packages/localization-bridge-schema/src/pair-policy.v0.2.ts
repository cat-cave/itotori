// ITOTORI-234 — Pair-policy wire schema v0.2.
//
// Widens the v0.1 shape (single per-stage `(modelId, providerId)` pair)
// into a versioned per-stage POSTURE: pair + zdr posture + fallback
// models + seed + maxPriceUsd. The v0.1 path is DELETED in the same
// change (no-legacy-compat); files with `schemaVersion: "0.1"` or
// `"itotori.pair-policy.v0.1"` are rejected with
// `PairPolicyVersionMismatchError` at parse time.
//
// What "per-stage posture" means structurally:
//
//   - `pair` (unchanged): `{ modelId, providerId }`, byte-equal to the
//      v0.1 leaf shape — the alpha-closer's audit asserts on this exact
//      record per invocation.
//   - `zdr` (default `true`): per-stage privacy posture. Operator-level
//      escape hatch: stage X can be set `zdr: false` ONLY when the env
//      var `OPENROUTER_ZDR_DOWNGRADE` lists that stage (comma-separated
//      or exact match). This keeps the file declarative while routing
//      the unsafe choice through an env-level audit trail.
//   - `fallbackModels` (default `[]`): per-stage fallback list. Default
//      empty — strict pair pinning is the alpha posture per ITOTORI-220.
//      A populated list documents the per-stage fallback chain the
//      OpenRouter routing block would carry (`models: […]` per
//      docs/openrouter-integration.md §3).
//   - `seed` (default deterministic from stage name): per-stage seed.
//      Default = `sha256(stage_name)[:8]` interpreted as an unsigned
//      32-bit int. The bounded-repair loop uses `seed + attempt_number`
//      so the first attempt is reproducible but retries differentiate.
//   - `maxPriceUsd` (default derived): per-stage USD cap. Default =
//      `DEFAULT_COST_CAP_USD / stage_count` (the canonical 0.5 USD per
//      ITOTORI-231 divided across every leaf in the policy file).
//
// Top-level fields:
//
//   - `schemaVersion` is locked to the literal
//     `"itotori.pair-policy.v0.2"`.
//   - `openrouterPresetSlug` (optional): when set, declares that an
//     OpenRouter-side preset (configured at the OR dashboard) handles
//     routing. Per OpenRouter's preset rules
//     (docs/openrouter-integration.md §3), explicit request-level fields
//     override preset fields. Translation: if a policy file declares
//     BOTH `openrouterPresetSlug` AND per-stage `zdr` / `fallbackModels`
//     / `seed`, the per-stage values WIN at request time. The parser
//     surfaces this in a comment + accepts both; the schema does not
//     try to forbid overlap because the override behaviour is a
//     deliberate posture, not a bug.
//   - `policyId`, `enUsSentinel`, `sceneId` are preserved verbatim from
//     v0.1 (alpha closer wire shape).
//
// Stage tree (mirrors the v0.1 leaf layout):
//
//   ```
//   stages: {
//     context: {
//       sceneSummary: StagePostureV02,
//       characterRelationship: StagePostureV02,
//       terminologyCandidate: StagePostureV02,
//       routeChoiceMap: StagePostureV02,
//     },
//     preTranslation: { speakerLabel: StagePostureV02 },
//     translation:    { primary: StagePostureV02 },
//     qa: {
//       styleAdherence: StagePostureV02,
//       semanticDrift: StagePostureV02,
//       toneRegister: StagePostureV02,
//       unresolvedTerminology: StagePostureV02,
//     },
//     repair:         { primary: StagePostureV02 },
//   }
//   ```
//
//   Every leaf is a `StagePostureV02`. The byte-equal-pair invariant
//   from v0.1 (every leaf's `pair` equals the top-level `pair`) is
//   preserved: the localize-sweetie-hd parser still asserts it.
//
// Defaults policy:
//
//   The parser fills in `zdr`, `fallbackModels`, `seed`, `maxPriceUsd`
//   when absent at the leaf. Resolved postures are surfaced to callers
//   so the dry-run printer + the agentic-loop bundle can record them.
//
// No-legacy-compat:
//
//   - A file with `schemaVersion: "0.1"`, `"itotori.pair-policy.v0.1"`,
//     or an absent `schemaVersion` field is rejected at parse time with
//     `PairPolicyVersionMismatchError`. There is no fallback v0.1
//     parsing path. Files MUST be migrated to v0.2.
//   - Old v0.1 files in the tree are deleted in the same change; the
//     forcing function is the schema bump itself.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const PAIR_POLICY_SCHEMA_VERSION = "itotori.pair-policy.v0.2" as const;
export type PairPolicySchemaVersion = typeof PAIR_POLICY_SCHEMA_VERSION;

// Known prior-version literals; the parser rejects each with
// `PairPolicyVersionMismatchError`. We enumerate them explicitly rather
// than catching "anything that isn't v0.2" so a future v0.3 bump can
// emit a precise mismatch diagnostic.
export const KNOWN_LEGACY_PAIR_POLICY_VERSIONS: ReadonlyArray<string> = [
  "0.1",
  "itotori.pair-policy.v0.1",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pinned (modelId, providerId) pair. Byte-equal to the v0.1 leaf pair.
 */
export type PairPolicyV02Pair = {
  modelId: string;
  providerId: string;
};

/**
 * One stage / agent's resolved posture. Every field is filled in by the
 * parser; downstream consumers (orchestrator, dry-run printer, bundle)
 * see only resolved values, never `undefined`.
 */
export type StagePostureV02 = {
  pair: PairPolicyV02Pair;
  zdr: boolean;
  fallbackModels: string[];
  seed: number;
  /**
   * Per-stage USD cap. A decimal number (USD), bounded by
   * `DEFAULT_COST_CAP_USD` divided across the stage count by default.
   */
  maxPriceUsd: number;
};

/**
 * Per-stage tree of postures. Mirrors the v0.1 `PairPolicy` layout
 * leaf-for-leaf; only the leaf shape changed (pair -> posture).
 */
export type PairPolicyV02Stages = {
  context: {
    sceneSummary: StagePostureV02;
    characterRelationship: StagePostureV02;
    terminologyCandidate: StagePostureV02;
    routeChoiceMap: StagePostureV02;
  };
  preTranslation: {
    speakerLabel: StagePostureV02;
  };
  translation: {
    primary: StagePostureV02;
    regrade?: StagePostureV02;
  };
  qa: {
    styleAdherence: StagePostureV02;
    semanticDrift: StagePostureV02;
    toneRegister: StagePostureV02;
    unresolvedTerminology: StagePostureV02;
  };
  repair: {
    primary: StagePostureV02;
  };
};

/**
 * Full v0.2 pair-policy. The parser returns this exact shape — every
 * leaf is a fully-resolved `StagePostureV02`.
 */
export type PairPolicyV02 = {
  schemaVersion: PairPolicySchemaVersion;
  policyId: string;
  enUsSentinel: string;
  sceneId: number;
  /**
   * Optional OpenRouter preset slug. When set, the OR-side preset
   * handles routing; explicit per-stage fields in this file OVERRIDE
   * preset fields per OpenRouter's "request-level overrides" rule.
   */
  openrouterPresetSlug?: string;
  /**
   * Optional top-level pair declaration. Required for single-game alpha
   * policies that need to assert every leaf's pair matches; carried
   * through so the parser can perform that byte-equal check.
   */
  pair: PairPolicyV02Pair;
  stages: PairPolicyV02Stages;
};

// ---------------------------------------------------------------------------
// Stage-name enumeration
// ---------------------------------------------------------------------------

/**
 * Closed list of every leaf path in the policy stage tree. Used for
 * default seed derivation (seed[stage_name]) AND for stage-count
 * derivation (maxPriceUsd default). Adding a new leaf ALSO bumps the
 * leaf count divisor for the per-stage cost cap — a deliberate side
 * effect that keeps the per-process cap stable as the tree widens.
 */
export const PAIR_POLICY_V02_STAGE_LEAF_PATHS = [
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

export type PairPolicyV02StageLeafPath = (typeof PAIR_POLICY_V02_STAGE_LEAF_PATHS)[number];

/**
 * Optional leaf paths (declared as `?` on the stage tree). Currently
 * limited to `translation.regrade`, the optional regrade pass.
 */
export const PAIR_POLICY_V02_OPTIONAL_STAGE_LEAF_PATHS = ["translation.regrade"] as const;

// ---------------------------------------------------------------------------
// Default derivation
// ---------------------------------------------------------------------------

/**
 * Deterministic seed derivation: `sha256(stagePath)[:8]` parsed as a
 * 32-bit unsigned integer. The bounded-repair loop adds `attempt` to
 * differentiate retries; see ITOTORI-234 implementation plan §3.
 */
export function deriveDefaultSeed(stagePath: string): number {
  const hex = createHash("sha256").update(stagePath).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

/**
 * Per-stage USD cap default: `defaultCostCapUsd / stageCount`. Both
 * inputs are required so callers can wire the canonical ITOTORI-231
 * cap (0.5 USD) from `apps/itotori/src/providers/openrouter.ts` without
 * importing it into the schema package (avoids a circular dep — the
 * schema package is upstream of itotori app code).
 */
export function deriveDefaultMaxPriceUsd(defaultCostCapUsd: number, stageCount: number): number {
  if (stageCount <= 0) {
    throw new Error(
      `pair-policy.v0.2: stageCount must be > 0 to derive a default maxPriceUsd (got ${stageCount})`,
    );
  }
  if (defaultCostCapUsd < 0) {
    throw new Error(`pair-policy.v0.2: defaultCostCapUsd must be >= 0 (got ${defaultCostCapUsd})`);
  }
  return defaultCostCapUsd / stageCount;
}

/**
 * Parse the `OPENROUTER_ZDR_DOWNGRADE` env-var value into the set of
 * stage paths the operator has approved for a `zdr: false` posture.
 * Format: comma- or whitespace-separated `stage.agent` paths. Empty /
 * undefined → empty set (no downgrades approved).
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
 * Raised when a file's `schemaVersion` field is a known legacy value
 * (or absent). The error carries the observed value + the expected
 * value so the operator can grep for the precise mismatch.
 */
export class PairPolicyVersionMismatchError extends Error {
  constructor(
    public readonly observed: string | undefined,
    public readonly expected: PairPolicySchemaVersion,
  ) {
    super(
      `pair-policy refused: schemaVersion mismatch — observed=${
        observed === undefined ? "<absent>" : `'${observed}'`
      }, expected='${expected}'. v0.1 files are no longer accepted (no-legacy-compat); rewrite the file to the v0.2 shape.`,
    );
    this.name = "PairPolicyVersionMismatchError";
  }
}

/**
 * Raised on every other structural failure (missing field, wrong
 * type, malformed leaf, zdr downgrade not approved by env, etc.).
 * A single typed surface keeps the parser's error contract narrow.
 */
export class PairPolicyV02ValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail: string,
  ) {
    super(`pair-policy.v0.2 refused at ${path}: ${detail}`);
    this.name = "PairPolicyV02ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Inputs the parser needs from its caller. Both are passed in (not
 * imported) so the schema package never reaches into itotori app code.
 *
 *   - `defaultCostCapUsd` — canonical per-process USD cap; the
 *     ITOTORI-231 constant `DEFAULT_COST_CAP_USD` (0.5 USD) at the time
 *     of writing.
 *   - `zdrDowngradeEnv` — the OPENROUTER_ZDR_DOWNGRADE env-var value
 *     (or undefined). The parser uses this to authorize per-stage
 *     `zdr: false` postures.
 */
export type PairPolicyV02ParseOptions = {
  defaultCostCapUsd: number;
  zdrDowngradeEnv: string | undefined;
};

/**
 * Parse a raw JSON value as a v0.2 pair-policy. Returns a fully
 * resolved `PairPolicyV02` — every leaf has its defaults filled in.
 *
 * Throws:
 *   - `PairPolicyVersionMismatchError` if `schemaVersion` is a known
 *     legacy literal or absent.
 *   - `PairPolicyV02ValidationError` on any other structural failure.
 */
export function parsePairPolicyV02(
  value: unknown,
  options: PairPolicyV02ParseOptions,
): PairPolicyV02 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairPolicyV02ValidationError("", "must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  // -- schemaVersion gate (no-legacy-compat) --
  const observedVersionRaw = record.schemaVersion;
  const observedVersion = typeof observedVersionRaw === "string" ? observedVersionRaw : undefined;
  if (observedVersion !== PAIR_POLICY_SCHEMA_VERSION) {
    if (
      observedVersion === undefined ||
      KNOWN_LEGACY_PAIR_POLICY_VERSIONS.includes(observedVersion) ||
      // Anything else also gets a mismatch error — the only accepted
      // value is the literal v0.2 string. A future v0.3 will land its
      // own forcing function in the same way.
      true
    ) {
      throw new PairPolicyVersionMismatchError(observedVersion, PAIR_POLICY_SCHEMA_VERSION);
    }
  }

  const policyId = expectNonEmptyString(record, "policyId");
  const enUsSentinel = expectNonEmptyString(record, "enUsSentinel");
  const sceneId = expectNonNegativeInteger(record, "sceneId");
  const pair = expectPair(record, "pair");
  const openrouterPresetSlug = expectOptionalNonEmptyString(record, "openrouterPresetSlug");

  const stagesRaw = record.stages;
  if (typeof stagesRaw !== "object" || stagesRaw === null || Array.isArray(stagesRaw)) {
    throw new PairPolicyV02ValidationError("stages", "must be a JSON object");
  }

  const stageCount = PAIR_POLICY_V02_STAGE_LEAF_PATHS.length;
  const zdrDowngrades = parseZdrDowngradeEnv(options.zdrDowngradeEnv);

  // The stage tree is parsed leaf-by-leaf so every defaulted field is
  // resolved deterministically. We pre-compute the default maxPrice
  // once because it's a constant per file.
  const defaultMaxPriceUsd = deriveDefaultMaxPriceUsd(options.defaultCostCapUsd, stageCount);

  function parseLeaf(
    parentPath: string,
    leafName: string,
    parent: Record<string, unknown>,
  ): StagePostureV02 {
    const leafPath = `${parentPath}.${leafName}`;
    const leafRaw = parent[leafName];
    if (typeof leafRaw !== "object" || leafRaw === null || Array.isArray(leafRaw)) {
      throw new PairPolicyV02ValidationError(`stages.${leafPath}`, "must be a JSON object");
    }
    const leaf = leafRaw as Record<string, unknown>;
    const leafPair = expectPair(leaf, "pair", `stages.${leafPath}`);

    // ---- zdr (default true) ----
    let zdr = true;
    if ("zdr" in leaf) {
      if (typeof leaf.zdr !== "boolean") {
        throw new PairPolicyV02ValidationError(
          `stages.${leafPath}.zdr`,
          "must be a boolean when present",
        );
      }
      zdr = leaf.zdr;
    }
    if (zdr === false && !zdrDowngrades.has(leafPath)) {
      throw new PairPolicyV02ValidationError(
        `stages.${leafPath}.zdr`,
        `set to false without OPENROUTER_ZDR_DOWNGRADE='${leafPath}' (or a list containing '${leafPath}'); operator-level posture downgrade required`,
      );
    }

    // ---- fallbackModels (default []) ----
    let fallbackModels: string[] = [];
    if ("fallbackModels" in leaf) {
      const rawList = leaf.fallbackModels;
      if (!Array.isArray(rawList)) {
        throw new PairPolicyV02ValidationError(
          `stages.${leafPath}.fallbackModels`,
          "must be an array of strings when present",
        );
      }
      fallbackModels = rawList.map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new PairPolicyV02ValidationError(
            `stages.${leafPath}.fallbackModels[${index}]`,
            "each entry must be a non-empty string",
          );
        }
        return entry;
      });
    }

    // ---- seed (default = sha256(leafPath)[:8]) ----
    let seed = deriveDefaultSeed(leafPath);
    if ("seed" in leaf) {
      const rawSeed = leaf.seed;
      if (typeof rawSeed !== "number" || !Number.isInteger(rawSeed) || rawSeed < 0) {
        throw new PairPolicyV02ValidationError(
          `stages.${leafPath}.seed`,
          "must be a non-negative integer when present",
        );
      }
      seed = rawSeed;
    }

    // ---- maxPriceUsd (default = defaultCostCapUsd / stageCount) ----
    let maxPriceUsd = defaultMaxPriceUsd;
    if ("maxPriceUsd" in leaf) {
      const rawCap = leaf.maxPriceUsd;
      if (typeof rawCap !== "number" || !Number.isFinite(rawCap) || rawCap < 0) {
        throw new PairPolicyV02ValidationError(
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
      throw new PairPolicyV02ValidationError(`stages.${name}`, "must be a JSON object");
    }
    return raw as Record<string, unknown>;
  }

  const contextGroup = expectStageGroup("context");
  const preTranslationGroup = expectStageGroup("preTranslation");
  const translationGroup = expectStageGroup("translation");
  const qaGroup = expectStageGroup("qa");
  const repairGroup = expectStageGroup("repair");

  const stages: PairPolicyV02Stages = {
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

  const parsed: PairPolicyV02 = {
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
 * Flatten a parsed v0.2 policy's stage tree into an ordered list of
 * `(leafPath, posture)` tuples. Order matches
 * `PAIR_POLICY_V02_STAGE_LEAF_PATHS`. The optional regrade leaf, if
 * present, follows `translation.primary`.
 */
export function flattenPairPolicyV02Postures(
  policy: PairPolicyV02,
): ReadonlyArray<{ leafPath: string; posture: StagePostureV02 }> {
  const out: Array<{ leafPath: string; posture: StagePostureV02 }> = [
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
    throw new PairPolicyV02ValidationError(key, "must be a string");
  }
  if (value.length === 0) {
    throw new PairPolicyV02ValidationError(key, "must be a non-empty string");
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
    throw new PairPolicyV02ValidationError(key, "must be a non-empty string when present");
  }
  return value;
}

function expectNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new PairPolicyV02ValidationError(key, "must be a finite integer");
  }
  if (value < 0) {
    throw new PairPolicyV02ValidationError(key, "must be a non-negative integer");
  }
  return value;
}

function expectPair(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): PairPolicyV02Pair {
  const value = record[key];
  const errPath = parentPath !== undefined ? `${parentPath}.${key}` : key;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairPolicyV02ValidationError(errPath, "must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const modelId = obj.modelId;
  const providerId = obj.providerId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new PairPolicyV02ValidationError(`${errPath}.modelId`, "must be a non-empty string");
  }
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new PairPolicyV02ValidationError(`${errPath}.providerId`, "must be a non-empty string");
  }
  return { modelId, providerId };
}
