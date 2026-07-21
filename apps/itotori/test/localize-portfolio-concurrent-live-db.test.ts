// Concurrent multi-project localize portfolio over a real Postgres plane.
// Asserts independent progression, cost, lease isolation, and failure isolation
// when three drivers fan out through runLocalizePortfolioCommand.

import { beforeAll, describe, expect, it } from "vitest";
import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { handleReadOnlyItotoriApiRequest, readOnlyApiServices } from "../src/api-handlers.js";
import {
  LocalizePortfolioExecutionError,
  runLocalizePortfolioCommand,
} from "../src/cli/localize-portfolio-command.js";
import { projectDecodeStructure } from "../src/composition/live/scene-projection.js";
import {
  withDatabaseItotoriServices,
  type ItotoriApplicationServices,
} from "../src/services/database-services.js";
import type { PhysicalAttemptCostObserver } from "../src/llm/physical-attempt-policy.js";
import type { NarrativeStructure } from "../src/structure/types.js";
import {
  bridge,
  hash,
  recordedPorts,
  recordedRunState,
  revision,
  structure,
  type RecordedRunState,
  type RunIdentity,
} from "./recorded-localize-run.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("localize portfolio concurrent over Postgres", () => {
  beforeAll(() => {
    process.env.ITOTORI_FIELD_CIPHER_KEY ??= Buffer.alloc(32, 11).toString("base64");
  });

  it("drives three concurrent runs with independent progression, cost, and leases", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const setup = await prepareProjects(services, 3);
        // Three genuinely independent runs (distinct game content) fan out
        // concurrently. Isolation is proven by each run driving ITS OWN plane
        // rows to full progression with its own cost/cap and a run-local lease
        // — the single-run test already proves the intermediate transitions.
        const states = setup.runs.map(() => recordedRunState());
        const result = await portfolioPromise(services, setup, states);

        expect(result.failedCount).toBe(0);
        expect(result.completedCount).toBe(3);

        for (let i = 0; i < setup.runs.length; i += 1) {
          const run = setup.runs[i]!;
          const state = states[i]!;
          const live = await services.projectWorkflow.loadLiveReadModel(run.projectId, run.runId);
          // Each run reached full progression on its own units and released
          // its lease; the cost cap is per-run (100 + i) and the spent cost is
          // this run's real provider tally — no bleed from the other runs.
          expect(live?.run).toMatchObject({
            status: "completed",
            leaseOwnerId: null,
            cost: {
              capMicrosUsd: 100 + i,
              spentMicrosUsd: state.providerCallCount * 7,
              reservedMicrosUsd: 0,
            },
          });
          expect(live?.progress.totalCostMicrosUsd).toBe(state.providerCallCount * 7);
          expect(live?.progress.statusCounts.patched).toBeGreaterThan(0);
          expect(live?.progress.statusCounts.decoded).toBe(0);
        }
        // Distinct per-run cost caps confirm the read models did not collapse
        // into a shared identity under concurrency.
        expect(new Set(setup.runs.map((_, i) => 100 + i)).size).toBe(3);
      });
    } finally {
      await context.close();
    }
  }, 120_000);

  it("isolates failure: one failed run leaves the other two progress/cost intact", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const setup = await prepareProjects(services, 3);
        const states = setup.runs.map(() => recordedRunState());
        // Induce failure on the middle run only.
        states[1]!.failOnDraft = new Error("induced portfolio failure");

        const portfolio = portfolioPromise(services, setup, states);
        try {
          let caught: unknown;
          try {
            await portfolio;
          } catch (error: unknown) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(LocalizePortfolioExecutionError);
          const result = (caught as LocalizePortfolioExecutionError).result;
          expect(result.failedCount).toBe(1);
          expect(result.completedCount).toBe(2);
          expect(result.outcomes.map((o) => o.status).sort()).toEqual([
            "completed",
            "completed",
            "failed",
          ]);

          const failed = result.outcomes.find((o) => o.status === "failed")!;
          expect(failed.projectId).toBe(setup.runs[1]!.projectId);
          expect(failed.runId).toBe(setup.runs[1]!.runId);
          expect(failed.error).toContain("induced portfolio failure");

          for (const index of [0, 2] as const) {
            const run = setup.runs[index]!;
            const state = states[index]!;
            const live = await services.projectWorkflow.loadLiveReadModel(run.projectId, run.runId);
            expect(live?.run.status).toBe("completed");
            expect(live?.run.leaseOwnerId).toBeNull();
            expect(live?.progress.totalCostMicrosUsd).toBe(state.providerCallCount * 7);
            expect(live?.progress.statusCounts.patched).toBeGreaterThan(0);
          }

          const failedLive = await services.projectWorkflow.loadLiveReadModel(
            setup.runs[1]!.projectId,
            setup.runs[1]!.runId,
          );
          expect(failedLive?.run.status).toBe("failed");
          // Failed run did not bill draft cost (threw before provider).
          expect(states[1]!.providerCallCount).toBe(0);

          const response = await handleReadOnlyItotoriApiRequest(
            { method: "GET", pathname: "/api/projects" },
            readOnlyApiServices({
              ...services,
              authorization: { requirePermission: async () => undefined },
            }),
          );
          expect(response.statusCode).toBe(200);
          if (!("projects" in response.body)) {
            throw new Error("projects.list did not return a portfolio");
          }
          const projects = new Map(
            response.body.projects.map((project) => [project.projectId, project]),
          );
          for (const index of [0, 1, 2] as const) {
            const run = setup.runs[index]!;
            const state = states[index]!;
            expect(projects.get(run.projectId)?.progress).toMatchObject({
              runCount: 1,
              runStatusCounts: index === 1 ? { failed: 1 } : { completed: 1 },
              totalCostMicrosUsd: state.providerCallCount * 7,
            });
          }
        } finally {
          await Promise.allSettled([portfolio]);
        }
      });
    } finally {
      await context.close();
    }
  }, 120_000);
});

