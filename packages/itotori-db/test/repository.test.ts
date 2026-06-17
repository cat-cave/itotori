import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  allPermissions,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import { createDatabaseContext } from "../src/connection.js";
import { migrate } from "../src/migrations.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { userPermissionGrants } from "../src/schema.js";

const localActor: AuthorizationActor = { userId: localUserId };

function projectFixture(overrides: Partial<ItotoriProjectRecord> = {}): ItotoriProjectRecord {
  const project: ItotoriProjectRecord = {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
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
    },
  };
  return { ...project, ...overrides };
}

describe("ItotoriProjectRepository", () => {
  it("persists project, source bundle, units, artifacts, and branch status", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();

      await repo.importSourceBundle(localActor, project);
      await repo.saveDrafts(localActor, project);
      await repo.savePatchExport(localActor, project, {
        schemaVersion: "0.1.0",
        patchExportId: "patch-test",
        sourceBridgeId: "bridge-test",
        sourceBundleHash: "hash-test",
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        entries: [
          {
            entryId: "entry-test",
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
            sourceHash: "source-hash",
            targetText: "Hello, {player}.",
            protectedSpanMappings: [{ raw: "{player}", targetStart: 7, targetEnd: 15 }],
          },
        ],
      });
      const status = await repo.saveRuntimeReport(
        localActor,
        project,
        {
          schemaVersion: "0.1.0",
          runtimeReportId: "runtime-test",
          adapterName: "utsushi-fixture",
          fidelityTier: "layout_probe",
          status: "passed",
          textEvents: [
            {
              runtimeTextEventId: "runtime-text-test",
              bridgeUnitId: "bridge-unit-test",
              text: "Hello, {player}.",
              frame: 1,
            },
          ],
          frameCaptures: [
            {
              frameCaptureId: "frame-test",
              bridgeUnitId: "bridge-unit-test",
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactPath: "fixture://frame/1",
            },
          ],
          approximations: ["fixture"],
        },
        "patch-result-test",
      );

      expect(status.status).toBe("runtime_ingested");
      expect(status.sourceBundleId).toBe("bridge-test");
      expect(status.sourceBundleRevisionId).toBe("bridge-test:bundle-revision");
      expect(status.unitCount).toBe(1);
      expect(status.branchCount).toBe(1);
      expect(status.localeBranches[0]?.translatedUnitCount).toBe(1);
      expect(status.artifactCount).toBe(4);
      expect(status.latestEventKind).toBe("patch_result_recorded");

      const runtimeStatus = await repo.getRuntimeStatus();
      expect(runtimeStatus).toEqual({
        finalStatus: "hello_world_passed",
        runtimeReportId: "runtime-test",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: null,
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
      });
    } finally {
      await context.close();
    }
  });

  it("persists v0.2 runtime evidence tiers and bridge-linked evidence artifacts", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
      await repo.reset(localActor);
      const project = projectFixture();
      await repo.importSourceBundle(localActor, project);

      await repo.saveRuntimeReport(
        localActor,
        project,
        {
          schemaVersion: "0.2.0",
          runtimeReportId: "019ed003-0000-7000-8000-000000000001",
          adapterName: "utsushi-fixture",
          adapterVersion: "0.0.0",
          fidelityTier: "layout_probe",
          evidenceTier: "E2",
          status: "passed",
          createdAt: "2026-06-17T00:00:00.000Z",
          traceEvents: [
            {
              traceEventId: "019ed003-0000-7000-8000-000000000101",
              eventKind: "text_observed",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 1,
              traceKey: "hello.line.001",
              observedText: "Hello, {player}.",
            },
          ],
          branchEvents: [
            {
              branchEventId: "019ed003-0000-7000-8000-000000000201",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              frame: 2,
              branchPointKey: "hello.choice.001",
              promptText: "Choose a route",
              options: [
                {
                  optionId: "019ed003-0000-7000-8000-000000000211",
                  label: "Stay",
                  labelBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-test",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                  targetRouteKey: "hello.stay",
                  targetBridgeUnitRef: {
                    bridgeUnitId: "bridge-unit-test",
                    sourceUnitKey: "hello.scene.001.line.001",
                  },
                },
              ],
              selectedOptionId: "019ed003-0000-7000-8000-000000000211",
            },
          ],
          captures: [
            {
              captureId: "019ed003-0000-7000-8000-000000000301",
              bridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              evidenceTier: "E2",
              frame: 1,
              width: 320,
              height: 180,
              nonZeroPixels: 57600,
              artifactRef: {
                artifactId: "019ed003-0000-7000-8000-000000000401",
                artifactKind: "screenshot",
                uri: "artifacts/utsushi/hello/frame-0001.png",
                mediaType: "image/png",
              },
            },
          ],
          recordings: [],
          approximations: [
            {
              approximationId: "019ed003-0000-7000-8000-000000000701",
              approximationTier: "deterministic_fixture",
              scope: "fixture runtime",
              description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
              affectedBridgeUnitRefs: [
                {
                  bridgeUnitId: "bridge-unit-test",
                  sourceUnitKey: "hello.scene.001.line.001",
                },
              ],
              evidenceTierCeiling: "E2",
            },
          ],
          validationFindings: [],
          limitations: ["No reference-runtime pixel comparison is performed."],
        },
        "patch-result-v02",
      );

      const runtimeStatus = await repo.getRuntimeStatus();
      expect(runtimeStatus).toMatchObject({
        runtimeReportId: "019ed003-0000-7000-8000-000000000001",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: "E2",
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
      });

      const artifactResult = await context.pool.query<{
        artifact_kind: string;
        uri: string | null;
      }>("select artifact_kind, uri from itotori_artifacts where artifact_id = $1", [
        "019ed003-0000-7000-8000-000000000401",
      ]);
      expect(artifactResult.rows[0]).toEqual({
        artifact_kind: "screenshot",
        uri: "artifacts/utsushi/hello/frame-0001.png",
      });

      const evidenceArtifacts = await context.pool.query<{
        artifact_id: string;
        artifact_kind: string;
        bridge_unit_id: string | null;
        metadata: Record<string, unknown>;
      }>(
        `
        select artifact_id, artifact_kind, bridge_unit_id, metadata
        from itotori_artifacts
        where artifact_kind in ('runtime_trace_event', 'runtime_branch_event')
        order by artifact_kind
      `,
      );
      expect(evidenceArtifacts.rows).toHaveLength(2);

      const branchArtifact = evidenceArtifacts.rows.find(
        (row) => row.artifact_kind === "runtime_branch_event",
      );
      expect(branchArtifact).toMatchObject({
        artifact_id: "019ed003-0000-7000-8000-000000000201",
        bridge_unit_id: "bridge-unit-test",
      });
      expect(branchArtifact?.metadata).toMatchObject({
        runtimeReportId: "019ed003-0000-7000-8000-000000000001",
        branchPointKey: "hello.choice.001",
        bridgeUnitRefs: [
          {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        ],
        event: {
          branchEventId: "019ed003-0000-7000-8000-000000000201",
          bridgeUnitRef: {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
          options: [
            {
              labelBridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
              targetBridgeUnitRef: {
                bridgeUnitId: "bridge-unit-test",
                sourceUnitKey: "hello.scene.001.line.001",
              },
            },
          ],
        },
      });

      const traceArtifact = evidenceArtifacts.rows.find(
        (row) => row.artifact_kind === "runtime_trace_event",
      );
      expect(traceArtifact).toMatchObject({
        artifact_id: "019ed003-0000-7000-8000-000000000101",
        bridge_unit_id: "bridge-unit-test",
      });
      expect(traceArtifact?.metadata).toMatchObject({
        runtimeReportId: "019ed003-0000-7000-8000-000000000001",
        eventKind: "text_observed",
        bridgeUnitRefs: [
          {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        ],
        event: {
          traceEventId: "019ed003-0000-7000-8000-000000000101",
          bridgeUnitRef: {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      });
    } finally {
      await context.close();
    }
  });

  it("supports multiple locale branches for one project", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
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

  it("records append-only events, findings, and artifact links", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);
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

  it("bootstraps the MVP local user with every permission", async () => {
    const context = await migratedContext();
    try {
      const grants = await context.db
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, localUserId));

      expect(new Set(grants.map((grant) => grant.permission))).toEqual(new Set(allPermissions));
    } finally {
      await context.close();
    }
  });

  it("rejects repository mutations without the required permission", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db);

      await expect(
        repo.importSourceBundle({ userId: "user-without-grants" }, projectFixture()),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: permissionValues.projectImport,
      });
    } finally {
      await context.close();
    }
  });

  it("creates indexes for common project, branch, event, finding, and artifact lookups", async () => {
    const context = await migratedContext();
    try {
      const result = await context.db.execute(sql`
        select indexname
        from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'itotori_source_units_project_locale_key_idx',
            'itotori_source_bundles_revision_idx',
            'itotori_events_project_branch_time_idx',
            'itotori_findings_project_branch_status_idx',
            'itotori_artifacts_project_branch_kind_idx'
          )
      `);
      expect(new Set(result.rows.map((row) => String(row.indexname)))).toEqual(
        new Set([
          "itotori_source_units_project_locale_key_idx",
          "itotori_source_bundles_revision_idx",
          "itotori_events_project_branch_time_idx",
          "itotori_findings_project_branch_status_idx",
          "itotori_artifacts_project_branch_kind_idx",
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("backfills legacy hello-world state during the v0.2 migration", async () => {
    const databaseUrl = requiredDatabaseUrl();
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schemaName = `itotori_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    await admin.query(`create schema ${quoteIdentifier(schemaName)}`);
    const pool = new pg.Pool({
      connectionString: databaseUrlWithSearchPath(databaseUrl, schemaName),
    });
    try {
      await pool.query(migrationSql("0001_hello_world.sql"));
      await pool.query(migrationSql("0002_permissions.sql"));
      await seedLegacyHelloWorldState(pool);
      await pool.query(migrationSql("0003_persistence_v02.sql"));

      const project = await pool.query<{
        status: string;
        source_locale: string;
      }>("select status, source_locale from itotori_projects where project_id = $1", [
        "legacy-project",
      ]);
      expect(project.rows[0]).toEqual({
        status: "runtime_ingested",
        source_locale: "ja-JP",
      });

      const unit = await pool.query<{
        bridge_unit_id: string;
        target_text: string | null;
      }>(
        `
        select su.bridge_unit_id, lbu.target_text
        from itotori_source_units su
        join itotori_locale_branch_units lbu using (bridge_unit_id)
        where su.bridge_unit_id = $1
      `,
        ["legacy-unit"],
      );
      expect(unit.rows[0]).toEqual({
        bridge_unit_id: "legacy-unit",
        target_text: "Hello, {player}.",
      });

      const artifactsResult = await pool.query<{
        artifact_id: string;
        artifact_kind: string;
        metadata: Record<string, unknown>;
      }>(
        `
        select artifact_id, artifact_kind, metadata
        from itotori_artifacts
        where project_id = $1
        order by artifact_kind
      `,
        ["legacy-project"],
      );
      expect(artifactsResult.rows.map((row) => row.artifact_id).sort()).toEqual([
        "legacy-patch",
        "legacy-patch-result",
        "legacy-runtime",
      ]);
      expect(
        artifactsResult.rows.find((row) => row.artifact_kind === "runtime_report")?.metadata,
      ).toMatchObject({
        status: "passed",
        fidelityTier: "layout_probe",
        textEventCount: 1,
        frameCaptureCount: 1,
      });

      const runtimeStatus = await pool.query<{
        final_status: string;
        runtime_report_id: string;
      }>(
        `
        select
          patch.metadata->>'finalStatus' as final_status,
          runtime.artifact_id as runtime_report_id
        from itotori_artifacts patch
        join itotori_artifacts runtime on runtime.project_id = patch.project_id
        where patch.artifact_kind = 'patch_result'
          and runtime.artifact_kind = 'runtime_report'
          and patch.project_id = $1
      `,
        ["legacy-project"],
      );
      expect(runtimeStatus.rows[0]).toEqual({
        final_status: "hello_world_passed",
        runtime_report_id: "legacy-runtime",
      });

      const eventsResult = await pool.query<{ event_kind: string }>(
        "select event_kind from itotori_events where project_id = $1 order by event_kind",
        ["legacy-project"],
      );
      expect(eventsResult.rows.map((row) => row.event_kind)).toEqual([
        "patch_result_recorded",
        "runtime_report_migrated",
      ]);

      const legacyTable = await pool.query<{ table_name: string | null }>(
        "select to_regclass('itotori_legacy_projects')::text as table_name",
      );
      expect(legacyTable.rows[0]?.table_name).toBe("itotori_legacy_projects");
    } finally {
      await pool.end();
      await admin.query(`drop schema ${quoteIdentifier(schemaName)} cascade`);
      await admin.end();
    }
  });
});

async function migratedContext() {
  const databaseUrl = requiredDatabaseUrl();
  await migrate(databaseUrl);
  return createDatabaseContext(databaseUrl);
}

function requiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for DB-backed repository tests");
  }
  return process.env.DATABASE_URL;
}

function migrationSql(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "migrations", file), "utf8");
}

async function seedLegacyHelloWorldState(pool: pg.Pool): Promise<void> {
  await pool.query(`
    insert into itotori_projects (
      project_id,
      bridge_id,
      source_locale,
      target_locale,
      locale_branch_id,
      status
    )
    values (
      'legacy-project',
      'legacy-bridge',
      'ja-JP',
      'en-US',
      'legacy-locale-en-us',
      'hello_world_passed'
    )
  `);
  await pool.query(`
    insert into itotori_bridge_units (
      bridge_unit_id,
      project_id,
      source_unit_key,
      source_text,
      target_text,
      text_surface,
      protected_span_count
    )
    values (
      'legacy-unit',
      'legacy-project',
      'hello.scene.001.line.001',
      'こんにちは、{player}。',
      'Hello, {player}.',
      'dialogue',
      1
    )
  `);
  await pool.query(`
    insert into itotori_patch_exports (
      patch_export_id,
      project_id,
      target_locale,
      entry_count
    )
    values ('legacy-patch', 'legacy-project', 'en-US', 1)
  `);
  await pool.query(`
    insert into itotori_runtime_reports (
      runtime_report_id,
      project_id,
      status,
      fidelity_tier,
      text_event_count,
      frame_capture_count
    )
    values ('legacy-runtime', 'legacy-project', 'passed', 'layout_probe', 1, 1)
  `);
  await pool.query(`
    insert into itotori_hello_world_runs (
      run_id,
      project_id,
      patch_result_id,
      final_status
    )
    values ('legacy-run', 'legacy-project', 'legacy-patch-result', 'hello_world_passed')
  `);
}

function databaseUrlWithSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
