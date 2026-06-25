// ITOTORI-234 — v0.2 pair-policy schema unit tests.
//
// Scope:
//   - Happy path: minimal v0.2 file resolves with canonical defaults.
//   - Version mismatch: v0.1 / absent / wrong schemaVersion -> typed
//     PairPolicyVersionMismatchError.
//   - ZDR posture downgrade: zdr=false requires OPENROUTER_ZDR_DOWNGRADE
//     to list the stage path, else a typed validation error.
//   - Seed / maxPriceUsd / fallbackModels defaults are deterministic.
//   - flattenPairPolicyV02Postures iterates leaves in declared order.

import { describe, expect, it } from "vitest";
import {
  PAIR_POLICY_SCHEMA_VERSION,
  PAIR_POLICY_V02_STAGE_LEAF_PATHS,
  PairPolicyV02ValidationError,
  PairPolicyVersionMismatchError,
  deriveDefaultMaxPriceUsd,
  deriveDefaultSeed,
  flattenPairPolicyV02Postures,
  parsePairPolicyV02,
  parseZdrDowngradeEnv,
} from "../src/pair-policy.v0.2.js";

const DEFAULT_COST_CAP_USD = 0.5;

function minimalV02(): Record<string, unknown> {
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

describe("parsePairPolicyV02", () => {
  it("resolves canonical defaults on a minimal v0.2 file", () => {
    const parsed = parsePairPolicyV02(minimalV02(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.schemaVersion).toBe(PAIR_POLICY_SCHEMA_VERSION);
    expect(parsed.stages.translation.primary.zdr).toBe(true);
    expect(parsed.stages.translation.primary.fallbackModels).toEqual([]);
    expect(parsed.stages.translation.primary.seed).toBe(deriveDefaultSeed("translation.primary"));
    const stageCount = PAIR_POLICY_V02_STAGE_LEAF_PATHS.length;
    expect(parsed.stages.translation.primary.maxPriceUsd).toBe(
      deriveDefaultMaxPriceUsd(DEFAULT_COST_CAP_USD, stageCount),
    );
  });

  it("rejects schemaVersion='0.1' with PairPolicyVersionMismatchError", () => {
    const raw = minimalV02();
    raw.schemaVersion = "0.1";
    expect(() =>
      parsePairPolicyV02(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects schemaVersion='itotori.pair-policy.v0.1' with PairPolicyVersionMismatchError", () => {
    const raw = minimalV02();
    raw.schemaVersion = "itotori.pair-policy.v0.1";
    expect(() =>
      parsePairPolicyV02(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("rejects absent schemaVersion with PairPolicyVersionMismatchError", () => {
    const raw = minimalV02();
    delete raw.schemaVersion;
    expect(() =>
      parsePairPolicyV02(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyVersionMismatchError);
  });

  it("refuses a per-stage zdr=false without OPENROUTER_ZDR_DOWNGRADE listing the stage", () => {
    const raw = minimalV02();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      zdr: false,
    };
    expect(() =>
      parsePairPolicyV02(raw, {
        defaultCostCapUsd: DEFAULT_COST_CAP_USD,
        zdrDowngradeEnv: undefined,
      }),
    ).toThrow(PairPolicyV02ValidationError);
  });

  it("accepts zdr=false when OPENROUTER_ZDR_DOWNGRADE lists the stage path", () => {
    const raw = minimalV02();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      zdr: false,
    };
    const parsed = parsePairPolicyV02(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: "translation.primary",
    });
    expect(parsed.stages.translation.primary.zdr).toBe(false);
  });

  it("accepts an explicit seed override at the leaf", () => {
    const raw = minimalV02();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      seed: 42,
    };
    const parsed = parsePairPolicyV02(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.seed).toBe(42);
  });

  it("accepts an explicit fallbackModels list", () => {
    const raw = minimalV02();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      fallbackModels: ["openai/gpt-5-flash", "anthropic/claude-haiku-5"],
    };
    const parsed = parsePairPolicyV02(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.fallbackModels).toEqual([
      "openai/gpt-5-flash",
      "anthropic/claude-haiku-5",
    ]);
  });

  it("accepts an explicit maxPriceUsd at the leaf", () => {
    const raw = minimalV02();
    const stages = raw.stages as Record<string, Record<string, Record<string, unknown>>>;
    stages.translation.primary = {
      pair: { modelId: "deepseek/deepseek-v4-flash", providerId: "fireworks" },
      maxPriceUsd: 0.01,
    };
    const parsed = parsePairPolicyV02(raw, {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    expect(parsed.stages.translation.primary.maxPriceUsd).toBe(0.01);
  });

  it("threads openrouterPresetSlug through when present", () => {
    const raw = minimalV02();
    raw.openrouterPresetSlug = "alpha-closer-zdr-only";
    const parsed = parsePairPolicyV02(raw, {
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

describe("flattenPairPolicyV02Postures", () => {
  it("iterates every canonical leaf in declared order", () => {
    const parsed = parsePairPolicyV02(minimalV02(), {
      defaultCostCapUsd: DEFAULT_COST_CAP_USD,
      zdrDowngradeEnv: undefined,
    });
    const leaves = flattenPairPolicyV02Postures(parsed).map((entry) => entry.leafPath);
    expect(leaves).toEqual([...PAIR_POLICY_V02_STAGE_LEAF_PATHS]);
  });
});
