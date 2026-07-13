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
  fixturePlayTesterResultRevision,
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
  { routeId: "projects.bmkCockpit", init: { params: { projectId: "project-1" } } },
  { routeId: "projects.bmkCockpitHistory", init: { params: { projectId: "project-1" } } },
  { routeId: "jobs.runTable", init: { query: { projectId: "project-1" } } },
  { routeId: "settings.modelRouting.get", init: { query: { projectId: "project-1" } } },
  {
    routeId: "settings.branchPolicy.get",
    init: { params: { projectId: "project-1", localeBranchId: "locale-1" } },
  },
  { routeId: "runtime.status" },
  { routeId: "catalog.conflicts" },
  { routeId: "catalog.completeness" },
  { routeId: "catalog.benchmarkSeeds" },
  { routeId: "catalog.opportunities" },
  { routeId: "auth.members.list", init: { query: { accountId: "account-local" } } },
  { routeId: "auth.billing.seatUsage", init: { query: { accountId: "account-local" } } },
  { routeId: "auth.identity" },
  // fnd-caps-context — Studio capability permission view (flag/decide/steer/reveal).
  { routeId: "auth.capabilities" },
  {
    routeId: "terminology.search",
    init: { query: { q: "Hero", localeBranchId: "locale-1" } },
  },
  {
    routeId: "wiki.list",
    init: { params: { projectId: "project-1", localeBranchId: "locale-1" } },
  },
  {
    routeId: "wiki.show",
    init: {
      params: {
        projectId: "project-1",
        localeBranchId: "locale-1",
        contextArtifactId: "context-artifact-hero-scene",
      },
    },
  },
  {
    routeId: "wiki.history",
    init: {
      params: {
        projectId: "project-1",
        localeBranchId: "locale-1",
        contextArtifactId: "context-artifact-hero-scene",
      },
    },
  },
  {
    routeId: "workspace.search",
    init: {
      query: {
        projectId: "project-itotori-040",
        localeBranchId: "locale-branch-itotori-040",
        query: "世界",
        mode: "all",
        limit: 10,
        offset: 0,
      },
    },
  },
  { routeId: "play.delivery", init: { params: { runId: "run-contract-delivery-1" } } },
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

  it("POST target edit and GET delivery cross the real HTTP boundary with target-only input", async () => {
    const edited = await harness.httpRequest("play.targetEdit", {
      params: { parentPatchVersionId: "patch-version-contract-parent" },
      body: {
        bridgeUnitId: "bridge-unit-contract-1",
        targetBody: "Edited contract target.",
      },
    });

    assertHttpContractOk("play.targetEdit", edited);
    expect(edited.body).toMatchObject({
      schemaVersion: "itotori.play.target-edit.v0",
      patchVersionId: "patch-version-contract-child",
      targetBody: "Edited contract target.",
    });
    expect(fixtureRequirePermission).toHaveBeenCalledWith("draft.write" as Permission);
    expect(fixturePlayTesterResultRevision.editTarget).toHaveBeenCalledWith({
      parentPatchVersionId: "patch-version-contract-parent",
      bridgeUnitId: "bridge-unit-contract-1",
      targetBody: "Edited contract target.",
    });

    const delivery = await harness.httpRequest("play.delivery", {
      params: { runId: "run-contract-delivery-1" },
    });
    assertHttpContractOk("play.delivery", delivery);
    expect(delivery.body).toMatchObject({
      patchVersionId: "patch-version-contract-child",
      artifactHashes: { delivered_bundle: "sha256:contract-child" },
      downloadUrl: "/api/play/runs/run-contract-delivery-1/delivery/archive",
      units: [{ targetBody: "Edited contract target." }],
    });
    expect(delivery.body).not.toHaveProperty("artifactRefs");
  });

  it("downloads the selected delivered patch as real binary bytes through its authenticated URL", async () => {
    const delivery = await harness.httpRequest("play.delivery", {
      params: { runId: "run-contract-delivery-1" },
    });
    assertHttpContractOk("play.delivery", delivery);
    const downloadUrl = (delivery.body as { downloadUrl: string }).downloadUrl;

    const archive = await fetch(`${harness.origin}${downloadUrl}`);

    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toContain("application/x-tar");
    expect(archive.headers.get("content-disposition")).toContain(
      'attachment; filename="patch-version-contract-child.tar"',
    );
    expect(archive.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await archive.arrayBuffer())).toEqual(
      Buffer.from("fixture-delivered-patch-tar", "utf8"),
    );
    expect(fixturePlayTesterResultRevision.loadSelectedArchive).toHaveBeenCalledWith({
      runId: "run-contract-delivery-1",
    });
  });

  it("does not route an encoded traversal run id to the archive loader", async () => {
    const traversal = await harness.httpRequest("/api/play/runs/%2E%2E%2Foutside/delivery/archive");

    assertHttpContractError(traversal, { status: 404, code: "not_found" });
    expect(fixturePlayTesterResultRevision.loadSelectedArchive).not.toHaveBeenCalled();
  });

  it("routes wiki.edit through the typed canonical-correction receipt", async () => {
    const result = await harness.httpRequest("wiki.edit", {
      params: {
        projectId: "project-1",
        localeBranchId: "locale-1",
        contextArtifactId: "context-artifact-hero-scene",
      },
      body: { body: "Corrected scene fact.", reason: "Playtest observation." },
    });

    assertHttpContractOk("wiki.edit", result);
    expect(fixtureRequirePermission).toHaveBeenCalledWith("project.import" as Permission);
  });

  it("routes wiki.add through the same typed canonical-correction receipt", async () => {
    const result = await harness.httpRequest("wiki.add", {
      params: { projectId: "project-1", localeBranchId: "locale-1" },
      body: {
        sourceRevisionId: "source-revision-1",
        kind: "note",
        title: "Playtest context",
        body: "A new durable context note.",
        reason: "Observed during play.",
        affectedUnitIds: ["bridge-unit-1"],
      },
    });

    assertHttpContractOk("wiki.add", result);
    expect(fixtureRequirePermission).toHaveBeenCalledWith("project.import" as Permission);
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

  it("answers a GET on the target-edit mutation path with 405 method_not_allowed", async () => {
    const result = await harness.httpRequest(
      "/api/play/patch-versions/patch-version-contract-parent/target-edits",
    );

    assertHttpContractError(result, { status: 405, code: "method_not_allowed" });
  });

  it("answers a POST on the GET-only wiki history path with 405 method_not_allowed", async () => {
    const result = await harness.httpRequest(
      "/api/projects/project-1/locale-branches/locale-1/wiki/context-artifact-hero-scene/history",
      { method: "POST" },
    );

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
