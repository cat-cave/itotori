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
//       P0#1) and preserves the loop's canonical written outcome.
//   (c) PERSISTS, per unit: every physical provider attempt (including exact
//       cost + validation/retry state), the canonical written outcome with all
//       candidates/findings/provenance, and — via the loop's own bridge — the
//       reviewer_queue_items.
//   (d) produces ONE patch EXPORT only after every configured in-scope unit
//       has a written body. The translated bridge carries each selected body;
//       an operational unit failure is recorded as a typed failure and never
//       fabricated as source text.
//
// Robustness (a pilot runs many units): a SINGLE unit's failure — including a
// live semantic-agent malformed pack (the filed P2) — MUST NOT abort the whole
// run. The executor records the failure and continues (per-unit isolation).
//
// Config-driven scope + the (modelId, providerId) pinning + ZDR all flow
// through the loop UNCHANGED: the executor never re-derives a pair, never
// downgrades ZDR, never widens scope — it threads the caller's parsed policy
// into every `runAgenticLoopForUnit` call verbatim.

import { createHash, randomUUID } from "node:crypto";
import type {
  AuthorizationActor,
  CreateReviewerQueueItemInput,
  ItotoriContextArtifactRepositoryPort,
  ReviewerQueueItemRecord,
} from "@itotori/db";
import { ReviewerQueueRepositoryError, reviewerQueueItemStateValues } from "@itotori/db";
import {
  isLocaleTaggedSourceEcho,
  type AgenticLoopBundle,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type SpeakerLabel,
  type StyleGuidePolicyV0Draft,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import { planBatches } from "../batch-planner/planner.js";
import { resolveModelProfile } from "../batch-planner/model-profiles.js";
import type { NarrativeStructure } from "../agents/structure-informed-context/index.js";
import type {
  PriorPassFeedback,
  TranslationGlossaryEntry,
  TranslationWorkScopeContext,
} from "../agents/translation/shapes.js";
import type { EffectiveScope } from "../agents/work-scope/index.js";
import type { AgenticLoopReviewerQueueSink } from "./reviewer-queue-bridge.js";
import {
  AgenticLoopInvariantError,
  readOutcomeJournalProvenance,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type ContextEnrichmentSingleFlight,
  type ContextEnrichmentType,
  type PairPolicy,
} from "./agentic-loop.js";
import {
  capturePhysicalProviderAttempts,
  DrivenLlmAttemptRecord,
} from "./attempt-outcome-journal.js";
import { addDecimalUsd } from "../providers/cost.js";
import {
  bracketWrapForRealLive,
  stripOutOfBandControlMarkup,
} from "./localize-project-stage-command.js";
import { buildPipelineUnitFailureDiagnostic } from "./pipeline-failure-diagnostic.js";
import type { PipelineUnitFailureDiagnostic } from "./pipeline-failure-diagnostic.js";
import type { WholeGameRenderValidationResult } from "./wholegame-render-validation-seam.js";
import {
  InvocationRetryCeilingError,
  isInvocationOperationalPause,
  type InvocationLifecycle,
  type InvocationAttemptCompleted,
  type InvocationAttemptStarted,
  type InvocationCostAdmission,
  type OperationalBlocker,
} from "./invocation-supervisor.js";

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
// Optional historical prior-run context
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
 * over any project whose units flow through the agentic loop. A caller may
 * supply this historical context, but the durable journal is its persistence
 * source of truth.
 */
export type PriorPassContext = {
  /** 1-based number of the prior localization pass this context came from. */
  passNumber: number;
  /** Durable journal run that supplied this context, when one exists. */
  journalRunId?: string;
  feedbackByUnit: ReadonlyMap<string, PriorPassFeedback>;
};

// ---------------------------------------------------------------------------
// Persistence sinks (narrow ports — DB-backed live, in-memory in tests)
// ---------------------------------------------------------------------------

/**
 * The executor's persistence projection of one canonical written outcome.
 * `selectedBody` is required and is checked against the selected candidate
 * before this record crosses a persistence or patch-export boundary.
 */
export type DrivenWrittenOutcomeRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number | undefined;
  outcome: WrittenUnitOutcome;
  /** The selected candidate body, never blank or a source repetition. */
  selectedBody: string;
};

/** Immutable identity frozen once for the durable journal run. */
export type DrivenJournalRunRecord = {
  runId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  targetLocale: string;
};

export type DrivenPlannedRunUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  nextAction: { kind: "drive_unit"; stage: "context" };
};

/**
 * Frozen cost policy for a driven run. A cap raised through the repository is
 * persisted as an exact decimal string, so resumes must retain that string
 * verbatim instead of coercing it back through a floating-point CLI value.
 * The index signature preserves future persisted policy fields during a
 * resume seed as well.
 */
export type DrivenJournalCostPolicy = {
  budgetCapUsd: number | string | null;
  reservation: "node_4_seam";
  [key: string]: unknown;
};

/** Immutable launch facts persisted atomically with every planned unit. */
export type DrivenJournalRunPlan = {
  run: DrivenJournalRunRecord;
  frozenScope: {
    translationScope: TranslationScope;
    bridgeUnitIds: string[];
  };
  routingPolicy: PairPolicy;
  costPolicy: DrivenJournalCostPolicy;
  units: DrivenPlannedRunUnit[];
};

export type DrivenJournalResumeState = {
  /** Persisted verbatim so a resume never rebuilds a raised cap as null. */
  costPolicy: DrivenJournalCostPolicy;
  status: "running" | "paused" | "finalizing" | "succeeded" | "failed" | "aborted";
  pausedBlocker: OperationalBlocker | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
  fenceToken: number;
  writtenOutcomes: DrivenWrittenOutcomeRecord[];
  /** Complete run ledger, including providerless/interrupted attempts. */
  attempts?: DrivenLlmAttemptRecord[];
};

/** A resolved context reference; versionRef is omitted when the current source has no version id. */
export type DrivenOutcomeContextRef = {
  refKind: string;
  refId: string;
  versionRef?: string;
  details?: unknown;
};

/** Raw QA provenance that remains separately renderable from `WrittenQaFinding.note`. */
export type DrivenQaFindingDetail = {
  recommendation: string;
  agentRationale: string;
  evidenceRefs: string[];
  sourceSpan?: { start: number; end: number };
  draftSpan?: { start: number; end: number };
};

/**
 * The sole project-driven persistence payload. It deliberately contains the
 * canonical outcome verbatim plus every physical attempt and its resolved
 * provenance; the DB adapter writes it transactionally.
 */
