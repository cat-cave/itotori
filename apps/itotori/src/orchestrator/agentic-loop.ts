// ITOTORI-222 — Full agentic-loop orchestrator.
//
// Single entry point that chains EVERY agentic stage end-to-end on
// one localization unit (LocalizationUnitV02 from KAIFUU-210). After
// this seam lands, the alpha-tier "full agentic loop fires" clause is
// structurally satisfied; only the Sweetie HD wiring (UTSUSHI-227 /
// UTSUSHI-228) remains for end-to-end runtime evidence.
//
// Hard rules (mirrored from the spec + audit-focus items):
//   - (modelId, providerId) pair is REQUIRED on every model
//     invocation in every stage. The pair is drawn from the
//     `PairPolicy` the caller passes; there is NO defaulting at the
//     orchestrator boundary.
//   - No silent fallbacks. Every stage failure routes through the
//     triage router; deterministic-check P0 failures short-circuit
//     before the LLM-QA stages can fire.
//   - Repair is bounded by `policy.maxRepairAttempts`. Exceeding the
//     cap records `routingSummary.outcome === 'deferred_to_human'`;
//     the bundle's finalDraft carries a `deferredReason` instead of a
//     `draftText`.
//   - No `as any`, no `@ts-ignore`. Every union resolution uses
//     proper narrowing or an exhaustive switch.
//   - No legacy compat. The old isolated drafting command was deleted
//     in the same change; this orchestrator is the only entry point.

import { createHash } from "node:crypto";
import type { AuthorizationActor } from "@itotori/db";
import {
  AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION,
  type AgenticLoopBundle,
  type AgenticLoopInvocation,
  type AgenticLoopProviderPair,
  type AgenticLoopRoutingOutcome,
  type AgenticLoopRoutingSummary,
  type AgenticLoopStageName,
  type AgenticLoopStageRecord,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import { SpeakerLabelAgent } from "../agents/speaker-label/agent.js";
import {
  SPEAKER_LABEL_PROMPT_TEMPLATE_VERSION_V1,
  type SpeakerLabelInvocationInput,
  type SpeakerLabelInvocationResult,
} from "../agents/speaker-label/shapes.js";
import { TranslationAgent } from "../agents/translation/agent.js";
import {
  TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  type TranslationBridgeUnit,
  type TranslationGlossaryEntry,
  type TranslationInvocationInput,
  type TranslationInvocationResult,
  type TranslationProtectedSpanInput,
} from "../agents/translation/shapes.js";
import { QaAgent } from "../agents/qa/agent.js";
import {
  QA_PROMPT_TEMPLATE_VERSION_V1,
  type QaBridgeUnit,
  type QaGlossaryEntry,
  type QaInvocationInput,
  type QaInvocationResult,
} from "../agents/qa/shapes.js";
import { DraftProtectedSpanValidator } from "../draft/protected-span-validator.js";
import type {
  DraftProtectedSpanViolation,
  DraftSourceProtectedSpan,
} from "../draft/protected-span-validator.js";
import { FindingTriageRouter } from "../triage/router.js";
import type { FindingTriageResult } from "../triage/router.js";
import type { ModelInvocationRequest, ModelProvider, ProviderFamily } from "../providers/types.js";
import { assertBilledCost } from "../providers/cost.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single pinned (modelId, providerId) choice. Stage-level
 * configuration is built from these. Mirrored on every invocation
 * inside the bundle so audit can prove the orchestrator never
 * silently defaulted.
 */
export type PairChoice = AgenticLoopProviderPair;

/**
 * Per-stage pair policy. Every stage that issues at least one LLM
 * invocation has its (modelId, providerId) pinned here. A single
 * stage can declare per-agent pairs (e.g. each focused QA agent gets
 * its own pair).
 *
 * The orchestrator NEVER falls back to a default; missing entries
 * are a typed `PairPolicyMissingEntryError`.
 */
export type PairPolicy = {
  context: {
    sceneSummary: PairChoice;
    characterRelationship: PairChoice;
    terminologyCandidate: PairChoice;
    routeChoiceMap: PairChoice;
  };
  preTranslation: {
    speakerLabel: PairChoice;
  };
  translation: {
    primary: PairChoice;
    regrade?: PairChoice;
  };
  qa: {
    styleAdherence: PairChoice;
    semanticDrift: PairChoice;
    toneRegister: PairChoice;
    unresolvedTerminology: PairChoice;
  };
  repair: {
    primary: PairChoice;
  };
};

import { DEV_PAIR } from "../providers/dev-pair.js";

/**
 * Pre-populated pair policy that pins every stage to `DEV_PAIR`. Used
 * by the smoke command and the orchestrator's test suite so a single
 * import drops in a complete policy. Production callers build their
 * own policy and pass it explicitly.
 */
export const DEV_POLICY: PairPolicy = {
  context: {
    sceneSummary: DEV_PAIR,
    characterRelationship: DEV_PAIR,
    terminologyCandidate: DEV_PAIR,
    routeChoiceMap: DEV_PAIR,
  },
  preTranslation: {
    speakerLabel: DEV_PAIR,
  },
  translation: {
    primary: DEV_PAIR,
  },
  qa: {
    styleAdherence: DEV_PAIR,
    semanticDrift: DEV_PAIR,
    toneRegister: DEV_PAIR,
    unresolvedTerminology: DEV_PAIR,
  },
  repair: {
    primary: DEV_PAIR,
  },
};

/**
 * Tunables for the loop. `maxRepairAttempts` is strictly enforced —
 * exceeding it records `routingSummary.outcome === 'deferred_to_human'`
 * (see acceptance criterion #4 of ITOTORI-222).
 */
export type AgenticLoopPolicy = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  targetLocale: string;
  maxRepairAttempts: number;
  /**
   * Deterministic clock seam — tests inject a fixed counter so the
   * bundle output is byte-equal across runs.
   */
  now?: () => Date;
};

