// ITOTORI-222 — Full agentic-loop orchestrator tests.
//
// Exercises `runAgenticLoopForUnit` end-to-end on a single bridge
// unit with a FakeModelProvider routed through every stage. The
// FakeModelProvider returns structurally-correct content (verbatim
// JSON for QA / translation / speaker-label stages) so the loop
// reaches each downstream stage without faking provider records.
//
// The suite asserts:
//   1. Happy path: every stage appears in bundle.stages, every
//      invocation declares an explicit (modelId, providerId) pair.
//   2. Deterministic-check P0 short-circuit: QA stage records ZERO
//      invocations and the loop ends with `deferred_to_human`.
//   3. Repair cap: a synthetic finding that would normally repair
//      defers when `maxRepairAttempts=0`.
//   4. Round-trip: bundle serializes + reparses byte-equal via the
//      schema package asserter.
//   5. Pair-policy completeness: missing entries throw a typed
//      `PairPolicyMissingEntryError`.

import { describe, expect, it } from "vitest";
import {
  AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION,
  AGENTIC_LOOP_STAGE_NAMES,
  assertAgenticLoopBundle,
  parseAgenticLoopBundle,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  PairPolicyMissingEntryError,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest, ModelProvider } from "../src/providers/types.js";
import type { AuthorizationActor } from "@itotori/db";

const ACTOR: AuthorizationActor = { userId: "itotori-222-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-00000000ac01";
const PROJECT_ID = "019ed079-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000000002";
const REVISION_ID = "019ed079-0000-7000-8000-000000000003";
const ASSET_ID = "019ed079-0000-7000-8000-000000000004";

const SOURCE_TEXT = "こんにちは、{player}。";
const DRAFT_TEXT = "Hello, {player}.";

function makeUnit(): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: "scene-001/line-001",
    occurrenceId: "occ-001",
    sourceLocale: "ja-JP",
    sourceText: SOURCE_TEXT,
    sourceHash: "src-hash-fixture-222",
    sourceRevision: {
      revisionId: REVISION_ID,
      revisionKind: "content_hash",
      value: "fixture-rev",
    },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "fixture-asset" },
    sourceLocation: { containerKey: "fixture-asset" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-001/line-001",
      sourceRevision: {
        revisionId: REVISION_ID,
        revisionKind: "content_hash",
        value: "fixture-rev",
      },
    },
    runtimeExpectation: {
      expectationKind: "metadata_only",
    },
  };
}

function makeInput(): AgenticLoopUnitInput {
  return {
    unit: makeUnit(),
    sceneUnits: [],
    glossary: [
      {
        termId: "019ed079-0000-7000-8000-00000000gl01",
        preferredSourceForm: "{player}",
        policyAction: "do_not_translate",
      },
    ],
    protectedSpans: [
      {
        refId: "span-variable-player",
        sourceText: "{player}",
        spanKind: "variable",
      },
    ],
    knownCharacters: [],
    actor: ACTOR,
  };
}

function makePolicy(overrides: Partial<AgenticLoopPolicy> = {}): AgenticLoopPolicy {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: deterministicClock(),
    ...overrides,
  };
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

// --- Fake content generators ------------------------------------------

type StageRole =
  | "context"
  | "speaker-label"
  | "translation-success"
  | "translation-with-glossary-mistranslation"
  | "qa-clean"
  | "qa-with-mistranslation";

function makeSpeakerLabelContent(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fixture-narration",
      },
    ],
  });
}

function makeTranslationContent(args: {
  unit: LocalizationUnitV02;
  draftText: string;
  spanStart: number;
  spanEnd: number;
}): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: args.unit.bridgeUnitId,
        sourceLocale: args.unit.sourceLocale,
        targetLocale: "en-US",
        draftText: args.draftText,
        protectedSpanRefs: [
          {
            refId: "span-variable-player",
            startInDraft: args.spanStart,
            endInDraft: args.spanEnd,
          },
        ],
        citationRefs: ["019ed079-0000-7000-8000-00000000gl01"],
        agentRationale: "fixture-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function makeQaContent(findings: ReadonlyArray<QaFinding>): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings,
  });
}

function happyPathProviderFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) => {
    return new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabelContent(makeUnit());
        }
        if (request.taskKind === "experiment") {
          // Context probes — no schema requirements.
          return `context-probe:${agentLabel}`;
        }
        if (request.taskKind === "draft_translation") {
          return makeTranslationContent({
            unit: makeUnit(),
            draftText: DRAFT_TEXT,
            spanStart: 7,
            spanEnd: 15,
          });
        }
        if (request.taskKind === "llm_qa") {
          return makeQaContent([]);
        }
        return "";
      },
    });
  };
}