export type DrivenUnitJournalRecord = {
  run: DrivenJournalRunRecord;
  writtenOutcome: DrivenWrittenOutcomeRecord;
  attempts: DrivenLlmAttemptRecord[];
  contextPacket: unknown;
  contextRefs: DrivenOutcomeContextRef[];
  speakerLabels: SpeakerLabel[];
  qaDetails: Record<string, DrivenQaFindingDetail>;
};

export type DrivenFailedUnitJournalRecord = {
  run: DrivenJournalRunRecord;
  bridgeUnitId: string;
  sourceUnitKey: string;
  attempts: DrivenLlmAttemptRecord[];
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
  /** The translated v0.2 BridgeBundle (in-scope units carry selected bodies). */
  translatedBridge: unknown;
  /** Deterministic patch report summarising the driven run. */
  patchReport: DrivenPatchReport;
};

export type DrivenPatchReport = {
  schemaVersion: "itotori.project-driven-executor.patch-report.v0";
  /** Exact durable journal run; never infer a patch run from latest rows. */
  journalRunId: string;
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  pair: { modelId: string; providerId: string };
  engineProfile: DrivenEngineProfile;
  translationScope: TranslationScope;
  unitsEnumerated: number;
  unitsInScope: number;
  unitsRun: number;
  writtenOutcomeCount: number;
  failureCount: number;
  reviewerQueueItemCount: number;
  /** Exact sum of every physical attempt's decimal `usage.cost`. */
  totalUsageCostExactUsd: string;
  /**
   * Compatibility/display projection of {@link totalUsageCostExactUsd}.
   * Persistence and budget comparisons use the exact decimal field above.
   */
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  budgetStopped: boolean;
  /** A patch exists only when the configured scope has complete written coverage. */
  coverageComplete: boolean;
  /**
   * The canonical hash of the RAW bridge this run actually drafted against. The
   * patch-apply seam compares this to the apply-time bridge's hash so a
   * stale / mismatched bridge cannot pass `sourceBridgeIntegrity` (the check is
   * NOT self-referential — it binds to the bridge the drafts were produced from).
   */
  sourceBridgeHash: string;
  /** The written units + their selected bodies (the patchback splices). */
  writtenUnits: Array<{
    bridgeUnitId: string;
    sourceUnitKey: string;
    selectedBody: string;
    qualityFlags: string[];
  }>;
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

export type DrivenWrittenOutcomeSink = {
  persistWrittenOutcome(record: DrivenWrittenOutcomeRecord): Promise<void>;
};
export type DrivenProviderRunSink = {
  persistProviderRun(record: DrivenProviderRunRecord): Promise<void>;
};
export type DrivenUnitJournalSink = {
  /** Atomically establishes the immutable run and every planned unit. */
  beginJournalRun?(plan: DrivenJournalRunPlan, mode: "new" | "resume"): Promise<void>;
  loadResumeState?(runId: string): Promise<DrivenJournalResumeState>;
  resumeJournalRun?(runId: string): Promise<void>;
  /** Builds the durable atomic cost-admission implementation after seeding. */
  createCostAdmission?(runId: string): InvocationCostAdmission;
  attemptStarted?(attempt: InvocationAttemptStarted): Promise<AbortSignal | void>;
  attemptCompleted?(attempt: InvocationAttemptCompleted): Promise<void>;
  pauseRun?(runId: string, blocker: OperationalBlocker): Promise<void>;
  /** Called only after every in-flight worker on a paused run has drained. */
  releasePausedRunLease?(runId: string): Promise<void>;
  persistUnitJournal(record: DrivenUnitJournalRecord): Promise<void>;
  persistFailedUnitAttempts(record: DrivenFailedUnitJournalRecord): Promise<void>;
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
  /**
   * Caller-selected durable run identity. The outer terminal finalizer owns
   * this in the shipped whole-project path so failures after the run is seeded
   * can always be reconciled to one terminal summary. Omit it for the
   * executor's standalone/test convenience identity.
   */
  runId?: string;
  targetLocale?: string;
  maxRepairAttempts?: number;
  actor: AuthorizationActor;
  /** The loop's provider factory (live OpenRouter in production, fake in tests). */
  providerFactory: AgenticLoopProviderFactory;
  /** Explicit test/alternate admission; the durable journal provides the production default. */
  costAdmission?: InvocationCostAdmission;
  /** The reviewer-queue DB sink (per P0#2). When absent, nothing is bridged. */
  reviewerQueue?: AgenticLoopReviewerQueueSink;
  /**
   * p0-core-persistent-context-brain — central context-artifact store (source /
   * sink / invalidation). Threaded into every unit so semantic enrichment +
   * speaker labels persist and cross-unit reuse works on the live path.
   */
  contextArtifactRepository?: ItotoriContextArtifactRepositoryPort;
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
   * Prior localization-run context, threaded so a pass N+1 driven run consumes
   * pass N's accepted state + flagged-unit feedback as drafting context. When
   * present each unit's translation prompt receives a
   * strictly-additive "Prior pass feedback" block (the draft iterates on the
   * prior result); when absent the run is a blank first pass. This is an
   * optional caller-provided input only; the journal remains the execution
   * source of truth. Project-agnostic.
   */
  priorPass?: PriorPassContext;
  sinks: {
    journal: DrivenUnitJournalSink;
    patchExport: DrivenPatchExportSink;
  };
  /**
   * Bounded-slice cap: the executor drives AT MOST this many in-scope units.
   * The executor SUPPORTS the whole game (omit to run all in-scope units) but
   * a pilot proves on a bounded slice.
   */
  maxUnits?: number;
  /** Exact run cap persisted in the journal cost account at seed time. */
  budgetCapUsd?: number;
  /** Existing durable run identity to resume instead of creating a new run. */
  resumeRunId?: string;
  /**
   * itotori-batched-concurrent-translation-scheduling — the CLIENT-SIDE
   * bounded-concurrency permit: at most this many units run their agentic loop
   * (`runAgenticLoopForUnit`) simultaneously. The provider rate-token hook
   * runs before each atomic cost reservation; this worker bound prevents a
   * whole-route run from stampeding that transport. Defaults to
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
 * concurrent unit loops, causing provider queue thrash and rate-limit churn.
 * Sixteen is a safe operator ceiling above the default 8.
 */
export const MAX_DRIVEN_CONCURRENCY = 16;

/**
 * One executor owns one fixed project / branch / source revision. Flights are
 * keyed by both scene and enrichment type, so a character build can never
 * collide with a route build for the same scene. The map holds only in-flight
 * work: once the leader has persisted its artifact, later units use the normal
 * central-store retrieval path. Rejections clear the flight too, so a transient
 * provider/persistence error never leaves a poisoned lock behind.
 */
class SceneContextEnrichmentSingleFlight implements ContextEnrichmentSingleFlight {
  private readonly inFlight = new Map<ContextEnrichmentType, Map<string, Promise<unknown>>>();

  async run<T>(
    sceneKey: string,
    enrichmentType: ContextEnrichmentType,
    build: () => Promise<T>,
  ): Promise<{ value: T; shared: boolean }> {
    const flightsForType = this.inFlight.get(enrichmentType);
    const existing = flightsForType?.get(sceneKey);
    if (existing !== undefined) {
      return { value: (await existing) as T, shared: true };
    }

    const leader = build();
    const activeFlights = flightsForType ?? new Map<string, Promise<unknown>>();
    if (flightsForType === undefined) {
      this.inFlight.set(enrichmentType, activeFlights);
    }
    activeFlights.set(sceneKey, leader);
    void leader.then(
      () => {
        if (activeFlights.get(sceneKey) === leader) {
          activeFlights.delete(sceneKey);
          if (activeFlights.size === 0) {
            this.inFlight.delete(enrichmentType);
          }
        }
      },
      () => {
        if (activeFlights.get(sceneKey) === leader) {
          activeFlights.delete(sceneKey);
          if (activeFlights.size === 0) {
            this.inFlight.delete(enrichmentType);
          }
        }
      },
    );
    return { value: await leader, shared: false };
  }
}

export type ProjectDrivenExecutorResult = {
  journalRunId: string;
  /**
   * The executor itself returns only `running|paused`; the outer node-5
   * finalizer projects the same result into a durable terminal state for the
   * shipped whole-project command.
   */
  runState: "running" | "paused" | "succeeded" | "failed" | "aborted";
  pausedBlocker: OperationalBlocker | null;
  unitsEnumerated: number;
  unitsInScope: number;
  unitsRun: number;
  writtenOutcomesPersisted: number;
  writtenOutcomeCount: number;
  journalUnitsPersisted: number;
  attemptsPersisted: number;
  reviewerQueueItemCount: number;
  patchExportCount: number;
  failures: DrivenUnitFailure[];
  /**
   * Per-unit written outcomes (one entry per successfully-run unit, canonical
   * order). This is an in-memory convenience for callers; the durable source
   * of truth is the journal record. `failures` remains as a compatibility
   * projection and is always empty: operational problems use `pausedBlocker`.
   */
  unitOutcomes: DrivenWrittenOutcomeRecord[];
  /**
   * m1-wholegame-replay-render-validate — optional post-patch replay/render
   * validation report supplied by an executor hook.
   */
  runtimeValidation?: WholeGameRenderValidationResult;
  /** Exact sum of every physical attempt's decimal `usage.cost`. */
  totalUsageCostExactUsd: string;
  /** Compatibility/display projection of `totalUsageCostExactUsd`. */
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
  const journalRun: DrivenJournalRunRecord = {
    runId: input.resumeRunId ?? input.runId ?? `localization-journal-run-${randomUUID()}`,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    targetLocale,
  };
  // Context reuse is durable only when the central repository is wired. Keep
  // one coordinator for this whole run so concurrently dispatched same-scene
  // units cannot all miss the scene-summary row before the leader upserts it.
  const contextEnrichmentSingleFlight =
    input.contextArtifactRepository !== undefined
      ? new SceneContextEnrichmentSingleFlight()
      : undefined;

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

  let resumeState: DrivenJournalResumeState | undefined;
  if (input.resumeRunId !== undefined) {
    if (
      input.sinks.journal.loadResumeState === undefined ||
      input.sinks.journal.resumeJournalRun === undefined
    ) {
      throw new Error("resume requires a journal sink with durable load and resume support");
    }
    // Load first so a typo cannot silently seed a brand-new run under an id
    // the operator explicitly asked to resume.
    resumeState = await input.sinks.journal.loadResumeState(journalRun.runId);
    if (resumeState.status !== "paused" && resumeState.status !== "running") {
      throw new Error(
        `cannot resume journal run ${journalRun.runId} from terminal/finalizer state ${resumeState.status}`,
      );
    }
  }

  // Freeze and seed the COMPLETE scope before any provider is constructed or
  // dispatched. Pending rows carry identity + next action only—never source
  // text or a fabricated candidate. A resumed run is governed by its durable
  // policy, not the present CLI/config arguments: a previous cap raise stores
  // an exact decimal string and rebuilding `null` here would both erase that
  // authority and trip the repository's run_seed_conflict protection.
  const runPlan: DrivenJournalRunPlan = {
    run: journalRun,
    frozenScope: {
      translationScope,
      bridgeUnitIds: enumerated.map((entry) => entry.unit.bridgeUnitId),
    },
    routingPolicy: input.pairPolicy,
    costPolicy: resumeState?.costPolicy ?? {
      budgetCapUsd: input.budgetCapUsd ?? null,
      reservation: "node_4_seam",
    },
    units: enumerated.map((entry) => ({
      bridgeUnitId: entry.unit.bridgeUnitId,
      sourceUnitKey: entry.unit.sourceUnitKey,
      nextAction: { kind: "drive_unit", stage: "context" },
    })),
  };

  // New runs are atomically established here. Existing runs are re-seeded
  // idempotently to verify the frozen scope/policies before any resumed call.
  await input.sinks.journal.beginJournalRun?.(
    runPlan,
    resumeState === undefined ? "new" : "resume",
  );

  if (resumeState !== undefined) {
    // Explicit resume also reconciles any pre-dispatch attempt left in the
    // dispatching state by a process crash, including when the durable run was
    // still marked running at the time of death. The repository's atomic
    // PostgreSQL-now predicate is the sole lease-expiry authority; executor
    // host-clock skew must never admit a takeover.
    await input.sinks.journal.resumeJournalRun!(journalRun.runId);
    resumeState = await input.sinks.journal.loadResumeState!(journalRun.runId);
    if (resumeState.status !== "running" || resumeState.pausedBlocker !== null) {
      throw new Error(`journal run ${journalRun.runId} did not enter running state on resume`);
    }
    const unresolved = (resumeState.attempts ?? []).filter(
      (attempt) => attempt.completedAt === null,
    );
    if (unresolved.length > 0) {
      throw new Error(
        `journal run ${journalRun.runId} resume left ${unresolved.length} attempt(s) dispatching`,
      );
    }
  }

  const policy: AgenticLoopPolicy = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceLocale: input.bridge.sourceLocale,
    targetLocale,
    maxRepairAttempts: input.maxRepairAttempts ?? 1,
    ...(input.now !== undefined ? { now: input.now } : {}),
  };

  const failures: DrivenUnitFailure[] = [];
  const writtenBodies = new Map<string, string>();
  const writtenUnits: DrivenPatchReport["writtenUnits"] = [];
  // Per-unit outcome accumulator (canonical order), retained for callers that
  // need an immediate in-memory projection in addition to the durable journal.
  const unitOutcomes: DrivenWrittenOutcomeRecord[] = [];
  let unitsRun = 0;
  let writtenOutcomesPersisted = 0;
  let writtenOutcomeCount = 0;
  let journalUnitsPersisted = 0;
  const resumedAttempts = resumeState?.attempts ?? [];
  let attemptsPersisted = resumedAttempts.length;
  let totalUsageCostExactUsd = resumedAttempts.reduce(
    (total, attempt) => addDecimalUsd(total, attempt.costUsd ?? "0"),
    "0",
  );
  let zdrConfirmed = resumedAttempts.every((attempt) => attempt.zdr);
  let sawPhysicalInvocation = resumedAttempts.length > 0;
  let budgetStopped = false;
  let pausedBlocker: OperationalBlocker | null = null;

  const resumedWrittenIds = new Set<string>();
  for (const written of resumeState?.writtenOutcomes ?? []) {
    const source = enumerated.find(
      (entry) => entry.unit.bridgeUnitId === written.bridgeUnitId,
    )?.unit;
    if (source === undefined) {
      throw new Error(
        `durable run ${journalRun.runId} contains written unit ${written.bridgeUnitId} outside the frozen bridge scope`,
      );
    }
    assertSelectedTargetBody({
      body: written.selectedBody,
      sourceText: source.sourceText,
      label: `resumed selected candidate for ${written.bridgeUnitId}`,
    });
    resumedWrittenIds.add(written.bridgeUnitId);
    writtenBodies.set(written.bridgeUnitId, written.selectedBody);
    writtenUnits.push({
      bridgeUnitId: written.bridgeUnitId,
      sourceUnitKey: written.sourceUnitKey,
      selectedBody: written.selectedBody,
      qualityFlags: written.outcome.qualityFlags.slice(),
    });
    unitOutcomes.push(written);
    writtenOutcomeCount += 1;
  }

  // itotori-batched-concurrent-translation-scheduling — the pilot must scale to
  // a whole route/game, but the per-unit loop fires ~10 ZDR calls, so running
  // units strictly sequentially is ~25 min for four units. We schedule up to
  // `concurrency` units' `runAgenticLoopForUnit` at once via a bounded
  // worker-pool over the canonical unit list. Every completed unit is durably
  // journaled by its worker immediately; canonical ordering remains only for
  // the returned aggregate and patch assembly below.
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? DEFAULT_DRIVEN_CONCURRENCY));

  // `maxUnits` is a DISPATCH cap: the pool drives AT MOST this many in-scope
  // units (canonical prefix). A failed unit is isolated but still consumes a
  // dispatch slot — the cap bounds provider calls, not successes.
  const maxUnits = input.maxUnits ?? enumerated.length;
  const plannedUnits = enumerated
    .filter((entry) => !resumedWrittenIds.has(entry.unit.bridgeUnitId))
    .slice(0, Math.max(0, maxUnits));

  // Result slots, one per planned unit, addressed by CANONICAL index. A slot is
  // filled by whichever worker completed and journaled that unit; `undefined`
  // means the unit was never dispatched (budget cap tripped first). The final
  // report and patch assembly walk these slots in index order, so externally
  // returned data remains deterministic even though durable writes stream by
  // completion order.
  const slots: Array<UnitRunResult | undefined> = Array.from({ length: plannedUnits.length });

  let nextIndex = 0;
  const lifecycle = invocationLifecycleFor(input.sinks.journal);
  // Every physical provider call must pass through durable cost admission.
  // Unlimited accounts intentionally participate too: they record exact
  // spent/reserved state so an operator can later add a finite cap without
  // erasing the run's historical provider spend.
  const costAdmission =
    input.costAdmission ?? input.sinks.journal.createCostAdmission?.(journalRun.runId);
  if (costAdmission === undefined) {
    throw new Error(
      "every driven run requires a durable atomic cost-admission journal sink or an explicit admission implementation",
    );
  }

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (pausedBlocker !== null) return;
      // Claim the next canonical index atomically (no await between read+bump).
      const index = nextIndex;
      if (index >= plannedUnits.length) {
        return;
      }
      nextIndex += 1;

      const enumeratedUnit = plannedUnits[index]!;
      let result = await runSingleDrivenUnit({
        enumeratedUnit,
        input,
        policy,
        targetLocale,
        engineProfile,
        journalRun,
        lifecycle,
        costAdmission,
        contextEnrichmentSingleFlight,
        log,
      });
      // Durability boundary: stream this completed unit now instead of waiting
      // for every unrelated worker to drain. A process failure after another
      // unit completes cannot erase this unit's attempts/outcome evidence.
      try {
        await persistCompletedUnitJournal(input.sinks.journal, result);
      } catch (error) {
        const blocker = itotoriBugBlocker({
          runId: journalRun.runId,
          bridgeUnitId: enumeratedUnit.unit.bridgeUnitId,
          operation: "persist completed unit journal",
          error,
          raisedAt: input.now?.() ?? new Date(),
        });
        await input.sinks.journal.pauseRun?.(journalRun.runId, blocker);
        const attempts = result.journal.attempts;
        result = {
          status: "paused",
          blocker,
          journal: {
            run: journalRun,
            bridgeUnitId: enumeratedUnit.unit.bridgeUnitId,
            sourceUnitKey: enumeratedUnit.unit.sourceUnitKey,
            attempts: [...attempts],
          },
          telemetry: result.telemetry,
        };
      }
      slots[index] = result;
      if (result.status === "paused") {
        pausedBlocker ??= result.blocker;
        budgetStopped = budgetStopped || result.blocker.kind === "budget_cap";
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, plannedUnits.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (pausedBlocker !== null) {
    // pauseRun intentionally retains the fence while sibling workers still
    // have live provider calls. Only this post-Promise.all quiescence boundary
    // makes the paused run available to a new owner.
    await input.sinks.journal.releasePausedRunLease?.(journalRun.runId);
  }

  // (c) Assemble the aggregate in CANONICAL order. The journal has already
  // been persisted incrementally inside each worker; only the returned
  // in-memory projection, patch body map, and buffered reviewer side-channel
  // retain canonical ordering here.
  for (const slot of slots) {
    if (slot === undefined) {
      continue; // never dispatched (budget cap) — no patch may export incomplete coverage.
    }
    totalUsageCostExactUsd = addDecimalUsd(
      totalUsageCostExactUsd,
      slot.telemetry.totalCostExactUsd,
    );
    if (slot.telemetry.invocationCount > 0) {
      sawPhysicalInvocation = true;
      zdrConfirmed = zdrConfirmed && slot.telemetry.zdr;
    }
    if (slot.status === "paused") {
      attemptsPersisted += slot.journal.attempts.length;
      pausedBlocker ??= slot.blocker;
      continue;
    }

    unitsRun += 1;

    writtenOutcomesPersisted += 1;
    journalUnitsPersisted += 1;
    attemptsPersisted += slot.journal.attempts.length;
    // Capture this outcome for the returned in-memory projection in canonical order.
    unitOutcomes.push(slot.writtenOutcomeRecord);

    // PERSIST — the reviewer_queue_items the loop's bridge produced for this
    // unit, replayed onto the REAL sink in canonical order (they were buffered
    // during the concurrent run so completion interleaving never reorders them).
    if (input.reviewerQueue !== undefined) {
      for (const captured of slot.queueCaptures) {
        await flushCapturedReviewerQueueItem(input.reviewerQueue, captured);
      }
    }

    writtenOutcomeCount += 1;
    writtenBodies.set(slot.unit.bridgeUnitId, slot.exportBody);
    writtenUnits.push({
      bridgeUnitId: slot.unit.bridgeUnitId,
      sourceUnitKey: slot.unit.sourceUnitKey,
      selectedBody: slot.writtenOutcomeRecord.selectedBody,
      qualityFlags: slot.writtenOutcomeRecord.outcome.qualityFlags.slice(),
    });
  }

  // Count reviewer-queue items emitted by the legacy bridge. Written outcomes
  // do not depend on this informational side channel.
  const reviewerQueueItemCount = await countReviewerQueueItems(input);

  // Coverage is the export gate. Do not turn an operational failure, budget
  // pause, or bounded pilot slice into source text just to manufacture a
  // complete-looking bridge. The later run finalizer/supervisor owns resume.
  const coverageComplete = pausedBlocker === null && writtenBodies.size === unitsInScope;
  // Existing call sites render a number, but all accounting and persistence
  // above use this exact decimal string. Do not feed this projection back into
  // any journal or decision path.
  const totalUsageCostUsd = Number(totalUsageCostExactUsd);
  zdrConfirmed = sawPhysicalInvocation ? zdrConfirmed : false;
  const patchReport: DrivenPatchReport = {
    schemaVersion: "itotori.project-driven-executor.patch-report.v0",
    journalRunId: journalRun.runId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    targetLocale,
    pair: input.pair,
    engineProfile,
    translationScope,
    unitsEnumerated,
    unitsInScope,
    unitsRun,
    writtenOutcomeCount,
    failureCount: failures.length,
    reviewerQueueItemCount,
    totalUsageCostExactUsd,
    totalUsageCostUsd,
    zdrConfirmed,
    budgetStopped,
    coverageComplete,
    sourceBridgeHash: hashDraftedAgainstBridge(input.rawBridge),
    writtenUnits,
  };
  if (coverageComplete && pausedBlocker === null) {
    const translatedBridge = synthesiseDrivenTranslatedBridge({
      rawBridge: input.rawBridge,
      writtenBodies,
      inScopeUnitIds: new Set(enumerated.map((entry) => entry.unit.bridgeUnitId)),
      engineProfile,
      targetLocale,
    });
    await input.sinks.patchExport.exportPatch({ translatedBridge, patchReport });
  }
  log(
    `project-driven-executor: ran ${unitsRun} unit(s); ${writtenOutcomeCount} written, ${failures.length} failed; coverageComplete=${coverageComplete}; ${reviewerQueueItemCount} queue item(s); total usage.cost $${totalUsageCostExactUsd} (zdr=${zdrConfirmed})`,
  );

  return {
    journalRunId: journalRun.runId,
    runState: pausedBlocker === null ? "running" : "paused",
    pausedBlocker,
    unitsEnumerated,
    unitsInScope,
    unitsRun,
    writtenOutcomesPersisted,
    writtenOutcomeCount,
    journalUnitsPersisted,
    attemptsPersisted,
    reviewerQueueItemCount,
    patchExportCount: coverageComplete ? 1 : 0,
    failures,
    unitOutcomes,
    totalUsageCostExactUsd,
    totalUsageCostUsd,
    zdrConfirmed,
    budgetStopped,
    patchReport,
  };
}

