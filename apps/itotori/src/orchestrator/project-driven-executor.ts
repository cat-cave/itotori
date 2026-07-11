// itotori-project-level-driven-executor (P0 — LAST pre-pilot seam).
//
// Turns the at-scale plumbing proof into a REAL driven pilot. Before this
// module only a SINGLE-unit live driver existed
// (`runLocalizeProjectStageCommand`) plus a batch PLANNER that GROUPS units
// (`planBatches`) — but nothing ran a whole game (or a bounded slice of it)
// THROUGH the agentic loop and PERSISTED the results. This is that executor.
//
// What it does, per driven run:
//   (a) ENUMERATES the in-scope units for a project/game. The batch PLANNER
//       (`planBatches`) groups the bridge units by scene/route; the executor
//       consumes that grouping and drives each in-scope unit in canonical
//       order. Config-driven scope (dialogue / +choices / +ui / …) filters
//       which units are in scope — everything outside scope is a byte no-op
//       on the patch export, per the config-driven patchback contract.
//   (b) runs `runAgenticLoopForUnit` PER unit WITH the REAL structure-informed
//       context (the decoded `narrativeStructure` + the unit's `sceneId`, per
//       P0#1) AND the `reviewerQueue` DB sink wired (per P0#2) so every
//       deferral / threshold-finding PERSISTS as a `reviewer_queue_items`
//       record automatically.
//   (c) PERSISTS, per unit: the draft outcome, a provider-run summary carrying
//       the REAL total `usage.cost` + ZDR posture (summed verbatim from the
//       bundle's per-invocation telemetry — PROJECT LAW: cost only from real
//       provider output), and — via the loop's own bridge — the
//       reviewer_queue_items.
//   (d) produces ONE patch EXPORT for the ACCEPTED drafts (the translated
//       bridge bundle + a deterministic patch report), byte-correct per the
//       config-driven scope (accepted units carry the real translated body;
//       deferred / out-of-scope units keep `target === source` — a byte no-op
//       the patchback collapses to zero edits).
//
// Robustness (a pilot runs many units): a SINGLE unit's failure — including a
// live semantic-agent malformed pack (the filed P2) — MUST NOT abort the whole
// run. The executor records the failure and continues (per-unit isolation).
//
// Config-driven scope + the (modelId, providerId) pinning + ZDR all flow
// through the loop UNCHANGED: the executor never re-derives a pair, never
// downgrades ZDR, never widens scope — it threads the caller's parsed policy
// into every `runAgenticLoopForUnit` call verbatim.

import { createHash } from "node:crypto";
import type {
  AuthorizationActor,
  CreateReviewerQueueItemInput,
  ItotoriTerminologyCandidateRepositoryPort,
  ReviewerQueueItemRecord,
} from "@itotori/db";
import { ReviewerQueueRepositoryError, reviewerQueueItemStateValues } from "@itotori/db";
import type {
  AgenticLoopBundle,
  BridgeBundleV02,
  LocalizationUnitV02,
  StyleGuidePolicyV0Draft,
} from "@itotori/localization-bridge-schema";
import type { PriorPassFeedback } from "../agents/translation/shapes.js";
import { planBatches } from "../batch-planner/planner.js";
import { resolveModelProfile } from "../batch-planner/model-profiles.js";
import type { NarrativeStructure } from "../agents/structure-informed-context/index.js";
import type {
  TranslationGlossaryEntry,
  TranslationWorkScopeContext,
} from "../agents/translation/shapes.js";
import type { EffectiveScope } from "../agents/work-scope/index.js";
import type { AgenticLoopReviewerQueueSink } from "./reviewer-queue-bridge.js";
import {
  AgenticLoopInvariantError,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "./agentic-loop.js";
import {
  bracketWrapForRealLive,
  stripOutOfBandControlMarkup,
} from "./localize-project-stage-command.js";
import { buildPipelineUnitFailureDiagnostic } from "./pipeline-failure-diagnostic.js";
import type { PipelineUnitFailureDiagnostic } from "./pipeline-failure-diagnostic.js";
import type { WholeGameRenderValidationResult } from "./wholegame-render-validation-seam.js";

// ---------------------------------------------------------------------------
// Config-driven translation scope
// ---------------------------------------------------------------------------

/**
 * The config-driven translation scope tiers. itotori translates as much as the
 * USER CONFIGURES — dialogue-only, then choices, then UI. `all` is every
 * surface. The scope selects which bridge units are IN SCOPE for the driven
 * run; out-of-scope units are a byte no-op on the patch export (their
 * `target === source`), so the patchback stays byte-correct for whatever the
 * config declares.
 */
export type TranslationScope =
  | "dialogue-only"
  | "dialogue-and-choices"
  | "dialogue-choices-ui"
  | "all";

const DIALOGUE_SURFACE_KINDS: ReadonlySet<string> = new Set(["dialogue", "monologue", "narration"]);
const CHOICE_SURFACE_KINDS: ReadonlySet<string> = new Set([
  "choice_prompt",
  "choice_label",
  "choice",
]);
const UI_SURFACE_KINDS: ReadonlySet<string> = new Set(["ui_label", "ui", "system", "menu"]);

/**
 * Whether a unit's `surfaceKind` is in scope for the given config-driven
 * translation scope. The tiers are additive: `dialogue-and-choices` includes
 * dialogue AND choices, and so on. `all` admits every surface. This is the
 * ONLY place scope is decided — the executor never widens it.
 */
export function unitSurfaceKindInScope(surfaceKind: string, scope: TranslationScope): boolean {
  if (scope === "all") {
    return true;
  }
  if (DIALOGUE_SURFACE_KINDS.has(surfaceKind)) {
    return true;
  }
  if (scope === "dialogue-only") {
    return false;
  }
  if (CHOICE_SURFACE_KINDS.has(surfaceKind)) {
    return true;
  }
  if (scope === "dialogue-and-choices") {
    return false;
  }
  // dialogue-choices-ui
  return UI_SURFACE_KINDS.has(surfaceKind);
}

// ---------------------------------------------------------------------------
// Per-unit real-context resolution
// ---------------------------------------------------------------------------

type DrivenUnitStructureContext =
  | {
      narrativeStructure: NarrativeStructure;
      sceneId: number;
    }
  | {
      narrativeStructure?: never;
      sceneId?: never;
    };

/**
 * Per-unit context resolved by the caller. Structure context is all-or-nothing:
 * `narrativeStructure` + `sceneId` select the deterministic scene slice, while
 * omitting both permits scope-only context. `effectiveScope` carries the
 * resolved work scope. A resolver may return either surface or both, which lets
 * the full-project driver compose decoded structure with operator-supplied
 * work-scope mapping without fabricating either one.
 */
export type DrivenUnitContext = DrivenUnitStructureContext & {
  /**
   * Structure-informed context fields. Supply both fields or neither; a
   * scope-only context uses `effectiveScope` without structure fields.
   */
  /**
   * itotori-crosswork-context-injection — resolved effective scope for this
   * unit's work: inherited shared glossary/characters plus any per-work
   * overrides. The executor adapts it into the loop's glossary, character
   * roster, and translation prompt continuity block.
   */
  effectiveScope?: EffectiveScope;
};

/**
 * Resolve the per-unit structure/work-scope context. The caller owns the
 * mapping from a bridge unit (+ the planner's scene grouping) to decoded
 * structure and work scope, because only the caller holds the real project
 * config/manifests. Returning `undefined` runs the loop without deterministic
 * structure or work-scope context (the semantic agents still fire live).
 */
export type DrivenUnitContextResolver = (args: {
  unit: LocalizationUnitV02;
  unitIndex: number;
  /** The planner's (string) scene id for this unit's batch, when grouped. */
  plannerSceneId: string | undefined;
}) => DrivenUnitContext | undefined;

// ---------------------------------------------------------------------------
// itotori-pass-ledger — prior-pass context threaded into a pass N+1 run
// ---------------------------------------------------------------------------

/**
 * Per-unit feedback the prior localization pass surfaced, keyed by
 * `bridgeUnitId`. A pass N+1 driven run consumes this as drafting context so
 * the translation prompt for each unit iterates on the prior pass's accepted
 * state / flagged-unit feedback rather than re-running from scratch.
 *
 * Strictly project-agnostic: the feedback carries only the prior routing
 * outcome, the prior draft, the defer reason, and an optional feedback note.
 * No game / engine / title fields anywhere — the multi-pass loop is generic
 * over any project whose units flow through the agentic loop. The pass ledger
 * (`pass-ledger.ts`) is the canonical source of this map.
 */
export type PriorPassContext = {
  /** 1-based number of the prior localization pass this context came from. */
  passNumber: number;
  feedbackByUnit: ReadonlyMap<string, PriorPassFeedback>;
};

// ---------------------------------------------------------------------------
// Persistence sinks (narrow ports — DB-backed live, in-memory in tests)
// ---------------------------------------------------------------------------

export type DrivenDraftRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number | undefined;
  outcome: AgenticLoopBundle["routingSummary"]["outcome"];
  accepted: boolean;
  targetLocale: string;
  /** The accepted (or repaired-then-accepted) draft body; absent on a defer. */
  draftText: string | undefined;
  /** The loop's reasoning when it deferred; absent when accepted. */
  deferredReason: string | undefined;
};

