import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriModelLedgerRepository,
  type ProviderRunLedgerInput,
} from "../src/repositories/model-ledger-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { artifacts, providerRuns } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import {
  projectFixture,
  runInput,
  seedDrilldownRuns,
} from "./model-ledger-repository.test.shared-01.js";

describe("ItotoriModelLedgerRepository", () => {
  it("rolls back benchmark artifacts and ledger rows when provider ledger ingestion conflicts", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
        amountMicrosUsd: 100, // cost-audit-allow: synthetic fixture cost, not a real billed amount
      });
    } finally {
      await context.close();
    }
  });

  it("model-ledger-repository.test.ts ZDR-enforced count coverage — countZdrEnforcedByPair returns ZDR-enforced count per pair", async () => {
    // Schema check: insert two rows with `routing_posture->>'zdr' = 'true'`
    // and one with `'false'`; assert the count by pair returns 2 enforced /
    // 3 total.
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      await projectRepository.importSourceBundle(localActor, projectFixture());
      const ledger = new ItotoriModelLedgerRepository(context.db);

      await ledger.recordProviderRun(localActor, runInput("run-zdr-1", "billed", 100));
      await ledger.recordProviderRun(localActor, runInput("run-zdr-2", "billed", 200));
      await ledger.recordProviderRun(
        localActor,
        runInput("run-non-zdr", "billed", 50, {
          // Explicit non-ZDR posture (public input would typically carry
          // this shape on the wire).
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
          amountMicrosUsd: 150, // cost-audit-allow: synthetic fixture cost, not a real billed amount
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

  it("filters the cost drilldown by project with deterministic ordering + pagination metadata", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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

  it("does not fabricate canonical cost fidelity: displayAmountUsd is micros-derived, NOT amountUsd", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
});
