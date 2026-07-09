// itotori-localize-fullproject-cli — the general `itotori localize <project>`
// whole-game driver.
//
// Before this module the shipped localize surfaces were single-unit: the
// suite `run.mjs` driver + the `localize-project-stage` CLI each drove ONE
// bridge unit through the agentic loop. The whole-PROJECT executor
// (`runProjectDrivenExecutor`) + the multi-pass ledger (`runLocalizationPass`)
// existed but had no shipped CLI entry point wiring them to real persistence.
//
// This is that driver. Given a project's CONFIG (project / engine / data-root
// + the extracted bridge + the pair-policy), it runs the FULL project — every
// in-scope unit — through `runLocalizationPass`, which:
//   - LOADS the latest prior pass from the DB-backed pass ledger so a live pass
//     N+1 consumes pass N's accepted state + flagged-unit feedback;
//   - drives every in-scope unit through the agentic loop, PERSISTING drafts +
//     provider-runs (real usage.cost + ZDR) + reviewer-queue items and
//     exporting ONE patch;
//   - RECORDS the pass in the ledger (deterministic accepted deltas vs prior).
//
// GAME-AGNOSTIC: there is no game-specific code path and no hardcoded game
// path anywhere. Everything a run needs — the project/branch/revision ids, the
// engine profile, the translation scope, the (out-of-repo) bridge + decoded
// structure paths, the data-root — arrives through the config. The real bytes
// for any run come from the configured data-root (the bridge is its extracted
// product). Swapping the config runs the SAME driver over a different project.
//
// Cost + ZDR (PROJECT LAW): recorded ONLY from real provider telemetry the
// executor summed — surfaced on the pass record, the patch report, and the run
// summary. A zero-cost fake provider (tests) records the real zero it produced;
// nothing is fabricated.

import type { AuthorizationActor, ItotoriTerminologyCandidateRepositoryPort } from "@itotori/db";
import type { BridgeBundleV02, StyleGuidePolicyV0Draft } from "@itotori/localization-bridge-schema";
import {
  parseNarrativeStructure,
  type NarrativeStructure,
} from "../agents/structure-informed-context/index.js";
import type { TranslationGlossaryEntry } from "../agents/translation/shapes.js";
import type { AgenticLoopProviderFactory } from "./agentic-loop.js";
import type { AgenticLoopReviewerQueueSink } from "./reviewer-queue-bridge.js";
import { parseLocalizeProjectPairPolicy } from "./localize-project-stage-command.js";
import {
  type DrivenDraftSink,
  type DrivenEngineProfile,
  type DrivenPatchExportSink,
  type DrivenProviderRunSink,
  type DrivenUnitContext,
  type DrivenUnitContextResolver,
  type ProjectDrivenExecutorInput,
  type ProjectDrivenExecutorResult,
  type TranslationScope,
} from "./project-driven-executor.js";
import {
  buildPipelineFailureDiagnostic,
  PipelineFailureDiagnosticError,
  runPipelineStepWithDiagnostic,
} from "./pipeline-failure-diagnostic.js";
import {
  runLocalizationPass,
  type LocalizationPassRecord,
  type PassLedgerPort,
} from "./pass-ledger.js";

const CONFIG_SCHEMA_VERSION = "itotori.localize-fullproject.config.v0";
const RUN_SUMMARY_SCHEMA_VERSION = "itotori.localize-fullproject.run-summary.v0";

const ENGINE_PROFILES: ReadonlySet<DrivenEngineProfile> = new Set(["reallive", "rpg-maker-mv-mz"]);
const TRANSLATION_SCOPES: ReadonlySet<TranslationScope> = new Set([
  "dialogue-only",
  "dialogue-and-choices",
  "dialogue-choices-ui",
  "all",
]);

/**
 * The whole-project localize config. GAME-AGNOSTIC + project-parameterised:
 * every field the driver needs to localize ANY supported project arrives here.
 * No game-specific field; no path is hardcoded in shipped source.
 */
