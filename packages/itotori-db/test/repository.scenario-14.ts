import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { eq, sql } from "drizzle-orm";

import { describe, expect, it } from "vitest";

import { allPermissions, localUserId, permissionValues } from "../src/authorization.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";

import {
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
} from "../src/repositories/feedback-repository.js";
import {
  events,
  feedbackReportEvidence,
  feedbackReports,
  userPermissionGrants,
} from "../src/schema.js";

import { localActor, manualFeedbackFixture, projectFixture } from "./repository.test.shared.js";
import { migratedContext } from "./repository.test.legacy.js";

describe("ItotoriProjectRepository", () => {
  it("labels style preferences separately from objective defect candidates", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const style = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({ reporterNote: "The protagonist should sound harsher here." }),
      );
      const objective = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporterNote: "The line has a typo in the player-facing text.",
          attachments: [
            {
              attachmentKind: "screenshot",
              artifactId: "feedback-screenshot-typo",
              uri: "fixture://feedback/screenshot/typo",
              capturePosition: "hello.scene.001:frame002",
            },
          ],
        }),
      );

      expect(style.triageLabel).toBe(feedbackTriageLabelValues.styleDisputeCandidate);
      expect(objective.triageLabel).toBe(feedbackTriageLabelValues.objectiveDefectCandidate);
    } finally {
      await context.close();
    }
  });
  it("does not aggregate different feedback types with the same explicit dedupe key", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const style = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          dedupeKey: "external-ticket-123",
          reporterNote: "The protagonist should sound less formal here.",
        }),
      );
      const objective = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          dedupeKey: "external-ticket-123",
          feedbackType: feedbackTypeValues.objectiveDefect,
          reporterNote: "The player-facing line contains the wrong term.",
        }),
      );

      expect(style.dedupeKey).not.toBe(objective.dedupeKey);
      expect(objective).toMatchObject({
        duplicate: false,
        reportCount: 1,
        triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
      });

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.projectId, "project-test"));
      expect(reports).toHaveLength(2);
      expect(new Set(reports.map((report) => report.feedbackType))).toEqual(
        new Set([feedbackTypeValues.stylePreference, feedbackTypeValues.objectiveDefect]),
      );

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, objective.feedbackReportId))
        .limit(1);
      expect(evidence[0]?.metadata).toMatchObject({
        importedFeedbackType: feedbackTypeValues.objectiveDefect,
      });
    } finally {
      await context.close();
    }
  });
  it("aggregates duplicate manual feedback evidence under one canonical report", async () => {
    const context = await migratedContext();
    try {
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);
      const feedbackRepo = new ItotoriFeedbackRepository(context.db);
      await repo.reset(localActor);
      await repo.importSourceBundle(localActor, projectFixture());

      const first = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({ feedbackReportId: "feedback-formal-tone" }),
      );
      const second = await feedbackRepo.importManualFeedback(
        localActor,
        manualFeedbackFixture({
          feedbackReportId: "feedback-formal-tone-copy",
          feedbackEvidenceId: "feedback-formal-tone-evidence-2",
          reporter: { role: "playtester", displayName: "Second fixture reviewer" },
          attachments: [
            {
              attachmentKind: "screenshot",
              artifactId: "feedback-screenshot-duplicate",
              uri: "fixture://feedback/screenshot/formal-tone-2",
              hash: "sha256:feedback-screenshot-duplicate",
              caption: "same formal tone issue from another frame",
              capturePosition: "hello.scene.001:frame003",
            },
          ],
          reportedAt: "2026-06-17T00:05:00.000Z",
        }),
      );

      expect(second).toMatchObject({
        duplicate: true,
        feedbackReportId: first.feedbackReportId,
        reportCount: 2,
      });

      const reports = await context.db
        .select()
        .from(feedbackReports)
        .where(eq(feedbackReports.dedupeKey, first.dedupeKey));
      expect(reports).toHaveLength(1);
      expect(reports[0]?.reportCount).toBe(2);

      const evidence = await context.db
        .select()
        .from(feedbackReportEvidence)
        .where(eq(feedbackReportEvidence.feedbackReportId, first.feedbackReportId));
      expect(evidence).toHaveLength(2);

      const duplicateEvent = await context.db
        .select()
        .from(events)
        .where(eq(events.eventKind, "feedback_report_duplicate_aggregated"))
        .limit(1);
      expect(duplicateEvent[0]?.payload).toMatchObject({
        duplicate: true,
        reportCount: 2,
      });
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
      const repo = new ItotoriProjectRepository(context.db, testProjectEngineFamilyRegistry);

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
});
