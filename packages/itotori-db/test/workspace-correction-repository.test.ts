// ITOTORI-118 — workspace correction edit-history repository tests.
//
// Each test stands up an isolated migrated schema, seeds the project / locale
// branch / source revision / feedback report the edit links to, and exercises a
// distinct invariant: durable persistence with the full identity, the matching
// durable `itotori_events` row, idempotent replay, branch-scoped read-back, and
// the `queue.manage` permission gate on the mutation.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriWorkspaceCorrectionRepository,
  WorkspaceCorrectionRepositoryError,
  workspaceCorrectionDispositionValues,
  workspaceCorrectionEventKind,
} from "../src/repositories/workspace-correction-repository.js";
import { feedbackTriageLabelValues } from "../src/repositories/feedback-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };

const projectId = "project-it118";
const localeBranchId = "locale-branch-it118";
const otherLocaleBranchId = "locale-branch-it118-fr";
const sourceRevisionId = "source-revision-it118";
const feedbackReportId = "feedback-report-it118";
const otherFeedbackReportId = "feedback-report-it118-2";

async function seedScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-it118', 'Workspace IT118')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    )
    values (${projectId}, 'workspace-it118', 'it118', 'IT118 Project', 'ja-JP', 'imported')
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'it118-v1')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-it118', ${projectId}, ${sourceRevisionId}, 'bridge-it118',
      '0.2.0', 'hash:it118', 'ja-JP', 'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  for (const branchId of [localeBranchId, otherLocaleBranchId]) {
    await context.db.execute(sql`
      insert into itotori_locale_branches (
        locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
      )
      values (
        ${branchId}, ${projectId}, 'source-bundle-it118', 'en-US', ${branchId}, 'active'
      )
      on conflict (locale_branch_id) do nothing
    `);
  }
  await context.db.execute(sql`
    insert into itotori_feedback_sources (
      feedback_source_id, project_id, source_kind, label, privacy_review_state, metadata
    )
    values ('feedback-source-it118', ${projectId}, 'manual_review', 'IT118', 'reviewed', '{}'::jsonb)
    on conflict (feedback_source_id) do nothing
  `);
  for (const reportId of [feedbackReportId, otherFeedbackReportId]) {
    await context.db.execute(sql`
      insert into itotori_feedback_reports (
        feedback_report_id, project_id, locale_branch_id, source_bundle_id, target_locale,
        feedback_source_id, feedback_type, triage_label, report_status, context_status,
        privacy_classification, redaction_state, reporter_role, reporter_note, dedupe_key,
        attachment_summary, metadata, first_reported_at, last_reported_at
      )
      values (
        ${reportId}, ${projectId}, ${localeBranchId}, 'source-bundle-it118', 'en-US',
        'feedback-source-it118', 'objective_defect', 'objective_defect_candidate', 'open',
        'contextualized', 'internal', 'raw', 'reviewer', 'note', ${`dedupe-${reportId}`},
        '{}'::jsonb, '{}'::jsonb, now(), now()
      )
      on conflict (feedback_report_id) do nothing
    `);
  }
}

function baseInput() {
  return {
    projectId,
    localeBranchId,
    sourceRevisionId,
    bridgeUnitId: "bridge-unit-a",
    actorUserId: localUserId,
    reason: "Typo: teh -> the",
    beforeText: "Teh hero speaks.",
    afterText: "The hero speaks.",
    disposition: workspaceCorrectionDispositionValues.repairCandidate,
    triageLabel: feedbackTriageLabelValues.objectiveDefectCandidate,
    feedbackReportId,
    feedbackEvidenceId: "feedback-evidence-it118",
    batchId: "workspace-correction-batch-it118",
  } as const;
}

