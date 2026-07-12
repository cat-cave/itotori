import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriProjectRepository,
  localUserId,
  type AuthorizationActor,
  type ItotoriProjectRepositoryPort,
  type LocaleBranchIdentity,
} from "@itotori/db";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { AccountZdrAssertionError } from "../src/providers/account-zdr.js";
import { DEV_PAIR, type ProviderRunArtifact } from "../src/providers/index.js";
import {
  DraftProviderNotConfiguredError,
  ItotoriProjectWorkflowService,
  LocalizationPassDriverNotConfiguredError,
  type ProjectState,
} from "../src/services/project-workflow.js";
import {
  createDbBackedDraftModelProvider,
  createDbBackedLivePassRunner,
  createDbBackedLocalizationPassDriver,
  type DbBackedPassRunConfig,
} from "../src/services/db-live-workflow-ports.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

// A no-op run-scoped recorder stand-in — the wiring proof only needs a recorder
// present; it never reaches the recorder because the ZDR assertion fires first.
function noopRecorder(): { recordProviderRun(a: ProviderRunArtifact): Promise<void> } {
  return { recordProviderRun: async (_a: ProviderRunArtifact) => {} };
}

// itotori-db-draft-route-provider-not-wired +
// p3-wire-or-explicitly-retire-localizationpassdriverport — these tests exercise
// the REAL constructor wiring the DB-backed service factory now performs. They
// do NOT mock the workflow method under test: `draftProject` runs for real and
// reaches the injected live provider port, and `launchNextLocalizationPass` runs
// for real and reaches the injected pass driver.
describe("DB-backed workflow live ports — real constructor wiring", () => {
  describe("draft provider (itotori-db-draft-route-provider-not-wired)", () => {
    it("pins the request to the ZDR DEV_PAIR (concrete model, never the multi-model sentinel)", () => {
      const provider = createDbBackedDraftModelProvider({
        env: {},
        artifactRecorder: noopRecorder(),
      });
      expect(provider.descriptor.family).toBe("openrouter");
      expect(provider.descriptor.defaultModelId).toBe(DEV_PAIR.modelId);
      expect(provider.descriptor.providerName).toBe(DEV_PAIR.providerId);
    });

    it("refuses the unadmitted real provider before lazy OpenRouter construction", async () => {
      // The injected provider is the SAME one the DB service factory wires.
      // It deliberately has no durable run-cost sink, so the universal
      // invocation boundary must fail before preflight can lazily construct
      // an OpenRouter transport (or reach the ZDR/API-key gate).
      const provider = createDbBackedDraftModelProvider({
        env: {},
        artifactRecorder: noopRecorder(),
      });
      const service = new ItotoriProjectWorkflowService(stubRepository(), actor, provider);

      await expect(service.draftProject(projectFixture(), "fr-FR")).rejects.toThrow(
        /durable cost-admission sink/u,
      );
      await expect(service.draftProject(projectFixture(), "fr-FR")).rejects.not.toBeInstanceOf(
        DraftProviderNotConfiguredError,
      );
    });
  });

  describe("pass driver (p3-wire-or-explicitly-retire-localizationpassdriverport)", () => {
    it("launchNextLocalizationPass REACHES the real driver and returns an in-band domain refusal (never LocalizationPassDriverNotConfiguredError)", async () => {
      // The driver is constructed exactly as the DB service factory wires it (no
      // game-bytes run-config resolver). A launch does a real branch-ownership
      // read, then returns an in-band `refused` outcome — proving the Overview
      // "Launch pass" action reaches the REAL pass driver rather than throwing
      // the old dead-button LocalizationPassDriverNotConfiguredError.
      const passDriver = createDbBackedLocalizationPassDriver({
        actor,
        projectRepository: {
          listLocaleBranchIdentities: async () => [branchIdentity("locale-en-us", "project-test")],
        },
      });
      const service = new ItotoriProjectWorkflowService(
        stubRepository(),
        actor,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        passDriver,
      );

      const result = await service.launchNextLocalizationPass({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
      });
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusalMessage).toContain("itotori localize");
      }
    });

    it("does NOT throw LocalizationPassDriverNotConfiguredError once wired", async () => {
      const passDriver = createDbBackedLocalizationPassDriver({
        actor,
        projectRepository: {
          listLocaleBranchIdentities: async () => [branchIdentity("locale-en-us", "project-test")],
        },
      });
      const service = new ItotoriProjectWorkflowService(
        stubRepository(),
        actor,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        passDriver,
      );
      await expect(
        service.launchNextLocalizationPass({
          projectId: "project-test",
          localeBranchId: "locale-en-us",
        }),
      ).resolves.not.toBeInstanceOf(LocalizationPassDriverNotConfiguredError);
    });

    it("DRIVES a real pass when a run config resolves (genuine dispatch, not a stub)", async () => {
      // Proves the driver is not scaffolding: given a resolvable run config it
      // dispatches to the injected whole-project runner and surfaces its
      // `started` outcome. The runner double stands in for
      // `runLocalizeFullProjectLive` (separately tested) — the driver's dispatch
      // is the unit under test, not the downstream live CLI.
      const runLive = vi.fn(
        async (
          _config: DbBackedPassRunConfig,
        ): Promise<{ outcome: "started"; journalRunId: string; startedAt: Date }> => ({
          outcome: "started",
          journalRunId: "localization-journal-run-2",
          startedAt: new Date("2026-07-11T00:00:00.000Z"),
        }),
      );
      const passDriver = createDbBackedLocalizationPassDriver({
        actor,
        projectRepository: {
          listLocaleBranchIdentities: async () => [branchIdentity("locale-en-us", "project-test")],
        },
        resolveRunConfig: async () => ({
          configPath: "/runs/project.localize.json",
          runDir: "/runs",
        }),
        runLive,
      });

      const result = await passDriver.launchNextPass({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        actor,
      });
      expect(result).toEqual({
        outcome: "started",
        journalRunId: "localization-journal-run-2",
        startedAt: new Date("2026-07-11T00:00:00.000Z"),
      });
      expect(runLive).toHaveBeenCalledTimes(1);
      expect(runLive.mock.calls[0]?.[0]).toEqual({
        configPath: "/runs/project.localize.json",
        runDir: "/runs",
      });
    });

    it("refuses in-band when the branch does not belong to the project", async () => {
      const passDriver = createDbBackedLocalizationPassDriver({
        actor,
        projectRepository: { listLocaleBranchIdentities: async () => [] },
      });
      const result = await passDriver.launchNextPass({
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        actor,
      });
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.refusalMessage).toContain("does not belong to project");
      }
    });

    const realConfigPath = process.env.ITOTORI_REAL_LOCALIZATION_CONFIG;
    const realDataRoot = process.env.ITOTORI_REAL_LOCALIZATION_DATA_ROOT;
    const realPairPolicyPath = process.env.ITOTORI_REAL_LOCALIZATION_PAIR_POLICY;
    const realProofReady =
      realConfigPath !== undefined &&
      realDataRoot !== undefined &&
      realPairPolicyPath !== undefined &&
      process.env.DATABASE_URL !== undefined &&
      existsSync(realConfigPath) &&
      existsSync(realDataRoot) &&
      existsSync(realPairPolicyPath);

    it.skipIf(!realProofReady)(
      "Launch pass reaches the REAL runLocalizeFullProjectLive runner for a registered local data root",
      async () => {
        const runDir = mkdtempSync(join(tmpdir(), "itotori-launch-pass-real-wire-"));
        const context = await isolatedMigratedContext();

        try {
          const projectRepository = new ItotoriProjectRepository(context.db);
          await projectRepository.importSourceBundle(actor, projectFixture());
          const runConfigRepository = new ItotoriLocalizationPassRunConfigRepository(context.db);
          await runConfigRepository.saveRunConfig(actor, {
            projectId: "project-test",
            localeBranchId: "locale-en-us",
            configPath: realConfigPath!,
            dataRoot: realDataRoot!,
            pairPolicyPath: realPairPolicyPath!,
            modelId: "deepseek/deepseek-v4-flash",
            providerId: "fireworks",
            runDir,
          });
          const passDriver = createDbBackedLocalizationPassDriver({
            actor,
            projectRepository,
            resolveRunConfig: (input) =>
              runConfigRepository.resolveRunConfig(input.projectId, input.localeBranchId),
            // This is the production runner, not a vi.fn replacement. The
            // default branch below deliberately removes the account assertion so
            // the real function fails at its live-provider privacy gate without
            // spending tokens; the registry and branch lookup above are real DB
            // operations in an isolated schema.
            runLive: createDbBackedLivePassRunner(),
          });

          if (process.env.ITOTORI_RUN_LIVE_PASS_PROOF === "1") {
            const result = await passDriver.launchNextPass({
              projectId: "project-test",
              localeBranchId: "locale-en-us",
              actor,
            });
            expect(result.outcome).toBe("started");
            return;
          }

          const asserted = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
          delete process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
          try {
            await expect(
              passDriver.launchNextPass({
                projectId: "project-test",
                localeBranchId: "locale-en-us",
                actor,
              }),
            ).rejects.toBeInstanceOf(AccountZdrAssertionError);
          } finally {
            if (asserted === undefined) {
              delete process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
            } else {
              process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = asserted;
            }
          }
        } finally {
          rmSync(runDir, { recursive: true, force: true });
          await context.close();
        }
      },
    );
  });
});

