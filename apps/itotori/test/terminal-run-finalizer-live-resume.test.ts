import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashLocalizationArtifact,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import {
  assertBridgeBundleV02,
  asNonBlankTargetText,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import {
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import {
  runLocalizeFullProjectLive,
  type RunLocalizeFullProjectLiveArgs,
} from "../src/orchestrator/localize-fullproject-cli.js";
import type { LocalizeFullProjectConfig } from "../src/orchestrator/localize-fullproject-command.js";
import { parseLocalizeProjectPairPolicy } from "../src/orchestrator/localize-project-stage-command.js";
import {
  applyWholeGamePatch,
  buildWholeGamePatchExport,
} from "../src/orchestrator/patch-apply-seam.js";
import {
  runProjectDrivenExecutor,
  type ProjectDrivenExecutorResult,
} from "../src/orchestrator/project-driven-executor.js";
import {
  DrivenJournalPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "../src/orchestrator/project-driven-executor-sinks.js";
import { DbTerminalRunFinalizerAdapter } from "../src/orchestrator/terminal-run-finalizer-db-adapter.js";
import {
  finalizeTerminalRun,
  type TerminalFinalizerWorkerPorts,
  type TerminalRunFinalizerPersistencePort,
} from "../src/orchestrator/terminal-run-finalizer.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "terminal-finalizer-live-resume-driver",
  fenceToken: 1,
};
const scope = {
  projectId: "project-terminal-finalizer-live-resume",
  localeBranchId: "branch-terminal-finalizer-live-resume",
  sourceRevisionId: "019ef200-0000-7000-8000-000000000010",
  targetLocale: "en-US",
} as const;
const RESUME_UNIT_ONE = "019ef200-0000-7000-8000-000000000001";
const RESUME_UNIT_TWO = "019ef200-0000-7000-8000-000000000002";
const RESUME_UNIT_THREE = "019ef200-0000-7000-8000-000000000003";
const RESUME_BRIDGE_ID = "019ef200-0000-7000-8000-000000000011";
const RESUME_ASSET_ID = "019ef200-0000-7000-8000-000000000012";
const RESUME_SOURCE_BUNDLE_HASH = `sha256:${"a".repeat(64)}`;
const RESUME_SOURCE_PROFILE_HASH = `sha256:${"b".repeat(64)}`;

describe.skipIf(!process.env.DATABASE_URL)("shipped terminal finalizer resume", () => {
  it("finishes an unconfirmed finalizing commit without config, provider, or executor work", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact();
    const runDir = mkdtempSync(join(tmpdir(), "itotori-finalizer-live-resume-"));
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "terminal-finalizer-live-resume-unconfirmed-commit";
      const unitId = `${runId}-unit`;
      await journal.seedRun(actor, {
        runId,
        ...scope,
        frozenScope: { kind: "explicit_units", unitIds: [unitId] },
        routingPolicy: { routes: ["model-finalizer-live/provider-finalizer-live"] },
        // itotori-225-audit-allow: deterministic synthetic ceiling; the fixture attempt bills exact zero.
        costPolicy: { kind: "terminal-finalizer-live-resume-test", capUsd: "1.00" },
        units: [
          {
            bridgeUnitId: unitId,
            sourceUnitKey: `scene.${unitId}`,
            nextAction: { kind: "drive_unit", stage: "translation" },
          },
        ],
        lease: { ownerId: driverLease.ownerId },
        createdAt: "2026-07-12T16:10:00.000Z",
      });
      await writeUnit(journal, runId, unitId);

      const productionAdapter = new DbTerminalRunFinalizerAdapter(
        repository,
        actor,
        () => driverLease,
        {},
        { runLockPool: context.pool },
      );
      const commitUnavailable: TerminalRunFinalizerPersistencePort = {
        acquireRunLock: (id) => productionAdapter.acquireRunLock(id),
        loadSnapshot: (id) => productionAdapter.loadSnapshot(id),
        loadTerminalSummary: (id) => productionAdapter.loadTerminalSummary(id),
        enterFinalizing: (id) => productionAdapter.enterFinalizing(id),
        ensurePatchVersion: (input) => productionAdapter.ensurePatchVersion(input),
        recordStage: (input) => productionAdapter.recordStage(input),
        commitTerminal: async () => {
          throw new Error("injected terminal commit transport outage");
        },
      };

      await expect(
        finalizeTerminalRun({
          runId,
          persistence: commitUnavailable,
          workers: successfulWorkers(artifact),
          now: () => new Date("2026-07-12T16:10:10.000Z"),
        }),
      ).rejects.toMatchObject({
        name: "TerminalRunCommitResumableError",
        runId,
        durableRunStatus: "finalizing",
      });
      expect(await repository.loadSnapshot(actor, runId)).toMatchObject({
        run: { status: "finalizing" },
        patch: { status: "building" },
      });
      expect(await repository.loadTerminalSummary(actor, runId)).toBeNull();

      const readJson = vi.fn(() => {
        throw new Error("finalizing resume must not read config or bridge input");
      });
      process.env.DATABASE_URL = context.databaseUrl;
      const summaryPath = join(runDir, "run-summary.json");
      writeFileSync(summaryPath, '{"stale":true}\n');
      const commitFailure = vi
        .spyOn(ItotoriLocalizationRunFinalizerRepository.prototype, "completeSucceededRun")
        .mockRejectedValue(new Error("injected resumed terminal commit outage"));
      try {
        await expect(
          runItotoriCliCommand(
            [
              "localize",
              "--config",
              "/must-not-be-read/localize.config.json",
              "--resume-run-id",
              runId,
              "--run-dir",
              runDir,
            ],
            cliDependencies(readJson),
          ),
        ).rejects.toThrow(/terminal commit.*could not be confirmed/u);
      } finally {
        commitFailure.mockRestore();
      }
      expect(await repository.loadSnapshot(actor, runId)).toMatchObject({
        run: { status: "finalizing" },
      });
      expect(await repository.loadTerminalSummary(actor, runId)).toBeNull();
      expect(existsSync(summaryPath)).toBe(false);

      await runItotoriCliCommand(
        [
          "localize",
          "--config",
          "/must-not-be-read/localize.config.json",
          "--resume-run-id",
          runId,
          "--run-dir",
          runDir,
        ],
        cliDependencies(readJson),
      );

      const canonical = await repository.loadTerminalSummary(actor, runId);
      const resumedSnapshot = await repository.loadSnapshot(actor, runId);
      expect(canonical).toMatchObject({
        terminalStatus: "succeeded",
        summaryEpoch: 1,
        summary: {
          terminalStatus: "succeeded",
          rootCause: { kind: "completed", code: "coverage_complete" },
          patch: { playable: true },
        },
      });
      expect(resumedSnapshot?.run.status).toBe("succeeded");
      expect(readJson).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(summaryPath, "utf8")) as unknown).toEqual(canonical?.summary);
      expect(stdout.join("")).toContain('"resumedFinalization": true');

      writeFileSync(summaryPath, '{"stale":true}\n');
      await runItotoriCliCommand(
        [
          "localize",
          "--config",
          "/still-must-not-be-read/localize.config.json",
          "--resume-run-id",
          runId,
          "--run-dir",
          runDir,
        ],
        cliDependencies(readJson),
      );
      expect(JSON.parse(readFileSync(summaryPath, "utf8")) as unknown).toEqual(canonical?.summary);
      expect(readJson).not.toHaveBeenCalled();
      const summaryRows = await context.pool.query<{ count: number }>(
        `select count(*)::int as count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(summaryRows.rows[0]?.count).toBe(1);
    } finally {
      stdoutSpy.mockRestore();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      rmSync(runDir, { recursive: true, force: true });
      artifact.cleanup();
      await context.close();
    }
  });

  it("recovers RPG Maker outputs left before patch-apply evidence and completes idempotently", async () => {
    const context = await isolatedMigratedContext();
    const root = mkdtempSync(join(tmpdir(), "itotori-finalizer-apply-recovery-"));
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalKaifuuBin = process.env.ITOTORI_KAIFUU_BIN;
    try {
      await seedScope(context);
      const fixture = materializeResumeProject(root, [RESUME_UNIT_ONE]);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "terminal-finalizer-live-resume-incomplete-apply";
      const initial = await runExecutorFixture({
        journal,
        runDir,
        runId,
        bridge: fixture.bridge,
        pairPolicy: fixture.pairPolicy,
        providerFactory: resumeProviderFactory(new Map()),
      });
      expect(initial.result).toMatchObject({
        journalRunId: runId,
        runState: "running",
        patchReport: { coverageComplete: true },
      });

      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const finalizingAdapter = new DbTerminalRunFinalizerAdapter(
        repository,
        actor,
        () => initial.adapter.getActiveRunLease(runId),
        {
          beforeEnterFinalizing: (id) => initial.adapter.quiesceTerminalRunLeaseHeartbeat(id),
          afterEnterFinalizing: (id) => initial.adapter.forgetTerminalRunLease(id),
        },
        { runLockPool: context.pool },
      );
      await finalizingAdapter.enterFinalizing(runId);
      const build = await buildWholeGamePatchExport({
        actor,
        engineProfile: "rpg-maker-mv-mz",
        journal,
        patchReport: initial.result.patchReport,
        rawBridge: fixture.bridge,
        sourceRoot: fixture.sourceRoot,
        targetRoot: fixture.targetRoot,
        rpgMakerDeltaOutputPath: fixture.deltaPath,
        translatedBundlePath: join(runDir, "translated-bridge.json"),
        requestedBy: localUserId,
        loadActiveDecisions: async () => [],
      });
      const patchExportPath = join(runDir, "patch-export-bundle.json");
      fsIo().writeJson(patchExportPath, build.patchExportBundle);
      const artifactRefs = {
        translatedBridge: join(runDir, "translated-bridge.json"),
        patchReport: join(runDir, "patch-report.json"),
        patchExport: patchExportPath,
      };
      await repository.ensurePatchVersion(actor, {
        runId,
        artifactRefs,
        artifactHashes: Object.fromEntries(
          Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
        ),
      });
      await repository.upsertPatchStageEvidence(actor, {
        runId,
        stage: "patch_build",
        status: "succeeded",
        evidence: { fixture: "crash-after-apply-output", step: "patch_build" },
      });

      materializeRpgMakerOutputs(fixture.targetRoot, fixture.deltaPath);
      const fakeKaifuu = installFakeKaifuu(root);
      process.env.DATABASE_URL = context.databaseUrl;
      process.env.ITOTORI_KAIFUU_BIN = fakeKaifuu.binPath;
      const liveArgs: RunLocalizeFullProjectLiveArgs = {
        configPath: fixture.configPath,
        runDir,
        io: fsIo(),
        resumeRunId: runId,
        sourceRoot: fixture.sourceRoot,
        patchTargetRoot: fixture.targetRoot,
      };
      const resumed = await runLocalizeFullProjectLive(liveArgs);

      expect(resumed).toMatchObject({
        resumedFinalization: true,
        result: { journalRunId: runId, runState: "succeeded" },
        terminalSummary: { terminalStatus: "succeeded", patch: { playable: true } },
      });
      const snapshot = await repository.loadSnapshot(actor, runId);
      const canonical = await repository.loadTerminalSummary(actor, runId);
      expect(snapshot?.run.status).toBe("succeeded");
      expect(snapshot?.outbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: "patch_build", status: "succeeded" }),
          expect.objectContaining({ stage: "patch_apply", status: "succeeded" }),
          expect.objectContaining({ stage: "validation", status: "succeeded" }),
        ]),
      );
      expect(readInvocationCount(fakeKaifuu.logPath)).toBe(1);
      expect(JSON.parse(readFileSync(join(runDir, "run-summary.json"), "utf8")) as unknown).toEqual(
        canonical?.summary,
      );

      await runLocalizeFullProjectLive(liveArgs);
      expect(readInvocationCount(fakeKaifuu.logPath)).toBe(1);
      expect((await repository.loadTerminalSummary(actor, runId))?.summaryEpoch).toBe(1);
    } finally {
      restoreEnv("DATABASE_URL", originalDatabaseUrl);
      restoreEnv("ITOTORI_KAIFUU_BIN", originalKaifuuBin);
      rmSync(root, { recursive: true, force: true });
      await context.close();
    }
  });

  it("adopts durable build/apply manifests left before their stage evidence", async () => {
    const context = await isolatedMigratedContext();
    const root = mkdtempSync(join(tmpdir(), "itotori-finalizer-manifest-recovery-"));
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalKaifuuBin = process.env.ITOTORI_KAIFUU_BIN;
    try {
      await seedScope(context);
      const fixture = materializeResumeProject(root, [RESUME_UNIT_ONE]);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "terminal-finalizer-live-resume-durable-manifests";
      const initial = await runExecutorFixture({
        journal,
        runDir,
        runId,
        bridge: fixture.bridge,
        pairPolicy: fixture.pairPolicy,
        providerFactory: resumeProviderFactory(new Map()),
      });
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const finalizingAdapter = new DbTerminalRunFinalizerAdapter(
        repository,
        actor,
        () => initial.adapter.getActiveRunLease(runId),
        {
          beforeEnterFinalizing: (id) => initial.adapter.quiesceTerminalRunLeaseHeartbeat(id),
          afterEnterFinalizing: (id) => initial.adapter.forgetTerminalRunLease(id),
        },
        { runLockPool: context.pool },
      );
      await finalizingAdapter.enterFinalizing(runId);
      const patchArgs = {
        actor,
        engineProfile: "rpg-maker-mv-mz" as const,
        journal,
        patchReport: initial.result.patchReport,
        rawBridge: fixture.bridge,
        sourceRoot: fixture.sourceRoot,
        targetRoot: fixture.targetRoot,
        rpgMakerDeltaOutputPath: fixture.deltaPath,
        translatedBundlePath: join(runDir, "translated-bridge.json"),
        requestedBy: localUserId,
        loadActiveDecisions: async () => [],
      };
      const build = await buildWholeGamePatchExport(patchArgs);
      const patchExportPath = join(runDir, "patch-export-bundle.json");
      fsIo().writeJson(patchExportPath, build.patchExportBundle);
      const applied = applyWholeGamePatch(
        {
          ...patchArgs,
          runProcess: (_command, processArgs) => {
            const target = processArgs[processArgs.indexOf("--patched-data-output") + 1]!;
            const delta = processArgs[processArgs.indexOf("--delta-output") + 1]!;
            materializeRpgMakerOutputs(target, delta);
            return { status: 0, stdout: "initial durable apply", stderr: "" };
          },
        },
        build,
      );
      const patchApplyPath = join(runDir, "patch-apply.json");
      fsIo().writeJson(patchApplyPath, applied.apply);
      const artifactRefs = {
        translatedBridge: join(runDir, "translated-bridge.json"),
        patchReport: join(runDir, "patch-report.json"),
        patchExport: patchExportPath,
        patchApply: patchApplyPath,
        patchTarget: fixture.targetRoot,
        rpgMakerDelta: fixture.deltaPath,
      };
      const artifactHashes = Object.fromEntries(
        Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
      );
      await repository.ensurePatchVersion(actor, { runId, artifactRefs, artifactHashes });
      expect((await repository.loadSnapshot(actor, runId))?.outbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: "patch_build", status: "pending" }),
          expect.objectContaining({ stage: "patch_apply", status: "pending" }),
        ]),
      );
      const patchExportBytes = readFileSync(patchExportPath, "utf8");
      const patchApplyBytes = readFileSync(patchApplyPath, "utf8");

      const fakeKaifuu = installFakeKaifuu(root);
      process.env.DATABASE_URL = context.databaseUrl;
      process.env.ITOTORI_KAIFUU_BIN = fakeKaifuu.binPath;
      const resumed = await runLocalizeFullProjectLive({
        configPath: fixture.configPath,
        runDir,
        io: fsIo(),
        resumeRunId: runId,
        sourceRoot: fixture.sourceRoot,
        patchTargetRoot: fixture.targetRoot,
      });

      expect(resumed).toMatchObject({
        resumedFinalization: true,
        result: { runState: "succeeded" },
        terminalSummary: { patch: { playable: true } },
      });
      expect(readInvocationCount(fakeKaifuu.logPath)).toBe(0);
      expect(readFileSync(patchExportPath, "utf8")).toBe(patchExportBytes);
      expect(readFileSync(patchApplyPath, "utf8")).toBe(patchApplyBytes);
      const completed = await repository.loadSnapshot(actor, runId);
      expect(completed?.patch?.artifactHashes).toMatchObject(artifactHashes);
      expect(completed?.outbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: "patch_build", status: "succeeded" }),
          expect.objectContaining({ stage: "patch_apply", status: "succeeded" }),
          expect.objectContaining({ stage: "validation", status: "succeeded" }),
        ]),
      );
    } finally {
      restoreEnv("DATABASE_URL", originalDatabaseUrl);
      restoreEnv("ITOTORI_KAIFUU_BIN", originalKaifuuBin);
      rmSync(root, { recursive: true, force: true });
      await context.close();
    }
  });

  it("re-drives pending executor units when a paused run already has a summary", async () => {
    const context = await isolatedMigratedContext();
    const root = mkdtempSync(join(tmpdir(), "itotori-finalizer-paused-resume-"));
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalZdrAssertion = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
    try {
      await seedScope(context);
      const fixture = materializeResumeProject(root, [
        RESUME_UNIT_ONE,
        RESUME_UNIT_TWO,
        RESUME_UNIT_THREE,
      ]);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const runId = "terminal-finalizer-live-resume-paused-summary";
      const firstCalls = new Map<string, number>();
      const first = await runExecutorFixture({
        journal,
        runDir,
        runId,
        bridge: fixture.bridge,
        pairPolicy: fixture.pairPolicy,
        providerFactory: resumeProviderFactory(firstCalls),
        pauseUnitId: RESUME_UNIT_TWO,
      });
      expect(first.result.runState).toBe("paused");
      expect(firstCalls.get(RESUME_UNIT_ONE)).toBeGreaterThan(0);
      expect(firstCalls.get(RESUME_UNIT_TWO) ?? 0).toBe(0);

      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const paused = await finalizeTerminalRun({
        runId,
        persistence: new DbTerminalRunFinalizerAdapter(
          repository,
          actor,
          undefined,
          {},
          { runLockPool: context.pool },
        ),
        workers: {
          summary: ({ summary }) => {
            if (summary === undefined) throw new Error("paused finalizer omitted its summary");
            fsIo().writeJson(join(runDir, "run-summary.json"), summary);
          },
        },
      });
      expect(paused).toMatchObject({
        terminalStatus: "paused",
        summary: {
          summaryEpoch: 1,
          coverage: { missingUnitIds: [RESUME_UNIT_TWO, RESUME_UNIT_THREE] },
        },
      });
      expect(
        (await journal.loadRunUnits(actor, runId)).map((unit) => [unit.bridgeUnitId, unit.state]),
      ).toEqual([
        [RESUME_UNIT_ONE, "written"],
        [RESUME_UNIT_TWO, "pending"],
        [RESUME_UNIT_THREE, "pending"],
      ]);

      process.env.DATABASE_URL = context.databaseUrl;
      process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = "1";
      const summaryPath = join(runDir, "run-summary.json");
      const liveIo = fsIo();
      const liveArgs = {
        configPath: fixture.configPath,
        runDir,
        io: {
          ...liveIo,
          writeJson: (path: string, value: unknown) => {
            if (path === summaryPath) {
              throw new Error("injected resumed pause summary projection failure");
            }
            liveIo.writeJson(path, value);
          },
        },
        resumeRunId: runId,
      } satisfies RunLocalizeFullProjectLiveArgs;
      const repausedCalls = new Map<string, number>();
      const repaused = await runLocalizeFullProjectLive({
        ...liveArgs,
        providerFactoryOverride: resumeProviderFactory(repausedCalls, RESUME_UNIT_THREE),
      });

      expect(repaused.resumedFinalization).not.toBe(true);
      expect(repaused.result).toMatchObject({ journalRunId: runId, runState: "paused" });
      expect(repausedCalls.get(RESUME_UNIT_ONE) ?? 0).toBe(0);
      expect(repausedCalls.get(RESUME_UNIT_TWO)).toBeGreaterThan(0);
      expect(repausedCalls.get(RESUME_UNIT_THREE)).toBeGreaterThan(0);
      expect(
        (await journal.loadRunUnits(actor, runId)).map((unit) => [unit.bridgeUnitId, unit.state]),
      ).toEqual([
        [RESUME_UNIT_ONE, "written"],
        [RESUME_UNIT_TWO, "written"],
        [RESUME_UNIT_THREE, "pending"],
      ]);
      const repausedCanonical = await repository.loadTerminalSummary(actor, runId);
      expect(repausedCanonical).toMatchObject({
        terminalStatus: "paused",
        summaryEpoch: 2,
        summary: {
          terminalStatus: "paused",
          rootCause: { kind: "operational_blocker", code: "provider_outage" },
          coverage: { missingUnitIds: [RESUME_UNIT_THREE] },
          stages: expect.arrayContaining([
            expect.objectContaining({
              stage: "summary",
              status: "pending",
              evidence: null,
              error: null,
            }),
          ]),
        },
      });
      expect((await repository.loadSnapshot(actor, runId))?.outbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "summary",
            status: "retry_waiting",
            lastError: expect.stringContaining("injected resumed pause summary projection failure"),
          }),
        ]),
      );
      expect(existsSync(summaryPath)).toBe(false);
    } finally {
      restoreEnv("DATABASE_URL", originalDatabaseUrl);
      restoreEnv("OPENROUTER_ZDR_ACCOUNT_ASSERTED", originalZdrAssertion);
      rmSync(root, { recursive: true, force: true });
      await context.close();
    }
  });
});

function fsIo(): RunLocalizeFullProjectLiveArgs["io"] {
  return {
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
    writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
  };
}

function materializeResumeProject(
  root: string,
  unitIds: readonly string[],
): {
  configPath: string;
  bridge: BridgeBundleV02;
  pairPolicy: ReturnType<typeof parseLocalizeProjectPairPolicy>["pairPolicy"];
  sourceRoot: string;
  targetRoot: string;
  deltaPath: string;
} {
  const bridge = resumeBridge(unitIds);
  const bridgePath = join(root, "bridge.json");
  const pairPolicyPath = join(root, "pair-policy.json");
  const configPath = join(root, "localize.config.json");
  const sourceRoot = join(root, "www");
  const targetRoot = join(root, "patched-data");
  const deltaPath = join(root, "run", "rpgmaker-delta.kaifuu");
  const pairPolicyFixture = new URL(
    "./fixtures/agentic-loop-smoke-pair-policy.json",
    import.meta.url,
  );
  const rawPairPolicy = JSON.parse(readFileSync(pairPolicyFixture, "utf8")) as unknown;
  const pairPolicy = parseLocalizeProjectPairPolicy(rawPairPolicy).pairPolicy;
  const config: LocalizeFullProjectConfig = {
    schemaVersion: "itotori.localize-fullproject.config.v0",
    ...scope,
    engineProfile: "rpg-maker-mv-mz",
    translationScope: "dialogue-only",
    bridgePath,
    pairPolicyPath,
    concurrency: 1,
    maxRepairAttempts: 0,
  };
  fsIo().writeJson(bridgePath, bridge);
  fsIo().writeJson(pairPolicyPath, rawPairPolicy);
  fsIo().writeJson(configPath, config);
  mkdirSync(join(sourceRoot, "data"), { recursive: true });
  writeFileSync(join(sourceRoot, "data", "Map001.json"), '{"events":[]}\n');
  return { configPath, bridge, pairPolicy, sourceRoot, targetRoot, deltaPath };
}

async function runExecutorFixture(input: {
  journal: ItotoriLocalizationJournalRepository;
  runDir: string;
  runId: string;
  bridge: BridgeBundleV02;
  pairPolicy: ReturnType<typeof parseLocalizeProjectPairPolicy>["pairPolicy"];
  providerFactory: AgenticLoopProviderFactory;
  pauseUnitId?: string;
}): Promise<{
  result: ProjectDrivenExecutorResult;
  adapter: DrivenJournalPersistenceAdapter;
}> {
  const adapter = new DrivenJournalPersistenceAdapter(input.journal, { actor });
  const result = await runProjectDrivenExecutor({
    bridge: input.bridge,
    rawBridge: structuredClone(input.bridge),
    pairPolicy: input.pairPolicy,
    pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
    ...scope,
    runId: input.runId,
    actor,
    providerFactory: input.providerFactory,
    translationScope: "dialogue-only",
    engineProfile: "rpg-maker-mv-mz",
    concurrency: 1,
    maxRepairAttempts: 0,
    costAdmission: {
      admit: async ({ bridgeUnitId }) =>
        bridgeUnitId === input.pauseUnitId
          ? {
              admitted: false as const,
              detail: "injected durable pause before pending resume unit",
              evidence: `resume-unit:${bridgeUnitId}`,
            }
          : { admitted: true as const },
    },
    sinks: {
      journal: adapter,
      patchExport: new FsDrivenPatchExportSink(input.runDir),
    },
  });
  return { result, adapter };
}

function resumeProviderFactory(
  calls: Map<string, number>,
  outageUnitId?: string,
): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `terminal-resume-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        calls.set("__all__", (calls.get("__all__") ?? 0) + 1);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        const unitId = resumeUnitIdOf(request);
        calls.set(unitId, (calls.get(unitId) ?? 0) + 1);
        if (request.taskKind === "experiment") return resumeSpeakerContent(unitId);
        if (request.taskKind === "draft_translation") {
          if (unitId === outageUnitId) {
            throw Object.assign(new Error("injected HTTP 503 during resumed unit"), {
              status: 503,
            });
          }
          return resumeTranslationContent(
            unitId,
            unitId === RESUME_UNIT_ONE ? "First target." : "Second target.",
          );
        }
        if (request.taskKind === "llm_qa") return cleanResumeQaContent();
        throw new Error(`unexpected terminal resume provider task ${request.taskKind}`);
      },
    });
}