describe.skipIf(!process.env.DATABASE_URL)("ItotoriWorkspaceCorrectionRepository", () => {
  it("records a durable edit tied to project/branch/revision/unit/actor/reason + a durable event", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriWorkspaceCorrectionRepository(context.db);
      const record = await repo.recordCorrectionEdit(localActor, baseInput());

      expect(record.correctionEditId).toMatch(/^workspace-correction-/);
      expect(record.projectId).toBe(projectId);
      expect(record.localeBranchId).toBe(localeBranchId);
      expect(record.sourceRevisionId).toBe(sourceRevisionId);
      expect(record.bridgeUnitId).toBe("bridge-unit-a");
      expect(record.actorUserId).toBe(localUserId);
      expect(record.reason).toBe("Typo: teh -> the");
      expect(record.beforeText).toBe("Teh hero speaks.");
      expect(record.afterText).toBe("The hero speaks.");
      expect(record.feedbackReportId).toBe(feedbackReportId);
      expect(record.duplicate).toBe(false);

      // The durable row exists in the edit-history table.
      const rows = await context.db.execute(sql`
        select project_id, locale_branch_id, source_revision_id, bridge_unit_id,
               actor_user_id, reason, after_text, feedback_report_id
        from itotori_workspace_correction_edits
        where correction_edit_id = ${record.correctionEditId}
      `);
      expect(rows.rows).toHaveLength(1);

      // A matching durable event was appended to the canonical event log.
      const events = await context.db.execute(sql`
        select event_kind, project_id, locale_branch_id, subject_refs, payload
        from itotori_events
        where event_id = ${`${record.correctionEditId}:${workspaceCorrectionEventKind}`}
      `);
      expect(events.rows).toHaveLength(1);
      const event = events.rows[0] as {
        event_kind: string;
        project_id: string;
        locale_branch_id: string;
        subject_refs: Array<{ subjectKind: string; subjectId: string }>;
        payload: { reason: string; bridgeUnitId: string };
      };
      expect(event.event_kind).toBe(workspaceCorrectionEventKind);
      expect(event.project_id).toBe(projectId);
      expect(event.locale_branch_id).toBe(localeBranchId);
      expect(event.payload.reason).toBe("Typo: teh -> the");
      const subjectKinds = event.subject_refs.map((ref) => ref.subjectKind);
      expect(subjectKinds).toContain("bridge_unit");
      expect(subjectKinds).toContain("source_revision");
      expect(subjectKinds).toContain("locale_branch");
    } finally {
      await context.close();
    }
  });

  it("is idempotent: replaying the same correction collapses onto one row + one event", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriWorkspaceCorrectionRepository(context.db);
      const first = await repo.recordCorrectionEdit(localActor, baseInput());
      const second = await repo.recordCorrectionEdit(localActor, baseInput());

      expect(second.correctionEditId).toBe(first.correctionEditId);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);

      const rows = await context.db.execute(sql`
        select count(*)::int as n from itotori_workspace_correction_edits
      `);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);
      const events = await context.db.execute(sql`
        select count(*)::int as n from itotori_events where event_kind = ${workspaceCorrectionEventKind}
      `);
      expect(Number((events.rows[0] as { n: number }).n)).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("loadCorrectionEditsByBranch returns only that branch's edits (no conflation)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriWorkspaceCorrectionRepository(context.db);
      await repo.recordCorrectionEdit(localActor, baseInput());
      await repo.recordCorrectionEdit(localActor, {
        ...baseInput(),
        localeBranchId: otherLocaleBranchId,
        afterText: "Le héros parle.",
        feedbackReportId: otherFeedbackReportId,
        feedbackEvidenceId: "feedback-evidence-it118-2",
      });

      const here = await repo.loadCorrectionEditsByBranch(localActor, localeBranchId);
      const other = await repo.loadCorrectionEditsByBranch(localActor, otherLocaleBranchId);
      expect(here).toHaveLength(1);
      expect(other).toHaveLength(1);
      expect(here[0]?.localeBranchId).toBe(localeBranchId);
      expect(other[0]?.localeBranchId).toBe(otherLocaleBranchId);
    } finally {
      await context.close();
    }
  });

  it("refuses the mutation without queue.manage", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriWorkspaceCorrectionRepository(context.db);
      await expect(repo.recordCorrectionEdit(deniedActor, baseInput())).rejects.toMatchObject({
        name: "AuthorizationError",
      });
      const rows = await context.db.execute(sql`
        select count(*)::int as n from itotori_workspace_correction_edits
      `);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("rejects an empty reason before touching the database", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const repo = new ItotoriWorkspaceCorrectionRepository(context.db);
      await expect(
        repo.recordCorrectionEdit(localActor, { ...baseInput(), reason: "   " }),
      ).rejects.toBeInstanceOf(WorkspaceCorrectionRepositoryError);
    } finally {
      await context.close();
    }
  });
});