function branchIdentity(localeBranchId: string, projectId: string): LocaleBranchIdentity {
  return {
    localeBranchId,
    projectId,
    sourceBundleId: "bundle-test",
    sourceBundleRevisionId: "rev-test",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    branchName: "en-US",
    status: "active",
  };
}

function stubRepository(): ItotoriProjectRepositoryPort {
  return {
    reset: vi.fn(async () => {}),
    importSourceBundle: vi.fn(async () => ({ state: "imported" }) as never),
    saveDrafts: vi.fn(async () => {}),
    savePatchExport: vi.fn(async () => {}),
    saveRuntimeReport: vi.fn(async () => ({}) as never),
    appendEvent: vi.fn(async () => {}),
    recordFinding: vi.fn(async () => {}),
    linkArtifact: vi.fn(async () => {}),
    recordBenchmarkArtifactWithProviderLedger: vi.fn(async () => {}),
    listLocaleBranchIdentities: vi.fn(async () => []),
    listBenchmarkReports: vi.fn(async () => []),
    getDashboardStatus: vi.fn(async () => ({}) as never),
    getRuntimeStatus: vi.fn(async () => ({}) as never),
    getDashboardDecisions: vi.fn(async () => ({}) as never),
  } as unknown as ItotoriProjectRepositoryPort;
}

function projectFixture(): ProjectState {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    bridge: bridgeFixture(),
    drafts: {},
  };
}

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-test",
    sourceBundleHash: "hash-test",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "bridge-unit-test",
        sourceUnitKey: "hello.scene.001.line.001",
        occurrenceId: "occurrence-1",
        sourceHash: "source-hash",
        sourceLocale: "ja-JP",
        sourceText: "Hello, {player}.",
        textSurface: "dialogue",
        protectedSpans: [
          { kind: "placeholder", raw: "{player}", start: 7, end: 15, preserveMode: "exact" },
        ],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "hello.scene.001.line.001",
        },
      },
    ],
  };
}
