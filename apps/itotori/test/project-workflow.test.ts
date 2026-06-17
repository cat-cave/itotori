import type {
  AuthorizationActor,
  ItotoriProjectRecord,
  ItotoriProjectRepositoryPort,
  ProjectDashboardStatus,
  RuntimeDashboardStatus,
} from "@itotori/db";
import type { BridgeBundle, RuntimeVerificationReport } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import {
  ItotoriProjectWorkflowService,
  type ProjectState,
} from "../src/services/project-workflow.js";

const actor: AuthorizationActor = { userId: "user-test" };

describe("ItotoriProjectWorkflowService", () => {
  it("imports source bundles through the repository boundary", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    const project = await service.importBridge(bridgeFixture());

    expect(project).toMatchObject({
      projectId: "019ed000-0000-7000-8000-project00001",
      localeBranchId: "019ed000-0000-7000-8000-locale000001",
      targetLocale: "en-US",
      drafts: {},
    });
    expect(repository.importSourceBundle).toHaveBeenCalledWith(actor, project);
  });

  it("drafts deterministic translations before saving drafts", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const project = projectFixture({ drafts: {} });

    const drafted = await service.draftProject(project, "fr-FR");

    expect(drafted.targetLocale).toBe("fr-FR");
    expect(drafted.drafts["bridge-unit-test"]).toBe("Hello, {player}.");
    expect(repository.saveDrafts).toHaveBeenCalledWith(actor, drafted);
    expect(project.drafts).toEqual({});
  });

  it("validates protected spans before writing patch exports", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);

    await expect(
      service.exportPatch(projectFixture({ drafts: { "bridge-unit-test": "Hello." } })),
    ).rejects.toThrow("lost protected span {player}");

    expect(repository.savePatchExport).not.toHaveBeenCalled();
  });

  it("stores runtime reports through the repository and returns CLI output", async () => {
    const repository = repositoryFixture();
    const service = new ItotoriProjectWorkflowService(repository, actor);
    const project = projectFixture();
    const report = runtimeReportFixture();

    const result = await service.ingestRuntimeReport(project, report);

    expect(repository.saveRuntimeReport).toHaveBeenCalledWith(
      actor,
      result.project,
      report,
      "019ed000-0000-7000-8000-patchres0001",
    );
    expect(result.result).toMatchObject({
      status: "hello_world_passed",
      bridgeId: "bridge-test",
      localeBranchId: "locale-en-us",
      runtimeReportId: "runtime-test",
      dashboard: dashboardStatusFixture,
    });
  });
});

function repositoryFixture(): ItotoriProjectRepositoryPort {
  return {
    reset: vi.fn(async () => {}),
    importSourceBundle: vi.fn(
      async (_actor: AuthorizationActor, _project: ItotoriProjectRecord) => {},
    ),
    saveDrafts: vi.fn(async (_actor: AuthorizationActor, _project: ItotoriProjectRecord) => {}),
    savePatchExport: vi.fn(async () => {}),
    saveRuntimeReport: vi.fn(async () => dashboardStatusFixture),
    appendEvent: vi.fn(async () => {}),
    recordFinding: vi.fn(async () => {}),
    linkArtifact: vi.fn(async () => {}),
    getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
    getRuntimeStatus: vi.fn(async () => runtimeStatusFixture),
  };
}

function projectFixture(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    bridge: bridgeFixture(),
    drafts: { "bridge-unit-test": "Hello, {player}." },
    ...overrides,
  };
}

function bridgeFixture(): BridgeBundle {
  return {
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
          { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
        ],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "hello.scene.001.line.001",
        },
      },
    ],
  };
}

function runtimeReportFixture(): RuntimeVerificationReport {
  return {
    schemaVersion: "0.1.0",
    runtimeReportId: "runtime-test",
    adapterName: "utsushi-fixture",
    fidelityTier: "layout_probe",
    status: "passed",
    textEvents: [],
    frameCaptures: [],
    approximations: [],
  };
}

const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-test",
  projectKey: "project-test",
  name: "project-test",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-test",
  sourceBundleHash: "hash-test",
  sourceBundleRevisionId: "revision-test",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 0,
  latestEventKind: null,
  latestEventAt: null,
  localeBranches: [],
};

const runtimeStatusFixture: RuntimeDashboardStatus = {
  finalStatus: "hello_world_passed",
  runtimeReportId: "runtime-test",
  runtimeStatus: "passed",
  fidelityTier: "layout_probe",
  evidenceTier: null,
  textEventCount: 0,
  frameCaptureCount: 0,
  screenshotArtifactCount: 0,
  recordingArtifactCount: 0,
  validationFindingCount: 0,
};
