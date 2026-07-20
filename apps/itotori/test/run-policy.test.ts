import { describe, expect, it } from "vitest";
import {
  FULL_ROSTER,
  MODE_PROFILES,
  RunPolicyError,
  ShippableFinalizationError,
  assertMayFinalizeShippable,
  finalizeShippable,
  forceTestDevForNarrowedContext,
  isNarrowedContext,
  isShippablePolicy,
  requiredRunModeForContext,
  resolveRunPolicy,
  type OutputScope,
  type ResolvedRunPolicy,
  type RunPolicyRequest,
} from "../src/run-policy/index.js";

const NARROWED = "narrowed:rin-route" as const;

function productionRequest(overrides: Partial<RunPolicyRequest> = {}): RunPolicyRequest {
  return {
    runMode: "production",
    contextScope: "whole-game",
    outputScope: "all",
    roster: FULL_ROSTER,
    ...overrides,
  };
}

// ── Clause 1: production AND pilot REQUIRE whole-game + full roster + wiki-first;
//    a narrowed / partial / bypassed production or pilot config is REJECTED. ──
describe("clause 1 — production and pilot require the full context stack", () => {
  it("defines the full context roster as exactly A1-A10", () => {
    expect(FULL_ROSTER).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"]);
  });

  it("production rejects narrowed context", () => {
    expect(() => resolveRunPolicy(productionRequest({ contextScope: NARROWED }))).toThrow(
      RunPolicyError,
    );
    // The guarantee: the ONLY way this stops throwing is deleting the whole-game
    // requirement from the production profile — which this asserts is present.
    expect(MODE_PROFILES.production.requiresWholeGameContext).toBe(true);
  });

  it("pilot rejects narrowed context", () => {
    expect(() =>
      resolveRunPolicy(productionRequest({ runMode: "pilot", contextScope: NARROWED })),
    ).toThrow(RunPolicyError);
  });

  it("production rejects a partial roster", () => {
    const partial = FULL_ROSTER.slice(0, 3);
    expect(() => resolveRunPolicy(productionRequest({ roster: partial }))).toThrow(RunPolicyError);
  });

  it("pilot rejects a partial roster", () => {
    const partial = FULL_ROSTER.slice(0, 5);
    expect(() =>
      resolveRunPolicy(productionRequest({ runMode: "pilot", roster: partial })),
    ).toThrow(RunPolicyError);
  });

  it("rejects duplicate or non-context roles instead of accepting an almost-full roster", () => {
    expect(() =>
      resolveRunPolicy(productionRequest({ roster: [...FULL_ROSTER.slice(0, -1), "A1"] })),
    ).toThrow(RunPolicyError);
    expect(() => resolveRunPolicy(productionRequest({ roster: [...FULL_ROSTER, "P1"] }))).toThrow(
      RunPolicyError,
    );
  });

  it("production rejects a bypassed (null-Wiki) bible", () => {
    expect(() => resolveRunPolicy(productionRequest({ ablation: { kind: "pure-mtl" } }))).toThrow(
      RunPolicyError,
    );
  });

  it("pilot rejects a bypassed (null-Wiki) bible", () => {
    expect(() =>
      resolveRunPolicy(productionRequest({ runMode: "pilot", ablation: { kind: "pure-mtl" } })),
    ).toThrow(RunPolicyError);
  });

  it("production and pilot differ only in output scope (same context/roster/bible requirements)", () => {
    const production = MODE_PROFILES.production;
    const pilot = MODE_PROFILES.pilot;
    // Identical on every requirement axis — output scope is the only free axis.
    expect(pilot.requiresWholeGameContext).toBe(production.requiresWholeGameContext);
    expect(pilot.requiresFullRoster).toBe(production.requiresFullRoster);
    expect(pilot.requiresWikiFirstBible).toBe(production.requiresWikiFirstBible);
    expect(pilot.canFinalizeShippable).toBe(production.canFinalizeShippable);
    // Both accept the full stack and both may ship.
    const prod = resolveRunPolicy(productionRequest());
    const pil = resolveRunPolicy(productionRequest({ runMode: "pilot" }));
    expect(prod.shippable).toBe(true);
    expect(pil.shippable).toBe(true);
    expect(prod.bibleBasis).toBe("wiki-first");
    expect(pil.bibleBasis).toBe("wiki-first");
  });

  it("a fully-specified production run resolves and requires the full bible", () => {
    const resolved = resolveRunPolicy(productionRequest());
    expect(resolved.localizationPosture).toBe("production");
    expect(resolved.requiresFullBible).toBe(true);
    expect(resolved.roster).toEqual(FULL_ROSTER);
  });
});

