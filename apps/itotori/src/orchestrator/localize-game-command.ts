// itotori-cli-localize-game-vertical — the M1 capstone.
//
// ONE user-shaped command an agent types to localize the WHOLE game
// end-to-end. `itotori localize-game` composes the EXISTING gated
// subcommands / their in-process seams — it does NOT re-implement any of
// their logic:
//
//   Stage 1 EXTRACT   — `runKaifuuRealliveExtract({ wholeSeen: true })`
//                        (the same seam `itotori extract --whole-seen` drives):
//                        one v0.2 BridgeBundle over the entire Seen.txt of the
//                        read-only source game.
//   Stage 2 STRUCTURE — `runUtsushiStructureExport(...)` (the same seam
//                        `itotori structure-export` drives): the deterministic
//                        `utsushi.narrative-structure.v1` the localize driver
//                        consumes as per-unit structure-informed context.
//   Stage 3 LOCALIZE  — `runLocalizeFullProjectLive({ sourceRoot,
//                        patchTargetRoot })` (the whole-game driver + the M1
//                        patch-apply seam that `itotori localize --source
//                        --patch-target` reaches): drives every in-scope unit
//                        against live OpenRouter + real Postgres, then applies
//                        the byte-correct patch to the writable target.
//   Stage 4 VALIDATE  — `utsushi replay-validate` + `render-validate` over the
//                        patched target (the same native invocations
//                        `itotori validate` drives).
//
// The bridge (stage 1) + structure (stage 2) land in the run dir; the command
// derives an EFFECTIVE localize config that overrides the base config's
// `bridgePath` / `structureJsonPath` with those fresh artifacts, so the
// localize driver consumes exactly what this run produced. Every stage seam is
// injected so the orchestration test can drive the stage SEQUENCE + wiring with
// mocked stages (CI touches no real bytes), while the real path binds them to
// the production seams (the env-gated real-Sweetie proof runs the true
// vertical). A stage failure is surfaced with the stage name + a structured
// diagnostic (pipeline-failure diagnostics are preserved verbatim).

import { dirname, join } from "node:path";
import {
  PipelineFailureDiagnosticError,
  renderPipelineFailureDiagnosticOneLine,
} from "./pipeline-failure-diagnostic.js";
import {
  runKaifuuRealliveExtract,
  type KaifuuExtractArgs,
  type KaifuuExtractResult,
} from "../extract/kaifuu-extract-seam.js";
import {
  runUtsushiStructureExport,
  type RunUtsushiStructureArgs,
  type RunUtsushiStructureResult,
} from "../structure-export/utsushi-structure-seam.js";
import {
  runLocalizeFullProjectLive,
  type RunLocalizeFullProjectLiveArgs,
  type RunLocalizeFullProjectLiveResult,
} from "./localize-fullproject-cli.js";
import {
  runNativeCli,
  type NativeCliRunner,
  type NativeCliProcessResult,
} from "../native-bin/cli-bin-resolver.js";
import {
  resolveRealliveSourcePaths,
  type RealliveSourceFsProbe,
} from "./reallive-source-resolver.js";

/** The four stages of the whole-game vertical, in dispatch order. */
export const LOCALIZE_GAME_STAGES = Object.freeze([
  "extract",
  "structure",
  "localize",
  "validate",
] as const);
export type LocalizeGameStage = (typeof LOCALIZE_GAME_STAGES)[number];

/** A stage failure carrying the failing stage + the (already-scrubbed) cause. */
export class LocalizeGameStageError extends Error {
  constructor(
    public readonly stage: LocalizeGameStage,
    message: string,
    public readonly stageCause: unknown,
  ) {
    super(message);
    this.name = "LocalizeGameStageError";
  }
}

/** RealLive identity the whole-seen extract needs (mirrors `itotori extract`). */
export type LocalizeGameIdentity = {
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceLocale: string;
};

/**
 * IO the command uses for the effective-config read+write. Mirrors the
 * `JsonFileStore` shape the CLI store implements.
 */
export type LocalizeGameIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

/**
 * The injected stage seams. Production binds these to the real seams (see
 * `defaultLocalizeGameStages`); the orchestration test binds fakes to assert
 * the sequence + the effective-config wiring without touching real bytes.
 */
