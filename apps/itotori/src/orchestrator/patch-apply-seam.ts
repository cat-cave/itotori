// m1-wholegame-localize-to-patch-seam — the M1 keystone.
//
// The whole-game localize driver (`runProjectDrivenExecutor` via
// `runLocalizeFullProjectCommand`) persists drafts + provider-runs + reviewer
// items and writes `translated-bridge.json` + `patch-report.json`. Before this
// module that was the END of the shipped path: nothing turned the translated
// bridge into an APPLYED patch.
//
// This module closes that seam with ONE shipped path covering both halves the
// M1 node requires:
//
//   1. A PRODUCTION `DraftArtifactBundleLoader`
//      (`buildDraftArtifactBundleFromExecutorRun`) that reconstructs the
//      `DraftArtifactBundle` `export-patch-v2` consumes from the executor's
//      REAL persisted journal run: canonical written outcomes (including every
//      candidate and QA finding) plus every physical provider attempt. The
//      patch report only identifies the exact run and its declared scope; it is
//      never used to reconstruct a target body or provenance.
//
//   2. The APPLY step (`applyKaifuuRealLivePatch`): after the whole-game
//      localize writes `translated-bridge.json`, invoke
//      `kaifuu patch --engine reallive --source <src> --target <out>
//       --bundle <translated-bridge.json> --scope <scope> --force`, mirroring
//      the single-unit suite runner's phase 3 (`run.mjs`). `translated-bridge`
//      is ALREADY the translated v0.2 BridgeBundle that
//      `kaifuu patch --bundle` consumes byte-for-byte, so this produces the
//      final applyable, byte-correct patched output.
//
// The binary is resolved through the SAME authoritative order the native-deps
// doctor uses (ITOTORI_KAIFUU_BIN -> ITOTORI_LIBEXEC_DIR -> CARGO_TARGET_DIR /
// target release|debug -> PATH), falling back to `cargo run -p kaifuu-cli` in a
// dev checkout so the seam ships in both an installed artifact and the dev
// shell.

import type {
  AssetDecisionRecord,
  AuthorizationActor,
  ItotoriLocalizationJournalRepositoryPort,
  LocalizationJournalAttemptRecord,
  LocalizationJournalOutcomeRecord,
} from "@itotori/db";
import {
  assertDraftArtifactBundle,
  assertPatchExportBundle,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
  type DraftArtifactDraftEntry,
  type PatchExportBundle,
} from "@itotori/localization-bridge-schema";
import { createHash } from "node:crypto";
import { AssetDecisionPolicyResolver } from "../asset-decisions/policy-resolver.js";
import { addDecimalUsd } from "../providers/cost.js";
import {
  defaultRepoRoot,
  resolveNativeCliBin,
  spawnNativeCliProcess,
} from "../native-bin/cli-bin-resolver.js";
import {
  PatchExporter,
  type DraftArtifactBundleLoad,
  type DraftArtifactBundleLoaderPort,
  type PreflightFailure,
  type SourceBridgeViewLoaderPort,
} from "../patch-export/exporter.js";
import { PatchExportPreflight } from "../patch-export/preflight.js";
import type {
  SourceBridgeAssetRef,
  SourceBridgeProtectedSpan,
  SourceBridgeUnit,
  SourceBridgeView,
} from "../patch-export/source-bridge-view.js";
import type {
  DrivenEngineProfile,
  DrivenPatchReport,
  TranslationScope,
} from "./project-driven-executor.js";
import {
  admitWholeGameRuntimeValidation,
  runWholeGameReplayRenderValidate,
  type RunWholeGameReplayRenderValidateArgs,
  type WholeGameRuntimeValidationAdmission,
  type WholeGameRenderValidationResult,
} from "./wholegame-render-validation-seam.js";

// ---------------------------------------------------------------------------
// (1) Production DraftArtifactBundle loader — real executor drafts, no fixture
// ---------------------------------------------------------------------------

/**
 * The report identifies an immutable journal run and its patch scope. Target
 * bodies, candidates, findings, and provider evidence are always loaded from
 * the journal — not reconstructed from this report.
 */
export type ExecutorRunPatchReport = Pick<
  DrivenPatchReport,
  | "journalRunId"
  | "projectId"
  | "localeBranchId"
  | "targetLocale"
  | "writtenUnits"
  | "translationScope"
>;

export type BuildDraftArtifactBundleArgs = {
  actor: AuthorizationActor;
  journal: ItotoriLocalizationJournalRepositoryPort;
  projectId: string;
  localeBranchId: string;
  /** Deterministic bundle identity derived from this exact journal run. */
  draftArtifactBundleId: string;
  patchReport: ExecutorRunPatchReport;
  /** The bridge hash the run drafted against (preflight integrity). */
  sourceBridgeHash: string;
};

export type WholeGamePatchLoaderDiscrepancyKind =
  | "no-persisted-journal-run"
  | "journal-run-scope-mismatch"
  | "duplicate-written-outcome"
  | "no-persisted-written-outcome"
  | "persisted-outcome-not-reported"
  | "patch-report-outcome-mismatch"
  | "selected-candidate-attempt-missing";

/**
 * Raised when the report and its exact durable run do not reconcile. The
 * loader never substitutes a report body, omits a candidate/finding, or
 * fabricates provider evidence.
 */
export class WholeGamePatchLoaderReconciliationError extends Error {
  constructor(
    public readonly discrepancy: WholeGamePatchLoaderDiscrepancyKind,
    public readonly unitIds: ReadonlyArray<string>,
    detail: string,
  ) {
    super(
      `whole-game journal loader refused (${discrepancy}): ${detail}; units: ${[...unitIds].sort().join(", ")}`,
    );
    this.name = "WholeGamePatchLoaderReconciliationError";
  }
}

