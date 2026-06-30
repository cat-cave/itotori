// ITOTORI-118 — workspace correction edit-history migration drift guard.
//
// Pins the load-bearing SQL invariants on `itotori_workspace_correction_edits`
// directly so a future migration that loosens them fails this test:
//   - `reason` and `after_text` must be non-empty (check constraints),
//   - `disposition` is a closed enum,
//   - the row references a real feedback report (FK), and
//   - deleting the locale branch cascades the edit history (branch-scoped).

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "./db-test-context.js";

function pgErrorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

const projectId = "project-drift-it118";
const localeBranchId = "locale-branch-drift-it118";
const sourceRevisionId = "source-revision-drift-it118";
const feedbackReportId = "feedback-report-drift-it118";

async function seedScope(context: Awaited<ReturnType<typeof isolatedMigratedContext>>) {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-drift-it118', 'Drift workspace')
    on conflict (workspace_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_projects (project_id, workspace_id, project_key, name, source_locale, status)
    values (${projectId}, 'workspace-drift-it118', 'drift-it118', 'Drift', 'ja-JP', 'imported')
    on conflict (project_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${sourceRevisionId}, ${projectId}, 'bridge_revision', 'drift-v1')
    on conflict (source_revision_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    )
    values (
      'source-bundle-drift-it118', ${projectId}, ${sourceRevisionId}, 'bridge-drift-it118',
      '0.2.0', 'hash:drift', 'ja-JP', 'fixture-extractor', '1.0.0', 0, 0
    )
    on conflict (source_bundle_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    )
    values (
      ${localeBranchId}, ${projectId}, 'source-bundle-drift-it118', 'en-US', 'English', 'active'
    )
    on conflict (locale_branch_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_feedback_sources (feedback_source_id, project_id, source_kind, label, privacy_review_state, metadata)
    values ('feedback-source-drift-it118', ${projectId}, 'manual_review', 'Drift', 'reviewed', '{}'::jsonb)
    on conflict (feedback_source_id) do nothing
  `);
  await context.db.execute(sql`
    insert into itotori_feedback_reports (
      feedback_report_id, project_id, locale_branch_id, source_bundle_id, target_locale,
      feedback_source_id, feedback_type, triage_label, report_status, context_status,
      privacy_classification, redaction_state, reporter_role, reporter_note, dedupe_key,
      attachment_summary, metadata, first_reported_at, last_reported_at
    )
    values (
      ${feedbackReportId}, ${projectId}, ${localeBranchId}, 'source-bundle-drift-it118', 'en-US',
      'feedback-source-drift-it118', 'objective_defect', 'objective_defect_candidate', 'open',
      'contextualized', 'internal', 'raw', 'reviewer', 'note', 'dedupe-drift-it118',
      '{}'::jsonb, '{}'::jsonb, now(), now()
    )
    on conflict (feedback_report_id) do nothing
  `);
}

async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected the insert to be rejected").toBeDefined();
  expect(pgErrorCodeOf(thrown)).toBe(code);
}

async function insertEdit(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  overrides: {
    correctionEditId?: string;
    reason?: string;
    afterText?: string;
    disposition?: string;
    feedbackReportId?: string;
  } = {},
) {
  await context.db.execute(sql`
    insert into itotori_workspace_correction_edits (
      correction_edit_id, project_id, locale_branch_id, source_revision_id, bridge_unit_id,
      actor_user_id, reason, after_text, disposition, triage_label,
      feedback_report_id, feedback_evidence_id, batch_id
    )
    values (
      ${overrides.correctionEditId ?? "edit-drift-1"}, ${projectId}, ${localeBranchId},
      ${sourceRevisionId}, 'bridge-unit-a', 'local-user',
      ${overrides.reason ?? "valid reason"}, ${overrides.afterText ?? "corrected text"},
      ${overrides.disposition ?? "repair_candidate"}, 'objective_defect_candidate',
      ${overrides.feedbackReportId ?? feedbackReportId}, 'evidence-drift-1', 'batch-drift-1'
    )
  `);
}

describe.skipIf(!process.env.DATABASE_URL)("workspace correction migration drift", () => {
  it("rejects an empty reason", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      await expectPgError(insertEdit(context, { reason: "   " }), "23514");
    } finally {
      await context.close();
    }
  });

  it("rejects empty corrected text", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      await expectPgError(insertEdit(context, { afterText: "" }), "23514");
    } finally {
      await context.close();
    }
  });

  it("rejects an unknown disposition", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      await expectPgError(insertEdit(context, { disposition: "auto_apply" }), "23514");
    } finally {
      await context.close();
    }
  });

  it("rejects an edit referencing a missing feedback report", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      await expectPgError(
        insertEdit(context, { feedbackReportId: "feedback-report-does-not-exist" }),
        "23503",
      );
    } finally {
      await context.close();
    }
  });

  it("cascades edit history when the locale branch is deleted (branch-scoped)", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      await insertEdit(context);
      await context.db.execute(
        sql`delete from itotori_locale_branches where locale_branch_id = ${localeBranchId}`,
      );
      const rows = await context.db.execute(
        sql`select count(*)::int as n from itotori_workspace_correction_edits`,
      );
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
    } finally {
      await context.close();
    }
  });
});
