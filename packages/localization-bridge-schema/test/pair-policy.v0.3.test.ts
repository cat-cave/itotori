// ITOTORI-238 — v0.3 pair-policy schema unit tests.
//
// Scope:
//   - Happy path: minimal v0.3 file resolves with canonical defaults,
//     including alternateProviders=[] and
//     failoverPredicate='http_429_from_primary'.
//   - Version mismatch: v0.1 / v0.2 / absent / wrong schemaVersion ->
//     typed PairPolicyVersionMismatchError.
//   - alternateProviders parsing:
//       * default [] when absent.
//       * each entry requires modelId + providerId + capabilitySheet.
//       * a duplicate alternate raises a validation error.
//       * an alternate byte-equal to the primary raises a validation
//         error (failover would loop on the same upstream).
//       * an alternate whose capabilitySheet declares
//         supportsStructuredOutputJsonSchema=false is REFUSED at parse
//         time (the QA stages mandate structured outputs).
//       * evidenceRef must be a non-empty string (forcing function for
//         the evidence-validation rule).
//   - failoverPredicate parsing:
//       * default 'http_429_from_primary' when absent.
//       * accepts the literal 'http_429_from_primary'.
//       * REFUSES any unknown literal at parse time (closed sum type).
//   - ZDR posture downgrade: zdr=false requires OPENROUTER_ZDR_DOWNGRADE
//     (preserved verbatim from v0.2).
//   - Seed / maxPriceUsd / fallbackModels defaults are deterministic.
//   - flattenPairPolicyV03Postures iterates leaves in declared order.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILOVER_PREDICATE,
  FAILOVER_PREDICATES,
  PAIR_POLICY_SCHEMA_VERSION,
  PAIR_POLICY_V03_STAGE_LEAF_PATHS,
  PairPolicyV03ValidationError,
  PairPolicyVersionMismatchError,
  deriveDefaultMaxPriceUsd,
  deriveDefaultSeed,
  flattenPairPolicyV03Postures,
  parsePairPolicyV03,
  parseZdrDowngradeEnv,
} from "../src/pair-policy.v0.3.js";

const DEFAULT_COST_CAP_USD = 0.5;

function minimalV03(): Record<string, unknown> {
  const leaf = { pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" } };
  return {
    schemaVersion: PAIR_POLICY_SCHEMA_VERSION,
    policyId: "fixture-policy",
    pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
    enUsSentinel: "FIXTURE-SENTINEL",
    sceneId: 0,
    stages: {
      context: {
        sceneSummary: leaf,
        characterRelationship: leaf,
        terminologyCandidate: leaf,
        routeChoiceMap: leaf,
      },
      preTranslation: { speakerLabel: leaf },
      translation: { primary: leaf },
      qa: {
        styleAdherence: leaf,
        semanticDrift: leaf,
        toneRegister: leaf,
        unresolvedTerminology: leaf,
      },
      repair: { primary: leaf },
    },
  };
}

function validAlternate(): Record<string, unknown> {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    providerId: "deepinfra",
    capabilitySheet: {
      supportsStructuredOutputJsonSchema: true,
      supportsToolUse: true,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      evidenceRef: "docs/openrouter-integration-evidence/2026-06-26-alt-providers.json",
    },
  };
}