/**
 * Load a patch bundle from a single persisted journal run. This is deliberately
 * run-addressed, rather than a "latest rows" query: a later run cannot change
 * what this report applies. All candidate/finding data is passed through from
 * the canonical persisted `WrittenUnitOutcome` verbatim.
 */
export async function buildDraftArtifactBundleFromExecutorRun(
  args: BuildDraftArtifactBundleArgs,
): Promise<DraftArtifactBundle> {
  const run = await args.journal.loadRun(args.actor, args.patchReport.journalRunId);
  if (run === null) {
    throw new WholeGamePatchLoaderReconciliationError(
      "no-persisted-journal-run",
      [],
      `journal run ${args.patchReport.journalRunId} does not exist`,
    );
  }
  if (
    run.projectId !== args.projectId ||
    run.localeBranchId !== args.localeBranchId ||
    run.targetLocale !== args.patchReport.targetLocale
  ) {
    throw new WholeGamePatchLoaderReconciliationError(
      "journal-run-scope-mismatch",
      [],
      `journal run ${run.runId} scope does not match project/branch/locale in the patch report`,
    );
  }

  const [outcomes, attempts] = await Promise.all([
    args.journal.loadRunOutcomes(args.actor, run.runId),
    args.journal.loadAttemptsForRun(args.actor, run.runId),
  ]);
  const reportUnits = indexReportWrittenUnits(args.patchReport);
  const outcomesByUnit = indexPersistedOutcomes(outcomes);
  const missingOutcomes = [...reportUnits.keys()].filter((unitId) => !outcomesByUnit.has(unitId));
  if (missingOutcomes.length > 0) {
    throw new WholeGamePatchLoaderReconciliationError(
      "no-persisted-written-outcome",
      missingOutcomes,
      "patch report claims written unit(s) with no persisted journal outcome",
    );
  }
  const unreportedOutcomes = [...outcomesByUnit.keys()].filter(
    (unitId) => !reportUnits.has(unitId),
  );
  if (unreportedOutcomes.length > 0) {
    throw new WholeGamePatchLoaderReconciliationError(
      "persisted-outcome-not-reported",
      unreportedOutcomes,
      "journal contains written outcome(s) absent from the patch report",
    );
  }

  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const drafts: DraftArtifactDraftEntry[] = [];
  for (const unitId of [...reportUnits.keys()].sort()) {
    const reportUnit = reportUnits.get(unitId)!;
    const persisted = outcomesByUnit.get(unitId)!;
    assertReportMatchesPersistedOutcome(reportUnit, persisted);
    const selectedCandidate = persisted.outcome.candidates.find(
      (candidate) => candidate.id === persisted.outcome.selectedCandidateId,
    );
    if (selectedCandidate === undefined) {
      throw new WholeGamePatchLoaderReconciliationError(
        "patch-report-outcome-mismatch",
        [unitId],
        `persisted outcome ${persisted.outcome.id} has no selected candidate`,
      );
    }
    const selectedAttempt = attemptsById.get(selectedCandidate.attemptId);
    if (selectedAttempt === undefined || selectedAttempt.bridgeUnitId !== unitId) {
      throw new WholeGamePatchLoaderReconciliationError(
        "selected-candidate-attempt-missing",
        [unitId],
        `selected candidate ${selectedCandidate.id} is not bound to a physical attempt in run ${run.runId}`,
      );
    }
    drafts.push({
      sourceUnitId: unitId,
      draftId: persisted.outcome.id,
      providerProofId: selectedAttempt.providerRunId,
      costLedgerEntryRef: `llm-attempt:${selectedAttempt.attemptId}`,
      writtenOutcome: persisted.outcome,
    });
  }

  const ledgerSummary = journalLedgerSummary(attempts);
  const bundle: DraftArtifactBundle = {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: args.draftArtifactBundleId,
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    drafts,
    ledgerSummary,
  };
  assertDraftArtifactBundle(bundle);
  return bundle;
}

function indexReportWrittenUnits(
  patchReport: ExecutorRunPatchReport,
): Map<string, ExecutorRunPatchReport["writtenUnits"][number]> {
  const result = new Map<string, ExecutorRunPatchReport["writtenUnits"][number]>();
  const duplicates: string[] = [];
  for (const unit of patchReport.writtenUnits) {
    if (result.has(unit.bridgeUnitId)) {
      duplicates.push(unit.bridgeUnitId);
      continue;
    }
    result.set(unit.bridgeUnitId, unit);
  }
  if (duplicates.length > 0) {
    throw new WholeGamePatchLoaderReconciliationError(
      "duplicate-written-outcome",
      duplicates,
      "patch report contains more than one written outcome for a unit",
    );
  }
  return result;
}

function indexPersistedOutcomes(
  outcomes: readonly LocalizationJournalOutcomeRecord[],
): Map<string, LocalizationJournalOutcomeRecord> {
  const result = new Map<string, LocalizationJournalOutcomeRecord>();
  const duplicates: string[] = [];
  for (const outcome of outcomes) {
    if (result.has(outcome.bridgeUnitId)) {
      duplicates.push(outcome.bridgeUnitId);
      continue;
    }
    result.set(outcome.bridgeUnitId, outcome);
  }
  if (duplicates.length > 0) {
    throw new WholeGamePatchLoaderReconciliationError(
      "duplicate-written-outcome",
      duplicates,
      "journal contains more than one persisted written outcome for a unit",
    );
  }
  return result;
}