// ---------------------------------------------------------------------------
// Bounded-concurrent unit scheduling — per-unit worker + deterministic buffers
// ---------------------------------------------------------------------------

function invocationLifecycleFor(sink: DrivenUnitJournalSink): InvocationLifecycle | undefined {
  if (
    sink.attemptStarted === undefined &&
    sink.attemptCompleted === undefined &&
    sink.pauseRun === undefined
  ) {
    return undefined;
  }
  return {
    attemptStarted: async (attempt) => {
      return await sink.attemptStarted?.(attempt);
    },
    attemptCompleted: async (attempt) => {
      await sink.attemptCompleted?.(attempt);
    },
    pauseRun: async (runId, blocker) => {
      await sink.pauseRun?.(runId, blocker);
    },
  };
}

function itotoriBugBlocker(input: {
  runId: string;
  bridgeUnitId: string;
  operation: string;
  error: unknown;
  raisedAt: Date;
}): OperationalBlocker {
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    kind: "itotori_bug",
    detail: `${input.operation}: ${detail}`,
    evidence: `journal-run:${input.runId};unit:${input.bridgeUnitId};operation:${input.operation}`,
    raisedAt: input.raisedAt.toISOString(),
    operatorAction: "fix the itotori defect, then resume this run",
  };
}

/**
 * The fully-computed outcome of driving ONE unit through the agentic loop,
 * captured (NOT persisted) inside a worker so the pool can run units
 * concurrently and the caller can persist them in CANONICAL order afterwards.
 */
