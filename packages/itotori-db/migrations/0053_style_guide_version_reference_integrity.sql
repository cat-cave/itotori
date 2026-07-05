-- ITOTORI-122: enforce consistency of the style-guide version reference graph
-- (latest / approved / previous pointers, scoped by project + locale-branch).
--
-- The finding
-- -----------
-- Style-guide rows carry three version POINTERS that were plain `text` columns
-- with NO database-level integrity:
--
--     itotori_style_guides.latest_version_id     -> a style_guide_versions row
--     itotori_style_guides.approved_version_id   -> a style_guide_versions row
--     itotori_style_guide_versions.previous_version_id -> a (prior) version row
--
-- Because these were unconstrained `text`, the DB accepted:
--   (a) DANGLING pointers  — a latest/approved/previous id that names no
--       existing style_guide_versions row; and
--   (b) CROSS-SCOPE pointers — a pointer that resolves to a version belonging
--       to a DIFFERENT project or a DIFFERENT locale-branch than the referrer.
-- Both can silently corrupt the version graph (e.g. `getLatestVersion()` /
-- `getApprovedVersion()` resolving a foreign or non-existent version).
--
-- Additionally, each `style_guide_versions` row independently stores
-- `style_guide_id` + `project_id` + `locale_branch_id`, but nothing tied those
-- three together to the parent style guide's own (project, locale-branch), so a
-- version could claim a project/locale-branch inconsistent with its guide.
--
-- The fix: COMPOSITE foreign keys. Each pointer is validated not just for
-- existence but against the referrer's own (style_guide_id, project_id,
-- locale_branch_id) tuple, so a referenced version is GUARANTEED to be a real
-- row in the SAME style guide + SAME project + SAME locale-branch. This rejects
-- both dangling and cross-scope references at the DB layer, for every code path
-- and every raw SQL statement.
--
-- Why composite FK (not CHECK / trigger)
-- --------------------------------------
-- A CHECK constraint cannot reference other rows/tables, and a plain
-- single-column FK proves existence but NOT same-scope. A composite FK does
-- both atomically: it matches the pointer id AND the scope columns against a
-- unique key on the target, so "exists" and "same project + same locale-branch"
-- are one enforced relationship — no trigger required.
--
-- Nullability: `latest_version_id`, `approved_version_id` and
-- `previous_version_id` remain NULLABLE (a fresh guide / first version has no
-- pointer). Postgres MATCH SIMPLE (the default) skips the whole composite FK
-- when the pointer column is NULL, while the scope columns (all NOT NULL) never
-- suppress a check — so a set pointer is always fully validated and an unset
-- pointer is correctly allowed.
--
-- Insert ordering / circular refs: the write path inserts the guide (pointers
-- NULL), inserts the version (its guide already exists), then updates the guide
-- pointers to the now-existing version. That satisfies the guide<->version
-- cycle under immediate checks; no DEFERRABLE needed.
--
-- Forward-only. Synthetic/test schemas are empty, so it applies clean; on a
-- populated DB the write path already maintains these invariants (previous =
-- prior latest of the same guide; latest/approved set to a just-inserted
-- same-scope version), so no pre-existing row violates the new constraints.
--
-- @permission-gate draft.write writes (createVersion / approveVersion drive
--   the constrained pointers)
-- @permission-gate draft.read reads

-- 1. Unique key on the version table's (id, scope) tuple. `style_guide_version_id`
--    is already the PK (hence unique), so this is trivially unique; it exists to
--    serve as the TARGET of the composite pointer FKs below.
alter table itotori_style_guide_versions
  add constraint itotori_style_guide_versions_scope_key
  unique (style_guide_version_id, style_guide_id, project_id, locale_branch_id);

-- 2. Unique key on the guide's (id, scope) tuple, target of the version->guide
--    scope FK. `style_guide_id` is the PK, so this is trivially unique.
alter table itotori_style_guides
  add constraint itotori_style_guides_scope_key
  unique (style_guide_id, project_id, locale_branch_id);

-- 3. A version's (project, locale-branch) MUST match its parent style guide's.
--    Composite FK on top of the existing single-column style_guide_id FK: ties
--    the version's scope to the guide it belongs to (rejects a version claiming
--    a project/locale-branch inconsistent with its guide). ON DELETE CASCADE
--    mirrors the existing style_guide_id cascade so guide deletion still removes
--    its versions.
alter table itotori_style_guide_versions
  add constraint itotori_style_guide_versions_guide_scope_fkey
  foreign key (style_guide_id, project_id, locale_branch_id)
  references itotori_style_guides (style_guide_id, project_id, locale_branch_id)
  on delete cascade;

-- 4. latest_version_id must reference an EXISTING version in the SAME guide +
--    project + locale-branch as the style guide row.
alter table itotori_style_guides
  add constraint itotori_style_guides_latest_version_scope_fkey
  foreign key (latest_version_id, style_guide_id, project_id, locale_branch_id)
  references itotori_style_guide_versions
    (style_guide_version_id, style_guide_id, project_id, locale_branch_id);

-- 5. approved_version_id must reference an EXISTING version in the SAME guide +
--    project + locale-branch as the style guide row.
alter table itotori_style_guides
  add constraint itotori_style_guides_approved_version_scope_fkey
  foreign key (approved_version_id, style_guide_id, project_id, locale_branch_id)
  references itotori_style_guide_versions
    (style_guide_version_id, style_guide_id, project_id, locale_branch_id);

-- 6. previous_version_id must reference an EXISTING (prior) version in the SAME
--    guide + project + locale-branch (self-referential composite FK).
alter table itotori_style_guide_versions
  add constraint itotori_style_guide_versions_previous_version_scope_fkey
  foreign key (previous_version_id, style_guide_id, project_id, locale_branch_id)
  references itotori_style_guide_versions
    (style_guide_version_id, style_guide_id, project_id, locale_branch_id);
