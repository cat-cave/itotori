// itotori-live-loop-style-glossary-injection — the live agentic loop now seeds
// the ACTIVE style-guide policy + glossary into BOTH the translation stage and
// the QA terminology lane (the old `styleGuide: []` is gone). These proofs are
// deterministic (FakeModelProvider), run in CI, and mirror the real-context
// stage test's capturing-fake harness.
//
// Proven here:
//   1. With an active glossary term + an active style guide, the translation
//      prompt AND every QA prompt carry the glossary line and the style-guide
//      rule (non-empty) — the styleGuide:[] replacement reaches the wire.
//   2. A draft that maps the glossary term to its target is ACCEPTED (glossary
//      respected).
//   3. A draft that mistranslates the glossary target is FLAGGED by the
//      deterministic glossary check (capitalization_drift → P0 short-circuit →
//      deferred_to_human).
//   4. With NO active glossary / style guide the loop degrades gracefully:
//      prompts render `(empty)` and the loop still completes with a draft.

import { describe, expect, it } from "vitest";
import type { AuthorizationActor } from "@itotori/db";
import type {
  LocalizationUnitV02,
  StyleGuidePolicyV0Draft,
} from "@itotori/localization-bridge-schema";
import { STYLE_GUIDE_POLICY_SCHEMA_VERSION } from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import type { DraftSourceProtectedSpan } from "../src/draft/protected-span-validator.js";
import type { TranslationGlossaryEntry } from "../src/agents/translation/shapes.js";

const ACTOR: AuthorizationActor = { userId: "itotori-styleglossary-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-1000-7000-8000-00000000sg01";
const REVISION_ID = "019ed079-1000-7000-8000-00000000sg03";
const ASSET_ID = "019ed079-1000-7000-8000-00000000sg04";
const TERM_ID = "019ed079-1000-7000-8000-00000000sg09";

const SOURCE_TEXT = "ステラが笑った。";
const GLOSSARY_SOURCE = "ステラ";
const GLOSSARY_TARGET = "Stella";

function makeUnit(): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "narration",
    sourceUnitKey: "scene-1/line-000",
    occurrenceId: "occ-sg-000",
    sourceLocale: "ja-JP",
    sourceText: SOURCE_TEXT,
    sourceHash: "src-hash-styleglossary",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "sg-rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "sg-asset" },
    sourceLocation: { containerKey: "sg-asset" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-1/line-000",
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "sg-rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeGlossary(): TranslationGlossaryEntry[] {
  return [
    {
      termId: TERM_ID,
      preferredSourceForm: GLOSSARY_SOURCE,
      preferredTargetForm: GLOSSARY_TARGET,
      policyAction: "localize",
    },
  ];
}

function makeStyleGuide(): StyleGuidePolicyV0Draft {
  return {
    schemaVersion: STYLE_GUIDE_POLICY_SCHEMA_VERSION,
    sections: {
      tone: [
        {
          ruleId: "tone-warm-direct",
          guidance: "Keep narration warm and direct; avoid slang.",
        },
      ],
      terminology: [],
      honorifics: [],
      formatting: [],
      protectedSpans: [],
    },
  };
}

function glossarySpan(): DraftSourceProtectedSpan {
  return {
    refId: "glossary-stella",
    sourceText: GLOSSARY_SOURCE,
    spanKind: "glossary",
    expectedTargetForm: GLOSSARY_TARGET,
  };
}

function makePolicy(): AgenticLoopPolicy {
  let tick = 0;
  return {
    projectId: "019ed079-1000-7000-8000-00000000sg10",
    localeBranchId: "019ed079-1000-7000-8000-00000000sg11",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: () => {
      const d = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
      d.setUTCSeconds(tick);
      tick += 1;
      return d;
    },
  };
}

function speakerLabel(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "sg-fixture",
      },
    ],
  });
}

