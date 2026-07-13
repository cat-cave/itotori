-- Feedback now creates a canonical context correction immediately. Reports
-- that were intentionally parked without a branch/unit target cannot be
-- replayed safely, so retire them instead of preserving a hidden deferral
-- workflow. Evidence rows cascade with their owning report.

delete from itotori_feedback_reports
where locale_branch_id is null
   or btrim(locale_branch_id) = ''
   or bridge_unit_id is null
   or btrim(bridge_unit_id) = ''
   or context_status <> 'contextualized'
   or report_status <> 'open'
   or triage_label not in (
     'objective_defect_candidate',
     'style_dispute_candidate',
     'glossary_canon_candidate',
     'runtime_issue_candidate',
     'asset_issue_candidate',
     'context_correction_candidate'
   );

-- Sources with no remaining report have no durable product consumer.
delete from itotori_feedback_sources source
where not exists (
  select 1
  from itotori_feedback_reports report
  where report.feedback_source_id = source.feedback_source_id
);

-- Match the application schema: a surviving report cannot later be made
-- targetless by deleting its branch or bridge unit.
alter table itotori_feedback_reports
  drop constraint if exists itotori_feedback_reports_locale_branch_id_fkey,
  drop constraint if exists itotori_feedback_reports_bridge_unit_id_fkey;

alter table itotori_feedback_reports
  alter column locale_branch_id set not null,
  alter column bridge_unit_id set not null;

alter table itotori_feedback_reports
  add constraint itotori_feedback_reports_locale_branch_id_fkey
    foreign key (locale_branch_id)
    references itotori_locale_branches(locale_branch_id)
    on delete restrict,
  add constraint itotori_feedback_reports_bridge_unit_id_fkey
    foreign key (bridge_unit_id)
    references itotori_source_units(bridge_unit_id)
    on delete restrict;

alter table itotori_feedback_reports
  drop constraint if exists itotori_feedback_reports_direct_context_target_check;

alter table itotori_feedback_reports
  add constraint itotori_feedback_reports_direct_context_target_check check (
    locale_branch_id is not null
    and btrim(locale_branch_id) <> ''
    and bridge_unit_id is not null
    and btrim(bridge_unit_id) <> ''
    and context_status = 'contextualized'
    and report_status = 'open'
    and triage_label in (
      'objective_defect_candidate',
      'style_dispute_candidate',
      'glossary_canon_candidate',
      'runtime_issue_candidate',
      'asset_issue_candidate',
      'context_correction_candidate'
    )
  );
