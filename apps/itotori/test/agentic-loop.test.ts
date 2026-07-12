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
//   2. Deterministic diagnostics: QA stage records ZERO invocations while the
//      primary candidate still becomes the required written result.
//   3. Repair cap: a synthetic finding leaves the primary candidate selected
//      with informational quality flags when `maxRepairAttempts=0`.
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
  fakeSemanticContextContent,
  PairPolicyMissingEntryError,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "../src/orchestrator/agentic-loop.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import { usageCostToDecimalString, usageCostToMicros } from "../src/providers/cost.js";
import type {
  ModelInvocationRequest,
  ModelProvider,
  ProviderCost,
} from "../src/providers/types.js";
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
    // A decoded speaker anchors the character-relationship context agent (a
    // narration-only unit has no relationships to extract).
    speaker: {
      knowledgeState: "known",
      speakerId: "019ed079-0000-7000-8000-00000000sp01",
      displayName: "Yui",
    },
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
    sourceRevisionId: REVISION_ID,
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

function selectedCandidateOf(bundle: {
  writtenOutcome: {
    selectedCandidateId: string;
    candidates: Array<{ id: string; body: string; kind: "primary" | "repair" }>;
  };
}): { id: string; body: string; kind: "primary" | "repair" } {
  const selected = bundle.writtenOutcome.candidates.find(
    (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
  );
  if (selected === undefined) {
    throw new Error("test fixture expected a selected written candidate");
  }
  return selected;
}

// --- Fake content generators ------------------------------------------

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

function happyPathProviderFactory(cost?: ProviderCost): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) => {
    return new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      ...(cost !== undefined ? { cost } : {}),
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabelContent(makeUnit());
        }
        if (request.taskKind === "experiment") {
          // Context probes — no schema requirements.
          return fakeSemanticContextContent(agentLabel);
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
          return fakeSemanticContextContent(agentLabel);
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

/**
 * agentic-loop-post-repair-qa-revalidation — a provider factory whose QA judges
 * emit the SAME repairable finding on EVERY invocation (initial pass AND the
 * bounded post-repair re-QA), while the repair translation emits a
 * deterministically-CLEAN draft. This isolates the post-repair contract: the
 * repaired draft clears the deterministic recheck yet the re-QA still flags the
 * issue, so the loop retains the primary candidate and records QA/budget flags
 * instead of clearing text. Every repair attempt fires exactly one repair
 * translation + one four-agent re-QA pass, so the invocation counts prove the
 * loop stays bounded.
 */
function persistentlyFlaggingProviderFactory(args: {
  qaFinding: QaFinding;
  repairDraftText: string;
  repairSpanStart: number;
  repairSpanEnd: number;
}): AgenticLoopProviderFactory {
  let translationCallCount = 0;
  return ({ stage, agentLabel }) => {
    return new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabelContent(makeUnit());
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          translationCallCount += 1;
          if (translationCallCount === 1) {
            return makeTranslationContent({
              unit: makeUnit(),
              draftText: DRAFT_TEXT,
              spanStart: 7,
              spanEnd: 15,
            });
          }
          // Every repair attempt emits a deterministically-clean draft — so the
          // ONLY thing that can reject it is the bounded re-QA.
          return makeTranslationContent({
            unit: makeUnit(),
            draftText: args.repairDraftText,
            spanStart: args.repairSpanStart,
            spanEnd: args.repairSpanEnd,
          });
        }
        if (request.taskKind === "llm_qa") {
          // Persistent rejection: the flagged issue is never resolved, so both
          // the initial QA pass AND every re-QA pass surface the finding.
          return makeQaContent([args.qaFinding]);
        }
        return "";
      },
    });
  };
}

/**
 * Returns empty structured-agent content at a selected point in the loop.
 * Empty content is deliberately used instead of an invalid JSON shape: it
 * exercises the agents' typed partial-result path, which bounded structured
 * retry intentionally does not retry as a schema problem.
 */