function assertReportMatchesPersistedOutcome(
  reportUnit: ExecutorRunPatchReport["writtenUnits"][number],
  persisted: LocalizationJournalOutcomeRecord,
): void {
  const selectedCandidate = persisted.outcome.candidates.find(
    (candidate) => candidate.id === persisted.outcome.selectedCandidateId,
  );
  const sameFlags =
    reportUnit.qualityFlags.length === persisted.outcome.qualityFlags.length &&
    reportUnit.qualityFlags.every((flag, index) => flag === persisted.outcome.qualityFlags[index]);
  if (
    persisted.outcome.unitId !== reportUnit.bridgeUnitId ||
    selectedCandidate?.body !== reportUnit.selectedBody ||
    !sameFlags
  ) {
    throw new WholeGamePatchLoaderReconciliationError(
      "patch-report-outcome-mismatch",
      [reportUnit.bridgeUnitId],
      "patch report selected body or quality flags differ from the persisted canonical outcome",
    );
  }
}

function journalLedgerSummary(
  attempts: readonly LocalizationJournalAttemptRecord[],
): DraftArtifactBundle["ledgerSummary"] {
  let totalCost = "0";
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const providerProofIds: string[] = [];
  const seenProviderProofIds = new Set<string>();
  for (const attempt of attempts) {
    totalCost = addDecimalUsd(totalCost, attempt.costUsd);
    totalTokensIn += attempt.tokensIn ?? 0;
    totalTokensOut += attempt.tokensOut ?? 0;
    if (!seenProviderProofIds.has(attempt.providerRunId)) {
      seenProviderProofIds.add(attempt.providerRunId);
      providerProofIds.push(attempt.providerRunId);
    }
  }
  return {
    totalCost,
    totalTokensIn,
    totalTokensOut,
    attemptCount: attempts.length,
    providerProofIds,
  };
}

/**
 * A `DraftArtifactBundleLoaderPort` bound to a single reconstructed whole-run
 * bundle. `export-patch-v2` calls `loadByJobId` with the run's bundle id; this
 * returns the real bundle + the run's `sourceBridgeHash`. Unlike the fixture
 * loader, the bundle came from the executor's persisted drafts.
 */
export function executorRunDraftArtifactBundleLoader(
  bundle: DraftArtifactBundle,
  sourceBridgeHash: string,
): DraftArtifactBundleLoaderPort {
  return {
    async loadByJobId(_actor, draftJobId): Promise<DraftArtifactBundleLoad> {
      if (draftJobId !== bundle.draftJobId) {
        throw new Error(
          `executor-run draft-bundle loader: requested draftJobId=${draftJobId} but the reconstructed run bundle is ${bundle.draftJobId}`,
        );
      }
      return { bundle, sourceBridgeHash };
    },
  };
}

// ---------------------------------------------------------------------------
// (2) The apply step — kaifuu patch, dispatched per engine:
//   - reallive:        --engine reallive --source <src> --target <out>
//                      --bundle translated-bridge.json --scope <scope> --force
//   - rpg-maker-mv-mz: --engine rpgmaker --source <www>
//                      --bundle translated-bridge.json --delta-output <delta>
//                      --patched-data-output <patched-data-tree>
// ---------------------------------------------------------------------------

/**
 * The result of ANY `kaifuu patch` apply invocation (reallive or rpgmaker):
 * the resolved command, its argv, exit status, and captured output.
 */
export type KaifuuPatchApplyResult = {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
};