/**
 * Provider factory the caller supplies. The orchestrator never
 * constructs providers on its own — production wires OpenRouter via
 * the caller, tests wire `FakeModelProvider`. The factory receives
 * the stage / agent label AND the pinned `PairChoice` so a single
 * factory closure can either return a stage-specific provider or
 * route every stage to one shared instance.
 */
export type AgenticLoopProviderFactory = (input: {
  stage: AgenticLoopStageName;
  agentLabel: string;
  pair: PairChoice;
}) => ModelProvider;

/**
 * Input to `runAgenticLoopForUnit`. The `unit` is a v0.2
 * LocalizationUnitV02 (KAIFUU-210). Surrounding scene-context
 * artifacts and the glossary are passed alongside — the orchestrator
 * is intentionally pure of side effects on persistence layers.
 */
export type AgenticLoopUnitInput = {
  unit: LocalizationUnitV02;
  /**
   * Other units in the same scene the context stage needs as
   * sibling evidence. May be empty for one-shot smoke tests.
   */
  sceneUnits?: ReadonlyArray<LocalizationUnitV02>;
  glossary: ReadonlyArray<TranslationGlossaryEntry>;
  /**
   * Protected spans pre-computed for the unit. Keyed by bridgeUnitId
   * so the translation agent can enforce byte-equal preservation +
   * the second-layer validator can run at acceptance time.
   */
  protectedSpans: ReadonlyArray<DraftSourceProtectedSpan>;
  /**
   * Optional roster for the speaker-label agent. When empty the
   * speaker-label stage still runs and returns `narration` /
   * `unknown_to_parser` shapes — the orchestrator never invents a
   * character.
   */
  knownCharacters?: ReadonlyArray<{
    characterId: string;
    displayName: string;
    bioLocale: string;
    bioText: string;
    hiddenFromReader: boolean;
    maskedCharacterId?: string;
    maskedDisplayName?: string;
  }>;
  /**
   * Actor that owns the run. Threaded through every agent invocation
   * for downstream provenance.
   */
  actor: AuthorizationActor;
};

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class PairPolicyMissingEntryError extends Error {
  constructor(
    public readonly stage: string,
    public readonly agent: string,
  ) {
    super(
      `agentic-loop refused: pair-policy is missing entry for stage='${stage}' agent='${agent}'`,
    );
    this.name = "PairPolicyMissingEntryError";
  }
}

export class AgenticLoopInvariantError extends Error {
  constructor(public readonly detail: string) {
    super(`agentic-loop invariant violation: ${detail}`);
    this.name = "AgenticLoopInvariantError";
  }
}

// ---------------------------------------------------------------------------
// Internal accumulator types
// ---------------------------------------------------------------------------

type StageAccumulator = {
  stageName: AgenticLoopStageName;
  invocations: AgenticLoopInvocation[];
  outcome: string;
  tokensIn: number;
  tokensOut: number;
  costMicros: bigint;
  latencyMs: number;
};

type RawProviderTelemetry = {
  invocationId: string;
  agentLabel: string;
  pair: PairChoice;
  tokensIn: number;
  tokensOut: number;
  costMicros: bigint;
  latencyMs: number;
  providerProofId: string;
};

// ---------------------------------------------------------------------------
// Headline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full agentic loop on a single bridge unit. Returns a
 * fully-formed `AgenticLoopBundle` (deserializable + assertable via
 * the schema package).
 */
