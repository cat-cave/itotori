import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Permission } from "@itotori/db";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import { toReadOnlyServiceFactory } from "../src/services/database-services.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  benchmarkReportFixture,
  benchmarkReportsFixture,
  bridgeFixture,
  costReportFixture,
  costDrilldownFixture,
  dashboardDecisionsFixture,
  dashboardStatusFixture,
  decisionEventFixture,
  findingRecordFixture,
  projectFixture,
  runtimeIngestResultFixture,
  runtimeStatusFixture,
} from "./api-fixtures.js";

const requirePermission = vi.fn<[Permission], Promise<void>>(async () => {});
const getDashboardStatus = vi.fn(async () => dashboardStatusFixture);
const getRuntimeStatus = vi.fn(async () => runtimeStatusFixture);
const getCostReport = vi.fn(async () => costReportFixture);
const getCostDrilldown = vi.fn(async () => costDrilldownFixture);
const getBenchmarkReports = vi.fn(async () => benchmarkReportsFixture);
const getDashboardDecisions = vi.fn(async () => dashboardDecisionsFixture);
const importBridge = vi.fn(async () => projectFixture);

const { createItotoriServer, startItotoriServer } = await import("../src/server.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("Itotori server API contracts", () => {
  it("serves project dashboard status from /api/projects/status", async () => {
    const response = await requestJson({ path: "/api/projects/status" });

    expect(response).toMatchObject({
      projectId: "project-1",
      status: "runtime_ingested",
      localeBranches: [
        { localeBranchId: "locale-1", targetLocale: "en-US" },
        { localeBranchId: "019ed065-0000-7000-8000-000000000110", targetLocale: "fr-FR" },
      ],
    });
    expect(getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("serves the legacy runtime status shape from /api/hello/status", async () => {
    const response = await requestJson({ path: "/api/hello/status" });

    expect(response).toEqual(runtimeStatusFixture);
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(getDashboardStatus).not.toHaveBeenCalled();
  });

  it("serves project cost status from /api/projects/cost", async () => {
    const response = await requestJson({ path: "/api/projects/cost" });

    expect(response).toMatchObject({
      projectId: "project-1",
      // ITOTORI-225 — the api-fixtures' second run was previously tagged
      // `provider_estimate` (amountMicrosUsd: 980). With the narrowed
      // enum, both fixture runs record as `billed`, so the total billed
      // is 1200 + 980 = 2180. The legacy `estimatedMicrosUsd` field is
      // gone.
      billedMicrosUsd: 2180,
    });
    expect(getCostReport).toHaveBeenCalledTimes(1);
    expect(getDashboardStatus).not.toHaveBeenCalled();
  });

  it("routes typed bridge imports through JSON request parsing and permission checks", async () => {
    const response = await requestJson({
      path: "/api/imports/bridge",
      method: "POST",
      body: { bridge: bridgeFixture },
    });

    expect(response).toMatchObject({
      project: { projectId: "project-1" },
      status: { projectId: "project-1" },
    });
    expect(requirePermission).toHaveBeenCalledWith("project.import");
    expect(importBridge).toHaveBeenCalledWith(bridgeFixture);
  });

  it("binds the dashboard server to loopback by default", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = startItotoriServer({
      port: 0,
      serviceFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    try {
      await waitForListening(server);
      const address = server.address() as AddressInfo;

      expect(address.address).toBe("127.0.0.1");

      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/status`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ projectId: "project-1" });
    } finally {
      consoleLog.mockRestore();
      await closeServer(server);
    }
  });

  it("returns a typed bad request response for malformed JSON", async () => {
    const server = createItotoriServer({
      serviceFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/imports/bridge`, {
        method: "POST",
        body: "{",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "bad_request" });
    } finally {
      await closeServer(server);
    }
  });

  it("serves the runtime dashboard index for deep links while preserving API and static routes", async () => {
    await withTempDir(async (directory) => {
      const webRoot = join(directory, "web");
      const runtimeWebRoot = join(directory, "runtime-web");
      await mkdir(join(webRoot, "assets"), { recursive: true });
      await mkdir(join(runtimeWebRoot, "assets"), { recursive: true });
      await writeFile(join(webRoot, "index.html"), "itotori dashboard", "utf8");
      await writeFile(join(webRoot, "assets", "dashboard.js"), "dashboard asset", "utf8");
      await writeFile(join(runtimeWebRoot, "index.html"), "runtime dashboard", "utf8");
      await writeFile(join(runtimeWebRoot, "assets", "runtime.js"), "runtime asset", "utf8");

      const server = createItotoriServer({
        serviceFactory,
        webRoot: directoryUrl(webRoot),
        runtimeWebRoot: directoryUrl(runtimeWebRoot),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;

        const deepLinkResponse = await fetch(`${origin}/runtime/evidence/runtime-1`);
        expect(deepLinkResponse.status).toBe(200);
        expect(deepLinkResponse.headers.get("content-type")).toBe("text/html");
        await expect(deepLinkResponse.text()).resolves.toBe("runtime dashboard");
        expect(getRuntimeStatus).not.toHaveBeenCalled();

        const styleGuideBuilderResponse = await fetch(`${origin}/style-guide-builder`);
        expect(styleGuideBuilderResponse.status).toBe(200);
        expect(styleGuideBuilderResponse.headers.get("content-type")).toBe("text/html");
        await expect(styleGuideBuilderResponse.text()).resolves.toBe("itotori dashboard");

        for (const pathname of [
          "/reviewer-queue/batch",
          "/reviewer-queue/reviewer-queue-1",
          "/projects/project-1/locale-branches/locale-1/asset-decisions",
          "/projects/project-1/locale-branches/locale-1/asset-decisions/batch",
        ]) {
          const dashboardResponse = await fetch(`${origin}${pathname}`);
          expect(dashboardResponse.status).toBe(200);
          expect(dashboardResponse.headers.get("content-type")).toBe("text/html");
          await expect(dashboardResponse.text()).resolves.toBe("itotori dashboard");
        }

        // ITOTORI-040 — the localization workspace SPA must be reachable at
        // /workspace deep links for ANY project (project/unit context comes
        // from query params, not the path). Each variant resolves to the
        // dashboard index so the SPA loader can re-route client-side.
        for (const pathname of [
          "/workspace",
          "/workspace/projects",
          "/workspace/scenes",
          "/workspace/assets",
          "/workspace/comparison",
          "/workspace/search",
          "/workspace/corrections",
        ]) {
          const workspaceResponse = await fetch(`${origin}${pathname}`);
          expect(workspaceResponse.status).toBe(200);
          expect(workspaceResponse.headers.get("content-type")).toBe("text/html");
          await expect(workspaceResponse.text()).resolves.toBe("itotori dashboard");
        }

        for (const pathname of [
          "/reviewer-queue",
          "/reviewer-queue/batch/",
          "/reviewer-queue/reviewer-queue-1/extra",
          "/reviewer-queue/reviewer-queue-1/%2e%2e",
          "/projects/project-1/locale-branches/locale-1/asset-decisions/",
          "/projects/project-1/locale-branches/locale-1/asset-decisions/extra",
          "/projects/project-1/locale-branches/locale-1/asset-decisions/%2e%2e",
          "/projects/project-1/locale-branches/locale-1",
          "/workspace/unknown",
          "/workspace/projects/extra",
        ]) {
          const notFoundResponse = await fetch(`${origin}${pathname}`);
          expect(notFoundResponse.status).toBe(404);
          await expect(notFoundResponse.text()).resolves.toBe("not found");
        }

        const assetResponse = await fetch(`${origin}/assets/runtime.js`);
        expect(assetResponse.status).toBe(200);
        expect(assetResponse.headers.get("content-type")).toBe("text/javascript");
        await expect(assetResponse.text()).resolves.toBe("runtime asset");

        const apiResponse = await fetch(`${origin}/api/runtime/v0.2/status?runtimeRunId=runtime-1`);
        expect(apiResponse.status).toBe(200);
        await expect(apiResponse.json()).resolves.toMatchObject({ runtimeReportId: "runtime-1" });
        expect(getRuntimeStatus).toHaveBeenCalledWith("runtime-1");
      } finally {
        await closeServer(server);
      }
    });
  });

  it("serves managed artifact-store files only from configured safe roots", async () => {
    await withTempDir(async (directory) => {
      const webRoot = join(directory, "web");
      const managedArtifactRoot = join(directory, "managed-artifacts");
      const publicFixtureArtifactRoot = join(directory, "public-fixtures");
      await mkdir(webRoot, { recursive: true });
      await mkdir(join(managedArtifactRoot, "runtime-1", "traces"), { recursive: true });
      await mkdir(
        join(publicFixtureArtifactRoot, "artifacts", "utsushi", "runtime", "runtime-2", "traces"),
        { recursive: true },
      );
      await writeFile(
        join(managedArtifactRoot, "runtime-1", "traces", "trace-1.json"),
        '{"source":"managed"}',
        "utf8",
      );
      await writeFile(
        join(
          publicFixtureArtifactRoot,
          "artifacts",
          "utsushi",
          "runtime",
          "runtime-2",
          "traces",
          "trace-2.json",
        ),
        '{"source":"fixture"}',
        "utf8",
      );

      const server = createItotoriServer({
        serviceFactory,
        webRoot: directoryUrl(webRoot),
        managedArtifactRoot: directoryUrl(managedArtifactRoot),
        publicFixtureArtifactRoot: directoryUrl(publicFixtureArtifactRoot),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;

        const managedResponse = await fetch(
          `${origin}/artifact-store/artifacts/utsushi/runtime/runtime-1/traces/trace-1.json`,
        );
        expect(managedResponse.status).toBe(200);
        expect(managedResponse.headers.get("content-type")).toBe("application/json");
        await expect(managedResponse.json()).resolves.toEqual({ source: "managed" });

        const fixtureResponse = await fetch(
          `${origin}/artifact-store/artifacts/utsushi/runtime/runtime-2/traces/trace-2.json`,
        );
        expect(fixtureResponse.status).toBe(200);
        await expect(fixtureResponse.json()).resolves.toEqual({ source: "fixture" });

        const missingResponse = await fetch(
          `${origin}/artifact-store/artifacts/utsushi/runtime/runtime-3/traces/missing.json`,
        );
        expect(missingResponse.status).toBe(404);

        const traversalResponse = await fetch(
          `${origin}/artifact-store/artifacts%2Futsushi%2Fruntime%2Fruntime-1%2F..%2Fsecret.json`,
        );
        expect(traversalResponse.status).toBe(400);

        const externalResponse = await fetch(`${origin}/artifact-store/file:///tmp/secret.json`);
        expect(externalResponse.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    });
  });

  // UTSUSHI-140 — defense-in-depth regression coverage. The artifact-store
  // server confines managed reads to the configured root via realpath
  // canonicalization (see `readRootedFile` in src/server.ts). A symlink whose
  // name is an ordinary path segment (so it passes the lexical `..`/scheme
  // guards) but whose target resolves OUTSIDE the managed root must NOT be
  // served — otherwise it would be a directory-escape leak. This test would
  // fail if the realpath confinement in `readRootedFile` were removed, because
  // the lexical checks alone treat the symlink path as in-root and would read
  // the outside target's contents.
  it("refuses artifact-store symlinks that escape the managed root while still serving in-root files", async () => {
    await withTempDir(async (directory) => {
      const webRoot = join(directory, "web");
      const managedArtifactRoot = join(directory, "managed-artifacts");
      await mkdir(webRoot, { recursive: true });
      await mkdir(join(managedArtifactRoot, "runtime-1", "traces"), { recursive: true });

      // A legitimate managed runtime artifact that must remain servable.
      await writeFile(
        join(managedArtifactRoot, "runtime-1", "traces", "trace-1.json"),
        '{"source":"managed"}',
        "utf8",
      );

      // A synthetic file OUTSIDE the managed root (no real secret). A symlink
      // under the root — with an ordinary segment name — points at it.
      const outsideSecret = join(directory, "outside-secret.json");
      await writeFile(outsideSecret, '{"source":"outside-root"}', "utf8");
      await symlink(outsideSecret, join(managedArtifactRoot, "runtime-1", "traces", "escape.json"));

      const server = createItotoriServer({
        serviceFactory,
        webRoot: directoryUrl(webRoot),
        managedArtifactRoot: directoryUrl(managedArtifactRoot),
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;

        // The out-of-root symlink target must not be served, and its contents
        // must never leak into the response body.
        const escapeResponse = await fetch(
          `${origin}/artifact-store/artifacts/utsushi/runtime/runtime-1/traces/escape.json`,
        );
        expect(escapeResponse.status).toBe(404);
        const escapeBody = await escapeResponse.text();
        expect(escapeBody).toBe("not found");
        expect(escapeBody).not.toContain("outside-root");

        // A normal managed runtime artifact under the root is still served —
        // the confinement does not break legitimate reads.
        const managedResponse = await fetch(
          `${origin}/artifact-store/artifacts/utsushi/runtime/runtime-1/traces/trace-1.json`,
        );
        expect(managedResponse.status).toBe(200);
        await expect(managedResponse.json()).resolves.toEqual({ source: "managed" });
      } finally {
        await closeServer(server);
      }
    });
  });
});

describe("itotori-043-followup transport-level read-only routing", () => {
  it("dispatches a GET through the read-only service factory (never the full one)", async () => {
    const fullFactory = vi.fn(serviceFactory);
    const readOnlyFactory = vi.fn(toReadOnlyServiceFactory(serviceFactory));
    const server = createItotoriServer({
      serviceFactory: fullFactory,
      readOnlyServiceFactory: readOnlyFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/status`);

      expect(response.status).toBe(200);
      await response.json();
      // The transport selected the read-only factory for the GET and never
      // constructed the full (mutation-bearing) services.
      expect(readOnlyFactory).toHaveBeenCalledTimes(1);
      expect(fullFactory).not.toHaveBeenCalled();
      // The GET resolved through the read-only projection of the shared
      // services (the narrowed surface delegates to the same read method).
      expect(getDashboardStatus).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it("dispatches a mutation through the full service factory (never the read-only one)", async () => {
    const fullFactory = vi.fn(serviceFactory);
    const readOnlyFactory = vi.fn(toReadOnlyServiceFactory(serviceFactory));
    const server = createItotoriServer({
      serviceFactory: fullFactory,
      readOnlyServiceFactory: readOnlyFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/imports/bridge`, {
        method: "POST",
        body: JSON.stringify({ bridge: bridgeFixture }),
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      await response.json();
      // The transport selected the full factory for the mutation and never
      // touched the read-only factory.
      expect(fullFactory).toHaveBeenCalledTimes(1);
      expect(readOnlyFactory).not.toHaveBeenCalled();
      expect(importBridge).toHaveBeenCalledWith(bridgeFixture);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves 405 method_not_allowed for a GET on a POST-only reviewer mutation path", async () => {
    const readOnlyFactory = vi.fn(toReadOnlyServiceFactory(serviceFactory));
    const server = createItotoriServer({
      serviceFactory,
      readOnlyServiceFactory: readOnlyFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/reviewer/queue/batch-preview`,
      );

      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({ code: "method_not_allowed" });
      // A GET still flows through the read-only factory (no mutation surface
      // constructed) even when it is refused as a wrong-method request.
      expect(readOnlyFactory).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves 405 method_not_allowed for a GET on a project mutation route", async () => {
    const readOnlyFactory = vi.fn(toReadOnlyServiceFactory(serviceFactory));
    const server = createItotoriServer({
      serviceFactory,
      readOnlyServiceFactory: readOnlyFactory,
      webRoot: new URL("file:///tmp/itotori-empty-web/"),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/projects/project-1/branches`,
      );

      expect(response.status).toBe(405);
      expect(readOnlyFactory).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });
});

async function requestJson(options: {
  path: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  const server = createItotoriServer({
    serviceFactory,
    webRoot: new URL("file:///tmp/itotori-empty-web/"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${options.path}`, {
      method: options.method ?? "GET",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    await closeServer(server);
  }
}

async function waitForListening(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  if (server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function closeServer(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTempDir(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "itotori-server-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function directoryUrl(directory: string): URL {
  return pathToFileURL(`${directory}/`);
}

async function serviceFactory<T>(
  callback: (services: ItotoriApplicationServices) => Promise<T>,
): Promise<T> {
  return await callback({
    authorization: {
      requirePermission,
    },
    projectWorkflow: {
      reset: vi.fn(async () => {}),
      getDashboardStatus,
      getRuntimeStatus,
      getDashboardDecisions,
      getCostReport,
      getCostDrilldown,
      getBenchmarkReports,
      importBridge,
      draftProject: vi.fn(async () => projectFixture),
      exportPatch: vi.fn(async () => {
        throw new Error("not used");
      }),
      ingestRuntimeReport: vi.fn(async () => ({
        project: projectFixture,
        result: runtimeIngestResultFixture,
      })),
      recordFinding: vi.fn(async () => ({
        findingId: findingRecordFixture.findingId,
        status: "open" as const,
      })),
      recordDecision: vi.fn(async () => ({
        decisionId: decisionEventFixture.eventId,
        eventKind: decisionEventFixture.eventKind,
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: benchmarkReportFixture.benchmarkRunId,
        artifactId: benchmarkReportFixture.benchmarkRunId,
        status: benchmarkReportFixture.status,
        systemCount: benchmarkReportFixture.systemsCompared.length,
        findingCount: benchmarkReportFixture.findingRecords.length,
      })),
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    catalogRepository: {
      catalogConflictReview: vi.fn(async () => ({ rows: [] })),
    },
    catalogExactExternalIdLinker: {
      linkExactExternalIds: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    catalogFuzzyCandidateGenerator: {
      generateFuzzyCandidates: vi.fn(async () => {
        throw new Error("not used");
      }),
      listCatalogCandidateMatches: vi.fn(async () => []),
    },
    catalogCrawlerRepository: {
      getCheckpoint: vi.fn(async () => null),
      startCrawlerJob: vi.fn(async () => {
        throw new Error("not used");
      }),
      recordFetchedStep: vi.fn(async () => {
        throw new Error("not used");
      }),
      commitStepImport: vi.fn(async () => {
        throw new Error("not used");
      }),
      markStepImported: vi.fn(async () => {
        throw new Error("not used");
      }),
      markStepFailed: vi.fn(async () => {
        throw new Error("not used");
      }),
      saveCheckpoint: vi.fn(async () => {
        throw new Error("not used");
      }),
      saveRateLimit: vi.fn(async () => {
        throw new Error("not used");
      }),
      completeCrawlerJob: vi.fn(async () => {
        throw new Error("not used");
      }),
      failCrawlerJob: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    catalogCrawlerRunner: {
      run: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  });
}