export type LocalizeFullProjectConfig = {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  /** The engine the project targets (drives translated-bundle synthesis). */
  engineProfile: DrivenEngineProfile;
  /** Config-driven translation scope. Defaults to dialogue-only. */
  translationScope?: TranslationScope;
  targetLocale?: string;
  /** Path to the extracted v0.2 bridge bundle (the data-root's product). */
  bridgePath: string;
  /** Path to the v0.3 pair-policy JSON (the single pinned (model, provider)). */
  pairPolicyPath: string;
  /**
   * Optional path to the decoded `utsushi.narrative-structure.v1` JSON (held
   * out-of-repo — it carries copyrighted script text). When present each unit
   * receives the DETERMINISTIC structure-informed context for its scene.
   */
  structureJsonPath?: string;
  /**
   * The data-root the bridge was extracted from — recorded for provenance
   * only. Game-agnostic: it is a config value, never a hardcoded path.
   */
  dataRoot?: string;
  /** Bounded-slice dispatch cap; omit to drive every in-scope unit. */
  maxUnits?: number;
  /** USD budget cap on the real total usage.cost. */
  budgetCapUsd?: number;
  /** Client-side bounded-concurrency cap. */
  concurrency?: number;
  maxRepairAttempts?: number;
  /**
   * Optional reviewer / QA-finding notes to layer into THIS pass, keyed by
   * bridge unit — a correction added between pass N and pass N+1 that the next
   * pass must address.
   */
  feedbackNotesByUnit?: Record<string, string>;
};

export type LocalizeFullProjectIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

/**
 * Injected dependencies. The persistence sinks + reviewer queue + pass ledger
 * are ports so production binds them to real DB/fs adapters while a test binds
 * a real-Postgres ledger + a fake provider (no live cost). The provider factory
 * is injected verbatim so the (model, provider) pinning + ZDR flow unchanged.
 */
export type LocalizeFullProjectDeps = {
  io: LocalizeFullProjectIo;
  actor: AuthorizationActor;
  providerFactory: AgenticLoopProviderFactory;
  sinks: {
    draft: DrivenDraftSink;
    providerRun: DrivenProviderRunSink;
    patchExport: DrivenPatchExportSink;
  };
  passLedger: PassLedgerPort;
  reviewerQueue?: AgenticLoopReviewerQueueSink;
  terminologyCandidateRepository?: ItotoriTerminologyCandidateRepositoryPort;
  glossary?: ReadonlyArray<TranslationGlossaryEntry>;
  styleGuide?: StyleGuidePolicyV0Draft;
  /**
   * Optional caller-resolved per-unit context extension. The command composes
   * this with its decoded-structure resolver so full-project callers can feed
   * work-scoped effective context (shared inherited glossary/characters/style
   * continuity + per-work overrides) without this driver inventing a manifest
   * schema or title-specific mapping.
   */
  resolveUnitContext?: DrivenUnitContextResolver;
  afterExecutor?: (
    result: ProjectDrivenExecutorResult,
  ) => Promise<ProjectDrivenExecutorResult> | ProjectDrivenExecutorResult;
  now?: () => Date;
  log?: (message: string) => void;
};

export type LocalizeFullProjectArgs = {
  configPath: string;
  /** Where the deterministic run-summary artifact lands. */
  runSummaryPath: string;
  deps: LocalizeFullProjectDeps;
};

export type LocalizeFullProjectResult = {
  result: ProjectDrivenExecutorResult;
  record: LocalizationPassRecord;
  prior: LocalizationPassRecord | undefined;
};

/**
 * Run the whole-project localize driver: parse the config, run the full
 * project through `runLocalizationPass` (persisting the pass to the DB ledger
 * so pass N+1 builds on persisted pass N), and write the run summary. Returns
 * the executor result + the recorded pass + the prior pass it built on.
 */
