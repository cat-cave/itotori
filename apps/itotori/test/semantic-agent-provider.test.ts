import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCharacterRelationshipProvider } from "../src/agents/character-relationship/cli.js";
import { resolveRouteChoiceMapProvider } from "../src/agents/route-choice-map/cli.js";
import { resolveSceneSummaryProvider } from "../src/agents/scene-summary/cli.js";
import { resolveTerminologyCandidateProvider } from "../src/agents/terminology-candidate/cli.js";
import {
  ALLOW_FAKE_SEMANTIC_AGENT_ENV,
  SemanticAgentFakeProviderNotAllowedError,
  SemanticAgentMissingProviderRunRecorderError,
  SemanticAgentUnsupportedLiveFamilyError,
  type SemanticAgentLiveProviderOptions,
} from "../src/providers/fake.js";
import { AccountZdrAssertionError } from "../src/providers/account-zdr.js";
import type { ModelProvider, ProviderFamily, ProviderRunArtifact } from "../src/providers/types.js";

// A no-op run-scoped recorder stand-in: the resolution seam only needs SOME
// recorder present to prove it no longer defaults to the global scratch dir;
// the recorded-into-the-run-scoped-dir proof lives in the reconciliation test.
function noopRecorder(): { recordProviderRun(a: ProviderRunArtifact): Promise<void> } {
  return { recordProviderRun: async (_a: ProviderRunArtifact) => {} };
}

// itotori-semantic-agents-live-provider-wiring — proves the four semantic-agent
// CLIs (a) NEVER silently produce fake context on a real path, and (b) route
// the `openrouter` family to the REAL, ZDR-gated OpenRouter provider (not a
// stub). Offline this test only exercises the resolution seam: it never issues
// a live call. The live proof (a real ZDR call with cost from usage.cost) lives
// in semantic-agent-live.test.ts, gated on ITOTORI_LIVE_PROVIDER=1.
const RESOLVERS: ReadonlyArray<{
  name: string;
  resolve: (family: ProviderFamily, live?: SemanticAgentLiveProviderOptions) => ModelProvider;
}> = [
  { name: "scene-summary", resolve: resolveSceneSummaryProvider },
  { name: "route-choice-map", resolve: resolveRouteChoiceMapProvider },
  { name: "character-relationship", resolve: resolveCharacterRelationshipProvider },
  { name: "terminology-candidate", resolve: resolveTerminologyCandidateProvider },
];

// Non-fake families that this resolver does NOT wire (they need a recorded
// bundle / a base URL that the resolver does not carry). They must refuse
// loudly rather than substituting a fake.
const UNSUPPORTED_LIVE_FAMILIES: ReadonlyArray<ProviderFamily> = [
  "recorded",
  "local-openai-compatible",
];

describe("semantic-agent provider resolution (no fake context on a real path)", () => {
  let priorAllow: string | undefined;
  let priorZdr: string | undefined;

  beforeEach(() => {
    priorAllow = process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
    delete process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
    // The `openrouter` live path asserts the account-wide ZDR posture FIRST
    // in the OpenRouterModelProvider constructor. Clear it so the openrouter
    // assertion below deterministically hits the ZDR gate (proving the
    // resolver builds the REAL live provider, not a stub) regardless of the
    // ambient environment.
    priorZdr = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
    delete process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
  });

  afterEach(() => {
    if (priorAllow === undefined) {
      delete process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
    } else {
      process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV] = priorAllow;
    }
    if (priorZdr === undefined) {
      delete process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
    } else {
      process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = priorZdr;
    }
  });

  for (const { name, resolve } of RESOLVERS) {
    it(`${name}: 'openrouter' without a run-scoped provider-run recorder fails closed (no global scratch default)`, () => {
      // semantic-agent-cli-provider-run-not-reconciled — the live path REQUIRES
      // a run-scoped provider-run recorder so the run lands in the reconciled
      // telemetry surface. It no longer silently defaults to a global
      // `.tmp/provider-runs` directory the reconciler never reads.
      expect(() => resolve("openrouter")).toThrow(SemanticAgentMissingProviderRunRecorderError);
    });

    it(`${name}: 'openrouter' WITH a run-scoped recorder builds the REAL ZDR-gated live provider (fails closed on ZDR, never a fake)`, () => {
      // With the recorder present, the live path constructs a real
      // OpenRouterModelProvider, whose constructor asserts the account-wide
      // ZDR posture. Without the assertion env var it throws
      // AccountZdrAssertionError — proving the resolver reaches the real live
      // wiring (fail-closed) rather than fabricating context.
      expect(() => resolve("openrouter", { artifactRecorder: noopRecorder() })).toThrow(
        AccountZdrAssertionError,
      );
    });

    for (const family of UNSUPPORTED_LIVE_FAMILIES) {
      it(`${name}: unsupported live family '${family}' fails loudly with a typed error (never a fake)`, () => {
        expect(() => resolve(family)).toThrow(SemanticAgentUnsupportedLiveFamilyError);
        try {
          resolve(family);
          throw new Error("expected resolve to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(SemanticAgentUnsupportedLiveFamilyError);
          expect((error as SemanticAgentUnsupportedLiveFamilyError).family).toBe(family);
        }
      });
    }

    it(`${name}: fake family refuses loudly without the explicit opt-in`, () => {
      expect(process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV] ?? "").toBe("");
      expect(() => resolve("fake")).toThrow(SemanticAgentFakeProviderNotAllowedError);
    });

    it(`${name}: fake family is reachable ONLY behind the explicit opt-in`, () => {
      process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV] = "1";
      const provider = resolve("fake");
      expect(provider.descriptor.family).toBe("fake");
    });
  }
});