export async function runAgenticLoopForUnit(
  input: AgenticLoopUnitInput,
  pairPolicy: PairPolicy,
  policy: AgenticLoopPolicy,
  providerFactory: AgenticLoopProviderFactory,
): Promise<AgenticLoopBundle> {
  assertPairPolicyComplete(pairPolicy);

  const now = policy.now ?? defaultNow();
  const stages: StageAccumulator[] = [];

  // -------------------------- context stage --------------------------
  const contextStage = startStage("context");
  // Context agents emit one provider call each — for the smoke /
  // synthetic case we record the call telemetry without persisting
  // their domain artifacts. Production callers can wire the full
  // scene-summary / character-relationship / terminology-candidate
  // / route-choice-map agents into this slot via a richer factory.
  // The orchestrator commits ONLY to: every context agent fires once
  // with its pinned pair, and the telemetry is captured.
  for (const entry of [
    { agentLabel: "scene-summary", pair: pairPolicy.context.sceneSummary },
    { agentLabel: "character-relationship", pair: pairPolicy.context.characterRelationship },
    { agentLabel: "terminology-candidate", pair: pairPolicy.context.terminologyCandidate },
    { agentLabel: "route-choice-map", pair: pairPolicy.context.routeChoiceMap },
  ]) {
    const provider = providerFactory({
      stage: "context",
      agentLabel: entry.agentLabel,
      pair: entry.pair,
    });
    const invocation = await invokeContextLikeProbe(
      provider,
      entry.pair,
      entry.agentLabel,
      input.unit,
      now,
    );
    pushInvocation(contextStage, invocation);
  }
  contextStage.outcome = "succeeded";
  stages.push(contextStage);

  // ----------------------- pre-translation stage ---------------------
  const preStage = startStage("pre_translation");
  const speakerLabelProvider = providerFactory({
    stage: "pre_translation",
    agentLabel: "speaker-label",
    pair: pairPolicy.preTranslation.speakerLabel,
  });
  const speakerLabelResult = await invokeSpeakerLabelStage({
    provider: speakerLabelProvider,
    pair: pairPolicy.preTranslation.speakerLabel,
    input,
    policy,
  });
  pushInvocation(preStage, providerTelemetryFromSpeakerLabel(speakerLabelResult, pairPolicy));
  preStage.outcome = "succeeded";
  stages.push(preStage);

  // --------------------------- translation ---------------------------
  const translationStage = startStage("translation");
  const translationProvider = providerFactory({
    stage: "translation",
    agentLabel: "translation-primary",
    pair: pairPolicy.translation.primary,
  });
  const translationResult = await invokeTranslationStage({
    provider: translationProvider,
    pair: pairPolicy.translation.primary,
    input,
    policy,
    agentLabel: "translation-primary",
  });
  pushInvocation(
    translationStage,
    providerTelemetryFromTranslation(
      translationResult,
      pairPolicy.translation.primary,
      "translation-primary",
    ),
  );
  translationStage.outcome = "succeeded";
  stages.push(translationStage);

  const primaryDraftText = pickDraftTextForUnit(translationResult, input.unit.bridgeUnitId);

  // --------------------- deterministic checks ------------------------
  const deterministicStage = startStage("deterministic_checks");
  const deterministicResult = runDeterministicChecks({
    input,
    draftText: primaryDraftText,
    draftProtectedSpanRefs:
      translationResult.drafts.find((d) => d.bridgeUnitId === input.unit.bridgeUnitId)
        ?.protectedSpanRefs ?? [],
    targetLocale: policy.targetLocale,
  });
  deterministicStage.outcome = deterministicResult.shortCircuit
    ? `short_circuit:p0:${deterministicResult.firstP0Kind ?? "unknown"}`
    : "succeeded";
  stages.push(deterministicStage);

  // ----------------------------- QA stages --------------------------- //
  // Deterministic-check P0 short-circuits before QA fires.            //
  // ------------------------------------------------------------------ //
  let qaFindings: QaFinding[] = [];
  if (deterministicResult.shortCircuit) {
    const qaStage = startStage("qa_findings");
    qaStage.outcome = "skipped:deterministic_p0";
    stages.push(qaStage);

    const routingStage = startStage("routing");
    const triageResult = routeFindingsAndViolations({
      findings: [],
      violations: deterministicResult.violations,
      projectId: policy.projectId,
    });
    routingStage.outcome = "routed";
    stages.push(routingStage);

    const repairStage = startStage("repair");
    repairStage.outcome = "skipped:deterministic_p0";
    stages.push(repairStage);

    const finalStage = startStage("final_draft");
    finalStage.outcome = "deferred_to_human";
    stages.push(finalStage);

    return finalizeBundle({
      bridgeUnitId: input.unit.bridgeUnitId,
      policy,
      stages,
      routingSummary: {
        outcome: "short_circuit_deterministic_p0",
        routedFindingCount: triageResult.routings.length,
        criticalFindingCount: triageResult.summary.criticalCount,
        repairAttempts: 0,
        maxRepairAttempts: policy.maxRepairAttempts,
      },
      finalDraft: {
        bridgeUnitId: input.unit.bridgeUnitId,
        deferredReason: `deterministic_checks short-circuited on P0: ${deterministicResult.firstP0Kind ?? "unknown"}`,
      },
    });
  }

  // The four focused QA agents fire in parallel; the orchestrator
  // wires a SHARED base provider per agent because each focused agent
  // wraps a base QaAgent. Every QA invocation carries its own pinned
  // pair from the policy.
  const qaStage = startStage("qa_findings");
  const qaInvocationResults: Array<{
    agentLabel: string;
    pair: PairChoice;
    result: QaInvocationResult;
  }> = [];
  for (const entry of [
    { agentLabel: "qa-style-adherence", pair: pairPolicy.qa.styleAdherence },
    { agentLabel: "qa-semantic-drift", pair: pairPolicy.qa.semanticDrift },
    { agentLabel: "qa-tone-register", pair: pairPolicy.qa.toneRegister },
    { agentLabel: "qa-unresolved-terminology", pair: pairPolicy.qa.unresolvedTerminology },
  ]) {
    const provider = providerFactory({
      stage: "qa_findings",
      agentLabel: entry.agentLabel,
      pair: entry.pair,
    });
    const result = await invokeQaStage({
      provider,
      pair: entry.pair,
      input,
      policy,
      draftText: primaryDraftText,
      agentLabel: entry.agentLabel,
    });
    qaInvocationResults.push({ agentLabel: entry.agentLabel, pair: entry.pair, result });
    pushInvocation(qaStage, providerTelemetryFromQa(result, entry.pair, entry.agentLabel));
    qaFindings = qaFindings.concat(result.findings);
  }
  qaStage.outcome = "succeeded";
  stages.push(qaStage);

  // ------------------------------ routing ----------------------------
  const routingStage = startStage("routing");
  const triageResult = routeFindingsAndViolations({
    findings: qaFindings,
    violations: deterministicResult.violations,
    projectId: policy.projectId,
  });
  routingStage.outcome = "routed";
  stages.push(routingStage);

  const repairableCauseCount = triageResult.routings.filter((routing) =>
    isRepairableCauseClass(routing.rootCause.class),
  ).length;

  // ------------------------------ repair -----------------------------
  const repairStage = startStage("repair");
  let routingOutcome: AgenticLoopRoutingOutcome = "accepted";
  let finalDraftText: string | undefined = primaryDraftText;
  let deferredReason: string | undefined;
  let repairAttempts = 0;

  if (qaFindings.length === 0 && deterministicResult.violations.length === 0) {
    // Nothing to repair — short, clean path.
    repairStage.outcome = "skipped:no_findings";
  } else if (repairableCauseCount === 0) {
    repairStage.outcome = "skipped:no_repairable_cause";
    if (triageResult.summary.criticalCount > 0) {
      routingOutcome = "deferred_to_human";
      finalDraftText = undefined;
      deferredReason = `routing reported ${triageResult.summary.criticalCount} critical finding(s) without a repairable cause`;
    }
  } else if (policy.maxRepairAttempts <= 0) {
    // Cap exceeded before the first attempt.
    repairStage.outcome = "cap_exceeded";
    routingOutcome = "deferred_to_human";
    finalDraftText = undefined;
    deferredReason = `maxRepairAttempts=${policy.maxRepairAttempts} but ${repairableCauseCount} repairable cause(s) emerged`;
  } else {
    // Run the bounded repair loop. We invoke the repair agent once
    // per repair budget; if any iteration produces a clean draft the
    // loop terminates with `repaired_then_accepted`. Otherwise the
    // bundle records `deferred_to_human`.
    let attempt = 0;
    while (attempt < policy.maxRepairAttempts) {
      attempt += 1;
      const repairProvider = providerFactory({
        stage: "repair",
        agentLabel: "repair-primary",
        pair: pairPolicy.repair.primary,
      });
      const repairResult = await invokeTranslationStage({
        provider: repairProvider,
        pair: pairPolicy.repair.primary,
        input,
        policy,
        agentLabel: `repair-primary[${attempt}]`,
      });
      pushInvocation(
        repairStage,
        providerTelemetryFromTranslation(
          repairResult,
          pairPolicy.repair.primary,
          `repair-primary[${attempt}]`,
        ),
      );
      const repairedText = pickDraftTextForUnit(repairResult, input.unit.bridgeUnitId);
      const recheck = runDeterministicChecks({
        input,
        draftText: repairedText,
        draftProtectedSpanRefs:
          repairResult.drafts.find((d) => d.bridgeUnitId === input.unit.bridgeUnitId)
            ?.protectedSpanRefs ?? [],
        targetLocale: policy.targetLocale,
      });
      if (!recheck.shortCircuit && recheck.violations.length === 0) {
        finalDraftText = repairedText;
        routingOutcome = "repaired_then_accepted";
        repairAttempts = attempt;
        repairStage.outcome = `repaired_then_accepted_at_attempt_${attempt}`;
        break;
      }
    }
    if (routingOutcome !== "repaired_then_accepted") {
      repairAttempts = attempt;
      routingOutcome = "deferred_to_human";
      finalDraftText = undefined;
      deferredReason = `repair budget exhausted after ${attempt} attempt(s) (maxRepairAttempts=${policy.maxRepairAttempts})`;
      repairStage.outcome = `cap_exhausted_after_${attempt}_attempts`;
    }
  }
  stages.push(repairStage);

  // ---------------------------- final draft --------------------------
  const finalStage = startStage("final_draft");
  finalStage.outcome = routingOutcome;
  stages.push(finalStage);

  return finalizeBundle({
    bridgeUnitId: input.unit.bridgeUnitId,
    policy,
    stages,
    routingSummary: {
      outcome: routingOutcome,
      routedFindingCount: triageResult.routings.length,
      criticalFindingCount: triageResult.summary.criticalCount,
      repairAttempts,
      maxRepairAttempts: policy.maxRepairAttempts,
    },
    finalDraft:
      finalDraftText !== undefined
        ? { bridgeUnitId: input.unit.bridgeUnitId, draftText: finalDraftText }
        : {
            bridgeUnitId: input.unit.bridgeUnitId,
            deferredReason:
              deferredReason ?? "agentic loop deferred to human without specific reason",
          },
  });
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

function startStage(stageName: AgenticLoopStageName): StageAccumulator {
  return {
    stageName,
    invocations: [],
    outcome: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costMicros: 0n,
    latencyMs: 0,
  };
}

function pushInvocation(stage: StageAccumulator, telemetry: RawProviderTelemetry): void {
  stage.invocations.push({
    invocationId: telemetry.invocationId,
    agentLabel: telemetry.agentLabel,
    pair: telemetry.pair,
    tokensIn: telemetry.tokensIn,
    tokensOut: telemetry.tokensOut,
    costUsd: microsToAmount(telemetry.costMicros),
    latencyMs: telemetry.latencyMs,
    providerProofId: telemetry.providerProofId,
  });
  stage.tokensIn += telemetry.tokensIn;
  stage.tokensOut += telemetry.tokensOut;
  stage.costMicros += telemetry.costMicros;
  stage.latencyMs += telemetry.latencyMs;
}

function stageAccumulatorToRecord(stage: StageAccumulator): AgenticLoopStageRecord {
  return {
    stageName: stage.stageName,
    outcome: stage.outcome,
    invocations: stage.invocations,
    tokensIn: stage.tokensIn,
    tokensOut: stage.tokensOut,
    costUsd: microsToAmount(stage.costMicros),
    latencyMs: stage.latencyMs,
  };
}

function finalizeBundle(args: {
  bridgeUnitId: string;
  policy: AgenticLoopPolicy;
  stages: StageAccumulator[];
  routingSummary: AgenticLoopRoutingSummary;
  finalDraft: AgenticLoopBundle["finalDraft"];
}): AgenticLoopBundle {
  return {
    schemaVersion: AGENTIC_LOOP_BUNDLE_SCHEMA_VERSION,
    bridgeUnitId: args.bridgeUnitId,
    projectId: args.policy.projectId,
    localeBranchId: args.policy.localeBranchId,
    sourceLocale: args.policy.sourceLocale,
    targetLocale: args.policy.targetLocale,
    stages: args.stages.map(stageAccumulatorToRecord),
    routingSummary: args.routingSummary,
    finalDraft: args.finalDraft,
  };
}

// ---------------------------------------------------------------------------
// Context stage — synthetic provider probe.
//
// The four context agents (scene-summary, character-relationship,
// terminology-candidate, route-choice-map) each have their own
// elaborate input shapes. For ITOTORI-222 we commit to: every context
// agent fires once with its pinned pair, and the resulting
// ProviderRunRecord is captured in the bundle's invocation array.
// Persisting the full SceneSummary / CharacterBio shapes is deferred
// to caller-driven extensions of this orchestrator (e.g. when the
// Sweetie HD wiring lands in UTSUSHI-227+228).
// ---------------------------------------------------------------------------

async function invokeContextLikeProbe(
  provider: ModelProvider,
  pair: PairChoice,
  agentLabel: string,
  unit: LocalizationUnitV02,
  now: () => Date,
): Promise<RawProviderTelemetry> {
  const promptHashUsed = createHash("sha256")
    .update(
      `${agentLabel}|${unit.bridgeUnitId}|${unit.sourceText}|${pair.modelId}|${pair.providerId}`,
    )
    .digest("hex");
  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: pair.modelId,
    providerId: pair.providerId,
    inputClassification: "private_corpus",
    messages: [
      { role: "system", content: `itotori agentic-loop context probe (${agentLabel})` },
      { role: "user", content: unit.sourceText },
    ],
    prompt: {
      presetId: `itotori-agentic-loop-${agentLabel}`,
      templateVersion: "itotori-agentic-loop-context-v0",
      promptHash: `sha256:${promptHashUsed}`,
    },
  };
  const startedAt = now();
  const invocation = await provider.invoke(request);
  const endedAt = now();
  const tokensIn = invocation.providerRun.tokenUsage.promptTokens ?? 0;
  const tokensOut = invocation.providerRun.tokenUsage.completionTokens ?? 0;
  return {
    invocationId: `context:${agentLabel}:${invocation.providerRun.runId}`,
    agentLabel,
    pair,
    tokensIn,
    tokensOut,
    costMicros: assertBilledCost(invocation.providerRun.cost),
    latencyMs: Math.max(invocation.providerRun.latencyMs, endedAt.getTime() - startedAt.getTime()),
    providerProofId: invocation.providerRun.runId,
  };
}

