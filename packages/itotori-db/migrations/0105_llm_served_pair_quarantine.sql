-- Route evidence is explicit: the served pair is either wholly stream-attested
-- with a generation ID or wholly unknown. Physical attempts retain every
-- available metadata fact, and accepted-output persistence rejects any memo
-- that is not live and accept-eligible.

drop trigger if exists itotori_llm_history_immutable on itotori_llm_call_memos;

alter table itotori_llm_call_memos
  add column if not exists served_pair_status text;

update itotori_llm_call_memos
set served_pair_status = case
      when served_pair_status = 'confirmed' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then 'confirmed'
      else 'unknown'
    end,
    served_model = case
      when served_pair_status = 'confirmed' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then served_model
      else null
    end,
    served_provider = case
      when served_pair_status = 'confirmed' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then served_provider
      else null
    end,
    verification_status = case
      when served_pair_status = 'confirmed' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then 'verified'
      else 'quarantined'
    end;

alter table itotori_llm_call_memos
  alter column served_pair_status set not null,
  alter column prompt_token_count drop not null,
  alter column completion_token_count drop not null,
  alter column reasoning_token_count drop not null,
  alter column cached_token_count drop not null,
  drop constraint if exists itotori_llm_call_memos_served_pair,
  drop constraint if exists itotori_llm_call_memos_verification,
  drop constraint if exists itotori_llm_call_memos_usage,
  add constraint itotori_llm_call_memos_served_pair check (
    (served_pair_status = 'unknown' and served_model is null and served_provider is null)
    or (served_pair_status = 'confirmed' and generation_id is not null
      and served_model is not null and served_provider is not null
      and served_model <> 'unknown' and served_provider <> 'unknown')
  ),
  add constraint itotori_llm_call_memos_verification check (
    (verification_status = 'verified') =
      (generation_id is not null and served_pair_status = 'confirmed')
  ),
  add constraint itotori_llm_call_memos_usage check (
    (prompt_token_count is null and completion_token_count is null
      and reasoning_token_count is null and cached_token_count is null)
    or (prompt_token_count >= 0 and completion_token_count >= 0
      and reasoning_token_count >= 0 and cached_token_count >= 0)
  );

create trigger itotori_llm_history_immutable
before update or delete on itotori_llm_call_memos
for each row execute function itotori_llm_enforce_history_immutability();

drop trigger if exists itotori_llm_history_immutable on itotori_llm_http_attempts;

alter table itotori_llm_http_attempts
  add column if not exists served_pair_status text,
  add column if not exists served_model text,
  add column if not exists served_provider text,
  add column if not exists verification_status text,
  add column if not exists router_attempts jsonb,
  add column if not exists prompt_token_count integer,
  add column if not exists completion_token_count integer,
  add column if not exists reasoning_token_count integer,
  add column if not exists cached_token_count integer,
  add column if not exists reported_cost_usd numeric(24, 12);

update itotori_llm_http_attempts
set served_pair_status = case
      when served_pair_status = 'confirmed'
        and attempt_status <> 'in-flight' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then 'confirmed'
      else 'unknown'
    end,
    served_model = case
      when served_pair_status = 'confirmed'
        and attempt_status <> 'in-flight' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then served_model
      else null
    end,
    served_provider = case
      when served_pair_status = 'confirmed'
        and attempt_status <> 'in-flight' and generation_id is not null
        and served_model is not null and served_provider is not null
        and served_model <> 'unknown' and served_provider <> 'unknown'
      then served_provider
      else null
    end,
    verification_status = coalesce(
      verification_status,
      case when attempt_status = 'in-flight' then 'pending' else 'quarantined' end
    ),
    router_attempts = coalesce(router_attempts, '[]'::jsonb),
    reported_cost_usd = coalesce(reported_cost_usd, cost_usd);

alter table itotori_llm_http_attempts
  alter column served_pair_status set not null,
  alter column verification_status set not null,
  alter column router_attempts set not null,
  drop constraint if exists itotori_llm_http_attempts_served_pair,
  drop constraint if exists itotori_llm_http_attempts_verification,
  drop constraint if exists itotori_llm_http_attempts_router_attempts,
  drop constraint if exists itotori_llm_http_attempts_usage,
  drop constraint if exists itotori_llm_http_attempts_reported_cost,
  add constraint itotori_llm_http_attempts_served_pair check (
    (served_pair_status = 'unknown' and served_model is null and served_provider is null)
    or (served_pair_status = 'confirmed' and generation_id is not null
      and served_model is not null and served_provider is not null
      and served_model <> 'unknown' and served_provider <> 'unknown')
  ),
  add constraint itotori_llm_http_attempts_verification check (
    (attempt_status = 'in-flight' and verification_status = 'pending'
      and served_pair_status = 'unknown' and generation_id is null)
    or (attempt_status <> 'in-flight' and (
      (verification_status = 'verified'
        and generation_id is not null and served_pair_status = 'confirmed')
      or (verification_status = 'quarantined'
        and (generation_id is null or served_pair_status = 'unknown'))
    ))
  ),
  add constraint itotori_llm_http_attempts_router_attempts check (
    jsonb_typeof(router_attempts) = 'array'
  ),
  add constraint itotori_llm_http_attempts_usage check (
    (prompt_token_count is null and completion_token_count is null
      and reasoning_token_count is null and cached_token_count is null)
    or (prompt_token_count >= 0 and completion_token_count >= 0
      and reasoning_token_count >= 0 and cached_token_count >= 0)
  ),
  add constraint itotori_llm_http_attempts_reported_cost check (
    reported_cost_usd is null or reported_cost_usd >= 0
  );