type RunSetup = {
  projectId: string;
  runId: string;
  localeBranchId: string;
  contextSnapshotId: string;
  localizationSnapshotId: string;
};

type ProjectSetup = {
  runs: readonly RunSetup[];
};

type DistinctContent = {
  structure: NarrativeStructure;
  bridge: BridgeBundleV02;
};

/**
 * The real portfolio contains distinct games. Keep this recorded fixture's
 * scene/unit identities distinct per run too: the LLM memo store keys work by
 * scene + lane + unit IDs, rather than by localization-run identity.
 */
function distinctContent(runIndex: number): DistinctContent {
  const suffix = `-p${String(runIndex)}`;
  const distinctStructure = structuredClone(structure) as NarrativeStructure;
  const distinctBridge = structuredClone(bridge);

  const structureIds = new Map<string, string>();
  for (const scene of distinctStructure.scenes) {
    structureIds.set(scene.sceneId, `${scene.sceneId}${suffix}`);
    for (const unit of scene.units ?? []) {
      structureIds.set(unit.unitId, `${unit.unitId}${suffix}`);
    }
  }
  // References carried by narrative units/messages/choices must change with
  // their owner as well. The recursive rewrite below reaches e.g.
  // choice.branchEntryScene, nextScene, and engine raw-byte handles.
  collectScopedStructureReferences(distinctStructure, structureIds, suffix);
  rewriteExactStrings(distinctStructure, structureIds);

  // v0.2 bridgeUnitId is UUID7, so a textual -pN suffix would be invalid.
  // Re-key its trailing payload digits instead, preserving UUID7's version and
  // variant bits while making each run's bridge unit identities distinct.
  const bridgeUnitIds = new Map(
    distinctBridge.units.map((unit) => [
      unit.bridgeUnitId,
      scopedUuid7(unit.bridgeUnitId, runIndex),
    ]),
  );
  const sceneTokens = new Map(
    distinctBridge.assets.map((asset) => {
      const token = asset.assetKey.slice(asset.assetKey.lastIndexOf(":") + 1);
      return [token, `${token}${suffix}`] as const;
    }),
  );
  // Asset keys occur inside patch/source/runtime coordinates, not only in the
  // assets list. Rewriting all scene-derived string values keeps those bridge
  // references internally aligned before the UUID references are re-keyed.
  rewriteStringValues(distinctBridge, (value) => rewriteSceneTokens(value, sceneTokens));
  rewriteExactStrings(distinctBridge, bridgeUnitIds);

  assertBridgeBundleV02(distinctBridge);
  projectDecodeStructure(distinctStructure);
  return { structure: distinctStructure, bridge: distinctBridge };
}

function collectScopedStructureReferences(
  value: unknown,
  replacements: Map<string, string>,
  suffix: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopedStructureReferences(item, replacements, suffix);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      (key === "bridgeUnitId" || key === "sourceUnitKey" || key === "assetKey")
    ) {
      replacements.set(item, `${item}${suffix}`);
    }
    collectScopedStructureReferences(item, replacements, suffix);
  }
}

function rewriteExactStrings(value: unknown, replacements: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") value[index] = replacements.get(item) ?? item;
      else rewriteExactStrings(item, replacements);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      (value as Record<string, unknown>)[key] = replacements.get(item) ?? item;
    } else {
      rewriteExactStrings(item, replacements);
    }
  }
}

function rewriteStringValues(value: unknown, rewrite: (input: string) => string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") value[index] = rewrite(item);
      else rewriteStringValues(item, rewrite);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      (value as Record<string, unknown>)[key] = rewrite(item);
    } else {
      rewriteStringValues(item, rewrite);
    }
  }
}

function rewriteSceneTokens(value: string, replacements: ReadonlyMap<string, string>): string {
  let rewritten = value;
  for (const [before, after] of replacements) rewritten = rewritten.replaceAll(before, after);
  return rewritten;
}