function findingsProviderFactory(args: {
  qaFinding: QaFinding;
  repairDraftText: string;
  repairSpanStart: number;
  repairSpanEnd: number;
}): AgenticLoopProviderFactory {
  let qaCallCount = 0;
  let translationCallCount = 0;
  return ({ stage, agentLabel }) => {
    return new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabelContent(makeUnit());
        }
        if (request.taskKind === "experiment") {
          return `context-probe:${agentLabel}`;
        }
        if (request.taskKind === "draft_translation") {
          translationCallCount += 1;
          if (translationCallCount === 1) {
            // Primary translation — clean shape.
            return makeTranslationContent({
              unit: makeUnit(),
              draftText: DRAFT_TEXT,
              spanStart: 7,
              spanEnd: 15,
            });
          }
          // Repair attempt — emit a different draft text.
          return makeTranslationContent({
            unit: makeUnit(),
            draftText: args.repairDraftText,
            spanStart: args.repairSpanStart,
            spanEnd: args.repairSpanEnd,
          });
        }
        if (request.taskKind === "llm_qa") {
          qaCallCount += 1;
          // First QA agent emits the finding; the other three are clean.
          if (qaCallCount === 1) {
            return makeQaContent([args.qaFinding]);
          }
          return makeQaContent([]);
        }
        return "";
      },
    });
  };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("runAgenticLoopForUnit (ITOTORI-222)", () => {
  it("happy path: chains every stage end-to-end and emits a well-formed bundle", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      happyPathProviderFactory(),
    );
    expect(bundle.schemaVersion).toBe(AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bridgeUnitId).toBe(BRIDGE_UNIT_ID);
    const stageNames = bundle.stages.map((s) => s.stageName);
    expect(stageNames).toEqual([
      "context",
      "pre_translation",
      "translation",
      "deterministic_checks",
      "qa_findings",
      "routing",
      "repair",
      "final_draft",
    ]);
    // Sanity check: every defined stage name appears in the closed enum.
    for (const name of stageNames) {
      expect(AGENTIC_LOOP_STAGE_NAMES).toContain(name);
    }
    // Happy path: routing accepted + draft text persisted.
    expect(bundle.routingSummary.outcome).toBe("accepted");
    expect(bundle.finalDraft.draftText).toBe(DRAFT_TEXT);
    expect(bundle.finalDraft.deferredReason).toBeUndefined();
    expect(bundle.routingSummary.repairAttempts).toBe(0);
  });

  it("every invocation carries an explicit (modelId, providerId) pair from the pair-policy", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      happyPathProviderFactory(),
    );
    const invocations = bundle.stages.flatMap((s) => s.invocations);
    expect(invocations.length).toBeGreaterThanOrEqual(
      // context (4) + speaker-label (1) + translation (1) + qa (4) = 10
      10,
    );
    for (const invocation of invocations) {
      expect(invocation.pair.modelId).toBe(DEV_POLICY.translation.primary.pair.modelId);
      expect(invocation.pair.providerId).toBe(DEV_POLICY.translation.primary.pair.providerId);
      expect(invocation.pair.modelId.length).toBeGreaterThan(0);
      expect(invocation.pair.providerId.length).toBeGreaterThan(0);
      // ITOTORI-234 — every invocation carries the per-stage posture's
      // zdr + seed. Acceptance criterion #3.
      expect(typeof invocation.zdr).toBe("boolean");
      expect(Number.isInteger(invocation.seed)).toBe(true);
      expect(invocation.seed).toBeGreaterThanOrEqual(0);
    }
  });

  it("deterministic-check P0 failure short-circuits before QA stages fire", async () => {
    // Build an input whose glossary protected span declares an
    // expectedTargetForm 'HERO'. The translation emits 'hero'
    // (lowercase) AT the declared range — yielding
    // `capitalization_drift` from the second-layer validator,
    // which the orchestrator classifies as P0 and short-circuits.
    const inputWithGlossary: AgenticLoopUnitInput = {
      ...makeInput(),
      unit: { ...makeUnit(), sourceText: "勇者{player}" },
      protectedSpans: [
        {
          refId: "span-variable-player",
          sourceText: "{player}",
          spanKind: "variable",
        },
        {
          refId: "span-glossary-hero",
          sourceText: "勇者",
          spanKind: "glossary",
          expectedTargetForm: "HERO",
        },
      ],
    };

    // Translation output declares BOTH the variable span AND the
    // glossary span. The glossary span's declared range hosts
    // 'hero' (lowercase 4 chars), which differs from 'HERO' only
    // by case — the validator emits `capitalization_drift`.
    const translationContent = JSON.stringify({
      schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
      drafts: [
        {
          bridgeUnitId: BRIDGE_UNIT_ID,
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          draftText: "hero {player}",
          protectedSpanRefs: [{ refId: "span-variable-player", startInDraft: 5, endInDraft: 13 }],
          citationRefs: ["019ed079-0000-7000-8000-00000000gl01"],
          agentRationale: "fixture-translation",
          confidenceFloor: "medium",
        },
      ],
    });

    const provider: AgenticLoopProviderFactory = ({ stage, agentLabel }) =>
      new FakeModelProvider({
        providerName: `fake-${stage}-${agentLabel}`,
        generate: (request: ModelInvocationRequest) => {
          if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
            return makeSpeakerLabelContent({ ...makeUnit(), sourceText: "勇者{player}" });
          }
          if (request.taskKind === "experiment") {
            return `context-probe:${agentLabel}`;
          }
          if (request.taskKind === "draft_translation") {
            return translationContent;
          }
          if (request.taskKind === "llm_qa") {
            return makeQaContent([]);
          }
          return "";
        },
      });

    const bundle = await runAgenticLoopForUnit(
      inputWithGlossary,
      DEV_POLICY,
      makePolicy(),
      provider,
    );
    const qaStage = bundle.stages.find((s) => s.stageName === "qa_findings");
    expect(qaStage).toBeDefined();
    expect(qaStage?.invocations.length).toBe(0);
    expect(qaStage?.outcome).toMatch(/^skipped:deterministic_p0/u);
    expect(bundle.routingSummary.outcome).toBe("short_circuit_deterministic_p0");
    expect(bundle.finalDraft.deferredReason).toBeDefined();
    expect(bundle.finalDraft.draftText).toBeUndefined();
  });

  it("repair cap: maxRepairAttempts=0 forces deferred_to_human when a repairable finding emerges", async () => {
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f01",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "critical",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: tighten the draft",
      agentRationale: "fixture-finding",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 0 }),
      findingsProviderFactory({
        qaFinding: finding,
        repairDraftText: DRAFT_TEXT,
        repairSpanStart: 7,
        repairSpanEnd: 15,
      }),
    );
    expect(bundle.routingSummary.outcome).toBe("deferred_to_human");
    expect(bundle.routingSummary.maxRepairAttempts).toBe(0);
    expect(bundle.routingSummary.repairAttempts).toBe(0);
    expect(bundle.routingSummary.criticalFindingCount).toBe(1);
    expect(bundle.finalDraft.draftText).toBeUndefined();
    expect(bundle.finalDraft.deferredReason).toBeDefined();
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(repairStage?.outcome).toBe("cap_exceeded");
  });

  it("round-trip: serialize + parse via the schema asserter yields a byte-equal bundle", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      happyPathProviderFactory(),
    );
    const serialized = JSON.stringify(bundle);
    const reparsed = parseAgenticLoopBundle(serialized);
    expect(reparsed).toEqual(bundle);
    expect(JSON.stringify(reparsed)).toBe(serialized);
    // Schema asserter accepts the bundle.
    assertAgenticLoopBundle(JSON.parse(serialized));
  });

  it("rejects a pair-policy with a missing entry", async () => {
    const incomplete: PairPolicy = {
      ...DEV_POLICY,
      qa: {
        ...DEV_POLICY.qa,
        // Synthesize an empty modelId to force the assertion to fire.
        // The orchestrator asserts the v0.2 posture shape now, so we
        // build a full posture and break the modelId.
        styleAdherence: {
          ...DEV_POLICY.qa.styleAdherence,
          pair: {
            modelId: "",
            providerId: DEV_POLICY.qa.styleAdherence.pair.providerId,
          },
        },
      },
    };
    await expect(
      runAgenticLoopForUnit(makeInput(), incomplete, makePolicy(), happyPathProviderFactory()),
    ).rejects.toBeInstanceOf(PairPolicyMissingEntryError);
  });

  it("live LLM is never invoked: every recorded provider proof comes from the fake provider", async () => {
    // The FakeModelProvider mints providerRun.runId values prefixed
    // with 'fake' (see `createProviderRunId` in providers/types.ts).
    // We assert every providerProofId in the bundle is fake-sourced.
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      happyPathProviderFactory(),
    );
    const proofIds = bundle.stages.flatMap((s) => s.invocations.map((i) => i.providerProofId));
    expect(proofIds.length).toBeGreaterThan(0);
    for (const proofId of proofIds) {
      expect(proofId).toMatch(/^fake[:-]/u);
    }
  });
});

// Local helper — keeps the test file self-contained without re-exporting
// the type from providers/types.
function _typeCheckOnly(_provider: ModelProvider): void {
  // Type-only marker; never invoked.
}
void _typeCheckOnly;
