// fe-http-contract-harness — black-box /api contract suite over REAL HTTP.
//
// The companion to `http-contract-harness.ts`. Each test boots the Itotori
// dashboard server on an ephemeral loopback port and drives a contract-critical
// `/api` route with the global `fetch`, asserting the OBSERVABLE wire contract
// (status line + content-type + typed body) against the api-schema authority.
// This replaces white-box `handleItotoriApiRequest`-direct calls for these
// routes: a transport-level regression (a dropped content-type, a wrong status,
// a body shape drift, a permission gate that redacts where it must not) fails
// HERE, against the contract an external client (curl, the SPA, OpenAPI
// consumers) actually sees. Behavior-first / code-agnostic
// ([[feedback_behavior_first_code_agnostic_testing]]).
import type { Permission } from "@itotori/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bridgeFixture, costReportFixture, dashboardStatusFixture } from "./api-fixtures.js";
import {
  assertHttpContractError,
  assertHttpContractOk,
  fixtureProjectWorkflow,
  fixtureRequirePermission,
  resetFixtureServiceFactoryMocks,
  startHttpContractHarness,
  startPostgresHttpContractHarness,
  type HttpContractHarness,
  type HttpContractRequestInit,
} from "./http-contract-harness.js";
import type { ItotoriApiRouteId } from "../src/api-schema.js";

let harness: HttpContractHarness;

beforeAll(async () => {
  harness = await startHttpContractHarness();
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  resetFixtureServiceFactoryMocks();
});

type ReadModelCase = {
  readonly routeId: ItotoriApiRouteId;
  readonly init?: HttpContractRequestInit;
};

// The contract-critical GET read-model routes the dashboard + SPA depend on.
// Each entry is driven through the route table (method + path resolved from the
// routeId) and asserted against `assertItotoriApiResponse` — the SAME typed
// contract the MSW + white-box suites pin to — so the wire shape is identical
// across the mock, the direct-handler, and the REAL-HTTP seams.
const READ_MODEL_CASES: readonly ReadModelCase[] = [
  { routeId: "projects.list" },
  { routeId: "projects.overview" },
  { routeId: "projects.status" },
  { routeId: "projects.decisions" },
  { routeId: "projects.cost" },
  { routeId: "projects.costDrilldown" },
  { routeId: "projects.benchmarks" },
  { routeId: "jobs.runTable" },
  { routeId: "runtime.status" },
  { routeId: "catalog.conflicts" },
  { routeId: "catalog.completeness" },
  { routeId: "catalog.benchmarkSeeds" },
  { routeId: "catalog.opportunities" },
  {
    routeId: "terminology.search",
    init: { query: { q: "Hero", localeBranchId: "locale-1" } },
  },
];

describe("fe-http-contract-harness: read-model /api routes over real loopback HTTP", () => {
  for (const { routeId, init } of READ_MODEL_CASES) {
    it(`returns the typed wire contract for ${routeId}`, async () => {
      const result = await harness.httpRequest(routeId, init);

      assertHttpContractOk(routeId, result);
    });
  }

  it("carries the privileged (un-redacted) project status body over the wire", async () => {
    // The permission gate grants every permission in the fixture factory, so
    // the transport must return the FULL-detail dashboard status (not the
    // redacted public summary) — proving the gate + the read reach the client
    // intact through real HTTP.
    const result = await harness.httpRequest("projects.status");

    assertHttpContractOk("projects.status", result);
    expect(result.body).toMatchObject({
      projectId: dashboardStatusFixture.projectId,
      status: dashboardStatusFixture.status,
    });
    // Privileged-only nested cost detail survives the wire (a redacted view
    // would strip recentRuns to []).
    expect((result.body as { cost: { recentRuns: unknown[] } }).cost.recentRuns).toHaveLength(
      costReportFixture.recentRuns.length,
    );
  });

  it("serves the legacy /api/hello/status alias under the same runtime.status contract", async () => {
    const result = await harness.httpRequest("/api/hello/status");

    // The legacy alias shares the runtime.status route contract; assert it
    // through that routeId so an alias divergence fails the contract suite.
    assertHttpContractOk("runtime.status", result);
  });

  it("serves the runtime status for a runtimeRunId query param", async () => {
    const result = await harness.httpRequest("runtime.status", {
      query: { runtimeRunId: "runtime-1" },
    });

    assertHttpContractOk("runtime.status", result);
    expect(fixtureProjectWorkflow.getRuntimeStatus).toHaveBeenCalledWith("runtime-1");
  });
});