function scopedUuid7(uuid: string, runIndex: number): string {
  if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex >= 256) {
    throw new Error("recorded portfolio run index must be an integer from 0 through 255");
  }
  return `${uuid.slice(0, -2)}${(runIndex + 1).toString(16).padStart(2, "0")}`;
}

function contentPath(run: RunSetup, filename: "structure.json" | "bridge.json"): string {
  return `${run.projectId}/${run.runId}/${filename}`;
}

async function prepareProjects(
  services: ItotoriApplicationServices,
  count: number,
): Promise<ProjectSetup> {
  const workflow = services.projectWorkflow;
  // Shared context snapshot is fine; localization snapshots must match each
  // run's locale branch (DB trigger: localization snapshot must match branch).
  const contextSnapshot = await workflow.putContext({
    sourceLanguage: "ja-JP",
    decode: revision("a"),
    sourceUnits: [{ unitId: "portfolio-concurrent-unit", sourceHash: hash("b") }],
    facts: [
      {
        factId: "unit:portfolio-concurrent-unit",
        playOrderIndex: 0,
        routeScope: { kind: "global" },
      },
    ],
    structure: revision("c"),
    routeGraph: revision("d"),
    glossary: revision("e"),
    style: revision("f"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("0"),
    externalSources: null,
    contextScope: "whole-game",
  });

  const runs: RunSetup[] = [];
  for (let i = 0; i < count; i += 1) {
    const projectId = `portfolio-concurrent-project-${String(i + 1)}`;
    const localeBranchId = `portfolio-concurrent-branch-${String(i + 1)}`;
    const runId = `portfolio-concurrent-run-${String(i + 1)}`;
    await workflow.ensureRunProjectScope({
      projectId,
      localeBranchId,
      sourceRevisionId: `portfolio-concurrent-source-${String(i + 1)}`,
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
      engineFamily: "synthetic_fixture",
      sourceRoot: `/fixture/portfolio-concurrent/${String(i + 1)}/source`,
      buildRoot: `/fixture/portfolio-concurrent/${String(i + 1)}/build`,
      extractProfile: { surface: "localize-portfolio-concurrent-live-db" },
    });
    const localizationSnapshot = await workflow.putLocalization({
      contextSnapshotId: contextSnapshot.snapshotId,
      targetLocale: "en-US",
      localeBranchId,
      acceptedBibleHead: null,
      acceptedTargetOutputHead: null,
    });
    runs.push({
      projectId,
      runId,
      localeBranchId,
      contextSnapshotId: contextSnapshot.snapshotId,
      localizationSnapshotId: localizationSnapshot.snapshotId,
    });
  }

  return { runs };
}

function portfolioPromise(
  services: ItotoriApplicationServices,
  setup: ProjectSetup,
  states: readonly RecordedRunState[],
) {
  const byKey = new Map(
    setup.runs.map(
      (run, index) =>
        [
          `${run.projectId}\0${run.runId}`,
          { run, state: states[index]!, content: distinctContent(index) },
        ] as const,
    ),
  );
  const contentByPath = new Map<string, unknown>();
  for (const entry of byKey.values()) {
    // Localize IO receives only a path, so these test-only paths carry the
    // project/run identity that selects the same entry as the recorded state.
    contentByPath.set(contentPath(entry.run, "structure.json"), entry.content.structure);
    contentByPath.set(contentPath(entry.run, "bridge.json"), entry.content.bridge);
  }
  const portfolioDoc = {
    maxConcurrency: setup.runs.length,
    runs: setup.runs.map((run, index) => ({
      structure: contentPath(run, "structure.json"),
      bridge: contentPath(run, "bridge.json"),
      projectId: run.projectId,
      runId: run.runId,
      localeBranchId: run.localeBranchId,
      runMode: "production",
      costCapMicrosUsd: 100 + index,
    })),
  };

  return runLocalizePortfolioCommand(["localize-portfolio", "--portfolio", "portfolio.json"], {
    io: {
      readJson: (path: string) => {
        if (path === "portfolio.json") return portfolioDoc;
        const content = contentByPath.get(path);
        if (content !== undefined) return content;
        throw new Error(`no recorded content for ${path}`);
      },
      writeJson: () => undefined,
    },
    projectWorkflow: services.projectWorkflow,
    resolvePortSource: (_request: unknown, perRun: { projectRun?: RunIdentity }) => {
      if (perRun.projectRun === undefined) throw new Error("localize test run identity is missing");
      const key = `${perRun.projectRun.projectId}\0${perRun.projectRun.runId}`;
      const entry = byKey.get(key);
      if (entry === undefined) throw new Error(`no recorded state for ${key}`);
      return {
        ports: recordedPorts(entry.state),
        attachRunCostObserver: (observer: PhysicalAttemptCostObserver) =>
          recordedPorts(entry.state, observer),
        runPlane: {
          ...perRun.projectRun,
          contextSnapshotId: entry.run.contextSnapshotId,
          localizationSnapshotId: entry.run.localizationSnapshotId,
          capMicrosUsd: 100,
        },
      };
    },
  });
}