export async function runLocalizeFullProjectCommand(
  args: LocalizeFullProjectArgs,
): Promise<LocalizeFullProjectResult> {
  const { deps } = args;
  const log = deps.log ?? (() => {});

  // itotori-agent-facing-pipeline-failure-diagnostics — each pipeline step is
  // wrapped so a thrown error becomes a structured diagnostic naming the step,
  // the failing unit/scene (when applicable), the inputs (redaction-safe), and
  // a minimal repro pointer. An agent driving the pipeline reads ONE
  // diagnostic, not a bare `Error: <message>` it has to guess at.
  const baseInputs: Record<string, unknown> = {
    configPath: args.configPath,
    runSummaryPath: args.runSummaryPath,
  };

  const config = await runPipelineStepWithDiagnostic<LocalizeFullProjectConfig>({
    step: "localize.parse-config",
    code: "refused",
    message: `localize.parse-config refused: config JSON at '${args.configPath}' is invalid`,
    repro: { configPath: args.configPath },
    inputs: baseInputs,
    actor: deps.actor,
    now: deps.now,
    run: () => parseLocalizeFullProjectConfig(deps.io.readJson(args.configPath)),
  });
  const targetLocale = config.targetLocale ?? "en-US";
  const translationScope = config.translationScope ?? "dialogue-only";

  const rawBridge = await runPipelineStepWithDiagnostic({
    step: "localize.read-bridge",
    code: "io-error",
    message: `localize.read-bridge failed: could not read bridge at '${config.bridgePath}'`,
    repro: { configPath: args.configPath, bridgePath: config.bridgePath },
    inputs: { ...baseInputs, bridgePath: config.bridgePath },
    actor: deps.actor,
    now: deps.now,
    run: () => deps.io.readJson(config.bridgePath),
  });
  const bridge = await runPipelineStepWithDiagnostic({
    step: "localize.read-bridge",
    code: "refused",
    message: `localize.read-bridge refused: bridge file at '${config.bridgePath}' is not a v0.2 bridge`,
    repro: { configPath: args.configPath, bridgePath: config.bridgePath },
    inputs: { ...baseInputs, bridgePath: config.bridgePath },
    actor: deps.actor,
    now: deps.now,
    run: () => assertBridgeBundleV02Shape(rawBridge),
  });
  if (bridge.units.length === 0) {
    throw new PipelineFailureDiagnosticError(
      buildPipelineFailureDiagnostic({
        step: "localize.read-bridge",
        code: "refused",
        message: "localize.read-bridge refused: bridge has zero units",
        error: new Error("localize: refused — bridge has zero units"),
        repro: { configPath: args.configPath, bridgePath: config.bridgePath },
        inputs: { ...baseInputs, bridgePath: config.bridgePath },
        actor: deps.actor,
        now: deps.now,
      }),
    );
  }

  const {
    pair,
    pairPolicy,
    sceneId: defaultSceneId,
  } = await runPipelineStepWithDiagnostic({
    step: "localize.read-pair-policy",
    code: "refused",
    message: `localize.read-pair-policy refused: pair-policy at '${config.pairPolicyPath}' is invalid`,
    repro: {
      configPath: args.configPath,
      bridgePath: config.bridgePath,
      pairPolicyPath: config.pairPolicyPath,
    },
    inputs: { ...baseInputs, pairPolicyPath: config.pairPolicyPath },
    actor: deps.actor,
    now: deps.now,
    run: () => parseLocalizeProjectPairPolicy(deps.io.readJson(config.pairPolicyPath)),
  });

  // Optional decoded structure -> per-unit structure-informed context resolver.
  let structure: NarrativeStructure | undefined;
  if (config.structureJsonPath !== undefined) {
    const structureJsonPath: string = config.structureJsonPath;
    const structureJson = await runPipelineStepWithDiagnostic({
      step: "localize.read-structure",
      code: "io-error",
      message: `localize.read-structure failed: could not read structure at '${structureJsonPath}'`,
      repro: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        pairPolicyPath: config.pairPolicyPath,
        structureJsonPath,
      },
      inputs: { ...baseInputs, structureJsonPath },
      actor: deps.actor,
      now: deps.now,
      run: () => deps.io.readJson(structureJsonPath),
    });
    structure = await runPipelineStepWithDiagnostic({
      step: "localize.read-structure",
      code: "refused",
      message: `localize.read-structure refused: structure JSON at '${structureJsonPath}' is invalid`,
      repro: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        pairPolicyPath: config.pairPolicyPath,
        structureJsonPath,
      },
      inputs: { ...baseInputs, structureJsonPath },
      actor: deps.actor,
      now: deps.now,
      run: () => parseNarrativeStructure(structureJson),
    });
  }
  const structureUnitContext =
    structure === undefined ? undefined : buildStructureResolver(structure, defaultSceneId);
  const resolveUnitContext = composeDrivenUnitContextResolvers(
    structureUnitContext,
    deps.resolveUnitContext,
  );

  const feedbackNotesByUnit =
    config.feedbackNotesByUnit === undefined
      ? undefined
      : new Map<string, string>(Object.entries(config.feedbackNotesByUnit));

  const executorInput: Omit<ProjectDrivenExecutorInput, "priorPass"> = {
    bridge,
    rawBridge,
    pairPolicy,
    pair,
    projectId: config.projectId,
    localeBranchId: config.localeBranchId,
    sourceRevisionId: config.sourceRevisionId,
    targetLocale,
    actor: deps.actor,
    providerFactory: deps.providerFactory,
    translationScope,
    engineProfile: config.engineProfile,
    sinks: {
      draft: deps.sinks.draft,
      providerRun: deps.sinks.providerRun,
      patchExport: deps.sinks.patchExport,
    },
    ...(deps.reviewerQueue !== undefined ? { reviewerQueue: deps.reviewerQueue } : {}),
    ...(deps.terminologyCandidateRepository !== undefined
      ? { terminologyCandidateRepository: deps.terminologyCandidateRepository }
      : {}),
    ...(deps.glossary !== undefined ? { glossary: deps.glossary } : {}),
    ...(deps.styleGuide !== undefined ? { styleGuide: deps.styleGuide } : {}),
    ...(resolveUnitContext !== undefined ? { resolveUnitContext } : {}),
    ...(config.maxUnits !== undefined ? { maxUnits: config.maxUnits } : {}),
    ...(config.budgetCapUsd !== undefined ? { budgetCapUsd: config.budgetCapUsd } : {}),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.maxRepairAttempts !== undefined
      ? { maxRepairAttempts: config.maxRepairAttempts }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };

  log(
    `localize: project=${config.projectId} branch=${config.localeBranchId} engine=${config.engineProfile} ` +
      `scope=${translationScope} pair=(${pair.modelId}, ${pair.providerId})`,
  );

  // Run ONE localization pass through the ledger: pass N+1 consumes the
  // persisted pass N; the executor persists drafts + reviewer items + exports
  // the patch; the ledger records the pass (real usage.cost + ZDR verbatim).
  const { result, record, prior } = await runPipelineStepWithDiagnostic({
    step: "localize.run-pass",
    code: "unknown",
    message: `localize.run-pass failed: the driven executor / pass-ledger step aborted`,
    repro: {
      configPath: args.configPath,
      bridgePath: config.bridgePath,
      pairPolicyPath: config.pairPolicyPath,
      ...(config.structureJsonPath !== undefined
        ? { structureJsonPath: config.structureJsonPath }
        : {}),
    },
    inputs: {
      ...baseInputs,
      bridgePath: config.bridgePath,
      pairPolicyPath: config.pairPolicyPath,
      ...(config.structureJsonPath !== undefined
        ? { structureJsonPath: config.structureJsonPath }
        : {}),
      projectId: config.projectId,
      localeBranchId: config.localeBranchId,
      sourceRevisionId: config.sourceRevisionId,
      translationScope,
      targetLocale,
      pair,
    },
    actor: deps.actor,
    now: deps.now,
    run: () =>
      runLocalizationPass({
        ledger: deps.passLedger,
        actor: deps.actor,
        executorInput,
        ...(deps.afterExecutor !== undefined ? { afterExecutor: deps.afterExecutor } : {}),
        ...(feedbackNotesByUnit !== undefined ? { feedbackNotesByUnit } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      }),
  });

  const runSummary = {
    schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
    projectId: config.projectId,
    localeBranchId: config.localeBranchId,
    sourceRevisionId: config.sourceRevisionId,
    ...(config.dataRoot !== undefined ? { dataRoot: config.dataRoot } : {}),
    engineProfile: config.engineProfile,
    translationScope,
    targetLocale,
    pair,
    passNumber: record.passNumber,
    priorPassNumber: record.priorPassNumber ?? null,
    unitsEnumerated: result.unitsEnumerated,
    unitsInScope: result.unitsInScope,
    unitsRun: result.unitsRun,
    acceptedDraftCount: result.acceptedDraftCount,
    deferredCount: result.deferredCount,
    failureCount: result.failures.length,
    reviewerQueueItemCount: result.reviewerQueueItemCount,
    patchExportCount: result.patchExportCount,
    ...(result.runtimeValidation !== undefined
      ? { runtimeValidation: result.runtimeValidation }
      : {}),
    acceptedDeltaCount: record.acceptedDeltas.length,
    // PROJECT LAW: the REAL summed usage.cost + ZDR posture, verbatim.
    totalUsageCostUsd: result.totalUsageCostUsd,
    zdrConfirmed: result.zdrConfirmed,
    budgetStopped: result.budgetStopped,
  };
  await runPipelineStepWithDiagnostic({
    step: "localize.write-run-summary",
    code: "io-error",
    message: `localize.write-run-summary failed: could not write run summary to '${args.runSummaryPath}'`,
    inputs: { ...baseInputs, runSummaryPath: args.runSummaryPath, passNumber: record.passNumber },
    actor: deps.actor,
    now: deps.now,
    run: async () => {
      deps.io.writeJson(args.runSummaryPath, runSummary);
    },
  });
  log(
    `localize: pass ${record.passNumber} recorded — ${result.unitsRun} unit(s), ` +
      `${result.acceptedDraftCount} accepted / ${result.deferredCount} deferred / ${result.failures.length} failed; ` +
      `${record.acceptedDeltas.length} accepted delta(s); usage.cost $${result.totalUsageCostUsd.toFixed(6)} ` +
      `(zdr=${result.zdrConfirmed}); wrote ${args.runSummaryPath}`,
  );

  return { result, record, prior };
}