// ── Clause 2: narrowed context FORCES test-dev (visible provenance) + an
//    UNBYPASSABLE shippable-finalization rejection. ──
describe("clause 2 — narrowed context forces test-dev and can never ship", () => {
  it("a narrowed context forces test-dev with visible provenance and shippable=false", () => {
    expect(requiredRunModeForContext(NARROWED)).toBe("test-dev");
    const resolved = forceTestDevForNarrowedContext(productionRequest({ contextScope: NARROWED }));
    expect(resolved.runMode).toBe("test-dev");
    expect(resolved.shippable).toBe(false);
    // Visible provenance — the narrowing is surfaced, not silent.
    expect(resolved.contextProvenance.narrowed).toBe(true);
    expect(resolved.contextProvenance.note).toContain("NARROWED");
  });

  it("shippable finalization is unbypassable in test-dev (even with a forged shippable flag)", () => {
    const testDev = resolveRunPolicy({
      runMode: "test-dev",
      contextScope: NARROWED,
      outputScope: "dialogue-only",
      roster: FULL_ROSTER.slice(0, 2),
    });
    expect(testDev.shippable).toBe(false);
    expect(() => finalizeShippable(testDev, { text: "hi" })).toThrow(ShippableFinalizationError);

    // Forge a policy that LIES about shippability — the gate re-derives the
    // invariant and refuses it anyway. There is no flag around the rejection.
    const forged: ResolvedRunPolicy = { ...testDev, shippable: true };
    expect(isShippablePolicy(forged)).toBe(false);
    expect(() => assertMayFinalizeShippable(forged)).toThrow(ShippableFinalizationError);
    expect(() => finalizeShippable(forged, { text: "hi" })).toThrow(ShippableFinalizationError);
  });

  it("shippable finalization re-checks a forged production roster", () => {
    const production = resolveRunPolicy(productionRequest());
    const forged: ResolvedRunPolicy = {
      ...production,
      roster: production.roster.slice(0, -1),
      shippable: true,
    };
    expect(isShippablePolicy(forged)).toBe(false);
    expect(() => finalizeShippable(forged, { text: "hi" })).toThrow(ShippableFinalizationError);
  });

  it("a production run CAN finalize a shippable artifact (control)", () => {
    const resolved = resolveRunPolicy(productionRequest());
    const shipped = finalizeShippable(resolved, { text: "hi" });
    expect(shipped.shippable).toBe(true);
    expect(shipped.runMode).toBe("production");
  });

  it("forceTestDevForNarrowedContext refuses a non-narrowed context (no escape hatch)", () => {
    expect(() => forceTestDevForNarrowedContext(productionRequest())).toThrow(RunPolicyError);
  });
});

