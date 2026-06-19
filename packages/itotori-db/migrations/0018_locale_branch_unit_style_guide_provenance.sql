alter table itotori_locale_branch_units
  add column if not exists style_guide_version_id text
    references itotori_style_guide_versions(style_guide_version_id) on delete set null;

create index if not exists itotori_locale_branch_units_style_guide_version_idx
  on itotori_locale_branch_units(style_guide_version_id);