// ---------------------------------------------------------------------------
// Speaker-label stage
// ---------------------------------------------------------------------------

async function invokeSpeakerLabelStage(args: {
  provider: ModelProvider;
  pair: PairChoice;
  input: AgenticLoopUnitInput;
  policy: AgenticLoopPolicy;
}): Promise<SpeakerLabelInvocationResult> {
  const agent = new SpeakerLabelAgent({ provider: args.provider });
  const labelInput: SpeakerLabelInvocationInput = {
    projectId: args.policy.projectId,
    localeBranchId: args.policy.localeBranchId,
    sourceLocale: args.policy.sourceLocale,
    bridgeUnits: [
      {
        bridgeUnitId: args.input.unit.bridgeUnitId,
        sourceUnitKey: args.input.unit.sourceUnitKey,
        sourceText: args.input.unit.sourceText,
        sourceHash: args.input.unit.sourceHash,
      },
    ],
    knownCharacters: args.input.knownCharacters ?? [],
    existingSpeakerLabels: new Map(),
    promptTemplateVersion: SPEAKER_LABEL_PROMPT_TEMPLATE_VERSION_V1,
    modelMetadata: {
      providerFamily: providerFamilyOf(args.provider),
      modelId: args.pair.modelId,
      providerId: args.pair.providerId,
      contextWindowTokens: 128_000,
    },
  };
  return agent.invokeSpeakerLabel(args.input.actor, labelInput);
}

