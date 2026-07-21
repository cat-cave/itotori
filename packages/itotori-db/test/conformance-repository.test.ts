import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import type { BridgeBundle, ConformanceResultV01 } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import { ItotoriConformanceRepository } from "../src/repositories/conformance-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

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

function projectFixture(projectId: string): ItotoriProjectRecord {
  return {
    projectId,
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: `${projectId}-branch`,
    targetLocale: "en-US",
    drafts: {},
    bridge: { ...bridgeFixture(), bridgeId: `bridge-${projectId}` },
  };
}

function passResult(
  profileId: ConformanceResultV01["profileId"],
  tier: "E0" | "E1" | "E2" | "E3" | "E4",
  evidence: ConformanceResultV01["evidence"],
): ConformanceResultV01 {
  return {
    schemaVersion: "0.2.0-alpha",
    adapterId: "utsushi-synthetic",
    profileId,
    outcome: { kind: "pass", evidenceTier: tier },
    evidence,
    recordedAt: "2026-06-23T12:00:00Z",
  };
}

function failResult(
  profileId: ConformanceResultV01["profileId"],
  semanticCode: string,
): ConformanceResultV01 {
  return {
    schemaVersion: "0.2.0-alpha",
    adapterId: "utsushi-synthetic",
    profileId,
    outcome: { kind: "fail", semanticCode, detail: "synthetic fail" },
    evidence: [],
    recordedAt: "2026-06-23T12:00:00Z",
  };
}

function skipResult(
  profileId: ConformanceResultV01["profileId"],
  semanticCode: string,
): ConformanceResultV01 {
  return {
    schemaVersion: "0.2.0-alpha",
    adapterId: "utsushi-synthetic",
    profileId,
    outcome: { kind: "skip", semanticCode, reason: "filter excluded" },
    evidence: [],
    recordedAt: "2026-06-23T12:00:00Z",
  };
}

function unsupportedResult(
  profileId: ConformanceResultV01["profileId"],
  semanticCode: string,
): ConformanceResultV01 {
  return {
    schemaVersion: "0.2.0-alpha",
    adapterId: "utsushi-synthetic",
    profileId,
    outcome: { kind: "unsupported", semanticCode, declaredInManifest: false },
    evidence: [],
    recordedAt: "2026-06-23T12:00:00Z",
  };
}

async function insertReportArtifact(
  context: DatabaseContext,
  projectId: string,
  artifactId: string,
): Promise<string> {
  await context.pool.query(
    `insert into itotori_artifacts (artifact_id, project_id, artifact_kind, metadata) values ($1, $2, $3, $4::jsonb)`,
    [artifactId, projectId, "conformance_report", "{}"],
  );
  return artifactId;
}