export type ApplyKaifuuRealLivePatchArgs = {
  /** Read-only source game root (contains REALLIVEDATA/Seen.txt). */
  sourceRoot: string;
  /** Writable target the patched archive is written under. */
  targetRoot: string;
  /** Path to the executor's `translated-bridge.json` (translated v0.2 bundle). */
  translatedBundlePath: string;
  /** The user's translation scope (config-driven byte-fidelity contract). */
  translationScope: TranslationScope;
  /** Overwrite a non-empty target (mirrors run.mjs phase 3, which passes --force). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real `spawnSync`. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

export type KaifuuProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type ApplyKaifuuRealLivePatchResult = KaifuuPatchApplyResult;

export class KaifuuPatchApplyError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "KaifuuPatchApplyError";
  }
}

/**
 * Apply the whole-game translated bridge to the source `Seen.txt`, producing
 * the final byte-correct patched output under `targetRoot`. Mirrors the
 * single-unit suite runner's phase 3 invocation
 * (`kaifuu patch --engine reallive --source ... --target ... --bundle
 * translated-bridge.json --scope ... --force`).
 */
export function applyKaifuuRealLivePatch(
  args: ApplyKaifuuRealLivePatchArgs,
): ApplyKaifuuRealLivePatchResult {
  const env = args.env ?? process.env;
  const { command, prefixArgs } = resolveKaifuuCli(env);
  const patchArgs = [
    ...prefixArgs,
    "patch",
    "--engine",
    "reallive",
    "--source",
    args.sourceRoot,
    "--target",
    args.targetRoot,
    "--bundle",
    args.translatedBundlePath,
    "--scope",
    kaifuuScopeToken(args.translationScope),
  ];
  if (args.force ?? true) {
    patchArgs.push("--force");
  }
  args.log?.(`patch-apply: ${command} ${patchArgs.join(" ")}`);
  const runProcess = args.runProcess ?? defaultRunProcessFor("reallive");
  const res = runProcess(command, patchArgs, env);
  if (res.status !== 0) {
    throw new KaifuuPatchApplyError(
      res.status,
      res.stderr,
      `kaifuu patch (reallive) failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    command,
    args: patchArgs,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

export type ApplyKaifuuRpgMakerPatchArgs = {
  /** Read-only source game root — the RPG Maker `www` dir (contains `data/`). */
  sourceRoot: string;
  /**
   * Writable output dir the byte-surgically patched `data` tree is
   * materialized under. Must NOT already exist (kaifuu-rpgmaker refuses to
   * overwrite so a stale patched tree is never silently reused).
   */
  patchedDataOutputPath: string;
  /** Path the `.kaifuu` delta package (source-vs-patched diff) is written to. */
  deltaOutputPath: string;
  /** Path to the executor's `translated-bridge.json` (translated v0.2 bundle). */
  translatedBundlePath: string;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests. Defaults to a real sanitized spawn. */
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  log?: (message: string) => void;
};

/**
 * Apply the whole-game translated bridge to the RPG Maker MV/MZ `www/data`
 * tree, producing the byte-surgically patched `data` tree under
 * `patchedDataOutputPath` + the `.kaifuu` delta package at `deltaOutputPath`.
 * Mirrors `kaifuu patch --engine rpgmaker --source <www> --bundle
 * translated-bridge.json --delta-output <delta> --patched-data-output <dir>`
 * (`run_patch_rpgmaker_bundle` → `kaifuu_rpgmaker::produce_delta_package`).
 *
 * The source `www/data` tree is treated strictly read-only; the delta + patched
 * tree are reproduced byte-for-byte by `kaifuu-delta apply`. `translated-bridge`
 * is the SAME translated v0.2 bundle the reallive apply consumes — the executor
 * writes ONE bundle regardless of engine.
 */
export function applyKaifuuRpgMakerPatch(
  args: ApplyKaifuuRpgMakerPatchArgs,
): KaifuuPatchApplyResult {
  const env = args.env ?? process.env;
  const { command, prefixArgs } = resolveKaifuuCli(env);
  const patchArgs = [
    ...prefixArgs,
    "patch",
    "--engine",
    "rpgmaker",
    "--source",
    args.sourceRoot,
    "--bundle",
    args.translatedBundlePath,
    "--delta-output",
    args.deltaOutputPath,
    "--patched-data-output",
    args.patchedDataOutputPath,
  ];
  args.log?.(`patch-apply: ${command} ${patchArgs.join(" ")}`);
  const runProcess = args.runProcess ?? defaultRunProcessFor("rpgmaker");
  const res = runProcess(command, patchArgs, env);
  if (res.status !== 0) {
    throw new KaifuuPatchApplyError(
      res.status,
      res.stderr,
      `kaifuu patch (rpgmaker) failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    command,
    args: patchArgs,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/**
 * Map the itotori config translation scope to the kaifuu-reallive `--scope`
 * token. RealLive supports two scopes: `dialogue-only` and `dialogue+choices`.
 * `dialogue-only` maps straight through; every broader itotori scope
 * (choices / +ui / all) maps to the widest RealLive scope, `dialogue+choices`
 * (UI + image surfaces are carried byte-identical by the patchback regardless).
 */
export function kaifuuScopeToken(scope: TranslationScope): string {
  return scope === "dialogue-only" ? "dialogue-only" : "dialogue+choices";
}

/**
 * Resolve the kaifuu-cli invocation. Delegates to the shared
 * `resolveNativeCliBin` so the kaifuu seam, the utsushi seam, and the
 * native-deps doctor all settle on the SAME bin (env override -> libexec ->
 * CARGO_TARGET_DIR -> repo target -> PATH), with a `cargo run -p kaifuu-cli`
 * dev-shell fallback for a fresh checkout with no built bin (what the suite
 * runner uses).
 */
export function resolveKaifuuCli(env: NodeJS.ProcessEnv): {
  command: string;
  prefixArgs: string[];
} {
  return resolveNativeCliBin(
    { binName: "kaifuu-cli", envVar: "ITOTORI_KAIFUU_BIN", cargoPackage: "kaifuu-cli" },
    env,
    { repoRoot: defaultRepoRoot() },
  );
}

function defaultRunProcessFor(
  engineLabel: string,
): (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult {
  return (command, args, env) => {
    // Route through the ONE sanitized native-CLI spawn boundary so the
    // live-provider secrets are scrubbed from the child env (patch-apply is a
    // byte tool — it never needs OpenRouter creds).
    const res = spawnNativeCliProcess(command, args, env);
    if (res.error !== undefined) {
      throw new KaifuuPatchApplyError(
        null,
        res.error.message,
        `kaifuu patch (${engineLabel}) could not be spawned (${command}): ${res.error.message}`,
      );
    }
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  };
}

// ---------------------------------------------------------------------------
// The ONE shipped seam — export-patch preflight (real drafts) + kaifuu apply
// ---------------------------------------------------------------------------

/**
 * Minimal asset-decision port the seam threads into the export-patch preflight.
 * Mirrors `ItotoriAssetLocalizationDecisionRepositoryPort.loadActiveDecisions`.
 */
export type SeamAssetDecisionLoader = (
  actor: AuthorizationActor,
  projectId: string,
  localeBranchId: string,
) => Promise<ReadonlyArray<AssetDecisionRecord>>;

export type RunWholeGamePatchExportAndApplyArgs = {
  actor: AuthorizationActor;
  /**
   * Which engine's byte-surgical patchback applies the translated bundle. The
   * export-patch preflight (real drafts, protected spans, asset decisions,
   * source-bridge integrity) is engine-AGNOSTIC and runs identically for both;
   * only the apply step dispatches:
   *   - `reallive`:        `kaifuu patch --engine reallive` (Seen.txt) + utsushi
   *                        replay/render validation.
   *   - `rpg-maker-mv-mz`: `kaifuu patch --engine rpgmaker` (www/data/*.json
   *                        literals → `.kaifuu` delta + patched tree). No utsushi
   *                        render validation — MV/MZ is a delegation runtime.
   */
  engineProfile: DrivenEngineProfile;
  /** The durable journal repository that owns this exact executor run. */
  journal: ItotoriLocalizationJournalRepositoryPort;
  /** The executor run's patch report (identity + accepted-unit scope). */
  patchReport: DrivenPatchReport;
  /** The raw v0.2 bridge the run drafted against (drives the source view + hash). */
  rawBridge: unknown;
  /**
   * Read-only source game root. RealLive: the game root (contains
   * REALLIVEDATA/Seen.txt). RPG Maker MV/MZ: the `www` dir (contains `data/`).
   */
  sourceRoot: string;
  /**
   * Writable target the patched output lands under. RealLive: the patched game
   * root. RPG Maker MV/MZ: the materialized patched `data` tree (must not
   * pre-exist).
   */
  targetRoot: string;
  /**
   * RPG Maker MV/MZ only: path the `.kaifuu` delta package is written to.
   * Defaults to `<targetRoot>.delta.kaifuu`. Ignored for RealLive.
   */
  rpgMakerDeltaOutputPath?: string;
  /** The executor's `translated-bridge.json` (translated v0.2 bundle). */
  translatedBundlePath: string;
  requestedBy: string;
  /** Active asset decisions for the honest `noUnresolvedAssetDecisions` check. */
  loadActiveDecisions: SeamAssetDecisionLoader;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  runProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => KaifuuProcessResult;
  renderValidation?: Omit<
    RunWholeGameReplayRenderValidateArgs,
    "rawBridge" | "patchReport" | "sourceRoot" | "targetRoot"
  >;
  log?: (message: string) => void;
};

export type WholeGamePatchExportAndApplyResult = {
  /** The current patch-export bundle produced from REAL executor drafts. */
  patchExportBundle: PatchExportBundle;
  /** The kaifuu-patch apply result (byte-correct patched output written). */
  apply: KaifuuPatchApplyResult;
  /** The reconstructed draft-artifact bundle id (deterministic per run). */
  draftArtifactBundleId: string;
  /** Present when the caller requested post-apply replay/render validation. */
  renderValidation?: WholeGameRenderValidationResult;
  runtimeValidationAdmission?: WholeGameRuntimeValidationAdmission;
};

export class WholeGamePatchExportPreflightError extends Error {
  constructor(public readonly failure: PreflightFailure) {
    super(
      `whole-game patch-export refused: ${failure.failingChecks
        .map((c) => `${c.check}(${c.detail ?? "no detail"})`)
        .join(", ")}`,
    );
    this.name = "WholeGamePatchExportPreflightError";
  }
}

/**
 * The M1 keystone as ONE shipped call. Given a completed executor run:
 *   1. Load the `DraftArtifactBundle` from REAL persisted journal rows
 *      (production loader — NOT a fixture or report reconstruction).
 *   2. Run the export-patch-v2 preflight + exporter over those real drafts,
 *      with an HONEST source-bridge view (integrity hash from the run's bridge,
 *      asset decisions resolved through the live repository, protected-span
 *      coverage checked per written outcome). A blocking preflight failure
 *      throws — no patch is applied on a failed preflight.
 *   3. Apply the translated bundle via `kaifuu patch`, dispatched on
 *      `engineProfile`: `--engine reallive` (Seen.txt) or `--engine rpgmaker`
 *      (www/data/*.json literals → `.kaifuu` delta + patched tree), to produce
 *      the final applyable, byte-correct patched output.
 */
export async function runWholeGamePatchExportAndApply(
  args: RunWholeGamePatchExportAndApplyArgs,
): Promise<WholeGamePatchExportAndApplyResult> {
  // (P1 #3 — real integrity, not a tautology.) The DECLARED bundle hash is the
  // hash the run ACTUALLY drafted against, recorded by the executor in its
  // patch report (`patchReport.sourceBridgeHash`). The SOURCE-VIEW hash is
  // recomputed HERE over the apply-time bridge (`args.rawBridge`). The preflight
  // `sourceBridgeIntegrity` check compares the two: if the apply-time bridge is
  // stale / different from the one the drafts were produced against, the hashes
  // differ and preflight fails loud — no patch is applied. When they match, the
  // integrity assertion is real (drafted-against === apply-time), not
  // self-referential.
  const declaredDraftedAgainstHash = args.patchReport.sourceBridgeHash;
  const applyTimeBridgeHash = hashRawBridge(args.rawBridge);
  const draftArtifactBundleId = `wholegame-run:${args.patchReport.journalRunId}`;

  const bundle = await buildDraftArtifactBundleFromExecutorRun({
    actor: args.actor,
    journal: args.journal,
    projectId: args.patchReport.projectId,
    localeBranchId: args.patchReport.localeBranchId,
    draftArtifactBundleId,
    patchReport: args.patchReport,
    sourceBridgeHash: declaredDraftedAgainstHash,
  });

  // The source-bridge view the preflight validates against carries exactly the
  // accepted-draft units (the ones being spliced), projected from the APPLY-TIME
  // bridge with the apply-time integrity hash + the REAL asset refs / protected
  // spans the bridge declares (NOT erased to empty). `protectedSpanCoverage` /
  // `noUnresolvedAsset` therefore run over the real spliced set, and
  // `sourceBridgeIntegrity` compares the drafted-against hash to this apply-time
  // hash.
  const view = buildSourceBridgeViewForAcceptedDrafts({
    rawBridge: args.rawBridge,
    bundle,
    projectId: args.patchReport.projectId,
    localeBranchId: args.patchReport.localeBranchId,
    targetLocale: args.patchReport.targetLocale,
    sourceBridgeHash: applyTimeBridgeHash,
  });

  const draftBundleLoader = executorRunDraftArtifactBundleLoader(
    bundle,
    declaredDraftedAgainstHash,
  );
  const sourceBridgeViewLoader: SourceBridgeViewLoaderPort = {
    async loadForLocale(_actor, projectId, localeBranchId): Promise<SourceBridgeView> {
      if (projectId !== view.projectId || localeBranchId !== view.localeBranchId) {
        throw new Error(
          `whole-game patch-export: requested project/locale (${projectId}/${localeBranchId}) does not match the run (${view.projectId}/${view.localeBranchId})`,
        );
      }
      return view;
    },
  };

  const resolverRepository = {
    async loadActiveDecisions(
      actor: AuthorizationActor,
      projectId: string,
      localeBranchId: string,
    ) {
      const records = await args.loadActiveDecisions(actor, projectId, localeBranchId);
      return [...records];
    },
  };

  const exporter = new PatchExporter({
    preflight: new PatchExportPreflight(),
    draftArtifactBundleLoader: draftBundleLoader,
    sourceBridgeViewLoader,
    assetDecisionResolver: new AssetDecisionPolicyResolver(resolverRepository),
  });

  const result = await exporter.export(args.actor, {
    projectId: args.patchReport.projectId,
    localeBranchId: args.patchReport.localeBranchId,
    draftArtifactBundleId,
    requestedBy: args.requestedBy,
  });
  if ("kind" in result && result.kind === "preflight_failure") {
    throw new WholeGamePatchExportPreflightError(result);
  }
  assertPatchExportBundle(result);

  args.log?.(
    `patch-export: ${result.drafts.length} real draft(s) passed preflight; applying via kaifuu patch (engine=${args.engineProfile})`,
  );

  // Apply step dispatches on the engine. The preflight above was engine-agnostic;
  // only the byte-surgical writer differs (Seen.txt vs www/data/*.json literals).
  const apply =
    args.engineProfile === "rpg-maker-mv-mz"
      ? applyKaifuuRpgMakerPatch({
          sourceRoot: args.sourceRoot,
          patchedDataOutputPath: args.targetRoot,
          deltaOutputPath: args.rpgMakerDeltaOutputPath ?? `${args.targetRoot}.delta.kaifuu`,
          translatedBundlePath: args.translatedBundlePath,
          ...(args.env !== undefined ? { env: args.env } : {}),
          ...(args.runProcess !== undefined ? { runProcess: args.runProcess } : {}),
          ...(args.log !== undefined ? { log: args.log } : {}),
        })
      : applyKaifuuRealLivePatch({
          sourceRoot: args.sourceRoot,
          targetRoot: args.targetRoot,
          translatedBundlePath: args.translatedBundlePath,
          translationScope: args.patchReport.translationScope,
          ...(args.force !== undefined ? { force: args.force } : {}),
          ...(args.env !== undefined ? { env: args.env } : {}),
          ...(args.runProcess !== undefined ? { runProcess: args.runProcess } : {}),
          ...(args.log !== undefined ? { log: args.log } : {}),
        });

  // Post-apply utsushi replay/render validation is RealLive-only (from-scratch
  // VM + rasterizer oracle). MV/MZ is a delegation runtime with no such seam
  // wired, so a render-validation request is ignored for it.
  const renderValidation =
    args.renderValidation === undefined || args.engineProfile !== "reallive"
      ? undefined
      : runWholeGameReplayRenderValidate({
          rawBridge: args.rawBridge,
          patchReport: args.patchReport,
          sourceRoot: args.sourceRoot,
          targetRoot: args.targetRoot,
          ...args.renderValidation,
        });
  const runtimeValidationAdmission =
    renderValidation === undefined ? undefined : admitWholeGameRuntimeValidation(renderValidation);

  return {
    patchExportBundle: result,
    apply,
    draftArtifactBundleId,
    ...(renderValidation !== undefined ? { renderValidation } : {}),
    ...(runtimeValidationAdmission !== undefined ? { runtimeValidationAdmission } : {}),
  };
}

/**
 * Project a `SourceBridgeView` covering exactly the accepted-draft units from
 * the run's raw bridge. Each unit carries its source text + a deterministic
 * unit hash AND the REAL asset refs + protected spans the bridge declares.
 *
 * (P1 #1 — no vacuous pass.) These are NOT erased to `[]`. Asset refs are
 * projected from BOTH the CANONICAL v0.2 `sourceAssetRef` (a decision-bearing
 * image/ui/video/audio/font/metadata asset, resolved via the bundle `assets[]`)
 * AND any explicit `assetRefs[]` array — so a unit whose real localizable asset
 * has no active decision makes `noUnresolvedAssetDecisions` BLOCK. If the bridge
 * unit declares a protected span (a v0.2 `spans[]` entry, or an explicit
 * `protectedSpans[]` on the raw unit), the preflight `protectedSpanCoverage`
 * check verifies the accepted draft still contains that span's raw text and
 * BLOCKS export when a span was lost. Carrying the real data is what makes those
 * blocking checks able to throw.
 */
function buildSourceBridgeViewForAcceptedDrafts(args: {
  rawBridge: unknown;
  bundle: DraftArtifactBundle;
  projectId: string;
  localeBranchId: string;
  targetLocale: string;
  sourceBridgeHash: string;
}): SourceBridgeView {
  const acceptedIds = new Set(args.bundle.drafts.map((d) => d.sourceUnitId));
  const bridgeUnits = readBridgeUnits(args.rawBridge);
  const units: SourceBridgeUnit[] = [];
  for (const raw of bridgeUnits) {
    const bridgeUnitId = raw.bridgeUnitId;
    if (bridgeUnitId === undefined || !acceptedIds.has(bridgeUnitId)) continue;
    units.push({
      sourceUnitId: bridgeUnitId,
      sourceText: raw.sourceText,
      sourceUnitHash: raw.sourceHash ?? hashUnit(bridgeUnitId, raw.sourceText),
      assetRefs: raw.assetRefs,
      protectedSpans: raw.protectedSpans,
    });
  }
  return {
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    sourceBridgeHash: args.sourceBridgeHash,
    targetLocale: args.targetLocale,
    units,
  };
}

type ReadBridgeUnit = {
  bridgeUnitId?: string;
  sourceText: string;
  sourceHash?: string;
  assetRefs: SourceBridgeAssetRef[];
  protectedSpans: SourceBridgeProtectedSpan[];
};

/**
 * The v0.2 asset kinds whose CONTENT is a localization surface and therefore
 * REQUIRE an explicit asset-localization decision (image with baked-in text,
 * UI art, video, audio, font, credits/song metadata). A `script` / `text` /
 * `database` container asset — the thing dialogue text lives in — is byte-patched
 * directly and needs NO decision, so it is NOT projected as an asset ref (that
 * would spuriously block every dialogue unit). Mirrors the decision-bearing
 * asset kinds `assetKindsForAssetPolicySurfaceKindV02` maps its surfaces to.
 */
const DECISION_BEARING_ASSET_KINDS: ReadonlySet<string> = new Set([
  "image",
  "ui_texture",
  "video",
  "audio",
  "font",
  "metadata",
]);

function readBridgeUnits(rawBridge: unknown): ReadBridgeUnit[] {
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    throw new Error("whole-game patch-export: bridge JSON must be an object");
  }
  const record = rawBridge as Record<string, unknown>;
  const units = record.units;
  if (!Array.isArray(units)) {
    throw new Error("whole-game patch-export: bridge.units must be an array");
  }
  // The canonical v0.2 unit references its container by `sourceAssetRef.assetId`;
  // the asset's KIND lives on the bundle-level `assets[]` array (BridgeAssetV02).
  // Build the assetId -> assetKind map once so per-unit projection can decide
  // whether the referenced asset is decision-bearing.
  const assetKindByAssetId = readAssetKindByAssetId(record.assets);
  return units.map((unit) => {
    const unitRecord = unit as Record<string, unknown>;
    const sourceText = unitRecord.sourceText;
    if (typeof sourceText !== "string") {
      throw new Error("whole-game patch-export: bridge unit sourceText must be a string");
    }
    return {
      ...(typeof unitRecord.bridgeUnitId === "string"
        ? { bridgeUnitId: unitRecord.bridgeUnitId }
        : {}),
      sourceText,
      ...(typeof unitRecord.sourceHash === "string" ? { sourceHash: unitRecord.sourceHash } : {}),
      assetRefs: readUnitAssetRefs(unitRecord, assetKindByAssetId),
      protectedSpans: readUnitProtectedSpans(unitRecord, sourceText),
    };
  });
}

/**
 * Map every bundle-level `assets[]` entry's `assetId` to its `assetKind`, so a
 * unit's canonical `sourceAssetRef.assetId` can be resolved to a kind. Absent /
 * malformed assets array → empty map (units then project no canonical asset ref,
 * degrading to the explicit-only path).
 */
function readAssetKindByAssetId(rawAssets: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(rawAssets)) return out;
  for (const asset of rawAssets) {
    if (typeof asset !== "object" || asset === null) continue;
    const a = asset as Record<string, unknown>;
    if (typeof a.assetId === "string" && typeof a.assetKind === "string") {
      out.set(a.assetId, a.assetKind);
    }
  }
  return out;
}

/**
 * The asset refs the preflight `noUnresolvedAssetDecisions` check resolves.
 * Projected from BOTH shapes so the check runs over the REAL asset dependencies:
 *
 *   1. The CANONICAL v0.2 `sourceAssetRef: {assetId, assetKey?}` — resolved to a
 *      kind via the bundle-level `assets[]`. Only projected when the referenced
 *      asset is a DECISION-BEARING kind (image / ui_texture / video / audio /
 *      font / metadata); a `script`/`text` container needs no decision and is
 *      skipped. The projected ref keys the decision the SAME way the decision
 *      repository stores it — `{kind: "bridgeAssetRef", ref: <assetId>}` — so a
 *      unit whose canonical image asset has no active decision resolves
 *      `unresolved` and BLOCKS export.
 *   2. An explicit `assetRefs: [{kind, ref, assetKind}]` array (the source-view /
 *      fixture shape) when the bridge already carries it.
 *
 * Refs are de-duplicated by `kind:ref` so the same container referenced by many
 * written units is resolved once.
 */
function readUnitAssetRefs(
  record: Record<string, unknown>,
  assetKindByAssetId: ReadonlyMap<string, string>,
): SourceBridgeAssetRef[] {
  const byKey = new Map<string, SourceBridgeAssetRef>();
  const add = (ref: SourceBridgeAssetRef): void => {
    byKey.set(`${ref.kind}:${ref.ref}`, ref);
  };

  const canonical = readCanonicalSourceAssetRef(record, assetKindByAssetId);
  if (canonical !== null) add(canonical);

  const raw = record.assetRefs;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new Error("whole-game patch-export: bridge unit assetRefs must be an array");
    }
    raw.forEach((entry, index) => {
      const r = entry as Record<string, unknown>;
      if (
        typeof r.kind !== "string" ||
        typeof r.ref !== "string" ||
        typeof r.assetKind !== "string"
      ) {
        throw new Error(
          `whole-game patch-export: bridge unit assetRefs[${index}] must have string kind/ref/assetKind`,
        );
      }
      add({ kind: r.kind, ref: r.ref, assetKind: r.assetKind });
    });
  }
  return [...byKey.values()];
}

/**
 * Project the unit's canonical v0.2 `sourceAssetRef` as a decision-bearing asset
 * ref, or `null` when it has none / references a non-decision-bearing (e.g.
 * `script`) container. Keyed `{kind: "bridgeAssetRef", ref: assetId}` to match
 * the decision repository's stored ref (`ItotoriAssetLocalizationDecisionRepository`).
 */
function readCanonicalSourceAssetRef(
  record: Record<string, unknown>,
  assetKindByAssetId: ReadonlyMap<string, string>,
): SourceBridgeAssetRef | null {
  const sourceAssetRef = record.sourceAssetRef;
  if (typeof sourceAssetRef !== "object" || sourceAssetRef === null) return null;
  const assetId = (sourceAssetRef as Record<string, unknown>).assetId;
  if (typeof assetId !== "string") return null;
  const assetKind = assetKindByAssetId.get(assetId);
  if (assetKind === undefined || !DECISION_BEARING_ASSET_KINDS.has(assetKind)) {
    // Unknown kind (asset not in the bundle `assets[]`) or a non-decision-bearing
    // container: not a localization surface, so no decision is required.
    return null;
  }
  return { kind: "bridgeAssetRef", ref: assetId, assetKind };
}

/**
 * The protected spans the preflight `protectedSpanCoverage` check verifies
 * survived into the accepted draft. Read from either:
 *   - the canonical v0.2 `spans: [{spanId, spanKind, raw, ...}]` array (the real
 *     decoded-bridge shape), mapped to the patch-export span kinds; or
 *   - an explicit `protectedSpans: [{spanRef, sourceStart, sourceEnd, sourceText,
 *     kind, preservationRule, expectedTargetForm?}]` array (the source-view
 *     shape) when the bridge already carries it.
 * Absent / empty → the unit declares no protected spans.
 */
function readUnitProtectedSpans(
  record: Record<string, unknown>,
  sourceText: string,
): SourceBridgeProtectedSpan[] {
  const explicit = record.protectedSpans;
  if (Array.isArray(explicit)) {
    return explicit.map((entry, index) => readExplicitProtectedSpan(entry, index));
  }
  const spans = record.spans;
  if (spans === undefined) return [];
  if (!Array.isArray(spans)) {
    throw new Error("whole-game patch-export: bridge unit spans must be an array");
  }
  return spans.map((entry, index) => mapV02SpanToProtectedSpan(entry, index, sourceText));
}

function readExplicitProtectedSpan(entry: unknown, index: number): SourceBridgeProtectedSpan {
  const r = entry as Record<string, unknown>;
  if (
    typeof r.spanRef !== "string" ||
    typeof r.sourceStart !== "number" ||
    typeof r.sourceEnd !== "number" ||
    typeof r.sourceText !== "string" ||
    typeof r.kind !== "string" ||
    typeof r.preservationRule !== "string"
  ) {
    throw new Error(
      `whole-game patch-export: bridge unit protectedSpans[${index}] is missing a required field`,
    );
  }
  const span: SourceBridgeProtectedSpan = {
    spanRef: r.spanRef,
    sourceStart: r.sourceStart,
    sourceEnd: r.sourceEnd,
    sourceText: r.sourceText,
    kind: r.kind as SourceBridgeProtectedSpan["kind"],
    preservationRule: r.preservationRule as SourceBridgeProtectedSpan["preservationRule"],
  };
  if (typeof r.expectedTargetForm === "string") {
    span.expectedTargetForm = r.expectedTargetForm;
  }
  // Out-of-band exemption is control-markup-only (see mapV02SpanToProtectedSpan):
  // never let a `variable` span (a real in-body variable/name run) be vacated.
  if (r.outOfBand === true && span.kind === "markup") {
    span.outOfBand = true;
  }
  return span;
}

/**
 * Map a canonical v0.2 `BridgeSpanV02` (`spanKind` ∈ control_markup /
 * variable_placeholder / ruby_annotation) to a patch-export protected span. The
 * span's `raw` bytes are the verbatim text that MUST reappear in the draft, so
 * `sourceText` carries `raw` and the preservation rule is verbatim for
 * variables and markup-well-formed for markup / ruby.
 */
export function mapV02SpanToProtectedSpan(
  entry: unknown,
  index: number,
  sourceText: string,
): SourceBridgeProtectedSpan {
  const r = entry as Record<string, unknown>;
  const raw = r.raw;
  if (typeof raw !== "string") {
    throw new Error(`whole-game patch-export: bridge unit spans[${index}].raw must be a string`);
  }
  const spanKind = typeof r.spanKind === "string" ? r.spanKind : "control_markup";
  const spanId = typeof r.spanId === "string" ? r.spanId : `span-${index}`;
  const startByte = typeof r.startByte === "number" ? r.startByte : sourceText.indexOf(raw);
  const endByte = typeof r.endByte === "number" ? r.endByte : startByte + raw.length;
  const isVariable = spanKind === "variable_placeholder";
  return {
    spanRef: spanId,
    sourceStart: startByte,
    sourceEnd: endByte,
    sourceText: raw,
    kind: isVariable ? "variable" : "markup",
    preservationRule: isVariable ? "verbatim" : "markup_well_formed",
    // Out-of-band (structurally re-emitted, not spliced) is ONLY valid for
    // control-markup spans (e.g. reallive.kidoku). A variable/name/ruby span has
    // real bytes in the Textout body and MUST be covered by the draft; a crafted
    // bridge cannot vacate its protection by asserting outOfBand.
    outOfBand: r.outOfBand === true && spanKind === "control_markup",
  };
}

function hashRawBridge(rawBridge: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(rawBridge)).digest("hex")}`;
}

function hashUnit(bridgeUnitId: string, sourceText: string): string {
  return `sha256:${createHash("sha256").update(`${bridgeUnitId}|${sourceText}`).digest("hex")}`;
}
