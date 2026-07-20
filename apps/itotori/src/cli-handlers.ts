import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertConformanceManifestV01,
  assertConformanceResultV01,
  assertPatchResultV02,
  assertRuntimeReport,
  ITOTORI_PRODUCT_VERSION,
  type ConformanceManifestV01,
  type ConformanceResultV01,
} from "@itotori/localization-bridge-schema";
import { capabilityLevelValues, createCatalogResolverFixtureArtifact } from "@itotori/db";
import type {
  AdapterCapabilityMatrixRecord,
  CapabilityLevel,
  CatalogExactExternalIdLinkRequest,
  CatalogFuzzyCandidateRequest,
  CatalogResolverFixtureInput,
  ItotoriCatalogExactExternalIdLinkerPort,
  ItotoriCatalogFuzzyCandidateGeneratorPort,
} from "@itotori/db";
import type { EngineCapabilityReportPort } from "./services/engine-capability-report.js";
import { configuredServicePort } from "./services/configured-port.js";
import { runAssetDecisionsList, type AssetDecisionsCliPort } from "./asset-decisions/cli.js";
import { runQueueHealthCli, type QueueHealthCliPort } from "./queue/cli.js";
import type { ItotoriProjectWorkflowPort } from "./services/project-operations-port.js";
import type { ProjectState } from "./services/project-types.js";
import { assertOpenRouterZdrAccount } from "./zdr-admission/account-zdr.js";
import { loadExternalEnvFile } from "./env/external-env-file.js";
import {
  extractCapabilities,
  resolveExtractAdapter,
  runKaifuuExtract,
} from "./extract/kaifuu-extract-seam.js";
import { scanCatalogLocalRoot } from "./services/catalog-local-scan.js";
import {
  runUtsushiStructureExport,
  type RunUtsushiStructureResult,
} from "./structure-export/utsushi-structure-seam.js";
import { runNativeCli, type NativeCliRunner } from "./native-bin/cli-bin-resolver.js";
import { buildHelpText } from "./help-text.js";
import { runInitCommand, type InitCommandDeps } from "./init-command.js";
import { optionalFlag, requiredFlag } from "./cli/flags.js";
import { runPatchbackProduceCommand } from "./patchback/produce-cli.js";
// The kept localize / wiki / patch-play commands route ONLY through these thin
// new-pipeline command handlers. Each has a clean transitive import closure (no
// edge to the legacy service graph — proven by composition-reachability); the live
// substrate they drive is injected through the ports below, never imported here on
// their behalf.
import { runLocalizeCommand } from "./cli/localize-command.js";
import { runWikiCommand } from "./cli/wiki-command.js";
import { runPlayCommand } from "./cli/play-command.js";
import type {
  LocalizationPerRunInput,
  LocalizationPortSource,
  SourceWikiRunReport,
  WikiBuildInvocation,
} from "./composition/index.js";
import type { RunPolicyRequest } from "./run-policy/index.js";
import type { PlayEntrypointDeps } from "./composition/play-entrypoint.js";
import type { WikiObjectApiService } from "./wiki/object-api/index.js";

export type JsonFileStore = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
  /**
   * Persist a UTF-8 text artifact (e.g. the README-safe Markdown summary). The
   * real CLI store implements it; an in-memory test store may omit it, in which
   * case a handler that needs it throws a clear error rather than silently
   * dropping the artifact.
   */
  writeText?(path: string, contents: string): void;
};

export type ItotoriCliServices = {
  projectWorkflow: ItotoriProjectWorkflowPort;
  catalogExactExternalIdLinker: ItotoriCatalogExactExternalIdLinkerPort;
  catalogFuzzyCandidateGenerator: ItotoriCatalogFuzzyCandidateGeneratorPort;
  engineCapabilityReports: EngineCapabilityReportPort;
  /**
   * Optional so unit suites can omit it. The CLI commands
   * `itotori:asset-decisions-list` requires it at runtime.
   */
  assetDecisions?: AssetDecisionsCliPort;
  /**
   * ITOTORI-047 — queue-health read-model loader powering the
   * `queue-health` CLI command. Optional so unit suites that don't exercise
   * the queue command can omit it; the CLI handler raises a typed error when
   * missing.
   */
  queueHealth?: QueueHealthCliPort;
  /**
   * The `wiki` object's installed-bible API. Optional so unit suites that do not
   * exercise it can omit it; production binds the DB-backed service.
   */
  wikiObjectApi?: WikiObjectApiService;
  /** The production source-Wiki analyst-wave assembler. It is separate from the
   * object API: `wiki build` writes source objects through the repository ledger. */
  wikiBuild?: {
    run(input: WikiBuildInvocation): Promise<SourceWikiRunReport>;
  };
  /**
   * The kept `localize` command's new-pipeline substrate: resolve the live
   * `WorkflowPortDeps` (or fake ports for a proof) for one run policy. Production
   * assembles it from `composition/live`; the remaining role-input assemblers over
   * the decode facts + installed bible are a substrate seam not yet wired into the
   * live factory (flagged). Optional so unit suites can omit it; the handler
   * refuses loudly when it is missing — it never routes to the old service.
   */
  localizationSubstrate?: {
    resolvePortSource(
      request: RunPolicyRequest,
      perRun: LocalizationPerRunInput,
    ): LocalizationPortSource | Promise<LocalizationPortSource>;
  };
  /**
   * The kept `patch play` command's new-pipeline substrate: the exact-surface
   * loader + Utsushi runtime launcher the composition `runPlaySession` drives. The
   * live factory wires it from the localization-iteration surface read + the real
   * `UtsushiPatchRuntimeLauncher` (no journal reservation/finalizer). Optional so
   * unit suites can omit it; the handler refuses loudly when it is missing.
   */
  patchPlay?: PlayEntrypointDeps;
};