function translation(unit: LocalizationUnitV02, draftText: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-translation-draft-output.v1",
    drafts: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        sourceLocale: unit.sourceLocale,
        targetLocale: "en-US",
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "sg-fixture-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

type Captured = { translation: string[]; qa: string[] };

/**
 * Capturing fake factory. Records every translation + QA user prompt so the
 * test can assert the injected glossary + style-guide, and returns the given
 * draft body for the translation stage.
 */
function capturingFactory(
  unit: LocalizationUnitV02,
  draftText: string,
  captured: Captured,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `sg-fake:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabel(unit);
        }
        if (request.taskKind === "experiment") {
          switch (agentLabel) {
            case "scene-summary":
              return "Synthetic scene summary.";
            case "character-relationship":
              return JSON.stringify({ bios: [], relationships: [] });
            case "terminology-candidate":
              return JSON.stringify({ candidates: [] });
            case "route-choice-map":
              return JSON.stringify({ routes: [], choices: [] });
            default:
              return "";
          }
        }
        if (request.taskKind === "draft_translation") {
          const user = request.messages?.find((m) => m.role === "user");
          if (user !== undefined) {
            captured.translation.push(user.content);
          }
          return translation(unit, draftText);
        }
        if (request.taskKind === "llm_qa") {
          const user = request.messages?.find((m) => m.role === "user");
          if (user !== undefined) {
            captured.qa.push(user.content);
          }
          return JSON.stringify({
            schemaVersion: "itotori.structured-qa-finding-output.v1",
            findings: [],
          });
        }
        return "";
      },
    });
}

describe("itotori-live-loop-style-glossary-injection", () => {
  it("seeds the active glossary + style guide into the translation AND QA prompts and accepts a glossary-respecting draft", async () => {
    const unit = makeUnit();
    const captured: Captured = { translation: [], qa: [] };
    const input: AgenticLoopUnitInput = {
      unit,
      sceneUnits: [],
      glossary: makeGlossary(),
      styleGuide: makeStyleGuide(),
      protectedSpans: [glossarySpan()],
      knownCharacters: [],
      actor: ACTOR,
    };

    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      // Draft MAPS the glossary term to its target — glossary respected.
      capturingFactory(unit, `${GLOSSARY_TARGET} smiled.`, captured),
    );

    // (1) The translation prompt carries the glossary line + the style rule.
    expect(captured.translation.length).toBeGreaterThan(0);
    const tprompt = captured.translation[0] ?? "";
    expect(tprompt).toContain(`${GLOSSARY_SOURCE} -> ${GLOSSARY_TARGET}`);
    expect(tprompt).toContain("Style guide:");
    expect(tprompt).toContain("[tone] (tone-warm-direct)");
    expect(tprompt).not.toContain("Style guide: (empty)");

    // (1) Every QA lane's prompt carries the SAME glossary + style rule.
    expect(captured.qa.length).toBe(4);
    for (const qprompt of captured.qa) {
      expect(qprompt).toContain(`${GLOSSARY_SOURCE} -> ${GLOSSARY_TARGET}`);
      expect(qprompt).toContain("[tone] (tone-warm-direct)");
    }

    // (2) The glossary-respecting draft is accepted with its target form.
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe(`${GLOSSARY_TARGET} smiled.`);
  });

  it("flags a draft that mistranslates the glossary target (deterministic glossary check → deferred)", async () => {
    const unit = makeUnit();
    const captured: Captured = { translation: [], qa: [] };
    const input: AgenticLoopUnitInput = {
      unit,
      sceneUnits: [],
      glossary: makeGlossary(),
      styleGuide: makeStyleGuide(),
      protectedSpans: [glossarySpan()],
      knownCharacters: [],
      actor: ACTOR,
    };

    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      // Draft violates the glossary target's capitalization ("stella" != "Stella").
      capturingFactory(unit, "stella smiled.", captured),
    );

    // The deterministic glossary check fired a P0 (capitalization_drift) and the
    // loop deferred to a human rather than accepting the violating draft.
    expect(bundle.routingSummary.outcome).toBe("short_circuit_deterministic_p0");
    expect(bundle.finalDraft.draftText).toBeUndefined();
    expect(bundle.finalDraft.deferredReason).toContain("capitalization_drift");
  });

  it("degrades gracefully with no active glossary or style guide (empty, not broken)", async () => {
    const unit = makeUnit();
    const captured: Captured = { translation: [], qa: [] };
    const input: AgenticLoopUnitInput = {
      unit,
      sceneUnits: [],
      glossary: [],
      protectedSpans: [],
      knownCharacters: [],
      actor: ACTOR,
    };

    const bundle = await runAgenticLoopForUnit(
      input,
      DEV_POLICY,
      makePolicy(),
      capturingFactory(unit, "Someone smiled.", captured),
    );

    const tprompt = captured.translation[0] ?? "";
    expect(tprompt).toContain("Glossary: (empty)");
    expect(tprompt).toContain("Style guide: (empty)");
    // Still completes end-to-end with a real draft.
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe("Someone smiled.");
  });
});
