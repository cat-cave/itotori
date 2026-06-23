import { readFileSync } from "node:fs";
import {
  localUserId,
  type AuthorizationActor,
  type ItotoriProjectRepositoryPort,
} from "@itotori/db";
import {
  computePatchResultOutputHashRollupV02,
  type BridgeBundle,
  type PatchResultV02,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import {
  ItotoriProjectWorkflowService,
  PatchResultIngestionError,
  type ProjectState,
} from "../src/services/project-workflow.js";

const actor: AuthorizationActor = { userId: localUserId };

function helloGamePatchResultFixture(): PatchResultV02 {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as PatchResultV02;
}

function invalidPatchResultFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../packages/localization-bridge-schema/test/examples/invalid/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-test",
    sourceBundleHash: "hash-test",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [],
  };
}

function projectFixture(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "project-test",
    localeBranchId: "locale-test",
    targetLocale: "fr-FR",
    drafts: {},
    bridge: bridgeFixture(),
    ...overrides,
  };
}

function repositoryFixture(): ItotoriProjectRepositoryPort {
  return {
    reset: vi.fn(async () => {}),
    importSourceBundle: vi.fn(async () => {
      throw new Error("not used");
    }),
    saveDrafts: vi.fn(async () => {}),
    savePatchExport: vi.fn(async () => {}),
    saveRuntimeReport: vi.fn(async () => {
      throw new Error("not used");
    }),
    appendEvent: vi.fn(async () => {}),
    recordFinding: vi.fn(async () => {}),
    linkArtifact: vi.fn(async () => {}),
    recordBenchmarkArtifactWithProviderLedger: vi.fn(async () => {}),
    listLocaleBranchIdentities: vi.fn(async () => []),
    getDashboardStatus: vi.fn(async () => {
      throw new Error("not used");
    }),
    getRuntimeStatus: vi.fn(async () => {
      throw new Error("not used");
    }),
    getDashboardDecisions: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

describe("ItotoriProjectWorkflowService.ingestPatchResult", () => {
  it("accepts the hello-game v0.2 patch result and returns the recorded ids", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const patchResult = helloGamePatchResultFixture();
    const project = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: patchResult.patchExportId,
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });

    const ingest = await service.ingestPatchResult(project, patchResult);

    expect(ingest.result.patchResultId).toBe(patchResult.patchResultId);
    expect(ingest.result.patchExportId).toBe(patchResult.patchExportId);
    expect(ingest.result.status).toBe("passed");
    expect(ingest.result.diagnostics).toEqual([]);
    expect(ingest.project.patchResult).toEqual(patchResult);
    expect(repository.recordFinding).not.toHaveBeenCalled();
  });

  it("rejects patch results whose patchExportId disagrees with the project's recorded export", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const patchResult = helloGamePatchResultFixture();
    const project = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: "019ed012-0000-7000-8000-deadbeef0901",
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });

    await expect(service.ingestPatchResult(project, patchResult)).rejects.toMatchObject({
      diagnostic: {
        code: "kaifuu.patch_result.mismatched_export_id",
      },
    });
    expect(repository.recordFinding).not.toHaveBeenCalled();
  });

  it("rejects passed results whose outputHash does not match the touched-assets rollup", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const patchResult = helloGamePatchResultFixture();
    const tampered: PatchResultV02 = {
      ...patchResult,
      outputHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const project = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: patchResult.patchExportId,
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });

    await expect(service.ingestPatchResult(project, tampered)).rejects.toMatchObject({
      diagnostic: {
        code: "kaifuu.patch_result.output_hash_drift",
      },
    });
  });

  it("raises a P0 finding and records a silent_partial_write diagnostic for retained_partial dispositions", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const patchResult: PatchResultV02 = {
      schemaVersion: "0.2.0",
      patchResultId: "019ed010-0000-7000-8000-00000000fb02",
      patchExportId: "019ed010-0000-7000-8000-000000000901",
      adapterId: "kaifuu-reallive",
      status: "failed",
      failures: [
        {
          failureId: "019ed010-0000-7000-8000-00000000fb22",
          category: "patch_write_failed",
          diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
          cause: "mid-write corruption could not be rolled back",
          assetId: "019ed010-0000-7000-8000-000000000810",
          bridgeUnitId: "019ed010-0000-7000-8000-000000000201",
          adapterId: "kaifuu-reallive",
          command: "patch.write_string_slot",
        },
      ],
      failureCategories: ["patch_write_failed"],
      partialWrite: {
        attemptedAssetIds: ["019ed010-0000-7000-8000-000000000810"],
        writtenAssetIds: ["019ed010-0000-7000-8000-000000000810"],
        skippedAssetIds: [],
        disposition: "retained_partial",
      },
    };
    const project = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: patchResult.patchExportId,
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });

    const ingest = await service.ingestPatchResult(project, patchResult);

    expect(ingest.result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "kaifuu.patch_result.silent_partial_write",
        pointer: "/partialWrite/disposition",
      }),
    );
    expect(repository.recordFinding).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        projectId: "project-test",
        status: "open",
        finding: expect.objectContaining({
          findingKind: "patching_issue",
          severity: "P0",
        }),
      }),
    );
  });

  it("computes the same rollup hash as the schema asserter", () => {
    const patchResult = helloGamePatchResultFixture();
    const rollup = computePatchResultOutputHashRollupV02(patchResult.touchedAssets ?? []);
    expect(rollup).toBe(patchResult.outputHash);
  });

  it("surfaces PatchResultIngestionError when boundary check fails", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const patchResult = helloGamePatchResultFixture();
    const project = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: "019ed012-0000-7000-8000-deadbeef0901",
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });

    await expect(service.ingestPatchResult(project, patchResult)).rejects.toBeInstanceOf(
      PatchResultIngestionError,
    );
  });
});