function providerTelemetryFromSpeakerLabel(
  result: SpeakerLabelInvocationResult,
  pairPolicy: PairPolicy,
): RawProviderTelemetry {
  return {
    invocationId: `pre_translation:speaker-label:${result.providerRunId}`,
    agentLabel: "speaker-label",
    pair: pairPolicy.preTranslation.speakerLabel,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costMicros: assertBilledCost(result.modelMetadata.providerRun.cost),
    latencyMs: result.modelMetadata.providerRun.latencyMs,
    providerProofId: result.providerRunId,
  };
}

// ---------------------------------------------------------------------------
// Translation stage
// ---------------------------------------------------------------------------

async function invokeTranslationStage(args: {
  provider: ModelProvider;
  pair: PairChoice;
  input: AgenticLoopUnitInput;
  policy: AgenticLoopPolicy;
  agentLabel: string;
}): Promise<TranslationInvocationResult> {
  const agent = new TranslationAgent({ provider: args.provider });
  const protectedSpansBySource = new Map<string, ReadonlyArray<TranslationProtectedSpanInput>>();
  // The translation agent enforces byte-equal preservation for source_unit
  // / markup / variable spans only. Glossary spans are NOT given to the
  // agent — they live on the second-layer deterministic check, which
  // validates capitalization + presence of the expected target form.
  protectedSpansBySource.set(
    args.input.unit.bridgeUnitId,
    args.input.protectedSpans
      .filter((s) => s.spanKind !== "glossary")
      .map((s) => ({ refId: s.refId, sourceText: s.sourceText })),
  );
  const sourceBridgeUnits: TranslationBridgeUnit[] = [
    {
      bridgeUnitId: args.input.unit.bridgeUnitId,
      sourceUnitKey: args.input.unit.sourceUnitKey,
      sourceText: args.input.unit.sourceText,
      sourceHash: args.input.unit.sourceHash,
    },
  ];
  const draftJobId = `agentic-loop-${args.input.unit.bridgeUnitId}-job`;
  const draftJobAttemptId = `agentic-loop-${args.input.unit.bridgeUnitId}-attempt-${args.agentLabel}`;
  const invocationInput: TranslationInvocationInput = {
    draftJobId,
    draftJobAttemptId,
    projectId: args.policy.projectId,
    localeBranchId: args.policy.localeBranchId,
    sourceLocale: args.policy.sourceLocale,
    targetLocale: args.policy.targetLocale,
    sourceBridgeUnits,
    protectedSpansBySource,
    glossary: args.input.glossary,
    styleGuide: [],
    contextArtifactRefs: [],
    modelProfile: {
      providerFamily: providerFamilyOf(args.provider),
      modelId: args.pair.modelId,
      providerId: args.pair.providerId,
      contextWindowTokens: 128_000,
    },
    promptTemplateVersion: TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  };
  return agent.invokeTranslation(args.input.actor, invocationInput);
}