type UnitRunResult = UnitRunSuccess | UnitRunPaused;

type UnitRunSuccess = {
  status: "success";
  unit: LocalizationUnitV02;
  writtenOutcomeRecord: DrivenWrittenOutcomeRecord;
  journal: DrivenUnitJournalRecord;
  telemetry: ProviderTelemetrySummary;
  /** The selected body after engine-specific out-of-band markup removal. */
  exportBody: string;
  /** Reviewer-queue writes the loop's bridge buffered for ordered replay. */
  queueCaptures: CapturedReviewerQueueCreate[];
};

type UnitRunPaused = {
  status: "paused";
  blocker: OperationalBlocker;
  journal: DrivenFailedUnitJournalRecord;
  telemetry: ProviderTelemetrySummary;
};

/**
 * Drive ONE unit through `runAgenticLoopForUnit` and capture its complete
 * journal payload. The worker persists that payload immediately after this
 * function returns; reviewer-queue writes stay buffered for canonical replay
 * later. Any unexpected exception is an operational itotori bug: the durable
 * run is paused and the unit remains pending. No exception becomes a terminal
 * per-unit outcome. Config-driven scope + the (modelId, providerId) pinning +
 * ZDR posture all thread through the loop unchanged.
 */
async function runSingleDrivenUnit(args: {
  enumeratedUnit: EnumeratedUnit;
  input: ProjectDrivenExecutorInput;
  policy: AgenticLoopPolicy;
  targetLocale: string;
  engineProfile: DrivenEngineProfile;
  journalRun: DrivenJournalRunRecord;
  lifecycle: InvocationLifecycle | undefined;
  costAdmission: InvocationCostAdmission;
  contextEnrichmentSingleFlight: ContextEnrichmentSingleFlight | undefined;
  log: (message: string) => void;
}): Promise<UnitRunResult> {
  const {
    enumeratedUnit,
    input,
    policy,
    targetLocale,
    engineProfile,
    journalRun,
    lifecycle,
    costAdmission,
    contextEnrichmentSingleFlight,
    log,
  } = args;
  const { unit, unitIndex, plannerSceneId, sceneUnits } = enumeratedUnit;
  // Resolve the per-unit structure-informed context OUTSIDE the try block so
  // the failure path can surface it in the diagnostic (itotori-agent-facing-
  // pipeline-failure-diagnostics — scene id helps the driving agent reproduce
  // the failing slice). The resolver is a pure function that never throws.
  const context = input.resolveUnitContext?.({ unit, unitIndex, plannerSceneId });
  // TODO(p0-core-universal-invocation-supervisor-retry): InvocationSupervisor
  // owns the stricter atomic "attempt row before physical provider call"
  // contract. This executor can only persist the completed unit immediately
  // after the capture wrapper returns, which prevents whole-pool buffering but
  // does not claim pre-call atomicity.
  const providerAttempts = capturePhysicalProviderAttempts({
    runId: journalRun.runId,
    bridgeUnitId: unit.bridgeUnitId,
    source: input.providerFactory,
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    costAdmission,
  });
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

    // Thread THIS unit's optional prior-run feedback (if the
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
      sourceRevisionId: input.sourceRevisionId,
      // The planner batch is the real bounded scene/route evidence available
      // for this unit. The loop adds `unit` itself, so this list contains only
      // its siblings and never duplicates the current source body.
      sceneUnits,
      semanticSceneKey:
        context?.sceneId !== undefined
          ? String(context.sceneId)
          : (plannerSceneId ?? unit.sourceUnitKey),
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
      attemptOutcomeObserver: providerAttempts.attemptOutcomeObserver,
      ...(bufferedQueue !== undefined ? { reviewerQueue: bufferedQueue } : {}),
      // Persistent context brain — central store as source/sink/invalidation.
      ...(input.contextArtifactRepository !== undefined
        ? { contextArtifactRepository: input.contextArtifactRepository }
        : {}),
      ...(contextEnrichmentSingleFlight !== undefined ? { contextEnrichmentSingleFlight } : {}),
      // Thread THIS unit's optional prior-run feedback (if the
      // run is a pass N+1 driven run with a prior context) so the translation
      // prompt iterates on the prior accepted state / flagged-unit feedback.
      ...(priorPassFeedback !== undefined ? { priorPassFeedback } : {}),
      ...(input.priorPass?.journalRunId !== undefined
        ? { priorJournalRunId: input.priorPass.journalRunId }
        : {}),
    };

    const bundle = await runAgenticLoopForUnit(
      unitInput,
      input.pairPolicy,
      policy,
      providerAttempts.providerFactory,
    );
    providerAttempts.markSuccessful();

    const writtenOutcomeRecord = materializeDrivenWrittenOutcome({
      unit,
      sceneId: context?.sceneId,
      targetLocale,
      outcome: bundle.writtenOutcome,
    });
    const telemetry = summariseCapturedProviderAttempts(providerAttempts.attempts, input.pair);
    const journal = materializeDrivenUnitJournal({
      run: journalRun,
      writtenOutcome: writtenOutcomeRecord,
      attempts: [...providerAttempts.attempts],
    });

    // Strip out-of-band kidoku markup so the patchback splice matches the
    // engine-visible selected body (mirrors the single-unit driver).
    const exportBody =
      engineProfile === "rpg-maker-mv-mz"
        ? writtenOutcomeRecord.selectedBody
        : stripOutOfBandControlMarkup(writtenOutcomeRecord.selectedBody);
    const exportSourceText =
      engineProfile === "rpg-maker-mv-mz"
        ? unit.sourceText
        : stripOutOfBandControlMarkup(unit.sourceText);
    assertSelectedTargetBody({
      body: exportBody,
      sourceText: exportSourceText,
      label: `export body for ${unit.bridgeUnitId}`,
    });

    return {
      status: "success",
      unit,
      writtenOutcomeRecord,
      journal,
      telemetry,
      exportBody,
      queueCaptures,
    };
  } catch (error) {
    // No exception becomes a terminal unit failure. Model-output failures are
    // already classified by InvocationSupervisor; anything else is an
    // itotori defect and pauses the durable run with this unit still pending.
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
    const blocker: OperationalBlocker = isInvocationOperationalPause(error)
      ? error.blocker
      : error instanceof InvocationRetryCeilingError
        ? {
            kind: "itotori_bug",
            detail: error.message,
            evidence: `${error.lastFailure}:${error.detail}`,
            raisedAt: (input.now?.() ?? new Date()).toISOString(),
            operatorAction: "fix the model/tool/schema configuration, then resume",
          }
        : {
            kind: "itotori_bug",
            detail: `${diagnostic.errorClass}: ${diagnostic.errorMessage}`,
            evidence: `journal-run:${journalRun.runId};unit:${unit.bridgeUnitId};diagnostic:${diagnostic.errorClass}`,
            raisedAt: (input.now?.() ?? new Date()).toISOString(),
            operatorAction: "fix the itotori defect, then resume this run",
          };
    await input.sinks.journal.pauseRun?.(journalRun.runId, blocker);
    log(
      `project-driven-executor: unit ${unit.sourceUnitKey} PAUSED run (${blocker.kind}): ${blocker.detail}`,
    );
    return {
      status: "paused",
      blocker,
      journal: {
        run: journalRun,
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        attempts: [...providerAttempts.attempts],
      },
      telemetry: summariseCapturedProviderAttempts(providerAttempts.attempts, input.pair),
    };
  }
}

