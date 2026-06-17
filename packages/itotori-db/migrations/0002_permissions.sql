create table if not exists itotori_users (
  user_id text primary key,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists itotori_user_permission_grants (
  user_id text not null references itotori_users(user_id) on delete cascade,
  permission text not null check (
    permission in (
      'project.import',
      'draft.write',
      'patch.export',
      'runtime.ingest',
      'system.reset'
    )
  ),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);
