-- Physical attempts become visible when dispatch starts so admission can report
-- bounded exposure. This is an attempt fact lifecycle, not a spend reservation:
-- no amount is deducted, owned, leased, or released.

drop trigger if exists itotori_llm_history_immutable on itotori_llm_http_attempts;

alter table itotori_llm_http_attempts
  add column if not exists admission_scope text,
  add column if not exists failure_class text,
  add column if not exists max_exposure_usd numeric(24, 12),
  add column if not exists deadline_at timestamptz;

alter table itotori_llm_http_attempts alter column completed_at drop not null;

update itotori_llm_http_attempts
set admission_scope = coalesce(admission_scope, 'legacy'),
    failure_class = coalesce(
      failure_class,
      case
        when attempt_status = 'transport-error' then 'transient'
        when attempt_status = 'http-error' and (
          http_status in (408, 429) or http_status between 500 and 599
        ) then 'transient'
        when attempt_status = 'http-error' then 'permanent'
        when attempt_status = 'cancelled' then 'cancelled'
        else null
      end
    ),
    max_exposure_usd = coalesce(max_exposure_usd, 0),
    deadline_at = coalesce(deadline_at, completed_at, started_at);

alter table itotori_llm_http_attempts
  alter column admission_scope set not null,
  alter column max_exposure_usd set not null,
  alter column deadline_at set not null;

alter table itotori_llm_http_attempts
  drop constraint if exists itotori_llm_http_attempts_status,
  drop constraint if exists itotori_llm_http_attempts_billing,
  drop constraint if exists itotori_llm_http_attempts_times,
  drop constraint if exists itotori_llm_http_attempts_retention,
  drop constraint if exists itotori_llm_http_attempts_failure,
  drop constraint if exists itotori_llm_http_attempts_exposure,
  add constraint itotori_llm_http_attempts_status check (
    attempt_status in ('in-flight', 'completed', 'transport-error', 'http-error', 'cancelled')
  ),
  add constraint itotori_llm_http_attempts_failure check (
    (attempt_status in ('in-flight', 'completed') and failure_class is null)
    or (attempt_status = 'cancelled' and failure_class = 'cancelled')
    or (attempt_status in ('transport-error', 'http-error')
      and failure_class in ('transient', 'permanent'))
  ),
  add constraint itotori_llm_http_attempts_billing check (
    (billing_state = 'confirmed' and cost_usd is not null and cost_usd >= 0)
    or (billing_state = 'billing_unknown' and cost_usd is null)
  ),
  add constraint itotori_llm_http_attempts_exposure check (max_exposure_usd >= 0),
  add constraint itotori_llm_http_attempts_times check (
    deadline_at >= started_at
    and (
      (attempt_status = 'in-flight' and completed_at is null)
      or (attempt_status <> 'in-flight' and completed_at is not null and completed_at >= started_at)
    )
  ),
  add constraint itotori_llm_http_attempts_retention check (
    retention_deadline <= coalesce(completed_at, deadline_at) + interval '7 days'
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
      - 'billing_state' - 'cost_usd' - 'completed_at';
    new_fixed := to_jsonb(new)
      - 'response_ciphertext' - 'response_key_ref' - 'response_content_hash'
      - 'attempt_status' - 'failure_class' - 'http_status' - 'generation_id'
      - 'billing_state' - 'cost_usd' - 'completed_at';
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