describe("ingest-patch-result CLI command", () => {
  it("schema-rejects the missing-failure-category invalid fixture before invoking the workflow", async () => {
    const invalid = invalidPatchResultFixture("patch-result-v0.2-missing-failure-category.json");
    const project: ProjectState = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: "019ed001-0000-7000-8000-000000000901",
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });
    const reads = new Map<string, unknown>([
      ["project.json", project],
      ["patch-result.json", invalid],
    ]);
    const writes = new Map<string, unknown>();
    const services = servicesFixtureWithPassthrough();

    await expect(
      runItotoriCliCommand(
        [
          "ingest-patch-result",
          "--project",
          "project.json",
          "--patch-result",
          "patch-result.json",
          "--output",
          "ingest.json",
        ],
        {
          io: {
            readJson: (path: string) => reads.get(path),
            writeJson: (path: string, value: unknown) => {
              writes.set(path, value);
            },
          },
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(services),
        },
      ),
    ).rejects.toThrow(/kaifuu\.patch_result\.missing_failure_category/);
    expect(services.projectWorkflow.ingestPatchResult).not.toHaveBeenCalled();
  });

  it("writes ingest summary and updated project state on success", async () => {
    const patchResult = helloGamePatchResultFixture();
    const project: ProjectState = projectFixture({
      patchExport: {
        schemaVersion: "0.1.0",
        patchExportId: patchResult.patchExportId,
        sourceBridgeId: "bridge-1",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        targetLocale: "fr-FR",
        entries: [],
      },
    });
    const reads = new Map<string, unknown>([
      ["project.json", project],
      ["patch-result.json", patchResult],
    ]);
    const writes = new Map<string, unknown>();
    const services = servicesFixtureWithPassthrough();

    await runItotoriCliCommand(
      [
        "ingest-patch-result",
        "--project",
        "project.json",
        "--patch-result",
        "patch-result.json",
        "--output",
        "ingest.json",
      ],
      {
        io: {
          readJson: (path: string) => reads.get(path),
          writeJson: (path: string, value: unknown) => {
            writes.set(path, value);
          },
        },
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(writes.get("project.json")).toMatchObject({ patchResult });
    expect(writes.get("ingest.json")).toMatchObject({
      patchResultId: patchResult.patchResultId,
      patchExportId: patchResult.patchExportId,
      status: "passed",
      diagnostics: [],
    });
  });
});

function servicesFixtureWithPassthrough(): ItotoriCliServices {
  const repository = repositoryFixture();
  const workflow = new ItotoriProjectWorkflowService(repository, actor);
  return {
    projectWorkflow: new Proxy(workflow, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value === "function") {
          return vi.fn(value.bind(target));
        }
        return value;
      },
    }) as unknown as ItotoriCliServices["projectWorkflow"],
    manualFeedback: {
      importManualFeedback: vi.fn(async () => {
        throw new Error("not used");
      }),
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
      listCatalogCandidateMatches: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    styleGuideFixtureFlow: {
      run: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  };
}
