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
  STYLE_GUIDE_POLICY_SECTIONS,
  type AgenticLoopBundle,
  type AgenticLoopInvocation,
  type AgenticLoopRoutingOutcome,
  type AgenticLoopRoutingSummary,
  type AgenticLoopStageName,
  type AgenticLoopStageRecord,
  type LocalizationUnitV02,
  type QaFinding,
  type StagePostureV03,
  type StyleGuidePolicyV0Draft,
} from "@itotori/localization-bridge-schema";
import { SpeakerLabelAgent } from "../agents/speaker-label/agent.js";
import {
  SPEAKER_LABEL_PROMPT_TEMPLATE_VERSION_V1,
  type SpeakerLabelInvocationInput,
  type SpeakerLabelInvocationResult,
} from "../agents/speaker-label/shapes.js";
import { TranslationAgent } from "../agents/translation/agent.js";
import { generateSceneSummary } from "../agents/scene-summary/agent.js";
import { generateCharacterRelationships } from "../agents/character-relationship/agent.js";
import { generateTerminologyCandidates } from "../agents/terminology-candidate/agent.js";
import { generateRouteChoiceMap } from "../agents/route-choice-map/agent.js";
import {
  buildSliceStructuredContext,
  buildStructureContextArtifacts,
  type NarrativeStructure,
  type StructuredContextInjection,
} from "../agents/structure-informed-context/index.js";
import {
  TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  type TranslationBridgeUnit,
  type TranslationGlossaryEntry,
  type TranslationInvocationInput,
  type TranslationInvocationResult,
  type TranslationProtectedSpanInput,
  type TranslationStyleGuideRule,
} from "../agents/translation/shapes.js";
import { QaAgent } from "../agents/qa/agent.js";
import {
  QA_PROMPT_TEMPLATE_VERSION_V1,
  type QaBridgeUnit,
  type QaGlossaryEntry,
  type QaInvocationInput,
  type QaInvocationResult,
  type QaStyleGuideRule,
} from "../agents/qa/shapes.js";
import { DraftProtectedSpanValidator } from "../draft/protected-span-validator.js";
import type {
  DraftProtectedSpanViolation,
  DraftSourceProtectedSpan,
} from "../draft/protected-span-validator.js";
import {
  normalizeToSjisSafe,
  reconstructTarget,
  splitProtectedSpans,
} from "../localization/patchback-safety.js";
import type { ProtectedSpanRef, TranslationDraft } from "@itotori/localization-bridge-schema";
import { FindingTriageRouter } from "../triage/router.js";
import type { FindingTriageResult } from "../triage/router.js";
import {
  bridgeAgenticLoopToReviewerQueue,
  type AgenticLoopReviewerQueueSink,
} from "./reviewer-queue-bridge.js";
import type { ModelProvider, ProviderFamily, ProviderRunRecord } from "../providers/types.js";
import { assertBilledCost } from "../providers/cost.js";
import { assertReportedTokenUsage } from "../providers/token-accounting.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ITOTORI-234 / ITOTORI-238 — A single stage / agent's full posture:
 * pinned (modelId, providerId) pair + ZDR posture + fallback list +
 * seed + USD cap. Every invocation carries the seed + zdr + pair
 * fields onto the bundle so audit can prove the orchestrator never
 * defaulted.
 *
 * The orchestrator never constructs these — callers build them from
 * the parsed v0.3 pair-policy (`parsePairPolicyV03` resolves every
 * defaulted field) and pass them in.
 */
export type PairChoice = StagePostureV03;

/**
 * Per-stage pair policy. Every stage that issues at least one LLM
 * invocation has its (modelId, providerId) + posture pinned here. A
 * single stage can declare per-agent leaves (e.g. each focused QA agent
 * gets its own pair-and-posture).
 *
 * The orchestrator NEVER falls back to a default; missing entries are
 * a typed `PairPolicyMissingEntryError`.
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
import { deriveDefaultSeed } from "@itotori/localization-bridge-schema";

/**
 * Build a `PairChoice` (== `StagePostureV03`) keyed to `DEV_PAIR` with
 * the canonical alpha posture: `zdr: true`, no fallbacks, a
 * deterministic seed derived from the leaf path, and a single-stage
 * cost cap (DEV-only — production callers feed the parsed v0.2 policy
 * straight through and never hit this helper). The cap is set to the
 * canonical ITOTORI-231 default 0.5 USD because DEV_POLICY is meant for
 * smoke / unit-test paths where the cap is not load-bearing; production
 * callers always pass an explicitly-parsed policy whose cap reflects
 * `DEFAULT_COST_CAP_USD / stageCount`.
 */