export type ItotoriCliDependencies = {
  io: JsonFileStore;
  migrateDatabase(): Promise<void>;
  resetDatabase(): Promise<void>;
  withServices<T>(callback: (services: ItotoriCliServices) => Promise<T>): Promise<T>;
  nativeCli?: NativeCliRunner;
  /**
   * Optional override for the `itotori init` guided-setup dependencies.
   * In production the CLI constructs real readline/fs deps; tests inject
   * a mock to avoid interactive I/O.
   */
  initDeps?: InitCommandDeps;
};

export async function runItotoriCliCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // Load allowlisted live-provider vars from a caller-specified external
  // env-file (via `--env-file` or `ITOTORI_LOCAL_ENV_FILE`) BEFORE any command
  // handler reads process.env / constructs a provider — and BEFORE the
  // `--version` early return, so a specified-but-unreadable file FAILS LOUD
  // consistently regardless of the command (a bad --env-file is never silently
  // ignored by an early-return path). Precedence: an already-exported var wins;
  // only the allowlist loads. Values are never logged — only applied var NAMES.
  const envFileResult = loadExternalEnvFile({ args, env: process.env });
  if (envFileResult.path !== undefined && envFileResult.appliedKeys.length > 0) {
    process.stderr.write(
      `loaded ${envFileResult.appliedKeys.length} allowlisted var(s) from env file ` +
        `'${envFileResult.path}': ${envFileResult.appliedKeys.join(", ")}\n`,
    );
  }
  if (args.includes("--help") || args.includes("-h")) {
    const allCommands = args.includes("--all");
    process.stdout.write(`${buildHelpText(allCommands)}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`itotori ${ITOTORI_PRODUCT_VERSION}\n`);
    return;
  }
  const command = args[0];
  switch (command) {
    case "db-migrate":
      await dependencies.migrateDatabase();
      break;
    case "db-reset":
      await dependencies.resetDatabase();
      break;
    case "dashboard-status":
      await runDashboardStatus(args, dependencies);
      break;
    case "localize":
      await runLocalize(args, dependencies);
      break;
    case "extract":
      await runExtract(args, dependencies);
      break;
    case "patch":
      await runPatchCommand(args, dependencies);
      break;
    case "validate":
      await runValidateCommand(args, dependencies);
      break;
    case "ingest-runtime":
      await runIngestRuntime(args, dependencies);
      break;
    case "ingest-patch-result":
      await runIngestPatchResult(args, dependencies);
      break;
    case "ingest-conformance":
      await runIngestConformance(args, dependencies);
      break;
    case "catalog-link-exact":
      await runCatalogLinkExact(args, dependencies);
      break;
    case "catalog-fuzzy-candidates":
      await runCatalogFuzzyCandidates(args, dependencies);
      break;
    case "catalog-resolve-fixture":
      await runCatalogResolveFixture(args, dependencies);
      break;
    case "catalog-local-corpus-scan":
    case "catalog-local-scan":
      await runCatalogLocalScan(args, dependencies);
      break;
    case "engine-capabilities-record":
      await runEngineCapabilitiesRecord(args, dependencies);
      break;
    case "engine-capabilities-list":
      await runEngineCapabilitiesList(args, dependencies);
      break;
    case "asset-decisions-list":
      await runAssetDecisionsListHandler(args, dependencies);
      break;
    case "structure-export":
      await runStructureExportHandler(args, dependencies);
      break;
    case "queue-health":
      await runQueueHealthHandler(args, dependencies);
      break;
    case "wiki":
      await runWiki(args, dependencies);
      break;
    case "help":
      process.stdout.write(`${buildHelpText(args.includes("--all"))}\n`);
      break;
    case "init":
      await runInitHandler(args, dependencies);
      break;
    default:
      throw new Error(`unknown itotori command: ${String(command)}`);
  }
}

async function runPatchCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  // Node 11 keeps the historical native `itotori patch --bundle ...` path
  // intact, while giving accepted-output patched builds and versioned patches
  // their own first-class surfaces. Branch before parsing native-patch flags so
  // neither command falls through to the historical Kaifuu wrapper.
  switch (args[1]) {
    case "produce":
      runPatchProduce(args, dependencies);
      return;
    case "play":
      await runPlay(args, dependencies);
      return;
  }
  const sourceRoot = requiredFlag(args, "--source");
  const targetRoot = requiredFlag(args, "--target");
  const bundlePath = requiredFlag(args, "--bundle");
  const scope = requiredFlag(args, "--scope");
  if (scope !== "dialogue-only" && scope !== "dialogue+choices") {
    throw new Error(
      `itotori patch: --scope must be 'dialogue-only' or 'dialogue+choices', got '${scope}'`,
    );
  }
  const nativeArgs = [
    "patch",
    "--engine",
    "reallive",
    "--bundle",
    bundlePath,
    "--source",
    sourceRoot,
    "--target",
    targetRoot,
    "--scope",
    scope,
  ];
  if (args.includes("--force")) {
    nativeArgs.push("--force");
  }
  runNativeCommandOrThrow("patch", "kaifuu-cli", nativeArgs, dependencies.nativeCli);
}

/**
 * `itotori patch produce --input <native-patchback-input.json> --source <ro-game>
 *   --build-root <owned-rw-dir> --scope dialogue-only|dialogue+choices --output <receipt.json>`
 *
 * A persistent-build front door over the exact same accepted-output-native
 * producer used by POST /api/patchback/produce. `--build-root` deliberately
 * remains on disk (unlike the HTTP service's temporary root) so the caller owns
 * the real patched game tree named by the receipt's `patchTarget` artifact.
 */
function runPatchProduce(args: string[], dependencies: ItotoriCliDependencies): void {
  const scope = requiredFlag(args, "--scope");
  const runId = optionalFlag(args, "--run-id");
  if (scope !== "dialogue-only" && scope !== "dialogue+choices") {
    throw new Error(
      `itotori patch produce: --scope must be 'dialogue-only' or 'dialogue+choices', got '${scope}'`,
    );
  }
  const receipt = runPatchbackProduceCommand({
    inputPath: requiredFlag(args, "--input"),
    outputPath: requiredFlag(args, "--output"),
    sourceRoot: requiredFlag(args, "--source"),
    buildRoot: requiredFlag(args, "--build-root"),
    scope,
    ...(runId === undefined ? {} : { runId }),
    ...(args.includes("--force") ? { force: true } : {}),
    ...(dependencies.nativeCli === undefined ? {} : { nativeCli: dependencies.nativeCli }),
    log: (message) => process.stderr.write(`${message}\n`),
    io: {
      readJson: (path) => dependencies.io.readJson(path),
      writeJson: (path, value) => dependencies.io.writeJson(path, value),
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        capabilityId: receipt.capabilityId,
        patchVersionId: receipt.patch.patchVersionId,
        patchTarget: receipt.patch.artifactRefs.patchTarget,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * `itotori patch play <version> [--launch-json <object>] [--output <json>]`
 *
 * The new-pipeline path: load the exact hash-bound play surface and launch it
 * through Utsushi's real replay runtime via the composition `runPlaySession`
 * entrypoint. It reaches ONLY the new play launcher — never the legacy
 * `PatchIterationService.play` journal reservation/finalizer path. The live
 * surface loader + launcher are injected through `services.patchPlay`.
 */
async function runPlay(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  await dependencies.withServices(async (services) => {
    const playDeps = configuredServicePort(services, "patchPlay");
    if (playDeps === undefined) {
      throw new Error(
        "patch play is not configured in this CLI build (patchPlay port missing — the new-pipeline surface loader + runtime launcher are not installed)",
      );
    }
    await runPlayCommand(args, {
      io: { writeJson: (path, value) => dependencies.io.writeJson(path, value) },
      resolvePlayDeps: () => playDeps,
    });
  });
}

async function runValidateCommand(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const seenPath = requiredFlag(args, "--seen");
  const scene = requiredFlag(args, "--scene");
  const replayLogPath = requiredFlag(args, "--replay-log");
  const gameexePath = requiredFlag(args, "--gameexe");
  const gameDir = requiredFlag(args, "--game-dir");
  const artifactRoot = requiredFlag(args, "--artifact-root");
  const renderOutputPath = requiredFlag(args, "--render-output");
  const redaction = optionalFlag(args, "--redaction") ?? "on";
  if (redaction !== "on" && redaction !== "off") {
    throw new Error(`itotori validate: --redaction must be 'on' or 'off', got '${redaction}'`);
  }

  const replayArgs = [
    "replay-validate",
    "--engine",
    "reallive",
    "--seen",
    seenPath,
    "--scene",
    scene,
    "--gameexe",
    gameexePath,
    "--g00-dir",
    join(gameDir, "g00"),
    "--print-replay-log",
    replayLogPath,
    "--dispatch-report",
    `${replayLogPath}.dispatch.json`,
    "--require-semantic-reached-path",
  ];
  if (args.includes("--print-textlines")) {
    replayArgs.push("--print-textlines");
  }
  runNativeCommandOrThrow("validate replay", "utsushi-cli", replayArgs, dependencies.nativeCli);

  const renderArgs = [
    "render-validate",
    "--engine",
    "reallive",
    "--seen",
    seenPath,
    "--scene",
    scene,
    "--gameexe",
    gameexePath,
    "--game-dir",
    gameDir,
    "--artifact-root",
    artifactRoot,
    "--redaction",
    redaction,
    "--output",
    renderOutputPath,
  ];
  appendOptionalFlag(renderArgs, args, "--source-seen");
  appendOptionalFlag(renderArgs, args, "--bg-asset");
  appendOptionalFlag(renderArgs, args, "--private-artifact-root");
  appendOptionalFlag(renderArgs, args, "--run-id");
  appendOptionalFlag(renderArgs, args, "--expect-text-contains");
  appendOptionalFlag(renderArgs, args, "--width");
  appendOptionalFlag(renderArgs, args, "--height");
  runNativeCommandOrThrow("validate render", "utsushi-cli", renderArgs, dependencies.nativeCli);
}

function runNativeCommandOrThrow(
  commandName: string,
  bin: "kaifuu-cli" | "utsushi-cli",
  args: string[],
  nativeCli: NativeCliRunner | undefined,
): void {
  const result = runNativeCli(bin, args, nativeCli);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "<no output>";
    throw new Error(
      `itotori ${commandName}: ${bin} failed with status ${String(result.status)}: ${detail}`,
    );
  }
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
}

async function runDashboardStatus(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const status = await dependencies.withServices((services) =>
    services.projectWorkflow.getDashboardStatus(),
  );
  dependencies.io.writeJson(outputPath, status);
}

/**
 * visual-inspection-gate-for-all-render-nodes — the eyes-on-pixels
 * enforcement step every render/screenshot node runs on its emitted proof
 * frame. Sends the frame to a ZDR-routed OpenRouter VISION model, records the
 * structured verdict alongside render-evidence, and EXITS NONZERO when the
 * verdict marks the frame incoherent / target-text-illegible / redaction-
 * wrong. Live only (`ITOTORI_VISION_GATE_LIVE=1` + exported OpenRouter key +
 * account ZDR assertion); a non-live invocation is reported as `skipped`.
 *
 * Flags:
 *   --frame <png>              rendered proof-frame PNG (required)
 *   --expected-text <s>        localized target text expected in the frame
 *   --expected-text-file <p>   ...or read it from a file (model input only)
 *   --redaction on|off         the frame's redaction posture (required)
 *   --classification <c>       provider input classification (default private_corpus)
 *   --verdict-out <json>       write the verdict artifact here (private/uncommitted)
 */

/**
 * itotori-structure-export — the user-shaped front-door over the UTSUSHI-side
 * narrative-structure producer (`utsushi structure`). Wraps the utsushi-cli
 * binary so the structure-informed context the whole-game localize driver
 * (`itotori localize`) consumes is a first-class itotori command, not a
 * foreign Rust bin.
 *
 * Required flags (no defaulting):
 *   --gameexe <PATH>   Gameexe.ini (resolves `SEEN_START` + `#NAMAE`)
 *   --seen <PATH>      Seen.txt compressed scene archive
 *   --output <PATH>    where the structure JSON is written (outside the repo;
 *                      carries copyrighted script text on real bytes)
 * Optional:
 *   --bridge <PATH>     exact Kaifuu bridge; enables evidence-complete v2
 *   --entry-scene <N>  override the `SEEN_START` entry scene (a route-specific
 *                      opening, etc.); drives the dispatch-order walk from it
 *   --max-scenes <N>   fail when the archive exceeds N scenes
 *
 * The producer owns its own JSON write; a non-zero exit surfaces its stderr
 * verbatim (already prefixed `utsushi.structure.<step>:`) through a typed
 * `UtsushiStructureExportError`.
 */
async function runStructureExportHandler(
  args: string[],
  _dependencies: ItotoriCliDependencies,
): Promise<void> {
  const gameexePath = requiredFlag(args, "--gameexe");
  const seenPath = requiredFlag(args, "--seen");
  const outputPath = requiredFlag(args, "--output");
  const bridgePath = optionalFlag(args, "--bridge");
  const entrySceneRaw = optionalFlag(args, "--entry-scene");
  const maxScenesRaw = optionalFlag(args, "--max-scenes");

  let entryScene: number | undefined;
  if (entrySceneRaw !== undefined) {
    const parsed = Number.parseInt(entrySceneRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== entrySceneRaw) {
      throw new Error(
        `structure-export refused: --entry-scene '${entrySceneRaw}' must be a non-negative integer`,
      );
    }
    entryScene = parsed;
  }

  let maxScenes: number | undefined;
  if (maxScenesRaw !== undefined) {
    const parsed = Number.parseInt(maxScenesRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== maxScenesRaw) {
      throw new Error(
        `structure-export refused: --max-scenes '${maxScenesRaw}' must be a positive integer`,
      );
    }
    maxScenes = parsed;
  }

  const result: RunUtsushiStructureResult = runUtsushiStructureExport({
    gameexePath,
    seenPath,
    outputPath,
    ...(bridgePath !== undefined ? { bridgePath } : {}),
    ...(entryScene !== undefined ? { entryScene } : {}),
    ...(maxScenes !== undefined ? { maxScenes } : {}),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion:
          bridgePath === undefined
            ? "utsushi.narrative-structure.v1"
            : "utsushi.narrative-structure.v2",
        outputPath,
        status: result.status,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * `itotori localize` drives the new pipeline from a fresh run request. Restart
 * durability is provided by the workflow's missing-artifact query, rather than
 * by the retired durable-journal resume path.
 */
async function runLocalize(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  await dependencies.withServices(async (services) => {
    const substrate = configuredServicePort(services, "localizationSubstrate");
    if (substrate === undefined) {
      throw new Error(
        "localize is not configured in this CLI build (localizationSubstrate port missing — the new-pipeline WorkflowPortDeps assemblers are not installed)",
      );
    }
    await runLocalizeCommand(args, {
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      resolvePortSource: (request, perRun) => substrate.resolvePortSource(request, perRun),
    });
  });
}

/**
 * itotori-cli-extract-command (P1, user-shaped CLI) — the user-shaped bridge
 * producer. Wraps `kaifuu-cli extract --engine <engine>` so a user/agent
 * produces the BridgeBundle `itotori localize` consumes WITHOUT knowing about
 * the Rust binary. The REQUIRED `--engine` flag selects the adapter from the
 * extract-adapter registry; every engine goes through the SAME extract seam and
 * the registry owns its per-engine flag parsing, so this handler carries NO
 * per-engine branch and an unregistered `--engine` is rejected at the boundary.
 * The wired adapters (their flags + modes) are self-described by the registry's
 * capabilities. kaifuu writes the bridge directly to `--bundle-output`; this
 * handler does NOT touch bridge bytes.
 */
async function runExtract(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  // The dispatcher contract is (args, dependencies); extract delegates to a
  // kaifuu-cli subprocess and does not touch the file store or services, so
  // `dependencies` is intentionally unused here.
  void dependencies;
  const engineRaw = optionalFlag(args, "--engine");
  if (engineRaw === undefined) {
    const available = extractCapabilities()
      .map((capability) => capability.engine)
      .join(", ");
    throw new Error(
      `extract refused: --engine <engine> is required (registered adapters: ${available})`,
    );
  }
  // resolveExtractAdapter rejects an unregistered engine at the boundary; the
  // adapter then parses its OWN flags into a typed source (no per-engine branch
  // here). The registry guarantees the parsed source matches `--engine`.
  const adapter = resolveExtractAdapter(engineRaw);
  const source = adapter.parseCli(args);
  const bundleOutputPath = requiredFlag(args, "--bundle-output");

  const result = runKaifuuExtract({
    ...source,
    bundleOutputPath,
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        engine: result.engine,
        mode: result.mode,
        bundleOutputPath: result.bundleOutputPath,
        status: result.status,
      },
      null,
      2,
    )}\n`,
  );
}

async function runIngestRuntime(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const runtimeReportPath = requiredFlag(args, "--runtime-report");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const report = dependencies.io.readJson(runtimeReportPath);
  assertRuntimeReport(report);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestRuntimeReport(project, report),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.result);
}

async function runIngestPatchResult(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const patchResultPath = requiredFlag(args, "--patch-result");
  const outputPath = requiredFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const patchResult = dependencies.io.readJson(patchResultPath);
  assertPatchResultV02(patchResult);
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestPatchResult(project, patchResult),
  );
  dependencies.io.writeJson(projectPath, result.project);
  dependencies.io.writeJson(outputPath, result.result);
}

async function runIngestConformance(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectPath = requiredFlag(args, "--project");
  const reportPath = requiredFlag(args, "--report-file");
  const manifestPath = optionalFlag(args, "--manifest-file");
  const outputPath = optionalFlag(args, "--output");
  const project = readProject(dependencies.io, projectPath);
  const reportPayload = dependencies.io.readJson(reportPath);
  const results: ConformanceResultV01[] = Array.isArray(reportPayload)
    ? reportPayload.map((entry) => {
        assertConformanceResultV01(entry);
        return entry;
      })
    : (() => {
        assertConformanceResultV01(reportPayload);
        return [reportPayload];
      })();
  let manifest: ConformanceManifestV01 | undefined;
  if (manifestPath !== undefined) {
    const manifestPayload = dependencies.io.readJson(manifestPath);
    assertConformanceManifestV01(manifestPayload);
    manifest = manifestPayload;
  }
  const result = await dependencies.withServices((services) =>
    services.projectWorkflow.ingestConformanceReport(project, {
      results,
      ...(manifest === undefined ? {} : { manifest }),
    }),
  );
  dependencies.io.writeJson(projectPath, result.project);
  if (outputPath !== undefined) {
    dependencies.io.writeJson(outputPath, result.result);
  }
}

async function runCatalogLinkExact(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogExactExternalIdLinkRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogExactExternalIdLinker.linkExactExternalIds(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runCatalogFuzzyCandidates(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const requestPath = requiredFlag(args, "--request");
  const outputPath = requiredFlag(args, "--output");
  const request = dependencies.io.readJson(requestPath) as CatalogFuzzyCandidateRequest;
  const result = await dependencies.withServices((services) =>
    services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates(request),
  );
  dependencies.io.writeJson(outputPath, result);
}

async function runCatalogResolveFixture(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const fixturePath = optionalFlag(args, "--fixture") ?? "fixtures/catalog-resolver/fixture.json";
  const outputPath =
    optionalFlag(args, "--output") ?? "artifacts/catalog/resolver-integration.json";
  const fixture = dependencies.io.readJson(fixturePath) as CatalogResolverFixtureInput;
  const artifact = createCatalogResolverFixtureArtifact(fixture);
  dependencies.io.writeJson(outputPath, artifact);
}

async function runCatalogLocalScan(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const rootPath = requiredFlag(args, "--root");
  const outputPath = requiredFlag(args, "--output");
  const rootLabel = optionalFlag(args, "--root-label");
  const ownedRaw = optionalFlag(args, "--owned");
  const maxDepthRaw = optionalFlag(args, "--max-depth");
  const hashKey = optionalFlag(args, "--hash-key") ?? process.env.ITOTORI_LOCAL_CORPUS_HASH_KEY;
  const report = await scanCatalogLocalRoot({
    rootPath,
    ...(rootLabel === undefined ? {} : { rootLabel }),
    ...(ownedRaw === undefined ? {} : { owned: parseBooleanFlag(ownedRaw, "--owned") }),
    ...(maxDepthRaw === undefined
      ? {}
      : { maxDepth: parseNonNegativeInteger(maxDepthRaw, "--max-depth") }),
    ...(hashKey === undefined ? {} : { hashKey }),
  });
  dependencies.io.writeJson(outputPath, report);
}

async function runInitHandler(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  const initDeps: InitCommandDeps = dependencies.initDeps ?? constructDefaultInitDeps(dependencies);
  await runInitCommand(args, initDeps);
}

function constructDefaultInitDeps(dependencies: ItotoriCliDependencies): InitCommandDeps {
  void dependencies;
  return {
    env: process.env,
    existsPath: (path) => existsSync(path),
    writeText: (path, contents, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: mode ?? 0o600 });
      if (mode !== undefined) {
        chmodSync(path, mode);
      }
    },
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    defaultDatabaseUrl: () => defaultLocalDatabaseUrl(process.env),
    provisionDatabase: async (databaseUrl) => provisionLocalPostgresContainer(databaseUrl),
  };
}

function defaultLocalDatabaseUrl(env: Record<string, string | undefined>): string {
  const port = env.ITOTORI_DB_HOST_PORT ?? String(deriveLocalDatabasePort(env));
  return `postgres://itotori:itotori@127.0.0.1:${port}/itotori`;
}

function deriveLocalDatabasePort(env: Record<string, string | undefined>): number {
  const base = parsePort(env.ITOTORI_DB_HOST_PORT_BASE ?? "56000", "ITOTORI_DB_HOST_PORT_BASE");
  const span = parsePort(env.ITOTORI_DB_HOST_PORT_SPAN ?? "2000", "ITOTORI_DB_HOST_PORT_SPAN");
  if (base + span - 1 > 65535) {
    throw new Error("ITOTORI_DB_HOST_PORT_SPAN must keep the derived port range within 1..65535");
  }
  return base + (stableNumber(resolveWorktreeRoot(env)) % span);
}

function resolveWorktreeRoot(env: Record<string, string | undefined>): string {
  if (env.ITOTORI_DB_WORKTREE_ROOT !== undefined && env.ITOTORI_DB_WORKTREE_ROOT.length > 0) {
    return env.ITOTORI_DB_WORKTREE_ROOT;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top.length > 0) {
      return top;
    }
  } catch {
    // Installed packages and non-git directories use the current directory.
  }
  return process.cwd();
}

function stableNumber(root: string): number {
  return Number.parseInt(
    createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 12),
    16,
  );
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function provisionLocalPostgresContainer(databaseUrl: string): { ok: boolean; message: string } {
  const runtime = firstRunnableCommand(["docker", "podman"]);
  if (runtime === undefined) {
    return {
      ok: false,
      message:
        "Could not auto-start local Postgres because Docker/Podman is unavailable. " +
        "Install Docker/Podman, set DATABASE_URL for a system Postgres, or set ITOTORI_POSTGRES_BIN_DIR.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return {
      ok: false,
      message: "Could not auto-start local Postgres because DATABASE_URL is invalid.",
    };
  }

  const port = parsed.port || "5432";
  const user = decodeURIComponent(parsed.username || "itotori");
  const password = decodeURIComponent(parsed.password || "itotori");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, "") || "itotori");
  const containerName = `itotori-postgres-${port}-${safeContainerSuffix(
    basename(resolveWorktreeRoot(process.env)),
  )}`;

  const start = spawnSync(runtime, ["start", containerName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (start.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started existing local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started existing local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }

  let envFilePath: string;
  try {
    envFilePath = writePostgresContainerEnvFile({ user, password, database });
  } catch (error) {
    return {
      ok: false,
      message: `Could not auto-start local Postgres because DATABASE_URL contains an unsupported credential value: ${errorMessage(
        error,
      )}`,
    };
  }

  const run = spawnSync(
    runtime,
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--env-file",
      envFilePath,
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:18",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  removeSensitiveFile(envFilePath);
  if (run.status === 0) {
    return waitForLocalPostgresReady(runtime, containerName, user, database, {
      readyMessage: `Started local Postgres container ${containerName}; Postgres is ready for migrations.`,
      timeoutMessage: `Started local Postgres container ${containerName}, but Postgres did not become ready for migrations.`,
    });
  }

  const detail = (run.stderr || run.stdout || "unknown container runtime error").trim();
  return {
    ok: false,
    message: `Could not auto-start local Postgres with ${runtime}: ${detail}`,
  };
}

function writePostgresContainerEnvFile(input: {
  user: string;
  password: string;
  database: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "itotori-postgres-env-"));
  const path = join(dir, "postgres.env");
  const contents = [
    envFileLine("POSTGRES_USER", input.user),
    envFileLine("POSTGRES_PASSWORD", input.password),
    envFileLine("POSTGRES_DB", input.database),
    "",
  ].join("\n");
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function envFileLine(name: string, value: string): string {
  if (value.includes("\r") || value.includes("\n") || value.includes(String.fromCharCode(0))) {
    throw new Error(`${name} may not contain newline or NUL characters`);
  }
  return `${name}=${value}`;
}

function removeSensitiveFile(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

function waitForLocalPostgresReady(
  runtime: string,
  containerName: string,
  user: string,
  database: string,
  messages: { readyMessage: string; timeoutMessage: string },
): { ok: boolean; message: string } {
  const timeoutMs = parseReadyTimeoutMs(process.env.ITOTORI_DB_READY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "readiness query did not succeed";
  do {
    const ready = spawnSync(
      runtime,
      [
        "exec",
        containerName,
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "select 1"',
        "itotori-postgres-ready",
        user,
        database,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (ready.status === 0) {
      return { ok: true, message: messages.readyMessage };
    }
    lastDetail = (ready.stderr || ready.stdout || lastDetail).trim();
    sleepSync(250);
  } while (Date.now() < deadline);

  return {
    ok: false,
    message: `${messages.timeoutMessage} Last readiness check: ${lastDetail}`,
  };
}

function parseReadyTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return 30_000;
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return 30_000;
  }
  return timeoutMs;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstRunnableCommand(commands: string[]): string | undefined {
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      return command;
    }
  }
  return undefined;
}

function safeContainerSuffix(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gu, "-")
    .replace(/^[^a-z0-9]+/u, "");
  return safe.length > 0 ? safe : "local";
}

function appendOptionalFlag(target: string[], source: string[], name: string): void {
  const value = optionalFlag(source, name);
  if (value !== undefined) {
    target.push(name, value);
  }
}

function parseBooleanFlag(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Parse the optional `--concurrency <N>` flag: a client-side bounded-concurrency
 * override for the whole-game localize driver. Returns undefined when absent (the
 * driver falls back to the config value, then DEFAULT_DRIVEN_CONCURRENCY).
 * Must be an integer in the safe operator range, so invalid requests are refused
 * loudly rather than changing the requested concurrency.
 */
export const MAX_LOCALIZE_CONCURRENCY = 16;

export class ConcurrencyFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyFlagError";
  }
}

export function parseConcurrencyFlag(args: string[]): number | undefined {
  const index = args.indexOf("--concurrency");
  if (index < 0) {
    return undefined;
  }

  const raw = args[index + 1];
  if (raw === undefined || raw.length === 0 || raw.startsWith("--")) {
    const receivedValue = raw === undefined ? "<missing>" : `'${raw}'`;
    throw new ConcurrencyFlagError(
      `--concurrency requires a positive integer value in the valid range [1, ${MAX_LOCALIZE_CONCURRENCY}]; got ${receivedValue}`,
    );
  }

  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== raw ||
    parsed < 1 ||
    parsed > MAX_LOCALIZE_CONCURRENCY
  ) {
    throw new ConcurrencyFlagError(
      `--concurrency '${raw}' must be a positive integer in the valid range [1, ${MAX_LOCALIZE_CONCURRENCY}]`,
    );
  }
  return parsed;
}

function readProject(io: JsonFileStore, path: string): ProjectState {
  return io.readJson(path) as ProjectState;
}

// Helper used internally during the legacy CLI bridging so unused-import lints
// pass while the resolveSceneSummaryProvider symbol stays public for embedders.

// KAIFUU-053: CLI commands for the capability-leveled engine detector
// registry. `engine-capabilities-record` upserts one adapter's matrix
// from a JSON file (used to import what `EngineAdapter::capabilities()`
// produced upstream); `engine-capabilities-list` writes a JSON report
// the dashboard and any wrapping tooling can render (the engine-capability
// matrix is exposed via the `/api/*` layer the React SPA consumes).
async function runEngineCapabilitiesRecord(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const matrixPath = requiredFlag(args, "--matrix");
  const matrix = dependencies.io.readJson(matrixPath);
  assertAdapterCapabilityMatrixRecord(matrix);
  await dependencies.withServices((services) =>
    services.engineCapabilityReports.recordMatrix(matrix),
  );
}

async function runEngineCapabilitiesList(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const levelRaw = optionalFlag(args, "--level");
  const level = levelRaw === undefined ? undefined : asCapabilityLevel(levelRaw);
  const result = await dependencies.withServices(async (services) => {
    const summaries = await services.engineCapabilityReports.listAdapterSummaries();
    if (level === undefined) {
      return { adapters: summaries };
    }
    const supporting = await services.engineCapabilityReports.adaptersSupporting(level);
    const supportingSet = new Set(supporting);
    return {
      adapters: summaries,
      level,
      adaptersSupporting: supporting,
      identifyOnlyAdapterIds: summaries
        .filter((summary) => !supportingSet.has(summary.adapterId))
        .map((summary) => summary.adapterId),
    };
  });
  dependencies.io.writeJson(outputPath, result);
}

function asCapabilityLevel(value: string): CapabilityLevel {
  switch (value) {
    case capabilityLevelValues.identify:
    case capabilityLevelValues.inventory:
    case capabilityLevelValues.extract:
    case capabilityLevelValues.patch:
      return value;
    default:
      throw new Error(`unknown capability level: ${value}`);
  }
}

function assertAdapterCapabilityMatrixRecord(
  value: unknown,
): asserts value is AdapterCapabilityMatrixRecord {
  if (!value || typeof value !== "object") {
    throw new Error("AdapterCapabilityMatrix payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.adapterId !== "string" || record.adapterId.length === 0) {
    throw new Error("AdapterCapabilityMatrix.adapterId must be a non-empty string");
  }
  for (const level of [
    capabilityLevelValues.identify,
    capabilityLevelValues.inventory,
    capabilityLevelValues.extract,
    capabilityLevelValues.patch,
  ]) {
    assertCapabilityLevelStatus(record[level], `AdapterCapabilityMatrix.${level}`);
  }
}

function assertCapabilityLevelStatus(value: unknown, label: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "supported":
      return;
    case "partial":
      if (!Array.isArray(record.limitations) || record.limitations.length === 0) {
        throw new Error(`${label}.limitations must be a non-empty string array`);
      }
      for (const entry of record.limitations) {
        if (typeof entry !== "string") {
          throw new Error(`${label}.limitations entries must be strings`);
        }
      }
      return;
    case "unsupported":
      if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
        throw new Error(`${label}.reason must be a non-empty string`);
      }
      return;
    default:
      throw new Error(`${label}.kind must be supported, partial, or unsupported`);
  }
}

// ITOTORI-035: historic asset-localization decisions remain observable for
// patch export and diagnostics, but no longer expose a human decision write.

async function runAssetDecisionsListHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const projectId = requiredFlag(args, "--project");
  const localeBranchId = requiredFlag(args, "--locale");
  const outputPath = requiredFlag(args, "--output");
  await dependencies.withServices(async (services) => {
    const port = requireAssetDecisionsPort(services);
    await runAssetDecisionsList({ projectId, localeBranchId, outputPath }, port, dependencies.io);
  });
}

