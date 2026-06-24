-- ITOTORI alpha gate 5: audit findings persistence.
--
-- Until this migration, the only persistent record of an audit finding was
-- the prose paragraph in `docs/audits/*.md`. The dashboard had no way to
-- render audit state because there was no DB shape to query. This
-- migration introduces `itotori_audit_findings`: one row per finding
-- surfaced by an audit report (the markdown doc on disk), keyed by the
-- DAG node the finding is about. The dashboard joins on that node id so a
-- node card can list its open P0/P1/P2/P3 audit findings inline.
--
-- Permission governance: writes (recording new findings, marking fixed,
-- marking superseded) are gated by audit.write; reads are gated by
-- catalog.read so any actor that can read the dashboard read model can
-- see the findings. audit.write is added to the permission constraint in
-- this migration.
--
-- @permission-gate audit.write writes
-- @permission-gate catalog.read reads
--
-- Severity vocabulary mirrors roadmap/audit-report.schema.json:
--   severity = P0 | P1 | P2 | P3
-- Status vocabulary mirrors the audit-report finding-orchestration model:
--   status = open | superseded | fixed | wontfix | duplicate
--
-- Supersede chain: when a follow-up audit re-evaluates a finding and
-- records a successor (e.g. the same gap is still present but the
-- summary is sharper, or the file_ref drifted), the old row is marked
-- superseded with a non-null superseded_by_finding_id. The successor row
-- is open. Closed states (fixed/wontfix/duplicate) carry a non-null
-- resolved_at.

alter table itotori_user_permission_grants
  drop constraint if exists itotori_user_permission_grants_permission_check;

alter table itotori_user_permission_grants
  add constraint itotori_user_permission_grants_permission_check check (
    permission in (
      'project.import',
      'draft.write',
      'patch.export',
      'runtime.ingest',
      'feedback.import',
      'queue.manage',
      'queue.read',
      'catalog.read',
      'catalog.write',
      'audit.write',
      'system.reset'
    )
  );

create table if not exists itotori_audit_findings (
  audit_finding_id text primary key,
  audit_report_id text not null,
  node_id text not null,
  severity text not null check (severity in ('P0', 'P1', 'P2', 'P3')),
  category text not null,
  summary text not null,
  detail text,
  file_ref text,
  proposed_dag_node text,
  status text not null check (
    status in ('open', 'superseded', 'fixed', 'wontfix', 'duplicate')
  ) default 'open',
  superseded_by_finding_id text references itotori_audit_findings(audit_finding_id)
    deferrable initially deferred,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Resolved-state consistency: a closed finding (fixed/wontfix/
  -- duplicate/superseded) must carry resolved_at; an open finding must
  -- not. Superseded findings additionally require superseded_by_finding_id.
  constraint itotori_audit_findings_resolved_state_consistent check (
    (status = 'open' and resolved_at is null and superseded_by_finding_id is null)
    or (status = 'superseded' and resolved_at is not null and superseded_by_finding_id is not null)
    or (
      status in ('fixed', 'wontfix', 'duplicate')
      and resolved_at is not null
      and superseded_by_finding_id is null
    )
  ),
  constraint itotori_audit_findings_summary_non_empty check (length(summary) > 0),
  constraint itotori_audit_findings_node_id_non_empty check (length(node_id) > 0),
  constraint itotori_audit_findings_audit_report_id_non_empty check (length(audit_report_id) > 0),
  constraint itotori_audit_findings_category_non_empty check (length(category) > 0)
);

create index if not exists itotori_audit_findings_node_status_severity_idx
  on itotori_audit_findings (node_id, status, severity);

create index if not exists itotori_audit_findings_report_idx
  on itotori_audit_findings (audit_report_id);

create index if not exists itotori_audit_findings_severity_status_idx
  on itotori_audit_findings (severity, status);
