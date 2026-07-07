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
  translationMemorySegments,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

describe("ItotoriModelLedgerRepository", () => {
  it("persists provider identity, prompt presets, separated costs, and fallback metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-billed", "billed", 1200));
      await ledger.recordProviderRun(
        localActor,
        // ITOTORI-225 — the legacy `provider_estimate` variant is gone;
        // the real upstream charge captured by the recorded fallback run
        // tags as `billed` with the actual amount.
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
          // ITOTORI-230 — fixture captured-on-wire posture for the
          // recorded-fallback ledger row. Mirrors what a real LIVE OR
          // call would have produced.
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
          expect.objectContaining({ costKind: "billed", runCount: 2, amountMicrosUsd: 3700 }), // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
    // ITOTORI-225 — failed runs incur no upstream charge, so they record
    // as `zero` with `amountMicrosUsd: 0`. The legacy `unknown` variant
    // is gone; the migration's CHECK constraint refuses it at the storage
    // layer.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
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

  it("rejects ledger writes attempting to revive a legacy cost-kind value", async () => {
    // ITOTORI-225 — every layer (typed input, validation, SQL CHECK) must
    // refuse a write that tries to insert 'unknown'/'provider_estimate'/
    // 'local_estimate'. We bypass the type system on purpose so the
    // runtime guard's behavior is observable.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-legacy-revival", "billed", 100, {
            cost: {
              costKind: "provider_estimate" as unknown as "billed", // itotori-225-audit-allow: this test asserts the runtime guard rejects the legacy enum.
              currency: "USD",
              amountMicrosUsd: 100, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
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
      const projectRepository = new ItotoriProjectRepository(context.db);
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
      const projectRepository = new ItotoriProjectRepository(context.db);
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
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(
        localActor,
        // The cost-kind narrowing (ITOTORI-225) does not affect token-count-
        // source semantics; unknown token sources can still pair with a
        // zero-cost ledger entry (e.g. a failed run whose token usage we
        // couldn't read off the upstream response).
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
      const projectRepository = new ItotoriProjectRepository(context.db);
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
            // ITOTORI-225 — skipped runs have no upstream charge; we
            // record them as zero-cost rather than the deprecated
            // 'unknown' variant.
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

  it("rolls back benchmark artifacts and ledger rows when provider ledger ingestion conflicts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      await ledger.recordProviderRun(localActor, runInput("run-conflict-existing", "zero", 0));

      await expect(
        projectRepository.recordBenchmarkArtifactWithProviderLedger(localActor, {
          artifact: {
            artifactId: "benchmark-artifact-rollback",
            projectId: "project-test",
            localeBranchId: "locale-en-us",
            artifactKind: "benchmark_report",
            metadata: {
              schemaVersion: "0.2.0",
              benchmarkName: "rollback fixture",
            },
          },
          providerRuns: [
            runInput("run-before-conflict", "zero", 0),
            runInput("run-conflict-existing", "zero", 0),
          ],
        }),
      ).rejects.toThrow();

      const rows = await context.db.execute(sql`
        select
          (select count(*)::int from ${artifacts} where artifact_id = 'benchmark-artifact-rollback')
            as artifact_count,
          (select count(*)::int from ${providerRuns} where provider_run_id = 'run-before-conflict')
            as rolled_back_provider_count,
          (select count(*)::int from ${providerRuns} where provider_run_id = 'run-conflict-existing')
            as existing_provider_count
      `);
      expect(rows.rows[0]).toMatchObject({
        artifact_count: 0,
        rolled_back_provider_count: 0,
        existing_provider_count: 1,
      });

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report).toMatchObject({
        runCount: 1,
        zeroRunCount: 1,
      });
    } finally {
      await context.close();
    }
  });

  it("rejects unknown token sources with totalTokens", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-unknown-token-totals", "zero", 0, {
            tokenUsage: {
              tokenCountSource: "unknown",
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            },
          }),
        ),
      ).rejects.toThrow(/unknown tokenCountSource/u);

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report.runCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("rejects typo token count sources", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-token-source-typo", "zero", 0, {
            tokenUsage: {
              tokenCountSource: "provider-reported",
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            } as ProviderRunLedgerInput["tokenUsage"],
          }),
        ),
      ).rejects.toThrow(/tokenUsage\.tokenCountSource/u);

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report.runCount).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps provider run and cost rows append-only for duplicate run ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-append-only", "billed", 100));
      await expect(
        ledger.recordProviderRun(localActor, runInput("run-append-only", "billed", 999)),
      ).rejects.toThrow();

      const report = await ledger.getProjectCostReport(localActor, "project-test");
      expect(report).toMatchObject({
        runCount: 1,
        billedMicrosUsd: 100,
      });
      expect(report.recentRuns[0]).toMatchObject({
        providerRunId: "run-append-only",
        amountMicrosUsd: 100, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
      });
    } finally {
      await context.close();
    }
  });

  it("model-ledger-repository.test.ts ZDR-enforced count coverage — countZdrEnforcedByPair returns ZDR-enforced count per pair", async () => {
    // ITOTORI-230 — acceptance criterion #3 schema check: insert two
    // rows with `routing_posture->>'zdr' = 'true'` and one with
    // `'false'`; assert the count by pair returns 2 enforced / 3 total.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-zdr-1", "billed", 100));
      await ledger.recordProviderRun(localActor, runInput("run-zdr-2", "billed", 200));
      await ledger.recordProviderRun(
        localActor,
        runInput("run-non-zdr", "billed", 50, {
          // ITOTORI-230 — explicit non-ZDR posture (public input would
          // typically carry this shape on the wire).
          routingPosture: {
            only: ["itotori-fixture"],
            allow_fallbacks: false,
            data_collection: "allow",
            zdr: false,
            require_parameters: true,
          },
        }),
      );

      const rows = await ledger.countZdrEnforcedByPair(localActor, "project-test", {
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-30T23:59:59Z"),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        modelId: "itotori-fake-draft-v0",
        invocationCount: 3,
        zdrEnforcedCount: 2,
      });
    } finally {
      await context.close();
    }
  });

  it("counts cost kinds by pair over a post-run window", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-cost-kind-billed", "billed", 150));
      await ledger.recordProviderRun(localActor, runInput("run-cost-kind-zero", "zero", 0));

      const rows = await ledger.countCostKindsByPair(localActor, "project-test", {
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-30T23:59:59Z"),
      });
      expect(rows).toEqual([
        expect.objectContaining({
          modelId: "itotori-fake-draft-v0",
          providerId: expect.any(String),
          costKind: "billed",
          invocationCount: 1,
          amountMicrosUsd: 150, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount
        }),
        expect.objectContaining({
          modelId: "itotori-fake-draft-v0",
          providerId: expect.any(String),
          costKind: "zero",
          invocationCount: 1,
          amountMicrosUsd: 0,
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  // ITOTORI-053 — cost drilldown: project/system/time filters, deterministic
  // pagination, zero-vs-unknown distinction, and adapter-metadata sanitization.
  async function seedDrilldownRuns(
    context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  ): Promise<void> {
    const ledger = new ItotoriModelLedgerRepository(context.db);
    // Earliest → latest so `started_at desc` orders [a, b, c, d].
    await ledger.recordProviderRun(
      localActor,
      runInput("run-d-unknown", "billed", 300, {
        systemId: "system-a",
        startedAt: "2026-06-17T00:00:00.000Z",
        completedAt: "2026-06-17T00:00:10.000Z",
      }),
    );
    await ledger.recordProviderRun(
      localActor,
      runInput("run-c-billed", "billed", 500, {
        systemId: "system-b",
        startedAt: "2026-06-17T00:01:00.000Z",
        completedAt: "2026-06-17T00:01:10.000Z",
      }),
    );
    await ledger.recordProviderRun(
      localActor,
      runInput("run-b-zero", "zero", 0, {
        systemId: "system-a",
        startedAt: "2026-06-17T00:02:00.000Z",
        completedAt: "2026-06-17T00:02:10.000Z",
      }),
    );
    await ledger.recordProviderRun(
      localActor,
      runInput("run-a-billed", "billed", 1200, {
        systemId: "system-a",
        startedAt: "2026-06-17T00:03:00.000Z",
        completedAt: "2026-06-17T00:03:10.000Z",
        adapterMetadata: {
          providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
          // A raw provider payload that MUST be stripped from the drilldown.
          rawResponse: { choices: [{ message: { content: "leaked body" } }] },
        },
      }),
    );
    // Turn run-d into an UNRECORDED-cost row by removing its cost ledger entry
    // (no cost row => unknown; distinct from an explicit zero-billed record).
    await context.db.execute(
      sql`delete from ${costLedgerEntries} where provider_run_id = 'run-d-unknown'`,
    );
  }

  it("filters the cost drilldown by project with deterministic ordering + pagination metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await seedDrilldownRuns(context);
      const ledger = new ItotoriModelLedgerRepository(context.db);

      const page = await ledger.getCostLedgerDrilldown(localActor, { projectId: "project-test" });

      expect(page.filter).toEqual({
        projectId: "project-test",
        systemId: null,
        from: null,
        to: null,
      });
      expect(page.pagination).toMatchObject({
        total: 4,
        limit: 20,
        offset: 0,
        page: 1,
        pageCount: 1,
        hasMore: false,
        nextOffset: null,
      });
      expect(page.rows.map((row) => row.providerRunId)).toEqual([
        "run-a-billed",
        "run-b-zero",
        "run-c-billed",
        "run-d-unknown",
      ]);
    } finally {
      await context.close();
    }
  });

  it("renders zero-cost and unknown-cost drilldown rows as DISTINCT states", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await seedDrilldownRuns(context);
      const ledger = new ItotoriModelLedgerRepository(context.db);

      const page = await ledger.getCostLedgerDrilldown(localActor, { projectId: "project-test" });
      const byId = new Map(page.rows.map((row) => [row.providerRunId, row]));

      const billed = byId.get("run-a-billed")!;
      expect(billed.cost.state).toBe("billed");
      if (billed.cost.state !== "billed") throw new Error("expected billed");
      expect(billed.cost.amountMicrosUsd).toBe(1200);
      // codex-audit-fix: displayAmountUsd is the micros-DERIVED display
      // string (NOT the canonical ProviderCost.amountUsd — the ledger row
      // stores integer micros only).
      expect(billed.cost.displayAmountUsd).toBe("0.0012");

      const zero = byId.get("run-b-zero")!;
      expect(zero.cost.state).toBe("zero");
      if (zero.cost.state !== "zero") throw new Error("expected zero");
      expect(zero.cost.amountMicrosUsd).toBe(0);
      expect(zero.cost.displayAmountUsd).toBe("0");

      const unknown = byId.get("run-d-unknown")!;
      // UNRECORDED cost — a distinct state carrying NO amount fields, never
      // collapsed to a $0.00 billed record.
      expect(unknown.cost).toEqual({ state: "unknown" });
      expect(unknown.cost).not.toEqual(zero.cost);
      expect(Object.prototype.hasOwnProperty.call(unknown.cost, "amountMicrosUsd")).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("exposes provider adapter metadata WITHOUT surfacing raw provider payloads", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await seedDrilldownRuns(context);
      const ledger = new ItotoriModelLedgerRepository(context.db);

      const page = await ledger.getCostLedgerDrilldown(localActor, { projectId: "project-test" });
      const billed = page.rows.find((row) => row.providerRunId === "run-a-billed")!;

      expect(billed.provider).toMatchObject({
        providerFamily: "fake",
        endpointFamily: "chat-completions",
        providerName: "itotori-fixture",
        requestedModelId: "itotori-fake-draft-v0",
        actualModelId: "itotori-fake-draft-v0",
      });
      // The curated adapter metadata is exposed…
      expect(billed.provider.adapterMetadata).toMatchObject({
        providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
      });
      // …but the raw provider payload keys are stripped at every depth.
      const serialized = JSON.stringify(billed.provider.adapterMetadata);
      expect(billed.provider.adapterMetadata).not.toHaveProperty("rawResponse");
      expect(serialized).not.toContain("leaked body");
      expect(serialized).not.toContain("choices");
    } finally {
      await context.close();
    }
  });

  // codex-audit-fix FIX 1 (P1) — the drilldown reads rows whose cost ledger
  // stores INTEGER MICROS only (no full-precision decimal column). A row whose
  // true upstream cost was sub-micro (e.g. 0.00000602) is rounded to micros
  // (6 → 0.000006) at storage time. The drilldown MUST present that
  // micros-derived value under an HONEST name (displayAmountUsd), NOT under
  // the canonical `amountUsd` name (which the rest of the codebase reserves
  // for the authoritative full-precision decimal). This test proves the
  // drilldown does not fabricate canonical fidelity it does not have.
  it("does not fabricate canonical cost fidelity: displayAmountUsd is micros-derived, NOT amountUsd", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      // A sub-micro cost: the true upstream decimal was 0.00000602, but the
      // ledger can only store integer micros (6). The drilldown reads 6 micros
      // and derives displayAmountUsd "0.000006" — NOT "0.00000602".
      await ledger.recordProviderRun(
        localActor,
        runInput("run-sub-micro", "billed", 6, {
          systemId: "system-a",
          startedAt: "2026-06-17T00:04:00.000Z",
          completedAt: "2026-06-17T00:04:10.000Z",
        }),
      );

      const page = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
      });
      const row = page.rows.find((r) => r.providerRunId === "run-sub-micro")!;
      expect(row).toBeDefined();
      expect(row.cost.state).toBe("billed");
      if (row.cost.state !== "billed") throw new Error("expected billed");

      // The integer micros are the SOURCE OF TRUTH for this row.
      expect(row.cost.amountMicrosUsd).toBe(6);
      // displayAmountUsd is the micros-DERIVED decimal (6 micros → 0.000006),
      // NOT the true upstream 0.00000602. This is honest about its precision.
      expect(row.cost.displayAmountUsd).toBe("0.000006");
      expect(row.cost.displayAmountUsd).not.toBe("0.00000602");

      // The canonical `amountUsd` field MUST NOT exist on the drilldown row:
      // presenting a micros-rounded value under the canonical name would
      // imply a fidelity the ledger row does not have.
      expect(Object.prototype.hasOwnProperty.call(row.cost, "amountUsd")).toBe(false);
    } finally {
      await context.close();
    }
  });

  // codex-audit-followup (P1, privacy hard boundary) — sanitizeAdapterMetadata
  // is now a default-deny PROJECTION of known-safe fields into a new object,
  // NOT a key filter over the untrusted object. Arbitrary adapter metadata is
  // stored, so raw-payload keys (`raw_response`, `responseText`,
  // `providerOutput`, `output`, `result`, future wrappers) are never projected
  // and can never appear. These negative tests prove that a raw body nested
  // inside an array or a non-safe wrapper object is also excluded at every
  // depth (it is simply never visited by the projectors).
  it("sanitizeAdapterMetadata projects only known-safe fields; raw-payload synonyms AND nested raw bodies never surface (default-deny)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      // Adapter metadata carrying a CURATED safe field PLUS every raw-payload
      // synonym the old denylist missed, AND a nested raw body inside an
      // array and a non-allowlisted wrapper.
      await ledger.recordProviderRun(
        localActor,
        runInput("run-allowlist", "billed", 1200, {
          systemId: "system-a",
          startedAt: "2026-06-17T00:05:00.000Z",
          completedAt: "2026-06-17T00:05:10.000Z",
          adapterMetadata: {
            // The ONLY key that should survive (plus its nested allowlisted
            // routing keys).
            providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
            generationId: "gen-test-allowlist",
            // snake_case / raw synonyms the old denylist did NOT cover — all
            // must be dropped by the allowlist.
            raw_response: { choices: [{ message: { content: "leaked snake" } }] },
            responseText: "leaked responseText body",
            providerOutput: { leaked: "providerOutput body" },
            output: { leaked: "output body" },
            result: { leaked: "result body" },
            // A future-unknown wrapper key (not in any list) — dropped.
            futureWrapper: { secret: "leaked future wrapper" },
            // A nested array containing a raw body — the array element's
            // non-allowlisted keys must be dropped at depth.
            nestedArray: [{ order: ["safe-inside-array"], rawResponse: "leaked array body" }],
            // A non-allowlisted wrapper carrying a safe-nested key — the
            // wrapper is dropped, so its child is gone too (default-deny at
            // every depth).
            unknownWrapper: { providerRouting: { order: ["hidden-inside"] } },
          },
        }),
      );

      const page = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
      });
      const row = page.rows.find((r) => r.providerRunId === "run-allowlist")!;
      const meta = row.provider.adapterMetadata;
      const serialized = JSON.stringify(meta);

      // The curated safe fields survive.
      expect(meta).toMatchObject({
        providerRouting: { order: ["fixture-upstream"], allowFallbacks: false },
        generationId: "gen-test-allowlist",
      });

      // Every raw-payload synonym the old denylist missed is excluded.
      expect(meta).not.toHaveProperty("raw_response");
      expect(meta).not.toHaveProperty("responseText");
      expect(meta).not.toHaveProperty("providerOutput");
      expect(meta).not.toHaveProperty("output");
      expect(meta).not.toHaveProperty("result");
      expect(serialized).not.toContain("leaked snake");
      expect(serialized).not.toContain("leaked responseText body");
      expect(serialized).not.toContain("leaked providerOutput body");
      expect(serialized).not.toContain("leaked output body");
      expect(serialized).not.toContain("leaked result body");

      // The future-unknown wrapper is excluded (default-deny).
      expect(meta).not.toHaveProperty("futureWrapper");
      expect(serialized).not.toContain("leaked future wrapper");

      // The nested array's non-allowlisted keys are excluded at depth; the
      // array itself is dropped (nestedArray is not allowlisted), so neither
      // its safe nor its raw contents surface.
      expect(meta).not.toHaveProperty("nestedArray");
      expect(serialized).not.toContain("leaked array body");

      // The non-allowlisted wrapper is dropped wholesale; its child does not
      // surface even though the child key would have been allowlisted on its
      // own (the allowlist is applied recursively at every depth, but the
      // parent key gates whether the child is visited at all).
      expect(meta).not.toHaveProperty("unknownWrapper");
      expect(serialized).not.toContain("hidden-inside");
    } finally {
      await context.close();
    }
  });

  // codex-audit-followup (P1, privacy hard boundary) — the OpenRouter adapter
  // mirrors the raw `openrouter_metadata` response fragment VERBATIM into
  // `adapterMetadata.openrouterMetadata`, and that fragment can carry a raw
  // provider request/response body (`choices`, `messages`, `endpoints`,
  // `response`). The projection must NOT mirror openrouterMetadata wholesale:
  // only its known-safe scalar observability fields (+ the selected endpoint's
  // scalar provider/model) may surface. It must also be context-aware: a
  // generic `source` / `summary` key carrying a payload OBJECT is not passed
  // through — `source` is a top-level scalar tag only, `summary` is an
  // openrouterRouting scalar only.
  it("projects openrouterMetadata to safe scalars only (no wholesale mirror) and is context-aware for source/summary", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      await ledger.recordProviderRun(
        localActor,
        runInput("run-orm-boundary", "billed", 1400, {
          systemId: "system-a",
          startedAt: "2026-06-17T00:06:00.000Z",
          completedAt: "2026-06-17T00:06:10.000Z",
          adapterMetadata: {
            // (a) openrouterMetadata mirrored verbatim, carrying a RAW body.
            openrouterMetadata: {
              // safe scalar observability fields — projected.
              requested: "deepseek/deepseek-v4",
              strategy: "fallback",
              attempt: 2,
              summary: "fireworks 429; served by deepinfra",
              // the SELECTED endpoint's scalar provider/model is the served
              // route identity — projected as `servedRoute`.
              endpoints: {
                available: [
                  {
                    provider: "DeepInfra",
                    model: "deepseek/deepseek-v4",
                    selected: true,
                    // a raw pricing/body blob hanging off the endpoint — dropped.
                    raw: { pricing: { prompt: "secret" } },
                  },
                ],
              },
              // RAW provider request/response fragments — must NEVER surface.
              choices: [{ message: { content: "leaked ORM choices body" } }],
              messages: [{ role: "user", content: "leaked ORM prompt" }],
              response: { body: "leaked ORM response body" },
            },
            openrouterRouting: {
              // safe scalar — projected.
              summary: "served by deepinfra",
              // a raw object smuggled under summary at depth — dropped (summary
              // is projected as a scalar only).
              attempts: [{ provider: "Fireworks", status: "429", raw: "leaked attempt body" }],
            },
            // (b) generic top-level `source` carrying a payload OBJECT — dropped
            // (source is projected as a scalar tag only). A scalar source WOULD
            // survive, but an object must not.
            source: { leaked: "leaked source payload object" },
            generationId: "gen-orm-boundary",
          },
        }),
      );

      const page = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
      });
      const row = page.rows.find((r) => r.providerRunId === "run-orm-boundary")!;
      const meta = row.provider.adapterMetadata;
      const serialized = JSON.stringify(meta);

      // openrouterMetadata is projected to safe scalars + the served route.
      expect(meta).toMatchObject({
        openrouterMetadata: {
          requested: "deepseek/deepseek-v4",
          strategy: "fallback",
          attempt: 2,
          summary: "fireworks 429; served by deepinfra",
          servedRoute: { provider: "DeepInfra", model: "deepseek/deepseek-v4" },
        },
        openrouterRouting: { summary: "served by deepinfra" },
        generationId: "gen-orm-boundary",
      });

      // (a) the raw body fragments under openrouterMetadata NEVER surface.
      const orm = (meta as Record<string, unknown>).openrouterMetadata as Record<string, unknown>;
      expect(orm).not.toHaveProperty("choices");
      expect(orm).not.toHaveProperty("messages");
      expect(orm).not.toHaveProperty("response");
      expect(orm).not.toHaveProperty("endpoints");
      expect(serialized).not.toContain("leaked ORM choices body");
      expect(serialized).not.toContain("leaked ORM prompt");
      expect(serialized).not.toContain("leaked ORM response body");
      // the raw blob hanging off the selected endpoint is dropped too.
      expect(serialized).not.toContain("secret");
      // the raw per-attempt blob under openrouterRouting.attempts is dropped
      // (only known-safe scalar attempt fields are projected).
      expect(serialized).not.toContain("leaked attempt body");

      // (b) the generic top-level `source` OBJECT is not passed through.
      expect(meta).not.toHaveProperty("source");
      expect(serialized).not.toContain("leaked source payload object");
    } finally {
      await context.close();
    }
  });

  // codex-audit-followup (P1, privacy hard boundary) — the projection is
  // context-aware: a benchmark-ingest run carries a top-level scalar
  // `source: "benchmark_report"` tag that MUST survive (it is a known top-level
  // field), proving default-deny does not over-strip the curated safe set.
  it("surfaces the top-level scalar `source` tag (benchmark ingest) while dropping non-scalar source", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      await ledger.recordProviderRun(
        localActor,
        runInput("run-benchmark-source", "billed", 1500, {
          systemId: "system-a",
          startedAt: "2026-06-17T00:07:00.000Z",
          completedAt: "2026-06-17T00:07:10.000Z",
          adapterMetadata: {
            source: "benchmark_report",
            routeSettingsHash: "sha256:abc123",
          },
        }),
      );

      const page = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
      });
      const row = page.rows.find((r) => r.providerRunId === "run-benchmark-source")!;
      expect(row.provider.adapterMetadata).toEqual({
        source: "benchmark_report",
        routeSettingsHash: "sha256:abc123",
      });
    } finally {
      await context.close();
    }
  });

  // codex-audit-fix FIX 3 (P3) — the drilldown orders by
  // (started_at desc, provider_run_id desc). The tie-break on provider_run_id
  // is in the code but was previously untested. This test seeds multiple
  // EQUAL-started_at rows and asserts the tie-break produces a stable,
  // non-overlapping page boundary ordered by provider_run_id.
  it("breaks started_at ties by provider_run_id desc with stable non-overlapping pages", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);
      // Five rows with the SAME started_at. The tie-break must order them by
      // provider_run_id DESC. Ids are chosen so descending lexical order is
      // unambiguous and different from insertion order.
      const tieStartedAt = "2026-06-17T00:06:00.000Z";
      const tieIds = ["tie-run-1", "tie-run-2", "tie-run-3", "tie-run-4", "tie-run-5"];
      for (const id of tieIds) {
        await ledger.recordProviderRun(
          localActor,
          runInput(id, "billed", 100, {
            systemId: "system-a",
            startedAt: tieStartedAt,
            completedAt: "2026-06-17T00:06:10.000Z",
          }),
        );
      }

      const expectedDesc = [...tieIds].sort().reverse();

      // Page 1 (limit 2): the two highest provider_run_ids.
      const first = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
        limit: 2,
        offset: 0,
      });
      // Page 2 (limit 2): the next two.
      const second = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
        limit: 2,
        offset: 2,
      });
      // Page 3 (limit 2): the last one.
      const third = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
        limit: 2,
        offset: 4,
      });

      // Stable total across all pages.
      expect(first.pagination.total).toBe(5);
      expect(second.pagination.total).toBe(5);
      expect(third.pagination.total).toBe(5);

      // Each page is ordered by provider_run_id desc (the tie-break).
      const firstIds = first.rows.map((r) => r.providerRunId);
      const secondIds = second.rows.map((r) => r.providerRunId);
      const thirdIds = third.rows.map((r) => r.providerRunId);
      expect(firstIds).toEqual(expectedDesc.slice(0, 2));
      expect(secondIds).toEqual(expectedDesc.slice(2, 4));
      expect(thirdIds).toEqual(expectedDesc.slice(4, 5));

      // Pages are disjoint and together cover the full set.
      const allIds = [...firstIds, ...secondIds, ...thirdIds];
      expect(new Set(allIds).size).toBe(5);
      expect(allIds).toEqual(expectedDesc);

      // hasMore / nextOffset agree at each boundary.
      expect(first.pagination.hasMore).toBe(true);
      expect(first.pagination.nextOffset).toBe(2);
      expect(second.pagination.hasMore).toBe(true);
      expect(second.pagination.nextOffset).toBe(4);
      expect(third.pagination.hasMore).toBe(false);
      expect(third.pagination.nextOffset).toBe(null);
    } finally {
      await context.close();
    }
  });

  it("filters by system and time and preserves totals + pagination across pages", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      await seedDrilldownRuns(context);
      const ledger = new ItotoriModelLedgerRepository(context.db);

      // System filter: only the three system-a runs (a, b, d).
      const bySystem = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
      });
      expect(bySystem.filter.systemId).toBe("system-a");
      expect(bySystem.pagination.total).toBe(3);
      expect(bySystem.rows.map((row) => row.providerRunId)).toEqual([
        "run-a-billed",
        "run-b-zero",
        "run-d-unknown",
      ]);

      // Time filter: window bounding only run-b and run-c.
      const byTime = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        from: new Date("2026-06-17T00:01:00.000Z"),
        to: new Date("2026-06-17T00:02:00.000Z"),
      });
      expect(byTime.pagination.total).toBe(2);
      expect(byTime.rows.map((row) => row.providerRunId)).toEqual(["run-b-zero", "run-c-billed"]);

      // Deterministic offset pagination over the system-a set: total is stable
      // across pages, pages are disjoint, and together they cover the set.
      const pageSize = 2;
      const first = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
        limit: pageSize,
        offset: 0,
      });
      const second = await ledger.getCostLedgerDrilldown(localActor, {
        projectId: "project-test",
        systemId: "system-a",
        limit: pageSize,
        offset: pageSize,
      });
      expect(first.pagination).toMatchObject({
        total: 3,
        limit: 2,
        offset: 0,
        page: 1,
        pageCount: 2,
        hasMore: true,
        nextOffset: 2,
      });
      expect(second.pagination).toMatchObject({
        total: 3,
        limit: 2,
        offset: 2,
        page: 2,
        pageCount: 2,
        hasMore: false,
        nextOffset: null,
      });
      const firstIds = first.rows.map((row) => row.providerRunId);
      const secondIds = second.rows.map((row) => row.providerRunId);
      expect(firstIds).toEqual(["run-a-billed", "run-b-zero"]);
      expect(secondIds).toEqual(["run-d-unknown"]);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(3);
    } finally {
      await context.close();
    }
  });

  it("rejects prompt preset drift for an existing preset id and version", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-preset-original", "zero", 0));
      await expect(
        ledger.recordProviderRun(
          localActor,
          runInput("run-preset-drift", "zero", 0, {
            prompt: {
              promptPresetId: "itotori-test-preset",
              promptTemplateVersion: "1.0.0",
              promptHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              presetSchemaVersion: "itotori.prompt-preset.v0",
              configSnapshot: { template: "changed prompt" },
            },
          }),
        ),
      ).rejects.toThrow(/immutable/u);

      const rows = await context.db.execute(sql`
        select
          (select count(*)::int from ${promptPresets}) as preset_count,
          (select prompt_hash from ${promptPresets} limit 1) as prompt_hash,
          (select count(*)::int from ${providerRuns}) as provider_run_count
      `);
      expect(rows.rows[0]).toMatchObject({
        preset_count: 1,
        prompt_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        provider_run_count: 1,
      });
    } finally {
      await context.close();
    }
  });

  // ITOTORI-146 — a translation-memory reuse event whose `cost_impact` JSON
  // was inserted OUTSIDE the repository API (raw SQL backfill / historical
  // pre-fix row) carries the wrong scalar shape for one of the numeric
  // fields. Pre-fix the cast (`(cost_impact->>'estimatedPromptTokensSaved')::int`)
  // aborted the entire aggregation with `invalid input syntax for type
  // integer: "abc"`, making the project cost report unavailable. Post-fix
  // the aggregation defensively classifies the row in a CTE, sums only the
  // well-formed rows, and surfaces the malformed count + a diagnostic. The
  // rest of the report aggregates correctly.
  it("keeps the project cost report available when a tm reuse event has a malformed cost_impact JSON", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      // Look up the source revision id produced by `importSourceBundle` so
      // the parent-row FKs for the raw INSERTs below resolve cleanly.
      // (This is the same value the translation-memory repository would set
      // when going through `recordReuse`; we read it back so the test does
      // not have to depend on a private helper.)
      const suRows = await context.db.execute(sql`
        select source_revision_id
        from itotori_source_units
        where bridge_unit_id = 'bridge-unit-test'
        limit 1
      `);
      const sourceRevisionId = (suRows.rows[0] as { source_revision_id?: string } | undefined)
        ?.source_revision_id;
      expect(typeof sourceRevisionId).toBe("string");

      // Seed a translation-memory segment for the well-formed reuse event.
      await context.db.execute(sql`
        insert into itotori_translation_memory_segments
          (memory_segment_id, project_id, locale_branch_id, source_revision_id,
           source_unit_key, source_occurrence_id, source_hash, source_fingerprint,
           source_text, target_locale, target_text, status, provenance)
        values
          ('tm-segment-good', 'project-test', 'locale-en-us', ${sourceRevisionId},
           'hello.scene.001.line.001', 'occurrence-1', 'source-hash', 'fingerprint-good',
           'こんにちは、{player}。', 'en-US', 'Hello, {player}.', 'active', '{}'::jsonb)
      `);

      // WELL-FORMED reuse event: every numeric / boolean field is the
      // expected scalar shape.
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-good', 'project-test', 'locale-en-us', 'bridge-unit-test',
           ${sourceRevisionId}, 'tm-segment-good', 'exact', 1000,
           'applied', 'source-hash', 'source-hash', 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":true,"estimatedPromptTokensSaved":40,"estimatedCompletionTokensSaved":20,"estimatedTotalTokensSaved":60,"estimatedCostUsdSaved":"0.00012","calculation":"deterministic_character_estimate_v1"}'::jsonb`)},
           '{}'::jsonb)
      `);

      // MALFORMED reuse event: inserted OUTSIDE the repository API via raw
      // SQL. `estimatedPromptTokensSaved` is a string ("abc") where the
      // aggregation expects an integer — this is the exact shape that
      // aborted the pre-fix aggregation with `invalid input syntax for
      // type integer: "abc"`. We also slip in a non-bool
      // `providerCallAvoided` and a non-numeric `estimatedCostUsdSaved` to
      // prove the defensive predicate covers every field the aggregation
      // reads.
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-malformed', 'project-test', 'locale-en-us', 'bridge-unit-test',
           ${sourceRevisionId}, 'tm-segment-good', 'exact', 1000,
           'applied', 'source-hash', 'source-hash', 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":"yes","estimatedPromptTokensSaved":"abc","estimatedCompletionTokensSaved":20,"estimatedTotalTokensSaved":60,"estimatedCostUsdSaved":"cheap"}'::jsonb`)},
           '{}'::jsonb)
      `);

      // Sanity: both rows are present.
      const rawCount = await context.db.execute(sql`
        select count(*)::int as n from ${translationMemoryReuseEvents} where project_id = 'project-test'
      `);
      expect(rawCount.rows[0]).toMatchObject({ n: 2 });

      // The aggregation MUST succeed (no throw). The malformed row is
      // skipped from the numeric sums but counted in
      // `malformedCostImpactCount` and surfaced via a diagnostic.
      const report = await ledger.getProjectCostReport(localActor, "project-test");
      const reuse = report.translationMemoryReuse;

      expect(reuse.reuseEventCount).toBe(2);
      expect(reuse.appliedCount).toBe(2);
      expect(reuse.suggestedCount).toBe(0);
      // Malformed row is skipped, so `providerCallAvoidedCount` only counts
      // the well-formed row's `providerCallAvoided: true`.
      expect(reuse.providerCallAvoidedCount).toBe(1);
      // The malformed row's non-numeric fields are NOT summed; only the
      // well-formed row contributes.
      expect(reuse.estimatedPromptTokensSaved).toBe(40);
      expect(reuse.estimatedCompletionTokensSaved).toBe(20);
      expect(reuse.estimatedTotalTokensSaved).toBe(60);
      expect(reuse.estimatedCostUsdSaved).toBeCloseTo(0.00012, 6);
      // Malformed row is surfaced for repair.
      expect(reuse.malformedCostImpactCount).toBe(1);
      expect(reuse.diagnostics).toHaveLength(1);
      expect(reuse.diagnostics[0]).toMatchObject({
        code: "translation_memory.reuse_event.cost_impact.malformed",
        severity: "warning",
        reasonCode: "malformed_cost_impact_json",
        field: "cost_impact",
      });
      expect(reuse.diagnostics[0]?.metadata).toMatchObject({
        projectId: "project-test",
        malformedCostImpactCount: 1,
      });

      // recentEvents rows surface `malformedCostImpact` for the malformed
      // event and zero its cost fields defensively (no NaN, no leaked
      // non-numeric value), while the well-formed row keeps its numbers.
      const byId = new Map(reuse.recentEvents.map((row) => [row.reuseEventId, row]));
      const good = byId.get("reuse-good");
      const bad = byId.get("reuse-malformed");
      expect(good).toBeDefined();
      expect(bad).toBeDefined();
      expect(good?.malformedCostImpact).toBe(false);
      expect(good?.estimatedPromptTokensSaved).toBe(40);
      expect(good?.providerCallAvoided).toBe(true);
      expect(bad?.malformedCostImpact).toBe(true);
      // Non-numeric / non-bool fields are coerced to zero / false so
      // downstream consumers never see NaN or non-boolean truthy values.
      expect(bad?.estimatedPromptTokensSaved).toBe(0);
      expect(bad?.estimatedCompletionTokensSaved).toBe(20);
      expect(bad?.estimatedTotalTokensSaved).toBe(60);
      expect(bad?.providerCallAvoided).toBe(false);
      expect(bad?.estimatedCostUsdSaved).toBeNull();
    } finally {
      await context.close();
    }
  });

  // ITOTORI-146 — the diagnostic stays empty when every reuse event has a
  // well-formed `cost_impact` JSON (the normal repository-API write path),
  // so callers can rely on `malformedCostImpactCount === 0` +
  // `diagnostics === []` as the "everything fine" signal.
  it("does not surface a malformed-cost-impact diagnostic when every reuse event is well-formed", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(context.db);
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      const suRows = await context.db.execute(sql`
        select source_revision_id
        from itotori_source_units
        where bridge_unit_id = 'bridge-unit-test'
        limit 1
      `);
      const sourceRevisionId = (suRows.rows[0] as { source_revision_id?: string } | undefined)
        ?.source_revision_id;
      expect(typeof sourceRevisionId).toBe("string");

      await context.db.execute(sql`
        insert into itotori_translation_memory_segments
          (memory_segment_id, project_id, locale_branch_id, source_revision_id,
           source_unit_key, source_occurrence_id, source_hash, source_fingerprint,
           source_text, target_locale, target_text, status, provenance)
        values
          ('tm-segment-good-2', 'project-test', 'locale-en-us', ${sourceRevisionId},
           'hello.scene.001.line.001', 'occurrence-1', 'source-hash', 'fingerprint-good-2',
           'こんにちは、{player}。', 'en-US', 'Hello, {player}.', 'active', '{}'::jsonb)
      `);
      await context.db.execute(sql`
        insert into itotori_translation_memory_reuse_events
          (reuse_event_id, project_id, locale_branch_id, target_bridge_unit_id,
           source_revision_id, memory_segment_id, match_kind, match_score,
           reuse_status, source_hash, candidate_source_hash, target_text,
           cost_impact, provenance)
        values
          ('reuse-good-2', 'project-test', 'locale-en-us', 'bridge-unit-test',
           ${sourceRevisionId}, 'tm-segment-good-2', 'exact', 1000,
           'applied', 'source-hash', 'source-hash', 'Hello, {player}.',
           ${sql.raw(`'{"providerCallAvoided":true,"estimatedPromptTokensSaved":12,"estimatedCompletionTokensSaved":3,"estimatedTotalTokensSaved":15,"estimatedCostUsdSaved":"0.00005","calculation":"deterministic_character_estimate_v1"}'::jsonb`)},
           '{}'::jsonb)
      `);

      const reuse = (await ledger.getProjectCostReport(localActor, "project-test"))
        .translationMemoryReuse;
      expect(reuse.reuseEventCount).toBe(1);
      expect(reuse.malformedCostImpactCount).toBe(0);
      expect(reuse.diagnostics).toEqual([]);
      expect(reuse.estimatedPromptTokensSaved).toBe(12);
      expect(reuse.providerCallAvoidedCount).toBe(1);
    } finally {
      await context.close();
    }
  });
});

function runInput(
  providerRunId: string,
  costKind: ProviderRunLedgerInput["cost"]["costKind"],
  amountMicrosUsd: number,
  overrides: Partial<ProviderRunLedgerInput> = {},
): ProviderRunLedgerInput {
  const input: ProviderRunLedgerInput = {
    providerRunId,
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    taskKind: "draft_translation",
    startedAt: `2026-06-17T00:00:0${Math.min(providerRunId.length, 9)}.000Z`,
    completedAt: `2026-06-17T00:00:1${Math.min(providerRunId.length, 9)}.000Z`,
    latencyMs: 1000,
    status: "succeeded",
    provider: {
      providerFamily: "fake",
      endpointFamily: "chat-completions",
      providerName: "itotori-fixture",
      requestedModelId: "itotori-fake-draft-v0",
      actualModelId: "itotori-fake-draft-v0",
    },
    prompt: {
      promptPresetId: "itotori-test-preset",
      promptTemplateVersion: "1.0.0",
      promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      presetSchemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: { template: "test prompt" },
    },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: ["itotori-fake-draft-v0"],
    tokenUsage: {
      tokenCountSource: "provider_reported",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    cost: {
      costKind,
      currency: "USD",
      amountMicrosUsd,
      pricingSnapshotId: "fixture-pricing-2026-06-17",
    },
    // ITOTORI-230 — the captured OR routing posture for THIS run. The
    // default fixture uses the canonical alpha posture
    // (only=[deepseek-v3.2-exp@fireworks-style], zdr=true). Individual
    // test cases override via the `overrides` spread when they need to
    // exercise a different posture (e.g. a public-input call).
    routingPosture: {
      only: ["itotori-fixture"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
    adapterMetadata: {},
  };
  return { ...input, ...overrides };
}

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {},
    bridge: {
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
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
}