describe("fe-http-contract-harness: mutation /api route over real loopback HTTP", () => {
  it("POST /api/imports/bridge returns the typed wire contract + flows through the permission gate", async () => {
    const result = await harness.httpRequest("imports.bridge", {
      body: { bridge: bridgeFixture },
    });

    assertHttpContractOk("imports.bridge", result);
    // Black-box observable: the transport forwarded the posted bridge body to
    // the workflow port AND gated the mutation on project.import. A mutation
    // that bypassed the gate (or dropped the body) would fail these.
    expect(fixtureProjectWorkflow.importBridge).toHaveBeenCalledWith(bridgeFixture);
    expect(fixtureRequirePermission).toHaveBeenCalledWith("project.import" as Permission);
    expect(result.body).toMatchObject({
      project: { projectId: dashboardStatusFixture.projectId },
    });
  });
});

describe("fe-http-contract-harness: typed error wire contract", () => {
  it("answers an unknown /api route with 404 not_found", async () => {
    const result = await harness.httpRequest("/api/contracts/this-route-does-not-exist");

    assertHttpContractError(result, { status: 404, code: "not_found" });
  });

  it("answers malformed JSON with 400 bad_request (not a 500)", async () => {
    const result = await harness.httpRequest("imports.bridge", { rawBody: "{" });

    assertHttpContractError(result, { status: 400, code: "bad_request" });
  });

  it("answers a GET on a POST-only project mutation path with 405 method_not_allowed", async () => {
    const result = await harness.httpRequest("/api/projects/project-1/branches");

    assertHttpContractError(result, { status: 405, code: "method_not_allowed" });
  });

  it("answers a GET on a POST-only reviewer mutation path with 405 method_not_allowed", async () => {
    const result = await harness.httpRequest("/api/reviewer/queue/batch-preview");

    assertHttpContractError(result, { status: 405, code: "method_not_allowed" });
  });
});

// The Postgres-backed smoke boots the server against the REAL DB-backed service
// factory (`withDatabaseItotoriServices`) so the /api wire contract is also
// exercised end-to-end through the repository layer. `queue.health` reads the
// real outbox/job tables (a route where the repository layer genuinely
// matters), and is deterministic on a freshly-migrated DB (empty queue → empty
// counts), so it does not depend on seed data. Gated on DATABASE_URL, so the
// fixture-only lane skips it; the ci-itotori / db-up lane stands up Postgres
// (`just db-up` + `just db-down` to remove the container).
describe.skipIf(!process.env.DATABASE_URL)(
  "fe-http-contract-harness: Postgres-backed smoke over real loopback HTTP",
  () => {
    it("returns the typed queue.health wire contract against the real DB", async () => {
      const dbHarness = await startPostgresHttpContractHarness({
        databaseUrl: process.env.DATABASE_URL as string,
      });
      try {
        const result = await dbHarness.httpRequest("queue.health");

        // The migrated DB answers the read with a contract-valid queue-health
        // read model (empty outbox on a fresh DB) — proving the wire contract
        // holds end-to-end through the repository, not just the fixture seam.
        assertHttpContractOk("queue.health", result);
        expect(
          (result.body as { outbox: { unprocessedCount: number } }).outbox.unprocessedCount,
        ).toBe(0);
      } finally {
        await dbHarness.close();
      }
    });

    it("answers an unknown /api route with the typed 404 contract over the real DB", async () => {
      const dbHarness = await startPostgresHttpContractHarness({
        databaseUrl: process.env.DATABASE_URL as string,
      });
      try {
        const result = await dbHarness.httpRequest("/api/contracts/no-such-route");

        assertHttpContractError(result, { status: 404, code: "not_found" });
      } finally {
        await dbHarness.close();
      }
    });
  },
);