/**
 * Persist one completed worker result at the durable journal boundary. This is
 * intentionally called INSIDE the worker, before it claims another unit and
 * before the pool is awaited, so completed evidence survives a later-worker
 * crash. The repository keeps successful attempts + outcome atomic; failed
 * units persist their observed physical attempts without fabricating an
 * outcome.
 */
async function persistCompletedUnitJournal(
  sink: DrivenUnitJournalSink,
  result: UnitRunResult,
): Promise<void> {
  if (result.status === "success") {
    await sink.persistUnitJournal(result.journal);
    return;
  }
  if (result.journal.attempts.length > 0) {
    await sink.persistFailedUnitAttempts(result.journal);
  }
}

/**
 * Validate and project the loop package's canonical outcome at the executor
 * boundary. The package validates its own wire shape, but this boundary also
 * binds it to the unit the worker was asked to run and refuses the historic
 * source-repetition convention before persistence/export can observe it.
 */
export function materializeDrivenWrittenOutcome(args: {
  unit: Pick<LocalizationUnitV02, "bridgeUnitId" | "sourceUnitKey" | "sourceText">;
  sceneId: number | undefined;
  targetLocale: string;
  outcome: WrittenUnitOutcome;
}): DrivenWrittenOutcomeRecord {
  const { unit, sceneId, targetLocale, outcome } = args;
  if (outcome.status !== "written") {
    throw new AgenticLoopInvariantError(
      `written outcome for ${unit.bridgeUnitId} has unsupported status '${String(outcome.status)}'`,
    );
  }
  if (outcome.unitId !== unit.bridgeUnitId) {
    throw new AgenticLoopInvariantError(
      `written outcome unitId '${outcome.unitId}' does not match requested unit '${unit.bridgeUnitId}'`,
    );
  }
  if (outcome.targetLocale !== targetLocale) {
    throw new AgenticLoopInvariantError(
      `written outcome targetLocale '${outcome.targetLocale}' does not match requested locale '${targetLocale}'`,
    );
  }
  const selectedCandidate = outcome.candidates.find(
    (candidate) => candidate.id === outcome.selectedCandidateId,
  );
  if (selectedCandidate === undefined) {
    throw new AgenticLoopInvariantError(
      `written outcome for ${unit.bridgeUnitId} has no candidate '${outcome.selectedCandidateId}'`,
    );
  }
  if (selectedCandidate.outcomeId !== outcome.id) {
    throw new AgenticLoopInvariantError(
      `selected candidate '${selectedCandidate.id}' is not bound to written outcome '${outcome.id}'`,
    );
  }
  const selectedBody = selectedCandidate.body;
  assertSelectedTargetBody({
    body: selectedBody,
    sourceText: unit.sourceText,
    label: `selected candidate '${selectedCandidate.id}' for ${unit.bridgeUnitId}`,
  });
  return {
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    sceneId,
    outcome,
    selectedBody,
  };
}