describe("parsePairPolicyV03 (happy path)", () => {
  it("resolves canonical defaults on a minimal v0.3 file", () => {
    const parsed = parsePairPolicyV03(minimalV03(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.schemaVersion).toBe(PAIR_POLICY_SCHEMA_VERSION);
    expect(parsed.stages.translation.primary.zdr).toBe(true);
    expect(parsed.stages.translation.primary.fallbackModels).toEqual([]);
    expect(parsed.stages.translation.primary.seed).toBe(deriveDefaultSeed("translation.primary"));
    const stageCount = PAIR_POLICY_V03_STAGE_LEAF_PATHS.length;
    expect(parsed.stages.translation.primary.maxPriceUsd).toBe(
      deriveDefaultMaxPriceUsd(DEFAULT_COST_CAP_USD, stageCount),
    );
    // ITOTORI-238 — defaults: empty alternates list, default predicate.
    expect(parsed.alternateProviders).toEqual([]);
    expect(parsed.failoverPredicate).toBe(DEFAULT_FAILOVER_PREDICATE);
  });
});

describe("parsePairPolicyV03 (version mismatch)", () => {
  it("rejects schemaVersion='0.1' with PairPolicyVersionMismatchError", () => {
    const raw = minimalV03();
    raw.schemaVersion = "0.1";
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects schemaVersion='itotori.pair-policy.v0.1' with PairPolicyVersionMismatchError", () => {
    const raw = minimalV03();
    raw.schemaVersion = "itotori.pair-policy.v0.1";
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects schemaVersion='0.2' with PairPolicyVersionMismatchError (ITOTORI-238 no-legacy-compat)", () => {
    const raw = minimalV03();
    raw.schemaVersion = "0.2";
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects schemaVersion='itotori.pair-policy.v0.2' with PairPolicyVersionMismatchError (ITOTORI-238 no-legacy-compat)", () => {
    const raw = minimalV03();
    raw.schemaVersion = "itotori.pair-policy.v0.2";
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects absent schemaVersion with PairPolicyVersionMismatchError", () => {
    const raw = minimalV03();
    delete raw.schemaVersion;
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });
});

describe("parsePairPolicyV03 (alternateProviders)", () => {
  it("accepts a single valid alternate", () => {
    const raw = minimalV03();
    raw.alternateProviders = [validAlternate()];
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.alternateProviders).toHaveLength(1);
    const alt = parsed.alternateProviders[0];
    expect(alt?.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(alt?.providerId).toBe("deepinfra");
    expect(alt?.capabilitySheet.supportsStructuredOutputJsonSchema).toBe(true);
    expect(alt?.capabilitySheet.contextWindowTokens).toBe(128000);
    expect(alt?.capabilitySheet.evidenceRef.length).toBeGreaterThan(0);
  });

  it("defaults to [] when alternateProviders is absent", () => {
    const parsed = parsePairPolicyV03(minimalV03(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.alternateProviders).toEqual([]);
  });

  it("rejects alternateProviders that is not an array", () => {
    const raw = minimalV03();
    raw.alternateProviders = "not an array" as unknown as Array<Record<string, unknown>>;
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("rejects a duplicate alternate (same modelId + providerId twice)", () => {
    const raw = minimalV03();
    raw.alternateProviders = [validAlternate(), validAlternate()];
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("rejects an alternate that byte-equals the primary pair", () => {
    const raw = minimalV03();
    const alt = validAlternate();
    alt.providerId = "fireworks"; // matches the primary
    raw.alternateProviders = [alt];
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("rejects an alternate whose capabilitySheet declares supportsStructuredOutputJsonSchema=false", () => {
    const raw = minimalV03();
    const alt = validAlternate();
    (alt.capabilitySheet as Record<string, unknown>).supportsStructuredOutputJsonSchema = false;
    raw.alternateProviders = [alt];
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("rejects an alternate without an evidenceRef", () => {
    const raw = minimalV03();
    const alt = validAlternate();
    (alt.capabilitySheet as Record<string, unknown>).evidenceRef = "";
    raw.alternateProviders = [alt];
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("rejects an alternate with a non-positive contextWindowTokens", () => {
    const raw = minimalV03();
    const alt = validAlternate();
    (alt.capabilitySheet as Record<string, unknown>).contextWindowTokens = 0;
    raw.alternateProviders = [alt];
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });
});

describe("parsePairPolicyV03 (failoverPredicate)", () => {
  it("defaults failoverPredicate to 'http_429_from_primary' when absent", () => {
    const parsed = parsePairPolicyV03(minimalV03(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.failoverPredicate).toBe("http_429_from_primary");
    expect(DEFAULT_FAILOVER_PREDICATE).toBe("http_429_from_primary");
    expect(FAILOVER_PREDICATES).toContain("http_429_from_primary");
  });

  it("accepts an explicit 'http_429_from_primary' literal", () => {
    const raw = minimalV03();
    raw.failoverPredicate = "http_429_from_primary";
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.failoverPredicate).toBe("http_429_from_primary");
  });

  it("REFUSES an unknown failoverPredicate literal at parse time", () => {
    const raw = minimalV03();
    raw.failoverPredicate = "http_5xx_from_primary";
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("REFUSES a non-string failoverPredicate", () => {
    const raw = minimalV03();
    raw.failoverPredicate = 429 as unknown as string;
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });
});

describe("parsePairPolicyV03 (ZDR posture preserved from v0.2)", () => {
  it("refuses a per-stage zdr=false without OPENROUTER_ZDR_DOWNGRADE listing the stage", () => {
    const raw = minimalV03();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      zdr: false,
    };
    expect(() =>
      parsePairPolicyV03(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV03ValidationError);
  });

  it("accepts zdr=false when OPENROUTER_ZDR_DOWNGRADE lists the stage path", () => {
    const raw = minimalV03();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      zdr: false,
    };
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: "translation.primary",
    });
    expect(parsed.stages.translation.primary.zdr).toBe(false);
  });

  it("accepts an explicit seed override at the leaf", () => {
    const raw = minimalV03();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      seed: 42,
    };
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.seed).toBe(42);
  });

  it("accepts an explicit fallbackModels list", () => {
    const raw = minimalV03();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      fallbackModels: ["openai/gpt-5-flash", "anthropic/claude-haiku-5"],
    };
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.fallbackModels).toEqual([
      "openai/gpt-5-flash",
      "anthropic/claude-haiku-5",
    ]);
  });

  it("accepts an explicit maxPriceUsd at the leaf", () => {
    const raw = minimalV03();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      maxPriceUsd: 0.01,
    };
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.maxPriceUsd).toBe(0.01);
  });

  it("threads openrouterPresetSlug through when present", () => {
    const raw = minimalV03();
    raw.openrouterPresetSlug = "alpha-closer-zdr-only";
    const parsed = parsePairPolicyV03(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.openrouterPresetSlug).toBe("alpha-closer-zdr-only");
  });
});

describe("parseZdrDowngradeEnv", () => {
  it("returns an empty set on undefined/empty input", () => {
    expect(parseZdrDowngradeEnv(undefined).size).toBe(0);
    expect(parseZdrDowngradeEnv("").size).toBe(0);
  });

  it("splits on commas and whitespace", () => {
    const set = parseZdrDowngradeEnv(" translation.primary, qa.styleAdherence ");
    expect(set.has("translation.primary")).toBe(true);
    expect(set.has("qa.styleAdherence")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("flattenPairPolicyV03Postures", () => {
  it("iterates every canonical leaf in declared order", () => {
    const parsed = parsePairPolicyV03(minimalV03(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    const leaves = flattenPairPolicyV03Postures(parsed).map((entry) => entry.leafPath);
    expect(leaves).toEqual([...PAIR_POLICY_V03_STAGE_LEAF_PATHS]);
  });
});
