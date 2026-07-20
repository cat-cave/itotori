-- RB-074: the rebuilt workflow persists content-addressed LLM facts, not a
-- resumable localization journal. Patch deliveries and play feedback remain
-- durable, but are reparented before the retired state-machine tables vanish.
--
-- This migration deliberately uses additive columns, backfills, NOT VALID
-- constraints, and IF EXISTS drops. It must upgrade populated deployments;
-- no historical row is rejected merely because it predates the new boundary.

create table if not exists itotori_patch_output_revisions (
  output_revision_id text primary key,
  bridge_unit_id text not null,
  target_body text not null,
  origin text not null,
  parent_output_revision_id text,
  actor_user_id text,
  created_for_patch_version_id text,
  created_at timestamptz not null default now()
);

create index if not exists itotori_patch_output_revisions_bridge_unit_idx
  on itotori_patch_output_revisions (bridge_unit_id);
create index if not exists itotori_patch_output_revisions_parent_idx
  on itotori_patch_output_revisions (parent_output_revision_id);

-- Retire the journal-era playable guards before reparenting seeded playable
-- patches. Content-addressed output revisions now provide the immutable facts.
drop trigger if exists itotori_localization_patch_member_provenance_guard
  on itotori_localization_patch_version_units;
drop trigger if exists itotori_localization_patch_origin_matches_run_guard
  on itotori_localization_patch_versions;
drop trigger if exists itotori_localization_patch_version_playable_guard
  on itotori_localization_patch_versions;
drop trigger if exists itotori_playable_patch_manifest_immutable
  on itotori_localization_patch_versions;
drop trigger if exists itotori_playable_patch_membership_immutable
  on itotori_localization_patch_version_units;

alter table itotori_localization_patch_versions
  add column if not exists project_id text,
  add column if not exists locale_branch_id text,
  add column if not exists source_revision_id text,
  add column if not exists delivery_scope_id text;

update itotori_localization_patch_versions patch
set
  project_id = coalesce(patch.project_id, legacy_run.project_id),
  locale_branch_id = coalesce(patch.locale_branch_id, legacy_run.locale_branch_id),
  source_revision_id = coalesce(patch.source_revision_id, legacy_run.source_revision_id),
  delivery_scope_id = coalesce(patch.delivery_scope_id, patch.run_id)
from itotori_localization_journal_runs legacy_run
where legacy_run.run_id = patch.run_id;

alter table itotori_localization_patch_version_units
  add column if not exists output_revision_id text;

insert into itotori_patch_output_revisions (
  output_revision_id,
  bridge_unit_id,
  target_body,
  origin,
  parent_output_revision_id,
  actor_user_id,
  created_for_patch_version_id,
  created_at
)
select
  legacy_revision.result_revision_id,
  legacy_revision.bridge_unit_id,
  legacy_revision.target_body,
  legacy_revision.origin,
  legacy_revision.parent_revision_id,
  legacy_revision.actor_user_id,
  legacy_revision.created_for_patch_version_id,
  legacy_revision.created_at
from itotori_localization_result_revisions legacy_revision
on conflict (output_revision_id) do nothing;

update itotori_localization_patch_version_units member
set output_revision_id = coalesce(member.output_revision_id, member.result_revision_id);

alter table itotori_play_test_feedback_events
  add column if not exists output_revision_id text,
  add column if not exists subject_ref text;

update itotori_play_test_feedback_events feedback
set
  output_revision_id = coalesce(feedback.output_revision_id, feedback.result_revision_id),
  subject_ref = coalesce(
    feedback.subject_ref,
    case
      when feedback.context_entry_version_id is not null
        then 'legacy-context-entry:' || feedback.context_entry_version_id
      when feedback.context_artifact_id is not null
        then 'legacy-context-artifact:' || feedback.context_artifact_id
      else null
    end
  );

alter table itotori_localization_patch_version_units
  drop constraint if exists itotori_localization_patch_version_units_patch_run_fkey,
  drop constraint if exists itotori_localization_patch_version_units_planned_unit_fkey,
  drop constraint if exists itotori_localization_patch_version_units_source_outcome_fkey,
  drop constraint if exists itotori_localization_patch_version_units_source_result_revision_fkey;

alter table itotori_localization_patch_version_units
  drop column if exists run_id cascade,
  drop column if exists source_run_id cascade,
  drop column if exists journal_outcome_id cascade,
  drop column if exists result_revision_id cascade;

alter table itotori_localization_patch_versions
  drop constraint if exists itotori_localization_patch_versions_id_run_unique,
  drop column if exists run_id cascade;