export type DrivenProviderRunRecord = {
  bridgeUnitId: string;
  pair: { modelId: string; providerId: string };
  /** Number of real LLM invocations the unit's loop fired across all stages. */
  invocationCount: number;
  /** SUM of every invocation's real `usage.cost` (decimal USD), PROJECT LAW. */
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** True iff EVERY invocation carried `zdr:true` on the wire. */
  zdr: boolean;
};

export type DrivenPatchExportRecord = {
  /** The translated v0.2 BridgeBundle (accepted units carry the real draft). */
  translatedBridge: unknown;
  /** Deterministic patch report summarising the driven run. */
  patchReport: DrivenPatchReport;
};

export type DrivenPatchReport = {
  schemaVersion: "itotori.project-driven-executor.patch-report.v0";
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  pair: { modelId: string; providerId: string };
  engineProfile: DrivenEngineProfile;
  translationScope: TranslationScope;
  unitsEnumerated: number;
  unitsInScope: number;
  unitsRun: number;
  acceptedDraftCount: number;
  deferredCount: number;
  failureCount: number;
  reviewerQueueItemCount: number;
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  budgetStopped: boolean;
  /**
   * The canonical hash of the RAW bridge this run actually drafted against. The
   * patch-apply seam compares this to the apply-time bridge's hash so a
   * stale / mismatched bridge cannot pass `sourceBridgeIntegrity` (the check is
   * NOT self-referential — it binds to the bridge the drafts were produced from).
   */
  sourceBridgeHash: string;
  /** The accepted units + their REAL translated body (the patchback splices). */
  acceptedUnits: Array<{ bridgeUnitId: string; sourceUnitKey: string; finalDraftText: string }>;
};

/**
 * Canonical hash of the raw v0.2 bridge JSON a run drafted against. The patch
 * report records this (as `sourceBridgeHash`) and the patch-apply seam recomputes
 * it over the apply-time bridge and compares — a mismatch means the drafts were
 * produced against a different bridge and MUST NOT be applied. Both sides hash
 * the identical raw JSON with this function so the comparison is meaningful.
 */
