-- Immutable-artifact DB enforcement closes the gaps that cannot safely rest
-- on an application-side check: retention extension, collision preservation,
-- format negotiation, and append-only audit history.

-- Capture this migration's schema for every function that resolves tables.
-- `pg_temp` must be explicit and last: PostgreSQL otherwise searches a caller's
-- temporary schema before the function's saved path.
select set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);

alter table itotori_immutable_artifacts
  add column if not exists format_version text not null default 'itotori.immutable-artifact.v1';

-- The domain-separated fingerprint distinguishes bytes that share a primary
-- SHA-256 identity. Existing rows predate collision addresses, so their
-- primary identity is retained as a conservative legacy fingerprint.
alter table itotori_immutable_artifacts
  add column if not exists content_fingerprint text;

update itotori_immutable_artifacts
set content_fingerprint = artifact_id
where content_fingerprint is null;

alter table itotori_immutable_artifacts
  alter column content_fingerprint set not null;

alter table itotori_immutable_artifacts
  drop constraint if exists itotori_immutable_artifacts_content_fingerprint_check;

alter table itotori_immutable_artifacts
  add constraint itotori_immutable_artifacts_content_fingerprint_check
  check (content_fingerprint ~ '^sha256:[0-9a-f]{64}$');

-- A fingerprint binds encrypted bytes to either their canonical identity or a
-- collision address. A raw UPDATE must not be able to redefine that binding.
create or replace function itotori_immutable_artifact_content_fingerprint_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_immutable_artifacts content_fingerprint is immutable'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists itotori_immutable_artifact_content_fingerprint_immutable_trigger
  on itotori_immutable_artifacts;

create trigger itotori_immutable_artifact_content_fingerprint_immutable_trigger
before update of content_fingerprint on itotori_immutable_artifacts
for each row execute function itotori_immutable_artifact_content_fingerprint_immutable();

create table if not exists itotori_immutable_artifact_collision_variants (
  claimed_artifact_id text not null
    references itotori_immutable_artifacts(artifact_id) on delete restrict,
  variant_artifact_id text not null
    references itotori_immutable_artifacts(artifact_id) on delete restrict,
  recorded_at timestamptz not null,
  recorded_by text not null,
  primary key (claimed_artifact_id, variant_artifact_id),
  check (claimed_artifact_id <> variant_artifact_id)
);

create index if not exists itotori_immutable_artifact_collision_variants_variant_idx
  on itotori_immutable_artifact_collision_variants (variant_artifact_id);

create unique index if not exists itotori_immutable_artifact_collision_variants_variant_unique_idx
  on itotori_immutable_artifact_collision_variants (variant_artifact_id);

-- A link may name only a row explicitly written as a collision address. This
-- keeps a raw INSERT from reclassifying an ordinary canonical artifact.
create or replace function itotori_immutable_artifact_collision_variant_validate()
returns trigger
language plpgsql
set search_path from current
as $$
declare
  stored_fingerprint text;
begin
  select content_fingerprint into stored_fingerprint
  from itotori_immutable_artifacts
  where artifact_id = new.variant_artifact_id;
  if stored_fingerprint is distinct from new.variant_artifact_id then
    raise exception 'collision variant % has no collision fingerprint', new.variant_artifact_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function itotori_immutable_artifact_collision_variants_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_immutable_artifact_collision_variants is append-only'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists itotori_immutable_artifact_collision_variants_append_only_trigger
  on itotori_immutable_artifact_collision_variants;
drop trigger if exists itotori_immutable_artifact_collision_variants_no_truncate_trigger
  on itotori_immutable_artifact_collision_variants;
drop trigger if exists itotori_immutable_artifact_collision_variants_validate_trigger
  on itotori_immutable_artifact_collision_variants;

create trigger itotori_immutable_artifact_collision_variants_validate_trigger
before insert on itotori_immutable_artifact_collision_variants
for each row execute function itotori_immutable_artifact_collision_variant_validate();

create trigger itotori_immutable_artifact_collision_variants_append_only_trigger
before update or delete on itotori_immutable_artifact_collision_variants
for each row execute function itotori_immutable_artifact_collision_variants_append_only();