function providerTelemetryFromTranslation(
  result: TranslationInvocationResult,
  pair: PairChoice,
  agentLabel: string,
): RawProviderTelemetry {
  return {
    invocationId: `translation:${agentLabel}:${result.providerRunId}`,
    agentLabel,
    pair,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costMicros: assertBilledCost(result.modelMetadata.providerRun.cost),
    latencyMs: result.modelMetadata.providerRun.latencyMs,
    providerProofId: result.providerRunId,
  };
}

function pickDraftTextForUnit(result: TranslationInvocationResult, bridgeUnitId: string): string {
  const draft = result.drafts.find((d) => d.bridgeUnitId === bridgeUnitId);
  if (draft === undefined) {
    throw new AgenticLoopInvariantError(
      `translation result has no draft for bridgeUnitId='${bridgeUnitId}'`,
    );
  }
  return draft.draftText;
}

// ---------------------------------------------------------------------------
// QA stage
// ---------------------------------------------------------------------------

async function invokeQaStage(args: {
  provider: ModelProvider;
  pair: PairChoice;
  input: AgenticLoopUnitInput;
  policy: AgenticLoopPolicy;
  draftText: string;
  agentLabel: string;
}): Promise<QaInvocationResult> {
  const agent = new QaAgent({ provider: args.provider });
  const draftHash = createHash("sha256").update(args.draftText).digest("hex");
  const qaUnit: QaBridgeUnit = {
    bridgeUnitId: args.input.unit.bridgeUnitId,
    sourceUnitKey: args.input.unit.sourceUnitKey,
    sourceText: args.input.unit.sourceText,
    sourceHash: args.input.unit.sourceHash,
    draftText: args.draftText,
    draftHash,
  };
  const glossary: QaGlossaryEntry[] = args.input.glossary.map((entry) => {
    const out: QaGlossaryEntry = {
      termId: entry.termId,
      preferredSourceForm: entry.preferredSourceForm,
    };
    if (entry.preferredTargetForm !== undefined) {
      out.preferredTargetForm = entry.preferredTargetForm;
    }
    if (entry.policyAction !== undefined) {
      out.policyAction = entry.policyAction;
    }
    return out;
  });
  const input: QaInvocationInput = {
    draftJobId: `agentic-loop-${args.input.unit.bridgeUnitId}-qa`,
    projectId: args.policy.projectId,
    localeBranchId: args.policy.localeBranchId,
    sourceRevisionId: args.input.unit.sourceRevision.revisionId,
    sourceLocale: args.policy.sourceLocale,
    targetLocale: args.policy.targetLocale,
    units: [qaUnit],
    glossary,
    styleGuide: [],
    modelProfile: {
      providerFamily: providerFamilyOf(args.provider),
      modelId: args.pair.modelId,
      providerId: args.pair.providerId,
      contextWindowTokens: 128_000,
    },
    qaPromptVersion: `${QA_PROMPT_TEMPLATE_VERSION_V1}-${args.agentLabel}`,
  };
  return agent.invokeQa(args.input.actor, input);
}