export function hashDraftedAgainstBridge(rawBridge: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(rawBridge)).digest("hex")}`;
}

function workScopeMemberId(workId: string, kind: "glossary" | "character", key: string): string {
  const digest = createHash("sha256").update(`${workId}\n${kind}\n${key}`).digest("hex");
  return `work-scope:${workId}:${kind}:${digest.slice(0, 16)}`;
}

function translationGlossaryFromEffectiveScope(
  effectiveScope: EffectiveScope,
): TranslationGlossaryEntry[] {
  return effectiveScope.glossary.map((entry) => ({
    termId: workScopeMemberId(effectiveScope.workId, "glossary", entry.sourceForm),
    preferredSourceForm: entry.sourceForm,
    preferredTargetForm: entry.targetForm,
    ...(entry.policyAction !== undefined ? { policyAction: entry.policyAction } : {}),
  }));
}

function translationWorkScopeContextFromEffectiveScope(
  effectiveScope: EffectiveScope,
): TranslationWorkScopeContext {
  return {
    workId: effectiveScope.workId,
    glossary: effectiveScope.glossary.map((entry) => ({
      termId: workScopeMemberId(effectiveScope.workId, "glossary", entry.sourceForm),
      sourceForm: entry.sourceForm,
      targetForm: entry.targetForm,
      ...(entry.policyAction !== undefined ? { policyAction: entry.policyAction } : {}),
      provenance: entry.provenance,
    })),
    characters: effectiveScope.characters.map((character) => ({
      characterId: character.characterId,
      displayName: character.displayName,
      ...(character.voiceNote !== undefined ? { voiceNote: character.voiceNote } : {}),
      provenance: character.provenance,
    })),
  };
}

function mergeGlossaryEntries(
  base: ReadonlyArray<TranslationGlossaryEntry>,
  workScope: ReadonlyArray<TranslationGlossaryEntry>,
): TranslationGlossaryEntry[] {
  const merged: TranslationGlossaryEntry[] = [];
  const bySource = new Map(workScope.map((entry) => [entry.preferredSourceForm, entry] as const));
  const emitted = new Set<string>();
  for (const entry of base) {
    const override = bySource.get(entry.preferredSourceForm);
    merged.push(override ?? entry);
    emitted.add(entry.preferredSourceForm);
  }
  for (const entry of workScope) {
    if (!emitted.has(entry.preferredSourceForm)) {
      merged.push(entry);
      emitted.add(entry.preferredSourceForm);
    }
  }
  return merged;
}

function knownCharactersFromEffectiveScope(
  effectiveScope: EffectiveScope,
  sourceLocale: string,
): NonNullable<AgenticLoopUnitInput["knownCharacters"]> {
  return effectiveScope.characters.map((character) => ({
    characterId: character.characterId,
    displayName: character.displayName,
    bioLocale: sourceLocale,
    bioText:
      character.voiceNote ??
      `${character.displayName} is present in the resolved work scope (${character.provenance}).`,
    hiddenFromReader: false,
  }));
}

export type DrivenDraftSink = {
  persistDraft(record: DrivenDraftRecord): Promise<void>;
};
export type DrivenProviderRunSink = {
  persistProviderRun(record: DrivenProviderRunRecord): Promise<void>;
};
export type DrivenPatchExportSink = {
  exportPatch(record: DrivenPatchExportRecord): Promise<void>;
};

export type DrivenEngineProfile = "reallive" | "rpg-maker-mv-mz";

export type DrivenUnitFailure = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  errorClass: string;
  errorMessage: string;
  /**
   * itotori-agent-facing-pipeline-failure-diagnostics — the structured
   * diagnostic for this per-unit failure (canonical step + failing unit/scene
   * id + redacted inputs + a minimal repro pointer). Optional so existing
   * call sites that read the four legacy fields keep working; the runner
   * populates it when the `executor.drive-unit` step catches a thrown
   * error.
   */
  diagnostic?: PipelineUnitFailureDiagnostic;
};

// ---------------------------------------------------------------------------
// Executor input + result
// ---------------------------------------------------------------------------

export type ProjectDrivenExecutorInput = {
  /** The source v0.2 bridge bundle whose units the executor enumerates. */
  bridge: BridgeBundleV02;
  /** Raw bridge JSON (deep-cloned for the translated-bundle synthesis). */
  rawBridge: unknown;
  /** Parsed pair-policy — every stage's (modelId, providerId) + posture. */
  pairPolicy: PairPolicy;
  /** The single top-level pinned pair (drives enumeration + the report). */
  pair: { modelId: string; providerId: string };
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale?: string;
  maxRepairAttempts?: number;
  actor: AuthorizationActor;
  /** The loop's provider factory (live OpenRouter in production, fake in tests). */
  providerFactory: AgenticLoopProviderFactory;
  /** The reviewer-queue DB sink (per P0#2). When absent, nothing is bridged. */
  reviewerQueue?: AgenticLoopReviewerQueueSink;
  /**
   * ITOTORI-150 — the terminology-candidate repository the loop's context stage
   * queries for the repository-side pre-persist conflict check
   * (`existsTerminologyTermBySurfaceForm`). Threaded verbatim into every unit's
   * `runAgenticLoopForUnit` call so the TOCTOU check RUNS in production. When
   * absent the loop's terminology enrichment runs without the repository check.
   */
  terminologyCandidateRepository?: ItotoriTerminologyCandidateRepositoryPort;
  /** Per-unit real-context resolver (per P0#1). */
  resolveUnitContext?: DrivenUnitContextResolver;
  /**
   * itotori-live-loop-style-glossary-injection — the ACTIVE glossary for this
   * run's locale branch. The caller resolves the active version from the
   * glossary tables/services (the READ path) and threads it in; the executor
   * hands it to every unit's loop so the translation prompt + QA terminology
   * lane enforce the real glossary. Omitted → the loop runs with an empty
   * glossary (graceful degrade).
   */
  glossary?: ReadonlyArray<TranslationGlossaryEntry>;
  /**
   * itotori-live-loop-style-glossary-injection — the ACTIVE (approved)
   * style-guide policy version for this run's locale branch, resolved by the
   * caller the SAME way as the glossary. Threaded into every unit's loop so the
   * draft is written — and QA'd — against the house style. Omitted → empty
   * style guide (graceful degrade).
   */
  styleGuide?: StyleGuidePolicyV0Draft;
  /** Config-driven translation scope. Defaults to dialogue-only. */
  translationScope?: TranslationScope;
  /** Engine profile controlling the translated-bundle synthesis. */
  engineProfile?: DrivenEngineProfile;
  /**
   * itotori-pass-ledger — prior localization pass's context, threaded so a pass
   * N+1 driven run consumes pass N's accepted state + flagged-unit feedback as
   * drafting context. When present each unit's translation prompt receives a
   * strictly-additive "Prior pass feedback" block (the draft iterates on the
   * prior result); when absent the run is a blank first pass. The pass ledger
   * is the canonical source — `runLocalizationPass` (pass-ledger.ts) loads the
   * latest pass and builds this map automatically. Project-agnostic.
   */
  priorPass?: PriorPassContext;
  sinks: {
    draft: DrivenDraftSink;
    providerRun: DrivenProviderRunSink;
    patchExport: DrivenPatchExportSink;
  };
  /**
   * Bounded-slice cap: the executor drives AT MOST this many in-scope units.
   * The executor SUPPORTS the whole game (omit to run all in-scope units) but
   * a pilot proves on a bounded slice.
   */
  maxUnits?: number;
  /**
   * USD budget cap on the REAL total `usage.cost`. Once the running total of
   * COMPLETED units reaches the cap, the pool stops DISPATCHING further units
   * (records `budgetStopped`). Under bounded concurrency the check gates the
   * NEXT dispatch, so at most `concurrency - 1` already-in-flight units can push
   * the realized total marginally past the cap; the provider's own
   * `costCapUsd` is the hard per-call backstop. A bounded, cost-safe pilot
   * guard.
   */
  budgetCapUsd?: number;
  /**
   * itotori-batched-concurrent-translation-scheduling — the CLIENT-SIDE
   * bounded-concurrency cap: at most this many units run their agentic loop
   * (`runAgenticLoopForUnit`) simultaneously. The OpenRouter-side provider
   * fallback + rate limits are the real backpressure; this bound is the client
   * cap that keeps a whole-route run from stampeding the provider. Defaults to
   * {@link DEFAULT_DRIVEN_CONCURRENCY}. Clamped to `>= 1` (a value `<= 1` runs
   * strictly sequentially, the pre-concurrency behaviour).
   */
  concurrency?: number;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * Default client-side concurrency bound. A deliberately CONSERVATIVE value: the
 * per-unit loop fires ~10 provider calls, so 8 concurrent units is ~80 in-flight
 * calls — comfortably below typical OpenRouter per-key rate ceilings while still
 * an ~8x wall-clock win over the old sequential driver. Raise it only with
 * evidence the served provider tolerates the higher call rate (a lower value is
 * the safe direction if rate-limit 429s appear).
 */
export const DEFAULT_DRIVEN_CONCURRENCY = 8;

/**
 * Single source of truth for the safe operator ceiling. Larger values can spin
 * up one worker/loop per planned unit: `--concurrency 27000` can create 27,000
 * concurrent unit loops, causing provider queue thrash, rate-limit churn, and
 * ZDR cost-cap risk because the provider checks the cost cap before its
 * rate-limit token. Sixteen is a safe operator ceiling above the default 8.
 */
export const MAX_DRIVEN_CONCURRENCY = 16;

export type ProjectDrivenExecutorResult = {
  unitsEnumerated: number;
  unitsInScope: number;
  unitsRun: number;
  draftsPersisted: number;
  acceptedDraftCount: number;
  deferredCount: number;
  providerRunsPersisted: number;
  reviewerQueueItemCount: number;
  patchExportCount: number;
  failures: DrivenUnitFailure[];
  /**
   * itotori-pass-ledger — per-unit outcome breakdown (one entry per
   * successfully-run unit, in canonical order). The pass ledger consumes this
   * to record each unit's accepted/deferred state + draft text + defer reason
   * so a pass N+1 run can build on the prior pass. Failures are surfaced
   * separately via {@link failures}. Absent only when no driven run has
   * populated it; the pass-ledger driver always reads it.
   */
  unitOutcomes: DrivenDraftRecord[];
  /**
   * m1-wholegame-replay-render-validate — optional post-patch replay/render
   * validation report. Populated by the pass-ledger post-executor hook so the
   * same pass record can carry rendered/runtime findings into pass N+1.
   */
  runtimeValidation?: WholeGameRenderValidationResult;
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  budgetStopped: boolean;
  patchReport: DrivenPatchReport;
};

// ---------------------------------------------------------------------------
// The driven executor
// ---------------------------------------------------------------------------

export async function runProjectDrivenExecutor(
  input: ProjectDrivenExecutorInput,
): Promise<ProjectDrivenExecutorResult> {
  const log = input.log ?? (() => {});
  const targetLocale = input.targetLocale ?? "en-US";
  const translationScope = input.translationScope ?? "dialogue-only";
  const engineProfile = input.engineProfile ?? "reallive";

  if (input.bridge.units.length === 0) {
    throw new Error("project-driven-executor refused: bridge has zero units");
  }

  // (a) ENUMERATE — consume the batch PLANNER's scene/route grouping.
  const enumerated = await enumerateInScopeUnits({
    bridge: input.bridge,
    pair: input.pair,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    targetLocale,
    translationScope,
  });
  const unitsEnumerated = input.bridge.units.length;
  const unitsInScope = enumerated.length;
  log(
    `project-driven-executor: enumerated ${unitsEnumerated} unit(s); ${unitsInScope} in scope (${translationScope})`,
  );

  const policy: AgenticLoopPolicy = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceLocale: input.bridge.sourceLocale,
    targetLocale,
    maxRepairAttempts: input.maxRepairAttempts ?? 1,
    ...(input.now !== undefined ? { now: input.now } : {}),
  };

  const failures: DrivenUnitFailure[] = [];
  const acceptedBodies = new Map<string, string>();
  const acceptedUnits: DrivenPatchReport["acceptedUnits"] = [];
  // itotori-pass-ledger — per-unit outcome accumulator (canonical order), read
  // by the pass-ledger driver to record each unit's accepted/deferred state.
  const unitOutcomes: DrivenDraftRecord[] = [];
  let unitsRun = 0;
  let draftsPersisted = 0;
  let acceptedDraftCount = 0;
  let deferredCount = 0;
  let providerRunsPersisted = 0;
  let totalUsageCostUsd = 0;
  let zdrConfirmed = true;
  let budgetStopped = false;

  // itotori-batched-concurrent-translation-scheduling — the pilot must scale to
  // a whole route/game, but the per-unit loop fires ~10 ZDR calls, so running
  // units strictly sequentially is ~25 min for four units. We schedule up to
  // `concurrency` units' `runAgenticLoopForUnit` at once via a bounded
  // worker-pool over the canonical unit list. The pool RUNS units concurrently
  // but PERSISTS in canonical order (below), so completion order never leaks
  // into the stored drafts / provider-runs / queue-items.
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? DEFAULT_DRIVEN_CONCURRENCY));

  // `maxUnits` is a DISPATCH cap: the pool drives AT MOST this many in-scope
  // units (canonical prefix). A failed unit is isolated but still consumes a
  // dispatch slot — the cap bounds provider calls, not successes.
  const maxUnits = input.maxUnits ?? enumerated.length;
  const plannedUnits = enumerated.slice(0, Math.max(0, maxUnits));

  // Result slots, one per planned unit, addressed by CANONICAL index. A slot is
  // filled by whichever worker ran that unit; `undefined` means the unit was
  // never dispatched (budget cap tripped first). Persistence walks these slots
  // in index order, so the stored order is canonical regardless of which worker
  // finished when — deterministic for identical inputs.
  const slots: Array<UnitRunResult | undefined> = Array.from({ length: plannedUnits.length });

  // Realized cost from COMPLETED units — the budget gate. JS is single-threaded,
  // so the read-check-and-claim below runs atomically between `await`s; no lock
  // is needed. Under concurrency `K` at most `K - 1` already-dispatched units
  // can push this marginally past the cap before the gate trips; the provider's
  // own `costCapUsd` is the hard per-call backstop (see `budgetCapUsd` docs).
  let realizedCostUsd = 0;
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      // (a) BUDGET GATE — stop DISPATCHING once completed cost reaches the cap.
      if (input.budgetCapUsd !== undefined && realizedCostUsd >= input.budgetCapUsd) {
        if (!budgetStopped) {
          budgetStopped = true;
          log(
            `project-driven-executor: budget cap $${input.budgetCapUsd} reached ($${realizedCostUsd.toFixed(6)}); stopping dispatch (concurrency=${concurrency})`,
          );
        }
        return;
      }
      // Claim the next canonical index atomically (no await between read+bump).
      const index = nextIndex;
      if (index >= plannedUnits.length) {
        return;
      }
      nextIndex += 1;

      const enumeratedUnit = plannedUnits[index]!;
      const result = await runSingleDrivenUnit({
        enumeratedUnit,
        input,
        policy,
        targetLocale,
        engineProfile,
        log,
      });
      slots[index] = result;
      if (result.status === "success") {
        // Only completed cost gates further dispatch (PROJECT LAW: real cost).
        realizedCostUsd += result.telemetry.totalCostUsd;
      }
    }
  };

  const workerCount = Math.min(concurrency, plannedUnits.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  // (c) PERSIST in CANONICAL order — walk the slots by index. Completion order
  // is irrelevant here: drafts, provider-runs, and the loop-bridged queue items
  // (buffered per unit during the concurrent phase) all land in unit order.
  for (const slot of slots) {
    if (slot === undefined) {
      continue; // never dispatched (budget cap) — a byte no-op on the export.
    }
    if (slot.status === "failure") {
      // PER-UNIT ISOLATION — the failing unit was caught in its worker; it
      // persisted nothing and its target stays a byte no-op (source === target).
      failures.push(slot.failure);
      continue;
    }

    unitsRun += 1;

    // PERSIST — the draft outcome FIRST. The DB provider-run ledger's FK
    // references the draft attempt persistDraft creates, so the draft must land
    // before the provider-run row (the shared adapter keys the attempt id by
    // bridgeUnitId).
    await input.sinks.draft.persistDraft(slot.draftRecord);
    draftsPersisted += 1;
    // itotori-pass-ledger — capture this unit's outcome for the pass-ledger
    // driver (canonical order — the persist loop already walks slots in order).
    unitOutcomes.push(slot.draftRecord);

    // PERSIST — provider-run summary (real usage.cost + ZDR).
    totalUsageCostUsd += slot.telemetry.totalCostUsd;
    zdrConfirmed = zdrConfirmed && slot.telemetry.zdr;
    await input.sinks.providerRun.persistProviderRun({
      bridgeUnitId: slot.unit.bridgeUnitId,
      ...slot.telemetry,
    });
    providerRunsPersisted += 1;

    // PERSIST — the reviewer_queue_items the loop's bridge produced for this
    // unit, replayed onto the REAL sink in canonical order (they were buffered
    // during the concurrent run so completion interleaving never reorders them).
    if (input.reviewerQueue !== undefined) {
      for (const captured of slot.queueCaptures) {
        await flushCapturedReviewerQueueItem(input.reviewerQueue, captured);
      }
    }

    if (slot.accepted && slot.acceptedBody !== undefined) {
      acceptedDraftCount += 1;
      acceptedBodies.set(slot.unit.bridgeUnitId, slot.acceptedBody);
      acceptedUnits.push({
        bridgeUnitId: slot.unit.bridgeUnitId,
        sourceUnitKey: slot.unit.sourceUnitKey,
        finalDraftText: slot.acceptedBody,
      });
    } else {
      deferredCount += 1;
    }
  }

  // Count the reviewer_queue_items the loop's bridge actually persisted for
  // this branch (the real DB read — deferrals + threshold findings).
  const reviewerQueueItemCount = await countReviewerQueueItems(input);

  // (d) ONE patch EXPORT for the accepted drafts.
  const patchReport: DrivenPatchReport = {
    schemaVersion: "itotori.project-driven-executor.patch-report.v0",
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    targetLocale,
    pair: input.pair,
    engineProfile,
    translationScope,
    unitsEnumerated,
    unitsInScope,
    unitsRun,
    acceptedDraftCount,
    deferredCount,
    failureCount: failures.length,
    reviewerQueueItemCount,
    totalUsageCostUsd,
    zdrConfirmed,
    budgetStopped,
    sourceBridgeHash: hashDraftedAgainstBridge(input.rawBridge),
    acceptedUnits,
  };
  const translatedBridge = synthesiseDrivenTranslatedBridge({
    rawBridge: input.rawBridge,
    acceptedBodies,
    engineProfile,
    targetLocale,
  });
  await input.sinks.patchExport.exportPatch({ translatedBridge, patchReport });
  log(
    `project-driven-executor: ran ${unitsRun} unit(s); ${acceptedDraftCount} accepted, ${deferredCount} deferred, ${failures.length} failed; ${reviewerQueueItemCount} queue item(s); total usage.cost $${totalUsageCostUsd.toFixed(6)} (zdr=${zdrConfirmed})`,
  );

  return {
    unitsEnumerated,
    unitsInScope,
    unitsRun,
    draftsPersisted,
    acceptedDraftCount,
    deferredCount,
    providerRunsPersisted,
    reviewerQueueItemCount,
    patchExportCount: 1,
    failures,
    unitOutcomes,
    totalUsageCostUsd,
    zdrConfirmed,
    budgetStopped,
    patchReport,
  };
}

// ---------------------------------------------------------------------------
// Bounded-concurrent unit scheduling — per-unit worker + deterministic buffers
// ---------------------------------------------------------------------------

/**
 * The fully-computed outcome of driving ONE unit through the agentic loop,
 * captured (NOT persisted) inside a worker so the pool can run units
 * concurrently and the caller can persist them in CANONICAL order afterwards.
 */
type UnitRunResult = UnitRunSuccess | UnitRunFailure;

type UnitRunSuccess = {
  status: "success";
  unit: LocalizationUnitV02;
  draftRecord: DrivenDraftRecord;
  telemetry: ReturnType<typeof summariseProviderTelemetry>;
  accepted: boolean;
  /** The stripped/bracket-wrapped accepted body; `undefined` on a defer. */
  acceptedBody: string | undefined;
  /** Reviewer-queue writes the loop's bridge buffered for ordered replay. */
  queueCaptures: CapturedReviewerQueueCreate[];
};

type UnitRunFailure = {
  status: "failure";
  failure: DrivenUnitFailure;
};

/**
 * Drive ONE unit through `runAgenticLoopForUnit` and capture everything the
 * caller needs to persist it later — WITHOUT touching the draft / provider-run
 * sinks (those persist in canonical order after the whole pool drains) and with
 * the reviewer-queue writes BUFFERED (replayed in order later). PER-UNIT
 * ISOLATION: a thrown error (incl. a live semantic-agent malformed pack, the
 * filed P2) is caught here and returned as a failure so one bad unit never
 * aborts the pool. Config-driven scope + the (modelId, providerId) pinning +
 * ZDR posture all thread through the loop UNCHANGED.
 */
async function runSingleDrivenUnit(args: {
  enumeratedUnit: EnumeratedUnit;
  input: ProjectDrivenExecutorInput;
  policy: AgenticLoopPolicy;
  targetLocale: string;
  engineProfile: DrivenEngineProfile;
  log: (message: string) => void;
}): Promise<UnitRunResult> {
  const { enumeratedUnit, input, policy, targetLocale, engineProfile, log } = args;
  const { unit, unitIndex, plannerSceneId } = enumeratedUnit;
  // Resolve the per-unit structure-informed context OUTSIDE the try block so
  // the failure path can surface it in the diagnostic (itotori-agent-facing-
  // pipeline-failure-diagnostics — scene id helps the driving agent reproduce
  // the failing slice). The resolver is a pure function that never throws.
  const context = input.resolveUnitContext?.({ unit, unitIndex, plannerSceneId });
  try {
    assertValidDrivenUnitContext(context);
    // Buffer the loop's reviewer-queue writes so they persist in CANONICAL unit
    // order after the concurrent phase — completion interleaving must not
    // reorder them. `loadItemsByBranch` still delegates to the real repository
    // so the bridge's idempotency pre-check still sees persisted rows.
    const queueCaptures: CapturedReviewerQueueCreate[] = [];
    const bufferedQueue =
      input.reviewerQueue !== undefined
        ? makeBufferingReviewerQueueSink(input.reviewerQueue, queueCaptures)
        : undefined;

    // itotori-pass-ledger — thread THIS unit's prior-pass feedback (if the
    // run is a pass N+1 driven run with a prior context) so the translation
    // prompt iterates on the prior accepted state / flagged-unit feedback.
    const priorPassFeedback =
      input.priorPass !== undefined
        ? input.priorPass.feedbackByUnit.get(unit.bridgeUnitId)
        : undefined;

    const scopeGlossary =
      context?.effectiveScope !== undefined
        ? translationGlossaryFromEffectiveScope(context.effectiveScope)
        : [];
    const workScopeContext =
      context?.effectiveScope !== undefined
        ? translationWorkScopeContextFromEffectiveScope(context.effectiveScope)
        : undefined;

    const unitInput: AgenticLoopUnitInput = {
      unit,
      sceneUnits: [],
      // itotori-live-loop-style-glossary-injection — feed the run's ACTIVE
      // glossary + style-guide (caller-resolved) into every unit's loop.
      glossary: mergeGlossaryEntries(input.glossary ?? [], scopeGlossary),
      protectedSpans: [],
      knownCharacters:
        context?.effectiveScope !== undefined
          ? knownCharactersFromEffectiveScope(context.effectiveScope, policy.sourceLocale)
          : [],
      ...(input.styleGuide !== undefined ? { styleGuide: input.styleGuide } : {}),
      ...(context?.narrativeStructure !== undefined && context.sceneId !== undefined
        ? { narrativeStructure: context.narrativeStructure, sceneId: context.sceneId }
        : {}),
      ...(workScopeContext !== undefined ? { workScopeContext } : {}),
      actor: input.actor,
      ...(bufferedQueue !== undefined ? { reviewerQueue: bufferedQueue } : {}),
      // ITOTORI-150 — hand the terminology-candidate repository to every unit's
      // loop so the repository-side pre-persist conflict check runs in prod.
      ...(input.terminologyCandidateRepository !== undefined
        ? { terminologyCandidateRepository: input.terminologyCandidateRepository }
        : {}),
      // itotori-pass-ledger — thread THIS unit's prior-pass feedback (if the
      // run is a pass N+1 driven run with a prior context) so the translation
      // prompt iterates on the prior accepted state / flagged-unit feedback.
      ...(priorPassFeedback !== undefined ? { priorPassFeedback } : {}),
    };

    const bundle = await runAgenticLoopForUnit(
      unitInput,
      input.pairPolicy,
      policy,
      input.providerFactory,
    );

    const accepted = bundle.finalDraft.draftText !== undefined;
    const draftRecord: DrivenDraftRecord = {
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sceneId: context?.sceneId,
      outcome: bundle.routingSummary.outcome,
      accepted,
      targetLocale,
      draftText: bundle.finalDraft.draftText,
      deferredReason: bundle.finalDraft.deferredReason,
    };
    const telemetry = summariseProviderTelemetry(bundle, input.pair);

    let acceptedBody: string | undefined;
    if (accepted && bundle.finalDraft.draftText !== undefined) {
      // Strip the out-of-band kidoku markup so the recorded body matches the
      // patchback splice (mirrors the single-unit driver).
      acceptedBody =
        engineProfile === "rpg-maker-mv-mz"
          ? bundle.finalDraft.draftText
          : stripOutOfBandControlMarkup(bundle.finalDraft.draftText);
    }

    return {
      status: "success",
      unit,
      draftRecord,
      telemetry,
      accepted,
      acceptedBody,
      queueCaptures,
    };
  } catch (error) {
    log(
      `project-driven-executor: unit ${unit.sourceUnitKey} FAILED (isolated, run continues): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // itotori-agent-facing-pipeline-failure-diagnostics — turn the bare throw
    // into a structured per-unit diagnostic so a driving agent gets the step,
    // failing unit/scene, redacted inputs, and a repro pointer — not just a
    // class + message. The diagnostic is optional on `DrivenUnitFailure` so
    // existing call sites that read the four legacy fields keep working.
    const unitInputs = redactUnitInputsForDiagnostic(unit, policy);
    const diagnostic = buildPipelineUnitFailureDiagnostic({
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      ...(context?.sceneId !== undefined ? { sceneId: context.sceneId } : {}),
      unitInputs,
      error,
      pair: input.pairPolicy.translation.primary.pair,
      stage: "translation",
      agentLabel: "translation-primary",
    });
    return {
      status: "failure",
      failure: {
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        errorClass: diagnostic.errorClass,
        errorMessage: diagnostic.errorMessage,
        diagnostic,
      },
    };
  }
}