create trigger itotori_immutable_artifact_collision_variants_no_truncate_trigger
before truncate on itotori_immutable_artifact_collision_variants
for each statement execute function itotori_immutable_artifact_collision_variants_append_only();

create or replace function itotori_immutable_artifact_audit_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_immutable_artifact_audit_events is append-only: recorded events cannot be rewritten or removed';
  return null;
end;
$$;

drop trigger if exists itotori_immutable_artifact_audit_events_append_only_trigger
  on itotori_immutable_artifact_audit_events;

create trigger itotori_immutable_artifact_audit_events_append_only_trigger
before update or delete on itotori_immutable_artifact_audit_events
for each row execute function itotori_immutable_artifact_audit_events_append_only();

drop trigger if exists itotori_immutable_artifact_audit_events_no_truncate_trigger
  on itotori_immutable_artifact_audit_events;

create trigger itotori_immutable_artifact_audit_events_no_truncate_trigger
before truncate on itotori_immutable_artifact_audit_events
for each statement execute function itotori_immutable_artifact_audit_events_append_only();

-- The base deadline is write-once. Extensions are separate, append-only facts
-- so there is no transaction setting (or other application-provided marker)
-- that can turn a raw UPDATE into an authorized retention change.
create or replace function itotori_immutable_artifact_base_expiry_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_immutable_artifacts expires_at is immutable; record an authorized retention extension instead'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists itotori_immutable_artifact_retention_extension_guard_trigger
  on itotori_immutable_artifacts;

create trigger itotori_immutable_artifact_retention_extension_guard_trigger
before update of expires_at on itotori_immutable_artifacts
for each row execute function itotori_immutable_artifact_base_expiry_immutable();

create table if not exists itotori_immutable_artifact_retention_extensions (
  retention_extension_id bigserial primary key,
  artifact_id text not null
    references itotori_immutable_artifacts(artifact_id) on delete restrict,
  expires_at timestamptz not null,
  authorized_session_id text not null
    references itotori_auth_sessions(session_id) on delete restrict,
  authorized_by text not null
    references itotori_auth_users(user_id) on delete restrict,
  occurred_at timestamptz not null,
  check (expires_at > occurred_at)
);

create index if not exists itotori_immutable_artifact_retention_extensions_expiry_idx
  on itotori_immutable_artifact_retention_extensions (artifact_id, expires_at desc);

create or replace function itotori_immutable_artifact_effective_expiry(p_artifact_id text)
returns timestamptz
language sql
stable
set search_path from current
as $$
  select coalesce(max(extension_row.expires_at), artifact.expires_at)
  from itotori_immutable_artifacts artifact
  left join itotori_immutable_artifact_retention_extensions extension_row
    on extension_row.artifact_id = artifact.artifact_id
  where artifact.artifact_id = p_artifact_id
  group by artifact.expires_at;
$$;

-- A retention extension is authenticated by an active opaque session. Its
-- audit actor is derived from that session, never accepted as a function
-- argument, so an ordinary caller cannot impersonate a privileged user by
-- supplying a different actor id.
create or replace function itotori_immutable_artifact_retention_actor_for_session(
  p_session_id text
)
returns table(actor_id text)
language sql
stable
set search_path from current
as $$
  select actor_user.user_id
  from itotori_auth_sessions session_row
  join itotori_auth_principals principal
    on principal.principal_id = session_row.principal_id
   and principal.disabled_at is null
  join itotori_auth_users actor_user
    on actor_user.principal_id = principal.principal_id
  where session_row.session_id = p_session_id
    and session_row.revoked_at is null
    and session_row.expires_at > now()
    and (
      exists (
        select 1
        from itotori_auth_principal_permission_grants direct_grant
        where direct_grant.principal_id = principal.principal_id
          and direct_grant.permission = 'retention.manage'
      )
      or exists (
        select 1
        from itotori_auth_principal_permission_set_grants set_grant
        join itotori_auth_permission_sets permission_set
          on permission_set.permission_set_id = set_grant.permission_set_id
        join itotori_auth_permission_set_permissions set_permission
          on set_permission.permission_set_id = permission_set.permission_set_id
         and set_permission.permission = 'retention.manage'
        join itotori_auth_accounts account_row
          on account_row.account_id = permission_set.account_id
         and account_row.disabled_at is null
        join itotori_auth_account_memberships membership
          on membership.account_id = permission_set.account_id
         and membership.user_id = actor_user.user_id
        where set_grant.principal_id = principal.principal_id
      )
    );