export type LocalizeGameStageSeams = {
  extract(args: KaifuuExtractArgs): KaifuuExtractResult;
  structure(args: RunUtsushiStructureArgs): RunUtsushiStructureResult;
  localize(args: RunLocalizeFullProjectLiveArgs): Promise<RunLocalizeFullProjectLiveResult>;
  /** Wraps a native CLI (utsushi-cli) for the replay/render validate stage. */
  runNative(bin: "utsushi-cli", args: string[]): NativeCliProcessResult;
};

export type RunLocalizeGameArgs = {
  /**
   * Base localize-fullproject config (v0). Carries the project identity
   * (projectId / localeBranchId / sourceRevisionId), engineProfile,
   * translationScope, and pairPolicyPath. Its `bridgePath` / `structureJsonPath`
   * are OVERRIDDEN by this run's stage-1 / stage-2 artifacts — the base config
   * value (if any) is provenance only.
   */
  configPath: string;
  /** Read-only source game root (contains REALLIVEDATA/Seen.txt). */
  sourceRoot: string;
  /** Writable target the byte-correct patched game lands under. */
  targetRoot: string;
  /** Directory the per-run artifacts (bridge, structure, patch, validate) land in. */
  runDir: string;
  /** RealLive identity for the whole-seen extract. */
  identity: LocalizeGameIdentity;
  /**
   * Sourcing for the extract + structure stages. EITHER a vault canonical id
   * (by-id, read-only) OR a raw game root path. Defaults the raw game root to
   * `sourceRoot` when neither is given (the common local case).
   */
  vaultCanonicalId?: string;
  gameRoot?: string;
  /**
   * Paths (inside the source tree) to Gameexe.ini + Seen.txt the structure
   * stage reads. When omitted they are RESOLVED from `sourceRoot` the SAME way
   * the extract stage resolves its game root — descending a bounded single-child
   * chain to the directory that directly contains `REALLIVEDATA/` (issue #64 E2)
   * — so a `--source` that wraps a nested game folder works for both stages. A
   * source with no `REALLIVEDATA/` resolves to `<sourceRoot>/REALLIVEDATA/*`
   * (loud downstream failure, identical to extract on the same input).
   */
  gameexePath?: string;
  seenPath?: string;
  /**
   * Filesystem probe the game-root resolver reads through. Injected for tests;
   * defaults to real `node:fs`.
   */
  sourceFsProbe?: RealliveSourceFsProbe;
  /** Optional entry scene override for the structure dispatch-order walk. */
  entryScene?: number;
  /** Scene id the validate stage replays + renders. */
  validateScene: string;
  /** The localized target text the render-validate frame must contain. */
  expectTextContains?: string;
  /** Redaction posture for the render-validate frame (default "on"). */
  redaction?: "on" | "off";
  /** Durable run-level USD budget cap forwarded to the localize driver. */
  costCapUsd?: number;
  /** Existing paused executor run or finalizing terminal commit to resume. */
  resumeRunId?: string;
  /**
   * Optional client-side bounded-concurrency override (from `--concurrency`),
   * forwarded to the localize driver. Wins over the config's `concurrency` and
   * the executor default.
   */
  concurrency?: number;
  /** Produce a byte-preserving preview patch when draft coverage is partial. */
  allowPartialPatch?: boolean;
  io: LocalizeGameIo;
  /** Stage seams (default: the production seams). Injected for the CI test. */
  stages?: LocalizeGameStageSeams;
  log?: (message: string) => void;
};

export type LocalizeGameResult = {
  runDir: string;
  effectiveConfigPath: string;
  bridgePath: string;
  structureJsonPath: string;
  patchTargetRoot: string;
  localize: RunLocalizeFullProjectLiveResult;
  /** The validate replay-log + render-evidence artifact paths. */
  replayLogPath: string;
  renderEvidencePath: string;
};

/** Production stage seams: bind each stage to its real gated seam. */
export function defaultLocalizeGameStages(nativeCli?: NativeCliRunner): LocalizeGameStageSeams {
  return {
    extract: (args) => runKaifuuRealliveExtract(args),
    structure: (args) => runUtsushiStructureExport(args),
    localize: (args) =>
      runLocalizeFullProjectLive({
        ...args,
        ...(args.allowPartialPatch !== undefined
          ? { allowPartialPatch: args.allowPartialPatch }
          : {}),
        ...(nativeCli !== undefined ? { nativeCli } : {}),
      }),
    runNative: (bin, args) => runNativeCli(bin, args, nativeCli),
  };
}