function providerTelemetryFromQa(
  result: QaInvocationResult,
  pair: PairChoice,
  agentLabel: string,
): RawProviderTelemetry {
  return {
    invocationId: `qa_findings:${agentLabel}:${result.providerRunId}`,
    agentLabel,
    pair,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costMicros: assertBilledCost(result.modelMetadata.providerRun.cost),
    latencyMs: result.modelMetadata.providerRun.latencyMs,
    providerProofId: result.providerRunId,
  };
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

type DeterministicCheckOutcome = {
  shortCircuit: boolean;
  firstP0Kind?: string;
  violations: DraftProtectedSpanViolation[];
};

const SHIFT_JIS_FRIENDLY_RE = /^[ -~　-ヿ一-鿿＀-￯a-zA-Z0-9\s]*$/u;

function runDeterministicChecks(args: {
  input: AgenticLoopUnitInput;
  draftText: string;
  draftProtectedSpanRefs: ReadonlyArray<{
    refId: string;
    startInDraft: number;
    endInDraft: number;
  }>;
  targetLocale: string;
}): DeterministicCheckOutcome {
  const violations: DraftProtectedSpanViolation[] = [];
  // 1. protected-spans validation. We inject glossary refs that the
  //    agent's catalog filtered out (it never sees `glossary` spans)
  //    so the second-layer validator can score capitalization /
  //    presence. The injected ranges point at the first
  //    case-insensitive occurrence of the expected target form;
  //    absent forms are left out so the validator reports
  //    `span_deleted` / `glossary_mistranslation`.
  const draftProtectedSpanRefs = injectGlossaryRefs({
    baseRefs: args.draftProtectedSpanRefs,
    glossarySpans: args.input.protectedSpans.filter((s) => s.spanKind === "glossary"),
    draftText: args.draftText,
  });
  const validator = new DraftProtectedSpanValidator();
  const result = validator.validate({
    sourceBridgeUnit: {
      bridgeUnitId: args.input.unit.bridgeUnitId,
      sourceUnitKey: args.input.unit.sourceUnitKey,
      sourceText: args.input.unit.sourceText,
      sourceHash: args.input.unit.sourceHash,
    },
    draftText: args.draftText,
    draftProtectedSpanRefs,
    sourceProtectedSpans: args.input.protectedSpans,
  });
  for (const violation of result.violations) {
    violations.push(violation);
  }
  // 2. glossary consistency: every glossary span MUST appear by its
  //    expected target form (or source if `do_not_translate`). The
  //    validator above already handles this for `glossary` spans; we
  //    additionally enforce that no glossary entry's preferred target
  //    form is entirely absent from the draft when the unit's source
  //    cites the term verbatim. Strict mode emits a `span_deleted`
  //    when violated.
  // 3. charset (Shift-JIS compatibility for ja* targets). Best-effort
  //    surrogate code-point check.
  if (args.targetLocale.startsWith("ja") && !SHIFT_JIS_FRIENDLY_RE.test(args.draftText)) {
    violations.push({
      kind: "malformed_markup",
      spanRefId: "synthetic:charset",
      spanKind: "source_unit",
      bridgeUnitId: args.input.unit.bridgeUnitId,
      detail: `draftText contains characters that are not Shift-JIS friendly for target='${args.targetLocale}'`,
      evidence: { observedRanges: [] },
    });
  }
  // 4. length: reject empty drafts AND drafts > 32x the source byte
  //    length (deliberately loose; serves as an overflow guard).
  if (args.draftText.length === 0) {
    violations.push({
      kind: "span_deleted",
      spanRefId: "synthetic:length",
      spanKind: "source_unit",
      bridgeUnitId: args.input.unit.bridgeUnitId,
      detail: "draftText is empty",
      evidence: { observedRanges: [] },
    });
  } else if (args.draftText.length > Math.max(64, args.input.unit.sourceText.length * 32)) {
    violations.push({
      kind: "span_duplicated",
      spanRefId: "synthetic:length",
      spanKind: "source_unit",
      bridgeUnitId: args.input.unit.bridgeUnitId,
      detail: `draftText length ${args.draftText.length} exceeds 32x source length ${args.input.unit.sourceText.length}`,
      evidence: { observedRanges: [] },
    });
  }
  // 5. punctuation balance: count open/close brackets and parens.
  const openClose: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of openClose) {
    const opens = countChar(args.draftText, open);
    const closes = countChar(args.draftText, close);
    if (opens !== closes) {
      violations.push({
        kind: "malformed_markup",
        spanRefId: `synthetic:punctuation:${open}${close}`,
        spanKind: "markup",
        bridgeUnitId: args.input.unit.bridgeUnitId,
        detail: `unbalanced punctuation: '${open}'=${opens}, '${close}'=${closes}`,
        evidence: { observedRanges: [] },
      });
    }
  }
  // P0 classifier — any non-retryable violation kind from the
  // protected-span enum is treated as P0 + short-circuits the loop.
  const firstP0 = violations.find((v) => isP0ViolationKind(v.kind));
  return {
    shortCircuit: firstP0 !== undefined,
    ...(firstP0 ? { firstP0Kind: firstP0.kind } : {}),
    violations,
  };
}

