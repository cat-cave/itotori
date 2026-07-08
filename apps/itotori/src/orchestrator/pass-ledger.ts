// itotori-pass-ledger — general multi-pass localization ledger.
//
// Multi-pass localization ("pass N+1 consumes pass N's feedback then reruns the
// affected scope") was not wired: the project-driven executor ran ONE pass over
// the in-scope units and persisted the accepted drafts + reviewer-queue items,
// but nothing RECORDED the pass's inputs/outputs/feedback so a subsequent pass
// could build on it. A pass N+1 run was therefore a blank re-run — it re-derived
// every draft from scratch, ignoring the prior pass's accepted state and the
// units it flagged.
//
// This module is the general pass ledger. It is the single source of truth for
// "what happened on each localization pass" for a locale branch:
//   - RECORDS, per pass: the inputs (scope / pair / units enumerated), the
//     outputs (accepted + deferred + failed unit outcomes, real usage.cost, ZDR,
//     budget-stopped), the prior-feedback notes carried in, and the ACCEPTED
//     DELTAS (units whose accepted draft CHANGED vs the prior pass).
//   - LETS a pass N+1 run CONSUME pass N's accepted state + flagged-unit
//     feedback as drafting context — `buildPriorPassContext` projects the latest
//     pass record into the `PriorPassContext` the driven executor threads into
//     every unit's translation prompt, and `runLocalizationPass` ties the
//     executor + ledger together so a pass N+1 run automatically loads pass N.
//
// Project-agnostic (GAME-AGNOSTIC): the record carries only generic fields —
// routing outcomes, draft text, defer reasons, free-form feedback notes. There
// is no title / engine / game-specific field anywhere; the multi-pass loop is
// generic over any project whose units flow through the agentic loop.
//
// Determinism + persistence: the ledger is a port (`PassLedgerPort`) so a
// production deployment backs it with a real table (`@itotori/db`) and tests
// back it with `InMemoryPassLedger`. `recordLocalizationPass` derives a
// deterministic `passNumber` (prior + 1, else 1) and a deterministic
// `acceptedDeltas` list (computed by a pure diff against the prior accepted
// state), so two replays of the same pass produce byte-equal records.
//
// Cost recording (PROJECT LAW / audit-no-hardcoded-cost): the ledger records the
// REAL total `usage.cost` the executor summed verbatim from per-invocation
// provider telemetry. It NEVER fabricates or defaults a cost — a zero-cost
// (synthetic fake) provider is recorded as the real zero it produced.

import type { AuthorizationActor } from "@itotori/db";
import type { AgenticLoopRoutingOutcome } from "@itotori/localization-bridge-schema";
import type { PriorPassFeedback } from "../agents/translation/shapes.js";
import {
  runProjectDrivenExecutor,
  type DrivenEngineProfile,
  type DrivenUnitFailure,
  type PriorPassContext,
  type ProjectDrivenExecutorInput,
  type ProjectDrivenExecutorResult,
  type TranslationScope,
} from "./project-driven-executor.js";
import type {
  WholeGameRenderValidationFinding,
  WholeGameRenderValidationResult,
} from "./wholegame-render-validation-seam.js";

// ---------------------------------------------------------------------------
// Record shapes (project-agnostic — no game / engine / title fields)
// ---------------------------------------------------------------------------

/**
 * One unit's outcome within a localization pass. Mirrors the driven executor's
 * per-unit `DrivenDraftRecord` (accepted/deferred state + draft text + defer
 * reason) plus the loop's routing outcome. The ledger records one of these per
 * successfully-run unit so a pass N+1 run can build on the prior pass's
 * accepted state and address the units it flagged.
 */
export type LocalizationPassUnitOutcome = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  /** The loop's routing outcome for this unit on this pass. */
  outcome: AgenticLoopRoutingOutcome;
  accepted: boolean;
  targetLocale: string;
  /** The accepted draft text; absent on a defer. */
  draftText?: string;
  /** The loop's deferred reason; absent when accepted. */
  deferredReason?: string;
};