function requireAssetDecisionsPort(services: ItotoriCliServices): AssetDecisionsCliPort {
  const port = configuredServicePort(services, "assetDecisions");
  if (port === undefined) {
    throw new Error(
      "asset-decisions service is not configured for this CLI context (assetDecisions port missing)",
    );
  }
  return port;
}

// ITOTORI-047: queue-health inspection CLI command. Surfaces the typed
// QueueHealthReadModel (outbox/job lag, pending counts by status, retry counts,
// dead-letter review) via a validated typed API response — the SAME contract
// the `queue.health` dashboard route emits.

async function runQueueHealthHandler(
  args: string[],
  dependencies: ItotoriCliDependencies,
): Promise<void> {
  const outputPath = requiredFlag(args, "--output");
  const deadLetterLimitRaw = optionalFlag(args, "--dead-letter-limit");
  const projectId = optionalFlag(args, "--project");
  await dependencies.withServices(async (services) => {
    const port = requireQueueHealthPort(services);
    const cliArgs: Parameters<typeof runQueueHealthCli>[0] = { outputPath };
    if (deadLetterLimitRaw !== undefined) {
      cliArgs.deadLetterLimit = parseNonNegativeInteger(deadLetterLimitRaw, "--dead-letter-limit");
    }
    if (projectId !== undefined) {
      cliArgs.projectId = projectId;
    }
    await runQueueHealthCli(cliArgs, port, dependencies.io);
  });
}