/**
 * Project the loop's exact auxiliary provenance into normalized journal input.
 * The canonical `WrittenUnitOutcome` remains unchanged; this preserves fields
 * that its concise presentation surface intentionally does not promote.
 */
export function materializeDrivenUnitJournal(args: {
  run: DrivenJournalRunRecord;
  writtenOutcome: DrivenWrittenOutcomeRecord;
  attempts: DrivenLlmAttemptRecord[];
}): DrivenUnitJournalRecord {
  const journalProvenance = readOutcomeJournalProvenance(args.writtenOutcome.outcome.provenance);
  const contextRefs: DrivenOutcomeContextRef[] = journalProvenance.contextArtifactIds.map(
    (refId) => ({
      refKind: contextRefKind(refId),
      refId,
    }),
  );
  for (const refId of journalProvenance.contextVersionRefs) {
    contextRefs.push({ refKind: "context_version", refId, versionRef: refId });
  }
  for (const resolvedRef of journalProvenance.resolvedContextRefs) {
    contextRefs.push({
      refKind: resolvedRef.refKind,
      refId: resolvedRef.refId,
      ...(resolvedRef.versionRef !== undefined ? { versionRef: resolvedRef.versionRef } : {}),
      ...(resolvedRef.details !== undefined ? { details: resolvedRef.details } : {}),
    });
  }
  for (const citationRef of journalProvenance.selectedCandidateCitationRefs) {
    contextRefs.push({ refKind: "selected_candidate_citation", refId: citationRef });
  }
  const qaDetails: Record<string, DrivenQaFindingDetail> = {};
  for (const detail of journalProvenance.qaFindingDetails) {
    qaDetails[detail.findingId] = {
      recommendation: detail.recommendation,
      agentRationale: detail.agentRationale,
      evidenceRefs: detail.evidenceRefs.slice(),
      ...(detail.sourceSpan !== undefined ? { sourceSpan: { ...detail.sourceSpan } } : {}),
      ...(detail.draftSpan !== undefined ? { draftSpan: { ...detail.draftSpan } } : {}),
    };
  }
  return {
    run: args.run,
    writtenOutcome: args.writtenOutcome,
    attempts: args.attempts,
    contextPacket: journalProvenance.resolvedContextPacket,
    contextRefs,
    speakerLabels: journalProvenance.speakerLabels,
    qaDetails,
  };
}

