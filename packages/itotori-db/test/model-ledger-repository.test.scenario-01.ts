import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriModelLedgerRepository,
  type ProviderRunLedgerInput,
} from "../src/repositories/model-ledger-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import {
  artifacts,
  costLedgerEntries,
  modelProviders,
  modelRegistry,
  promptPresets,
  providerRuns,
  translationMemoryReuseEvents,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import { runInput, projectFixture } from "./model-ledger-repository.test.shared-01.js";

describe("ItotoriModelLedgerRepository", () => {
  it("persists provider identity, prompt presets, separated costs, and fallback metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-billed", "billed", 1200));
      await ledger.recordProviderRun(
        localActor,
        // The legacy `provider_estimate` variant is gone; the real upstream
        // charge captured by the recorded fallback run tags as `billed` with
        // the actual amount.
        runInput("run-billed-fallback", "billed", 2500, {
          provider: {
            providerFamily: "recorded",
            endpointFamily: "recorded-fixture",
            providerName: "recorded-provider",
            requestedModelId: "fixture-model-v1",
            actualModelId: "fixture-model-v2",
            upstreamProvider: "fixture-upstream",
            routeSettingsHash:
              "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          },
          fallbackUsed: true,
          fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
          retryCount: 1,
          errorClasses: ["provider_timeout_retry"],
          providerPreset: {
            slug: "openrouter/fixture-draft",
            version: "2026-06-17",
            configHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            configSnapshot: {
              providerRouting: {
                order: ["fixture-upstream"],
              },
            },
          },
          adapterMetadata: {
            providerRouting: {
              allowFallbacks: true,
              order: ["fixture-upstream"],
            },
          },
          // Fixture captured-on-wire posture for the recorded-fallback ledger
          // row. Mirrors what a real LIVE OR call would have produced.
          routingPosture: {
            only: ["fixture-upstream"],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        }),
      );
      await ledger.recordProviderRun(localActor, runInput("run-zero", "zero", 0));

      const report = await ledger.getProjectCostReport(localActor, "project-test");

      expect(report).toMatchObject({
        projectId: "project-test",
        runCount: 3,
        billedMicrosUsd: 3700,
        zeroRunCount: 1,
      });
      expect(report.totalsByCostKind).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ costKind: "billed", runCount: 2, amountMicrosUsd: 3700 }), // cost-audit-allow: synthetic fixture cost, not a real billed amount
          expect.objectContaining({ costKind: "zero", runCount: 1, amountMicrosUsd: 0 }),
        ]),
      );

      const fallbackRun = report.recentRuns.find(
        (run) => run.providerRunId === "run-billed-fallback",
      );
      expect(fallbackRun).toMatchObject({
        providerFamily: "recorded",
        requestedModelId: "fixture-model-v1",
        actualModelId: "fixture-model-v2",
        upstreamProvider: "fixture-upstream",
        routeSettingsHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        promptPresetId: "itotori-test-preset",
        promptTemplateVersion: "1.0.0",
        fallbackUsed: true,
        fallbackPlan: ["fixture-model-v1", "fixture-model-v2"],
        retryCount: 1,
        errorClasses: ["provider_timeout_retry"],
        costKind: "billed",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        routingPosture: expect.objectContaining({
          only: ["fixture-upstream"],
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
          require_parameters: true,
        }),
      });

      const counts = await context.db.execute(sql`
        select
          (select count(*)::int from ${modelProviders}) as provider_count,
          (select count(*)::int from ${modelRegistry}) as model_count,
          (select count(*)::int from ${promptPresets}) as preset_count,
          (select count(*)::int from ${providerRuns}) as provider_run_count,
          (select count(*)::int from ${costLedgerEntries}) as cost_entry_count
      `);
      expect(counts.rows[0]).toMatchObject({
        provider_count: 2,
        model_count: 3,
        preset_count: 1,
        provider_run_count: 3,
        cost_entry_count: 3,
      });
      const providerPreset = await context.db.execute(sql`
        select provider_preset
        from ${providerRuns}
        where provider_run_id = 'run-billed-fallback'
      `);
      expect(providerPreset.rows[0]).toMatchObject({
        provider_preset: expect.objectContaining({
          slug: "openrouter/fixture-draft",
          configSnapshot: expect.objectContaining({
            providerRouting: { order: ["fixture-upstream"] },
          }),
        }),
      });
    } finally {
      await context.close();
    }
  });

  it("records failed provider runs as zero-cost ledger entries", async () => {
    // Failed runs incur no upstream charge, so they record as `zero` with
    // `amountMicrosUsd: 0`. The legacy `unknown` variant is gone; the
    // migration's CHECK constraint refuses it at the storage layer.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(
        localActor,
        runInput("run-failed-http", "zero", 0, {
          status: "failed",
          errorClasses: ["provider_http_error", "http_500"],
          tokenUsage: { tokenCountSource: "unknown" },
        }),
      );

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report).toMatchObject({
        runCount: 1,
        zeroRunCount: 1,
        billedMicrosUsd: 0,
      });
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-failed-http",
        status: "failed",
        costKind: "zero",
        amountMicrosUsd: 0,
        tokenCountSource: "unknown",
      });
    } finally {
      await context.close();
    }
  });

  it("builds provider-run throughput and cost-per-run timeseries from the persisted ledger", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(
        localActor,
        runInput("run-series-day-1a", "billed", 1200, {
          startedAt: "2026-06-16T10:15:00.000Z",
          completedAt: "2026-06-16T10:15:01.000Z",
        }),
      );
      await ledger.recordProviderRun(
        localActor,
        runInput("run-series-day-2a", "billed", 600, {
          startedAt: "2026-06-17T10:15:00.000Z",
          completedAt: "2026-06-17T10:15:01.000Z",
        }),
      );
      await ledger.recordProviderRun(
        localActor,
        runInput("run-series-day-2b", "zero", 0, {
          startedAt: "2026-06-17T11:15:00.000Z",
          completedAt: "2026-06-17T11:15:01.000Z",
        }),
      );

      const timeseries = await ledger.getProjectTelemetryTimeseries(localActor, "project-test");

      expect(timeseries).toEqual({
        projectId: "project-test",
        bucket: "day",
        rows: [
          {
            bucketStart: "2026-06-16T00:00:00.000Z",
            runCount: 1,
            billedMicrosUsd: 1200, // cost-audit-allow: synthetic fixture cost, not a real billed amount
            costPerRunMicrosUsd: 1200, // cost-audit-allow: synthetic fixture cost, not a real billed amount
          },
          {
            bucketStart: "2026-06-17T00:00:00.000Z",
            runCount: 2,
            billedMicrosUsd: 600, // cost-audit-allow: synthetic fixture cost, not a real billed amount
            costPerRunMicrosUsd: 300, // cost-audit-allow: synthetic fixture cost, not a real billed amount
          },
        ],
        throughputSeries: [1, 2],
        costPerRunSeries: [1200, 300],
      });
    } finally {
      await context.close();
    }
  });

  it("rejects ledger writes attempting to revive a legacy cost-kind value", async () => {
    // Every layer (typed input, validation, SQL CHECK) must refuse a write
    // that tries to insert 'unknown'/'provider_estimate'/'local_estimate'.
    // We bypass the type system on purpose so the runtime guard's behavior
    // is observable.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-legacy-revival", "billed", 100, {
            cost: {
              costKind: "provider_estimate" as unknown as "billed", // cost-audit-allow: this test asserts the runtime guard rejects the legacy enum.
              currency: "USD",
              amountMicrosUsd: 100, // cost-audit-allow: synthetic fixture cost, not a real billed amount
            },
          }),
        ),
      ).rejects.toThrow(/cost kind|cost_kind/iu);
    } finally {
      await context.close();
    }
  });

  it("rejects provider runs with missing fallback chain or token drift", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-empty-fallback", "zero", 0, { fallbackPlan: [] }),
        ),
      ).rejects.toThrow(/fallbackPlan/u);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-token-drift", "zero", 0, {
            tokenUsage: {
              tokenCountSource: "provider_reported",
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 12,
            },
          }),
        ),
      ).rejects.toThrow(/totalTokens/u);

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report.runCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("rejects provider runs when reasoning tokens make total tokens drift", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-reasoning-token-drift", "zero", 0, {
            tokenUsage: {
              tokenCountSource: "provider_reported",
              promptTokens: 10,
              completionTokens: 5,
              reasoningTokens: 3,
              totalTokens: 15,
            },
          }),
        ),
      ).rejects.toThrow(/reasoningTokens/u);

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report.runCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("records unknown token sources with component counters but no total", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(
        localActor,
        // The cost-kind narrowing does not affect token-count-source
        // semantics; unknown token sources can still pair with a zero-cost
        // ledger entry (e.g. a failed run whose token usage we couldn't read
        // off the upstream response).
        runInput("run-unknown-token-components", "zero", 0, {
          tokenUsage: {
            tokenCountSource: "unknown",
            promptTokens: 10,
            completionTokens: 5,
            reasoningTokens: 3,
            cachedInputTokens: 2,
          },
        }),
      );

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-unknown-token-components",
        tokenCountSource: "unknown",
        promptTokens: 10,
        completionTokens: 5,
        reasoningTokens: 3,
        cachedInputTokens: 2,
        totalTokens: null,
      });
    } finally {
      await context.close();
    }
  });

  it("atomically records benchmark artifacts with skipped partial-timing provider runs", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());

      await projectRepository.recordBenchmarkArtifactWithProviderLedger(localActor, {
        artifact: {
          artifactId: "benchmark-artifact-skipped",
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          artifactKind: "benchmark_report",
          metadata: {
            schemaVersion: "0.2.0",
            benchmarkName: "skipped provider timing fixture",
          },
        },
        providerRuns: [
          runInput("run-skipped-partial-timing", "zero", 0, {
            status: "skipped",
            completedAt: undefined,
            latencyMs: undefined,
            tokenUsage: { tokenCountSource: "unknown" },
            // Skipped runs have no upstream charge; we record them as
            // zero-cost rather than the deprecated 'unknown' variant.
            cost: { costKind: "zero", currency: "USD", amountMicrosUsd: 0 },
          }),
        ],
      });

      const report = await new ItotoriModelLedgerRepository(context.db).getProjectCostReport(
        localActor,
        "project-test",
      );
      expect(report).toMatchObject({
        runCount: 1,
        zeroRunCount: 1,
        billedMicrosUsd: 0,
      });
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-skipped-partial-timing",
        status: "skipped",
        costKind: "zero",
        tokenCountSource: "unknown",
      });

      const rows = await context.db.execute(sql`
        select
          (select count(*)::int from ${artifacts} where artifact_id = 'benchmark-artifact-skipped')
            as artifact_count,
          (select completed_at from ${providerRuns} where provider_run_id = 'run-skipped-partial-timing')
            as completed_at,
          (select latency_ms from ${providerRuns} where provider_run_id = 'run-skipped-partial-timing')
            as latency_ms
      `);
      expect(rows.rows[0]).toMatchObject({
        artifact_count: 1,
        completed_at: null,
        latency_ms: null,
      });
    } finally {
      await context.close();
    }
  });
});