// ── Clause 3: output scope is an INDEPENDENT axis, bounded on its own, and does
//    not relax the context/roster/bible requirements. ──
describe("clause 3 — output scope is an independent, self-bounded axis", () => {
  it("rejects an unknown output scope regardless of mode", () => {
    expect(() =>
      resolveRunPolicy(productionRequest({ outputScope: "everything" as OutputScope })),
    ).toThrow(RunPolicyError);
    expect(() =>
      resolveRunPolicy({
        runMode: "test-dev",
        contextScope: NARROWED,
        outputScope: "everything" as OutputScope,
        roster: FULL_ROSTER,
      }),
    ).toThrow(RunPolicyError);
  });

  it("a narrow output scope does NOT relax the whole-game/roster/bible requirements", () => {
    // dialogue-only output must STILL be rejected under production if context is
    // narrowed — output scope cannot buy a relaxation of context.
    expect(() =>
      resolveRunPolicy(productionRequest({ outputScope: "dialogue-only", contextScope: NARROWED })),
    ).toThrow(RunPolicyError);
    // …and a partial roster is still rejected even with the minimal output scope.
    expect(() =>
      resolveRunPolicy(
        productionRequest({ outputScope: "dialogue-only", roster: FULL_ROSTER.slice(0, 1) }),
      ),
    ).toThrow(RunPolicyError);
  });

  it("every valid output scope resolves under production with the same context requirements", () => {
    const scopes: OutputScope[] = [
      "dialogue-only",
      "dialogue-and-choices",
      "dialogue-choices-ui",
      "all",
    ];
    for (const outputScope of scopes) {
      const resolved = resolveRunPolicy(productionRequest({ outputScope }));
      expect(resolved.outputScope).toBe(outputScope);
      expect(resolved.contextProvenance.coversWholeGame).toBe(true);
      expect(resolved.requiresFullBible).toBe(true);
      expect(resolved.shippable).toBe(true);
    }
  });
});

// ── Clause 4: only the explicit pure-MTL ablation may select null Wiki / direct
//    translation. ──
describe("clause 4 — only the explicit ablation selects the null-Wiki basis", () => {
  it("the ablation selector under test-dev yields the null-Wiki basis and ablation posture", () => {
    const resolved = resolveRunPolicy({
      runMode: "test-dev",
      contextScope: NARROWED,
      outputScope: "dialogue-only",
      roster: FULL_ROSTER,
      ablation: { kind: "pure-mtl" },
    });
    expect(resolved.bibleBasis).toBe("pure-mtl-ablation");
    expect(resolved.localizationPosture).toBe("ablation");
    expect(resolved.ablationBypass).not.toBeNull();
    expect(resolved.requiresFullBible).toBe(false);
    expect(resolved.shippable).toBe(false);
  });

  it("production, pilot, and normal test-dev all resolve to the wiki-first basis", () => {
    expect(resolveRunPolicy(productionRequest()).bibleBasis).toBe("wiki-first");
    expect(resolveRunPolicy(productionRequest({ runMode: "pilot" })).bibleBasis).toBe("wiki-first");
    const normalTestDev = resolveRunPolicy({
      runMode: "test-dev",
      contextScope: NARROWED,
      outputScope: "dialogue-only",
      roster: FULL_ROSTER,
    });
    expect(normalTestDev.bibleBasis).toBe("wiki-first");
    expect(normalTestDev.ablationBypass).toBeNull();
  });

  it("the ablation selector is rejected under production and pilot", () => {
    expect(() => resolveRunPolicy(productionRequest({ ablation: { kind: "pure-mtl" } }))).toThrow(
      RunPolicyError,
    );
    expect(() =>
      resolveRunPolicy(productionRequest({ runMode: "pilot", ablation: { kind: "pure-mtl" } })),
    ).toThrow(RunPolicyError);
  });

  it("an unknown ablation selector is rejected", () => {
    expect(() =>
      resolveRunPolicy({
        runMode: "test-dev",
        contextScope: NARROWED,
        outputScope: "dialogue-only",
        roster: FULL_ROSTER,
        ablation: { kind: "bogus" } as never,
      }),
    ).toThrow(RunPolicyError);
  });
});

describe("context helpers", () => {
  it("classifies narrowed vs whole-game-covering scopes", () => {
    expect(isNarrowedContext(NARROWED)).toBe(true);
    expect(isNarrowedContext("whole-game")).toBe(false);
    expect(isNarrowedContext("external-augmented")).toBe(false);
  });
});
