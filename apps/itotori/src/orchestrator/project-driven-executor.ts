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

import type { AuthorizationActor } from "@itotori/db";
import type {
  AgenticLoopBundle,
  BridgeBundleV02,
  LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import { planBatches } from "../batch-planner/planner.js";
import { resolveModelProfile } from "../batch-planner/model-profiles.js";
import type { NarrativeStructure } from "../agents/structure-informed-context/index.js";
import type { AgenticLoopReviewerQueueSink } from "./reviewer-queue-bridge.js";
import {
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

/**
 * Per-unit structure-informed context. The executor threads the decoded
 * `narrativeStructure` + the unit's numeric `sceneId` into every
 * `runAgenticLoopForUnit` call (per P0#1). Both fields travel together or not
 * at all — the loop rejects a structure without a scene id.
 */
export type DrivenUnitContext = {
  narrativeStructure: NarrativeStructure;
  sceneId: number;
};

/**
 * Resolve the per-unit structure-informed context. The caller owns the
 * mapping from a bridge unit (+ the planner's scene grouping) to the decoded
 * scene, because only the caller holds the (copyrighted, out-of-repo) decoded
 * `narrativeStructure`. Returning `undefined` runs the loop WITHOUT a
 * deterministic structure block (the four semantic agents still fire live) —
 * used by the synthetic path that has no decode.
 */
export type DrivenUnitContextResolver = (args: {
  unit: LocalizationUnitV02;
  unitIndex: number;
  /** The planner's (string) scene id for this unit's batch, when grouped. */
  plannerSceneId: string | undefined;
}) => DrivenUnitContext | undefined;

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
  /** The accepted units + their REAL translated body (the patchback splices). */
  acceptedUnits: Array<{ bridgeUnitId: string; sourceUnitKey: string; finalDraftText: string }>;
};

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
  /** Per-unit real-context resolver (per P0#1). */
  resolveUnitContext?: DrivenUnitContextResolver;
  /** Config-driven translation scope. Defaults to dialogue-only. */
  translationScope?: TranslationScope;
  /** Engine profile controlling the translated-bundle synthesis. */
  engineProfile?: DrivenEngineProfile;
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
   * USD budget cap on the REAL total `usage.cost`. After a unit pushes the
   * running total at/above the cap, the executor stops enumerating further
   * units (records `budgetStopped`). A bounded, cost-safe pilot guard.
   */
  budgetCapUsd?: number;
  now?: () => Date;
  log?: (message: string) => void;
};

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
  let unitsRun = 0;
  let draftsPersisted = 0;
  let acceptedDraftCount = 0;
  let deferredCount = 0;
  let providerRunsPersisted = 0;
  let totalUsageCostUsd = 0;
  let zdrConfirmed = true;
  let budgetStopped = false;

  const maxUnits = input.maxUnits ?? enumerated.length;

  for (const enumeratedUnit of enumerated) {
    if (unitsRun >= maxUnits) {
      break;
    }
    if (input.budgetCapUsd !== undefined && totalUsageCostUsd >= input.budgetCapUsd) {
      budgetStopped = true;
      log(
        `project-driven-executor: budget cap $${input.budgetCapUsd} reached ($${totalUsageCostUsd.toFixed(6)}); stopping before unit ${enumeratedUnit.unit.sourceUnitKey}`,
      );
      break;
    }

    const { unit, unitIndex, plannerSceneId } = enumeratedUnit;
    // PER-UNIT ISOLATION — one unit's failure (incl. a live semantic-agent
    // malformed pack, the filed P2) NEVER aborts the whole run.
    try {
      const context = input.resolveUnitContext?.({ unit, unitIndex, plannerSceneId });
      const unitInput: AgenticLoopUnitInput = {
        unit,
        sceneUnits: [],
        glossary: [],
        protectedSpans: [],
        knownCharacters: [],
        ...(context !== undefined
          ? { narrativeStructure: context.narrativeStructure, sceneId: context.sceneId }
          : {}),
        actor: input.actor,
        ...(input.reviewerQueue !== undefined ? { reviewerQueue: input.reviewerQueue } : {}),
      };

      const bundle = await runAgenticLoopForUnit(
        unitInput,
        input.pairPolicy,
        policy,
        input.providerFactory,
      );
      unitsRun += 1;

      // (c) PERSIST — the draft outcome FIRST. The DB provider-run ledger's FK
      // references the draft attempt persistDraft creates, so the draft must
      // land before the provider-run row (the shared adapter keys the attempt
      // id by bridgeUnitId).
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
      await input.sinks.draft.persistDraft(draftRecord);
      draftsPersisted += 1;

      // (c) PERSIST — provider-run summary (real usage.cost + ZDR).
      const telemetry = summariseProviderTelemetry(bundle, input.pair);
      totalUsageCostUsd += telemetry.totalCostUsd;
      zdrConfirmed = zdrConfirmed && telemetry.zdr;
      await input.sinks.providerRun.persistProviderRun({
        bridgeUnitId: unit.bridgeUnitId,
        ...telemetry,
      });
      providerRunsPersisted += 1;

      if (accepted && bundle.finalDraft.draftText !== undefined) {
        acceptedDraftCount += 1;
        // (d) accumulate the accepted body for the ONE patch export. Strip the
        // out-of-band kidoku markup so the recorded body matches the patchback
        // splice (mirrors the single-unit driver).
        const body =
          engineProfile === "rpg-maker-mv-mz"
            ? bundle.finalDraft.draftText
            : stripOutOfBandControlMarkup(bundle.finalDraft.draftText);
        acceptedBodies.set(unit.bridgeUnitId, body);
        acceptedUnits.push({
          bridgeUnitId: unit.bridgeUnitId,
          sourceUnitKey: unit.sourceUnitKey,
          finalDraftText: body,
        });
      } else {
        deferredCount += 1;
      }
    } catch (error) {
      failures.push({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      log(
        `project-driven-executor: unit ${unit.sourceUnitKey} FAILED (isolated, run continues): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // No draft / provider-run persisted for a failed unit; its target stays
      // a byte no-op (source === target) on the patch export.
      continue;
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
    totalUsageCostUsd,
    zdrConfirmed,
    budgetStopped,
    patchReport,
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

function summariseProviderTelemetry(
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
