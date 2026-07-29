import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  allPermissions,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  RuntimeRunNotFoundError,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { createDatabaseContext } from "../src/connection.js";
import { ItotoriLocalizationResultRevisionRepository } from "../src/repositories/localization-result-revision-repository.js";
import { migrate, migrations } from "../src/migrations.js";
import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportInput,
} from "../src/repositories/feedback-repository.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";
import {
  bridgeV02Fixture,
  escapeRegExp,
  invalidLegacyRuntimeArtifactUriCases,
  invalidManagedRuntimeArtifactUriCases,
  localActor,
  manualFeedbackFixture,
  patchExportV02Fixture,
  projectFixture,
  projectV02Fixture,
  runtimeEvidenceReportFixture,
  stableSerializeHashInput,
  stableSerializeValue,
  v02Sha256,
} from "./repository.test.shared.js";
import {
  databaseUrlWithSearchPath,
  migratedContext,
  migrationSql,
  quoteIdentifier,
  requiredDatabaseUrl,
  seedLegacyHelloWorldState,
  seedLegacySelectedPatchForRetirement,
} from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("rejects legacy runtime capture refs through repository and direct SQL", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      for (const [index, [_label, uri]] of invalidLegacyRuntimeArtifactUriCases.entries()) {
        await expect(
          repo.saveRuntimeReport(
            localActor,
            project,
            {
              schemaVersion: "0.1.0",
              runtimeReportId: "legacy-runtime-uri-parity",
              adapterName: "utsushi-fixture",
              fidelityTier: "layout_probe",
              status: "passed",
              textEvents: [],
              frameCaptures: [
                {
                  frameCaptureId: "legacy-runtime-capture",
                  bridgeUnitId: "bridge-unit-test",
                  width: 320,
                  height: 180,
                  nonZeroPixels: 57600,
                  artifactPath: uri,
                },
              ],
              approximations: [],
            },
            "legacy-runtime-uri-patch-result",
          ),
        ).rejects.toThrow(new RegExp(`portable relative artifact path.*${escapeRegExp(uri)}`));

        await expect(
          context.pool.query(
            `insert into itotori_artifacts (
              artifact_id, project_id, artifact_kind, uri, metadata
            ) values ($1, $2, 'frame_capture', $3, '{}'::jsonb)`,
            [`legacy-runtime-uri-direct-${index}`, project.projectId, uri],
          ),
        ).rejects.toThrow(/itotori_legacy_runtime_artifact_uri_check/u);
      }

      await expect(
        context.pool.query(
          `insert into itotori_artifacts (
            artifact_id, project_id, artifact_kind, uri, metadata
          ) values ($1, $2, 'frame_capture', $3, '{}'::jsonb)`,
          [
            "legacy-runtime-uri-direct-valid",
            project.projectId,
            "artifacts/utsushi/runtime/legacy-run/frame-captures/capture.png",
          ],
        ),
      ).resolves.toBeDefined();
    } finally {
      await context.close();
    }
  });
  it("supports multiple locale branches for one project", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);

      await repo.importSourceBundle(localActor, projectFixture());
      await repo.importSourceBundle(
        localActor,
        projectFixture({
          localeBranchId: "locale-fr-fr",
          targetLocale: "fr-FR",
          drafts: { "bridge-unit-test": "Bonjour, {player}." },
        }),
      );

      const status = await repo.getDashboardStatus();
      expect(status.branchCount).toBe(2);
      expect(status.localeBranches.map((branch) => branch.targetLocale).sort()).toEqual([
        "en-US",
        "fr-FR",
      ]);
    } finally {
      await context.close();
    }
  });
  it("keeps stable locale branch identities for multiple targets on one source revision", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);

      await repo.importSourceBundle(localActor, projectFixture());
      await repo.importSourceBundle(
        localActor,
        projectFixture({
          localeBranchId: "locale-fr-fr",
          targetLocale: "fr-FR",
          drafts: { "bridge-unit-test": "Bonjour, {player}." },
        }),
      );
      await repo.importSourceBundle(
        localActor,
        projectFixture({
          localeBranchId: "locale-ko-kr",
          targetLocale: "ko-KR",
          drafts: { "bridge-unit-test": "Annyeonghaseyo, {player}." },
        }),
      );
      await repo.savePatchExport(
        localActor,
        projectFixture({
          localeBranchId: "locale-fr-fr",
          targetLocale: "fr-FR",
          drafts: { "bridge-unit-test": "Bonjour, {player}." },
        }),
        {
          schemaVersion: "0.1.0",
          patchExportId: "patch-fr-fr",
          sourceBridgeId: "bridge-test",
          sourceBundleHash: "hash-test",
          sourceLocale: "ja-JP",
          targetLocale: "fr-FR",
          entries: [
            {
              entryId: "entry-fr-fr",
              bridgeUnitId: "bridge-unit-test",
              sourceUnitKey: "hello.scene.001.line.001",
              sourceHash: "source-hash",
              targetText: "Bonjour, {player}.",
              protectedSpanMappings: [{ raw: "{player}", targetStart: 9, targetEnd: 17 }],
            },
          ],
        },
      );
      await repo.recordBenchmarkArtifactWithProviderLedger(localActor, {
        artifact: {
          artifactId: "benchmark-ko-kr",
          projectId: "project-test",
          localeBranchId: "locale-ko-kr",
          artifactKind: "benchmark_report",
          metadata: {
            schemaVersion: "0.2.0",
            benchmarkName: "ko-KR branch identity fixture",
          },
        },
        providerRuns: [],
      });

      const firstIdentities = await repo.listLocaleBranchIdentities("project-test");
      expect(firstIdentities.map((branch) => branch.localeBranchId)).toEqual([
        "locale-en-us",
        "locale-fr-fr",
        "locale-ko-kr",
      ]);
      expect(firstIdentities.map((branch) => branch.targetLocale)).toEqual([
        "en-US",
        "fr-FR",
        "ko-KR",
      ]);
      expect(new Set(firstIdentities.map((branch) => branch.sourceBundleRevisionId))).toEqual(
        new Set(["bridge-test:bundle-revision"]),
      );

      await repo.importSourceBundle(
        localActor,
        projectFixture({
          localeBranchId: "locale-fr-fr",
          targetLocale: "fr-FR",
          drafts: { "bridge-unit-test": "Salut, {player}." },
        }),
      );
      await context.pool.query("delete from itotori_locale_branch_units");

      const secondIdentities = await repo.listLocaleBranchIdentities("project-test");
      expect(secondIdentities).toEqual(
        firstIdentities.map((branch) =>
          branch.localeBranchId === "locale-fr-fr"
            ? { ...branch, branchName: "fr-FR", targetLocale: "fr-FR", status: "active" }
            : branch,
        ),
      );
      const artifactRows = await context.db.execute(sql`
        select artifact_id, locale_branch_id, artifact_kind, metadata->>'targetLocale' as target_locale
        from ${artifacts}
        where artifact_id in ('patch-fr-fr', 'benchmark-ko-kr')
        order by artifact_id
      `);
      expect(artifactRows.rows).toEqual([
        expect.objectContaining({
          artifact_id: "benchmark-ko-kr",
          artifact_kind: "benchmark_report",
          locale_branch_id: "locale-ko-kr",
          target_locale: null,
        }),
        expect.objectContaining({
          artifact_id: "patch-fr-fr",
          artifact_kind: "patch_export",
          locale_branch_id: "locale-fr-fr",
          target_locale: "fr-FR",
        }),
      ]);
    } finally {
      await context.close();
    }
  });
  it("lists recorded benchmark reports with persisted QA calibration", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      await repo.recordBenchmarkArtifactWithProviderLedger(localActor, {
        artifact: {
          artifactId: "benchmark-qa-calibration",
          projectId: "project-test",
          localeBranchId: "locale-en-us",
          artifactKind: "benchmark_report",
          metadata: {
            schemaVersion: "0.2.0",
            benchmarkName: "QA calibration fixture",
            status: "passed",
            createdAt: "2026-06-27T00:00:00.000Z",
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
            systemCount: 2,
            findingCount: 3,
            penaltyTotal: 10,
            qaAgents: [
              {
                qaAgentId: "terminology-qa-agent",
                qaAgentVersion: "0.2.0",
                evaluatedSystemId: "itotori-draft",
                truePositives: 1,
                falsePositives: 2,
                falseNegatives: 1,
                seededPrecision: 0.333333,
                seededRecall: 0.5,
                f1: 0.4,
                findingsEmitted: 3,
                scorableFindings: 3,
              },
            ],
          },
        },
        providerRuns: [],
      });

      const reports = await repo.listBenchmarkReports("project-test");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        benchmarkRunId: "benchmark-qa-calibration",
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        benchmarkName: "QA calibration fixture",
        status: "passed",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        systemCount: 2,
        findingCount: 3,
        penaltyTotal: 10,
      });
      expect(reports[0]?.qaAgents).toEqual([
        {
          qaAgentId: "terminology-qa-agent",
          qaAgentVersion: "0.2.0",
          evaluatedSystemId: "itotori-draft",
          truePositives: 1,
          falsePositives: 2,
          falseNegatives: 1,
          seededPrecision: 0.333333,
          seededRecall: 0.5,
          f1: 0.4,
          findingsEmitted: 3,
          scorableFindings: 3,
        },
      ]);
    } finally {
      await context.close();
    }
  });
  it("records append-only events, findings, and artifact links", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      await repo.appendEvent(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        event: {
          eventId: "event-finding",
          eventKind: "qa_finding_reported",
          occurredAt: "2026-06-17T00:00:00.000Z",
          actor: { actorKind: "tool", displayName: "deterministic-check" },
          findingId: "finding-test",
          subjectRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
          provenance: [],
          causalLinks: [],
          payload: { check: "protected-span" },
        },
      });

      await expect(
        context.pool.query("update itotori_events set event_kind = $1 where event_id = $2", [
          "task_started",
          "event-finding",
        ]),
      ).rejects.toThrow(/append-only/);

      await repo.recordFinding(localActor, {
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        finding: {
          findingId: "finding-test",
          findingKind: "protected_span_issue",
          severity: "P1",
          qualityCategory: "protected_content",
          title: "Protected span moved",
          description: "A placeholder was not preserved.",
          impact: "Patch output could break runtime substitution.",
          createdAt: "2026-06-17T00:00:00.000Z",
          firstSeenEventId: "event-finding",
          affectedRefs: [{ subjectKind: "bridge_unit", subjectId: "bridge-unit-test" }],
          evidence: [],
          provenance: [],
          causalLinks: [],
        },
      });
      await repo.linkArtifact(localActor, {
        artifactId: "artifact-finding",
        projectId: "project-test",
        localeBranchId: "locale-en-us",
        bridgeUnitId: "bridge-unit-test",
        findingId: "finding-test",
        artifactKind: "validator_message",
        uri: "fixture://validator/protected-span",
        metadata: { rule: "protected-span" },
      });

      const status = await repo.getDashboardStatus();
      expect(status.findingCount).toBe(1);
      expect(status.localeBranches[0]?.openFindingCount).toBe(1);
      expect(status.artifactCount).toBe(1);
    } finally {
      await context.close();
    }
  });
});