function contextRefKind(ref: string): string {
  const separator = ref.indexOf(":");
  return separator > 0 ? ref.slice(0, separator) : "context_artifact";
}

function assertSelectedTargetBody(args: { body: string; sourceText: string; label: string }): void {
  const body = args.body.trim();
  if (body.length === 0) {
    throw new AgenticLoopInvariantError(`${args.label} must be non-blank`);
  }
  if (body !== args.body) {
    throw new AgenticLoopInvariantError(`${args.label} must already be trimmed`);
  }
  if (isLocaleTaggedSourceEcho(body)) {
    throw new AgenticLoopInvariantError(`${args.label} must not use a locale-tagged source replay`);
  }
  if (args.sourceText.trim().length > 0 && body === args.sourceText.trim()) {
    throw new AgenticLoopInvariantError(`${args.label} must not echo the source text`);
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
  /** Other real bridge units retained from this unit's planner batch. */
  sceneUnits: ReadonlyArray<LocalizationUnitV02>;
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
    // Keep the concrete bridge units behind planner refs. The planner's batch
    // boundary is the only production source of sibling scene evidence for a
    // driven unit; retaining it here prevents the later loop call from seeing
    // an empty synthetic scene.
    const batchUnits = batch.units.flatMap((ref) => {
      const found = unitById.get(ref.bridgeUnitId);
      return found === undefined ? [] : [found];
    });
    for (const found of batchUnits) {
      if (seen.has(found.unit.bridgeUnitId)) {
        continue;
      }
      if (!unitSurfaceKindInScope(found.unit.surfaceKind, args.translationScope)) {
        continue;
      }
      seen.add(found.unit.bridgeUnitId);
      enumerated.push({
        unit: found.unit,
        unitIndex: found.index,
        plannerSceneId: batch.sceneId,
        sceneUnits: batchUnits
          .filter((candidate) => candidate.unit.bridgeUnitId !== found.unit.bridgeUnitId)
          .map((candidate) => candidate.unit),
      });
    }
  }
  return enumerated;
}