/**
 * Build the per-unit structure-informed context resolver. Each unit's scene is
 * resolved from its own route scene id (falling back to the planner's scene id,
 * then the pair-policy default scene) so a WHOLE-project run spanning many
 * scenes threads the right slice per unit. Context is attached only when the
 * decoded structure actually contains that scene; otherwise the loop runs the
 * semantic agents live with no deterministic block (graceful degrade).
 */
export function buildStructureResolver(
  structure: NarrativeStructure,
  defaultSceneId: number,
): DrivenUnitContextResolver {
  const sceneIds = new Set(structure.scenes.map((scene) => scene.sceneId));
  return ({ unit, plannerSceneId }): DrivenUnitContext | undefined => {
    const sceneId =
      readUnitRouteSceneNumber(unit) ?? toSceneNumber(plannerSceneId) ?? defaultSceneId;
    if (sceneId === undefined || !sceneIds.has(sceneId)) {
      return undefined;
    }
    return { narrativeStructure: structure, sceneId };
  };
}

export function composeDrivenUnitContextResolvers(
  base: DrivenUnitContextResolver | undefined,
  overlay: DrivenUnitContextResolver | undefined,
): DrivenUnitContextResolver | undefined {
  if (base === undefined) {
    return overlay;
  }
  if (overlay === undefined) {
    return base;
  }
  return (args) => {
    const baseContext = base(args);
    const overlayContext = overlay(args);
    if (baseContext === undefined) {
      return overlayContext;
    }
    if (overlayContext === undefined) {
      return baseContext;
    }
    return { ...baseContext, ...overlayContext };
  };
}