function resumeUnitIdOf(request: ModelInvocationRequest): string {
  // Resolved context can cite earlier units from the same scene. Attribute the
  // call from the prompt's explicit current-unit marker rather than the first
  // ID that happens to appear in context artifact data.
  const unitId = JSON.stringify(request).match(
    new RegExp(`unitId=(${[RESUME_UNIT_ONE, RESUME_UNIT_TWO, RESUME_UNIT_THREE].join("|")})`, "u"),
  );
  if (unitId === null || unitId[1] === undefined) {
    throw new Error("terminal resume provider could not find the current unit id");
  }
  return unitId[1];
}

function resumeSpeakerContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "terminal resume fixture",
      },
    ],
  });
}

function resumeTranslationContent(bridgeUnitId: string, draftText: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "terminal resume fixture",
        confidenceFloor: "medium",
      },
    ],
  });
}

function cleanResumeQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

function resumeBridge(unitIds: readonly string[]): BridgeBundleV02 {
  const sourceBundleRevision = resumeRevision(scope.sourceRevisionId, RESUME_SOURCE_BUNDLE_HASH);
  const bridge: BridgeBundleV02 = {
    schemaVersion: "0.2.0",
    bridgeId: RESUME_BRIDGE_ID,
    sourceGame: {
      gameId: "terminal-finalizer-live-resume-fixture",
      gameVersion: "1",
      sourceProfileId: "terminal-finalizer-live-resume-profile",
      sourceProfileRevision: resumeRevision(
        "019ef200-0000-7000-8000-000000000013",
        RESUME_SOURCE_PROFILE_HASH,
      ),
    },
    sourceBundleHash: RESUME_SOURCE_BUNDLE_HASH,
    sourceBundleRevision,
    sourceLocale: "ja-JP",
    hashStrategy: {
      sourceProfile: {
        scope: "source_profile",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceBundle: {
        scope: "source_bundle",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceAsset: { scope: "source_asset", algorithm: "sha256", normalization: "bytes" },
      sourceUnit: {
        scope: "source_unit",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
        fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
      },
      patchExport: {
        scope: "patch_export",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      deltaPackage: {
        scope: "delta_package",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
    },
    extractor: { name: "terminal-finalizer-live-resume-fixture", version: "1" },
    assets: [
      {
        assetId: RESUME_ASSET_ID,
        assetKey: "Map001.json",
        assetKind: "text",
        sourceHash: RESUME_SOURCE_BUNDLE_HASH,
        sourceRevision: sourceBundleRevision,
      },
    ],
    units: unitIds.map((unitId, index) => resumeUnit(unitId, index + 1)),
    policyRecords: [],
  };
  assertBridgeBundleV02(bridge);
  return bridge;
}

function resumeUnit(bridgeUnitId: string, ordinal: number): LocalizationUnitV02 {
  const sourceText = ordinal === 1 ? "一番目" : ordinal === 2 ? "二番目" : "三番目";
  const sourceUnitKey = `Map001/events/${String(ordinal)}`;
  const sourceRevision = resumeRevision(scope.sourceRevisionId, RESUME_SOURCE_BUNDLE_HASH);
  return {
    bridgeUnitId,
    surfaceId: RESUME_ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey,
    occurrenceId: `terminal-resume-occurrence-${String(ordinal)}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `sha256:${ordinal === 1 ? "c".repeat(64) : ordinal === 2 ? "d".repeat(64) : "e".repeat(64)}`,
    sourceRevision,
    sourceAssetRef: { assetId: RESUME_ASSET_ID, assetKey: "Map001.json" },
    sourceLocation: { containerKey: "Map001.json" },
    speaker: { knowledgeState: "not_applicable" },
    context: { route: { sceneKey: "terminal-resume-scene" } },
    spans: [],
    patchRef: {
      assetId: RESUME_ASSET_ID,
      writeMode: "replace",
      sourceUnitKey,
      sourceRevision,
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function resumeRevision(revisionId: string, value: string) {
  return { revisionId, revisionKind: "content_hash" as const, value };
}

function materializeRpgMakerOutputs(targetRoot: string, deltaPath: string): void {
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(targetRoot, "Map001.json"), '{"events":["translated"]}\n');
  writeFileSync(deltaPath, "deterministic-delta\n");
}

function installFakeKaifuu(root: string): { binPath: string; logPath: string } {
  const binPath = join(root, "fake-kaifuu.cjs");
  const logPath = join(root, "fake-kaifuu-invocations.log");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const target = valueAfter("--patched-data-output");
const delta = valueAfter("--delta-output");
if (args[0] !== "patch" || !target || !delta) process.exit(64);
fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(path.dirname(delta), { recursive: true });
fs.writeFileSync(path.join(target, "Map001.json"), '{"events":["translated"]}\\n');
fs.writeFileSync(delta, "deterministic-delta\\n");
fs.appendFileSync(${JSON.stringify(logPath)}, "invoke\\n");
process.stdout.write("fake kaifuu rpgmaker patch\\n");
`;
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return { binPath, logPath };
}

function readInvocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0).length;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function cliDependencies(readJson: () => unknown): ItotoriCliDependencies {
  return {
    io: {
      readJson,
      writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
    },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {
      throw new Error("finalizing resume must not open project workflow services");
    }),
  };
}

function successfulWorkers(
  artifact: ReturnType<typeof createRealArtifact>,
): TerminalFinalizerWorkerPorts {
  return {
    patch_build: () => ({
      artifactRefs: { patch: artifact.path },
      artifactHashes: { patch: artifact.hash },
      evidence: { fixture: "live-resume", stage: "patch_build" },
    }),
    patch_apply: () => ({ evidence: { fixture: "live-resume", stage: "patch_apply" } }),
    validation: () => ({ evidence: { fixture: "live-resume", stage: "validation" } }),
    cleanup: () => ({ evidence: { fixture: "live-resume", stage: "cleanup" } }),
  };
}

function createRealArtifact(): { path: string; hash: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "itotori-finalizer-live-resume-artifact-"));
  const path = join(root, "patch-artifact.bin");
  writeFileSync(path, "live DB terminal finalizer resume artifact\n", "utf8");
  return {
    path,
    hash: hashLocalizationArtifact(path),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
): Promise<void> {
  const attemptId = `terminal-finalizer-live-resume-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "terminal-finalizer-live-resume-fixture",
    logicalCallId: `terminal-finalizer-live-resume-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-finalizer-live",
    requestedProviderId: "provider-finalizer-live",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T16:10:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-finalizer-live",
    providerId: "provider-finalizer-live",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 1,
    tokensOut: 1,
    tokenCountSource: "fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${attemptId}`,
    errorClasses: [],
    completedAt: "2026-07-12T16:10:02.000Z",
    lease: driverLease,
  });

  const outcomeId = `terminal-finalizer-live-resume-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `terminal-finalizer-live-resume-candidate:${runId}:${bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(`Translated ${bridgeUnitId}.`),
        producedBy: {
          modelId: "model-finalizer-live",
          providerId: "provider-finalizer-live",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "terminal-finalizer-live-resume-fixture" },
    writtenAt: "2026-07-12T16:10:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "terminal-finalizer-live-resume" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-terminal-finalizer-live-resume', 'Terminal Finalizer Live Resume Workspace')
  `);
  await context.pool.query(
    `
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      $1, 'workspace-terminal-finalizer-live-resume', 'terminal-finalizer-live-resume',
      'Terminal Finalizer Live Resume Project', 'ja-JP', 'imported'
    )
  `,
    [scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ($1, $2, 'content_hash', $3)
  `,
    [scope.sourceRevisionId, scope.projectId, RESUME_SOURCE_BUNDLE_HASH],
  );
  await context.pool.query(
    `
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'bundle-terminal-finalizer-live-resume', $1, $2,
      'bridge-terminal-finalizer-live-resume', '0.2.0',
      'hash:terminal-finalizer-live-resume', 'ja-JP',
      'fixture-extractor', '1.0.0', 1, 0
    )
  `,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      $1, $2, 'bundle-terminal-finalizer-live-resume',
      $3, 'Terminal finalizer live resume branch', 'active'
    )
  `,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}
