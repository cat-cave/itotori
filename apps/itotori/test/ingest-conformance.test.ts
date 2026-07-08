import { readFileSync } from "node:fs";
import {
  localUserId,
  type AuthorizationActor,
  type ItotoriConformanceRepositoryPort,
  type ItotoriProjectRepositoryPort,
  type SaveConformanceRunInput,
  type SaveConformanceRunResult,
} from "@itotori/db";
import {
  ConformanceIngestionError,
  type BridgeBundle,
  type ConformanceManifestV01,
  type ConformanceResultV01,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import {
  ItotoriProjectWorkflowService,
  type ProjectState,
} from "../src/services/project-workflow.js";

const actor: AuthorizationActor = { userId: localUserId };

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/utsushi-conformance/${name}`, import.meta.url), "utf8"),
  ) as T;
}

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-conformance",
    sourceBundleHash: "hash-conformance",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [],
  };
}

function projectFixture(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "project-conformance",
    localeBranchId: "locale-conformance",
    targetLocale: "en-US",
    drafts: {},
    bridge: bridgeFixture(),
    ...overrides,
  };
}

function projectRepositoryFixture(): ItotoriProjectRepositoryPort {
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
    listBenchmarkReports: vi.fn(async () => []),
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

function conformanceRepositoryStub(): {
  port: ItotoriConformanceRepositoryPort;
  calls: SaveConformanceRunInput[];
} {
  const calls: SaveConformanceRunInput[] = [];
  const port: ItotoriConformanceRepositoryPort = {
    saveConformanceRun: vi.fn(
      async (
        _actor: AuthorizationActor,
        input: SaveConformanceRunInput,
      ): Promise<SaveConformanceRunResult> => {
        calls.push(input);
        return {
          conformanceRunId: input.conformanceRunId,
          resultIds: input.results.map((entry) => entry.conformanceResultId),
          findingIds: [],
        };
      },
    ),
    loadConformanceRun: vi.fn(async () => null),
  };
  return { port, calls };
}

describe("ItotoriProjectWorkflowService.ingestConformanceReport", () => {
  it("ingest_conformance_report_persists_pass_with_byte_equal_evidence_tier()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const manifest = loadFixture<ConformanceManifestV01>("manifest-baseline-text-trace.json");
    const result = loadFixture<ConformanceResultV01>("positive-text-trace-pass.json");

    const ingest = await service.ingestConformanceReport(project, {
      manifest,
      results: [result],
    });

    expect(ingest.result.counts.passCount).toBe(1);
    expect(ingest.result.counts.resultCount).toBe(1);
    expect(ingest.result.results[0]!.passEvidenceTier).toBe("E1");
    expect(ingest.result.results[0]!.outcomeKind).toBe("pass");
    expect(conformance.calls).toHaveLength(1);
    expect(conformance.calls[0]!.results[0]!.result.outcome).toEqual(result.outcome);
  });

  it("ingest_conformance_report_rejects_disallowed_semantic_code_at_schema_layer()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const bad = loadFixture<ConformanceResultV01>("negative-disallowed-semantic-code.json");

    await expect(
      service.ingestConformanceReport(project, { results: [bad] }),
    ).rejects.toBeInstanceOf(ConformanceIngestionError);
    expect(conformance.calls).toHaveLength(0);
  });

  it("ingest_conformance_report_rejects_promoted_skip_at_schema_layer()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const bad = loadFixture<unknown>("negative-skip-as-pass.json") as ConformanceResultV01;

    await expect(
      service.ingestConformanceReport(project, { results: [bad] }),
    ).rejects.toBeInstanceOf(ConformanceIngestionError);
    expect(conformance.calls).toHaveLength(0);
  });

  it("ingest_conformance_report_rejects_orphan_result_not_declared_in_manifest()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const manifest = loadFixture<ConformanceManifestV01>("manifest-baseline-text-trace.json");
    const orphan = loadFixture<ConformanceResultV01>("negative-orphan-result.json");

    await expect(
      service.ingestConformanceReport(project, {
        manifest,
        results: [orphan, loadFixture<ConformanceResultV01>("positive-text-trace-pass.json")],
      }),
    ).rejects.toMatchObject({ code: "itotori.conformance.profile_not_declared" });
    expect(conformance.calls).toHaveLength(0);
  });

  it("ingest_conformance_report_summary_counts_match_input_outcomes()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const passText = loadFixture<ConformanceResultV01>("positive-text-trace-pass.json");
    const skipFrame: ConformanceResultV01 = {
      ...passText,
      profileId: "frame-capture",
      outcome: {
        kind: "skip",
        semanticCode: "utsushi.conformance.profile_not_reported",
        reason: "filter excluded",
      },
      evidence: [],
    };
    const failRecording: ConformanceResultV01 = {
      ...passText,
      profileId: "recording-capture",
      outcome: {
        kind: "fail",
        semanticCode: "utsushi.conformance.evidence_tier_mismatch",
        detail: "tier mismatch",
      },
      evidence: [],
    };

    const ingest = await service.ingestConformanceReport(project, {
      results: [passText, skipFrame, failRecording],
    });

    expect(ingest.result.counts).toEqual({
      passCount: 1,
      failCount: 1,
      skipCount: 1,
      unsupportedCount: 0,
      resultCount: 3,
    });
  });

  it("ingest_conformance_report_persists_byte_equal_skip_outcome_distinctly_from_pass()", async () => {
    const projectRepository = projectRepositoryFixture();
    const conformance = conformanceRepositoryStub();
    const service = new ItotoriProjectWorkflowService(
      projectRepository,
      actor,
      undefined,
      undefined,
      undefined,
      conformance.port,
    );
    const project = projectFixture();
    const skip: ConformanceResultV01 = {
      schemaVersion: "0.2.0-alpha",
      adapterId: "utsushi-synthetic",
      profileId: "frame-capture",
      outcome: {
        kind: "skip",
        semanticCode: "utsushi.conformance.profile_not_reported",
        reason: "filter excluded",
      },
      evidence: [],
      recordedAt: "2026-06-23T12:00:00Z",
    };
    const ingest = await service.ingestConformanceReport(project, { results: [skip] });
    expect(ingest.result.results[0]!.outcomeKind).toBe("skip");
    expect(ingest.result.results[0]!.passEvidenceTier).toBeNull();
    expect(ingest.result.results[0]!.semanticCode).toBe("utsushi.conformance.profile_not_reported");
  });
});

describe("ingest-conformance CLI command", () => {
  it("cli_ingest_conformance_writes_byte_equal_output_when_output_flag_passed()", async () => {
    const project = projectFixture();
    const manifest = loadFixture<ConformanceManifestV01>("manifest-baseline-text-trace.json");
    const result = loadFixture<ConformanceResultV01>("positive-text-trace-pass.json");
    const reads = new Map<string, unknown>([
      ["project.json", project],
      ["manifest.json", manifest],
      ["report.json", [result]],
    ]);
    const writes = new Map<string, unknown>();
    const services = servicesFixtureWithConformanceWorkflow();

    await runItotoriCliCommand(
      [
        "ingest-conformance",
        "--project",
        "project.json",
        "--report-file",
        "report.json",
        "--manifest-file",
        "manifest.json",
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

    const ingestOutput = writes.get("ingest.json") as {
      results: Array<{ passEvidenceTier: string | null }>;
    };
    expect(ingestOutput.results[0]!.passEvidenceTier).toBe("E1");
  });

  it("cli_ingest_conformance_throws_when_report_file_missing()", async () => {
    const project = projectFixture();
    const reads = new Map<string, unknown>([["project.json", project]]);
    const services = servicesFixtureWithConformanceWorkflow();

    await expect(
      runItotoriCliCommand(
        ["ingest-conformance", "--project", "project.json", "--report-file", "missing-report.json"],
        {
          io: {
            readJson: (path: string) => {
              const value = reads.get(path);
              if (value === undefined) throw new Error(`missing fixture ${path}`);
              return value;
            },
            writeJson: vi.fn(),
          },
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(services),
        },
      ),
    ).rejects.toThrow(/missing fixture missing-report.json/);
  });

  it("cli_ingest_conformance_throws_when_manifest_schema_version_mismatch()", async () => {
    const project = projectFixture();
    const manifest = loadFixture<ConformanceManifestV01>("manifest-baseline-text-trace.json");
    const drifted = { ...manifest, schemaVersion: "0.0.0" };
    const result = loadFixture<ConformanceResultV01>("positive-text-trace-pass.json");
    const reads = new Map<string, unknown>([
      ["project.json", project],
      ["manifest.json", drifted],
      ["report.json", [result]],
    ]);
    const services = servicesFixtureWithConformanceWorkflow();

    await expect(
      runItotoriCliCommand(
        [
          "ingest-conformance",
          "--project",
          "project.json",
          "--report-file",
          "report.json",
          "--manifest-file",
          "manifest.json",
        ],
        {
          io: {
            readJson: (path: string) => reads.get(path),
            writeJson: vi.fn(),
          },
          migrateDatabase: vi.fn(async () => {}),
          withServices: async (callback) => await callback(services),
        },
      ),
    ).rejects.toThrow(/itotori\.conformance\.schema_version_mismatch/);
  });
});

function servicesFixtureWithConformanceWorkflow(): ItotoriCliServices {
  const projectRepository = projectRepositoryFixture();
  const conformance = conformanceRepositoryStub();
  const workflow = new ItotoriProjectWorkflowService(
    projectRepository,
    actor,
    undefined,
    undefined,
    undefined,
    conformance.port,
  );
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