/**
 * Recover the numeric RealLive scene id from a bridge unit's route context. The
 * `--whole-seen` bridge emits the scene as `context.route.sceneKey` (a
 * `"scene-NNNN"` string) — `sceneId` in the v0.2 schema is a UUID7, NOT the
 * numeric scene index (see RouteContextV02), so the canonical numeric-bearing
 * field IS `sceneKey`. This parses the `scene-NNNN` form (and a bare-numeric
 * fallback) to the numeric id the structure's `scenes[].sceneId` uses.
 */
function readUnitRouteSceneNumber(unit: unknown): number | undefined {
  const route = (unit as { context?: { route?: { sceneKey?: unknown } } }).context?.route;
  return toSceneNumber(route?.sceneKey);
}

function toSceneNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    // Accept both the canonical `scene-NNNN` bridge form and a bare-numeric id.
    const digits = value.match(/^(?:scene-)?(\d+)$/u)?.[1];
    if (digits !== undefined) {
      return Number.parseInt(digits, 10);
    }
  }
  return undefined;
}

/**
 * Parse + validate a raw JSON value as a {@link LocalizeFullProjectConfig}.
 * Every required field is checked (no silent defaulting of identity fields);
 * the engine profile + translation scope are validated against their closed
 * sets so a typo fails loudly rather than defaulting to the wrong surface.
 */