// ---------------------------------------------------------------------------
// Provider telemetry summary — real usage.cost + ZDR
// ---------------------------------------------------------------------------

/**
 * A compatibility-friendly telemetry projection with one exact decimal field.
 * The number field is only for legacy display consumers; journal persistence,
 * patch reconciliation, and executor budget accounting consume
 * `totalCostExactUsd` instead.
 */
export type ProviderTelemetrySummary = {
  pair: { modelId: string; providerId: string };
  invocationCount: number;
  totalCostExactUsd: string;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  zdr: boolean;
};

/**
 * Summarize the physical attempts captured at the provider boundary. This is
 * the project executor's accounting source: unlike bundle telemetry it also
 * includes calls made before a handled partial QA/repair failure.
 */
export function summariseCapturedProviderAttempts(
  attempts: readonly DrivenLlmAttemptRecord[],
  pair: { modelId: string; providerId: string },
): ProviderTelemetrySummary {
  let totalCostExactUsd = "0";
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let zdr = true;
  for (const attempt of attempts) {
    if (attempt.costUsd !== null) {
      totalCostExactUsd = addDecimalUsd(totalCostExactUsd, attempt.costUsd);
    }
    totalTokensIn += attempt.tokensIn ?? 0;
    totalTokensOut += attempt.tokensOut ?? 0;
    zdr = zdr && attempt.zdr;
  }
  return {
    pair,
    invocationCount: attempts.length,
    totalCostExactUsd,
    // Compatibility/display projection only. Never use this to persist,
    // compare a budget, or reconstruct a journal total.
    totalCostUsd: Number(totalCostExactUsd),
    totalTokensIn,
    totalTokensOut,
    // A unit that fired zero invocations cannot assert a ZDR posture.
    zdr: attempts.length > 0 ? zdr : false,
  };
}

/**
 * Legacy bundle helper retained for the repair executor. It now performs the
 * same lossless decimal addition as the physical-attempt path; callers should
 * prefer {@link summariseCapturedProviderAttempts} whenever capture is
 * available.
 */
export function summariseProviderTelemetry(
  bundle: AgenticLoopBundle,
  pair: { modelId: string; providerId: string },
): ProviderTelemetrySummary {
  let invocationCount = 0;
  let totalCostExactUsd = "0";
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
      totalCostExactUsd = addDecimalUsd(totalCostExactUsd, invocation.costUsd);
      totalTokensIn += invocation.tokensIn;
      totalTokensOut += invocation.tokensOut;
      zdr = zdr && invocation.zdr === true;
    }
  }
  return {
    pair,
    invocationCount,
    totalCostExactUsd,
    // Compatibility/display projection only. The repair executor has no
    // physical-attempt journal yet, so this remains a legacy boundary.
    totalCostUsd: Number(totalCostExactUsd),
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
 * Build the translated v0.2 BridgeBundle for a coverage-complete driven run.
 * Every IN-SCOPE unit must have a selected, non-blank target body. Missing
 * in-scope text is an operational failure, never an invitation to synthesize
 * `target === source`. Out-of-scope units retain the byte-no-op projection.
 */
export function synthesiseDrivenTranslatedBridge(args: {
  rawBridge: unknown;
  writtenBodies: ReadonlyMap<string, string>;
  inScopeUnitIds: ReadonlySet<string>;
  engineProfile: DrivenEngineProfile;
  targetLocale: string;
}): unknown {
  const { rawBridge, writtenBodies, inScopeUnitIds, engineProfile, targetLocale } = args;
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("project-driven-executor refused: bridge JSON must be an object");
  }
  const clone = JSON.parse(JSON.stringify(rawBridge)) as Record<string, unknown>;
  const units = clone.units;
  if (!Array.isArray(units)) {
    throw new Error("project-driven-executor refused: bridge.units must be an array");
  }
  const seenInScope = new Set<string>();
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
    const inScope = typeof bridgeUnitId === "string" && inScopeUnitIds.has(bridgeUnitId);
    if (inScope) {
      seenInScope.add(bridgeUnitId);
      const writtenBody = writtenBodies.get(bridgeUnitId);
      if (writtenBody === undefined) {
        throw new Error(
          `project-driven-executor refused: in-scope unit ${bridgeUnitId} has no written body; refusing target-source substitution`,
        );
      }
      assertSelectedTargetBody({
        body: writtenBody,
        sourceText:
          engineProfile === "rpg-maker-mv-mz"
            ? sourceText
            : stripOutOfBandControlMarkup(sourceText),
        label: `written body for ${bridgeUnitId}`,
      });
      record.target = {
        locale: targetLocale,
        text:
          engineProfile === "rpg-maker-mv-mz" ? writtenBody : bracketWrapForRealLive(writtenBody),
      };
      continue;
    }
    // Configured-out units are deliberately byte-no-op. This branch is never
    // available to an in-scope unit, even when a worker failed or stopped.
    record.target = { locale: targetLocale, text: sourceText };
  }
  for (const bridgeUnitId of inScopeUnitIds) {
    if (!seenInScope.has(bridgeUnitId)) {
      throw new Error(
        `project-driven-executor refused: in-scope unit ${bridgeUnitId} is absent from raw bridge export`,
      );
    }
  }
  return clone;
}