function partialResultProviderFactory(args: {
  primaryTranslationPartial?: boolean;
  initialQaPartial?: boolean;
  repairTranslationPartial?: boolean;
  reQaPartial?: boolean;
  qaFinding?: QaFinding;
}): AgenticLoopProviderFactory {
  let qaCallCount = 0;
  let translationCallCount = 0;
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `partial-result-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSpeakerLabelContent(makeUnit());
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          translationCallCount += 1;
          if (
            (translationCallCount === 1 && args.primaryTranslationPartial === true) ||
            (translationCallCount > 1 && args.repairTranslationPartial === true)
          ) {
            return "";
          }
          return makeTranslationContent({
            unit: makeUnit(),
            draftText: DRAFT_TEXT,
            spanStart: 7,
            spanEnd: 15,
          });
        }
        if (request.taskKind === "llm_qa") {
          qaCallCount += 1;
          const initialQaPass = qaCallCount <= 4;
          if (
            (initialQaPass && args.initialQaPartial === true) ||
            (!initialQaPass && args.reQaPartial === true)
          ) {
            return "";
          }
          if (initialQaPass && qaCallCount === 1 && args.qaFinding !== undefined) {
            return makeQaContent([args.qaFinding]);
          }
          return makeQaContent([]);
        }
        return "";
      },
    });
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
    // Happy path: one selected, non-blank candidate is written.
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(bundle.writtenOutcome.unitId).toBe(BRIDGE_UNIT_ID);
    expect(selectedCandidateOf(bundle).body).toBe(DRAFT_TEXT);
    expect(bundle.writtenOutcome.qualityFlags).toEqual([]);
    expect(bundle.writtenOutcome.provenance).toMatchObject({ repairAttempts: 0 });
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

  it("deterministic diagnostics skip QA but retain a written primary candidate", async () => {
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
            return fakeSemanticContextContent(agentLabel);
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
    expect(qaStage?.outcome).toMatch(/^skipped:deterministic_diagnostic/u);
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle).body).toBe("hero {player}");
    expect(bundle.writtenOutcome.qualityFlags).toEqual(
      expect.arrayContaining([
        "deterministic_capitalization_drift",
        "deterministic_validation_failed",
      ]),
    );
  });

  it("repair cap: maxRepairAttempts=0 retains the primary candidate with informational flags", async () => {
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
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.findings).toHaveLength(1);
    expect(bundle.writtenOutcome.qualityFlags).toEqual(
      expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
    );
    expect(bundle.writtenOutcome.provenance).toMatchObject({
      maxRepairAttempts: 0,
      repairAttempts: 0,
      criticalFindingCount: 1,
    });
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(repairStage?.outcome).toBe("repair_budget_exhausted");
  });

  it("writes the primary candidate with qa_incomplete when initial QA returns no content", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      partialResultProviderFactory({ initialQaPartial: true }),
    );

    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.qualityFlags).toContain("qa_incomplete");
    expect(bundle.stages.find((stage) => stage.stageName === "qa_findings")?.outcome).toBe(
      "incomplete:partial_result",
    );
    expect(bundle.stages.find((stage) => stage.stageName === "repair")?.outcome).toBe(
      "skipped:qa_incomplete",
    );
    assertAgenticLoopBundle(JSON.parse(JSON.stringify(bundle)));
  });

  it("retains the primary candidate with repair_incomplete when repair returns no content", async () => {
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f05",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "critical",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: trigger a repair",
      agentRationale: "fixture-repair-partial",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 1 }),
      partialResultProviderFactory({ qaFinding: finding, repairTranslationPartial: true }),
    );

    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.candidates).toHaveLength(1);
    expect(bundle.writtenOutcome.findings).toHaveLength(1);
    expect(bundle.writtenOutcome.qualityFlags).toContain("repair_incomplete");
    expect(bundle.stages.find((stage) => stage.stageName === "repair")?.outcome).toBe(
      "incomplete:partial_result_at_attempt_1",
    );
    expect(bundle.writtenOutcome.provenance).toMatchObject({ repairAttempts: 1 });
    assertAgenticLoopBundle(JSON.parse(JSON.stringify(bundle)));
  });

  it("retains the known primary candidate with qa_incomplete when post-repair QA returns no content", async () => {
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f06",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "critical",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: trigger re-QA",
      agentRationale: "fixture-reqa-partial",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 1 }),
      partialResultProviderFactory({ qaFinding: finding, reQaPartial: true }),
    );

    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.candidates).toHaveLength(2);
    expect(bundle.writtenOutcome.qualityFlags).toContain("qa_incomplete");
    expect(bundle.stages.find((stage) => stage.stageName === "repair")?.outcome).toBe(
      "incomplete:qa_partial_result_at_attempt_1",
    );
    assertAgenticLoopBundle(JSON.parse(JSON.stringify(bundle)));
  });

  it("correctively retries a primary partial result until a usable candidate exists", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      partialResultProviderFactory({ primaryTranslationPartial: true }),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
  });

  it("post-repair re-QA selects a repaired candidate that passes the bounded re-QA", async () => {
    // agentic-loop-post-repair-qa-revalidation — option (a) accept path. The
    // initial QA flags a repairable mistranslation; the repair emits a clean
    // draft; the bounded re-QA (four judges, once) comes back CLEAN, so the
    // repaired draft is accepted with real evidence the flagged issue is gone.
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f02",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "major",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: tighten the draft",
      agentRationale: "fixture-finding",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 1 }),
      // `findingsProviderFactory` emits the finding ONLY on the first QA call,
      // so the post-repair re-QA (QA calls 5-8) is clean → confirmed fix.
      findingsProviderFactory({
        qaFinding: finding,
        repairDraftText: DRAFT_TEXT,
        repairSpanStart: 7,
        repairSpanEnd: 15,
      }),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "repair" });
    expect(bundle.writtenOutcome.candidates).toHaveLength(2);
    expect(bundle.writtenOutcome.provenance).toMatchObject({ repairAttempts: 1 });
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(repairStage?.outcome).toBe("selected_repair_candidate_at_attempt_1");
    // The repair stage owns BOTH the repair translation (1) AND its bounded
    // re-QA (4 focused judges) = 5 invocations. The `qa_findings` stage stays
    // the INITIAL four-agent pass — the re-QA is not double-counted there.
    expect(repairStage?.invocations.length).toBe(5);
    const reqaInvocations =
      repairStage?.invocations.filter((i) => i.agentLabel.includes("-reqa[")) ?? [];
    expect(reqaInvocations.length).toBe(4);
    const qaStage = bundle.stages.find((s) => s.stageName === "qa_findings");
    expect(qaStage?.invocations.length).toBe(4);
  });

  it("post-repair re-QA retains the primary draft when a repair still has QA findings", async () => {
    // agentic-loop-post-repair-qa-revalidation — option (a) reject path. The
    // repaired draft is deterministically CLEAN (balanced / non-empty / charset
    // / protected-spans all pass), yet the bounded re-QA STILL flags the
    // repairable issue. The primary draft remains selected, while both drafts
    // and every QA annotation remain available in the written outcome.
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f03",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "major",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: the repaired draft STILL mistranslates",
      agentRationale: "fixture-finding",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 1 }),
      persistentlyFlaggingProviderFactory({
        qaFinding: finding,
        repairDraftText: DRAFT_TEXT,
        repairSpanStart: 7,
        repairSpanEnd: 15,
      }),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.candidates).toHaveLength(2);
    expect(bundle.writtenOutcome.findings.length).toBeGreaterThan(0);
    expect(bundle.writtenOutcome.qualityFlags).toEqual(
      expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
    );
    expect(bundle.writtenOutcome.provenance).toMatchObject({ repairAttempts: 1 });
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(repairStage?.outcome).toBe("repair_budget_exhausted_with_qa_flags_after_1_attempts");
    expect(repairStage?.invocations.length).toBe(5);
    // The bundle round-trips through the schema asserter with the new outcome.
    assertAgenticLoopBundle(JSON.parse(JSON.stringify(bundle)));
  });

  it("post-repair re-QA stays BOUNDED while retaining a written candidate", async () => {
    // agentic-loop-post-repair-qa-revalidation — the bound proof. With a
    // persistently-flagging re-QA never selects a repair, so it must run
    // EXACTLY `maxRepairAttempts` cycles and stop — each cycle firing one
    // repair translation + one four-agent re-QA (no unbounded QA→repair→QA),
    // while the primary candidate remains selected.
    const finding: QaFinding = {
      findingId: "019ed079-0000-7000-8000-000000000f04",
      bridgeUnitId: BRIDGE_UNIT_ID,
      severity: "major",
      category: "mistranslation",
      evidenceRefs: [],
      recommendation: "fixture: never resolvable",
      agentRationale: "fixture-finding",
    };
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 2 }),
      persistentlyFlaggingProviderFactory({
        qaFinding: finding,
        repairDraftText: DRAFT_TEXT,
        repairSpanStart: 7,
        repairSpanEnd: 15,
      }),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(selectedCandidateOf(bundle)).toMatchObject({ body: DRAFT_TEXT, kind: "primary" });
    expect(bundle.writtenOutcome.candidates).toHaveLength(3);
    expect(bundle.writtenOutcome.qualityFlags).toEqual(
      expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
    );
    // The cap held: exactly 2 attempts, not one more.
    expect(bundle.writtenOutcome.provenance).toMatchObject({ repairAttempts: 2 });
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(repairStage?.outcome).toBe("repair_budget_exhausted_with_qa_flags_after_2_attempts");
    // 2 repair translations + 2 × 4 re-QA judges = 10 invocations. If the loop
    // were unbounded this would blow past 10.
    expect(repairStage?.invocations.length).toBe(10);
    const repairPrimaryCount =
      repairStage?.invocations.filter((i) => i.agentLabel.startsWith("repair-primary")).length ?? 0;
    expect(repairPrimaryCount).toBe(2);
    const reqaCount =
      repairStage?.invocations.filter((i) => i.agentLabel.includes("-reqa[")).length ?? 0;
    expect(reqaCount).toBe(8);
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

  it("renders a SUB-MICRO billed cost at full precision (not truncated to 6 digits) per-invocation and per-stage", async () => {
    // Regression guard for the agentic-loop bundle costUsd truncation:
    // `microsToAmount(assertBilledCost(...))` padded to EXACTLY 6 fractional
    // digits, so a 0.00000602 USD invocation (6.02 micros) reported
    // "0.000006", silently dropping the sub-micro tail the ledger preserves.
    //
    // SYNTHETIC injected cost — the value is derived from the REAL cost parser
    // (`usageCostToDecimalString` / `usageCostToMicros`), never a fabricated
    // cost literal, so `audit-no-hardcoded-cost` stays green. The full-
    // precision decimal (`amountUsd`) is the SAME authoritative value the
    // draft-attempt ledger persists.
    const SUB_MICRO_USD = "0.00000602";
    const billedCost: ProviderCost = {
      costKind: "billed",
      currency: "USD",
      amountUsd: usageCostToDecimalString(SUB_MICRO_USD),
      amountMicrosUsd: usageCostToMicros(SUB_MICRO_USD),
    };
    // The micros mirror rounds 6.02 -> 6 micros; the OLD renderer would emit
    // this truncated string. The fix must NOT produce it.
    const TRUNCATED = "0.000006";
    expect(billedCost.amountUsd).toBe(SUB_MICRO_USD);
    expect(billedCost.amountMicrosUsd).toBe(6);

    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy(),
      happyPathProviderFactory(billedCost),
    );

    const invocations = bundle.stages.flatMap((s) => s.invocations);
    expect(invocations.length).toBeGreaterThan(0);
    // Per-invocation: every billed invocation renders the exact full-precision
    // amount, never the micros-truncated form.
    for (const invocation of invocations) {
      expect(invocation.costUsd).toBe(SUB_MICRO_USD);
      expect(invocation.costUsd).not.toBe(TRUNCATED);
    }

    // Per-stage: the roll-up is a LOSSLESS decimal sum of the invocation
    // costs — sub-micro tail preserved — not a micros-truncated total.
    let sawMultiInvocationStage = false;
    for (const stage of bundle.stages) {
      const count = stage.invocations.length;
      if (count === 0) {
        expect(stage.costUsd).toBe("0");
        continue;
      }
      // Independent expectation: each invocation is 602 units of 1e-8 USD.
      const units = 602 * count;
      const scaled = String(units).padStart(9, "0");
      const whole = scaled.slice(0, scaled.length - 8).replace(/^0+(?=\d)/u, "");
      const frac = scaled.slice(scaled.length - 8).replace(/0+$/u, "");
      const expected = frac.length > 0 ? `${whole}.${frac}` : whole;
      expect(stage.costUsd).toBe(expected);
      if (count > 1) {
        sawMultiInvocationStage = true;
        // The truncated micros total (count * 6 micros) would strictly
        // under-report; the full-precision sum must exceed it.
        expect(Number(stage.costUsd)).toBeGreaterThan((count * 6) / 1e6);
      }
    }
    // The happy path fans out multiple context invocations, so the per-stage
    // (not just per-invocation) precision path is genuinely exercised.
    expect(sawMultiInvocationStage).toBe(true);

    // The bundle still round-trips through the schema asserter with the full-
    // precision decimal strings (the decimal pattern accepts them).
    assertAgenticLoopBundle(JSON.parse(JSON.stringify(bundle)));
  });
});

// Local helper — keeps the test file self-contained without re-exporting
// the type from providers/types.
function _typeCheckOnly(_provider: ModelProvider): void {
  // Type-only marker; never invoked.
}
void _typeCheckOnly;
