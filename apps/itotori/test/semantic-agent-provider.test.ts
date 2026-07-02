import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCharacterRelationshipProvider } from "../src/agents/character-relationship/cli.js";
import { resolveRouteChoiceMapProvider } from "../src/agents/route-choice-map/cli.js";
import { resolveSceneSummaryProvider } from "../src/agents/scene-summary/cli.js";
import { resolveTerminologyCandidateProvider } from "../src/agents/terminology-candidate/cli.js";
import {
  ALLOW_FAKE_SEMANTIC_AGENT_ENV,
  SemanticAgentFakeProviderNotAllowedError,
  SemanticAgentLiveProviderNotImplementedError,
} from "../src/providers/fake.js";
import type { ModelProvider, ProviderFamily } from "../src/providers/types.js";

// itotori-semantic-agent-clis-no-fake-context-on-real-path — proves the four
// semantic-agent CLIs NEVER silently produce fake context on a real path:
// a live provider family loud-refuses with a typed error, and the fake
// provider is reachable ONLY behind the explicit env opt-in.
const RESOLVERS: ReadonlyArray<{
  name: string;
  resolve: (family: ProviderFamily) => ModelProvider;
}> = [
  { name: "scene-summary", resolve: resolveSceneSummaryProvider },
  { name: "route-choice-map", resolve: resolveRouteChoiceMapProvider },
  { name: "character-relationship", resolve: resolveCharacterRelationshipProvider },
  { name: "terminology-candidate", resolve: resolveTerminologyCandidateProvider },
];

const LIVE_FAMILIES: ReadonlyArray<ProviderFamily> = [
  "openrouter",
  "recorded",
  "local-openai-compatible",
];

describe("semantic-agent provider resolution (no fake context on a real path)", () => {
  let priorAllow: string | undefined;

  beforeEach(() => {
    priorAllow = process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
    delete process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
  });

  afterEach(() => {
    if (priorAllow === undefined) {
      delete process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV];
    } else {
      process.env[ALLOW_FAKE_SEMANTIC_AGENT_ENV] = priorAllow;
    }
  });

  for (const { name, resolve } of RESOLVERS) {
    for (const family of LIVE_FAMILIES) {
      it(`${name}: live family '${family}' fails loudly with a typed error (never a fake)`, () => {
        expect(() => resolve(family)).toThrow(SemanticAgentLiveProviderNotImplementedError);
        try {
          resolve(family);
          throw new Error("expected resolve to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(SemanticAgentLiveProviderNotImplementedError);
          expect((error as SemanticAgentLiveProviderNotImplementedError).family).toBe(family);
          expect((error as Error).message).toContain("not implemented");
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