export function parseLocalizeFullProjectConfig(value: unknown): LocalizeFullProjectConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("localize: refused — config must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `localize: refused — config.schemaVersion must be '${CONFIG_SCHEMA_VERSION}' (got ${String(record.schemaVersion)})`,
    );
  }
  const projectId = requireString(record, "projectId");
  const localeBranchId = requireString(record, "localeBranchId");
  const sourceRevisionId = requireString(record, "sourceRevisionId");
  const bridgePath = requireString(record, "bridgePath");
  const pairPolicyPath = requireString(record, "pairPolicyPath");

  const engineProfile = record.engineProfile;
  if (
    typeof engineProfile !== "string" ||
    !ENGINE_PROFILES.has(engineProfile as DrivenEngineProfile)
  ) {
    throw new Error(
      `localize: refused — config.engineProfile must be one of ${[...ENGINE_PROFILES].join(", ")} (got ${String(engineProfile)})`,
    );
  }

  let translationScope: TranslationScope | undefined;
  if (record.translationScope !== undefined) {
    if (
      typeof record.translationScope !== "string" ||
      !TRANSLATION_SCOPES.has(record.translationScope as TranslationScope)
    ) {
      throw new Error(
        `localize: refused — config.translationScope must be one of ${[...TRANSLATION_SCOPES].join(", ")} (got ${String(record.translationScope)})`,
      );
    }
    translationScope = record.translationScope as TranslationScope;
  }

  const out: LocalizeFullProjectConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    projectId,
    localeBranchId,
    sourceRevisionId,
    engineProfile: engineProfile as DrivenEngineProfile,
    bridgePath,
    pairPolicyPath,
    ...(translationScope !== undefined ? { translationScope } : {}),
    ...(optionalString(record, "targetLocale") !== undefined
      ? { targetLocale: optionalString(record, "targetLocale")! }
      : {}),
    ...(optionalString(record, "structureJsonPath") !== undefined
      ? { structureJsonPath: optionalString(record, "structureJsonPath")! }
      : {}),
    ...(optionalString(record, "dataRoot") !== undefined
      ? { dataRoot: optionalString(record, "dataRoot")! }
      : {}),
    ...(optionalNonNegativeInt(record, "maxUnits") !== undefined
      ? { maxUnits: optionalNonNegativeInt(record, "maxUnits")! }
      : {}),
    ...(optionalPositiveNumber(record, "budgetCapUsd") !== undefined
      ? { budgetCapUsd: optionalPositiveNumber(record, "budgetCapUsd")! }
      : {}),
    ...(optionalNonNegativeInt(record, "concurrency") !== undefined
      ? { concurrency: optionalNonNegativeInt(record, "concurrency")! }
      : {}),
    ...(optionalNonNegativeInt(record, "maxRepairAttempts") !== undefined
      ? { maxRepairAttempts: optionalNonNegativeInt(record, "maxRepairAttempts")! }
      : {}),
    ...(parseFeedbackNotes(record.feedbackNotesByUnit) !== undefined
      ? { feedbackNotesByUnit: parseFeedbackNotes(record.feedbackNotesByUnit)! }
      : {}),
  };
  return out;
}

function parseFeedbackNotes(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "localize: refused — config.feedbackNotesByUnit must be an object of unit -> note",
    );
  }
  const out: Record<string, string> = {};
  for (const [key, note] of Object.entries(value)) {
    if (typeof note !== "string" || note.length === 0) {
      throw new Error(
        `localize: refused — config.feedbackNotesByUnit['${key}'] must be a non-empty string`,
      );
    }
    out[key] = note;
  }
  return out;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`localize: refused — config.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`localize: refused — config.${key}, when present, must be a non-empty string`);
  }
  return value;
}

function optionalNonNegativeInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `localize: refused — config.${key}, when present, must be a non-negative integer`,
    );
  }
  return value;
}

function optionalPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`localize: refused — config.${key}, when present, must be a positive number`);
  }
  return value;
}

function assertBridgeBundleV02Shape(value: unknown): BridgeBundleV02 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("localize: refused — bridge file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "0.2.0") {
    throw new Error(
      `localize: refused — bridge schemaVersion must be '0.2.0' (got ${String(record.schemaVersion)})`,
    );
  }
  return value as BridgeBundleV02;
}
