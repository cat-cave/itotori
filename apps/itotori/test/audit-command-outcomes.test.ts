import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiDependencies from "../src/api-handler-dependencies.js";
import type { ItotoriCliDependencies, ItotoriCliServices } from "../src/cli-handler-contracts.js";
import { errorResponse, parseNewPipelineDraftFields } from "../src/api-handler-responses.js";
import { routeDraftBranchMutation } from "../src/api-handler-mutation-project.js";
import {
  runIngestConformance,
  runIngestPatchResult,
  runIngestRuntime,
} from "../src/cli-handler-core-commands.js";
import { projectFixture } from "./api-fixtures-project.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "itotori-audit-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe("audited command outcomes", () => {
  it("writes the requested ingestion receipt after patch-result ingestion succeeds", async () => {
    const directory = temporaryDirectory();
    const projectPath = join(directory, "project.json");
    const patchResultPath = join(directory, "patch-result.json");
    const outputPath = join(directory, "patch-result-ingest.json");
    writeJson(projectPath, projectFixture);
    writeFileSync(
      patchResultPath,
      readFileSync(
        new URL(
          "../../../packages/localization-bridge-schema/test/examples/patch-result-v0.2.json",
          import.meta.url,
        ),
      ),
    );

    await runIngestPatchResult(
      [
        "ingest-patch-result",
        "--project",
        projectPath,
        "--patch-result",
        patchResultPath,
        "--output",
        outputPath,
      ],
      {
        io: { readJson, writeJson },
        withServices: async (callback) =>
          await callback({
            projectWorkflow: {
              async ingestPatchResult() {},
            },
          }),
      },
    );

    expect(readJson(outputPath)).toMatchObject({
      outcome: "ingested",
      patchResultId: "019ed001-0000-7000-8000-000000000950",
    });
  });

  it("rejects malformed project JSON before runtime, patch, and conformance ingestion", async () => {
    const serviceReached = vi.fn();
    const projectPath = "project.json";
    const dependencies: ItotoriCliDependencies = {
      io: {
        readJson: (path: string): unknown => (path === projectPath ? {} : undefined),
        writeJson: vi.fn(),
      },
      withServices: async <T>(
        _callback: (services: ItotoriCliServices) => Promise<T>,
      ): Promise<T> => {
        serviceReached();
        throw new Error("project ingestion service should not be reached");
      },
      migrateDatabase: async () => undefined,
      resetDatabase: async () => undefined,
    };

    await expect(
      runIngestRuntime(
        [
          "ingest-runtime",
          "--project",
          projectPath,
          "--runtime-report",
          "report.json",
          "--output",
          "output.json",
        ],
        dependencies,
      ),
    ).rejects.toThrow(/ProjectState\.projectId/u);
    await expect(
      runIngestPatchResult(
        [
          "ingest-patch-result",
          "--project",
          projectPath,
          "--patch-result",
          "patch-result.json",
          "--output",
          "output.json",
        ],
        dependencies,
      ),
    ).rejects.toThrow(/ProjectState\.projectId/u);
    await expect(
      runIngestConformance(
        [
          "ingest-conformance",
          "--project",
          projectPath,
          "--report-file",
          "report.json",
          "--output",
          "output.json",
        ],
        dependencies,
      ),
    ).rejects.toThrow(/ProjectState\.projectId/u);
    expect(serviceReached).not.toHaveBeenCalled();
  });

  it.each([
    ["contextScope", "outside-the-contract"],
    ["outputScope", "outside-the-contract"],
  ])("maps an invalid optional draft %s to a client error", (field, value) => {
    const bridge = readJson(
      new URL(
        "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
        import.meta.url,
      ).pathname,
    );
    let error: unknown;
    try {
      parseNewPipelineDraftFields({
        runMode: "production",
        structure: {},
        bridge,
        [field]: value,
      });
    } catch (caught) {
      error = caught;
    }

    expect(errorResponse(error)).toMatchObject({ statusCode: 400, body: { code: "bad_request" } });
  });

  it("refuses an unplanned qualifying branch request before it can bypass Q5 evidence", async () => {
    const localize = vi.spyOn(apiDependencies, "runApiLocalize");

    const response = await routeDraftBranchMutation(
      {
        method: "POST",
        pathname: `/api/projects/${projectFixture.projectId}/branches`,
        body: {
          project: projectFixture,
          targetLocale: "fr-FR",
        },
      },
      projectFixture.projectId,
      {
        authorization: { requirePermission: async () => undefined },
        projectWorkflow: {
          async listLocaleBranchIdentities() {
            return [
              {
                projectId: projectFixture.projectId,
                localeBranchId: projectFixture.localeBranchId,
                targetLocale: projectFixture.targetLocale,
              },
            ];
          },
        },
      },
    );

    expect(response).toMatchObject({
      statusCode: 200,
      body: {
        outcome: "refused",
        refusalMessage: expect.stringContaining("launch-pass"),
      },
    });
    expect(localize).not.toHaveBeenCalled();
  });
});