// Wiki commands are intentionally a nested user-facing surface:
//   itotori wiki build/list/show/history/edit
// `build` enters the source-Wiki composition; object operations use the
// actor-bound installed-bible API.
async function runWiki(args: string[], dependencies: ItotoriCliDependencies): Promise<void> {
  await dependencies.withServices(async (services) => {
    const building = args[1] === "build";
    const service = configuredServicePort(services, "wikiObjectApi");
    const wikiBuild = configuredServicePort(services, "wikiBuild");
    if (!building && service === undefined) {
      throw new Error(
        "wiki is not configured in this CLI build (wikiObjectApi port missing — the new-pipeline Wiki object-API service is not installed)",
      );
    }
    if (building && wikiBuild === undefined) {
      throw new Error(
        "wiki build is not configured in this CLI build (wikiBuild port missing — the source-Wiki analyst substrate is not installed)",
      );
    }
    await runWikiCommand(args, {
      io: {
        readJson: (path) => dependencies.io.readJson(path),
        writeJson: (path, value) => dependencies.io.writeJson(path, value),
      },
      resolveWikiService: () => {
        if (service === undefined) throw new Error("wiki object API is not configured");
        return service;
      },
      ...(wikiBuild === undefined ? {} : { runBuild: (input) => wikiBuild.run(input) }),
    });
  });
}

function requireQueueHealthPort(services: ItotoriCliServices): QueueHealthCliPort {
  const port = configuredServicePort(services, "queueHealth");
  if (port === undefined) {
    throw new Error(
      "queue-health service is not configured for this CLI context (queueHealth port missing)",
    );
  }
  return port;
}
