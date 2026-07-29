import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { WorkflowRunReport } from "../src/workflow/index.js";
import * as apiDependencies from "../src/api-handler-dependencies.js";
import { routeDraftBranchMutation } from "../src/api-handler-mutation-project.js";
import { runIngestPatchResult } from "../src/cli-handler-core-commands.js";
import { resolveRunPolicy, FULL_ROSTER } from "../src/run-policy/index.js";
import { dashboardStatusFixture } from "./api-fixtures-dashboard.js";
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

  it("returns a failing API response when the workflow report has no patch output", async () => {
    const bridge = readJson(
      new URL(
        "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
        import.meta.url,
      ).pathname,
    ) as BridgeBundleV02;
    const report: WorkflowRunReport = {
      policy: resolveRunPolicy({
        runMode: "production",
        contextScope: "whole-game",
        outputScope: "dialogue-only",
        roster: FULL_ROSTER,
      }),
      schedule: { serialChains: [], parallelScenes: [] },
      excludedOutputUnitIds: [],
      scenes: [],
      finalized: [],
      patchId: null,
      buildLqa: [],
      attemptLineage: [],
    };
    vi.spyOn(apiDependencies, "runApiLocalize").mockResolvedValue(report);

    const response = await routeDraftBranchMutation(
      {
        method: "POST",
        pathname: `/api/projects/${projectFixture.projectId}/branches`,
        body: {
          project: projectFixture,
          targetLocale: "fr-FR",
          runMode: "production",
          structure: {},
          bridge,
        },
      },
      projectFixture.projectId,
      {
        authorization: { requirePermission: async () => undefined },
        localizationSubstrate: {
          resolvePortSource: () => {
            throw new Error("the mocked localize route must not resolve workflow ports");
          },
        },
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
          async getDashboardStatus() {
            return dashboardStatusFixture;
          },
        },
      },
    );

    expect(response).toMatchObject({ statusCode: 422, body: { code: "workflow_failed" } });
  });
});