create or replace function itotori_llm_enforce_attempt_lifecycle()
returns trigger
language plpgsql
as $$
declare
  old_fixed jsonb;
  new_fixed jsonb;
  column_name text;
begin
  if tg_op = 'DELETE' then
    raise exception '% history is immutable', tg_table_name;
  end if;

  if old.deletion_state = 'active' and new.deletion_state = 'active'
    and old.attempt_status = 'in-flight' and new.attempt_status <> 'in-flight'
    and old.completed_at is null and new.completed_at is not null
  then
    old_fixed := to_jsonb(old)
      - 'response_ciphertext' - 'response_key_ref' - 'response_content_hash'
      - 'attempt_status' - 'failure_class' - 'http_status' - 'generation_id'
      - 'served_pair_status' - 'served_model' - 'served_provider' - 'verification_status'
      - 'router_attempts' - 'prompt_token_count' - 'completion_token_count'
      - 'reasoning_token_count' - 'cached_token_count'
      - 'billing_state' - 'cost_usd' - 'reported_cost_usd' - 'completed_at';
    new_fixed := to_jsonb(new)
      - 'response_ciphertext' - 'response_key_ref' - 'response_content_hash'
      - 'attempt_status' - 'failure_class' - 'http_status' - 'generation_id'
      - 'served_pair_status' - 'served_model' - 'served_provider' - 'verification_status'
      - 'router_attempts' - 'prompt_token_count' - 'completion_token_count'
      - 'reasoning_token_count' - 'cached_token_count'
      - 'billing_state' - 'cost_usd' - 'reported_cost_usd' - 'completed_at';
    if old_fixed is distinct from new_fixed then
      raise exception '% attempt identity is immutable', tg_table_name;
    end if;
    return new;
  end if;

  if old.deletion_state <> 'active' or new.deletion_state <> 'deleted' or new.deleted_at is null then
    raise exception '% history is immutable', tg_table_name;
  end if;
  old_fixed := to_jsonb(old) - 'deletion_state' - 'deleted_at';
  new_fixed := to_jsonb(new) - 'deletion_state' - 'deleted_at';
  for column_name in select jsonb_object_keys(old_fixed)
  loop
    if column_name like '%ciphertext%' then
      if new_fixed -> column_name is distinct from 'null'::jsonb then
        raise exception '% deletion must remove ciphertext', tg_table_name;
      end if;
      old_fixed := old_fixed - column_name;
      new_fixed := new_fixed - column_name;
    end if;
  end loop;
  if old_fixed is distinct from new_fixed then
    raise exception '% history metadata is immutable', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger itotori_llm_history_immutable
before update or delete on itotori_llm_http_attempts
for each row execute function itotori_llm_enforce_attempt_lifecycle();

alter table itotori_llm_accepted_outputs
  drop constraint if exists itotori_llm_accepted_outputs_verified_memos,
  add constraint itotori_llm_accepted_outputs_verified_memos check (cardinality(memo_keys) > 0);

do $$
begin
  if exists (
    select 1
    from itotori_llm_accepted_outputs output
    cross join lateral unnest(output.memo_keys) required(memo_key)
    left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
    where memo.verification_status is distinct from 'verified'
      or memo.generation_id is null
      or memo.served_pair_status is distinct from 'confirmed'
  ) then
    raise exception 'accepted output contains an unverified memo';
  end if;
end;
$$;

create or replace function itotori_llm_require_verified_output_memos()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from unnest(new.memo_keys) required(memo_key)
    left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
    where memo.verification_status is distinct from 'verified'
      or memo.generation_id is null
      or memo.served_pair_status is distinct from 'confirmed'
      or memo.deletion_state is distinct from 'active'
  ) then
    raise exception 'accepted output requires a live memo with generation ID and stream-attested route'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists itotori_llm_accepted_output_quarantine
  on itotori_llm_accepted_outputs;
create trigger itotori_llm_accepted_output_quarantine
before insert on itotori_llm_accepted_outputs
for each row execute function itotori_llm_require_verified_output_memos();

create or replace function itotori_llm_enforce_cas_head_advance()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CAS heads cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.head_namespace <> old.head_namespace
      or new.snapshot_id <> old.snapshot_id
      or new.subject_type <> old.subject_type
      or new.subject_id <> old.subject_id
      or new.head_stage <> old.head_stage
      or new.head_version <> old.head_version + 1
      or (new.head_id = old.head_id and new.head_content_hash = old.head_content_hash)
    then
      raise exception 'CAS head advance is invalid';
    end if;
  end if;
  if new.head_namespace = 'accepted-output' then
    if not exists (
      select 1
      from itotori_llm_accepted_outputs output
      where output.output_id = new.head_id
        and output.output_version = new.head_version
        and output.output_content_hash = new.head_content_hash
        and cardinality(output.memo_keys) > 0
        and not exists (
          select 1
          from unnest(output.memo_keys) required(memo_key)
          left join itotori_llm_call_memos memo on memo.memo_key = required.memo_key
          where memo.verification_status is distinct from 'verified'
            or memo.generation_id is null
            or memo.served_pair_status is distinct from 'confirmed'
            or memo.deletion_state is distinct from 'active'
        )
    ) then
      raise exception 'CAS head target is invalid';
    end if;
  elsif not exists (
    select 1 from itotori_llm_wiki_versions
    where wiki_version_id = new.head_id and object_version = new.head_version
      and wiki_content_hash = new.head_content_hash
  ) then
    raise exception 'CAS head target is invalid';
  end if;
  return new;
end;
$$;