/**
 * Run the whole extract -> structure -> localize -> patch -> validate vertical
 * as ONE command. Each stage is wrapped so a failure surfaces the failing
 * stage name + a structured diagnostic; a `PipelineFailureDiagnosticError`
 * (thrown by the localize driver) is preserved verbatim so the agent still
 * reads the one-line pipeline diagnostic.
 */
export async function runLocalizeGameCommand(
  args: RunLocalizeGameArgs,
): Promise<LocalizeGameResult> {
  const log = args.log ?? (() => {});
  const stages = args.stages ?? defaultLocalizeGameStages();

  const bridgePath = join(args.runDir, "bridge-bundle.json");
  const structureJsonPath = join(args.runDir, "structure.json");
  const effectiveConfigPath = join(args.runDir, "localize-game.config.json");
  const replayLogPath = join(args.runDir, "replay-log.json");
  const dispatchReportPath = join(args.runDir, "dispatch-report.json");
  const renderArtifactsDir = join(args.runDir, "render-artifacts");
  const renderEvidencePath = join(args.runDir, "render-evidence.json");

  const gameRoot =
    args.gameRoot ?? (args.vaultCanonicalId === undefined ? args.sourceRoot : undefined);
  // Resolve the structure/validate inputs the SAME way the extract stage
  // resolves its game root (kaifuu's `resolve_reallive_game_root` descent), so a
  // `--source` pointing at a staging parent that wraps a nested game folder
  // works for BOTH stages (issue #64 E2). Explicit `--gameexe`/`--seen` still
  // win. When no REALLIVEDATA is found the resolver falls back to
  // `<sourceRoot>/REALLIVEDATA/*` — the prior default.
  const resolvedSource = resolveRealliveSourcePaths(args.sourceRoot, args.sourceFsProbe);
  const gameexePath = args.gameexePath ?? resolvedSource.gameexePath;
  const seenPath = args.seenPath ?? resolvedSource.seenPath;
  const redaction = args.redaction ?? "on";

  // -------- Stage 1: EXTRACT the whole-Seen bridge (kaifuu extract seam) -----
  log(`[localize-game] stage 1/4 extract (whole-seen) -> ${bridgePath}`);
  const extractResult = runStage("extract", () =>
    stages.extract({
      ...(args.vaultCanonicalId !== undefined ? { vaultCanonicalId: args.vaultCanonicalId } : {}),
      ...(gameRoot !== undefined ? { gameRoot } : {}),
      gameId: args.identity.gameId,
      gameVersion: args.identity.gameVersion,
      sourceProfileId: args.identity.sourceProfileId,
      sourceLocale: args.identity.sourceLocale,
      wholeSeen: true,
      bundleOutputPath: bridgePath,
      ...(args.log !== undefined ? { log: args.log } : {}),
    }),
  );
  log(`[localize-game] stage 1/4 extract done (mode=${extractResult.mode})`);

  // -------- Stage 2: STRUCTURE export (utsushi structure seam) ---------------
  log(`[localize-game] stage 2/4 structure -> ${structureJsonPath}`);
  runStage("structure", () =>
    stages.structure({
      gameexePath,
      seenPath,
      outputPath: structureJsonPath,
      ...(args.entryScene !== undefined ? { entryScene: args.entryScene } : {}),
      ...(args.log !== undefined ? { log: args.log } : {}),
    }),
  );
  log(`[localize-game] stage 2/4 structure done`);

  // Derive the EFFECTIVE config: the base config with bridgePath +
  // structureJsonPath pointed at THIS run's fresh stage-1 / stage-2 artifacts.
  // The localize driver reads it, so it consumes exactly what we extracted —
  // never a stale path baked into the base config.
  const baseConfig = args.io.readJson(args.configPath);
  if (baseConfig === null || typeof baseConfig !== "object" || Array.isArray(baseConfig)) {
    throw new LocalizeGameStageError(
      "localize",
      `localize-game: base config at '${args.configPath}' must be a JSON object`,
      undefined,
    );
  }
  // The localize driver enforces a durable identity fence: the config's
  // `sourceRevisionId` MUST name the bridge bundle's content-hash revisionId
  // (localize-fullproject-cli `provision-project-scope`). In this whole-game
  // vertical the bridge is THIS run's fresh stage-1 extract, whose revisionId is
  // content-derived and only known after extract — a static base-config value
  // (provenance only, like `bridgePath`) can never match it. Reconcile it the
  // SAME way we reconcile `bridgePath`/`structureJsonPath`: name the revision of
  // the bridge we just produced. This keeps the fence intact (the config names
  // the actual bridge) while making the one-command vertical runnable.
  const freshBridgeRevisionId = readBridgeSourceRevisionId(args.io, bridgePath);
  const effectiveConfig = {
    ...(baseConfig as Record<string, unknown>),
    bridgePath,
    structureJsonPath,
    ...(freshBridgeRevisionId !== undefined ? { sourceRevisionId: freshBridgeRevisionId } : {}),
  };
  args.io.writeJson(effectiveConfigPath, effectiveConfig);

  // -------- Stage 3: LOCALIZE whole-game + apply byte-correct patch ----------
  log(
    `[localize-game] stage 3/4 localize (whole-game driver + patch-apply) -> target ${args.targetRoot}`,
  );
  const localize = await runStageAsync("localize", () =>
    stages.localize({
      configPath: effectiveConfigPath,
      runDir: args.runDir,
      io: args.io,
      sourceRoot: args.sourceRoot,
      patchTargetRoot: args.targetRoot,
      ...(args.resumeRunId !== undefined ? { resumeRunId: args.resumeRunId } : {}),
      ...(args.costCapUsd !== undefined ? { costCapUsd: args.costCapUsd } : {}),
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      ...(args.allowPartialPatch !== undefined
        ? { allowPartialPatch: args.allowPartialPatch }
        : {}),
      ...(args.log !== undefined ? { log: args.log } : {}),
    }),
  );
  if (localize.result.runState === "paused") {
    // Pause is nonterminal and operator-actionable, not a failed localization
    // stage. The live driver has already persisted run-summary.json with this
    // exact blocker; stop before patch/apply/validation and return it intact.
    log(
      `[localize-game] stage 3/4 paused run=${localize.result.journalRunId} blocker=${JSON.stringify(localize.result.pausedBlocker)}`,
    );
    return {
      runDir: args.runDir,
      effectiveConfigPath,
      bridgePath,
      structureJsonPath,
      patchTargetRoot: args.targetRoot,
      localize,
      replayLogPath,
      renderEvidencePath,
    };
  }
  if (
    localize.resumedFinalization === true
      ? !localize.terminalSummary.patch.playable
      : localize.patchApply === undefined
  ) {
    // The source + target are always passed here, so the driver MUST have
    // reached an applyable patch. If it did not, the vertical did not produce a
    // patched game — fail closed rather than "validate" an unpatched target.
    throw new LocalizeGameStageError(
      "localize",
      "localize-game: the localize driver did not apply a patch (no patchApply result); the target was not patched",
      undefined,
    );
  }
  if (localize.resumedFinalization === true) {
    log(
      `[localize-game] stage 3/4 finalization resumed (planned=${String(localize.terminalSummary.coverage.plannedUnitCount)} written=${String(localize.terminalSummary.coverage.writtenOutcomeCount)} patched=${args.targetRoot})`,
    );
  } else {
    log(
      `[localize-game] stage 3/4 localize done (units=${localize.result.unitsRun} written=${localize.result.writtenOutcomeCount} cost=$${localize.result.totalUsageCostExactUsd} patched=${args.targetRoot})`,
    );
  }

  // -------- Stage 4: VALIDATE the patched target (utsushi replay + render) ----
  // The kaifuu patch (stage 3) materializes ONLY the patched Seen.txt into the
  // writable target — Gameexe.ini + the g00 assets render-validate needs are NOT
  // copied into the fresh target. So (mirroring the sibling patch/validate real
  // proof, `patch-validate-cli.test.ts`) we replay + render the PATCHED target
  // Seen against the READ-ONLY SOURCE data dir for Gameexe + assets. This is the
  // genuine end-to-end validate: the localized Seen bytes, rendered with the
  // real game's Gameexe/assets, so a whole-game run patches AND validates for
  // real without needing to duplicate the game tree.
  const targetSeen = join(args.targetRoot, "REALLIVEDATA", "Seen.txt");
  // The source data dir carries Gameexe.ini + g00 assets. `seenPath` defaults to
  // `<sourceRoot>/REALLIVEDATA/Seen.txt`; its dirname is that data dir (honouring
  // an operator-supplied `--seen`/`--gameexe` override).
  const sourceGameexe = gameexePath;
  const sourceGameDir = dirname(gameexePath);
  log(`[localize-game] stage 4/4 validate (replay + render) scene=${args.validateScene}`);
  runStage("validate", () => {
    const replay = stages.runNative("utsushi-cli", [
      "replay-validate",
      "--engine",
      "reallive",
      "--seen",
      targetSeen,
      "--scene",
      args.validateScene,
      "--gameexe",
      sourceGameexe,
      "--g00-dir",
      join(sourceGameDir, "g00"),
      "--print-replay-log",
      replayLogPath,
      "--dispatch-report",
      dispatchReportPath,
      "--require-semantic-reached-path",
    ]);
    if (replay.status !== 0) {
      throw new Error(
        `utsushi replay-validate failed with status ${String(replay.status)}: ${
          replay.stderr.trim() || replay.stdout.trim() || "<no output>"
        }`,
      );
    }
    const renderArgs = [
      "render-validate",
      "--engine",
      "reallive",
      "--seen",
      targetSeen,
      "--scene",
      args.validateScene,
      "--gameexe",
      sourceGameexe,
      "--game-dir",
      sourceGameDir,
      // Pristine source Seen recovers per-speaker #NAMAE colours a dialogue-only
      // translation rewrote off the Japanese key (mirrors `itotori validate`).
      "--source-seen",
      seenPath,
      "--artifact-root",
      renderArtifactsDir,
      "--redaction",
      redaction,
      "--output",
      renderEvidencePath,
    ];
    if (args.expectTextContains !== undefined && args.expectTextContains.length > 0) {
      renderArgs.push("--expect-text-contains", args.expectTextContains);
    }
    const render = stages.runNative("utsushi-cli", renderArgs);
    if (render.status !== 0) {
      throw new Error(
        `utsushi render-validate failed with status ${String(render.status)}: ${
          render.stderr.trim() || render.stdout.trim() || "<no output>"
        }`,
      );
    }
    return render;
  });
  log(`[localize-game] stage 4/4 validate done -> ${renderEvidencePath}`);

  return {
    runDir: args.runDir,
    effectiveConfigPath,
    bridgePath,
    structureJsonPath,
    patchTargetRoot: args.targetRoot,
    localize,
    replayLogPath,
    renderEvidencePath,
  };
}