function assertValidDrivenUnitContext(context: DrivenUnitContext | undefined): void {
  if (context === undefined) {
    return;
  }
  const hasNarrativeStructure = context.narrativeStructure !== undefined;
  const hasSceneId = context.sceneId !== undefined;
  if (hasNarrativeStructure === hasSceneId) {
    return;
  }
  throw new AgenticLoopInvariantError(
    hasNarrativeStructure
      ? "narrativeStructure supplied without sceneId: cannot select the unit's scene slice"
      : "sceneId supplied without narrativeStructure: cannot select the unit's scene slice",
  );
}

/**
 * Build the redacted input view for a per-unit failure diagnostic. The view
 * carries the unit's identifying fields + the policy / pair (the surface that
 * drove the agentic loop) but NO raw game text — `sourceText` is scrubbed by
 * the redaction helper, and any nested span / patchRef fields are scrubbed the
 * same way. The point: an agent reading the diagnostic sees the unit it was
 * processing without ever seeing the game line itself.
 */
function redactUnitInputsForDiagnostic(
  unit: LocalizationUnitV02,
  policy: AgenticLoopPolicy,
): Record<string, unknown> {
  return {
    unit: {
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      surfaceKind: unit.surfaceKind,
      sourceLocale: unit.sourceLocale,
      targetLocale: policy.targetLocale,
      // The closed redaction taxonomy scrubs `sourceText` (game text) +
      // every nested span's `sourceText` / `expectedTargetForm`.
      sourceText: unit.sourceText,
      spans: unit.spans,
      patchRef: unit.patchRef,
    },
    policy: {
      projectId: policy.projectId,
      localeBranchId: policy.localeBranchId,
      sourceLocale: policy.sourceLocale,
      targetLocale: policy.targetLocale,
      maxRepairAttempts: policy.maxRepairAttempts,
    },
  };
}