/**
 * A unit whose accepted draft CHANGED between the prior pass and the current
 * pass. The ledger computes this via a deterministic diff against the prior
 * accepted state so iteration is observable: pass N+1 either keeps an accepted
 * draft byte-equal (no delta) or produces a new one (delta recorded). A unit
 * that was deferred in pass N and accepted in pass N+1 is a delta whose
 * `priorDraftText` is absent.
 */
export type AcceptedDelta = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  /** The prior pass's accepted draft for this unit, when it had one. */
  priorDraftText?: string;
  /** The current pass's accepted draft for this unit. */
  currentDraftText: string;
};

/**
 * Inputs to a localization pass (what was driven). Project-parameterised but
 * game-agnostic: only the generic scope / pair / locale / unit-count fields.
 */
export type LocalizationPassInputs = {
  translationScope: TranslationScope;
  pair: { modelId: string; providerId: string };
  targetLocale: string;
  engineProfile: DrivenEngineProfile;
  unitsEnumerated: number;
  unitsInScope: number;
  unitsRun: number;
  /** Bounded-slice dispatch cap, when the caller set one. */
  maxUnits?: number;
};

/**
 * Outputs of a localization pass (what landed). Real usage.cost summed verbatim
 * from per-invocation provider telemetry (PROJECT LAW) — never fabricated.
 */
export type LocalizationPassOutputs = {
  acceptedDraftCount: number;
  deferredCount: number;
  failureCount: number;
  totalUsageCostUsd: number;
  zdrConfirmed: boolean;
  budgetStopped: boolean;
  /** Per-unit outcomes (accepted + deferred), canonical order. */
  unitOutcomes: LocalizationPassUnitOutcome[];
  /** Per-unit failures (isolated), canonical order. */
  unitFailures: DrivenUnitFailure[];
  /**
   * Post-patch replay/render validation signal for this pass. When present,
   * pass N+1 projects its findings into prior-pass feedback so rendered/runtime
   * bugs are consumed by the next drafting pass.
   */
  runtimeValidation?: WholeGameRenderValidationResult;
};

/**
 * A free-form feedback note carried INTO a pass from outside the loop — a
 * reviewer correction, a QA-finding recommendation, or any project-agnostic
 * hint. Keyed by bridge unit so `buildPriorPassContext` can layer it onto the
 * prior pass's per-unit feedback. The note is the human / finding signal a
 * blank re-run would have missed; the ledger records what each pass consumed.
 */
export type PassFeedbackNote = {
  bridgeUnitId: string;
  note: string;
};

/**
 * The canonical record for one localization pass on a locale branch. This is
 * what the ledger stores and what a pass N+1 run consumes. One record per pass,
 * append-only (the ledger never mutates a prior record).
 *
 * `priorPassNumber` chains successive passes so the iteration lineage is
 * self-contained: pass N+1's record points at pass N, all the way back to pass
 * 1 (whose `priorPassNumber` is undefined). `acceptedDeltas` makes iteration
 * observable — the set of units whose accepted draft actually changed vs the
 * prior pass.
 */
export type LocalizationPassRecord = {
  /** 1-based pass number; pass 1 is the first pass on the branch. */
  passNumber: number;
  /** The prior pass this one built on; undefined for the first pass. */
  priorPassNumber?: number;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  recordedAt: Date;
  inputs: LocalizationPassInputs;
  outputs: LocalizationPassOutputs;
  /** Units whose accepted draft changed vs the prior pass (deterministic diff). */
  acceptedDeltas: AcceptedDelta[];
  /**
   * The per-unit feedback notes this pass CONSUMED (carried in from the prior
   * pass / reviewers). Empty for a blank first pass. The ledger records these
   * so the iteration trail shows what context each pass ran with.
   */
  consumedFeedbackNotes: PassFeedbackNote[];
};

// ---------------------------------------------------------------------------
// Persistence port (DB-backed in production, in-memory in tests)
// ---------------------------------------------------------------------------

/**
 * The pass-ledger persistence surface. Production wires a DB-backed adapter
 * (`@itotori/db`); tests wire {@link InMemoryPassLedger}. Three operations:
 *   - `recordPass`           — append a pass record (assigns the passNumber).
 *   - `loadLatestPass`       — the most-recent pass for a branch (or undefined).
 *   - `loadPassesForBranch`  — the full pass history for a branch, pass-order.
 *
 * The port is deliberately narrower than a full CRUD surface: the ledger is
 * append-only (no mutation / deletion), so the contract a caller relies on is
 * "record + read the latest / the history."
 */