alter table itotori_play_test_feedback_events
  drop constraint if exists itotori_play_test_feedback_events_result_edit_revision,
  drop constraint if exists itotori_play_test_feedback_events_context_version_pair,
  drop constraint if exists itotori_play_test_feedback_events_canonical_outcome,
  drop column if exists play_session_id cascade,
  drop column if exists result_revision_id cascade,
  drop column if exists context_artifact_id cascade,
  drop column if exists context_entry_version_id cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_versions_project_fkey'
      and conrelid = 'itotori_localization_patch_versions'::regclass
  ) then
    alter table itotori_localization_patch_versions
      add constraint itotori_patch_versions_project_fkey
      foreign key (project_id) references itotori_projects(project_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_versions_branch_fkey'
      and conrelid = 'itotori_localization_patch_versions'::regclass
  ) then
    alter table itotori_localization_patch_versions
      add constraint itotori_patch_versions_branch_fkey
      foreign key (locale_branch_id) references itotori_locale_branches(locale_branch_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_versions_source_revision_fkey'
      and conrelid = 'itotori_localization_patch_versions'::regclass
  ) then
    alter table itotori_localization_patch_versions
      add constraint itotori_patch_versions_source_revision_fkey
      foreign key (source_revision_id) references itotori_source_revisions(source_revision_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_units_output_revision_fkey'
      and conrelid = 'itotori_localization_patch_version_units'::regclass
  ) then
    alter table itotori_localization_patch_version_units
      add constraint itotori_patch_units_output_revision_fkey
      foreign key (output_revision_id)
      references itotori_patch_output_revisions(output_revision_id) on delete restrict not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_units_patch_fkey'
      and conrelid = 'itotori_localization_patch_version_units'::regclass
  ) then
    alter table itotori_localization_patch_version_units
      add constraint itotori_patch_units_patch_fkey
      foreign key (patch_version_id)
      references itotori_localization_patch_versions(patch_version_id) on delete cascade not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_play_feedback_output_revision_fkey'
      and conrelid = 'itotori_play_test_feedback_events'::regclass
  ) then
    alter table itotori_play_test_feedback_events
      add constraint itotori_play_feedback_output_revision_fkey
      foreign key (output_revision_id)
      references itotori_patch_output_revisions(output_revision_id) on delete restrict not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_versions_scope_complete'
      and conrelid = 'itotori_localization_patch_versions'::regclass
  ) then
    alter table itotori_localization_patch_versions
      add constraint itotori_patch_versions_scope_complete
      check (
        project_id is not null
        and locale_branch_id is not null
        and source_revision_id is not null
        and delivery_scope_id is not null
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_patch_units_output_revision_present'
      and conrelid = 'itotori_localization_patch_version_units'::regclass
  ) then
    alter table itotori_localization_patch_version_units
      add constraint itotori_patch_units_output_revision_present
      check (output_revision_id is not null) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_play_test_feedback_events_result_edit_output_revision'
      and conrelid = 'itotori_play_test_feedback_events'::regclass
  ) then
    alter table itotori_play_test_feedback_events
      add constraint itotori_play_test_feedback_events_result_edit_output_revision
      check (event_kind <> 'result_edit' or output_revision_id is not null) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'itotori_play_test_feedback_events_subject_binding'
      and conrelid = 'itotori_play_test_feedback_events'::regclass
  ) then
    alter table itotori_play_test_feedback_events
      add constraint itotori_play_test_feedback_events_subject_binding
      check (
        (event_kind = 'result_edit' and output_revision_id is not null and subject_ref is null)
        or (
          event_kind in ('comment', 'added_context', 'wiki_edit')
          and output_revision_id is null
          and subject_ref is not null
        )
      ) not valid;
  end if;
end;
$$;

create index if not exists itotori_localization_patch_versions_scope_status_idx
  on itotori_localization_patch_versions (delivery_scope_id, status);
create index if not exists itotori_localization_patch_versions_branch_created_idx
  on itotori_localization_patch_versions (locale_branch_id, created_at);
create index if not exists itotori_localization_patch_version_units_output_idx
  on itotori_localization_patch_version_units (output_revision_id);

-- These tables are children of the journal/context graph. They contain no
-- independently addressable selected patch or feedback fact, so removal does
-- not discard the delivery and feedback rows reparented above.
drop table if exists itotori_play_session_qa_callouts;
drop table if exists itotori_play_sessions;
drop table if exists itotori_localization_refinement_run_feedback_events;
drop table if exists itotori_localization_refinement_run_feedback_batches;
drop table if exists itotori_localization_refinement_run_wiki_heads;
drop table if exists itotori_localization_refinement_run_members;
drop table if exists itotori_localization_run_finalizer_outbox;
drop table if exists itotori_localization_run_terminal_summaries;

drop table if exists itotori_localization_result_revisions cascade;
drop table if exists itotori_written_qa_findings cascade;
drop table if exists itotori_outcome_context_refs cascade;
drop table if exists itotori_outcome_speaker_labels cascade;
drop table if exists itotori_translation_candidates cascade;
drop table if exists itotori_written_unit_outcomes cascade;
drop table if exists itotori_localization_cost_reservations cascade;
drop table if exists itotori_localization_run_cost_accounts cascade;
drop table if exists itotori_llm_attempts cascade;
drop table if exists itotori_localization_journal_run_units cascade;
drop table if exists itotori_localization_journal_runs cascade;

drop table if exists itotori_context_artifact_source_units cascade;
drop table if exists itotori_context_entry_versions cascade;
drop table if exists itotori_context_artifacts cascade;

drop function if exists itotori_assert_localization_patch_member_provenance() cascade;
drop function if exists itotori_assert_localization_patch_origin_matches_run() cascade;
drop function if exists itotori_assert_localization_patch_version_playable() cascade;
drop function if exists itotori_assert_refinement_run_mapping_base() cascade;
drop function if exists itotori_freeze_localization_result_revision() cascade;
drop function if exists itotori_freeze_selected_translation_candidate() cascade;
drop function if exists itotori_freeze_playable_patch_stage_evidence() cascade;
drop function if exists itotori_freeze_playable_patch_membership() cascade;
drop function if exists itotori_freeze_playable_patch_manifest() cascade;
drop function if exists itotori_context_entry_versions_append_only() cascade;
drop function if exists itotori_context_artifacts_prepare_version_prune() cascade;
