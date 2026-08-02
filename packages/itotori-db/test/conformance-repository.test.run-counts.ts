import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { describe, expect, it } from "vitest";
import type { ConformanceResultV01 } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { DatabaseContext } from "../src/connection.js";
import { ItotoriConformanceRepository } from "../src/repositories/conformance-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import { currentProjectFixture } from "./current-project-fixture.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(projectId: string): ItotoriProjectRecord {
  return currentProjectFixture({
    seed: `conformance:${projectId}`,
    projectId,
    localeBranchId: `${projectId}-branch`,
    units: [],
  });
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
