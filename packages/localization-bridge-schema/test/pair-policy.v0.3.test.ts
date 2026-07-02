// v0.3 pair-policy schema unit tests.
//
// Scope:
//   - Happy path: minimal v0.3 file resolves with canonical defaults.
//   - Version mismatch: v0.1 / v0.2 / absent / wrong schemaVersion ->
//     typed PairPolicyVersionMismatchError.
//   - ZDR posture downgrade: zdr=false requires OPENROUTER_ZDR_DOWNGRADE
//     (preserved verbatim from v0.2).
//   - Seed / maxPriceUsd / fallbackModels defaults are deterministic.
//   - flattenPairPolicyV03Postures iterates leaves in declared order.
//
// There is no app-level alternate/failover plumbing in v0.3: resilience
// is OpenRouter-side (provider.order + allow_fallbacks within the ZDR
// allow-list), so the schema carries only the single primary pair.

import { describe, expect, it } from "vitest";
import {
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