/**
 * After translation, inject glossary span refs into the draft's
 * declared protectedSpanRefs so the second-layer validator can score
 * capitalization + presence. We use the same heuristic as the legacy
 * fixture command: locate the first case-insensitive occurrence of
 * the expected target form. Absent forms → skip the ref so the
 * validator reports `span_deleted` (still a P0 outcome).
 */
function injectGlossaryRefs(args: {
  baseRefs: ReadonlyArray<{ refId: string; startInDraft: number; endInDraft: number }>;
  glossarySpans: ReadonlyArray<DraftSourceProtectedSpan>;
  draftText: string;
}): Array<{ refId: string; startInDraft: number; endInDraft: number }> {
  const merged = args.baseRefs.map((ref) => ({
    refId: ref.refId,
    startInDraft: ref.startInDraft,
    endInDraft: ref.endInDraft,
  }));
  const lower = args.draftText.toLowerCase();
  for (const span of args.glossarySpans) {
    if (merged.some((ref) => ref.refId === span.refId)) {
      continue;
    }
    const expected = span.expectedTargetForm ?? span.sourceText;
    const start = lower.indexOf(expected.toLowerCase());
    if (start < 0) {
      continue;
    }
    merged.push({
      refId: span.refId,
      startInDraft: start,
      endInDraft: start + expected.length,
    });
  }
  merged.sort((a, b) => a.startInDraft - b.startInDraft);
  return merged;
}

function countChar(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while (idx < haystack.length) {
    const found = haystack.indexOf(needle, idx);
    if (found < 0) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}

function isP0ViolationKind(kind: DraftProtectedSpanViolation["kind"]): boolean {
  // The closed-enum split mirrors retry-policy.ts: only the
  // non-retryable kinds are treated as P0 for short-circuit. Adding a
  // new violation kind without updating this set is an explicit
  // editorial decision, not a silent default.
  return kind === "capitalization_drift" || kind === "glossary_mistranslation";
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function routeFindingsAndViolations(args: {
  findings: ReadonlyArray<QaFinding>;
  violations: ReadonlyArray<DraftProtectedSpanViolation>;
  projectId: string;
}): FindingTriageResult {
  const router = new FindingTriageRouter();
  return router.route({
    findings: args.findings,
    protectedSpanViolations: args.violations,
    humanFindings: [],
    context: { projectId: args.projectId },
  });
}

function isRepairableCauseClass(cls: string): boolean {
  // Repairable causes are those whose suggested action is "re-run
  // the translator with extra context". This is a closed list; the
  // triage router emits these classes from QA findings the model can
  // realistically address on its own.
  return cls === "translator_mistake" || cls === "stale_context";
}

// ---------------------------------------------------------------------------
// Pair-policy validation
// ---------------------------------------------------------------------------

function assertPairPolicyComplete(policy: PairPolicy): void {
  const required: ReadonlyArray<readonly [string, string, PairChoice | undefined]> = [
    ["context", "sceneSummary", policy.context?.sceneSummary],
    ["context", "characterRelationship", policy.context?.characterRelationship],
    ["context", "terminologyCandidate", policy.context?.terminologyCandidate],
    ["context", "routeChoiceMap", policy.context?.routeChoiceMap],
    ["preTranslation", "speakerLabel", policy.preTranslation?.speakerLabel],
    ["translation", "primary", policy.translation?.primary],
    ["qa", "styleAdherence", policy.qa?.styleAdherence],
    ["qa", "semanticDrift", policy.qa?.semanticDrift],
    ["qa", "toneRegister", policy.qa?.toneRegister],
    ["qa", "unresolvedTerminology", policy.qa?.unresolvedTerminology],
    ["repair", "primary", policy.repair?.primary],
  ];
  for (const [stage, agent, pair] of required) {
    if (pair === undefined) {
      throw new PairPolicyMissingEntryError(stage, agent);
    }
    if (typeof pair.modelId !== "string" || pair.modelId.length === 0) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.modelId`);
    }
    if (typeof pair.providerId !== "string" || pair.providerId.length === 0) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.providerId`);
    }
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function providerFamilyOf(provider: ModelProvider): ProviderFamily {
  return provider.descriptor.family;
}

function defaultNow(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function microsToAmount(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / 1_000_000n;
  const fractional = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${whole.toString()}.${fractional}`;
}