// ---------------------------------------------------------------------------
// Reviewer-queue write buffering — deterministic, canonical-order replay
// ---------------------------------------------------------------------------

type CapturedReviewerQueueCreate = {
  actor: AuthorizationActor;
  input: CreateReviewerQueueItemInput;
};

/**
 * Wrap the real reviewer-queue sink so the loop's `createItem` writes are
 * CAPTURED (not persisted) during the concurrent phase, then replayed in
 * canonical unit order afterwards. `loadItemsByBranch` passes through to the
 * real repository so the bridge's idempotency pre-check still sees persisted
 * rows. The loop discards the `createItem` return value, but a faithful record
 * is synthesised so the port contract holds.
 */
function makeBufferingReviewerQueueSink(
  real: AgenticLoopReviewerQueueSink,
  buffer: CapturedReviewerQueueCreate[],
): AgenticLoopReviewerQueueSink {
  let localSeq = 0;
  return {
    repository: {
      createItem: async (actor, createInput) => {
        buffer.push({ actor, input: createInput });
        localSeq += 1;
        return synthesiseBufferedQueueRecord(createInput, localSeq);
      },
      loadItemsByBranch: (actor, localeBranchId) =>
        real.repository.loadItemsByBranch(actor, localeBranchId),
    },
  };
}