export interface PassLedgerPort {
  recordPass(
    actor: AuthorizationActor,
    record: Omit<LocalizationPassRecord, "passNumber" | "priorPassNumber">,
  ): Promise<LocalizationPassRecord>;
  loadLatestPass(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord | undefined>;
  loadPassesForBranch(
    actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord[]>;
}

/**
 * In-memory pass ledger. Implements {@link PassLedgerPort} over a plain array,
 * assigning deterministic `passNumber`s (1-based, incrementing per branch).
 * Determinism: two replays that record the same sequence of passes produce
 * byte-equal records (the `passNumber` is derived from the branch's prior
 * count, not from wall-clock or entropy).
 */
export class InMemoryPassLedger implements PassLedgerPort {
  private readonly records: LocalizationPassRecord[] = [];
  private readonly perBranchCount = new Map<string, number>();

  async recordPass(
    _actor: AuthorizationActor,
    record: Omit<LocalizationPassRecord, "passNumber" | "priorPassNumber">,
  ): Promise<LocalizationPassRecord> {
    // Derive the pass number from the branch's recorded history so it is
    // deterministic for a given replay sequence (prior count + 1, else 1).
    const priorCount = this.perBranchCount.get(record.localeBranchId) ?? 0;
    const passNumber = priorCount + 1;
    this.perBranchCount.set(record.localeBranchId, passNumber);
    // Resolve the prior pass number from the latest record on this branch.
    const priorPassNumber = this.latestForBranch(record.localeBranchId)?.passNumber;
    const full: LocalizationPassRecord = {
      ...record,
      passNumber,
      ...(priorPassNumber !== undefined ? { priorPassNumber } : {}),
    };
    this.records.push(full);
    return full;
  }

  async loadLatestPass(
    _actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord | undefined> {
    return this.latestForBranch(localeBranchId);
  }

  async loadPassesForBranch(
    _actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<LocalizationPassRecord[]> {
    return this.records.filter((r) => r.localeBranchId === localeBranchId);
  }

  private latestForBranch(localeBranchId: string): LocalizationPassRecord | undefined {
    let latest: LocalizationPassRecord | undefined;
    for (const record of this.records) {
      if (record.localeBranchId !== localeBranchId) {
        continue;
      }
      if (latest === undefined || record.passNumber > latest.passNumber) {
        latest = record;
      }
    }
    return latest;
  }
}

// ---------------------------------------------------------------------------
// Accepted-delta diff (deterministic, pure)
// ---------------------------------------------------------------------------

/**
 * Compute the accepted deltas between the prior pass's accepted state and the
 * current pass's accepted state. A unit is a DELTA iff its accepted draft text
 * CHANGED — either the text differs, or the unit is newly accepted (no prior
 * draft) vs the prior pass. A unit that stays byte-equal accepted is NOT a
 * delta (iteration left it alone). Deterministic: same inputs → same deltas.
 *
 * The `current`/`prior` inputs accept the structural subset a record-under-
 * construction carries — the full `outputs.unitOutcomes` list — so the diff can
 * run BEFORE the ledger assigns a `passNumber` (it never reads the passNumber).
 */
export function deriveAcceptedDeltas(args: {
  prior?:
    | LocalizationPassRecord
    | { outputs: { unitOutcomes: LocalizationPassUnitOutcome[] } }
    | undefined;
  current: LocalizationPassRecord | { outputs: { unitOutcomes: LocalizationPassUnitOutcome[] } };
}): AcceptedDelta[] {
  if (args.prior === undefined) {
    // First pass: every accepted unit is a delta (no prior state to compare).
    return args.current.outputs.unitOutcomes
      .filter((unit) => unit.accepted && unit.draftText !== undefined)
      .map((unit) => ({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        currentDraftText: unit.draftText!,
      }));
  }
  const priorAccepted = new Map<string, string>();
  for (const unit of args.prior.outputs.unitOutcomes) {
    if (unit.accepted && unit.draftText !== undefined) {
      priorAccepted.set(unit.bridgeUnitId, unit.draftText);
    }
  }
  const deltas: AcceptedDelta[] = [];
  for (const unit of args.current.outputs.unitOutcomes) {
    if (!unit.accepted || unit.draftText === undefined) {
      continue;
    }
    const priorDraftText = priorAccepted.get(unit.bridgeUnitId);
    if (priorDraftText === undefined) {
      // Newly accepted vs prior (was deferred / failed / not run).
      deltas.push({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        currentDraftText: unit.draftText,
      });
    } else if (priorDraftText !== unit.draftText) {
      // Accepted in both passes but the draft text changed (real iteration).
      deltas.push({
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        priorDraftText,
        currentDraftText: unit.draftText,
      });
    }
    // else: byte-equal accepted — NOT a delta (unchanged).
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Prior-pass context projection (the seam a pass N+1 run consumes)
// ---------------------------------------------------------------------------

/**
 * Project the latest pass record into the {@link PriorPassContext} the driven
 * executor threads into every unit's translation prompt. Each unit's feedback
 * carries its prior routing outcome, its prior accepted/deferred draft, and its
 * defer reason; caller-supplied `feedbackNotesByUnit` are layered on top so a
 * reviewer correction / QA-finding recommendation reaches the prompt verbatim.
 *
 * Generic + project-agnostic: the feedback carries no game-specific fields —
 * only the prior outcome + draft + reason + note. Returns `undefined` when
 * there is no prior pass (the run is a blank first pass).
 */
export function buildPriorPassContext(args: {
  latest: LocalizationPassRecord | undefined;
  /**
   * Optional human / finding notes to layer onto the prior-pass feedback, keyed
   * by bridge unit. A note a reviewer added between pass N and pass N+1 reaches
   * the pass N+1 prompt even when the prior pass accepted the unit.
   */
  feedbackNotesByUnit?: ReadonlyMap<string, string>;
}): PriorPassContext | undefined {
  if (args.latest === undefined) {
    return undefined;
  }
  const latest = args.latest;
  const runtimeNotesByUnit = runtimeValidationNotesByUnit(
    latest.outputs.runtimeValidation?.findings ?? [],
  );
  const feedbackByUnit = new Map<string, PriorPassFeedback>();
  for (const unit of latest.outputs.unitOutcomes) {
    const note = args.feedbackNotesByUnit?.get(unit.bridgeUnitId);
    const runtimeNote = runtimeNotesByUnit.get(unit.bridgeUnitId);
    const feedbackNote = combineFeedbackNotes(note, runtimeNote);
    const feedback: PriorPassFeedback = {
      passNumber: latest.passNumber,
      priorOutcome: unit.outcome,
      ...(unit.draftText !== undefined ? { priorDraftText: unit.draftText } : {}),
      ...(unit.deferredReason !== undefined ? { deferredReason: unit.deferredReason } : {}),
      ...(feedbackNote !== undefined ? { feedbackNote } : {}),
    };
    feedbackByUnit.set(unit.bridgeUnitId, feedback);
  }
  return { passNumber: latest.passNumber, feedbackByUnit };
}

// ---------------------------------------------------------------------------
// Recording helper — turn an executor result into a pass record
// ---------------------------------------------------------------------------

/**
 * Build a {@link LocalizationPassRecord} (sans passNumber / priorPassNumber,
 * which the ledger assigns deterministically on `recordPass`) from a driven
 * executor result. Derives the deterministic `acceptedDeltas` by diffing
 * against the supplied prior pass, and records the feedback notes the pass
 * consumed (so the iteration trail is self-contained).
 *
 * Cost comes verbatim from the executor's `totalUsageCostUsd` (PROJECT LAW —
 * the executor already summed it from real per-invocation telemetry).
 */
export function buildLocalizationPassRecord(args: {
  executorInput: ProjectDrivenExecutorInput;
  result: ProjectDrivenExecutorResult;
  prior?: LocalizationPassRecord | undefined;
  consumedFeedbackNotes?: PassFeedbackNote[];
  now?: () => Date;
}): Omit<LocalizationPassRecord, "passNumber" | "priorPassNumber"> {
  const { executorInput, result, prior } = args;
  const targetLocale = executorInput.targetLocale ?? "en-US";
  const translationScope = executorInput.translationScope ?? "dialogue-only";
  const engineProfile = executorInput.engineProfile ?? "reallive";
  const now = args.now ?? (() => new Date());

  const unitOutcomes: LocalizationPassUnitOutcome[] = result.unitOutcomes.map((unit) => ({
    bridgeUnitId: unit.bridgeUnitId,
    sourceUnitKey: unit.sourceUnitKey,
    outcome: unit.outcome,
    accepted: unit.accepted,
    targetLocale: unit.targetLocale,
    ...(unit.draftText !== undefined ? { draftText: unit.draftText } : {}),
    ...(unit.deferredReason !== undefined ? { deferredReason: unit.deferredReason } : {}),
  }));

  const record: Omit<LocalizationPassRecord, "passNumber" | "priorPassNumber"> = {
    projectId: executorInput.projectId,
    localeBranchId: executorInput.localeBranchId,
    sourceRevisionId: executorInput.sourceRevisionId,
    recordedAt: now(),
    inputs: {
      translationScope,
      pair: executorInput.pair,
      targetLocale,
      engineProfile,
      unitsEnumerated: result.unitsEnumerated,
      unitsInScope: result.unitsInScope,
      unitsRun: result.unitsRun,
      ...(executorInput.maxUnits !== undefined ? { maxUnits: executorInput.maxUnits } : {}),
    },
    outputs: {
      acceptedDraftCount: result.acceptedDraftCount,
      deferredCount: result.deferredCount,
      failureCount: result.failures.length,
      totalUsageCostUsd: result.totalUsageCostUsd,
      zdrConfirmed: result.zdrConfirmed,
      budgetStopped: result.budgetStopped,
      unitOutcomes,
      unitFailures: result.failures,
      ...(result.runtimeValidation !== undefined
        ? { runtimeValidation: result.runtimeValidation }
        : {}),
    },
    acceptedDeltas: [],
    consumedFeedbackNotes: args.consumedFeedbackNotes ?? [],
  };
  // `deriveAcceptedDeltas` reads only `outputs.unitOutcomes`, which is complete
  // on the record-under-construction, so it can run before the ledger assigns a
  // passNumber (the diff never reads the passNumber).
  record.acceptedDeltas = deriveAcceptedDeltas({ prior, current: record });
  return record;
}

// ---------------------------------------------------------------------------
// The multi-pass driver — load prior pass, run executor with it, record it
// ---------------------------------------------------------------------------

/**
 * Run ONE localization pass and record it in the ledger. This is the seam that
 * makes multi-pass iteration work: it LOADS the latest prior pass from the
 * ledger (so pass N+1 consumes pass N's accepted state + flagged-unit
 * feedback), threads that context into the driven executor, runs it, and
 * RECORDS the resulting pass (with deterministic accepted deltas vs the prior).
 *
 * For a blank first pass (no prior on the branch) the executor runs with no
 * `priorPass` — byte-identical to calling `runProjectDrivenExecutor` directly.
 * For pass N+1, every unit whose prior-pass feedback is in the ledger receives
 * it in the translation prompt, so the draft iterates rather than re-deriving.
 *
 * `feedbackNotesByUnit` lets a caller layer reviewer / QA-finding notes onto the
 * prior-pass context between passes (e.g. a human correction added after pass N
 * that pass N+1 must address). These are recorded on the pass for the trail.
 *
 * Project-agnostic: only the generic executor input + ledger are touched.
 */
export async function runLocalizationPass(args: {
  ledger: PassLedgerPort;
  actor: AuthorizationActor;
  executorInput: Omit<ProjectDrivenExecutorInput, "priorPass">;
  afterExecutor?: (
    result: ProjectDrivenExecutorResult,
  ) => Promise<ProjectDrivenExecutorResult> | ProjectDrivenExecutorResult;
  feedbackNotesByUnit?: ReadonlyMap<string, string>;
  now?: () => Date;
  log?: (message: string) => void;
}): Promise<{
  result: ProjectDrivenExecutorResult;
  record: LocalizationPassRecord;
  /** The prior pass this run built on; undefined for a blank first pass. */
  prior: LocalizationPassRecord | undefined;
}> {
  const log = args.log ?? (() => {});
  // LOAD the latest prior pass from the ledger — this is the medium of
  // iteration. Pass N+1 does NOT see pass N's in-memory result; it sees the
  // ledger record, so the loop is deterministic + persisted.
  const prior = await args.ledger.loadLatestPass(args.actor, args.executorInput.localeBranchId);
  const priorContext = buildPriorPassContext({
    latest: prior,
    ...(args.feedbackNotesByUnit !== undefined
      ? { feedbackNotesByUnit: args.feedbackNotesByUnit }
      : {}),
  });

  if (priorContext !== undefined && prior !== undefined) {
    log(
      `pass-ledger: running pass ${prior.passNumber + 1} consuming pass ${prior.passNumber} ` +
        `(${priorContext.feedbackByUnit.size} unit(s) with prior feedback)`,
    );
  } else {
    log("pass-ledger: running pass 1 (blank, no prior context)");
  }

  // RUN the executor with the prior context threaded in (or undefined).
  let result = await runProjectDrivenExecutor({
    ...args.executorInput,
    ...(priorContext !== undefined ? { priorPass: priorContext } : {}),
  });
  if (args.afterExecutor !== undefined) {
    result = await args.afterExecutor(result);
    if (result.runtimeValidation !== undefined) {
      const coverage = result.runtimeValidation.coverage;
      log(
        `pass-ledger: post-patch render validation covered ${coverage.selectedUnitCount}/${coverage.candidateUnitCount} unit(s) ` +
          `across ${coverage.validatedSceneCount}/${coverage.candidateSceneCount} scene(s), ` +
          `${result.runtimeValidation.findings.length} finding(s)` +
          (coverage.sampled ? ` (sampled; skipped=${coverage.skippedUnitIds.length})` : ""),
      );
    }
  }

  // RECORD the pass — derive the deterministic accepted deltas vs the prior.
  const consumedFeedbackNotes: PassFeedbackNote[] = [];
  if (args.feedbackNotesByUnit !== undefined) {
    for (const [bridgeUnitId, note] of args.feedbackNotesByUnit) {
      consumedFeedbackNotes.push({ bridgeUnitId, note });
    }
    consumedFeedbackNotes.sort((a, b) => a.bridgeUnitId.localeCompare(b.bridgeUnitId));
  }
  const recordInput = buildLocalizationPassRecord({
    executorInput: args.executorInput,
    result,
    prior,
    consumedFeedbackNotes,
    ...(args.now !== undefined ? { now: args.now } : {}),
  });
  const record = await args.ledger.recordPass(args.actor, recordInput);

  log(
    `pass-ledger: recorded pass ${record.passNumber} ` +
      `(${result.acceptedDraftCount} accepted, ${result.deferredCount} deferred, ` +
      `${result.failures.length} failed, ${record.acceptedDeltas.length} accepted delta(s))`,
  );

  return { result, record, prior };
}

// Re-export the driven-executor types the multi-pass surface pairs with so
// callers reach them from a single import path. The schema-package types
// (`AgenticLoopBundle` / `AgenticLoopRoutingOutcome`) are imported at the top
// of this file directly from `@itotori/localization-bridge-schema`.
export type {
  DrivenDraftRecord,
  PriorPassContext,
  ProjectDrivenExecutorInput,
  ProjectDrivenExecutorResult,
} from "./project-driven-executor.js";

function runtimeValidationNotesByUnit(
  findings: ReadonlyArray<WholeGameRenderValidationFinding>,
): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const finding of findings) {
    const notes = out.get(finding.bridgeUnitId) ?? [];
    notes.push(
      `Runtime validation (${finding.phase}, scene ${finding.sceneId}) failed: ${finding.message}`,
    );
    out.set(finding.bridgeUnitId, notes);
  }
  return new Map([...out.entries()].map(([unitId, notes]) => [unitId, notes.join("\n")]));
}

function combineFeedbackNotes(
  explicitNote: string | undefined,
  runtimeNote: string | undefined,
): string | undefined {
  if (explicitNote === undefined) return runtimeNote;
  if (runtimeNote === undefined) return explicitNote;
  return `${explicitNote}\n${runtimeNote}`;
}
