-- play-mark-validated — per-scene localization coverage state.
--
-- The Play surface tracks whether each scene has been human-checked for
-- localization quality. Coverage is a closed three-state vocabulary:
--   needs_check | flagged | validated
-- and is scoped to (project, locale branch, scene). The Play RouteMap paints
-- each node with this state; "Mark validated" (and flag / reset to needs_check)
-- write through this table.
--
-- Why a dedicated table (not routeEvidence):
--   `itotori_route_evidence` is a citation link (route/choice → bridge unit +
--   source hash). Coverage is a human workflow state, not evidence of a unit
--   citation. Reusing routeEvidence would overload the wrong domain.
--
-- Design:
--   - PRIMARY KEY (`coverage_id`) — opaque durable id.
--   - UNIQUE (project_id, locale_branch_id, scene_id) — one current state per
--     scene on a branch; setCoverage UPSERTs on this key.
--   - coverage_state CHECK — closed vocabulary, refuses free-text states.
--   - updated_by_user_id — who last changed the state (audit-friendly).
--   - scene_id is an opaque game-agnostic key (matches scene-summary sceneId
--     and/or route-map routeKey when those surfaces share identity).

create table if not exists itotori_scene_localization_coverage (
  coverage_id text primary key,
  project_id text not null references itotori_projects(project_id) on delete cascade,
  locale_branch_id text not null references itotori_locale_branches(locale_branch_id) on delete cascade,
  scene_id text not null,
  coverage_state text not null,
  updated_by_user_id text not null,
  updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint itotori_scene_localization_coverage_state_known
    check (coverage_state in ('needs_check', 'flagged', 'validated')),
  constraint itotori_scene_localization_coverage_scene_id_non_empty
    check (length(scene_id) > 0),
  constraint itotori_scene_localization_coverage_updated_by_non_empty
    check (length(updated_by_user_id) > 0)
);

create unique index if not exists itotori_scene_localization_coverage_unique_idx
  on itotori_scene_localization_coverage (project_id, locale_branch_id, scene_id);

create index if not exists itotori_scene_localization_coverage_branch_idx
  on itotori_scene_localization_coverage (project_id, locale_branch_id, coverage_state);