/** Replay one buffered reviewer-queue write onto the real sink (idempotent). */
async function flushCapturedReviewerQueueItem(
  sink: AgenticLoopReviewerQueueSink,
  captured: CapturedReviewerQueueCreate,
): Promise<void> {
  try {
    await sink.repository.createItem(captured.actor, captured.input);
  } catch (error) {
    // A duplicate (unique key already present) is a no-op — exactly as the
    // bridge treats it — so a re-run against shared storage never throws.
    if (
      error instanceof ReviewerQueueRepositoryError &&
      error.code === "reviewer_queue_item_duplicate"
    ) {
      return;
    }
    throw error;
  }
}

function synthesiseBufferedQueueRecord(
  createInput: CreateReviewerQueueItemInput,
  seq: number,
): ReviewerQueueItemRecord {
  const createdAt = createInput.createdAt ?? new Date();
  return {
    reviewItemId: `driven-buffered-${seq}`,
    projectId: createInput.projectId,
    localeBranchId: createInput.localeBranchId,
    sourceRevisionId: createInput.sourceRevisionId,
    itemKind: createInput.itemKind,
    sourceItemRef: createInput.sourceItemRef,
    state: reviewerQueueItemStateValues.pending,
    priority: createInput.priority ?? 0,
    summary: createInput.summary,
    affectedArtifactIds: createInput.affectedArtifactIds ?? [],
    evidenceTier: createInput.evidenceTier ?? null,
    observationEventIds: createInput.observationEventIds ?? null,
    artifactHashes: createInput.artifactHashes ?? null,
    payload: createInput.payload ?? {},
    metadata: createInput.metadata ?? {},
    createdByUserId: createInput.createdByUserId ?? null,
    assignedToUserId: createInput.assignedToUserId ?? null,
    createdAt,
    updatedAt: createdAt,
    resolvedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Enumeration — consume the batch planner's scene/route grouping
// ---------------------------------------------------------------------------

type EnumeratedUnit = {
  unit: LocalizationUnitV02;
  unitIndex: number;
  plannerSceneId: string | undefined;
};

async function enumerateInScopeUnits(args: {
  bridge: BridgeBundleV02;
  pair: { modelId: string; providerId: string };
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
  translationScope: TranslationScope;
}): Promise<EnumeratedUnit[]> {
  const unitById = new Map<string, { unit: LocalizationUnitV02; index: number }>();
  for (const [index, unit] of args.bridge.units.entries()) {
    unitById.set(unit.bridgeUnitId, { unit, index });
  }

  // The batch PLANNER groups the bridge units by scene/route. We CONSUME that
  // grouping (a deterministic reduction — no LLM, no translation-memory mining
  // here) so the driven run walks units in canonical scene/route dispatch
  // order and learns each unit's scene grouping for the per-unit context.
  const modelProfile = resolveModelProfile({
    modelId: args.pair.modelId,
    providerId: args.pair.providerId,
  });
  const plan = await planBatches({
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    sourceRevisionId: args.sourceRevisionId,
    locale: args.targetLocale,
    bridgeBundle: args.bridge,
    glossary: [],
    modelProfile,
  });

  const enumerated: EnumeratedUnit[] = [];
  const seen = new Set<string>();
  for (const batch of plan.batches) {
    for (const ref of batch.units) {
      const found = unitById.get(ref.bridgeUnitId);
      if (found === undefined || seen.has(ref.bridgeUnitId)) {
        continue;
      }
      if (!unitSurfaceKindInScope(found.unit.surfaceKind, args.translationScope)) {
        continue;
      }
      seen.add(ref.bridgeUnitId);
      enumerated.push({
        unit: found.unit,
        unitIndex: found.index,
        plannerSceneId: batch.sceneId,
      });
    }
  }
  return enumerated;
}

// ---------------------------------------------------------------------------
// Provider telemetry summary — real usage.cost + ZDR, from the bundle
// ---------------------------------------------------------------------------

export function summariseProviderTelemetry(
  bundle: AgenticLoopBundle,
  pair: { modelId: string; providerId: string },
): {
  pair: { modelId: string; providerId: string };
  invocationCount: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  zdr: boolean;
} {
  let invocationCount = 0;
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let zdr = true;
  let sawInvocation = false;
  for (const stage of bundle.stages) {
    for (const invocation of stage.invocations) {
      sawInvocation = true;
      invocationCount += 1;
      // PROJECT LAW: cost comes ONLY from the real per-invocation usage.cost
      // the provider reported (the bundle stores it as a decimal-USD string).
      totalCostUsd += Number.parseFloat(invocation.costUsd);
      totalTokensIn += invocation.tokensIn;
      totalTokensOut += invocation.tokensOut;
      zdr = zdr && invocation.zdr === true;
    }
  }
  return {
    pair,
    invocationCount,
    totalCostUsd,
    totalTokensIn,
    totalTokensOut,
    // A unit that fired zero invocations cannot assert a ZDR posture.
    zdr: sawInvocation ? zdr : false,
  };
}

// ---------------------------------------------------------------------------
// Reviewer-queue item count (real DB read of what the loop bridged)
// ---------------------------------------------------------------------------

async function countReviewerQueueItems(input: ProjectDrivenExecutorInput): Promise<number> {
  const sink = input.reviewerQueue;
  if (sink === undefined) {
    return 0;
  }
  const items = await sink.repository.loadItemsByBranch(input.actor, input.localeBranchId);
  // Count only the items THIS driven run's loop bridged (source = agentic_loop).
  return items.filter((item) => {
    const metadataSource = (item.metadata as { source?: unknown }).source;
    return metadataSource === "agentic_loop";
  }).length;
}

// ---------------------------------------------------------------------------
// Patch export synthesis — whole-project translated bridge
// ---------------------------------------------------------------------------

/**
 * Build the translated v0.2 BridgeBundle for the driven run. Every ACCEPTED
 * unit carries its REAL translated body (SJIS-bracket-wrapped for RealLive so
 * the KAIFUU-191 lexer captures it as a Textout run; the plain literal for RPG
 * Maker). Every other unit — deferred, out-of-scope, or failed — keeps
 * `target.text === sourceText`, a byte no-op the patchback collapses to zero
 * edits. That is the config-driven byte-fidelity contract: everything outside
 * the accepted set is byte-identical.
 */
export function synthesiseDrivenTranslatedBridge(args: {
  rawBridge: unknown;
  acceptedBodies: ReadonlyMap<string, string>;
  engineProfile: DrivenEngineProfile;
  targetLocale: string;
}): unknown {
  const { rawBridge, acceptedBodies, engineProfile, targetLocale } = args;
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("project-driven-executor refused: bridge JSON must be an object");
  }
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("project-driven-executor refused: bridge.units must be an array");
  }
  for (const unit of units) {
    if (typeof unit !== "object" || unit === null) {
      throw new Error("project-driven-executor refused: bridge unit must be an object");
    }
    const record = unit as Record<string, unknown>;
    const bridgeUnitId = record.bridgeUnitId;
    const sourceText = record.sourceText;
    if (typeof sourceText !== "string") {
      throw new Error("project-driven-executor refused: bridge unit sourceText must be a string");
    }
    const accepted =
      typeof bridgeUnitId === "string" ? acceptedBodies.get(bridgeUnitId) : undefined;
    const text =
      accepted === undefined
        ? sourceText // byte no-op: deferred / out-of-scope / failed unit.
        : engineProfile === "rpg-maker-mv-mz"
          ? accepted
          : bracketWrapForRealLive(accepted);
    record.target = { locale: targetLocale, text };
  }
  return clone;
}
