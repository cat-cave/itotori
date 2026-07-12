// itotori-db-draft-route-provider-not-wired — the DRAFT HTTP boundary must
// surface provider and paid-cost-admission refusals in-band.

import type { AddressInfo } from "node:net";
import {
  localUserId,
  type ItotoriProjectRepositoryPort,
  type LocaleBranchIdentity,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { assertItotoriApiResponse, type ApiDraftBranchResponse } from "../src/api-schema.js";
import {
  OpenRouterModelProvider,
  type ModelProvider,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../src/providers/index.js";
import { createDbBackedDraftModelProvider } from "../src/services/db-live-workflow-ports.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import { createItotoriServer } from "../src/server.js";
import type {
  ItotoriApplicationServices,
  ItotoriServiceFactory,
} from "../src/services/database-services.js";
import { dashboardStatusFixture, projectFixture } from "./api-fixtures.js";

const actor = { userId: localUserId };
const branchIdentity: LocaleBranchIdentity = {
  localeBranchId: "locale-1",
  projectId: "project-1",
  sourceBundleId: "bridge-1",
  sourceBundleRevisionId: "revision-1",
  sourceLocale: "ja-JP",
  targetLocale: "en-US",
  branchName: "en-US",
  status: "active",
};

type DraftProviderFactory = (recorder: ProviderRunArtifactRecorder) => ModelProvider | undefined;

const unconfiguredDraftCases: ReadonlyArray<{
  label: string;
  expectedMessage: string;
  provider: DraftProviderFactory;
}> = [
  {
    label: "the account ZDR assertion is missing",
    expectedMessage: "durable cost-admission sink",
    provider: (artifactRecorder) =>
      createDbBackedDraftModelProvider({
        env: {},
        artifactRecorder,
      }),
  },
  {
    label: "the OpenRouter API key is missing",
    expectedMessage: "durable cost-admission sink",
    provider: (artifactRecorder) =>
      createDbBackedDraftModelProvider({
        env: { OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
        artifactRecorder,
      }),
  },
  {
    label: "no draft provider is wired",
    expectedMessage: "no real model provider is configured",
    provider: () => undefined,
  },
];

describe("projects.draft HTTP boundary", () => {
  it.each(unconfiguredDraftCases)(
    "returns an in-band refusal, not a 500, when $label",
    async ({ expectedMessage, provider: buildProvider }) => {
      const recorder: ProviderRunArtifactRecorder = {
        recordProviderRun: async (_artifact: ProviderRunArtifact) => {},
      };
      const workflow = new ItotoriProjectWorkflowService(
        repositoryFixture(),
        actor,
        buildProvider(recorder),
      );

      const response = await withDraftServer(workflow, (origin) => postDraft(origin));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        outcome: "refused",
        project: null,
        status: null,
        refusalMessage: expect.stringContaining(expectedMessage),
      });
      expect((response.body as Record<string, unknown>).code).not.toBe("internal_error");
    },
  );

  it("refuses an opt-in live draft before OpenRouter invocation without a durable cost sink", async () => {
    const liveEnabled =
      typeof process.env.OPENROUTER_API_KEY === "string" &&
      process.env.OPENROUTER_API_KEY.length > 0;
    if (!liveEnabled) {
      // eslint-disable-next-line no-console
      console.warn("[draft-route-live] skipping real ZDR draft — set OPENROUTER_API_KEY to run it");
      return;
    }

    const recordedArtifacts: ProviderRunArtifact[] = [];
    const artifactRecorder: ProviderRunArtifactRecorder = {
      recordProviderRun: async (artifact) => {
        recordedArtifacts.push(artifact);
      },
    };
    const provider = createDbBackedDraftModelProvider({
      // Keep the live test's env surface explicit and do not pass unrelated
      // process secrets into the provider constructor.
      env: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED,
      },
      artifactRecorder,
    });
    const workflow = new ItotoriProjectWorkflowService(repositoryFixture(), actor, provider);
    const invokeSpy = vi.spyOn(OpenRouterModelProvider.prototype, "invoke");

    try {
      const response = await withDraftServer(workflow, (origin) => postDraft(origin));
      expect(response.status).toBe(200);
      assertItotoriApiResponse("branches.draft", response.body);
      const draftResponse = response.body as ApiDraftBranchResponse;
      expect(draftResponse.outcome).toBe("refused");
      expect(draftResponse.project).toBeNull();
      expect(draftResponse.status).toBeNull();
      expect(draftResponse.refusalMessage).toContain("durable cost-admission sink");
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(recordedArtifacts).toEqual([]);
    } finally {
      invokeSpy.mockRestore();
    }
  }, 120_000);
});

async function postDraft(origin: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/api/projects/project-1/branches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: projectFixture, targetLocale: "fr-FR" }),
  });
  return { status: response.status, body: await response.json() };
}

async function withDraftServer<T>(
  workflow: ItotoriProjectWorkflowService,
  callback: (origin: string) => Promise<T>,
): Promise<T> {
  const services = minimalServices(workflow);
  const serviceFactory: ItotoriServiceFactory = async (handler) => handler(services);
  const server = createItotoriServer({
    serviceFactory,
    webRoot: new URL("file:///tmp/itotori-empty-web/"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function minimalServices(workflow: ItotoriProjectWorkflowService): ItotoriApplicationServices {
  const unusedPort = new Proxy(
    {},
    {
      get: () => async () => [],
    },
  );
  return {
    authorization: {
      requirePermission: async () => {},
    },
    projectWorkflow: workflow,
    catalogRepository: unusedPort,
    terminologyRepository: unusedPort,
    wikiRepository: unusedPort,
    reviewerQueue: unusedPort,
    workspace: unusedPort,
    workspaceCorrections: unusedPort,
    assetDecisions: unusedPort,
    queueHealth: unusedPort,
    jobs: unusedPort,
    benchmarkCockpit: unusedPort,
    authMembers: unusedPort,
    modelRouting: unusedPort,
    branchPolicy: unusedPort,
    authBilling: unusedPort,
    authPermissions: unusedPort,
    authIdentity: unusedPort,
    playRouteMap: unusedPort,
    sceneCoverage: unusedPort,
  } as unknown as ItotoriApplicationServices;
}

function repositoryFixture(): ItotoriProjectRepositoryPort {
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
    listLocaleBranchIdentities: vi.fn(async () => [branchIdentity]),
    listBenchmarkReports: vi.fn(async () => []),
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getRuntimeStatus: vi.fn(async () => ({}) as never),
    getDashboardDecisions: vi.fn(async () => ({}) as never),
  } as unknown as ItotoriProjectRepositoryPort;
}
