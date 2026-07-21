-- mp-01: a project is bound to the engine adapter and its source/build layout.
-- Existing rows predate engine bindings and remain nullable until a project is
-- re-imported; all repository create/import writers supply every field.

alter table itotori_projects
  add column engine_family text,
  add column source_root text,
  add column build_root text,
  add column extract_profile jsonb;