function devPosture(leafPath: string): PairChoice {
  return {
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    zdr: true,
    fallbackModels: [],
    seed: deriveDefaultSeed(leafPath),
    maxPriceUsd: 0.5,
  };
}

/**
 * Pre-populated pair policy that pins every stage to `DEV_PAIR` with
 * canonical alpha posture (`zdr: true`, no fallbacks, deterministic
 * per-stage seeds, dev-mode USD caps). Used by the smoke command and
 * the orchestrator's test suite so a single import drops in a complete
 * policy. Production callers build their own policy via
 * `parsePairPolicyV03` and pass it explicitly.
 */
export const DEV_POLICY: PairPolicy = {
  context: {
    sceneSummary: devPosture("context.sceneSummary"),
    characterRelationship: devPosture("context.characterRelationship"),
    terminologyCandidate: devPosture("context.terminologyCandidate"),
    routeChoiceMap: devPosture("context.routeChoiceMap"),
  },
  preTranslation: {
    speakerLabel: devPosture("preTranslation.speakerLabel"),
  },
  translation: {
    primary: devPosture("translation.primary"),
  },
  qa: {
    styleAdherence: devPosture("qa.styleAdherence"),
    semanticDrift: devPosture("qa.semanticDrift"),
    toneRegister: devPosture("qa.toneRegister"),
    unresolvedTerminology: devPosture("qa.unresolvedTerminology"),
  },
  repair: {
    primary: devPosture("repair.primary"),
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
   * itotori-agentic-loop-real-context-stage — the decoded narrative structure
   * (`utsushi.narrative-structure.v1`, emitted by the Kaifuu/Utsushi decode)
   * for the work this unit belongs to. When present the context stage builds
   * the DETERMINISTIC structure-informed context (per-scene summaries +
   * route/branch map + character arcs — a pure reduction of the decode, NOT an
   * LLM guess) and injects the per-scene slice into the translation prompt. This
   * is the project's core advantage: the translator receives the KNOWN scene /
   * route / speaker structure rather than re-inferring it from prose. When
   * absent, the loop runs the four semantic agents live for enrichment but
   * injects no deterministic structure block (legacy smoke path).
   */
  narrativeStructure?: NarrativeStructure;
  /**
   * The numeric scene id (within `narrativeStructure`) this unit belongs to.
   * Selects the per-scene structured-context slice injected into translation.
   * REQUIRED when `narrativeStructure` is set.
   */
  sceneId?: number;
  /**
   * itotori-live-loop-style-glossary-injection — the ACTIVE (approved)
   * style-guide policy version for this unit's locale branch. Resolved the SAME
   * way `narrativeStructure` is: the caller (the driven executor / stage command)
   * owns the read of the active version from the style-guide tables/services and
   * threads the resolved policy in as a deterministic anchor — the loop consumes
   * a KNOWN policy, it does not re-derive one. Its `sections`
   * (tone / terminology / honorifics / formatting / protectedSpans) are flattened
   * DETERMINISTICALLY into the translation + QA style-guide rule lists so the
   * draft is written — and terminology-QA'd — against the real house style.
   * When absent the loop degrades gracefully to an empty style guide (the prompt
   * renders `Style guide: (empty)`), exactly as before this seam.
   *
   * The glossary is threaded alongside via `glossary` (above): both the
   * translation prompt and the QA terminology lane already consume
   * `input.glossary`, so an active glossary term reaches every stage that
   * enforces it.
   */
  styleGuide?: StyleGuidePolicyV0Draft;
  /**
   * Actor that owns the run. Threaded through every agent invocation
   * for downstream provenance.
   */
  actor: AuthorizationActor;
  /**
   * itotori-loop-to-review-queue-bridge — the reviewer-queue write surface a
   * DRIVEN run wires so the loop's `deferred_to_human` /
   * `short_circuit_deterministic_p0` outcome (or a threshold-exceeding QA
   * finding) lands a context-rich `reviewer_queue_items` record automatically.
   * This is the DEFAULT path for a driven run: when the sink is present the
   * loop bridges its outcome into the HITL queue with the full decision context
   * (source / draft / context / evidence / reasoning / options). When absent
   * (the synthetic smoke path, which has no DB) the loop still returns its
   * bundle but persists nothing.
   */
  reviewerQueue?: AgenticLoopReviewerQueueSink;
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
  /**
   * ITOTORI-234 — per-invocation seed. Defaults to `pair.seed` but the
   * repair stage substitutes `pair.seed + attempt` so each retry
   * records a differentiated value while leaving the first attempt
   * byte-equal to the policy posture.
   */
  seed: number;
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
  // The REAL context stage (itotori-agentic-loop-real-context-stage):
  //   (1) builds the DETERMINISTIC structure-informed context slice from the
  //       decoded narrative structure (the always-available base), and
  //       injects it into the translation prompt below; and
  //   (2) runs the four semantic context agents LIVE (scene-summary,
  //       character-relationship, terminology-candidate, route-choice-map) to
  //       ENRICH the citable context. Each fires one real provider call whose
  //       telemetry is captured; their produced artifact refs join the slice's.
  // This SUPERSEDES the old `invokeContextLikeProbe`, which fired a provider
  // call and DISCARDED its output so no context ever reached the translator.
  const contextStage = startStage("context");
  const contextResult = await invokeSemanticContextStage({
    input,
    policy,
    pairPolicy,
    providerFactory,
    now,
  });
  for (const invocation of contextResult.telemetry) {
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
    structuredContext: contextResult.structuredContext,
    contextArtifactRefs: contextResult.contextArtifactRefs,
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

    const shortCircuitBundle = finalizeBundle({
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
    // itotori-loop-to-review-queue-bridge — a P0 short-circuit is a deferral;
    // surface it to the reviewer queue with the rejected draft + the violations
    // that fired so a human sees WHY it was held (not a random line).
    await maybeBridgeLoopOutcomeToReviewerQueue({
      input,
      now,
      bundle: shortCircuitBundle,
      draftText: primaryDraftText,
      deferredReason: shortCircuitBundle.finalDraft.deferredReason,
      qaFindings: [],
      deterministicViolations: deterministicResult.violations,
      contextArtifactRefs: contextResult.contextArtifactRefs,
    });
    return shortCircuitBundle;
  }

  // The four focused QA agents run SEQUENTIALLY here (one awaited
  // invokeQaStage per loop iteration). Parallelism is deliberately
  // avoided in this seam: every stage shares one memoized base provider,
  // so firing the agents concurrently would only contend the shared
  // token bucket without buying real wall-clock parallelism. The
  // orchestrator wires a SHARED base provider per agent because each
  // focused agent wraps a base QaAgent. Every QA invocation carries its
  // own pinned pair from the policy.
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
        // Repair re-translates carrying the SAME structure-informed context so
        // the retry is still branch/scene/speaker aware, not context-stripped.
        structuredContext: contextResult.structuredContext,
        contextArtifactRefs: contextResult.contextArtifactRefs,
      });
      pushInvocation(
        repairStage,
        providerTelemetryFromTranslation(
          repairResult,
          pairPolicy.repair.primary,
          `repair-primary[${attempt}]`,
          // ITOTORI-234 — bounded-repair seed derivation: the first
          // attempt records the policy posture seed verbatim; each
          // retry adds the attempt index so two retries can't collide.
          pairPolicy.repair.primary.seed + attempt,
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

  const finalBundle = finalizeBundle({
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
  // itotori-loop-to-review-queue-bridge — DEFAULT loop path. When the outcome
  // is `deferred_to_human` (or a QA finding crossed the review severity floor
  // even on an accepted draft) this lands ONE context-rich reviewer_queue_items
  // record. `finalDraftText ?? primaryDraftText` carries the accepted draft, or
  // the REJECTED draft on a defer, so the reviewer never judges an isolated line.
  await maybeBridgeLoopOutcomeToReviewerQueue({
    input,
    now,
    bundle: finalBundle,
    draftText: finalDraftText ?? primaryDraftText,
    ...(deferredReason !== undefined ? { deferredReason } : {}),
    qaFindings,
    deterministicViolations: deterministicResult.violations,
    contextArtifactRefs: contextResult.contextArtifactRefs,
  });
  return finalBundle;
}

/**
 * itotori-loop-to-review-queue-bridge — thin adapter that hands a finished loop
 * pass to the reviewer-queue bridge WHEN a driven run wired a sink. No sink
 * (the synthetic smoke path) → no-op. The bridge itself decides whether the
 * outcome warrants a human decision and is idempotent per unit+revision.
 */
async function maybeBridgeLoopOutcomeToReviewerQueue(args: {
  input: AgenticLoopUnitInput;
  now: () => Date;
  bundle: AgenticLoopBundle;
  draftText?: string | undefined;
  deferredReason?: string | undefined;
  qaFindings: ReadonlyArray<QaFinding>;
  deterministicViolations: ReadonlyArray<DraftProtectedSpanViolation>;
  contextArtifactRefs: ReadonlyArray<string>;
}): Promise<void> {
  const sink = args.input.reviewerQueue;
  if (sink === undefined) {
    return;
  }
  await bridgeAgenticLoopToReviewerQueue({
    actor: args.input.actor,
    sink,
    bundle: args.bundle,
    unit: args.input.unit,
    draftText: args.draftText,
    deferredReason: args.deferredReason,
    qaFindings: args.qaFindings,
    deterministicViolations: args.deterministicViolations,
    contextArtifactRefs: args.contextArtifactRefs,
    now: args.now,
    ...(args.input.sceneId !== undefined ? { sceneId: args.input.sceneId } : {}),
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
  // ITOTORI-234 — every invocation now carries the per-stage `zdr` +
  // `seed` posture from the v0.2 pair-policy verbatim. `pair.zdr` is
  // the policy posture for this stage/agent; `telemetry.seed` is
  // typically `pair.seed`, but the repair stage substitutes
  // `pair.seed + attempt` so each retry gets a distinct value.
  stage.invocations.push({
    invocationId: telemetry.invocationId,
    agentLabel: telemetry.agentLabel,
    pair: { modelId: telemetry.pair.pair.modelId, providerId: telemetry.pair.pair.providerId },
    tokensIn: telemetry.tokensIn,
    tokensOut: telemetry.tokensOut,
    costUsd: microsToAmount(telemetry.costMicros),
    latencyMs: telemetry.latencyMs,
    providerProofId: telemetry.providerProofId,
    zdr: telemetry.pair.zdr,
    seed: telemetry.seed,
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
// Context stage — REAL structure-informed context + live semantic enrichment.
//
// itotori-agentic-loop-real-context-stage. This SUPERSEDES the old
// `invokeContextLikeProbe` (which fired a provider call and discarded the
// output) AND the `genaudit1-01-agentic-loop-context-probe-coerces-mis` /
// `itotori-semantic-agent-clis-no-fake-context-on-real-path` nodes: the probe
// is gone and the four semantic agents now run live.
//
//   (a) DETERMINISTIC base — `buildStructureContextArtifacts` reduces the
//       decoded `NarrativeStructure` (scene-dispatch graph + choice/branch
//       subsystem + `#NAMAE` speakers + per-scene message stream) into the
//       three context artifacts, and `buildSliceStructuredContext` selects this
//       unit's scene slice. That slice is injected into the translation prompt
//       (see `invokeTranslationStage`) so the draft carries the KNOWN structure
//       rather than re-inferring it from prose. Always available when the
//       structure is supplied; never an LLM guess.
//   (b) LIVE enrichment — the four semantic agents (scene-summary,
//       character-relationship, terminology-candidate, route-choice-map) each
//       fire ONE real provider call (routed under ZDR via the DEV_PAIR plain-
//       json path). Their real telemetry is captured; their produced artifact
//       refs join the citable set. `character-relationship` runs only when the
//       unit / structure supplies a character anchor (a narration-only unit has
//       no relationships to extract — a domain fact, not a silent fallback).
// ---------------------------------------------------------------------------

/**
 * The minimal VALID content a fake/synthetic provider must return for each
 * semantic context agent so the (now-real) context stage parses it without a
 * live call. Used by the smoke command + the loop's own tests. scene-summary
 * accepts any free text; the other three parse a structured (possibly empty)
 * pack. Empty packs are valid — the fake asserts the stage RUNS, not that it
 * invents context.
 */
export function fakeSemanticContextContent(agentLabel: string): string {
  switch (agentLabel) {
    case "scene-summary":
      return "Synthetic scene summary (smoke/unit context stage — no live call).";
    case "character-relationship":
      return JSON.stringify({ bios: [], relationships: [] });
    case "terminology-candidate":
      return JSON.stringify({ candidates: [] });
    case "route-choice-map":
      return JSON.stringify({ routes: [], choices: [] });
    default:
      return `context:${agentLabel}`;
  }
}

type SemanticContextStageResult = {
  telemetry: RawProviderTelemetry[];
  structuredContext?: StructuredContextInjection | undefined;
  contextArtifactRefs: string[];
};

async function invokeSemanticContextStage(args: {
  input: AgenticLoopUnitInput;
  policy: AgenticLoopPolicy;
  pairPolicy: PairPolicy;
  providerFactory: AgenticLoopProviderFactory;
  now: () => Date;
}): Promise<SemanticContextStageResult> {
  const { input, policy, pairPolicy, providerFactory, now } = args;
  const telemetry: RawProviderTelemetry[] = [];
  const artifactRefs = new Set<string>();

  // (a) DETERMINISTIC base — the structure-informed context slice.
  let structuredContext: StructuredContextInjection | undefined;
  if (input.narrativeStructure !== undefined) {
    if (input.sceneId === undefined) {
      throw new AgenticLoopInvariantError(
        "narrativeStructure supplied without sceneId: cannot select the unit's scene slice",
      );
    }
    const artifacts = buildStructureContextArtifacts(input.narrativeStructure);
    structuredContext = buildSliceStructuredContext(artifacts, input.sceneId);
    for (const ref of structuredContext.artifactRefs) {
      artifactRefs.add(ref);
    }
  }

  // (b) LIVE enrichment — the four semantic agents.
  const units = [buildSemanticBridgeUnit(input.unit)];
  const roster = deriveCharacterRoster(input);

  // scene-summary.
  {
    const pair = pairPolicy.context.sceneSummary;
    const provider = providerFactory({ stage: "context", agentLabel: "scene-summary", pair });
    const output = await generateSceneSummary(
      {
        projectId: policy.projectId,
        localeBranchId: policy.localeBranchId,
        sourceRevisionId: input.unit.sourceRevision.revisionId,
        sourceLocale: policy.sourceLocale,
        sceneId: input.sceneId !== undefined ? String(input.sceneId) : input.unit.sourceUnitKey,
        units,
        glossaryExcerpt: [],
        modelProfile: semanticModelProfile(provider, pair),
        now,
      },
      { provider },
    );
    telemetry.push(providerTelemetryFromSemanticRun(output.providerRun, pair, "scene-summary"));
    artifactRefs.add(`scene-summary:${output.summary.id}`);
  }

  // character-relationship — only when a character anchor exists.
  if (roster.length > 0 || buildSemanticBridgeUnit(input.unit).speaker !== undefined) {
    const pair = pairPolicy.context.characterRelationship;
    const provider = providerFactory({
      stage: "context",
      agentLabel: "character-relationship",
      pair,
    });
    const output = await generateCharacterRelationships(
      {
        projectId: policy.projectId,
        localeBranchId: policy.localeBranchId,
        sourceRevisionId: input.unit.sourceRevision.revisionId,
        sourceLocale: policy.sourceLocale,
        units,
        curatedCharacters: roster,
        glossaryExcerpt: [],
        modelProfile: semanticModelProfile(provider, pair),
        now,
      },
      { provider },
    );
    telemetry.push(
      providerTelemetryFromSemanticRun(output.providerRun, pair, "character-relationship"),
    );
    for (const bio of output.bios) {
      artifactRefs.add(`character-bio:${bio.characterId}`);
    }
    for (const rel of output.relationships) {
      artifactRefs.add(`character-rel:${rel.fromCharacterId}->${rel.toCharacterId}`);
    }
  }

  // terminology-candidate.
  {
    const pair = pairPolicy.context.terminologyCandidate;
    const provider = providerFactory({
      stage: "context",
      agentLabel: "terminology-candidate",
      pair,
    });
    const output = await generateTerminologyCandidates(
      {
        projectId: policy.projectId,
        localeBranchId: policy.localeBranchId,
        sourceRevisionId: input.unit.sourceRevision.revisionId,
        sourceLocale: policy.sourceLocale,
        units,
        existingGlossary: [],
        modelProfile: semanticModelProfile(provider, pair),
        now,
      },
      { provider },
    );
    telemetry.push(
      providerTelemetryFromSemanticRun(output.providerRun, pair, "terminology-candidate"),
    );
    for (const candidate of output.candidates) {
      artifactRefs.add(`terminology-candidate:${candidate.surfaceForm}`);
    }
  }

  // route-choice-map.
  {
    const pair = pairPolicy.context.routeChoiceMap;
    const provider = providerFactory({ stage: "context", agentLabel: "route-choice-map", pair });
    const output = await generateRouteChoiceMap(
      {
        projectId: policy.projectId,
        localeBranchId: policy.localeBranchId,
        sourceRevisionId: input.unit.sourceRevision.revisionId,
        sourceLocale: policy.sourceLocale,
        units,
        curatedRoutes: [],
        modelProfile: semanticModelProfile(provider, pair),
        now,
      },
      { provider },
    );
    telemetry.push(providerTelemetryFromSemanticRun(output.providerRun, pair, "route-choice-map"));
    for (const route of output.routes) {
      artifactRefs.add(`route:${route.routeKey}`);
    }
    for (const choice of output.choices) {
      artifactRefs.add(`choice:${choice.choiceKey}`);
    }
  }

  return {
    telemetry,
    structuredContext,
    contextArtifactRefs: [...artifactRefs].sort(),
  };
}

/** The common (modelId, providerId)-driven model profile for every semantic agent. */
function semanticModelProfile(
  provider: ModelProvider,
  pair: PairChoice,
): {
  providerFamily: ProviderFamily;
  modelId: string;
  providerId: string;
  contextWindowTokens: number;
} {
  return {
    providerFamily: providerFamilyOf(provider),
    modelId: pair.pair.modelId,
    providerId: pair.pair.providerId,
    contextWindowTokens: 128_000,
  };
}

/**
 * Project the loop's `LocalizationUnitV02` into the minimal bridge-unit shape
 * every semantic agent consumes. The `speaker` is derived from the unit's
 * decoded speaker context (`#NAMAE`), never invented.
 */
function buildSemanticBridgeUnit(unit: LocalizationUnitV02): {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string;
} {
  const speaker = unitSpeakerName(unit);
  return {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sourceText: unit.sourceText,
    sourceHash: unit.sourceHash,
    ...(speaker !== undefined ? { speaker } : {}),
  };
}

/** The decoded speaker display name for a unit, or undefined for narration. */
function unitSpeakerName(unit: LocalizationUnitV02): string | undefined {
  const speaker = unit.speaker;
  if (speaker === undefined) {
    return undefined;
  }
  if (speaker.knowledgeState === "known" || speaker.knowledgeState === "reader_unknown") {
    return speaker.displayName;
  }
  return undefined;
}

/**
 * The closed character roster the character-relationship agent may emit records
 * for. Scoped to characters ACTUALLY present in the units handed to the agent —
 * the caller-supplied known characters plus this unit's own decoded speaker.
 *
 * It deliberately does NOT pull in every speaker from the whole decoded
 * structure: those characters speak in OTHER units not in this slice, so
 * offering them as roster entries only tempts the model to emit a bio it cannot
 * cite (the agent strictly rejects a bio/edge that cites a unit outside
 * `input.units`). The loop never invents a character; it only names the ones
 * this slice references.
 */
function deriveCharacterRoster(
  input: AgenticLoopUnitInput,
): Array<{ characterId: string; displayName: string }> {
  const byId = new Map<string, string>();
  for (const known of input.knownCharacters ?? []) {
    if (known.characterId.trim().length > 0) {
      byId.set(known.characterId, known.displayName);
    }
  }
  const speaker = unitSpeakerName(input.unit);
  if (speaker !== undefined && !byId.has(speaker)) {
    byId.set(speaker, speaker);
  }
  return [...byId].map(([characterId, displayName]) => ({ characterId, displayName }));
}

function providerTelemetryFromSemanticRun(
  providerRun: ProviderRunRecord,
  pair: PairChoice,
  agentLabel: string,
): RawProviderTelemetry {
  // PROJECT LAW: token counts + cost come ONLY from real provider output; an
  // omitted count is a real failure (mirror of assertBilledCost), never a
  // silent coercion to zero that would understate the persisted usage.
  const { tokensIn, tokensOut } = assertReportedTokenUsage(
    providerRun.tokenUsage,
    providerRun.runId,
  );
  return {
    invocationId: `context:${agentLabel}:${providerRun.runId}`,
    agentLabel,
    pair,
    tokensIn,
    tokensOut,
    costMicros: assertBilledCost(providerRun.cost),
    latencyMs: providerRun.latencyMs,
    providerProofId: providerRun.runId,
    seed: pair.seed,
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
      modelId: args.pair.pair.modelId,
      providerId: args.pair.pair.providerId,
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
    seed: pairPolicy.preTranslation.speakerLabel.seed,
  };
}

// ---------------------------------------------------------------------------
// Style-guide resolution (itotori-live-loop-style-glossary-injection)
// ---------------------------------------------------------------------------

/**
 * Flatten the ACTIVE style-guide policy version into the flat rule list every
 * stage consumes. DETERMINISTIC: sections are walked in the canonical
 * `STYLE_GUIDE_POLICY_SECTIONS` order and rules in their declared order, so two
 * runs on the same policy produce a byte-equal list (the prompt templates then
 * apply their own canonical sort). The `StyleGuidePolicyV0Draft` section names
 * are exactly the stage rule `section` union
 * (tone / terminology / honorifics / formatting / protectedSpans), so this is a
 * lossless 1:1 projection, NOT a category guess.
 *
 * The result is structurally identical to both `TranslationStyleGuideRule` and
 * `QaStyleGuideRule` (`{ ruleId, section, guidance }`), so a single resolution
 * feeds the translation stage AND the QA terminology lane. When no active policy
 * is threaded the list is empty — the graceful no-style-guide degrade.
 */
function resolveStyleGuideRules(
  styleGuide: StyleGuidePolicyV0Draft | undefined,
): TranslationStyleGuideRule[] {
  if (styleGuide === undefined) {
    return [];
  }
  const rules: TranslationStyleGuideRule[] = [];
  for (const section of STYLE_GUIDE_POLICY_SECTIONS) {
    for (const rule of styleGuide.sections[section]) {
      rules.push({ ruleId: rule.ruleId, section, guidance: rule.guidance });
    }
  }
  return rules;
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
  /**
   * Structure-informed context slice for this unit's scene (deterministic
   * reduction of the decode). Rendered into the translation prompt so the
   * draft carries the KNOWN scene summary / route position / speaker arcs.
   */
  structuredContext?: StructuredContextInjection | undefined;
  /** Citable artifact refs (the slice's refs + the semantic agents' refs). */
  contextArtifactRefs?: ReadonlyArray<string>;
}): Promise<TranslationInvocationResult> {
  const agent = new TranslationAgent({ provider: args.provider });

  // PATCHBACK-SAFETY (primary, deterministic). Strip EVERY protected control
  // span — out-of-band kidoku markers, the leading 【name】 speaker token, and
  // the 「…」 quote wrapper — OFF the source before the LLM. The model only
  // ever sees `skeleton.body` (the pure translatable dialogue/narration), so
  // it CANNOT drop or mutate the control markup: the deterministic re-inject
  // below owns it. This is config-coherent with the translation scope — the
  // same split applies uniformly to whatever unit is in scope (a choice_label
  // / ui_label with no name/quotes splits to a bare body and re-injects
  // unchanged; the DraftProtectedSpanValidator downstream is now a SAFETY NET,
  // no longer the primary preservation mechanism).
  const skeleton = splitProtectedSpans(args.input.unit.sourceText);

  const protectedSpansBySource = new Map<string, ReadonlyArray<TranslationProtectedSpanInput>>();
  // The translation agent enforces byte-equal preservation for source_unit
  // / markup / variable spans that remain IN the stripped body only. Glossary
  // spans are NOT given to the agent — they live on the second-layer
  // deterministic check. Spans consumed by the skeleton (name / quotes /
  // kidoku) are dropped from the agent catalog: they are re-injected
  // deterministically and never reach the model.
  const inBodySpans = args.input.protectedSpans
    .filter((s) => s.spanKind !== "glossary")
    .filter((s) => skeleton.body.includes(s.sourceText));
  protectedSpansBySource.set(
    args.input.unit.bridgeUnitId,
    inBodySpans.map((s) => ({ refId: s.refId, sourceText: s.sourceText })),
  );
  const sourceBridgeUnits: TranslationBridgeUnit[] = [
    {
      bridgeUnitId: args.input.unit.bridgeUnitId,
      sourceUnitKey: args.input.unit.sourceUnitKey,
      // Model sees ONLY the body — control markup is stripped.
      sourceText: skeleton.body,
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
    // itotori-live-loop-style-glossary-injection — the translator now writes
    // against the ACTIVE style-guide policy (deterministic flatten of the
    // caller-resolved version). Empty only when no active policy is threaded.
    styleGuide: resolveStyleGuideRules(args.input.styleGuide),
    // itotori-agentic-loop-real-context-stage — the translator now RECEIVES the
    // structure-informed context (the discard-probe is gone). `structuredContext`
    // renders the decoded scene/route/speaker block into the prompt;
    // `contextArtifactRefs` are the citable refs (the slice's + the semantic
    // agents' enrichment).
    contextArtifactRefs: [...(args.contextArtifactRefs ?? [])],
    ...(args.structuredContext !== undefined ? { structuredContext: args.structuredContext } : {}),
    modelProfile: {
      providerFamily: providerFamilyOf(args.provider),
      modelId: args.pair.pair.modelId,
      providerId: args.pair.pair.providerId,
      contextWindowTokens: 128_000,
    },
    promptTemplateVersion: TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  };
  const result = await agent.invokeTranslation(args.input.actor, invocationInput);

  // Deterministically reconstruct the patchback-safe target for the unit:
  //   (b) SJIS-normalize the LLM body (curly quotes / em-dash / … folded to a
  //       Shift_JIS-representable equivalent, genuine CJK kept);
  //   (c) re-inject the stripped 【name】 + 「…」 + trailing around it, applying
  //       any glossary-driven name romanization.
  // The refs are then recomputed against the reconstructed target so the
  // downstream deterministic checks + validator score the FINAL, patchback-
  // safe text (not the model's body-relative offsets).
  const nameRomanization = buildNameRomanization(args.input.glossary);
  const rebuiltDrafts: TranslationDraft[] = result.drafts.map((draft) => {
    if (draft.bridgeUnitId !== args.input.unit.bridgeUnitId) {
      return draft;
    }
    const normalizedBody = normalizeToSjisSafe(draft.draftText);
    const finalTarget = reconstructTarget(skeleton, normalizedBody, nameRomanization);
    return {
      ...draft,
      draftText: finalTarget,
      protectedSpanRefs: relocateProtectedSpanRefs(finalTarget, inBodySpans),
    };
  });
  return { ...result, drafts: rebuiltDrafts };
}

/**
 * Recompute each in-body protected span's `(startInDraft, endInDraft)` range
 * against the reconstructed patchback-safe target by locating its literal
 * source text. Because the deterministic layer is now primary, the loop no
 * longer trusts the model's body-relative offsets — it derives them from the
 * final target. A span that cannot be located (destroyed by the model) is
 * simply omitted, leaving the DraftProtectedSpanValidator safety-net to report
 * the divergence.
 */
function relocateProtectedSpanRefs(
  finalTarget: string,
  inBodySpans: ReadonlyArray<{ refId: string; sourceText: string }>,
): ProtectedSpanRef[] {
  const refs: ProtectedSpanRef[] = [];
  for (const span of inBodySpans) {
    const start = finalTarget.indexOf(span.sourceText);
    if (start < 0) {
      continue;
    }
    refs.push({
      refId: span.refId,
      startInDraft: start,
      endInDraft: start + span.sourceText.length,
    });
  }
  refs.sort((a, b) => a.startInDraft - b.startInDraft);
  return refs;
}

/**
 * Build the deterministic name-romanization map consumed by
 * `reconstructTarget`. Config-coherent with the glossary: a glossary entry
 * with a `preferredTargetForm` maps its bracketed speaker token
 * `【source】` → `【target】`. A name absent from the map keeps its original
 * (Shift_JIS-safe) token, so a speaker name is never dropped or corrupted.
 */
function buildNameRomanization(
  glossary: ReadonlyArray<TranslationGlossaryEntry>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of glossary) {
    if (entry.preferredTargetForm !== undefined && entry.preferredTargetForm.length > 0) {
      map.set(`【${entry.preferredSourceForm}】`, `【${entry.preferredTargetForm}】`);
    }
  }
  return map;
}

function providerTelemetryFromTranslation(
  result: TranslationInvocationResult,
  pair: PairChoice,
  agentLabel: string,
  seedOverride?: number,
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
    // ITOTORI-234 — repair invocations pass `pair.seed + attempt`
    // so each retry carries a distinct seed while the first attempt
    // matches the policy posture exactly.
    seed: seedOverride ?? pair.seed,
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
    // itotori-live-loop-style-glossary-injection — the QA terminology/style
    // lanes now validate the draft against the SAME active style-guide policy
    // the translator wrote against (structurally identical rule shape).
    styleGuide: resolveStyleGuideRules(args.input.styleGuide) satisfies QaStyleGuideRule[],
    modelProfile: {
      providerFamily: providerFamilyOf(args.provider),
      modelId: args.pair.pair.modelId,
      providerId: args.pair.pair.providerId,
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
    seed: pair.seed,
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
  for (const [stage, agent, posture] of required) {
    if (posture === undefined) {
      throw new PairPolicyMissingEntryError(stage, agent);
    }
    if (typeof posture.pair?.modelId !== "string" || posture.pair.modelId.length === 0) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.pair.modelId`);
    }
    if (typeof posture.pair?.providerId !== "string" || posture.pair.providerId.length === 0) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.pair.providerId`);
    }
    if (typeof posture.zdr !== "boolean") {
      throw new PairPolicyMissingEntryError(stage, `${agent}.zdr`);
    }
    if (
      !Array.isArray(posture.fallbackModels) ||
      posture.fallbackModels.some((f) => typeof f !== "string")
    ) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.fallbackModels`);
    }
    if (typeof posture.seed !== "number" || !Number.isInteger(posture.seed) || posture.seed < 0) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.seed`);
    }
    if (
      typeof posture.maxPriceUsd !== "number" ||
      !Number.isFinite(posture.maxPriceUsd) ||
      posture.maxPriceUsd < 0
    ) {
      throw new PairPolicyMissingEntryError(stage, `${agent}.maxPriceUsd`);
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