/**
 * Read the freshly-extracted bridge bundle's content-hash source revisionId so
 * the effective config can name it (the localize driver's identity fence). Best
 * effort: on any shape mismatch return `undefined` and leave the base config's
 * value in place, so the driver still surfaces its own precise fence error
 * rather than this command guessing.
 */
function readBridgeSourceRevisionId(io: LocalizeGameIo, bridgePath: string): string | undefined {
  let bridge: unknown;
  try {
    bridge = io.readJson(bridgePath);
  } catch {
    return undefined;
  }
  if (bridge === null || typeof bridge !== "object") {
    return undefined;
  }
  const revision = (bridge as Record<string, unknown>).sourceBundleRevision;
  if (revision === null || typeof revision !== "object") {
    return undefined;
  }
  const revisionId = (revision as Record<string, unknown>).revisionId;
  return typeof revisionId === "string" && revisionId.length > 0 ? revisionId : undefined;
}

/**
 * Run one synchronous stage, wrapping any thrown error as a
 * {@link LocalizeGameStageError} tagged with the failing stage. A
 * `PipelineFailureDiagnosticError` is preserved as the cause so its structured
 * diagnostic (step + inputs + repro) survives — the message surfaces its
 * one-line render so an agent reads the pipeline diagnostic inline.
 */
function runStage<T>(stage: LocalizeGameStage, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw toStageError(stage, error);
  }
}

async function runStageAsync<T>(stage: LocalizeGameStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toStageError(stage, error);
  }
}

function toStageError(stage: LocalizeGameStage, error: unknown): LocalizeGameStageError {
  if (error instanceof LocalizeGameStageError) {
    return error;
  }
  if (error instanceof PipelineFailureDiagnosticError) {
    return new LocalizeGameStageError(
      stage,
      `localize-game stage '${stage}' failed: ${renderPipelineFailureDiagnosticOneLine(
        error.diagnostic,
      )}`,
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LocalizeGameStageError(
    stage,
    `localize-game stage '${stage}' failed: ${message}`,
    error,
  );
}
