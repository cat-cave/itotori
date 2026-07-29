import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriModelLedgerRepository } from "../src/repositories/model-ledger-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { promptPresets, providerRuns } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

import {
  projectFixture,
  runInput,
  seedDrilldownRuns,
} from "./model-ledger-repository.test.support.js";

describe("ItotoriModelLedgerRepository", () => {
  it("sanitizeAdapterMetadata projects only known-safe fields; raw-payload synonyms AND nested raw bodies never surface (default-deny)", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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

  it("projects openrouterMetadata to safe scalars only (no wholesale mirror) and is context-aware for source/summary", async () => {
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

  it("surfaces the top-level scalar `source` tag (benchmark ingest) while dropping non-scalar source", async () => {
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

  it("breaks started_at ties by provider_run_id desc with stable non-overlapping pages", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
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
});