describe("ItotoriConformanceRepository", () => {
  it("conformance_repository_round_trips_a_pass_result_with_evidence_tier_byte_equal", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-pass");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa01",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const result = passResult("text-trace", "E1", [
        { artifactKind: "textLine", lineId: "trace-line-001" },
      ]);
      const conformanceRunId = "019ed028-0000-7000-8000-000000000001";
      const conformanceResultId = `${conformanceRunId}:result:000`;
      const saved = await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results: [{ conformanceResultId, result }],
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });
      expect(saved.resultIds).toEqual([conformanceResultId]);

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      expect(loaded).not.toBeNull();
      expect(loaded!.passCount).toBe(1);
      const row = loaded!.results[0]!;
      expect(row.outcomeKind).toBe("pass");
      expect(row.passEvidenceTier).toBe("E1");
      expect(row.passEvidenceTier).toBe(
        result.outcome.kind === "pass" ? result.outcome.evidenceTier : null,
      );
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_round_trips_a_skip_result_without_evidence_tier", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-skip");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa02",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const result = skipResult("frame-capture", "utsushi.conformance.profile_not_reported");
      const conformanceRunId = "019ed028-0000-7000-8000-000000000002";
      const conformanceResultId = `${conformanceRunId}:result:000`;
      await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results: [{ conformanceResultId, result }],
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      expect(loaded!.skipCount).toBe(1);
      const row = loaded!.results[0]!;
      expect(row.outcomeKind).toBe("skip");
      expect(row.passEvidenceTier).toBeNull();
      expect(row.semanticCode).toBe("utsushi.conformance.profile_not_reported");
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_round_trips_a_fail_result_with_semantic_code", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-fail");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa03",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const result = failResult("text-trace", "utsushi.conformance.evidence_tier_mismatch");
      const conformanceRunId = "019ed028-0000-7000-8000-000000000003";
      const conformanceResultId = `${conformanceRunId}:result:000`;
      await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results: [{ conformanceResultId, result }],
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      const row = loaded!.results[0]!;
      expect(row.outcomeKind).toBe("fail");
      expect(row.passEvidenceTier).toBeNull();
      expect(row.semanticCode).toBe("utsushi.conformance.evidence_tier_mismatch");
      expect(row.outcomeMessage).toBe("synthetic fail");
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_round_trips_an_unsupported_result_with_declared_in_manifest_false", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-unsupported");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa04",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const result = unsupportedResult("frame-capture", "utsushi.conformance.profile_not_declared");
      const conformanceRunId = "019ed028-0000-7000-8000-000000000004";
      const conformanceResultId = `${conformanceRunId}:result:000`;
      await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results: [{ conformanceResultId, result }],
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      const row = loaded!.results[0]!;
      expect(row.outcomeKind).toBe("unsupported");
      expect(row.declaredInManifest).toBe(false);
      expect(row.passEvidenceTier).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_persists_every_evidence_ref_kind", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-evidence");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa05",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const result = passResult("recording-capture", "E2", [
        {
          artifactKind: "runtimeArtifact",
          kind: "trace_log",
          uri: "artifacts/utsushi/runtime/synthetic-run/trace_log/trace-001.jsonl",
          artifactId: "trace-001",
        },
        { artifactKind: "textLine", lineId: "trace-line-001" },
        { artifactKind: "frameArtifactRef", frameId: "frame-0001" },
        { artifactKind: "replayLogRef", runId: "run-001" },
        { artifactKind: "implMapFixture", fixtureId: "fixture-a" },
        { artifactKind: "bridgeUnit", bridgeUnitId: "bridge-unit-001" },
        { artifactKind: "statePath", path: "port.frame" },
      ]);
      const conformanceRunId = "019ed028-0000-7000-8000-000000000005";
      const conformanceResultId = `${conformanceRunId}:result:000`;
      await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results: [{ conformanceResultId, result }],
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      const row = loaded!.results[0]!;
      expect(row.evidenceRefs).toHaveLength(7);
      expect(row.evidenceRefs.map((ref) => ref.evidenceKind)).toEqual([
        "runtimeArtifact",
        "textLine",
        "frameArtifactRef",
        "replayLogRef",
        "implMapFixture",
        "bridgeUnit",
        "statePath",
      ]);
      const runtime = row.evidenceRefs[0]!;
      expect(runtime.artifactKind).toBe("trace_log");
      expect(runtime.uri).toBe("artifacts/utsushi/runtime/synthetic-run/trace_log/trace-001.jsonl");
      expect(runtime.artifactId).toBe("trace-001");
      const statePath = row.evidenceRefs[6]!;
      expect(statePath.statePath).toBe("port.frame");
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_direct_sql_rejects_malformed_runtime_artifact_refs", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-absolute-uri");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa06",
      );

      await expect(
        context.pool.query(
          `insert into itotori_conformance_runs (
            conformance_run_id, project_id, report_artifact_id, adapter_id, abi_version,
            schema_version, recorded_at, metadata
          ) values ($1, $2, $3, $4, $5, $6, now(), '{}'::jsonb)`,
          [
            "019ed028-0000-7000-8000-000000000006",
            project.projectId,
            artifactId,
            "utsushi-synthetic",
            1,
            "0.2.0-alpha",
          ],
        ),
      ).resolves.toBeDefined();
      await expect(
        context.pool.query(
          `insert into itotori_conformance_results (
            conformance_result_id, conformance_run_id, project_id, adapter_id, profile_id,
            outcome_kind, pass_evidence_tier, recorded_at, metadata
          ) values ($1, $2, $3, $4, $5, 'pass', 'E1', now(), '{}'::jsonb)`,
          [
            "019ed028-0000-7000-8000-000000000006:result:000",
            "019ed028-0000-7000-8000-000000000006",
            project.projectId,
            "utsushi-synthetic",
            "text-trace",
          ],
        ),
      ).resolves.toBeDefined();

      const conformanceResultId = "019ed028-0000-7000-8000-000000000006:result:000";
      await expect(
        context.pool.query(
          `insert into itotori_conformance_evidence_refs (
            conformance_evidence_ref_id, conformance_result_id, evidence_kind, uri, ordinal
          ) values ($1, $2, 'runtimeArtifact', $3, 0)`,
          [
            "019ed028-0000-7000-8000-000000000006:ref:valid",
            conformanceResultId,
            "artifacts/utsushi/runtime/synthetic-run/traces/trace-001.json",
          ],
        ),
      ).resolves.toBeDefined();

      const invalidRuntimeArtifactUris = [
        [
          "current-directory dot segment",
          "artifacts/utsushi/runtime/./synthetic-run/traces/trace-001.json",
        ],
        [
          "parent-directory dot segment",
          "artifacts/utsushi/runtime/synthetic-run/../traces/trace-001.json",
        ],
        ["empty path segment", "artifacts/utsushi/runtime/synthetic-run//trace-001.json"],
        ["URI scheme", "https://example.invalid/trace-001.json"],
        ["absolute POSIX path", "/tmp/runtime/trace-001.json"],
        ["backslash path", "artifacts\\utsushi\\runtime\\trace-001.json"],
        ["missing managed runtime prefix", "artifacts/utsushi/schema-fixture/trace-001.json"],
      ] as const;

      for (const [index, [_label, uri]] of invalidRuntimeArtifactUris.entries()) {
        await expect(
          context.pool.query(
            `insert into itotori_conformance_evidence_refs (
              conformance_evidence_ref_id, conformance_result_id, evidence_kind, uri, ordinal
            ) values ($1, $2, 'runtimeArtifact', $3, $4)`,
            [
              `019ed028-0000-7000-8000-000000000006:ref:invalid-${index}`,
              conformanceResultId,
              uri,
              index + 1,
            ],
          ),
        ).rejects.toThrow(/itotori_conformance_evidence_refs_managed_uri_check/u);
      }
    } finally {
      await context.close();
    }
  });

  it("conformance_repository_run_counts_match_sum_of_outcome_kind_rows", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projectRepository = new ItotoriProjectRepository(
        context.db,
        testProjectEngineFamilyRegistry,
      );
      const project = projectFixture("project-counts");
      await projectRepository.importSourceBundle(localActor, project);
      const artifactId = await insertReportArtifact(
        context,
        project.projectId,
        "019ed028-0000-7000-8000-000000aaaa07",
      );

      const repository = new ItotoriConformanceRepository(context.db);
      const conformanceRunId = "019ed028-0000-7000-8000-000000000007";
      const results = [
        {
          conformanceResultId: `${conformanceRunId}:result:000`,
          result: passResult("text-trace", "E1", [
            { artifactKind: "textLine", lineId: "trace-line-001" },
          ]),
        },
        {
          conformanceResultId: `${conformanceRunId}:result:001`,
          result: failResult("text-trace", "utsushi.conformance.evidence_tier_mismatch"),
        },
        {
          conformanceResultId: `${conformanceRunId}:result:002`,
          result: skipResult("frame-capture", "utsushi.conformance.profile_not_reported"),
        },
        {
          conformanceResultId: `${conformanceRunId}:result:003`,
          result: unsupportedResult(
            "recording-capture",
            "utsushi.conformance.profile_not_declared",
          ),
        },
      ];
      await repository.saveConformanceRun(localActor, {
        conformanceRunId,
        projectId: project.projectId,
        localeBranchId: project.localeBranchId,
        reportArtifactId: artifactId,
        results,
        recordedAt: new Date("2026-06-23T12:00:00Z"),
        metadata: {},
      });

      const loaded = await repository.loadConformanceRun(localActor, conformanceRunId);
      expect(loaded!.resultCount).toBe(4);
      expect(loaded!.passCount).toBe(1);
      expect(loaded!.failCount).toBe(1);
      expect(loaded!.skipCount).toBe(1);
      expect(loaded!.unsupportedCount).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("returns null for unknown run ids", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriConformanceRepository(context.db);
      const loaded = await repository.loadConformanceRun(localActor, "no-such-run");
      expect(loaded).toBeNull();
    } finally {
      await context.close();
    }
  });
});