$$;

create or replace function itotori_immutable_artifact_retention_extension_authorize()
returns trigger
language plpgsql
set search_path from current
as $$
declare
  stored itotori_immutable_artifacts%rowtype;
  resolved_actor_id text;
  previous_expiry timestamptz;
begin
  select * into stored
  from itotori_immutable_artifacts
  where artifact_id = new.artifact_id
  for update;
  if not found or stored.deletion_state <> 'active' then
    raise exception 'artifact % is not available for retention', new.artifact_id using errcode = 'P0002';
  end if;

  select actor_id into resolved_actor_id
  from itotori_immutable_artifact_retention_actor_for_session(new.authorized_session_id);
  if resolved_actor_id is null then
    raise exception 'active session lacks retention.manage' using errcode = '42501';
  end if;

  previous_expiry := itotori_immutable_artifact_effective_expiry(new.artifact_id);
  if new.expires_at <= previous_expiry then
    raise exception 'artifact % retention may only be extended', new.artifact_id using errcode = '22023';
  end if;
  if stored.retention_classification = 'restricted'
    and new.expires_at > stored.created_at + interval '365 days' then
    raise exception 'restricted retention exceeds the 365-day maximum' using errcode = '22023';
  end if;

  new.authorized_by := resolved_actor_id;
  insert into itotori_immutable_artifact_audit_events (
    occurred_at, actor_id, action, target, outcome, artifact_id, details
  ) values (
    new.occurred_at, resolved_actor_id, 'retain', new.artifact_id, 'retained', new.artifact_id,
    jsonb_build_object('expiresAt', new.expires_at, 'previousExpiresAt', previous_expiry)
  );
  return new;
end;
$$;

create or replace function itotori_immutable_artifact_retention_extensions_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'itotori_immutable_artifact_retention_extensions is append-only'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists itotori_immutable_artifact_retention_extensions_authorize_trigger
  on itotori_immutable_artifact_retention_extensions;
drop trigger if exists itotori_immutable_artifact_retention_extensions_append_only_trigger
  on itotori_immutable_artifact_retention_extensions;
drop trigger if exists itotori_immutable_artifact_retention_extensions_no_truncate_trigger
  on itotori_immutable_artifact_retention_extensions;

create trigger itotori_immutable_artifact_retention_extensions_authorize_trigger
before insert on itotori_immutable_artifact_retention_extensions
for each row execute function itotori_immutable_artifact_retention_extension_authorize();

create trigger itotori_immutable_artifact_retention_extensions_append_only_trigger
before update or delete on itotori_immutable_artifact_retention_extensions
for each row execute function itotori_immutable_artifact_retention_extensions_append_only();

create trigger itotori_immutable_artifact_retention_extensions_no_truncate_trigger
before truncate on itotori_immutable_artifact_retention_extensions
for each statement execute function itotori_immutable_artifact_retention_extensions_append_only();

create or replace function itotori_extend_immutable_artifact_retention(
  p_session_id text,
  p_artifact_id text,
  p_until timestamptz,
  p_occurred_at timestamptz
)
returns void
language plpgsql
set search_path from current
as $$
begin
  if p_session_id is null or btrim(p_session_id) = '' then
    raise exception 'retention.manage requires an active session' using errcode = '42501';
  end if;
  if p_artifact_id is null or p_artifact_id !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'retention target is invalid' using errcode = '22023';
  end if;
  if p_until is null or p_occurred_at is null or p_until <= p_occurred_at then
    raise exception 'retention extension deadline must be after its occurrence' using errcode = '22023';
  end if;

  insert into itotori_immutable_artifact_retention_extensions (
    artifact_id, expires_at, authorized_session_id, authorized_by, occurred_at
  ) values (
    p_artifact_id, p_until, p_session_id, null, p_occurred_at
  );
end;
$$;
